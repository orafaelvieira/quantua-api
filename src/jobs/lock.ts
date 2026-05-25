import { prisma } from "../db/client";

/**
 * Helper de lock idempotente para jobs scheduled. Grava uma row em `JobRun`
 * antes de executar e atualiza no fim. Garante observabilidade (consulta
 * histórico) e prepara para o futuro multi-instance (lock leve via DB).
 *
 * Uso:
 *
 *   await withJobLock("scan-due-reviews", async (run) => {
 *     // ... trabalho do job ...
 *     run.meta = { processed: 5, notified: 3 };
 *   });
 *
 * Auto-rescue de runs travadas: se já existe run com status="running" há
 * mais de `stuckThresholdMs` (default 1h), marca como "failed" e prossegue.
 */
export interface JobRunContext {
  /** Metadados serializáveis para gravar no fim. */
  meta: Record<string, unknown>;
}

const DEFAULT_STUCK_THRESHOLD_MS = 60 * 60 * 1000; // 1h

export async function withJobLock<T>(
  jobName: string,
  fn: (ctx: JobRunContext) => Promise<T>,
  options: { stuckThresholdMs?: number } = {},
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  const stuckThresholdMs = options.stuckThresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS;

  // Rescue de runs travadas. Marca como failed e segue.
  const stuckCutoff = new Date(Date.now() - stuckThresholdMs);
  const stuck = await prisma.jobRun.findMany({
    where: { jobName, status: "running", startedAt: { lt: stuckCutoff } },
  });
  if (stuck.length > 0) {
    await prisma.jobRun.updateMany({
      where: { id: { in: stuck.map((s) => s.id) } },
      data: { status: "failed", finishedAt: new Date(), meta: { reason: "stuck > threshold" } },
    });
    console.warn(`[jobs] ${jobName}: ${stuck.length} stuck run(s) marked as failed`);
  }

  // Verifica se já há um run ativo. Se sim, pula esta execução.
  const active = await prisma.jobRun.findFirst({
    where: { jobName, status: "running" },
  });
  if (active) {
    console.log(`[jobs] ${jobName}: skip — run ${active.id} já em andamento`);
    return { ok: false, error: "already running" };
  }

  const run = await prisma.jobRun.create({
    data: { jobName, status: "running" },
  });

  const ctx: JobRunContext = { meta: {} };
  try {
    const result = await fn(ctx);
    await prisma.jobRun.update({
      where: { id: run.id },
      data: { status: "success", finishedAt: new Date(), meta: ctx.meta as object },
    });
    console.log(`[jobs] ${jobName}: ok (run ${run.id})`, ctx.meta);
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.jobRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        meta: { ...ctx.meta, error: message } as object,
      },
    });
    console.error(`[jobs] ${jobName}: failed (run ${run.id})`, message);
    return { ok: false, error: message };
  }
}
