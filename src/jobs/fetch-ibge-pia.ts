import { prisma } from "../db/client";
import {
  PIA_VARIABLES,
  applyPiaRows,
  deriveMargemBruta,
  fetchPiaVariable,
} from "../services/ibge-pia";
import { clearSectorBenchmarkCache } from "../services/sector-benchmark";
import { withJobLock } from "./lock";

/**
 * Fetch anual do IBGE PIA via SIDRA. Schedule típico: `0 3 15 6 *` (15 jun
 * America/Sao_Paulo) — após o IBGE publicar (defasagem ~18 meses).
 *
 * Fluxo:
 *   1. Fetch das variáveis PIA configuradas (receita + custos)
 *   2. Derivar margem_bruta = 1 - custos/receita por CNAE
 *   3. Resolver CNAE → sectorCode via CnaeMapping (agrega múltiplos CNAE/setor)
 *   4. Upsert em SectorBenchmark com source='ibge_pia', percentile=50
 *
 * SIDRA é flaky — fetcher tem retry 3x exp backoff + timeout 120s. Se uma
 * variável falhar, outras continuam. Falha total → JobRun.failed, dados
 * existentes preservados.
 *
 * Ano alvo: ano atual - 2 (PIA de N publica em mid-N+2). Se rodar em
 * 2026-06, busca ano 2024.
 */
export async function runFetchIbgePia(): Promise<void> {
  await withJobLock("fetch-ibge-pia", async (ctx) => {
    const targetYear = new Date().getUTCFullYear() - 2;
    const summary: {
      year: number;
      variables: Array<{ code: string; ok: boolean; rows?: number; error?: string }>;
      upserted?: number;
      mapped?: number;
      unmapped?: string[];
    } = { year: targetYear, variables: [] };

    const rowsByVariable = new Map<string, Awaited<ReturnType<typeof fetchPiaVariable>>>();
    for (const config of PIA_VARIABLES) {
      try {
        const rows = await fetchPiaVariable(config);
        rowsByVariable.set(config.metric, rows);
        summary.variables.push({ code: config.variableCode, ok: true, rows: rows.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[fetch-ibge-pia] variable ${config.variableCode} falhou:`, message);
        summary.variables.push({ code: config.variableCode, ok: false, error: message });
      }
    }

    const receita = rowsByVariable.get("receita_liquida_anual");
    const custos = rowsByVariable.get("custos_diretos_anual");
    if (!receita || !custos) {
      ctx.meta = summary;
      throw new Error("PIA: receita ou custos faltaram — sem derivar margem_bruta");
    }

    const derived = deriveMargemBruta(receita, custos);
    const result = await applyPiaRows({
      rows: derived,
      year: targetYear,
      rawSourceUrl: "https://apisidra.ibge.gov.br/values/t/1849",
      prismaClient: prisma,
    });

    summary.upserted = result.upserted;
    summary.mapped = result.mapped;
    summary.unmapped = result.unmapped;
    ctx.meta = summary;

    clearSectorBenchmarkCache();
  });
}
