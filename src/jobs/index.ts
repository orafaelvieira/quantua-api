import cron from "node-cron";
import { env } from "../config/env";
import { runScanDueReviews } from "./scan-due-reviews";
import { runFetchDamodaranBenchmarks } from "./fetch-damodaran-benchmarks";

/**
 * Bootstrap dos jobs schedulados. Chamado de `server.ts` no boot.
 *
 * Estratégia: cron in-process via node-cron. Compartilha pool Prisma e logger.
 * Multi-instance no futuro resolve via lock em `JobRun` (vide `lock.ts`).
 *
 * Toggle: `JOBS_ENABLED=true` em prod (`.do/app.yaml`); default false em dev
 * para não disparar emails reais durante desenvolvimento local.
 */
export function startJobs(): void {
  if (!env.jobs.enabled) {
    console.log("[jobs] startJobs: skip — JOBS_ENABLED não setado");
    return;
  }

  const tz = env.jobs.timezone;
  console.log(`[jobs] startJobs: registrando schedules em tz=${tz}`);

  // Diário às 7h — varre revisões recorrentes vencendo.
  cron.schedule(
    "0 7 * * *",
    () => {
      runScanDueReviews().catch((err) => {
        console.error("[jobs] scan-due-reviews: erro não capturado", err);
      });
    },
    { timezone: tz },
  );

  console.log("[jobs] registrado: scan-due-reviews (0 7 * * *)");

  // Mensal — dia 1 às 3h da manhã, refresh dos benchmarks Damodaran.
  cron.schedule(
    "0 3 1 * *",
    () => {
      runFetchDamodaranBenchmarks().catch((err) => {
        console.error("[jobs] fetch-damodaran-benchmarks: erro não capturado", err);
      });
    },
    { timezone: tz },
  );

  console.log("[jobs] registrado: fetch-damodaran-benchmarks (0 3 1 * *)");
}

/**
 * Whitelist de jobs disparáveis via endpoint admin. Mapeia nome (mesmo de
 * `jobName` no `withJobLock`) pra função executável.
 */
export const TRIGGERABLE_JOBS: Record<string, () => Promise<void>> = {
  "scan-due-reviews": runScanDueReviews,
  "fetch-damodaran-benchmarks": runFetchDamodaranBenchmarks,
};
