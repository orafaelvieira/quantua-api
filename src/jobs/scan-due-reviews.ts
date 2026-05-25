import { prisma } from "../db/client";
import { sendDueReviewEmail } from "../services/email";
import { env } from "../config/env";
import { withJobLock } from "./lock";

/**
 * Varre análises recorrentes com `nextReviewAt` vencendo nos próximos 14 dias
 * ou já vencidas, dispara email ao RT/operator do workspace e marca
 * `lastReviewNotifiedAt`. Idempotente: pula análises já notificadas dentro
 * de 1 dia da próxima revisão.
 *
 * Schedule típico: diário às 7h (America/Sao_Paulo).
 */
export async function runScanDueReviews(): Promise<void> {
  await withJobLock("scan-due-reviews", async (ctx) => {
    const now = new Date();
    const in14Days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    // Janela: já venceu OU vence nos próximos 14 dias.
    // Idempotência: NOT notified OR notified before (nextReview - 1d).
    const candidates = await prisma.analysis.findMany({
      where: {
        mode: "recurring",
        nextReviewAt: { lte: in14Days },
      },
      include: {
        user: { select: { id: true, email: true, name: true } },
        company: { select: { razaoSocial: true, nomeFantasia: true } },
      },
    });

    let notified = 0;
    let skipped = 0;
    let failed = 0;

    for (const analysis of candidates) {
      if (!analysis.nextReviewAt) continue;

      // Pula se já notificou recentemente (< 1d antes do próximo review).
      const cutoff = new Date(analysis.nextReviewAt.getTime() - 24 * 60 * 60 * 1000);
      if (analysis.lastReviewNotifiedAt && analysis.lastReviewNotifiedAt >= cutoff) {
        skipped++;
        continue;
      }

      const companyName = analysis.company.nomeFantasia ?? analysis.company.razaoSocial;
      const overdueDays = Math.floor((now.getTime() - analysis.nextReviewAt.getTime()) / (24 * 60 * 60 * 1000));

      const result = await sendDueReviewEmail({
        to: analysis.user.email,
        rtName: analysis.user.name ?? "Time",
        companyName,
        analysisName: analysis.nome,
        nextReviewAt: analysis.nextReviewAt,
        overdueDays,
        inboxUrl: `${env.frontendUrl}/inbox`,
      });

      if (result.ok) {
        await prisma.analysis.update({
          where: { id: analysis.id },
          data: { lastReviewNotifiedAt: now },
        });
        notified++;
      } else {
        // Não marca lastReviewNotifiedAt — próximo tick tenta de novo.
        failed++;
      }
    }

    ctx.meta = { candidates: candidates.length, notified, skipped, failed };
  });
}
