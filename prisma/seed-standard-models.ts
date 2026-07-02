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
    where: { tipo, ativo: true },
    include: { linhas: { orderBy: { ordem: "asc" } } },
  });
  const assinatura = (ls: Array<{ nome: string; grupo: string; nivel: number; tipo: string }>) =>
    ls.map((l) => `${l.nome}|${l.grupo}|${l.nivel}|${l.tipo}`).join("\n");

  // A referência de comparação é a ÚLTIMA VERSÃO QUE O PRÓPRIO SEED PUBLICOU
  // (criadoPor "sistema"), NUNCA a vigente: comparar com a vigente fazia o seed
  // ATROPELAR edições do usuário a cada deploy (uma edição também "diverge do
  // template"). Vale para BP e DRE — esta função atende os dois.
  const ultimaSeed = await prisma.standardModel.findFirst({
    where: { tipo, criadoPor: "sistema" },
    orderBy: { versao: "desc" },
    include: { linhas: { orderBy: { ordem: "asc" } } },
  });
  if (ultimaSeed && assinatura(ultimaSeed.linhas) === assinatura(linhas)) {
    console.log(`  ${tipo}: template do código inalterado (última seed v${ultimaSeed.versao}) — edições do usuário preservadas.`);
    return;
  }

  // Template do código REALMENTE mudou (ou primeira carga). Se a vigente é edição de
  // USUÁRIO, a nova versão entra INATIVA (fica no histórico, sem atropelar a edição).
  const vigenteEhDoUsuario = !!ativo && ativo.criadoPor !== "sistema";
  const ativarNova = !vigenteEhDoUsuario;
  const proxVersao = ((await prisma.standardModel.aggregate({ where: { tipo }, _max: { versao: true } }))._max.versao ?? 0) + 1;
  await prisma.$transaction(async (tx) => {
    if (ativarNova) await tx.standardModel.updateMany({ where: { tipo, ativo: true }, data: { ativo: false } });
    await tx.standardModel.create({
      data: {
        tipo, versao: proxVersao, ativo: ativarNova,
        nota: proxVersao === 1
          ? "Versão inicial (migrada dos templates do código)"
          : ativarNova
            ? "Atualização do template do código"
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

async function main() {
  console.log("Seed dos modelos padrão (BP/DRE):");
  await seedTipo("BP");
  await seedTipo("DRE");
  await backfillGuia();
  const total = await prisma.standardModelLine.count();
  console.log(`Concluído. Total de linhas de modelo no banco: ${total}.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
