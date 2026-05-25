import { prisma } from "../db/client";
import { SGS_SERIES, applySgsValues, fetchSgsLatestValue } from "../services/bcb-sgs";
import { clearSectorBenchmarkCache } from "../services/sector-benchmark";
import { withJobLock } from "./lock";

/**
 * Fetch trimestral do Banco Central via SGS API. Schedule típico:
 * `0 3 1 1,4,7,10 *` (1º dia de jan/abr/jul/out, 3h America/Sao_Paulo).
 *
 * Fluxo:
 *   1. Pra cada série configurada (SGS_SERIES), fetch ultima observação
 *   2. Normaliza % → decimal quando aplicável
 *   3. Upsert macros raw em sectorCode="default"
 *   4. Derivar `custo_medio_divida = cdi + spread` e upsert em TODOS os
 *      setores (sobrescreve baseline manual_curation por ordering alfabético)
 *
 * Erros isolados (uma série falhar) não derruba batch. Falha total →
 * JobRun.failed, dados existentes preservados.
 */
export async function runFetchBcbSgs(): Promise<void> {
  await withJobLock("fetch-bcb-sgs", async (ctx) => {
    const year = new Date().getUTCFullYear();
    const values = new Map<string, number>();
    const dates = new Map<string, string>();
    const summary: {
      year: number;
      series: Array<{ code: number; ok: boolean; value?: number; date?: string; error?: string }>;
      upserted?: number;
    } = { year, series: [] };

    for (const config of SGS_SERIES) {
      try {
        const { value, date } = await fetchSgsLatestValue(config);
        values.set(config.metric, value);
        dates.set(config.metric, date);
        summary.series.push({ code: config.seriesCode, ok: true, value, date });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[fetch-bcb-sgs] série ${config.seriesCode} falhou:`, message);
        summary.series.push({ code: config.seriesCode, ok: false, error: message });
      }
    }

    if (values.size === 0) {
      ctx.meta = summary;
      throw new Error("BCB SGS: todas as séries falharam");
    }

    const result = await applySgsValues({ values, year, prismaClient: prisma });
    summary.upserted = result.upserted;
    ctx.meta = summary;

    clearSectorBenchmarkCache();
  });
}
