import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import { join } from "path";

const prisma = new PrismaClient();

interface DictEntry {
  nomeOriginal: string;
  contaDestino: string;
  grupoConta: string;
  tipo: string; // "BP" | "DRE"
}

/** Mínimo de entradas no arquivo para o SYNC apagar globais. Trava de segurança: se o
 *  arquivo vier vazio/corrompido (ou faltar no deploy), NÃO apaga o dicionário inteiro. */
const MIN_ENTRADAS_PARA_SYNC = 100;

const keyOf = (e: { nomeOriginal: string; tipo: string; grupoConta: string }) =>
  `${e.nomeOriginal.trim()}|${e.tipo === "DRE" ? "DRE" : "BP"}|${e.grupoConta.trim()}`;

/**
 * SINCRONIZA o dicionário GLOBAL (userId = null) com prisma/seed-data/account-dictionary.json
 * — o arquivo é a fonte da verdade OFICIAL. Faz upsert (cria/atualiza) E **apaga** as globais
 * que não estão no arquivo (remove duplicatas/itens revisados fora). Idempotente: após aplicar,
 * boots seguintes não mudam nada. NÃO toca em overrides de workspace (userId != null).
 *
 * Trava: aborta o delete se o arquivo tiver < MIN_ENTRADAS_PARA_SYNC (proteção contra
 * arquivo vazio/ausente zerar o dicionário).
 *
 * Rodar: npm run db:seed:dictionary (também roda no boot/deploy via `start`).
 */
async function main() {
  const file = join(__dirname, "seed-data", "account-dictionary.json");
  const entries: DictEntry[] = JSON.parse(readFileSync(file, "utf-8"));

  // Dedup por chave (nome,tipo,grupo) defensivo + normalização.
  const porChave = new Map<string, DictEntry>();
  for (const e of entries) {
    const nomeOriginal = e.nomeOriginal?.trim();
    const contaDestino = e.contaDestino?.trim();
    const grupoConta = e.grupoConta?.trim();
    const tipo = e.tipo === "DRE" ? "DRE" : "BP";
    if (!nomeOriginal || !contaDestino || !grupoConta) continue;
    porChave.set(keyOf({ nomeOriginal, tipo, grupoConta }), { nomeOriginal, contaDestino, grupoConta, tipo });
  }
  const oficiais = [...porChave.values()];
  console.log(`Sincronizando dicionário global com ${oficiais.length} entradas oficiais...`);

  let created = 0, updated = 0, deleted = 0, errors = 0;

  // 1) Upsert (cria/atualiza destino)
  for (const entry of oficiais) {
    try {
      const existing = await prisma.accountDictionary.findFirst({
        where: { nomeOriginal: entry.nomeOriginal, tipo: entry.tipo, grupoConta: entry.grupoConta, userId: null },
      });
      if (existing) {
        if (existing.contaDestino !== entry.contaDestino) {
          await prisma.accountDictionary.update({ where: { id: existing.id }, data: { contaDestino: entry.contaDestino } });
          updated++;
        }
      } else {
        await prisma.accountDictionary.create({ data: { ...entry } }); // userId null => global
        created++;
      }
    } catch (err) {
      console.error(`Erro em "${entry.nomeOriginal}" (${entry.tipo}/${entry.grupoConta}):`, err);
      errors++;
    }
  }

  // 2) Delete: globais que NÃO estão no arquivo oficial (remove duplicatas/revisados fora).
  if (oficiais.length >= MIN_ENTRADAS_PARA_SYNC) {
    const oficiaisKeys = new Set(oficiais.map(keyOf));
    const globais = await prisma.accountDictionary.findMany({
      where: { userId: null },
      select: { id: true, nomeOriginal: true, tipo: true, grupoConta: true },
    });
    const orfas = globais.filter((g) => !oficiaisKeys.has(keyOf(g)));
    if (orfas.length > 0) {
      await prisma.accountDictionary.deleteMany({ where: { id: { in: orfas.map((o) => o.id) } } });
      deleted = orfas.length;
    }
  } else {
    console.warn(`[SAFETY] Arquivo com ${oficiais.length} entradas (< ${MIN_ENTRADAS_PARA_SYNC}) — pulei o DELETE para não zerar o dicionário.`);
  }

  // 3) Registra UM evento de versão se houve qualquer mudança (changelog interno).
  if (created + updated + deleted > 0) {
    const ultima = await prisma.dictionaryVersion.findFirst({ orderBy: { versao: "desc" }, select: { versao: true } });
    await prisma.dictionaryVersion.create({
      data: {
        versao: (ultima?.versao ?? 0) + 1,
        acao: "import",
        fonte: "manual",
        nota: `Importação oficial do De-Para: ${oficiais.length} entradas (+${created} ~${updated} -${deleted})`,
        criadoPor: "Seed (deploy)",
      },
    });
  }

  const totalGlobais = await prisma.accountDictionary.count({ where: { userId: null } });
  console.log(
    `Sync concluído: ${created} criadas, ${updated} atualizadas, ${deleted} apagadas, ${errors} erros. ` +
      `Total de entradas globais agora: ${totalGlobais}.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
