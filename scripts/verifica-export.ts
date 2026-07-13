/**
 * Verificação do export Excel dos Modelos Financeiros (uso pontual, dev):
 * carrega o modelo do banco, RECALCULA com o motor (independente do cache)
 * e imprime JSON para o comparador cruzar com o arquivo baixado.
 * Uso: npx tsx scripts/verifica-export.ts "<parte do nome do modelo>" <saida.json>
 */
import { writeFileSync } from "node:fs";
import { prisma } from "../src/db/client";
import { calcularModelo, BlocoModelo, ScenarioOverrides, RealizadoModelo } from "../src/services/model-engine";

async function main() {
  const filtro = process.argv[2] ?? "";
  const saida = process.argv[3] ?? "verifica-export.json";
  const model = await prisma.financialModel.findFirst({
    where: { nome: { contains: filtro, mode: "insensitive" } },
    include: { blocks: { orderBy: { ordem: "asc" } }, scenarios: true },
    orderBy: { updatedAt: "desc" },
  });
  if (!model) throw new Error(`Modelo com nome contendo "${filtro}" não encontrado`);
  const cenario = model.scenarios.find((s) => s.id === model.cenarioAtivoId) ?? model.scenarios.find((s) => s.isBase);
  const resultado = calcularModelo({
    mesInicial: model.mesInicial,
    horizonteMeses: model.horizonteMeses,
    blocks: model.blocks.map((b) => ({ id: b.id, tipo: b.tipo, nome: b.nome, ativo: b.ativo, config: b.config as BlocoModelo["config"] })),
    overrides: (cenario?.overrides ?? {}) as ScenarioOverrides,
    realizado: (model.realizado as RealizadoModelo | null) ?? null,
  });
  const cache = model.resultadoCache as { dre?: Array<{ id: string; valores: Record<string, number> }> } | null;
  writeFileSync(saida, JSON.stringify({
    nome: model.nome,
    cenario: cenario?.nome ?? "Base",
    mesInicial: model.mesInicial,
    horizonteMeses: model.horizonteMeses,
    resultado,
    cacheDre: cache?.dre ?? null,
  }));
  console.log(`ok: ${model.nome} · cenário ${cenario?.nome} · ${resultado.meses.length} meses · ${resultado.dre.length} linhas de DRE`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
