import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

const eventSchema = z.object({
  analysisId: z.string().uuid(),
  entity: z.enum(["bp", "dre", "indicador", "stcf", "scenario", "option", "engagement", "summary"]),
  entityId: z.string().optional(),
  field: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  source: z.enum(["manual", "extracted", "formula", "import"]).default("manual"),
  reason: z.string().optional(),
});

router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const scopeIds = req.scopeUserIds!;
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(200, Math.max(10, parseInt(String(req.query.pageSize ?? "50"), 10) || 50));
  const skip = (page - 1) * pageSize;

  const filterUserId = req.query.userId as string | undefined;
  const filterEntity = req.query.entity as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  const where = {
    OR: [
      { analysis: { userId: { in: scopeIds } } },
      { analysisId: null, userId: { in: scopeIds } },
    ],
    ...(filterUserId ? { userId: filterUserId } : {}),
    ...(filterEntity ? { entity: filterEntity } : {}),
    ...(from || to
      ? {
          timestamp: {
            ...(from ? { gte: new Date(from) } : {}),
            ...(to ? { lte: new Date(to) } : {}),
          },
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.auditEvent.findMany({
      where,
      orderBy: { timestamp: "desc" },
      skip,
      take: pageSize,
      include: {
        analysis: {
          select: {
            id: true,
            nome: true,
            company: { select: { razaoSocial: true, nomeFantasia: true } },
          },
        },
      },
    }),
    prisma.auditEvent.count({ where }),
  ]);

  // Eventos de EMPRESA (analysisId null): resolve o NOME pela entityId — sem isso a
  // coluna Entidade mostrava "—" + UUID (flagrado pelo usuário). Empresa já excluída
  // não resolve pelo banco → cai no snapshot gravado em `before`.
  const companyIds = [...new Set(
    items.filter((e) => !e.analysisId && e.entity === "company" && e.entityId).map((e) => e.entityId as string)
  )];
  const companiesById = new Map<string, string>(
    companyIds.length
      ? (await prisma.company.findMany({
          where: { id: { in: companyIds } },
          select: { id: true, razaoSocial: true, nomeFantasia: true },
        })).map((c) => [c.id, c.nomeFantasia || c.razaoSocial])
      : []
  );

  const out = items.map((e) => ({
    id: e.id,
    timestamp: e.timestamp.toISOString(),
    userId: e.userId,
    userName: e.userName,
    entity: e.entity,
    entityId: e.entityId,
    field: e.field,
    before: e.before,
    after: e.after,
    source: e.source,
    reason: e.reason,
    analysisId: e.analysisId,
    analysisName: e.analysis?.nome ?? null,
    companyName: e.analysis?.company
      ? e.analysis.company.nomeFantasia || e.analysis.company.razaoSocial
      : e.entity === "company"
        ? companiesById.get(e.entityId ?? "")
          ?? ((e.before as { nomeFantasia?: string | null; razaoSocial?: string | null } | null)?.nomeFantasia
            || (e.before as { razaoSocial?: string | null } | null)?.razaoSocial
            || null)
        : null,
  }));

  res.json({ items: out, total, page, pageSize });
});

/**
 * Export do audit trail filtrado em CSV. Streamming linha a linha (sem buffer total).
 * Limita a 10k registros para evitar OOM em workspaces grandes.
 */
router.get("/export", async (req: AuthRequest, res: Response): Promise<void> => {
  const scopeIds = req.scopeUserIds!;
  const format = (req.query.format as string | undefined) ?? "csv";

  if (format !== "csv") {
    res.status(400).json({ error: "Apenas format=csv é suportado no momento" });
    return;
  }

  const filterUserId = req.query.userId as string | undefined;
  const filterEntity = req.query.entity as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  const where = {
    OR: [
      { analysis: { userId: { in: scopeIds } } },
      { analysisId: null, userId: { in: scopeIds } },
    ],
    ...(filterUserId ? { userId: filterUserId } : {}),
    ...(filterEntity ? { entity: filterEntity } : {}),
    ...(from || to
      ? {
          timestamp: {
            ...(from ? { gte: new Date(from) } : {}),
            ...(to ? { lte: new Date(to) } : {}),
          },
        }
      : {}),
  };

  const events = await prisma.auditEvent.findMany({
    where,
    orderBy: { timestamp: "desc" },
    take: 10_000,
    include: {
      analysis: {
        select: {
          id: true,
          nome: true,
          company: { select: { razaoSocial: true, nomeFantasia: true } },
        },
      },
    },
  });

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="audit-${date}.csv"`);

  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (s.includes('"') || s.includes(",") || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  res.write("timestamp,user_id,user_name,entity,entity_id,field,source,reason,analysis_id,analysis_name,company,before,after\n");
  for (const e of events) {
    const company = e.analysis?.company?.nomeFantasia || e.analysis?.company?.razaoSocial || "";
    res.write(
      [
        e.timestamp.toISOString(),
        e.userId,
        escape(e.userName),
        e.entity,
        e.entityId ?? "",
        escape(e.field),
        e.source,
        escape(e.reason ?? ""),
        e.analysisId ?? "",
        escape(e.analysis?.nome ?? ""),
        escape(company),
        escape(e.before),
        escape(e.after),
      ].join(",") + "\n",
    );
  }
  res.end();
});

router.post("/events", async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = eventSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const analysis = await prisma.analysis.findFirst({
    where: { id: parsed.data.analysisId, userId: { in: req.scopeUserIds! } },
    select: { id: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  const event = await prisma.auditEvent.create({
    data: {
      analysisId: analysis.id,
      userId: req.userId!,
      userName: user?.name ?? "Usuário",
      entity: parsed.data.entity,
      entityId: parsed.data.entityId,
      field: parsed.data.field,
      before: parsed.data.before as object,
      after: parsed.data.after as object,
      source: parsed.data.source,
      reason: parsed.data.reason,
    },
  });
  res.status(201).json(event);
});

export default router;
