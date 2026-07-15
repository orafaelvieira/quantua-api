/** Inspeção rápida: versões do modelo DRE no banco (qual está ativa, linhas). */
import { prisma } from "../src/db/client";

async function main() {
  const vs = await prisma.standardModel.findMany({ where: { tipo: "DRE" }, orderBy: { versao: "asc" }, include: { linhas: true } });
  for (const v of vs) console.log(`v${v.versao} · ativo=${v.ativo} · criadoPor=${v.criadoPor ?? "null"} · ${v.linhas.length} linhas · ${v.nota ?? ""}`);
  const ativa = vs.find((v) => v.ativo);
  if (ativa) {
    console.log(`ATIVA v${ativa.versao}:`);
    console.log(ativa.linhas.sort((a, b) => a.ordem - b.ordem).map((l) => l.nome).join(" | "));
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(2); });
