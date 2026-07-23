import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "../db/client";
import { requireAuth, requireQuantua, AuthRequest } from "../middleware/auth";
import { registrarAuditoria } from "../services/audit-trail";
import { sendTeamInviteEmail, sendPasswordResetEmail } from "../services/email";
import { env } from "../config/env";

const router = Router();
router.use(requireAuth);
// F2 SaaS: dado de FIRMA — usuário externo (empresa/parceiro) e portal nunca acessam.
router.use(requireQuantua);

const PAPEIS_EQUIPE = ["operator", "reviewer", "partner"];
const hashToken = (raw: string): string => crypto.createHash("sha256").update(raw).digest("hex");
/** Hash do token de REDEFINIÇÃO DE SENHA — precisa ser idêntico ao de
 *  auth.ts (`hashInvitationToken`), que é quem valida o link. São algoritmos
 *  DIFERENTES: o convite de equipe usa sha256 puro; o reset leva o segredo. */
const hashResetSenha = (raw: string): string =>
  crypto.createHash("sha256").update(raw + env.invitationSecret).digest("hex");

/** Gerir a equipe (convidar/papel/desativar) é ação de PARTNER (ou role nula — fundador). */
async function podeGerirEquipe(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  return !u?.role || u.role === "partner";
}
/** Workspace do caller — fronteira da equipe interna. */
async function workspaceDoCaller(userId: string): Promise<string | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { workspaceId: true } });
  return u?.workspaceId ?? null;
}

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

// ── GESTÃO DE ACESSO DA EQUIPE QUANTUA (2026-07-17) ──────────────────────────
// Papéis (operator/reviewer/partner) + convites por e-mail + desativação.
// Escopo = workspace do caller. Mutação exige PARTNER.

// GET /team/acesso — membros (com status/desativado) + convites pendentes.
router.get("/acesso", async (req: AuthRequest, res: Response): Promise<void> => {
  const ws = await workspaceDoCaller(req.userId!);
  const where = ws ? { workspaceId: ws } : { OR: [{ id: req.userId! }, { role: { in: PAPEIS_EQUIPE } }] };
  const [membros, convites] = await Promise.all([
    prisma.user.findMany({
      where, orderBy: { createdAt: "asc" },
      select: { id: true, name: true, email: true, role: true, cargo: true, onboardedAt: true, desativadoEm: true, createdAt: true },
    }),
    ws ? prisma.teamInvite.findMany({ where: { workspaceId: ws, status: "pending" }, orderBy: { createdAt: "desc" } }) : Promise.resolve([]),
  ]);
  res.json({
    podeGerir: await podeGerirEquipe(req.userId!),
    membros: membros.map((m) => ({
      userId: m.id, nome: m.name, email: m.email, papel: m.role ?? "operator", cargo: m.cargo ?? null,
      status: m.desativadoEm ? "desativado" : m.onboardedAt ? "ativo" : "pendente",
      desativadoEm: m.desativadoEm, ehVoceMesmo: m.id === req.userId,
    })),
    convitesPendentes: convites.map((c) => ({ id: c.id, email: c.email, papel: c.role, expiraEm: c.expiresAt })),
  });
});

// POST /team/convites — convida membro da equipe (partner). E-mail + fallback link.
router.post("/convites", async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await podeGerirEquipe(req.userId!))) { res.status(403).json({ error: "Convidar membros da equipe é ação de partner." }); return; }
  const ws = await workspaceDoCaller(req.userId!);
  if (!ws) { res.status(409).json({ error: "Seu usuário não tem workspace configurado — conclua o onboarding." }); return; }
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const papel = PAPEIS_EQUIPE.includes(req.body?.papel) ? req.body.papel : "operator";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { res.status(400).json({ error: "E-mail inválido" }); return; }
  // CONTA JÁ EXISTENTE NÃO É MAIS BECO SEM SAÍDA (23/07/2026). A checagem é
  // GLOBAL (e-mail é único no sistema), mas a LISTAGEM é por workspace — então
  // uma conta órfã (workspaceId null, criada antes dos workspaces) ficava
  // invisível na tela E impossível de convidar: "já existe" sem dizer onde nem
  // o que fazer. Caso real relatado pelo usuário em 23/07. Agora o 409 carrega
  // o DIAGNÓSTICO e a tela oferece a ação certa.
  const existente = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true, name: true, workspaceId: true, desativadoEm: true, role: true,
      workspace: { select: { id: true, razaoSocial: true, nomeFantasia: true } },
    },
  });
  if (existente) {
    const mesmoWorkspace = existente.workspaceId === ws;
    const semWorkspace = existente.workspaceId === null;
    // OUTRO WORKSPACE: o caso comum não é um tenant de verdade — é a pessoa que
    // se auto-cadastrou e o onboarding criou um workspace SÓ DELA (caso real do
    // usuário em 23/07). Distinguimos os dois pelo tamanho: sozinha lá dentro,
    // trazê-la não tira ninguém de equipe nenhuma; com colegas, é tenant real e
    // continua bloqueado. O nome da outra equipe vai na resposta para o partner
    // decidir com o dado na frente, não no escuro.
    const outrosMembros = existente.workspaceId
      ? await prisma.user.count({ where: { workspaceId: existente.workspaceId, id: { not: existente.id } } })
      : 0;
    const sozinhoNoOutro = !!existente.workspaceId && !mesmoWorkspace && outrosMembros === 0;
    const nomeOutro = existente.workspace?.nomeFantasia || existente.workspace?.razaoSocial || "equipe sem nome";
    res.status(409).json({
      error: mesmoWorkspace
        ? "Esta pessoa já está na sua equipe."
        : semWorkspace
          ? "Já existe uma conta com este e-mail, mas ela não está vinculada a nenhuma equipe — por isso não aparece na lista. Você pode trazê-la para a sua equipe."
          : sozinhoNoOutro
            ? `Esta conta está sozinha em outra equipe ("${nomeOutro}") — provavelmente um auto-cadastro. Trazê-la para cá não afeta mais ninguém; os dados dela vêm junto.`
            : `Esta conta pertence à equipe "${nomeOutro}", que tem outros ${outrosMembros} membro(s). Por segurança, ela não pode ser movida por aqui.`,
      conta: {
        id: existente.id,
        nome: existente.name,
        desativado: !!existente.desativadoEm,
        mesmoWorkspace,
        semWorkspace,
        sozinhoNoOutro,
        outraEquipe: mesmoWorkspace || semWorkspace ? null : { nome: nomeOutro, outrosMembros },
        podeAdotar: semWorkspace || sozinhoNoOutro,
      },
    });
    return;
  }
  if (await prisma.teamInvite.findFirst({ where: { workspaceId: ws, email, status: "pending" } })) { res.status(409).json({ error: "Já existe convite pendente para este e-mail." }); return; }

  const inviter = await prisma.user.findUnique({ where: { id: req.userId! }, select: { name: true, workspace: { select: { razaoSocial: true } } } });
  const rawToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const invite = await prisma.teamInvite.create({ data: { workspaceId: ws, email, role: papel, tokenHash: hashToken(rawToken), expiresAt, invitedById: req.userId! } });
  await sendTeamInviteEmail({
    to: email, workspaceName: inviter?.workspace?.razaoSocial ?? "Quantua", invitedByName: inviter?.name ?? "Equipe Quantua",
    role: papel, magicLink: `${env.frontendUrl}/convite/equipe/${rawToken}`, expiresAt,
  }).catch((e) => console.error("[team-invite email]", (e as Error)?.message ?? e));
  void registrarAuditoria({ userId: req.userId!, entity: "team", entityId: invite.id, field: "convite de equipe enviado", after: { email, papel }, source: "team" });
  res.status(201).json({ id: invite.id, email, papel, expiraEm: expiresAt, magicLink: `/convite/equipe/${rawToken}`, emailEnviado: env.email.provider === "resend" });
});

// POST /team/convites/:id/reenviar — novo link + reenvia (invalida o antigo).
router.post("/convites/:id/reenviar", async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await podeGerirEquipe(req.userId!))) { res.status(403).json({ error: "Sem permissão" }); return; }
  const ws = await workspaceDoCaller(req.userId!);
  const invite = await prisma.teamInvite.findFirst({ where: { id: String(req.params.id), workspaceId: ws ?? undefined, status: "pending" } });
  if (!invite) { res.status(404).json({ error: "Convite pendente não encontrado" }); return; }
  const inviter = await prisma.user.findUnique({ where: { id: req.userId! }, select: { name: true, workspace: { select: { razaoSocial: true } } } });
  const rawToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.teamInvite.update({ where: { id: invite.id }, data: { tokenHash: hashToken(rawToken), expiresAt } });
  await sendTeamInviteEmail({
    to: invite.email, workspaceName: inviter?.workspace?.razaoSocial ?? "Quantua", invitedByName: inviter?.name ?? "Equipe Quantua",
    role: invite.role, magicLink: `${env.frontendUrl}/convite/equipe/${rawToken}`, expiresAt,
  }).catch((e) => console.error("[team-invite email]", (e as Error)?.message ?? e));
  void registrarAuditoria({ userId: req.userId!, entity: "team", entityId: invite.id, field: "convite de equipe reenviado", after: { email: invite.email }, source: "team" });
  res.json({ ok: true, email: invite.email, expiraEm: expiresAt, magicLink: `/convite/equipe/${rawToken}`, emailEnviado: env.email.provider === "resend" });
});

// DELETE /team/convites/:id — revoga convite pendente.
router.delete("/convites/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await podeGerirEquipe(req.userId!))) { res.status(403).json({ error: "Sem permissão" }); return; }
  const ws = await workspaceDoCaller(req.userId!);
  const upd = await prisma.teamInvite.updateMany({ where: { id: String(req.params.id), workspaceId: ws ?? undefined, status: "pending" }, data: { status: "revoked" } });
  if (upd.count === 0) { res.status(404).json({ error: "Convite não encontrado" }); return; }
  void registrarAuditoria({ userId: req.userId!, entity: "team", entityId: String(req.params.id), field: "convite de equipe revogado", source: "team" });
  res.status(204).send();
});

/** Não deixa o workspace sem NENHUM partner ativo. */
async function ehUltimoPartnerAtivo(ws: string | null, userId: string): Promise<boolean> {
  const where = ws ? { workspaceId: ws } : { role: { in: PAPEIS_EQUIPE } };
  const ativos = await prisma.user.findMany({ where: { ...where, role: "partner", desativadoEm: null }, select: { id: true } });
  return ativos.length === 1 && ativos[0].id === userId;
}

// PUT /team/membros/:userId/papel — muda o papel (partner). Protege o último partner.
router.put("/membros/:userId/papel", async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await podeGerirEquipe(req.userId!))) { res.status(403).json({ error: "Sem permissão" }); return; }
  const ws = await workspaceDoCaller(req.userId!);
  const alvo = String(req.params.userId);
  const papel = PAPEIS_EQUIPE.includes(req.body?.papel) ? req.body.papel : null;
  if (!papel) { res.status(400).json({ error: "Papel inválido" }); return; }
  const membro = await prisma.user.findFirst({ where: { id: alvo, ...(ws ? { workspaceId: ws } : {}) }, select: { id: true, role: true } });
  if (!membro) { res.status(404).json({ error: "Membro não encontrado" }); return; }
  if (membro.role === "partner" && papel !== "partner" && await ehUltimoPartnerAtivo(ws, alvo)) {
    res.status(409).json({ error: "Não é possível rebaixar o último partner ativo do workspace." }); return;
  }
  await prisma.user.update({ where: { id: alvo }, data: { role: papel } });
  void registrarAuditoria({ userId: req.userId!, entity: "user", entityId: alvo, field: "papel da equipe alterado", before: { papel: membro.role }, after: { papel }, source: "team" });
  res.json({ ok: true });
});

// PUT /team/membros/:userId/ativo — desativa (offboarding) ou reativa.
router.put("/membros/:userId/ativo", async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await podeGerirEquipe(req.userId!))) { res.status(403).json({ error: "Sem permissão" }); return; }
  const ws = await workspaceDoCaller(req.userId!);
  const alvo = String(req.params.userId);
  const ativo = req.body?.ativo === true; // ativo=true reativa; false desativa
  if (alvo === req.userId && !ativo) { res.status(409).json({ error: "Você não pode desativar o próprio acesso." }); return; }
  const membro = await prisma.user.findFirst({ where: { id: alvo, ...(ws ? { workspaceId: ws } : {}) }, select: { id: true, role: true } });
  if (!membro) { res.status(404).json({ error: "Membro não encontrado" }); return; }
  if (!ativo && membro.role === "partner" && await ehUltimoPartnerAtivo(ws, alvo)) {
    res.status(409).json({ error: "Não é possível desativar o último partner ativo do workspace." }); return;
  }
  await prisma.user.update({ where: { id: alvo }, data: { desativadoEm: ativo ? null : new Date() } });
  void registrarAuditoria({ userId: req.userId!, entity: "user", entityId: alvo, field: ativo ? "acesso da equipe reativado" : "acesso da equipe desativado (offboarding)", source: "team" });
  res.json({ ok: true });
});

/**
 * POST /team/membros/adotar — traz para a equipe uma conta que EXISTE mas está
 * órfã (sem workspace). body: { email, papel? }
 *
 * Por que existe (23/07/2026): contas criadas antes dos workspaces ficaram com
 * `workspaceId` nulo. Elas não aparecem na listagem (que filtra por workspace) e
 * o convite as recusa ("já existe conta com este e-mail") — o partner ficava sem
 * nenhuma porta para consertar o acesso da própria equipe.
 *
 * TRAVA MULTI-TENANT: conta de OUTRO workspace nunca é movida por aqui. Roubar
 * um usuário de outra equipe seria uma escalada de privilégio silenciosa.
 */
router.post("/membros/adotar", async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await podeGerirEquipe(req.userId!))) { res.status(403).json({ error: "Gerir a equipe é ação de partner." }); return; }
  const ws = await workspaceDoCaller(req.userId!);
  if (!ws) { res.status(409).json({ error: "Seu usuário não tem workspace configurado — conclua o onboarding." }); return; }
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const papel = PAPEIS_EQUIPE.includes(req.body?.papel) ? req.body.papel : "operator";
  if (!email) { res.status(400).json({ error: "email é obrigatório" }); return; }

  const alvo = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true, name: true, email: true, workspaceId: true, role: true, desativadoEm: true,
      workspace: { select: { razaoSocial: true, nomeFantasia: true } },
    },
  });
  if (!alvo) { res.status(404).json({ error: "Não existe conta com este e-mail — use o convite normal." }); return; }
  if (alvo.workspaceId === ws) { res.status(409).json({ error: "Esta pessoa já está na sua equipe." }); return; }

  // A trava não é "tem workspace", é "tem COLEGAS lá". Workspace de uma pessoa
  // só é auto-cadastro acidental (o onboarding cria um por conta nova); mover
  // não deixa ninguém sem equipe. Com outros membros é tenant real — recusa.
  let origem: { id: string; nome: string } | null = null;
  if (alvo.workspaceId !== null) {
    const outrosMembros = await prisma.user.count({ where: { workspaceId: alvo.workspaceId, id: { not: alvo.id } } });
    const nomeOutro = alvo.workspace?.nomeFantasia || alvo.workspace?.razaoSocial || "equipe sem nome";
    if (outrosMembros > 0) {
      res.status(409).json({ error: `Esta conta pertence à equipe "${nomeOutro}", que tem outros ${outrosMembros} membro(s), e não pode ser movida por aqui. Peça ao partner daquela equipe para liberá-la.` });
      return;
    }
    origem = { id: alvo.workspaceId, nome: nomeOutro };
  }

  await prisma.user.update({
    where: { id: alvo.id },
    // Adotar RESTAURA o acesso: a conta costuma estar desativada por offboarding
    // antigo, e trazê-la de volta sem reativar seria meio conserto.
    data: { workspaceId: ws, role: papel, desativadoEm: null },
  });
  void registrarAuditoria({
    userId: req.userId!, entity: "user", entityId: alvo.id,
    field: origem
      ? `conta movida para a equipe (vinha da equipe "${origem.nome}", onde estava sozinha)`
      : "conta órfã trazida para a equipe (vínculo de workspace)",
    before: { workspaceId: alvo.workspaceId, workspaceNome: origem?.nome ?? null, papel: alvo.role, desativado: !!alvo.desativadoEm },
    after: { workspaceId: ws, papel }, source: "team",
  });
  res.json({ ok: true, id: alvo.id, nome: alvo.name, email: alvo.email, papel });
});

/**
 * POST /team/membros/:userId/redefinir-senha — envia ao membro um link de
 * redefinição (pedido do usuário, 23/07/2026: "faz sentido colocar um link na
 * tela para enviar novamente um link de alteração de senha?").
 *
 * O partner NUNCA vê nem define a senha: gera-se o mesmo token do fluxo público
 * de "esqueci a senha" e quem escolhe a nova senha é a própria pessoa, pelo
 * e-mail dela. Tokens pendentes anteriores são invalidados.
 */
router.post("/membros/:userId/redefinir-senha", async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await podeGerirEquipe(req.userId!))) { res.status(403).json({ error: "Sem permissão" }); return; }
  const ws = await workspaceDoCaller(req.userId!);
  const alvo = String(req.params.userId);
  const membro = await prisma.user.findFirst({
    where: { id: alvo, ...(ws ? { workspaceId: ws } : {}) },
    select: { id: true, name: true, email: true, desativadoEm: true },
  });
  if (!membro) { res.status(404).json({ error: "Membro não encontrado na sua equipe" }); return; }
  if (membro.desativadoEm) {
    res.status(409).json({ error: "Esta conta está desativada — reative o acesso antes de enviar o link (senha nova não destrava conta desativada)." });
    return;
  }

  await prisma.passwordResetToken.updateMany({ where: { userId: membro.id, usedAt: null }, data: { usedAt: new Date() } });
  const rawToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h, igual ao fluxo público
  await prisma.passwordResetToken.create({
    data: {
      userId: membro.id,
      // hashResetSenha, NÃO o hashToken local: /auth/reset-password valida com
      // sha256(token + invitationSecret). Gravar com o hash simples do convite
      // geraria um link que sempre responde "token inválido".
      tokenHash: hashResetSenha(rawToken),
      expiresAt,
      ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "team-admin",
    },
  });
  const link = `${env.frontendUrl}/redefinir-senha?token=${rawToken}`;
  let emailEnviado = false;
  try {
    await sendPasswordResetEmail({ to: membro.email, name: membro.name, resetLink: link, expiresAt });
    emailEnviado = env.email.provider === "resend";
  } catch (e) {
    console.error("[team/redefinir-senha] envio falhou:", (e as Error)?.message ?? e);
  }
  void registrarAuditoria({
    userId: req.userId!, entity: "user", entityId: membro.id,
    field: "link de redefinição de senha enviado pelo partner",
    after: { email: membro.email, expiraEm: expiresAt.toISOString() }, source: "team",
  });
  // O link volta na resposta como PLANO B (mesmo padrão do convite): sem
  // provedor de e-mail configurado, o partner ainda consegue destravar a pessoa.
  res.json({ ok: true, emailEnviado, expiraEm: expiresAt, link });
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
    where: { id: parsed.data.analysisId, userId: { in: req.scopeUserIds! } },
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
    where: { id, analysis: { userId: { in: req.scopeUserIds! } } },
    select: { id: true },
  });
  if (!allocation) { res.status(404).json({ error: "Alocação não encontrada" }); return; }
  await prisma.allocation.delete({ where: { id } });
  res.status(204).end();
});

export default router;
