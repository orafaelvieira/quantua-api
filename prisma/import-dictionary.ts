import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import { join } from "path";
import { avaliarContaParticular } from "../src/services/conta-particular";
import { avaliaValorNoNome } from "../src/services/valor-no-nome";
import { avaliaBloqueioEstrutural } from "../src/services/conta-estrutural";

const prisma = new PrismaClient();

interface DictEntry {
  nomeOriginal: string;
  contaDestino: string;
  grupoConta: string;
  tipo: string; // "BP" | "DRE"
}

/** Mínimo de entradas no arquivo para o cancelamento rodar. Trava de segurança: se o
 *  arquivo vier vazio/corrompido (ou faltar no deploy), NÃO cancela o dicionário inteiro. */
const MIN_ENTRADAS_PARA_SYNC = 100;

const keyOf = (e: { nomeOriginal: string; tipo: string; grupoConta: string }) =>
  `${e.nomeOriginal.trim()}|${e.tipo === "DRE" ? "DRE" : "BP"}|${e.grupoConta.trim()}`;

/**
 * HERANÇA FUNDADORA do dicionário GLOBAL (13/08/2026 — antes se chamava "sync").
 *
 * prisma/seed-data/account-dictionary.json é a herança que toda empresa nova
 * recebe. A regra do dono: "um dicionário global que só tem contas quando o
 * analista aceita na tela de Validação de Contas". Logo o arquivo CRIA o que
 * falta e não faz mais nada — não reescreve destino (isso é decisão humana) e
 * não apaga linha (política da casa: cancelar, nunca deletar).
 *
 * O que este arquivo faz hoje:
 *   · RECUSA entrada que as travas do produto barrariam (LGPD, valor no nome);
 *   · CRIA a entrada global que ainda não existe;
 *   · RELATA no log a divergência entre arquivo e banco, sem aplicar;
 *   · CANCELA (revisao "cancelada", com motivo e autor) a global que saiu do
 *     arquivo — ela deixa a cascata ativa mas o histórico fica.
 * Nunca toca em workspace (userId != null) nem em entrada "promovida".
 *
 * Trava: pula o cancelamento se o arquivo tiver < MIN_ENTRADAS_PARA_SYNC
 * (arquivo vazio/ausente no deploy não pode zerar o dicionário).
 *
 * Rodar: npm run db:seed:dictionary (também roda no boot/deploy via `start`).
 */
async function main() {
  const file = join(__dirname, "seed-data", "account-dictionary.json");
  const entries: DictEntry[] = JSON.parse(readFileSync(file, "utf-8"));

  // Dedup por chave (nome,tipo,grupo) defensivo + normalização.
  const porChave = new Map<string, DictEntry>();
  const recusadas: string[] = [];
  for (const e of entries) {
    const nomeOriginal = e.nomeOriginal?.trim();
    const contaDestino = e.contaDestino?.trim();
    const grupoConta = e.grupoConta?.trim();
    const tipo = e.tipo === "DRE" ? "DRE" : "BP";
    if (!nomeOriginal || !contaDestino || !grupoConta) continue;
    // O ARQUIVO OFICIAL PASSA PELAS MESMAS TRAVAS DA PORTA (13/08/2026).
    // O dicionário global é SEED: instala em toda base e é visível a todos os
    // clientes da plataforma. Estava lá dentro "Bradesco Ag.0049 C/C 0329707-1"
    // — agência e conta de um cliente. Uma trava que só vale no /classify não
    // protege nada se o arquivo curado entra por baixo dela.
    const lgpd = avaliarContaParticular(nomeOriginal, grupoConta);
    if (lgpd.bloqueioDuro) { recusadas.push(`${nomeOriginal} — ${lgpd.motivo}`); continue; }
    const comValor = avaliaValorNoNome(nomeOriginal);
    if (comValor.bloqueado) { recusadas.push(`${nomeOriginal} — valor "${comValor.trecho}" no nome`); continue; }
    // Conta AGREGADA como folha colapsa o grupo — a mesma trava do /classify.
    // Medido no arquivo: 3 entradas ("Creditos" → Contas a Receber - CP,
    // "Outras Obrigações" → Outros Passivos C/NC) entravam por baixo dela.
    const estrutural = avaliaBloqueioEstrutural(nomeOriginal, contaDestino);
    if (estrutural.bloqueado) { recusadas.push(`${nomeOriginal} — ${estrutural.motivo}`); continue; }
    porChave.set(keyOf({ nomeOriginal, tipo, grupoConta }), { nomeOriginal, contaDestino, grupoConta, tipo });
  }
  if (recusadas.length) {
    console.warn(`[DICIONÁRIO] ${recusadas.length} entrada(s) do arquivo oficial RECUSADAS pelas travas:`);
    for (const r of recusadas) console.warn(`  · ${r}`);
  }
  const oficiais = [...porChave.values()];
  console.log(`Sincronizando dicionário global com ${oficiais.length} entradas oficiais...`);

  let created = 0, canceladas = 0, errors = 0;
  const divergentes: string[] = [];

  // 1) HERANÇA: cria o que falta. NUNCA atualiza destino.
  //
  //    O arquivo curado é a VERSÃO FUNDADORA do dicionário global — a herança
  //    que toda empresa nova recebe. Ele não é uma segunda porta de escrita:
  //    quem muda o destino de uma conta global é a tela "Validação de contas",
  //    e só ela (invariante do dono, 13/08/2026).
  //
  //    Antes, este laço reescrevia o destino a cada partida do servidor. Isso
  //    fazia do arquivo um editor silencioso do dicionário de todos os clientes,
  //    sem aprovação e com UMA linha agregada de changelog para centenas de
  //    entradas. Divergência entre arquivo e banco agora é RELATADA, não
  //    aplicada: quem decide é gente, na tela.
  for (const entry of oficiais) {
    try {
      const existing = await prisma.accountDictionary.findFirst({
        where: { nomeOriginal: entry.nomeOriginal, tipo: entry.tipo, grupoConta: entry.grupoConta, userId: null },
      });
      if (existing) {
        if (existing.contaDestino !== entry.contaDestino) {
          divergentes.push(`"${entry.nomeOriginal}" (${entry.tipo}/${entry.grupoConta}): banco="${existing.contaDestino}" × arquivo="${entry.contaDestino}"`);
        }
        continue;
      }
      await prisma.accountDictionary.create({ data: { ...entry } }); // userId null => global
      created++;
    } catch (err) {
      console.error(`Erro em "${entry.nomeOriginal}" (${entry.tipo}/${entry.grupoConta}):`, err);
      errors++;
    }
  }
  if (divergentes.length) {
    console.warn(`[DICIONÁRIO] ${divergentes.length} entrada(s) com destino DIFERENTE do arquivo oficial — nada foi alterado, decida na tela de Validação de contas:`);
    for (const d of divergentes.slice(0, 40)) console.warn(`  · ${d}`);
    if (divergentes.length > 40) console.warn(`  … e mais ${divergentes.length - 40}.`);
  }

  // 2) SAIU DO ARQUIVO → CANCELA, não apaga. A política da casa é nunca deletar
  //    (o histórico e a trilha valem mais que a linha), e "cancelada" já sai da
  //    cascata ativa que o fold lê, com "Reativar" na tela. Antes isto era
  //    deleteMany: dado de produção destruído no boot, sem volta.
  //    Entradas PROMOVIDAS pela Validação ficam fora — não estão no arquivo por
  //    definição e a aprovação humana não pode evaporar no próximo deploy.
  if (oficiais.length >= MIN_ENTRADAS_PARA_SYNC) {
    const oficiaisKeys = new Set(oficiais.map(keyOf));
    const globais = await prisma.accountDictionary.findMany({
      where: { userId: null, companyId: null, revisao: null },
      select: { id: true, nomeOriginal: true, tipo: true, grupoConta: true },
    });
    const orfas = globais.filter((g) => !oficiaisKeys.has(keyOf(g)));
    if (orfas.length > 0) {
      await prisma.accountDictionary.updateMany({
        where: { id: { in: orfas.map((o) => o.id) } },
        data: {
          revisao: "cancelada",
          revisaoMotivo: "Saiu do arquivo oficial do dicionário — fora da cascata, mas preservada para histórico.",
          revisadoPor: "Seed (deploy)",
          revisadoEm: new Date(),
        },
      });
      canceladas = orfas.length;
      console.warn(`[DICIONÁRIO] ${canceladas} entrada(s) global(is) canceladas por terem saído do arquivo oficial.`);
      for (const o of orfas.slice(0, 20)) console.warn(`  · "${o.nomeOriginal}" (${o.tipo}/${o.grupoConta})`);
    }
  } else {
    console.warn(`[SAFETY] Arquivo com ${oficiais.length} entradas (< ${MIN_ENTRADAS_PARA_SYNC}) — pulei o cancelamento para não zerar o dicionário.`);
  }

  // 3) Registra UM evento de versão se houve qualquer mudança (changelog interno).
  //    Divergência NÃO entra aqui: ela não mudou dado nenhum. Entra no log, para
  //    virar decisão humana na tela.
  if (created + canceladas > 0) {
    const ultima = await prisma.dictionaryVersion.findFirst({ orderBy: { versao: "desc" }, select: { versao: true } });
    await prisma.dictionaryVersion.create({
      data: {
        versao: (ultima?.versao ?? 0) + 1,
        acao: "import",
        fonte: "manual",
        nota: `Herança oficial do De-Para: ${oficiais.length} entradas no arquivo (+${created} criadas, ${canceladas} canceladas por saírem do arquivo` +
          (divergentes.length ? `, ${divergentes.length} divergência(s) RELATADAS e não aplicadas` : "") + ")",
        criadoPor: "Seed (deploy)",
      },
    });
  }

  const totalGlobais = await prisma.accountDictionary.count({ where: { userId: null } });
  console.log(
    `Herança concluída: ${created} criadas, ${canceladas} canceladas, ${divergentes.length} divergências relatadas, ${errors} erros. ` +
      `Total de entradas globais agora: ${totalGlobais}.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
