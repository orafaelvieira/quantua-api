import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { computeProjections } from "../services/projection-engine";
import { resolveSectorPremises } from "../services/sector-benchmark";

const router = Router({ mergeParams: true });
router.use(requireAuth);

async function loadAnalysis(req: AuthRequest) {
  const id = req.params.id;
  if (!id || typeof id !== "string") return null;
  return prisma.analysis.findFirst({
    where: { id, userId: { in: req.scopeUserIds! } },
  });
}

/* ─────────────  STCF  ───────────── */

router.get("/:id/stcf", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const scenarioId = (req.query.scenarioId as string) || "base";
  const stcf = (analysis.stcf as Record<string, unknown> | null) ?? null;
  if (stcf && (stcf as { scenarioId?: string }).scenarioId === scenarioId) {
    res.json(stcf);
    return;
  }
  res.status(404).json({ error: "Forecast não encontrado para o cenário" });
});

router.put("/:id/stcf", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const updated = await prisma.analysis.update({
    where: { id: analysis.id },
    data: { stcf: req.body },
  });
  res.json(updated.stcf);
});

/* ─────────────  Cenários  ───────────── */

router.get("/:id/scenarios", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  res.json(analysis.scenarios ?? []);
});

router.put("/:id/scenarios", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const updated = await prisma.analysis.update({
    where: { id: analysis.id },
    data: { scenarios: req.body },
  });
  res.json(updated.scenarios);
});

/* ─────────────  Opções estratégicas  ───────────── */

const optionSchema = z.object({
  pillar: z.enum(["strategic_repositioning", "value_focused_business_model", "operational_excellence", "financial_restructuring"]),
  title: z.string().min(2),
  description: z.string().default(""),
  estimatedImpactBRL: z.number().optional(),
  horizonMonths: z.number().optional(),
  effort: z.enum(["low", "medium", "high"]).default("medium"),
  owner: z.string().optional(),
  priority: z.enum(["p0", "p1", "p2"]).default("p1"),
});

// SWOT editável pelo analista (sobrescreve resultado.swot — a IA sugere, o analista refina).
const swotSchema = z.object({
  forcas: z.array(z.string()),
  fraquezas: z.array(z.string()),
  oportunidades: z.array(z.string()),
  riscos: z.array(z.string()),
});
router.put("/:id/swot", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const parsed = swotSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const clean = {
    forcas: parsed.data.forcas.map((s) => s.trim()).filter(Boolean),
    fraquezas: parsed.data.fraquezas.map((s) => s.trim()).filter(Boolean),
    oportunidades: parsed.data.oportunidades.map((s) => s.trim()).filter(Boolean),
    riscos: parsed.data.riscos.map((s) => s.trim()).filter(Boolean),
  };
  const resultado = (analysis.resultado as Record<string, unknown> | null) ?? {};
  await prisma.analysis.update({ where: { id: analysis.id }, data: { resultado: { ...resultado, swot: clean } as object } });
  res.json(clean);
});

router.get("/:id/options", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  res.json(analysis.options ?? []);
});

router.post("/:id/options", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const parsed = optionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const current = (analysis.options as unknown[] | null) ?? [];
  const created = { id: crypto.randomUUID(), ...parsed.data };
  const updated = await prisma.analysis.update({
    where: { id: analysis.id },
    data: { options: [...current, created] as unknown as object },
  });
  res.status(201).json(created);
});

// Editar uma opção estratégica (analista ajusta o que a IA semeou ou o que ele criou).
router.put("/:id/options/:optionId", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const parsed = optionSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const current = (analysis.options as Array<{ id: string }> | null) ?? [];
  const idx = current.findIndex((o) => o.id === req.params.optionId);
  if (idx === -1) { res.status(404).json({ error: "Opção não encontrada" }); return; }
  const atualizado = { ...current[idx], ...parsed.data };
  const novas = [...current]; novas[idx] = atualizado;
  await prisma.analysis.update({ where: { id: analysis.id }, data: { options: novas as unknown as object } });
  res.json(atualizado);
});

// Excluir uma opção estratégica.
router.delete("/:id/options/:optionId", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const current = (analysis.options as Array<{ id: string }> | null) ?? [];
  const novas = current.filter((o) => o.id !== req.params.optionId);
  await prisma.analysis.update({ where: { id: analysis.id }, data: { options: novas as unknown as object } });
  res.status(204).send();
});

/* ─────────────  Projeções (12 meses, computadas pelo engine)  ───────────── */

router.get("/:id/projections", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const analysis = await prisma.analysis.findFirst({
    where: { id, userId: { in: req.scopeUserIds! } },
    include: { company: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  const scenarioKind = (req.query.scenarioId as string) || "base";
  const scenarios = (analysis.scenarios as Array<{ kind: string; assumptions: any }> | null) ?? [];
  const scenario = scenarios.find((s) => s.kind === scenarioKind) || scenarios[0];
  if (!scenario) {
    res.status(400).json({ error: "Nenhum cenário disponível para projetar. Configure cenários antes." });
    return;
  }

  try {
    const premises = await resolveSectorPremises({
      sectorCode: analysis.sectorId,
      // "Outros" do picker grava sectorCustom (texto livre) — tem prioridade
      // sobre o setor cadastrado da empresa no fallback textual.
      setorText: analysis.sectorCustom ?? analysis.company?.setor ?? null,
    });
    const projections = computeProjections({
      dadosEstruturados: analysis.dadosEstruturados,
      stcf: analysis.stcf,
      scenario,
      premises,
      startMonth: new Date(),
    });
    // Cache no campo projections (sob a chave do cenário)
    const cached = ((analysis as any).projections as Record<string, unknown> | null) ?? {};
    await prisma.analysis.update({
      where: { id: analysis.id },
      data: { projections: { ...cached, [scenarioKind]: projections } } as any,
    });
    res.json({ scenarioKind, scenarioName: scenario.kind, months: projections });
  } catch (err) {
    console.error("Projection engine error:", err);
    res.status(500).json({ error: "Falha ao computar projeções", detail: err instanceof Error ? err.message : String(err) });
  }
});

/* ─────────────  Sumário Executivo  ───────────── */

const summarySchema = z.object({
  recommendationToLender: z.enum(["continue_support", "restructure", "accelerated_ma", "wind_down", "undecided"]),
  rationale: z.string().default(""),
  keyRisks: z.array(z.string()).default([]),
  keyMitigations: z.array(z.string()).default([]),
  liquidityRunwayWeeks: z.number().optional(),
  covenantHeadroom: z.number().optional(),
});

router.get("/:id/executive-summary", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  res.json(analysis.executiveSummary ?? null);
});

router.put("/:id/executive-summary", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const parsed = summarySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const updated = await prisma.analysis.update({
    where: { id: analysis.id },
    data: { executiveSummary: parsed.data },
  });
  res.json(updated.executiveSummary);
});

/* ─────────────  Engagement embed (legado, no Analysis)  ───────────── */

router.get("/:id/engagement", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const eng = await prisma.engagement.findFirst({
    where: { analysisId: id, userId: { in: req.scopeUserIds! } },
  });
  res.json(eng);
});

/* ─────────────  Workflow de revisão  ───────────── */

const VALID_TRANSITIONS: Record<string, { to: string; requirePerm?: string }[]> = {
  draft: [{ to: "in_review", requirePerm: "ibr.edit" }],
  in_review: [
    { to: "approved", requirePerm: "ibr.review" },
    { to: "revision_requested", requirePerm: "ibr.review" },
  ],
  revision_requested: [{ to: "in_review", requirePerm: "ibr.edit" }],
  approved: [{ to: "signed", requirePerm: "ibr.sign" }, { to: "draft", requirePerm: "ibr.sign" }],
  signed: [{ to: "delivered", requirePerm: "ibr.sign" }, { to: "draft", requirePerm: "ibr.sign" }],
  delivered: [],
};

const TRANSITION_TO_STATE: Record<string, { from: string[]; to: string }> = {
  submit_for_review: { from: ["draft"], to: "in_review" },
  request_revision: { from: ["in_review"], to: "revision_requested" },
  resubmit: { from: ["revision_requested"], to: "in_review" },
  approve: { from: ["in_review"], to: "approved" },
  sign: { from: ["approved"], to: "signed" },
  deliver: { from: ["signed"], to: "delivered" },
  reopen: { from: ["approved", "signed", "delivered"], to: "draft" },
};

router.get("/:id/review", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const meta = (analysis.reviewMeta as Record<string, unknown> | null) ?? {};
  res.json({
    state: analysis.reviewState,
    transitions: (meta.transitions as unknown[]) ?? [],
    comments: (meta.comments as unknown[]) ?? [],
    signature: analysis.signature ?? undefined,
  });
});

router.post("/:id/review/transition", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const action = (req.body?.action as string) || "";
  const t = TRANSITION_TO_STATE[action];
  if (!t) { res.status(400).json({ error: "Transição inválida" }); return; }
  if (!t.from.includes(analysis.reviewState)) {
    res.status(409).json({ error: `Transição '${action}' não permitida do estado '${analysis.reviewState}'` });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  const meta = (analysis.reviewMeta as Record<string, unknown> | null) ?? {};
  const transitions = ((meta.transitions as unknown[]) ?? []).slice() as Record<string, unknown>[];
  transitions.push({
    id: crypto.randomUUID(),
    analysisId: analysis.id,
    fromState: analysis.reviewState,
    toState: t.to,
    by: user?.name ?? req.userId,
    byRole: user?.role ?? "operator",
    timestamp: new Date().toISOString(),
    reason: req.body?.reason,
  });
  const updated = await prisma.analysis.update({
    where: { id: analysis.id },
    data: {
      reviewState: t.to,
      reviewMeta: { ...meta, transitions } as object,
    },
  });
  const newMeta = (updated.reviewMeta as Record<string, unknown> | null) ?? {};
  res.json({
    state: updated.reviewState,
    transitions: (newMeta.transitions as unknown[]) ?? [],
    comments: (newMeta.comments as unknown[]) ?? [],
    signature: updated.signature ?? undefined,
  });
});

router.post("/:id/review/comments", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const body = (req.body?.body as string) || "";
  if (!body.trim()) { res.status(400).json({ error: "Comentário vazio" }); return; }
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  const meta = (analysis.reviewMeta as Record<string, unknown> | null) ?? {};
  const comments = ((meta.comments as unknown[]) ?? []).slice() as Record<string, unknown>[];
  comments.push({
    id: crypto.randomUUID(),
    analysisId: analysis.id,
    authorId: req.userId,
    authorName: user?.name ?? "Usuário",
    authorRole: user?.role ?? "operator",
    timestamp: new Date().toISOString(),
    body: body.trim(),
    anchor: req.body?.anchor,
  });
  const updated = await prisma.analysis.update({
    where: { id: analysis.id },
    data: { reviewMeta: { ...meta, comments } as object },
  });
  const newMeta = (updated.reviewMeta as Record<string, unknown> | null) ?? {};
  res.json({
    state: updated.reviewState,
    transitions: (newMeta.transitions as unknown[]) ?? [],
    comments: (newMeta.comments as unknown[]) ?? [],
    signature: updated.signature ?? undefined,
  });
});

/* ─────────────  Assinatura RT  ───────────── */

router.post("/:id/sign", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (user?.role !== "partner") {
    res.status(403).json({ error: "Apenas Partner (RT) pode assinar" });
    return;
  }
  if (analysis.reviewState !== "approved") {
    res.status(409).json({ error: "IBR precisa estar 'approved' para ser assinado" });
    return;
  }
  const registration = (req.body?.professionalRegistration as string) || "";
  if (!registration.trim()) {
    res.status(400).json({ error: "Registro profissional obrigatório" });
    return;
  }

  // Hash do conteúdo: estabilizamos o snapshot dos campos analíticos.
  const snapshot = JSON.stringify({
    dadosEstruturados: analysis.dadosEstruturados,
    stcf: analysis.stcf,
    scenarios: analysis.scenarios,
    options: analysis.options,
    executiveSummary: analysis.executiveSummary,
    documentChecklist: analysis.documentChecklist,
  });
  const contentHash = crypto.createHash("sha256").update(snapshot).digest("hex");

  const signature = {
    id: crypto.randomUUID(),
    analysisId: analysis.id,
    partnerId: user.id,
    partnerName: user.name,
    professionalRegistration: registration.trim(),
    contentHashSha256: contentHash,
    signedAt: new Date().toISOString(),
  };

  const meta = (analysis.reviewMeta as Record<string, unknown> | null) ?? {};
  const transitions = ((meta.transitions as unknown[]) ?? []).slice() as Record<string, unknown>[];
  transitions.push({
    id: crypto.randomUUID(),
    analysisId: analysis.id,
    fromState: "approved",
    toState: "signed",
    by: user.name,
    byRole: "partner",
    timestamp: new Date().toISOString(),
  });

  await prisma.analysis.update({
    where: { id: analysis.id },
    data: {
      signature,
      reviewState: "signed",
      reviewMeta: { ...meta, transitions } as object,
    },
  });

  res.status(201).json(signature);
});

/* ─────────────  Audit trail (lista por análise)  ───────────── */

router.get("/:id/audit", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const limit = Math.min(parseInt(String(req.query.limit ?? "200")) || 200, 500);
  const offset = parseInt(String(req.query.offset ?? "0")) || 0;
  const entity = req.query.entity as string | undefined;
  const events = await prisma.auditEvent.findMany({
    where: { analysisId: analysis.id, ...(entity ? { entity } : {}) },
    orderBy: { timestamp: "desc" },
    take: limit,
    skip: offset,
  });
  res.json(events);
});

/* ─────────────  Time tracking  ───────────── */

const timeEntrySchema = z.object({
  phase: z.enum(["engagement", "collection", "analysis", "review", "delivery"]),
  hours: z.number().positive(),
  date: z.string(),
  notes: z.string().optional(),
});

router.post("/:id/time", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const parsed = timeEntrySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const entry = await prisma.timeEntry.create({
    data: {
      analysisId: analysis.id,
      userId: req.userId!,
      phase: parsed.data.phase,
      hours: parsed.data.hours,
      date: new Date(parsed.data.date),
      notes: parsed.data.notes,
    },
  });
  res.status(201).json(entry);
});

router.get("/:id/time/summary", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const entries = await prisma.timeEntry.findMany({
    where: { analysisId: analysis.id },
    include: { user: { select: { name: true } } },
  });

  const hoursByPhase: Record<string, number> = {
    engagement: 0,
    collection: 0,
    analysis: 0,
    review: 0,
    delivery: 0,
  };
  const userMap = new Map<string, { userId: string; userName: string; hours: number }>();
  let totalHours = 0;
  for (const e of entries) {
    hoursByPhase[e.phase] = (hoursByPhase[e.phase] ?? 0) + e.hours;
    totalHours += e.hours;
    const existing = userMap.get(e.userId);
    if (existing) existing.hours += e.hours;
    else userMap.set(e.userId, { userId: e.userId, userName: e.user.name, hours: e.hours });
  }

  // Margem se houver engagement com fee
  const engagement = await prisma.engagement.findFirst({
    where: { analysisId: analysis.id },
  });
  const HOURLY_COST = 350; // BRL — assumption interna; backend pode tornar configurável
  const estimatedCost = totalHours * HOURLY_COST;
  const feeAmount = engagement?.feeAmount ?? undefined;
  const marginAmount = feeAmount != null ? feeAmount - estimatedCost : undefined;
  const marginPct = feeAmount && feeAmount > 0 ? (marginAmount! / feeAmount) : undefined;

  res.json({
    analysisId: analysis.id,
    totalHours,
    hoursByPhase,
    hoursByUser: Array.from(userMap.values()),
    estimatedCost,
    feeAmount,
    marginAmount,
    marginPct,
  });
});

/* ─────────────  Covenants  ───────────── */

const covenantSchema = z.object({
  name: z.string().min(2),
  metric: z.string().min(2),
  operator: z.enum(["<=", ">=", "<", ">", "=="]),
  threshold: z.number(),
  periodicity: z.enum(["monthly", "quarterly", "annual"]).default("quarterly"),
  notes: z.string().optional(),
});

router.get("/:id/covenants", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const covenants = await prisma.covenant.findMany({
    where: { analysisId: analysis.id },
    orderBy: { createdAt: "asc" },
  });
  res.json({ items: covenants });
});

router.post("/:id/covenants", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const parsed = covenantSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const covenant = await prisma.covenant.create({
    data: { analysisId: analysis.id, ...parsed.data },
  });
  res.status(201).json(covenant);
});

router.put("/:id/covenants/:covenantId", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const covenantId = req.params.covenantId;
  if (!covenantId || typeof covenantId !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const existing = await prisma.covenant.findFirst({
    where: { id: covenantId, analysisId: analysis.id },
    select: { id: true },
  });
  if (!existing) { res.status(404).json({ error: "Covenant não encontrado" }); return; }
  const parsed = covenantSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const updated = await prisma.covenant.update({
    where: { id: covenantId },
    data: parsed.data,
  });
  res.json(updated);
});

router.delete("/:id/covenants/:covenantId", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadAnalysis(req);
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const covenantId = req.params.covenantId;
  if (!covenantId || typeof covenantId !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const existing = await prisma.covenant.findFirst({
    where: { id: covenantId, analysisId: analysis.id },
    select: { id: true },
  });
  if (!existing) { res.status(404).json({ error: "Covenant não encontrado" }); return; }
  await prisma.covenant.delete({ where: { id: covenantId } });
  res.status(204).end();
});

export default router;
