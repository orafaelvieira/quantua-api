import { PrismaClient } from "@prisma/client";
import { BP_TEMPLATE, DRE_TEMPLATE } from "../src/services/financial-templates";

const prisma = new PrismaClient();

/**
 * Carrega os modelos padrão BP/DRE (hoje hardcoded em financial-templates.ts) para o
 * banco como VERSÃO 1, ativa — sem mudar comportamento. A cascata e os indicadores
 * continuam funcionando pelo código; este seed só move o modelo para um lugar
 * versionável/editável (base da tela de governança).
 *
 * Idempotente e CONSERVADOR: só cria a v1 se NÃO existir nenhum modelo daquele tipo.
 * Assim, depois que o usuário editar/versionar pela tela, o boot não sobrescreve nada.
 *
 * Rodar: npm run db:seed:models
 */
function slug(nome: string): string {
  return nome
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

async function seedTipo(tipo: "BP" | "DRE") {
  const linhas =
    tipo === "BP"
      ? BP_TEMPLATE.map((t, i) => ({
          codigo: slug(t.conta),
          nome: t.conta,
          grupo: t.classificacao,
          ordem: i,
          tipo: t.nivel === 0 ? "total" : t.nivel === 1 ? "subtotal" : "input",
          nivel: t.nivel,
          sinal: null as number | null,
        }))
      : DRE_TEMPLATE.map((t, i) => ({
          codigo: slug(t.conta),
          nome: t.conta,
          grupo: "",
          ordem: i,
          tipo: t.subtotal ? "subtotal" : "input",
          nivel: t.subtotal ? 1 : 2,
          sinal: null as number | null,
        }));

  const ativo = await prisma.standardModel.findFirst({
    where: { tipo, ativo: true, companyId: null }, // seed governa SÓ o global — modelos de empresa ficam intactos
    include: { linhas: { orderBy: { ordem: "asc" } } },
  });
  const assinatura = (ls: Array<{ nome: string; grupo: string; nivel: number; tipo: string }>) =>
    ls.map((l) => `${l.nome}|${l.grupo}|${l.nivel}|${l.tipo}`).join("\n");

  // A referência de comparação é a ÚLTIMA VERSÃO QUE O PRÓPRIO SEED PUBLICOU
  // (criadoPor "sistema"), NUNCA a vigente: comparar com a vigente fazia o seed
  // ATROPELAR edições do usuário a cada deploy (uma edição também "diverge do
  // template"). Vale para BP e DRE — esta função atende os dois.
  const ultimaSeed = await prisma.standardModel.findFirst({
    where: { tipo, criadoPor: "sistema", companyId: null },
    orderBy: { versao: "desc" },
    include: { linhas: { orderBy: { ordem: "asc" } } },
  });
  if (ultimaSeed && assinatura(ultimaSeed.linhas) === assinatura(linhas)) {
    console.log(`  ${tipo}: template do código inalterado (última seed v${ultimaSeed.versao}) — edições do usuário preservadas.`);
    return;
  }

  // Template do código REALMENTE mudou (ou primeira carga). Se a vigente é edição de
  // USUÁRIO, a nova versão entra INATIVA (fica no histórico, sem atropelar a edição)
  // — EXCETO quando o template novo PRESERVA a vigente por inteiro (toda linha dela
  // aparece no novo, na mesma ordem relativa): aí nada do usuário se perde, o novo
  // só ADICIONA — pode ativar (caso da abertura v7 da DRE, 15/07/2026).
  const vigenteEhDoUsuario = !!ativo && ativo.criadoPor !== "sistema";
  const linhaId = (l: { nome: string; grupo: string; nivel: number; tipo: string }) => `${l.nome}|${l.grupo}|${l.nivel}|${l.tipo}`;
  const preservaVigente = (() => {
    if (!ativo) return false;
    // subsequência ordenada: cada linha da vigente existe no template novo, na ordem
    const novas = linhas.map(linhaId);
    let i = 0;
    for (const l of ativo.linhas) {
      const alvo = linhaId(l);
      while (i < novas.length && novas[i] !== alvo) i++;
      if (i >= novas.length) return false;
      i++;
    }
    return true;
  })();
  const ativarNova = !vigenteEhDoUsuario || preservaVigente;
  const proxVersao = ((await prisma.standardModel.aggregate({ where: { tipo, companyId: null }, _max: { versao: true } }))._max.versao ?? 0) + 1;
  await prisma.$transaction(async (tx) => {
    if (ativarNova) await tx.standardModel.updateMany({ where: { tipo, ativo: true, companyId: null }, data: { ativo: false } });
    await tx.standardModel.create({
      data: {
        tipo, versao: proxVersao, ativo: ativarNova,
        nota: proxVersao === 1
          ? "Versão inicial (migrada dos templates do código)"
          : ativarNova
            ? (vigenteEhDoUsuario ? "Atualização do template do código (preserva a edição vigente — só adiciona linhas)" : "Atualização do template do código")
            : "Atualização do template do código (inativa — a vigente é edição do usuário)",
        criadoPor: "sistema",
        linhas: { create: linhas },
      },
    });
  });
  console.log(`  ${tipo}: v${proxVersao} publicada (${linhas.length} linhas, ${ativarNova ? "ATIVA" : "inativa — vigente do usuário mantida"}).`);
}

/** Preenche o guia "entra/não entra" (descricao) das linhas — SÓ onde está vazio
 *  (nunca sobrescreve texto editado pelo usuário no editor). Idempotente. */
async function backfillGuia(): Promise<void> {
  const { GUIA_LINHAS } = await import("./seed-data/model-line-guide");
  let filled = 0;
  for (const [nome, descricao] of Object.entries(GUIA_LINHAS)) {
    const r = await prisma.standardModelLine.updateMany({
      where: { nome, OR: [{ descricao: null }, { descricao: "" }] },
      data: { descricao },
    });
    filled += r.count;
  }
  if (filled > 0) console.log(`  guia: ${filled} descrição(ões) preenchida(s) (só onde estava vazio).`);
}

/** Seed da CONFIG DE INDICADORES (tela "Indicadores"): cria os canônicos do código com
 *  semáforo default — CREATE-ONLY (indicador já existente nunca é tocado: limiar editado,
 *  exibição desativada e ordem do usuário são preservados em todo deploy). */
async function seedIndicatorConfigs(): Promise<void> {
  const { INDICADORES_TEMPLATE } = await import("../src/services/financial-templates");
  const { SEMAFORO_DEFAULTS } = await import("../src/services/indicator-calculator");

  // Renomeações de indicador de sistema: RENOMEIA a linha existente (preserva semáforo
  // editado/exibição do usuário); se o nome novo já existir (seed antigo criou os dois),
  // remove a linha antiga. Roda ANTES do create-only.
  const RENOMEADOS: Record<string, string> = {
    "Margem Operacional": "Margem EBITDA",
    "Dívida Líquida/Lucro Operacional": "Dívida Líquida/EBITDA",
    // O antigo "Capital de Terceiros" incluía partes relacionadas → ganha o nome explícito;
    // o create-only abaixo cria o NOVO "Capital de Terceiros" (só empréstimos CP+LP).
    "Capital de Terceiros": "Capital de Terceiros + Partes Relacionadas",
    // Fleuriet promovido ao bloco de Solvência com nome explícito (grupo/fórmula
    // acompanham o template no sync abaixo).
    "Situação da empresa": "Situação de Liquidez (Fleuriet)",
  };
  for (const [antigo, novo] of Object.entries(RENOMEADOS)) {
    const rowAntigo = await prisma.indicatorConfig.findUnique({ where: { nome: antigo } });
    if (!rowAntigo) continue;
    const rowNovo = await prisma.indicatorConfig.findUnique({ where: { nome: novo } });
    if (rowNovo) await prisma.indicatorConfig.delete({ where: { id: rowAntigo.id } });
    else await prisma.indicatorConfig.update({ where: { id: rowAntigo.id }, data: { nome: novo } });
    console.log(`  indicadores: "${antigo}" → "${novo}".`);
  }

  // Fusão de grupos: "Rentabilidade - Modelo Dupont" incorporado a "Indicadores de
  // Rentabilidade" (a fórmula de cada linha já conta a história do DuPont).
  const fusao = await prisma.indicatorConfig.updateMany({
    where: { grupo: "Indicadores de Rentabilidade - Modelo Dupont" },
    data: { grupo: "Indicadores de Rentabilidade" },
  });
  if (fusao.count > 0) console.log(`  indicadores: ${fusao.count} movido(s) do grupo DuPont para Rentabilidade.`);
  // Fórmulas/grupos/ordem das linhas de SISTEMA acompanham o template do código (texto
  // exibido; semáforo/exibição do usuário ficam intactos).
  let ordemSync = 0;
  const nomesTemplate = new Set<string>();
  for (const t of INDICADORES_TEMPLATE) {
    ordemSync += 1;
    if (nomesTemplate.has(t.nome)) continue; // nome duplicado no template (ex.: Margem Líquida em 2 grupos)
    nomesTemplate.add(t.nome);
    await prisma.indicatorConfig.updateMany({ where: { nome: t.nome, sistema: true }, data: { formula: t.formula, grupo: t.tipo, ordem: ordemSync } });
  }
  // Linhas de SISTEMA que saíram do template (ex.: indicador removido/renomeado) não
  // são mais calculadas — remove para não virarem fantasmas na tela de configuração.
  const orfaos = await prisma.indicatorConfig.deleteMany({ where: { sistema: true, nome: { notIn: [...nomesTemplate] } } });
  if (orfaos.count > 0) console.log(`  indicadores: ${orfaos.count} config(s) de sistema órfã(s) removida(s).`);

  let created = 0;
  let ordem = 0;
  for (const t of INDICADORES_TEMPLATE) {
    ordem += 1;
    const existe = await prisma.indicatorConfig.findUnique({ where: { nome: t.nome } });
    if (existe) continue;
    const sem = SEMAFORO_DEFAULTS[t.nome];
    await prisma.indicatorConfig.create({
      data: {
        nome: t.nome, sistema: true, ativo: true, grupo: t.tipo, tipoDado: t.tipoDado,
        formula: t.formula, ordem,
        ...(sem ? { semDirecao: sem.direcao, semCritico: sem.critico, semAtencao: sem.atencao } : {}),
      },
    });
    created += 1;
  }
  if (created > 0) console.log(`  indicadores: ${created} config(s) de sistema criada(s).`);
}

async function main() {
  console.log("Seed dos modelos padrão (BP/DRE):");
  await seedTipo("BP");
  await seedTipo("DRE");
  await backfillGuia();
  await seedIndicatorConfigs();
  const total = await prisma.standardModelLine.count();
  console.log(`Concluído. Total de linhas de modelo no banco: ${total}.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
