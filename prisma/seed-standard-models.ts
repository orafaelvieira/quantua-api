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

  // Modelo vigente no banco (se houver). Só publica nova versão se o CONTEÚDO do
  // template mudou — preservando a versão anterior (pinagem). Edições futuras feitas
  // pelo usuário na tela ficam protegidas: o seed só age quando o template do código
  // diverge do vigente (ex.: esta migração do BP granular CP/LP).
  const ativo = await prisma.standardModel.findFirst({
    where: { tipo, ativo: true },
    include: { linhas: { orderBy: { ordem: "asc" } } },
  });
  const assinatura = (ls: Array<{ nome: string; grupo: string; nivel: number; tipo: string }>) =>
    ls.map((l) => `${l.nome}|${l.grupo}|${l.nivel}|${l.tipo}`).join("\n");

  if (ativo && assinatura(ativo.linhas) === assinatura(linhas)) {
    console.log(`  ${tipo}: v${ativo.versao} já reflete o template — pulando.`);
    return;
  }

  const proxVersao = ((await prisma.standardModel.aggregate({ where: { tipo }, _max: { versao: true } }))._max.versao ?? 0) + 1;
  await prisma.$transaction(async (tx) => {
    await tx.standardModel.updateMany({ where: { tipo, ativo: true }, data: { ativo: false } });
    await tx.standardModel.create({
      data: {
        tipo, versao: proxVersao, ativo: true,
        nota: proxVersao === 1 ? "Versão inicial (migrada dos templates do código)" : "Atualização do template do código",
        criadoPor: "sistema",
        linhas: { create: linhas },
      },
    });
  });
  console.log(`  ${tipo}: v${proxVersao} publicada com ${linhas.length} linhas${ativo ? ` (anterior v${ativo.versao} preservada)` : ""}.`);
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
