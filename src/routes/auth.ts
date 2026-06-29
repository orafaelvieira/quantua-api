import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { loginLimiter, publicReadLimiter, publicWriteLimiter, resendLimiter, forgotPasswordEmailLimiter, forgotPasswordIpLimiter } from "../middleware/rate-limit";
import { renderLetter } from "../services/letter-templates";
import { sendInviteEmail, sendPasswordResetEmail, sendEmailConfirmationEmail, sendNewSignupNotificationEmail } from "../services/email";

const router = Router();

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  workspaceType: z.enum(["empresa", "consultoria"]).default("consultoria"),
  // Perfil de ICP escolhido na página /para/<perfil>. Opcional.
  partnerProfile: z.enum(["contabilidade", "bpo", "cfo"]).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const acceptInviteSchema = z.object({
  token: z.string().min(32),
  name: z.string().min(2),
  password: z.string().min(8),
  acceptedTerms: z.literal(true),
});

const resendInviteSchema = z.object({
  email: z.string().email(),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(32),
  password: z.string().min(8),
});

const confirmEmailSchema = z.object({
  token: z.string().min(32),
});

function signToken(userId: string): string {
  return jwt.sign({ userId }, env.jwtSecret, { expiresIn: "30d" });
}

function hashInvitationToken(rawToken: string): string {
  return crypto
    .createHash("sha256")
    .update(rawToken + env.invitationSecret)
    .digest("hex");
}

router.post("/register", async (req: Request, res: Response): Promise<void> => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { name, email, password, workspaceType, partnerProfile } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: "E-mail já cadastrado" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { name, email, passwordHash, workspaceType, partnerProfile: partnerProfile ?? null },
    select: { id: true, name: true, email: true, workspaceType: true, partnerProfile: true, role: true },
  });

  // Notifica o time sobre o novo cadastro. Best-effort.
  await sendNewSignupNotificationEmail({
    to: env.email.teamInbox,
    name: user.name,
    email: user.email,
    workspaceType: user.workspaceType,
    partnerProfile: user.partnerProfile,
  });

  res.status(201).json({ user, token: signToken(user.id) });
});

router.post("/login", loginLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos" });
    return;
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    res.status(401).json({ error: "E-mail ou senha incorretos" });
    return;
  }

  res.json({
    user: { id: user.id, name: user.name, email: user.email, workspaceType: user.workspaceType, role: user.role },
    token: signToken(user.id),
  });
});

router.get("/me", requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      id: true,
      name: true,
      email: true,
      workspaceType: true,
      partnerProfile: true,
      role: true,
      phone: true,
      cargo: true,
      timezone: true,
      language: true,
      onboardedAt: true,
      workspaceId: true,
      createdAt: true,
      workspace: {
        select: {
          id: true,
          type: true,
          cnpj: true,
          razaoSocial: true,
          nomeFantasia: true,
          setor: true,
          porte: true,
          defaultCurrency: true,
          fiscalYearStart: true,
          auditLogsOn: true,
          aiAnalysisModel: true,
        },
      },
    },
  });
  if (!user) { res.status(404).json({ error: "Usuário não encontrado" }); return; }

  // Para clientes, busca o estado do engagement (aceite da carta) para o frontend rotear.
  let engagementSigned = false;
  let engagementId: string | undefined;
  if (user.role === "client") {
    const company = await prisma.company.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      include: {
        analyses: {
          where: { kind: "ibr" },
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { engagement: { select: { id: true, letterAcceptedAt: true } } },
        },
      },
    });
    const engagement = company?.analyses[0]?.engagement;
    engagementSigned = !!engagement?.letterAcceptedAt;
    engagementId = engagement?.id;
  }

  res.json({ ...user, engagementSigned, engagementId });
});

/**
 * Preview público da carta antes do aceite. Cliente recebe magic link e o
 * frontend chama este endpoint para mostrar conteúdo + dados do engagement.
 */
router.get("/invite/:token", publicReadLimiter, async (req: Request, res: Response): Promise<void> => {
  const rawToken = req.params.token;
  if (!rawToken || typeof rawToken !== "string" || rawToken.length < 32) {
    res.status(404).json({ status: "invalid" });
    return;
  }
  const tokenHash = hashInvitationToken(rawToken);
  const invitation = await prisma.clientInvitation.findUnique({
    where: { tokenHash },
    include: {
      engagement: {
        include: { rt: { select: { name: true, professionalRegistration: true } } },
      },
    },
  });

  if (!invitation) {
    res.status(404).json({ status: "invalid" });
    return;
  }
  if (invitation.usedAt) {
    res.status(410).json({ status: "used" });
    return;
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    res.status(410).json({ status: "expired" });
    return;
  }

  const eng = invitation.engagement;
  if (eng.state !== "won" && eng.state !== "kicked_off") {
    res.status(409).json({ status: "engagement_not_ready" });
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

  res.json({
    status: "valid",
    invitation: {
      email: invitation.email,
      expiresAt: invitation.expiresAt.toISOString(),
    },
    engagement: {
      id: eng.id,
      companyName: eng.companyName,
      requestedBy: eng.requestedBy,
      requestedByType: eng.requestedByType,
      scope: eng.scope,
      feeAmount: eng.feeAmount,
      feeCurrency: eng.feeCurrency,
      deadline: eng.deadline?.toISOString() ?? null,
      rtName: eng.rt?.name ?? null,
      rtRegistration: eng.rt?.professionalRegistration ?? null,
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
 * Aceite do convite + criação de senha em uma única operação.
 * Cria User cliente, vincula Company, marca invitation como usada,
 * registra EngagementSignature e atualiza letterAcceptedAt.
 */
router.post("/accept-invite", publicWriteLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = acceptInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { token, name, password } = parsed.data;
  const tokenHash = hashInvitationToken(token);

  const invitation = await prisma.clientInvitation.findUnique({
    where: { tokenHash },
    include: { engagement: { include: { rt: true } } },
  });
  if (!invitation) {
    res.status(404).json({ error: "Convite inválido" });
    return;
  }
  if (invitation.usedAt) {
    res.status(410).json({ error: "Convite já utilizado" });
    return;
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    res.status(410).json({ error: "Convite expirado" });
    return;
  }

  const eng = invitation.engagement;
  if (eng.state !== "won" && eng.state !== "kicked_off") {
    res.status(409).json({ error: "Engagement ainda não foi fechado" });
    return;
  }
  if (!eng.analysisId) {
    res.status(409).json({ error: "Engagement sem IBR vinculado. Contate o RT." });
    return;
  }

  const existingUser = await prisma.user.findUnique({ where: { email: invitation.email } });
  if (existingUser) {
    res.status(409).json({ error: "Já existe um cadastro com esse e-mail. Faça login pela tela inicial." });
    return;
  }

  // Renderiza letter atual + computa hash para auditoria
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

  const passwordHash = await bcrypt.hash(password, 12);
  const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
  const userAgent = req.headers["user-agent"]?.slice(0, 500) || "unknown";

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name,
        email: invitation.email,
        passwordHash,
        role: "client",
        workspaceType: "empresa",
        invitedAt: invitation.createdAt,
      },
      select: { id: true, name: true, email: true, role: true, workspaceType: true },
    });

    // Vincula Company existente (criada em transition→won) ao novo user cliente
    const analysis = await tx.analysis.findUnique({ where: { id: eng.analysisId! } });
    if (!analysis) throw new Error("Analysis associada ao engagement não encontrada");
    await tx.company.update({
      where: { id: analysis.companyId },
      data: { userId: user.id },
    });

    await tx.clientInvitation.update({
      where: { id: invitation.id },
      data: { usedAt: new Date(), status: "used" },
    });

    await tx.engagementSignature.create({
      data: {
        engagementId: eng.id,
        signerType: "client",
        signerUserId: user.id,
        signerName: name,
        signerEmail: invitation.email,
        contentHash: letter.contentHash,
        letterVersion: letter.version,
        ipAddress,
        userAgent,
      },
    });

    const updatedEng = await tx.engagement.update({
      where: { id: eng.id },
      data: {
        letterAcceptedAt: new Date(),
        letterContentHash: letter.contentHash,
        letterVersion: letter.version,
      },
      select: { id: true, letterAcceptedAt: true },
    });

    await tx.auditEvent.create({
      data: {
        analysisId: eng.analysisId,
        userId: user.id,
        userName: name,
        entity: "engagement",
        entityId: eng.id,
        field: "letter_accepted",
        before: Prisma.JsonNull,
        after: { signedAt: updatedEng.letterAcceptedAt, contentHash: letter.contentHash, version: letter.version },
        source: "client",
      },
    });

    return { user, engagementId: updatedEng.id };
  });

  res.status(201).json({
    user: result.user,
    token: signToken(result.user.id),
    engagement: { id: result.engagementId, letterAcceptedAt: new Date().toISOString() },
  });
});

/**
 * Reenvia magic link. Identifica invitation pendente pelo email + rota o último
 * engagement "won/kicked_off" desse email. Gera novo tokenHash (rotação).
 */
router.post("/magic-link/resend", resendLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = resendInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "E-mail inválido" });
    return;
  }
  const email = parsed.data.email.toLowerCase();
  const invitation = await prisma.clientInvitation.findFirst({
    where: { email, status: "pending" },
    orderBy: { createdAt: "desc" },
    include: {
      engagement: { include: { rt: { select: { name: true } } } },
      createdBy: { select: { name: true } },
    },
  });

  // Resposta sempre 200 (não vazar enumeração de emails)
  if (!invitation) {
    res.json({ ok: true });
    return;
  }

  const newRawToken = crypto.randomBytes(32).toString("hex");
  const newHash = hashInvitationToken(newRawToken);
  const newExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await prisma.clientInvitation.update({
    where: { id: invitation.id },
    data: {
      tokenHash: newHash,
      expiresAt: newExpires,
      lastSentAt: new Date(),
      resendCount: { increment: 1 },
    },
  });

  await sendInviteEmail({
    to: invitation.email,
    contactName: undefined,
    companyName: invitation.engagement.companyName,
    rtName: invitation.engagement.rt?.name ?? invitation.createdBy.name,
    magicLink: `${env.frontendUrl}/convite/${newRawToken}`,
    expiresAt: newExpires,
  });

  res.json({ ok: true });
});

/**
 * Solicita link de redefinição de senha. Resposta sempre 200 (anti-enumeração).
 * Rate-limited por email (3/h) e por IP (10/h).
 */
router.post(
  "/forgot-password",
  forgotPasswordIpLimiter,
  forgotPasswordEmailLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.json({ ok: true });
      return;
    }
    const email = parsed.data.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      res.json({ ok: true });
      return;
    }

    // Invalida todos os tokens pendentes do usuário antes de gerar novo (evita TOCTOU).
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashInvitationToken(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h
    const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";

    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt, ipAddress },
    });

    await sendPasswordResetEmail({
      to: user.email,
      name: user.name,
      resetLink: `${env.frontendUrl}/redefinir-senha?token=${rawToken}`,
      expiresAt,
    });

    res.json({ ok: true });
  },
);

/**
 * Aplica a nova senha. Invalida o token usado + todos os outros pendentes do user.
 */
router.post(
  "/reset-password",
  publicWriteLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Dados inválidos" });
      return;
    }
    const { token, password } = parsed.data;
    const tokenHash = hashInvitationToken(token);

    const record = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    if (!record) {
      res.status(410).json({ error: "Link inválido" });
      return;
    }
    if (record.usedAt) {
      res.status(410).json({ error: "Link já utilizado" });
      return;
    }
    if (record.expiresAt.getTime() < Date.now()) {
      res.status(410).json({ error: "Link expirado" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash },
      }),
      prisma.passwordResetToken.updateMany({
        where: { userId: record.userId, usedAt: null },
        data: { usedAt: new Date() },
      }),
      prisma.auditEvent.create({
        data: {
          userId: record.userId,
          userName: record.user.name,
          entity: "user",
          entityId: record.userId,
          field: "password_reset",
          before: Prisma.JsonNull,
          after: { resetAt: new Date().toISOString() },
          source: "self_service",
        },
      }),
    ]);

    res.json({ ok: true });
  },
);

/**
 * Reenvia email de confirmação. Sempre 200 (anti-enum). Rate-limited por email.
 */
router.post(
  "/resend-confirmation",
  resendLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.json({ ok: true });
      return;
    }
    const email = parsed.data.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || user.emailConfirmedAt) {
      // Já confirmado ou não existe — resposta genérica.
      res.json({ ok: true });
      return;
    }

    await prisma.emailConfirmationToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashInvitationToken(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 dias

    await prisma.emailConfirmationToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    await sendEmailConfirmationEmail({
      to: user.email,
      name: user.name,
      confirmLink: `${env.frontendUrl}/confirmar-email?token=${rawToken}`,
      expiresAt,
    });

    res.json({ ok: true });
  },
);

/**
 * Confirma email via token. Idempotente: se já confirmado, retorna 200 com flag.
 */
router.post(
  "/confirm-email",
  publicWriteLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = confirmEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Token inválido" });
      return;
    }
    const tokenHash = hashInvitationToken(parsed.data.token);

    const record = await prisma.emailConfirmationToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, emailConfirmedAt: true } } },
    });
    if (!record) {
      res.status(410).json({ error: "Link inválido" });
      return;
    }
    if (record.user.emailConfirmedAt) {
      res.json({ ok: true, alreadyConfirmed: true });
      return;
    }
    if (record.usedAt) {
      res.status(410).json({ error: "Link já utilizado" });
      return;
    }
    if (record.expiresAt.getTime() < Date.now()) {
      res.status(410).json({ error: "Link expirado" });
      return;
    }

    const now = new Date();
    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { emailConfirmedAt: now },
      }),
      prisma.emailConfirmationToken.update({
        where: { id: record.id },
        data: { usedAt: now },
      }),
    ]);

    res.json({ ok: true });
  },
);

export default router;
