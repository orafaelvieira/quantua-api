import { Router, Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { TRIGGERABLE_JOBS } from "../jobs";
import { getBenchmarkCoverage } from "../services/benchmark-coverage";

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
  const report = await getBenchmarkCoverage();
  res.json(report);
});

export default router;
