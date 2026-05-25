import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();

// Reason agora cobre dois eras:
// - Legado (até 2026-05-22): solicitação IBR lado credor
// - v2 (pivot B2B-3, 2026-05-22+): firmType da firma candidata a design partner.
// Mantém ambos no enum para retrocompat e para aceitar leads de canais antigos.
const leadSchema = z.object({
  targetCompany: z.string().min(2),
  reason: z.enum([
    // Legado credor
    "credit_approval", "judicial_recovery", "refinancing", "due_diligence", "monitoring",
    // Novo (pivot B2B-3): tipo de firma do parceiro candidato
    "contabilidade_consultiva", "bpo_financeiro", "cfoaas", "contabilidade_tradicional",
  ]),
  debtVolume: z.string().optional(),
  desiredDeadline: z.string().optional(),
  contactName: z.string().optional(),
  contactEmail: z.string().email(),
  notes: z.string().optional(),
  // Pivot B2B-3: campos nominais opcionais. Frontend (PR /solicitar-ibr) hoje
  // empacota tudo em notes markdown legível; em PR futuro vai migrar pra estes.
  contactRole: z.enum(["socio", "gerente_carteira", "analista", "outro"]).optional(),
  contactPhone: z.string().optional(),
  firmType: z.enum([
    "contabilidade_consultiva", "bpo_financeiro", "cfoaas", "contabilidade_tradicional",
  ]).optional(),
  portfolioSize: z.enum(["lt30", "30_80", "80_200", "gt200"]).optional(),
  portfolioMidMarketPct: z.enum(["lt30", "30_50", "gt50", "nao_sei"]).optional(),
  teamSize: z.enum(["lt5", "5_15", "15_50", "gt50"]).optional(),
  consultingPricingModel: z.enum([
    "incluido_fee_fiscal", "hora_baseado", "produto_separado", "nao_cobramos",
  ]).optional(),
  weeklyAvailability: z.boolean().optional(),
});

// POST público — landing page envia direto sem auth.
router.post("/", async (req: Request, res: Response): Promise<void> => {
  const parsed = leadSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const lead = await prisma.lead.create({
    data: {
      targetCompany: parsed.data.targetCompany,
      reason: parsed.data.reason,
      debtVolume: parsed.data.debtVolume,
      desiredDeadline: parsed.data.desiredDeadline ? new Date(parsed.data.desiredDeadline) : null,
      contactName: parsed.data.contactName,
      contactEmail: parsed.data.contactEmail,
      notes: parsed.data.notes,
      contactRole: parsed.data.contactRole,
      contactPhone: parsed.data.contactPhone,
      firmType: parsed.data.firmType,
      portfolioSize: parsed.data.portfolioSize,
      portfolioMidMarketPct: parsed.data.portfolioMidMarketPct,
      teamSize: parsed.data.teamSize,
      consultingPricingModel: parsed.data.consultingPricingModel,
      weeklyAvailability: parsed.data.weeklyAvailability,
      status: "new",
    },
  });
  res.status(201).json({ id: lead.id });
});

// GET autenticado — lista interna.
router.get("/", requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const status = req.query.status as string | undefined;
  const leads = await prisma.lead.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json(leads);
});

router.put("/:id", requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const status = (req.body?.status as string) || undefined;
  const updated = await prisma.lead.update({
    where: { id },
    data: { ...(status ? { status } : {}) },
  });
  res.json(updated);
});

export default router;
