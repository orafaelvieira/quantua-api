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
  /**
   * Promoção via dialog de triagem do Inbox. Quando preenchido, a criação
   * roda em transação: cria Engagement + atualiza Lead.status="converted".
   * Bloqueia se o Lead já está convertido (race condition em abas paralelas).
   */
  leadId: z.string().uuid().optional(),
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
  const data = parsed.data;

  // Caminho com leadId: promoção via dialog de triagem do Inbox. Transação
  // garante atomicidade entre criação do Engagement e mudança de Lead.status.
  if (data.leadId) {
    try {
      const created = await prisma.$transaction(async (tx) => {
        const lead = await tx.lead.findUnique({ where: { id: data.leadId! } });
        if (!lead) throw new Error("LEAD_NOT_FOUND");
        if (lead.status === "converted") throw new Error("LEAD_ALREADY_CONVERTED");
        const eng = await tx.engagement.create({
          data: {
            userId: req.userId!,
            companyName: data.companyName,
            requestedBy: data.requestedBy,
            requestedByType: data.requestedByType,
            scope: data.scope,
            state: data.state,
            deadline: data.deadline ? new Date(data.deadline) : null,
            feeAmount: data.feeAmount,
            feeCurrency: data.feeCurrency,
            rtId: data.rtId,
            notes: data.notes,
          },
          include: { rt: { select: { id: true, name: true } } },
        });
        await tx.lead.update({
          where: { id: data.leadId! },
          data: { status: "converted" },
        });
        return eng;
      });
      res.status(201).json({
        ...created,
        rtName: created.rt?.name ?? null,
        deadline: created.deadline?.toISOString(),
        signedAt: created.signedAt?.toISOString(),
        promotedFromLeadId: data.leadId,
      });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "LEAD_NOT_FOUND") {
        res.status(404).json({ error: "Lead não encontrado" });
        return;
      }
      if (message === "LEAD_ALREADY_CONVERTED") {
        res.status(409).json({ error: "Este lead já foi convertido em engagement" });
        return;
      }
      throw err;
    }
  }

  // Caminho padrão: criação direta sem promover lead.
  const created = await prisma.engagement.create({
    data: {
      userId: req.userId!,
      companyName: data.companyName,
      requestedBy: data.requestedBy,
      requestedByType: data.requestedByType,
      scope: data.scope,
      state: data.state,
      deadline: data.deadline ? new Date(data.deadline) : null,
      feeAmount: data.feeAmount,
      feeCurrency: data.feeCurrency,
      rtId: data.rtId,
      notes: data.notes,
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

/**
 * Gera proposta comercial baseada no engagement letter. Renderiza HTML
 * inline e expõe via GET /:id/proposal-html (cliente abre em nova aba e
 * imprime → PDF). Atualiza Engagement.proposalUrl.
 *
 * TODO: substituir por geração PDF real com pdfkit em iteração futura.
 */
router.post("/:id/generate-proposal", requireRole("partner", "operator"), async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const eng = await prisma.engagement.findFirst({
    where: { id, userId: req.userId! },
    include: { rt: { select: { name: true, professionalRegistration: true } } },
  });
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

  const proposalUrl = `${env.frontendUrl || ""}/api/engagements/${eng.id}/proposal-html`;

  await prisma.engagement.update({
    where: { id: eng.id },
    data: { proposalUrl },
  });

  const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { name: true } });
  if (eng.analysisId) {
    await prisma.auditEvent.create({
      data: {
        analysisId: eng.analysisId,
        userId: req.userId!,
        userName: user?.name ?? "Usuário",
        entity: "engagement",
        entityId: eng.id,
        field: "proposal_generated",
        after: { proposalUrl, version: letter.version, contentHash: letter.contentHash } as object,
        source: "manual",
      },
    });
  }

  res.json({ proposalUrl, version: letter.version, contentHash: letter.contentHash });
});

/**
 * Serve a proposta como HTML estilizado para impressão (Cmd+P → Save as PDF).
 * Endpoint público dentro do contexto do engagement (não exige client login).
 */
router.get("/:id/proposal-html", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).send("ID inválido"); return; }
  const eng = await prisma.engagement.findFirst({
    where: { id, userId: req.userId! },
    include: { rt: { select: { name: true, professionalRegistration: true } } },
  });
  if (!eng) { res.status(404).send("Engagement não encontrado"); return; }

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

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const sectionsHtml = letter.sections.map(
    (s) => `<section><h2>${escapeHtml(s.title)}</h2>${s.body.split("\n").map((p) => `<p>${escapeHtml(p)}</p>`).join("")}</section>`,
  ).join("");
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Proposta · ${escapeHtml(eng.companyName)} · Quantua</title>
  <style>
    @media print { @page { margin: 28mm 22mm; } }
    body { font-family: Georgia, serif; background: #F5F2EC; color: #161513; max-width: 720px; margin: 0 auto; padding: 48px 32px; line-height: 1.65; }
    h1 { font-size: 28px; font-weight: 500; letter-spacing: -0.02em; margin-bottom: 8px; }
    h2 { font-size: 16px; font-weight: 600; margin-top: 32px; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.08em; color: #5A554C; }
    .ref { font-family: 'Courier New', monospace; font-size: 11px; letter-spacing: 0.1em; color: #8A8478; text-transform: uppercase; margin-bottom: 24px; }
    p { margin: 8px 0; font-size: 15px; }
    .meta { background: #EDE8DE; padding: 16px; margin-bottom: 32px; font-size: 13px; }
    .meta div { margin: 4px 0; }
  </style>
</head>
<body>
  <div class="ref">○ PROPOSTA QUANTUA · ${letter.meta.reference}</div>
  <h1>${escapeHtml(letter.meta.companyName)}</h1>
  <div class="meta">
    <div><strong>Solicitante:</strong> ${escapeHtml(letter.meta.requesterLine)}</div>
    <div><strong>RT:</strong> ${escapeHtml(letter.meta.rtLine)}</div>
    <div><strong>Prazo de entrega:</strong> ${escapeHtml(letter.meta.deadlineFormatted)}</div>
    <div><strong>Honorários:</strong> ${escapeHtml(letter.meta.feeFormatted)}</div>
  </div>
  ${sectionsHtml}
  <p style="margin-top: 48px; font-size: 11px; color: #8A8478; text-align: center;">
    Quantua Serviços de Análise Ltda. · Versão ${letter.version} · Hash ${letter.contentHash.slice(0, 12)}…
  </p>
</body>
</html>`);
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export default router;
