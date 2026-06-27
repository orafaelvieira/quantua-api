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
  const existe = await prisma.standardModel.findFirst({ where: { tipo } });
  if (existe) {
    console.log(`  ${tipo}: já existe (v${existe.versao}) — pulando.`);
    return;
  }

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

  await prisma.standardModel.create({
    data: {
      tipo,
      versao: 1,
      ativo: true,
      nota: "Versão inicial (migrada dos templates do código)",
      criadoPor: "sistema",
      linhas: { create: linhas },
    },
  });
  console.log(`  ${tipo}: v1 criada com ${linhas.length} linhas.`);
}

async function main() {
  console.log("Seed dos modelos padrão (BP/DRE):");
  await seedTipo("BP");
  await seedTipo("DRE");
  const total = await prisma.standardModelLine.count();
  console.log(`Concluído. Total de linhas de modelo no banco: ${total}.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
