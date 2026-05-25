import { prisma } from "../db/client";
import { uploadFile } from "../services/storage";
import {
  DAMODARAN_SOURCES,
  applyDamodaranRows,
  fetchDamodaranXls,
} from "../services/damodaran";
import { clearSectorBenchmarkCache } from "../services/sector-benchmark";
import { withJobLock } from "./lock";

/**
 * Fetch mensal dos XLSs Damodaran (margens + working capital). Schedule típico:
 * `0 3 1 * *` (1º dia do mês às 3h, America/Sao_Paulo).
 *
 * Fluxo por XLS:
 *   1. Fetch URL → buffer cru
 *   2. Snapshot do buffer em DO Spaces (path `raw-imports/damodaran/YYYY-MM-name.xls`)
 *      pra debug se parsing quebrar no futuro
 *   3. Parse via xlsx + Zod
 *   4. Resolve Damodaran industry → sectorCode via DamodaranMapping
 *   5. Upsert em SectorBenchmark com source='damodaran', year=ano atual
 *
 * Erros isolados (uma fonte falhar) não abortam o job — outras fontes seguem.
 * Erros catastróficos (todas falharem) → JobRun.status="failed", meta.errors.
 *
 * Após sucesso, limpa o cache in-memory de `getSectorBenchmark` pra que próxima
 * leitura pegue valores novos.
 */
export async function runFetchDamodaranBenchmarks(): Promise<void> {
  await withJobLock("fetch-damodaran-benchmarks", async (ctx) => {
    const now = new Date();
    const year = now.getUTCFullYear();
    const yyyymm = `${year}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

    const summary: {
      sources: Array<{ name: string; ok: boolean; rows?: number; upserted?: number; mapped?: number; unmapped?: string[]; error?: string }>;
      year: number;
      yyyymm: string;
    } = { sources: [], year, yyyymm };

    for (const source of DAMODARAN_SOURCES) {
      try {
        const { rawBuffer, rows } = await fetchDamodaranXls(source);

        // Snapshot bruto pra Spaces — best-effort, não falha o job se Spaces down.
        const rawKey = `raw-imports/damodaran/${yyyymm}-${source.name}.xls`;
        let rawSourceUrl = "https://pages.stern.nyu.edu/~adamodar/";
        try {
          await uploadFile(rawBuffer, rawKey, "application/vnd.ms-excel");
          rawSourceUrl = rawKey;
        } catch (uploadErr) {
          console.warn(`[fetch-damodaran] snapshot upload falhou (${source.name}):`, uploadErr);
        }

        const result = await applyDamodaranRows({
          rows,
          sourceName: source.name,
          year,
          rawSourceUrl,
          prismaClient: prisma,
        });

        summary.sources.push({
          name: source.name,
          ok: true,
          rows: rows.length,
          upserted: result.upserted,
          mapped: result.mapped,
          unmapped: result.unmapped,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[fetch-damodaran] source ${source.name} falhou:`, message);
        summary.sources.push({ name: source.name, ok: false, error: message });
      }
    }

    clearSectorBenchmarkCache();

    const ok = summary.sources.some((s) => s.ok);
    ctx.meta = summary;

    if (!ok) {
      // Nenhuma fonte conseguiu — propaga erro pro withJobLock marcar status=failed.
      throw new Error("all damodaran sources failed");
    }
  });
}
