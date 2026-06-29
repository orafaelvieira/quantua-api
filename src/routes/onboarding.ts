import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { publicReadLimiter, publicWriteLimiter } from "../middleware/rate-limit";
import { sendTeamInviteEmail } from "../services/email";

const router = Router();

const workspaceSchema = z.object({
  type: z.enum(["empresa", "consultoria"]),
  cnpj: z.string().trim().optional().nullable(),
  razaoSocial: z.string().trim().min(2),
  nomeFantasia: z.string().trim().optional().nullable(),
  setor: z.string().trim().optional().nullable(),
  porte: z.enum(["micro", "pequena", "media", "grande"]).optional().nullable(),
});

const workspacePrefsSchema = z.object({
  defaultCurrency: z.enum(["BRL", "USD", "EUR"]).optional(),
  fiscalYearStart: z.enum(["january", "april", "july"]).optional(),
  auditLogsOn: z.boolean().optional(),
  aiAnalysisModel: z.enum(["haiku", "sonnet", "opus"]).optional(),
});

const profileSchema = z.object({
  name: z.string().trim().min(2).optional(),
  cargo: z.string().trim().min(1).optional(),
  phone: z.string().trim().optional().nullable(),
  timezone: z.string().trim().optional(),
  language: z.enum(["pt-BR", "en-US"]).optional(),
});

const inviteRoleEnum = z.enum(["operator", "reviewer", "partner"]);

const invitesSchema = z.object({
  invites: z
    .array(
      z.object({
        email: z.string().email(),
        role: inviteRoleEnum,
      }),
    )
    .min(1)
    .max(20),
});

const acceptInviteSchema = z.object({
  token: z.string().min(32),
  name: z.string().min(2),
  password: z.string().min(8),
  phone: z.string().trim().optional(),
  cargo: z.string().trim().optional(),
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

/**
 * Step 1 — cria o Workspace e vincula ao usuário corrente.
 * Se o usuário já tem workspace, retorna conflito (use PATCH para atualizar).
 */
router.post("/workspace", requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = workspaceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) {
    res.status(404).json({ error: "Usuário não encontrado" });
    return;
  }
  if (user.workspaceId) {
    res.status(409).json({ error: "Workspace já existe. Use PATCH /onboarding/workspace/:id." });
    return;
  }

  const workspace = await prisma.$transaction(async (tx) => {
    const ws = await tx.workspace.create({
      data: {
        type: parsed.data.type,
        cnpj: parsed.data.cnpj ?? null,
        razaoSocial: parsed.data.razaoSocial,
        nomeFantasia: parsed.data.nomeFantasia ?? null,
        setor: parsed.data.setor ?? null,
        porte: parsed.data.porte ?? null,
      },
    });
    await tx.user.update({
      where: { id: user.id },
      data: {
        workspaceId: ws.id,
        workspaceType: parsed.data.type,
        role: user.role ?? "partner",
      },
    });
    return ws;
  });

  res.status(201).json({ workspace });
});

/**
 * Step 3 — atualiza preferências do workspace (moeda, ano fiscal, audit logs).
 */
router.patch("/workspace/:id", requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = workspacePrefsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user || user.workspaceId !== req.params.id) {
    res.status(403).json({ error: "Sem acesso a este workspace" });
    return;
  }
  const workspace = await prisma.workspace.update({
    where: { id: req.params.id },
    data: {
      defaultCurrency: parsed.data.defaultCurrency,
      fiscalYearStart: parsed.data.fiscalYearStart,
      auditLogsOn: parsed.data.auditLogsOn,
      aiAnalysisModel: parsed.data.aiAnalysisModel,
    },
  });
  res.json({ workspace });
});

/**
 * Step 2 e 3 — atualiza perfil do usuário (cargo, phone, timezone, language).
 */
router.patch("/profile", requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const data: Prisma.UserUpdateInput = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.cargo !== undefined) data.cargo = parsed.data.cargo;
  if (parsed.data.phone !== undefined) data.phone = parsed.data.phone;
  if (parsed.data.timezone !== undefined) data.timezone = parsed.data.timezone;
  if (parsed.data.language !== undefined) data.language = parsed.data.language;

  const user = await prisma.user.update({
    where: { id: req.userId },
    data,
    select: {
      id: true,
      name: true,
      email: true,
      workspaceType: true,
      role: true,
      phone: true,
      cargo: true,
      timezone: true,
      language: true,
      onboardedAt: true,
      workspaceId: true,
    },
  });
  res.json({ user });
});

/**
 * Step 4 — envia convites em batch para a equipe.
 * Cria um TeamInvite por email, gera magic link e dispara email.
 */
router.post("/invites", requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = invitesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const inviter = await prisma.user.findUnique({
    where: { id: req.userId },
    include: { workspace: true },
  });
  if (!inviter || !inviter.workspaceId || !inviter.workspace) {
    res.status(409).json({ error: "Workspace não configurado. Complete o passo anterior." });
    return;
  }

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const created: Array<{ id: string; email: string; role: string; status: string }> = [];

  for (const inv of parsed.data.invites) {
    const email = inv.email.toLowerCase();
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      created.push({ id: "", email, role: inv.role, status: "skipped_existing_user" });
      continue;
    }
    const existingPending = await prisma.teamInvite.findFirst({
      where: { workspaceId: inviter.workspaceId, email, status: "pending" },
    });
    if (existingPending) {
      created.push({ id: existingPending.id, email, role: inv.role, status: "skipped_pending" });
      continue;
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashInvitationToken(rawToken);
    const invite = await prisma.teamInvite.create({
      data: {
        workspaceId: inviter.workspaceId,
        email,
        role: inv.role,
        tokenHash,
        expiresAt,
        invitedById: inviter.id,
      },
    });

    await sendTeamInviteEmail({
      to: email,
      workspaceName: inviter.workspace.razaoSocial,
      invitedByName: inviter.name,
      role: inv.role,
      magicLink: `${env.frontendUrl}/convite/equipe/${rawToken}`,
      expiresAt,
    });

    created.push({ id: invite.id, email, role: inv.role, status: "sent" });
  }

  res.status(201).json({ invites: created });
});

/**
 * Step 5 — finaliza o onboarding marcando user.onboardedAt.
 */
router.post("/complete", requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) {
    res.status(404).json({ error: "Usuário não encontrado" });
    return;
  }
  if (!user.workspaceId) {
    res.status(409).json({ error: "Workspace não criado. Complete o passo de workspace primeiro." });
    return;
  }
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { onboardedAt: new Date() },
    select: {
      id: true,
      name: true,
      email: true,
      workspaceType: true,
      role: true,
      phone: true,
      cargo: true,
      timezone: true,
      language: true,
      onboardedAt: true,
      workspaceId: true,
    },
  });
  res.json({ user: updated });
});

/**
 * Convidado — preview público do convite via magic link.
 */
router.get("/invite/:token", publicReadLimiter, async (req: Request, res: Response): Promise<void> => {
  const rawToken = req.params.token;
  if (!rawToken || typeof rawToken !== "string" || rawToken.length < 32) {
    res.status(404).json({ status: "invalid" });
    return;
  }
  const tokenHash = hashInvitationToken(rawToken);
  const invitation = await prisma.teamInvite.findUnique({
    where: { tokenHash },
    include: {
      workspace: { select: { id: true, razaoSocial: true, type: true } },
      invitedBy: { select: { name: true, email: true } },
    },
  });

  if (!invitation) {
    res.status(404).json({ status: "invalid" });
    return;
  }
  if (invitation.acceptedAt) {
    res.status(410).json({ status: "used" });
    return;
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    res.status(410).json({ status: "expired" });
    return;
  }

  res.json({
    status: "valid",
    invitation: {
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
    },
    workspace: invitation.workspace,
    invitedBy: invitation.invitedBy,
  });
});

/**
 * Convidado — aceita convite, cria User vinculado ao Workspace.
 */
router.post("/accept-invite", publicWriteLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = acceptInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { token, name, password, phone, cargo } = parsed.data;
  const tokenHash = hashInvitationToken(token);

  const invitation = await prisma.teamInvite.findUnique({
    where: { tokenHash },
    include: { workspace: true },
  });
  if (!invitation) {
    res.status(404).json({ error: "Convite inválido" });
    return;
  }
  if (invitation.acceptedAt) {
    res.status(410).json({ error: "Convite já utilizado" });
    return;
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    res.status(410).json({ error: "Convite expirado" });
    return;
  }

  const existingUser = await prisma.user.findUnique({ where: { email: invitation.email } });
  if (existingUser) {
    res.status(409).json({ error: "Já existe cadastro com esse e-mail. Faça login pela tela inicial." });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name,
        email: invitation.email,
        passwordHash,
        role: invitation.role,
        workspaceType: invitation.workspace.type,
        workspaceId: invitation.workspaceId,
        phone: phone ?? null,
        cargo: cargo ?? null,
        invitedAt: invitation.createdAt,
        onboardedAt: new Date(),
      },
      select: {
        id: true,
        name: true,
        email: true,
        workspaceType: true,
        role: true,
        phone: true,
        cargo: true,
        timezone: true,
        language: true,
        onboardedAt: true,
        workspaceId: true,
      },
    });

    await tx.teamInvite.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date(), status: "accepted" },
    });

    return { user };
  });

  res.status(201).json({
    user: result.user,
    token: signToken(result.user.id),
  });
});

export default router;
