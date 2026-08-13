/**
 * A/B DO DETECTOR LGPD sobre os nomes REAIS do dicionário (13/08/2026).
 *
 * Detector é decisão de exposição de dado de cliente: falso NEGATIVO vaza nome
 * de terceiro no dicionário global; falso POSITIVO tira do global uma conta
 * genérica que serviria a todo mundo. Os dois custam, então a mudança só sobe
 * medida contra o acervo, nome a nome.
 *
 *   npx tsx scripts/ab-detector-particular.ts            → placar + lista de mudanças
 *   npx tsx scripts/ab-detector-particular.ts --json x   → grava o veredito por nome
 */
import * as fs from "fs";
import { PrismaClient } from "@prisma/client";
import { avaliarContaParticular } from "../src/services/conta-particular";

const prisma = new PrismaClient();
const JSON_OUT = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;

(async () => {
  const linhas = await prisma.accountDictionary.findMany({
    select: { nomeOriginal: true, grupoConta: true, grupoCaminho: true, companyId: true },
  });
  // Nome distinto é a unidade: o mesmo nome em 3 empresas é 1 decisão.
  const porNome = new Map<string, { nome: string; ctx: string | null }>();
  for (const l of linhas) {
    if (!porNome.has(l.nomeOriginal)) porNome.set(l.nomeOriginal, { nome: l.nomeOriginal, ctx: l.grupoCaminho ?? l.grupoConta });
  }
  const casos = [...porNome.values()];

  const vereditos = casos.map((c) => {
    // Dois contextos: o RICO (o caminho do documento, quando existe) e o POBRE
    // ("Ativo Circulante" — o que a fila realmente entrega na maioria das linhas).
    const rico = avaliarContaParticular(c.nome, c.ctx);
    const pobre = avaliarContaParticular(c.nome, c.ctx && c.ctx.includes(">") ? c.ctx.split(">")[0].trim() : c.ctx);
    return { nome: c.nome, ctx: c.ctx, rico, pobre };
  });

  const parts = vereditos.filter((v) => v.rico.particular);
  const duros = vereditos.filter((v) => v.rico.bloqueioDuro);
  const soComCtxRico = vereditos.filter((v) => v.rico.particular && !v.pobre.particular);

  console.log(`nomes distintos ......... ${casos.length}`);
  console.log(`particular (ctx do doc) . ${parts.length}`);
  console.log(`bloqueio duro ........... ${duros.length}`);
  console.log(`DEPENDEM do ctx rico .... ${soComCtxRico.length}  ← o que a fila perde quando o caminho não vem`);

  const porMotivo = new Map<string, number>();
  for (const v of parts) {
    const chave = (v.rico.motivo ?? "?").split("(")[0].trim();
    porMotivo.set(chave, (porMotivo.get(chave) ?? 0) + 1);
  }
  console.log("\npor motivo:");
  for (const [m, q] of [...porMotivo].sort((a, b) => b[1] - a[1])) console.log(`  ${String(q).padStart(4)}  ${m}`);

  console.log("\n— amostra dos flagrados —");
  for (const v of parts.slice(0, 30)) console.log(`  ${v.rico.bloqueioDuro ? "[DURO]" : "      "} "${v.nome}"  ::  ${v.rico.motivo}`);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(vereditos.map((v) => ({ nome: v.nome, particular: v.rico.particular, duro: v.rico.bloqueioDuro, motivo: v.rico.motivo })), null, 1), "utf-8");
    console.log(`\nveredito por nome gravado em ${JSON_OUT}`);
  }
  await prisma.$disconnect();
})();
