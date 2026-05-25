import cron from "node-cron";
import { env } from "../config/env";
import { runScanDueReviews } from "./scan-due-reviews";
import { runFetchDamodaranBenchmarks } from "./fetch-damodaran-benchmarks";
import { runFetchIbgePia } from "./fetch-ibge-pia";
import { runFetchBcbSgs } from "./fetch-bcb-sgs";

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

  // Anual — 15 jun às 3h, refresh dos benchmarks IBGE PIA (defasagem ~18m).
  cron.schedule(
    "0 3 15 6 *",
    () => {
      runFetchIbgePia().catch((err) => {
        console.error("[jobs] fetch-ibge-pia: erro não capturado", err);
      });
    },
    { timezone: tz },
  );

  console.log("[jobs] registrado: fetch-ibge-pia (0 3 15 6 *)");

  // Trimestral — dia 1 de jan/abr/jul/out às 3h, refresh do Banco Central.
  cron.schedule(
    "0 3 1 1,4,7,10 *",
    () => {
      runFetchBcbSgs().catch((err) => {
        console.error("[jobs] fetch-bcb-sgs: erro não capturado", err);
      });
    },
    { timezone: tz },
  );

  console.log("[jobs] registrado: fetch-bcb-sgs (0 3 1 1,4,7,10 *)");
}

/**
 * Whitelist de jobs disparáveis via endpoint admin. Mapeia nome (mesmo de
 * `jobName` no `withJobLock`) pra função executável.
 */
export const TRIGGERABLE_JOBS: Record<string, () => Promise<void>> = {
  "scan-due-reviews": runScanDueReviews,
  "fetch-damodaran-benchmarks": runFetchDamodaranBenchmarks,
  "fetch-ibge-pia": runFetchIbgePia,
  "fetch-bcb-sgs": runFetchBcbSgs,
};
