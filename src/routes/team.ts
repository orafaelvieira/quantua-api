import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

const allocationCreateSchema = z.object({
  userId: z.string().uuid(),
  analysisId: z.string().uuid(),
  phase: z.enum(["engagement", "collection", "analysis", "review", "delivery"]),
  plannedHours: z.number().positive(),
  startDate: z.string(),
  endDate: z.string(),
  notes: z.string().optional(),
});

router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const me = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { workspaceId: true },
  });
  if (!me) { res.status(401).json({ error: "Sessão inválida" }); return; }

  const where = me.workspaceId
    ? { workspaceId: me.workspaceId }
    : {
        OR: [
          { id: req.userId! },
          { role: { in: ["operator", "reviewer", "partner"] } },
        ],
      };

  const members = await prisma.user.findMany({
    where,
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      cargo: true,
      professionalRegistration: true,
      onboardedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const memberIds = members.map((m) => m.id);

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

  const [allocations, timeEntries, signedAnalyses] = await Promise.all([
    prisma.allocation.findMany({
      where: {
        userId: { in: memberIds },
        endDate: { gte: now },
      },
      select: {
        userId: true,
        analysisId: true,
        plannedHours: true,
      },
    }),
    prisma.timeEntry.findMany({
      where: {
        userId: { in: memberIds },
        date: { gte: thirtyDaysAgo },
      },
      select: { userId: true, hours: true },
    }),
    prisma.analysis.findMany({
      where: {
        userId: { in: memberIds },
        kind: "ibr",
        reviewState: "signed",
      },
      select: { userId: true },
    }),
  ]);

  const activeIBRsByUser = new Map<string, Set<string>>();
  const plannedByUser = new Map<string, number>();
  for (const a of allocations) {
    plannedByUser.set(a.userId, (plannedByUser.get(a.userId) ?? 0) + a.plannedHours);
    if (!activeIBRsByUser.has(a.userId)) activeIBRsByUser.set(a.userId, new Set());
    activeIBRsByUser.get(a.userId)!.add(a.analysisId);
  }
  const loggedByUser = new Map<string, number>();
  for (const e of timeEntries) {
    loggedByUser.set(e.userId, (loggedByUser.get(e.userId) ?? 0) + e.hours);
  }
  const signedByUser = new Map<string, number>();
  for (const s of signedAnalyses) {
    signedByUser.set(s.userId, (signedByUser.get(s.userId) ?? 0) + 1);
  }

  const CAPACITY_HOURS = 160;
  const out = members.map((m) => {
    const initials = m.name
      .split(/\s+/)
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
    return {
      userId: m.id,
      name: m.name,
      email: m.email,
      initials,
      role: m.role ?? "operator",
      cargo: m.cargo ?? null,
      professionalRegistration: m.professionalRegistration ?? null,
      status: m.onboardedAt ? "active" : "pending",
      capacityHours: CAPACITY_HOURS,
      activeIBRs: activeIBRsByUser.get(m.id)?.size ?? 0,
      plannedHours: plannedByUser.get(m.id) ?? 0,
      loggedHours30d: loggedByUser.get(m.id) ?? 0,
      signedCount: signedByUser.get(m.id) ?? 0,
    };
  });

  const totalCapacity = out.length * CAPACITY_HOURS;
  const totalPlanned = out.reduce((s, m) => s + m.plannedHours, 0);
  const totalLogged = out.reduce((s, m) => s + m.loggedHours30d, 0);
  const totalSigned = out.reduce((s, m) => s + m.signedCount, 0);
  const activePartners = out.filter((m) => m.role === "partner" && m.status === "active").length;
  const avgHoursPerIbr = totalSigned > 0 ? totalLogged / totalSigned : 0;
  const capacityUtilizationPct = totalCapacity > 0 ? (totalPlanned / totalCapacity) * 100 : 0;

  res.json({
    members: out,
    kpis: {
      activePartners,
      totalMembers: out.length,
      capacityUtilizationPct,
      avgHoursPerIbr,
      totalSigned,
    },
  });
});

router.get("/allocations", async (req: AuthRequest, res: Response): Promise<void> => {
  const me = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { workspaceId: true },
  });
  const members = await prisma.user.findMany({
    where: me?.workspaceId ? { workspaceId: me.workspaceId } : { id: req.userId! },
    select: { id: true },
  });
  const memberIds = members.map((m) => m.id);

  const allocations = await prisma.allocation.findMany({
    where: { userId: { in: memberIds } },
    orderBy: { startDate: "desc" },
    include: {
      user: { select: { id: true, name: true } },
      analysis: {
        select: {
          id: true,
          nome: true,
          company: { select: { razaoSocial: true, nomeFantasia: true } },
        },
      },
    },
  });

  const out = allocations.map((a) => ({
    id: a.id,
    userId: a.userId,
    userName: a.user.name,
    analysisId: a.analysisId,
    analysisName: a.analysis.nome,
    companyName: a.analysis.company?.nomeFantasia || a.analysis.company?.razaoSocial || "Empresa",
    phase: a.phase,
    plannedHours: a.plannedHours,
    startDate: a.startDate.toISOString(),
    endDate: a.endDate.toISOString(),
    notes: a.notes,
  }));
  res.json({ items: out, total: out.length });
});

router.post("/allocations", async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = allocationCreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const analysis = await prisma.analysis.findFirst({
    where: { id: parsed.data.analysisId, userId: req.userId! },
    select: { id: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  const allocation = await prisma.allocation.create({
    data: {
      userId: parsed.data.userId,
      analysisId: parsed.data.analysisId,
      phase: parsed.data.phase,
      plannedHours: parsed.data.plannedHours,
      startDate: new Date(parsed.data.startDate),
      endDate: new Date(parsed.data.endDate),
      notes: parsed.data.notes,
    },
  });
  res.status(201).json(allocation);
});

router.delete("/allocations/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const allocation = await prisma.allocation.findFirst({
    where: { id, analysis: { userId: req.userId! } },
    select: { id: true },
  });
  if (!allocation) { res.status(404).json({ error: "Alocação não encontrada" }); return; }
  await prisma.allocation.delete({ where: { id } });
  res.status(204).end();
});

export default router;
