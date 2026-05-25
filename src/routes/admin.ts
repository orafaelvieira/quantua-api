import { Router, Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { prisma } from "../db/client";
import { TRIGGERABLE_JOBS } from "../jobs";

const router = Router();

/**
 * Auth middleware compartilhado por todo o router /admin.
 * Token vazio = endpoint admin DESABILITADO (não cai em default trivial).
 */
function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  if (!env.adminTriggerToken) {
    res.status(503).json({ error: "Admin endpoints desabilitados (ADMIN_TRIGGER_TOKEN não setado)" });
    return;
  }
  const token = req.header("X-Admin-Token");
  if (!token || token !== env.adminTriggerToken) {
    res.status(403).json({ error: "Token inválido" });
    return;
  }
  next();
}

router.use(requireAdminToken);

/**
 * Endpoint admin pra trigger manual de jobs. Auth via header `X-Admin-Token`
 * matchando `env.ADMIN_TRIGGER_TOKEN`. Endpoint fica DESLIGADO se token vazio
 * — não cai num default trivial por engano em prod.
 *
 * Uso:
 *   curl -X POST -H "X-Admin-Token: $TOKEN" \
 *        https://api.quantua.com.br/admin/jobs/run/fetch-damodaran-benchmarks
 *
 * Response sync: `{ok: true, job: "name", durationMs}` — bloqueia até job
 * terminar. Jobs longos (>30s) podem timeout no client; rodar em background
 * fica como evolução futura via `setImmediate` + JobRun polling.
 */
router.post("/jobs/run/:jobName", async (req: Request, res: Response): Promise<void> => {
  const jobName = req.params.jobName as string;
  const runFn = TRIGGERABLE_JOBS[jobName];
  if (!runFn) {
    res.status(404).json({
      error: `Job desconhecido: ${jobName}`,
      available: Object.keys(TRIGGERABLE_JOBS),
    });
    return;
  }

  const start = Date.now();
  try {
    await runFn();
    res.json({ ok: true, job: jobName, durationMs: Date.now() - start });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] trigger ${jobName} falhou:`, message);
    res.status(500).json({ ok: false, job: jobName, error: message, durationMs: Date.now() - start });
  }
});

/**
 * GET /admin/benchmarks/coverage — tabela de observabilidade pro pipeline #6.
 *
 * Pra cada setor ativo, mostra:
 *   - Mais recente fetch por source (manual_curation, damodaran, ibge_pia, bcb_sgs)
 *   - Métricas cobertas
 *   - Último JobRun de cada cron, status, duração, meta
 *
 * Frontend renderiza isso como tabela em /admin/benchmarks (partner-only).
 * Auth herda do middleware do router (X-Admin-Token).
 */
router.get("/benchmarks/coverage", async (_req: Request, res: Response): Promise<void> => {
  // Setores ativos + última leitura por (sector, source)
  const sectors = await prisma.sector.findMany({
    where: { active: true },
    orderBy: [{ parentCode: { sort: "asc", nulls: "first" } }, { code: "asc" }],
  });

  const benchmarks = await prisma.sectorBenchmark.findMany({
    select: { sectorCode: true, source: true, metric: true, fetchedAt: true, year: true },
  });

  // Agrega por (sectorCode, source): última fetchedAt + métricas distintas.
  const coverageBySector = new Map<
    string,
    Map<string, { fetchedAt: Date; metrics: Set<string>; latestYear: number }>
  >();
  for (const b of benchmarks) {
    if (!coverageBySector.has(b.sectorCode)) coverageBySector.set(b.sectorCode, new Map());
    const sectorMap = coverageBySector.get(b.sectorCode)!;
    const existing = sectorMap.get(b.source);
    if (!existing) {
      sectorMap.set(b.source, {
        fetchedAt: b.fetchedAt,
        metrics: new Set([b.metric]),
        latestYear: b.year,
      });
    } else {
      existing.metrics.add(b.metric);
      if (b.fetchedAt > existing.fetchedAt) existing.fetchedAt = b.fetchedAt;
      if (b.year > existing.latestYear) existing.latestYear = b.year;
    }
  }

  // Últimos JobRuns por jobName.
  const recentRuns = await prisma.jobRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 200,
  });
  const lastRunByJob = new Map<string, typeof recentRuns[number]>();
  for (const run of recentRuns) {
    if (!lastRunByJob.has(run.jobName)) lastRunByJob.set(run.jobName, run);
  }

  const sectorRows = sectors.map((s) => {
    const sources = coverageBySector.get(s.code) ?? new Map();
    return {
      code: s.code,
      name: s.name,
      parentCode: s.parentCode,
      sources: Array.from(sources.entries()).map(([source, info]) => ({
        source,
        fetchedAt: info.fetchedAt,
        latestYear: info.latestYear,
        metricCount: info.metrics.size,
        metrics: Array.from(info.metrics).sort(),
      })),
    };
  });

  const jobRows = Object.keys(TRIGGERABLE_JOBS).map((jobName) => {
    const last = lastRunByJob.get(jobName);
    return {
      jobName,
      lastStartedAt: last?.startedAt ?? null,
      lastFinishedAt: last?.finishedAt ?? null,
      lastStatus: last?.status ?? "never_run",
      lastMeta: last?.meta ?? null,
    };
  });

  res.json({
    generatedAt: new Date().toISOString(),
    sectorCount: sectors.length,
    sectors: sectorRows,
    jobs: jobRows,
  });
});

export default router;
