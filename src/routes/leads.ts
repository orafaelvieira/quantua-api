import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { requireAuth, requireQuantua, AuthRequest } from "../middleware/auth";
import { sendLeadNotificationEmail, sendLeadConfirmationEmail } from "../services/email";

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
    // Canais de entrada genéricos: form de contato e interesse em integração ERP
    "contact", "integration_interest",
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

  // Notifica o time + auto-resposta ao remetente. Best-effort: sendSafe engole
  // erros, então a resposta 201 nunca depende do sucesso do e-mail.
  await Promise.allSettled([
    sendLeadNotificationEmail({
      to: env.email.teamInbox,
      lead,
      inboxUrl: `${env.frontendUrl}/inbox`,
    }),
    lead.contactEmail
      ? sendLeadConfirmationEmail({
          to: lead.contactEmail,
          contactName: lead.contactName ?? undefined,
          targetCompany: lead.targetCompany,
        })
      : Promise.resolve(),
  ]);

  res.status(201).json({ id: lead.id });
});

// GET autenticado — lista interna.
router.get("/", requireAuth, requireQuantua, async (req: AuthRequest, res: Response): Promise<void> => {
  const status = req.query.status as string | undefined;
  const leads = await prisma.lead.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json(leads);
});

/**
 * GET /leads/:id — retorna o lead completo (todos os campos nominais BPO)
 * para o dialog de triagem no Inbox consumir. Sem isolamento por userId
 * porque Leads são pool global (todos os RTs podem triar).
 */
router.get("/:id", requireAuth, requireQuantua, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) { res.status(404).json({ error: "Lead não encontrado" }); return; }
  res.json(lead);
});

/**
 * Status aceitos no lifecycle de triagem. Documentado aqui (até v2.1 o campo
 * era free-form); endpoints novos validam contra esse set, endpoints antigos
 * permanecem permissivos por retrocompat.
 *
 *  new       — recém-criado pelo formulário público
 *  contacted — RT já fez contato inicial (não promoveu ainda)
 *  converted — promovido para Engagement (vide POST /engagements com leadId)
 *  lost      — descartado (não bate ICP, sumiu, etc.)
 */
const LEAD_STATUSES = ["new", "contacted", "converted", "lost"] as const;
type LeadStatus = (typeof LEAD_STATUSES)[number];

const updateSchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
});

router.put("/:id", requireAuth, requireQuantua, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const status = parsed.data.status;
  const updated = await prisma.lead.update({
    where: { id },
    data: { ...(status ? { status } : {}) },
  });
  res.json(updated);
});

export default router;
export { LEAD_STATUSES, type LeadStatus };
