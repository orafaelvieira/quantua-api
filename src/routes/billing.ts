import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

const invoiceCreateSchema = z.object({
  engagementId: z.string().uuid(),
  milestone: z.enum(["entry_50", "final_50", "other"]),
  amount: z.number().positive(),
  currency: z.string().default("BRL"),
  status: z.enum(["draft", "issued", "paid", "overdue", "cancelled"]).default("draft"),
  issuedAt: z.string().optional(),
  dueDate: z.string().optional(),
  paidAt: z.string().optional(),
  invoiceNumber: z.string().optional(),
  notes: z.string().optional(),
});

const invoiceUpdateSchema = invoiceCreateSchema.partial();

router.get("/invoices", async (req: AuthRequest, res: Response): Promise<void> => {
  const scopeIds = req.scopeUserIds!;
  const status = req.query.status as string | undefined;
  const engagementId = req.query.engagementId as string | undefined;

  const invoices = await prisma.invoice.findMany({
    where: {
      engagement: { userId: { in: scopeIds } },
      ...(status ? { status } : {}),
      ...(engagementId ? { engagementId } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      engagement: {
        select: {
          id: true,
          companyName: true,
          analysisId: true,
          analysis: { select: { id: true, ibrType: true } },
        },
      },
    },
    take: 200,
  });

  const out = invoices.map((i) => ({
    id: i.id,
    engagementId: i.engagementId,
    companyName: i.engagement.companyName,
    analysisId: i.engagement.analysisId,
    ibrType: i.engagement.analysis?.ibrType ?? null,
    milestone: i.milestone,
    amount: i.amount,
    currency: i.currency,
    status: i.status,
    issuedAt: i.issuedAt?.toISOString() ?? null,
    dueDate: i.dueDate?.toISOString() ?? null,
    paidAt: i.paidAt?.toISOString() ?? null,
    invoiceNumber: i.invoiceNumber,
    notes: i.notes,
    createdAt: i.createdAt.toISOString(),
  }));

  res.json({ items: out, total: out.length });
});

router.get("/kpis", async (req: AuthRequest, res: Response): Promise<void> => {
  const scopeIds = req.scopeUserIds!;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [paidMtd, paidPrevMonth, receivable30, allInvoices, signedIbrCount] = await Promise.all([
    prisma.invoice.aggregate({
      where: {
        engagement: { userId: { in: scopeIds } },
        status: "paid",
        paidAt: { gte: startOfMonth },
      },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.invoice.aggregate({
      where: {
        engagement: { userId: { in: scopeIds } },
        status: "paid",
        paidAt: { gte: startOfPrevMonth, lt: startOfMonth },
      },
      _sum: { amount: true },
    }),
    prisma.invoice.aggregate({
      where: {
        engagement: { userId: { in: scopeIds } },
        status: { in: ["issued", "overdue"] },
        dueDate: { lte: new Date(Date.now() + 30 * 24 * 3600 * 1000) },
      },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.invoice.aggregate({
      where: { engagement: { userId: { in: scopeIds } }, status: "paid" },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.analysis.count({
      where: { userId: { in: scopeIds }, kind: "ibr", reviewState: "signed" },
    }),
  ]);

  const mtdRevenue = paidMtd._sum.amount ?? 0;
  const prevMtdRevenue = paidPrevMonth._sum.amount ?? 0;
  const mtdDeltaPct = prevMtdRevenue > 0 ? ((mtdRevenue - prevMtdRevenue) / prevMtdRevenue) * 100 : null;

  const receivableAmount = receivable30._sum.amount ?? 0;
  const receivableCount = receivable30._count;

  const avgTicket = (allInvoices._count ?? 0) > 0 ? (allInvoices._sum.amount ?? 0) / allInvoices._count : 0;

  res.json({
    mtdRevenue,
    mtdDeltaPct,
    receivableAmount,
    receivableCount,
    avgTicket,
    signedIbrCount,
  });
});

router.get("/invoices/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }

  const invoice = await prisma.invoice.findFirst({
    where: { id, engagement: { userId: { in: req.scopeUserIds! } } },
    include: {
      engagement: {
        select: {
          id: true,
          companyName: true,
          requestedBy: true,
          requestedByType: true,
          state: true,
          analysisId: true,
          deadline: true,
          feeAmount: true,
          feeCurrency: true,
          analysis: { select: { id: true, ibrType: true, nome: true } },
        },
      },
    },
  });
  if (!invoice) { res.status(404).json({ error: "Invoice não encontrada" }); return; }

  res.json({
    id: invoice.id,
    engagementId: invoice.engagementId,
    engagement: {
      id: invoice.engagement.id,
      companyName: invoice.engagement.companyName,
      requestedBy: invoice.engagement.requestedBy,
      requestedByType: invoice.engagement.requestedByType,
      state: invoice.engagement.state,
      analysisId: invoice.engagement.analysisId,
      deadline: invoice.engagement.deadline?.toISOString() ?? null,
      feeAmount: invoice.engagement.feeAmount,
      feeCurrency: invoice.engagement.feeCurrency,
      analysis: invoice.engagement.analysis,
    },
    milestone: invoice.milestone,
    amount: invoice.amount,
    currency: invoice.currency,
    status: invoice.status,
    issuedAt: invoice.issuedAt?.toISOString() ?? null,
    dueDate: invoice.dueDate?.toISOString() ?? null,
    paidAt: invoice.paidAt?.toISOString() ?? null,
    invoiceNumber: invoice.invoiceNumber,
    notes: invoice.notes,
    createdAt: invoice.createdAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString(),
  });
});

router.post("/invoices", async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = invoiceCreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const eng = await prisma.engagement.findFirst({
    where: { id: parsed.data.engagementId, userId: { in: req.scopeUserIds! } },
    select: { id: true },
  });
  if (!eng) { res.status(404).json({ error: "Engagement não encontrado" }); return; }

  const invoice = await prisma.invoice.create({
    data: {
      engagementId: parsed.data.engagementId,
      milestone: parsed.data.milestone,
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      status: parsed.data.status,
      issuedAt: parsed.data.issuedAt ? new Date(parsed.data.issuedAt) : null,
      dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
      paidAt: parsed.data.paidAt ? new Date(parsed.data.paidAt) : null,
      invoiceNumber: parsed.data.invoiceNumber,
      notes: parsed.data.notes,
    },
  });
  res.status(201).json(invoice);
});

router.patch("/invoices/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const invoice = await prisma.invoice.findFirst({
    where: { id, engagement: { userId: { in: req.scopeUserIds! } } },
    select: { id: true },
  });
  if (!invoice) { res.status(404).json({ error: "Invoice não encontrada" }); return; }

  const parsed = invoiceUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const updated = await prisma.invoice.update({
    where: { id },
    data: {
      ...parsed.data,
      issuedAt: parsed.data.issuedAt ? new Date(parsed.data.issuedAt) : undefined,
      dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : undefined,
      paidAt: parsed.data.paidAt ? new Date(parsed.data.paidAt) : undefined,
    },
  });
  res.json(updated);
});

router.delete("/invoices/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const invoice = await prisma.invoice.findFirst({
    where: { id, engagement: { userId: { in: req.scopeUserIds! } } },
    select: { id: true },
  });
  if (!invoice) { res.status(404).json({ error: "Invoice não encontrada" }); return; }
  await prisma.invoice.delete({ where: { id } });
  res.status(204).end();
});

export default router;
