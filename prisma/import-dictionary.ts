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

/**
 * Importa o dicionário De-Para a partir de prisma/seed-data/account-dictionary.json
 * como entradas GLOBAIS (userId = null).
 *
 * Idempotente: usa findFirst + create/update na chave única
 * (nomeOriginal, tipo, grupoConta, userId=null), mesmo padrão de prisma/seed.ts —
 * upsert direto não funciona porque a unique tem userId nullable.
 *
 * Rodar: npm run db:seed:dictionary
 */
async function main() {
  const file = join(__dirname, "seed-data", "account-dictionary.json");
  const entries: DictEntry[] = JSON.parse(readFileSync(file, "utf-8"));

  console.log(`Importando ${entries.length} entradas globais do dicionário...`);

  let created = 0;
  let updated = 0;
  let errors = 0;

  for (const entry of entries) {
    const nomeOriginal = entry.nomeOriginal?.trim();
    const contaDestino = entry.contaDestino?.trim();
    const grupoConta = entry.grupoConta?.trim();
    const tipo = entry.tipo === "DRE" ? "DRE" : "BP";

    if (!nomeOriginal || !contaDestino || !grupoConta) continue;

    try {
      const existing = await prisma.accountDictionary.findFirst({
        where: { nomeOriginal, tipo, grupoConta, userId: null },
      });

      if (existing) {
        if (existing.contaDestino !== contaDestino) {
          await prisma.accountDictionary.update({
            where: { id: existing.id },
            data: { contaDestino },
          });
          updated++;
        }
      } else {
        await prisma.accountDictionary.create({
          data: { nomeOriginal, contaDestino, grupoConta, tipo }, // userId null => global
        });
        created++;
      }
    } catch (err) {
      console.error(`Erro em "${nomeOriginal}" (${tipo}/${grupoConta}):`, err);
      errors++;
    }
  }

  const totalGlobais = await prisma.accountDictionary.count({ where: { userId: null } });
  console.log(
    `Importação concluída: ${created} criadas, ${updated} atualizadas, ${errors} erros. ` +
      `Total de entradas globais agora: ${totalGlobais}.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
