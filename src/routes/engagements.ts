import { Router, Response } from "express";
import crypto from "crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { requireRole } from "../middleware/permissions";
import { inviteLimiter } from "../middleware/rate-limit";
import { renderLetter } from "../services/letter-templates";
import { sendInviteEmail, sendEngagementSignedEmail } from "../services/email";
import { env } from "../config/env";

const router = Router();
router.use(requireAuth);

const engagementCreateSchema = z.object({
  companyName: z.string().min(2),
  requestedBy: z.string().min(2),
  requestedByType: z.enum(["lender", "investor", "advisor", "other"]).default("lender"),
  scope: z.string().default(""),
  state: z.enum(["lead", "proposal_sent", "won", "kicked_off", "completed", "lost"]).default("lead"),
  deadline: z.string().optional(),
  feeAmount: z.number().optional(),
  feeCurrency: z.string().default("BRL"),
  rtId: z.string().uuid().optional(),
  notes: z.string().optional(),
});

const engagementUpdateSchema = engagementCreateSchema.partial();

const inviteClientSchema = z.object({
  email: z.string().email(),
  contactName: z.string().optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

const signLetterSchema = z.object({
  acceptedContentHash: z.string().min(8),
  signerCpf: z.string().optional(),
});

const VALID_TRANSITIONS: Record<string, string[]> = {
  lead: ["proposal_sent", "lost"],
  proposal_sent: ["won", "lost"],
  won: ["kicked_off", "lost"],
  kicked_off: ["completed"],
  completed: [],
  lost: [],
};

function hashInvitationToken(rawToken: string): string {
  return crypto
    .createHash("sha256")
    .update(rawToken + env.invitationSecret)
    .digest("hex");
}

router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const items = await prisma.engagement.findMany({
    where: { userId: req.userId! },
    orderBy: { createdAt: "desc" },
    include: { rt: { select: { id: true, name: true } } },
  });
  const out = items.map((e) => ({
    ...e,
    rtName: e.rt?.name ?? null,
    deadline: e.deadline?.toISOString(),
    signedAt: e.signedAt?.toISOString(),
    letterAcceptedAt: e.letterAcceptedAt?.toISOString() ?? null,
  }));
  res.json(out);
});

router.get("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const eng = await prisma.engagement.findFirst({
    where: { id, userId: req.userId! },
    include: {
      rt: { select: { id: true, name: true } },
      invitations: { orderBy: { createdAt: "desc" }, take: 5 },
      signatures: { orderBy: { signedAt: "desc" } },
    },
  });
  if (!eng) { res.status(404).json({ error: "Engagement não encontrado" }); return; }
  res.json({
    ...eng,
    rtName: eng.rt?.name ?? null,
    deadline: eng.deadline?.toISOString(),
    signedAt: eng.signedAt?.toISOString(),
    letterAcceptedAt: eng.letterAcceptedAt?.toISOString() ?? null,
  });
});

router.post("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = engagementCreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const created = await prisma.engagement.create({
    data: {
      userId: req.userId!,
      companyName: parsed.data.companyName,
      requestedBy: parsed.data.requestedBy,
      requestedByType: parsed.data.requestedByType,
      scope: parsed.data.scope,
      state: parsed.data.state,
      deadline: parsed.data.deadline ? new Date(parsed.data.deadline) : null,
      feeAmount: parsed.data.feeAmount,
      feeCurrency: parsed.data.feeCurrency,
      rtId: parsed.data.rtId,
      notes: parsed.data.notes,
    },
    include: { rt: { select: { id: true, name: true } } },
  });
  res.status(201).json({
    ...created,
    rtName: created.rt?.name ?? null,
    deadline: created.deadline?.toISOString(),
    signedAt: created.signedAt?.toISOString(),
  });
});

router.put("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const eng = await prisma.engagement.findFirst({ where: { id, userId: req.userId! } });
  if (!eng) { res.status(404).json({ error: "Engagement não encontrado" }); return; }
  const parsed = engagementUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const updated = await prisma.engagement.update({
    where: { id },
    data: {
      ...parsed.data,
      deadline: parsed.data.deadline ? new Date(parsed.data.deadline) : undefined,
    },
  });
  res.json(updated);
});

router.post("/:id/transition", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const eng = await prisma.engagement.findFirst({ where: { id, userId: req.userId! } });
  if (!eng) { res.status(404).json({ error: "Engagement não encontrado" }); return; }
  const toState = (req.body?.toState as string) || "";
  const allowed = VALID_TRANSITIONS[eng.state] ?? [];
  if (!allowed.includes(toState)) {
    res.status(409).json({ error: `Transição inválida ${eng.state} → ${toState}` });
    return;
  }

  // Se for 'won' e não houver IBR vinculado, cria automaticamente.
  let analysisId = eng.analysisId;
  if (toState === "won" && !analysisId) {
    const existingCompany = await prisma.company.findFirst({
      where: { userId: req.userId!, razaoSocial: eng.companyName },
    });
    const company =
      existingCompany ??
      (await prisma.company.create({
        data: {
          userId: req.userId!,
          razaoSocial: eng.companyName,
          status: "ativo",
        },
      }));
    const created = await prisma.analysis.create({
      data: {
        companyId: company.id,
        userId: req.userId!,
        nome: `IBR — ${eng.companyName}`,
        kind: "ibr",
        status: "Rascunho",
      },
    });
    analysisId = created.id;
  }

  const updated = await prisma.engagement.update({
    where: { id },
    data: {
      state: toState,
      ...(analysisId !== eng.analysisId ? { analysisId } : {}),
    },
    include: { rt: { select: { name: true } } },
  });
  res.json({
    ...updated,
    rtName: updated.rt?.name ?? null,
    deadline: updated.deadline?.toISOString(),
    signedAt: updated.signedAt?.toISOString(),
  });
});

/**
 * Renderiza a letter atual do engagement com hash de conteúdo.
 * Acessível por staff (dono do engagement) e por client (via Company.userId).
 */
router.get("/:id/letter", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }

  // Tenta como staff primeiro
  let eng = await prisma.engagement.findFirst({
    where: { id, userId: req.userId! },
    include: { rt: { select: { name: true, professionalRegistration: true } } },
  });

  // Se não encontrou, tenta como cliente (via company.userId → analysis → engagement)
  if (!eng) {
    const company = await prisma.company.findFirst({
      where: { userId: req.userId },
      include: { analyses: { where: { kind: "ibr" }, include: { engagement: true } } },
    });
    const candidate = company?.analyses.find((a) => a.engagement?.id === id);
    if (candidate?.engagement) {
      eng = await prisma.engagement.findUnique({
        where: { id },
        include: { rt: { select: { name: true, professionalRegistration: true } } },
      });
    }
  }

  if (!eng) { res.status(404).json({ error: "Engagement não encontrado" }); return; }

  const letter = renderLetter({
    engagementId: eng.id,
    companyName: eng.companyName,
    requestedBy: eng.requestedBy,
    requestedByType: eng.requestedByType,
    scope: eng.scope,
    feeAmount: eng.feeAmount,
    feeCurrency: eng.feeCurrency,
    deadline: eng.deadline,
    rtName: eng.rt?.name ?? null,
    rtRegistration: eng.rt?.professionalRegistration ?? null,
  });

  res.json({
    engagement: {
      id: eng.id,
      companyName: eng.companyName,
      state: eng.state,
      letterAcceptedAt: eng.letterAcceptedAt?.toISOString() ?? null,
    },
    letter: {
      version: letter.version,
      contentHash: letter.contentHash,
      sections: letter.sections,
      meta: letter.meta,
      text: letter.text,
    },
  });
});

/**
 * Staff convida cliente. Idempotente por (engagementId, status="pending"):
 * se já existe, gera novo tokenHash (rotation) e re-envia.
 */
router.post(
  "/:id/invite-client",
  requireRole("partner", "operator"),
  inviteLimiter,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const id = req.params.id;
    if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
    const parsed = inviteClientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const { email, contactName, expiresInDays } = parsed.data;

    const eng = await prisma.engagement.findFirst({
      where: { id, userId: req.userId! },
      include: { rt: { select: { name: true } } },
    });
    if (!eng) { res.status(404).json({ error: "Engagement não encontrado" }); return; }
    if (eng.state !== "won" && eng.state !== "kicked_off") {
      res.status(409).json({ error: "Engagement deve estar em 'won' ou 'kicked_off' para convidar cliente" });
      return;
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashInvitationToken(rawToken);
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    const existing = await prisma.clientInvitation.findFirst({
      where: { engagementId: id, status: "pending", email },
    });

    let invitation;
    if (existing) {
      invitation = await prisma.clientInvitation.update({
        where: { id: existing.id },
        data: {
          tokenHash,
          expiresAt,
          lastSentAt: new Date(),
          resendCount: { increment: 1 },
        },
      });
    } else {
      invitation = await prisma.clientInvitation.create({
        data: {
          engagementId: id,
          email,
          tokenHash,
          expiresAt,
          createdById: req.userId!,
        },
      });
    }

    const magicLink = `${env.frontendUrl}/convite/${rawToken}`;
    const emailResult = await sendInviteEmail({
      to: email,
      contactName,
      companyName: eng.companyName,
      rtName: eng.rt?.name ?? "Quantua",
      magicLink,
      expiresAt,
    });

    if (eng.analysisId) {
      await prisma.auditEvent.create({
        data: {
          analysisId: eng.analysisId,
          userId: req.userId!,
          userName: req.userId!,
          entity: "invitation",
          entityId: invitation.id,
          field: "sent",
          before: Prisma.JsonNull,
          after: { email, expiresAt: expiresAt.toISOString(), resendCount: invitation.resendCount },
          source: "manual",
        },
      });
    }

    res.status(201).json({
      invitationId: invitation.id,
      expiresAt: invitation.expiresAt.toISOString(),
      resendCount: invitation.resendCount,
      emailDelivered: emailResult.ok,
      emailError: emailResult.error,
    });
  }
);

/**
 * Cliente assina engagement letter (TOCTOU-safe via contentHash).
 * Cria EngagementSignature, atualiza letterAcceptedAt, dispara email para RT.
 */
router.post(
  "/:id/sign-letter",
  requireRole("client"),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const id = req.params.id;
    if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
    const parsed = signLetterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    // Cliente acessa engagement via Company.userId
    const company = await prisma.company.findFirst({
      where: { userId: req.userId! },
      include: {
        analyses: { where: { kind: "ibr" }, include: { engagement: { include: { rt: true } } } },
      },
    });
    const candidate = company?.analyses.find((a) => a.engagement?.id === id);
    const eng = candidate?.engagement;
    if (!eng) { res.status(404).json({ error: "Engagement não encontrado" }); return; }
    if (eng.letterAcceptedAt) {
      res.status(409).json({ error: "Carta já foi assinada", signedAt: eng.letterAcceptedAt.toISOString() });
      return;
    }

    const letter = renderLetter({
      engagementId: eng.id,
      companyName: eng.companyName,
      requestedBy: eng.requestedBy,
      requestedByType: eng.requestedByType,
      scope: eng.scope,
      feeAmount: eng.feeAmount,
      feeCurrency: eng.feeCurrency,
      deadline: eng.deadline,
      rtName: eng.rt?.name ?? null,
      rtRegistration: eng.rt?.professionalRegistration ?? null,
    });

    if (letter.contentHash !== parsed.data.acceptedContentHash) {
      res.status(409).json({
        error: "A carta foi atualizada. Recarregue para revisar a versão atual.",
        currentContentHash: letter.contentHash,
      });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId! } });
    if (!user) { res.status(401).json({ error: "Sessão inválida" }); return; }

    const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
    const userAgent = req.headers["user-agent"]?.slice(0, 500) || "unknown";

    await prisma.$transaction(async (tx) => {
      await tx.engagementSignature.create({
        data: {
          engagementId: eng.id,
          signerType: "client",
          signerUserId: user.id,
          signerName: user.name,
          signerEmail: user.email,
          signerCpf: parsed.data.signerCpf,
          contentHash: letter.contentHash,
          letterVersion: letter.version,
          ipAddress,
          userAgent,
        },
      });
      await tx.engagement.update({
        where: { id: eng.id },
        data: {
          letterAcceptedAt: new Date(),
          letterContentHash: letter.contentHash,
          letterVersion: letter.version,
        },
      });
      if (eng.analysisId) {
        await tx.auditEvent.create({
          data: {
            analysisId: eng.analysisId,
            userId: user.id,
            userName: user.name,
            entity: "engagement",
            entityId: eng.id,
            field: "letter_accepted",
            before: Prisma.JsonNull,
            after: { contentHash: letter.contentHash, version: letter.version },
            source: "client",
          },
        });
      }
    });

    if (eng.rt?.email) {
      await sendEngagementSignedEmail({
        to: eng.rt.email,
        rtName: eng.rt.name,
        clientName: user.name,
        companyName: eng.companyName,
        signedAt: new Date(),
        engagementUrl: `${env.frontendUrl}/engagements/${eng.id}`,
      });
    }

    res.status(201).json({
      signedAt: new Date().toISOString(),
      contentHash: letter.contentHash,
      letterVersion: letter.version,
    });
  }
);

export default router;
