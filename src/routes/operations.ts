import { Router, Response } from "express";
import { prisma } from "../db/client";
import { requireAuth, requireQuantua, AuthRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);
// F2 SaaS: dado de FIRMA — usuário externo (empresa/parceiro) e portal nunca acessam.
router.use(requireQuantua);

type Phase = "engagement" | "collection" | "analysis" | "review" | "delivery";

function phaseFor(reviewState: string, hasDocuments: boolean, status: string): Phase {
  if (reviewState === "delivered") return "delivery";
  if (reviewState === "signed") return "delivery";
  if (reviewState === "approved") return "review";
  if (reviewState === "in_review" || reviewState === "revision_requested") return "review";
  if (status === "Concluída") return "analysis";
  if (hasDocuments) return "analysis";
  return "collection";
}

router.get("/pipeline", async (req: AuthRequest, res: Response): Promise<void> => {
  const analyses = await prisma.analysis.findMany({
    where: { userId: { in: req.scopeUserIds! }, kind: "ibr" },
    orderBy: { createdAt: "desc" },
    include: {
      company: { select: { razaoSocial: true, nomeFantasia: true } },
      documents: { select: { id: true } },
      engagement: { include: { rt: { select: { name: true } } } },
      timeEntries: { select: { hours: true } },
    },
  });

  const items = analyses.map((a) => {
    const companyName = a.company?.nomeFantasia || a.company?.razaoSocial || "Empresa";
    const phase = phaseFor(a.reviewState, a.documents.length > 0, a.status);
    const hoursLogged = a.timeEntries.reduce((s, t) => s + t.hours, 0);
    const progress =
      a.reviewState === "delivered" ? 1 :
      a.reviewState === "signed" ? 0.95 :
      a.reviewState === "approved" ? 0.85 :
      a.reviewState === "in_review" ? 0.7 :
      a.reviewState === "revision_requested" ? 0.6 :
      a.status === "Concluída" ? 0.5 :
      a.documents.length > 0 ? 0.3 : 0.1;
    return {
      id: a.id,
      companyName,
      requestedBy: a.engagement?.requestedBy,
      rt: a.engagement?.rt?.name,
      reviewState: a.reviewState,
      phase,
      deadline: a.engagement?.deadline?.toISOString(),
      progress,
      hoursLogged,
      feeAmount: a.engagement?.feeAmount ?? undefined,
    };
  });
  res.json(items);
});

router.get("/workload", async (req: AuthRequest, res: Response): Promise<void> => {
  // Por enquanto, agrupamos horas por usuário do workspace do RT logado.
  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  const team = await prisma.user.findMany({
    where: {
      OR: [
        { id: req.userId! },
        { role: { in: ["operator", "reviewer", "partner"] } },
      ],
    },
    select: { id: true, name: true, role: true },
  });

  const entries = await prisma.timeEntry.findMany({
    where: {
      analysis: { userId: { in: req.scopeUserIds! } },
      date: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
    },
    select: { userId: true, hours: true, analysisId: true },
  });

  const activeIBRsByUser = new Map<string, Set<string>>();
  const hoursByUser = new Map<string, number>();
  for (const e of entries) {
    hoursByUser.set(e.userId, (hoursByUser.get(e.userId) ?? 0) + e.hours);
    if (!activeIBRsByUser.has(e.userId)) activeIBRsByUser.set(e.userId, new Set());
    activeIBRsByUser.get(e.userId)!.add(e.analysisId);
  }

  // Capacidade default: 160h/mês.
  const CAPACITY_HOURS = 160;
  const out = team.map((t) => ({
    userId: t.id,
    userName: t.name,
    role: (t.role ?? "operator") as "operator" | "reviewer" | "partner",
    activeIBRs: activeIBRsByUser.get(t.id)?.size ?? 0,
    hoursAllocated: hoursByUser.get(t.id) ?? 0,
    capacityHours: CAPACITY_HOURS,
  }));
  res.json(out);
});

router.get("/kpis", async (req: AuthRequest, res: Response): Promise<void> => {
  const scopeIds = req.scopeUserIds!;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [inProduction, deliveredThisMonth, deliveredAll, slaAtRiskRaw] = await Promise.all([
    prisma.analysis.count({
      where: { userId: { in: scopeIds }, kind: "ibr", reviewState: { notIn: ["delivered"] } },
    }),
    prisma.analysis.count({
      where: { userId: { in: scopeIds }, kind: "ibr", reviewState: "delivered" /*, deliveredAt >= startOfMonth */ },
    }),
    prisma.analysis.findMany({
      where: { userId: { in: scopeIds }, kind: "ibr", reviewState: "delivered" },
      select: { createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.analysis.findMany({
      where: {
        userId: { in: scopeIds },
        kind: "ibr",
        reviewState: { notIn: ["delivered", "signed"] },
        engagement: { deadline: { not: null } },
      },
      select: {
        engagement: { select: { deadline: true } },
        documents: { select: { id: true } },
        reviewState: true,
        status: true,
      },
    }),
  ]);

  const avgDeliveryDays = deliveredAll.length > 0
    ? deliveredAll.reduce((s, a) => s + (Date.now() - a.createdAt.getTime()) / (1000 * 3600 * 24), 0) / deliveredAll.length / 1
    : null;

  const slaAtRisk = slaAtRiskRaw.filter((a) => {
    if (!a.engagement?.deadline) return false;
    const daysToDeadline = (a.engagement.deadline.getTime() - Date.now()) / (1000 * 3600 * 24);
    const progress =
      a.reviewState === "approved" ? 0.85 :
      a.reviewState === "in_review" ? 0.7 :
      a.status === "Concluída" ? 0.5 : 0.3;
    return daysToDeadline < 3 && progress < 0.7;
  }).length;

  // Margem média: requer time entries + fee. Fórmula simplificada.
  const fees = await prisma.engagement.findMany({
    where: { userId: { in: scopeIds }, feeAmount: { not: null }, analysisId: { not: null } },
    select: { feeAmount: true, analysisId: true },
  });
  const HOURLY_COST = 350;
  let marginSum = 0;
  let marginCount = 0;
  for (const f of fees) {
    if (!f.analysisId || !f.feeAmount) continue;
    const hours = await prisma.timeEntry.aggregate({
      where: { analysisId: f.analysisId },
      _sum: { hours: true },
    });
    const cost = (hours._sum.hours ?? 0) * HOURLY_COST;
    if (cost > 0 && f.feeAmount > 0) {
      marginSum += (f.feeAmount - cost) / f.feeAmount;
      marginCount += 1;
    }
  }
  const avgGrossMarginPct = marginCount > 0 ? marginSum / marginCount : null;

  res.json({
    inProduction,
    deliveredThisMonth,
    avgDeliveryDays: avgDeliveryDays ?? 0,
    avgGrossMarginPct: avgGrossMarginPct ?? 0,
    slaAtRisk,
  });
});

router.get("/alerts", async (req: AuthRequest, res: Response): Promise<void> => {
  const scopeIds = req.scopeUserIds!;
  const alerts: { id: string; severity: "info" | "warning" | "critical"; message: string; analysisId?: string }[] = [];

  // IBRs sem RT atribuído
  const noRT = await prisma.engagement.findMany({
    where: { userId: { in: scopeIds }, rtId: null, state: { in: ["won", "kicked_off"] } },
    take: 5,
    select: { id: true, companyName: true, analysisId: true },
  });
  for (const e of noRT) {
    alerts.push({
      id: `no-rt-${e.id}`,
      severity: "warning",
      message: `Engagement de ${e.companyName} sem RT atribuído.`,
      analysisId: e.analysisId ?? undefined,
    });
  }

  // Deadlines próximas
  const nearDeadline = await prisma.engagement.findMany({
    where: {
      userId: { in: scopeIds },
      deadline: {
        gte: new Date(),
        lte: new Date(Date.now() + 5 * 24 * 3600 * 1000),
      },
    },
    take: 5,
    select: { id: true, companyName: true, deadline: true, analysisId: true },
  });
  for (const e of nearDeadline) {
    const days = Math.round((e.deadline!.getTime() - Date.now()) / (1000 * 3600 * 24));
    alerts.push({
      id: `deadline-${e.id}`,
      severity: days <= 2 ? "critical" : "warning",
      message: `${e.companyName}: prazo em ${days} dia(s).`,
      analysisId: e.analysisId ?? undefined,
    });
  }

  res.json(alerts);
});

export default router;
