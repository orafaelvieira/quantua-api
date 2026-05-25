import { Router, Request, Response } from "express";
import { env } from "../config/env";
import { TRIGGERABLE_JOBS } from "../jobs";

const router = Router();

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
  if (!env.adminTriggerToken) {
    res.status(503).json({ error: "Admin trigger desabilitado (ADMIN_TRIGGER_TOKEN não setado)" });
    return;
  }

  const token = req.header("X-Admin-Token");
  if (!token || token !== env.adminTriggerToken) {
    res.status(403).json({ error: "Token inválido" });
    return;
  }

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

export default router;
