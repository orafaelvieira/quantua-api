import { Router, Response } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../db/client";
import { requireAuth, requireQuantua, AuthRequest } from "../middleware/auth";
import { whereEmpresaVisivel } from "../services/escopo-empresa";
import { registrarAuditoria } from "../services/audit-trail";
import { statusOrganizacao } from "../services/escopo-acesso";
import { sendOrgInviteEmail } from "../services/email";
import { env } from "../config/env";

/** Dispara o e-mail do convite de organização (não bloqueia a resposta se falhar). */
async function enviarEmailConviteOrg(org: { nome: string; tipo: string; dataInicio: Date | null; suspenso: boolean; dataFim: Date | null }, email: string, papel: string, rawToken: string, expiresAt: Date): Promise<void> {
  const status = statusOrganizacao(org, new Date());
  await sendOrgInviteEmail({
    to: email,
    organizacaoNome: org.nome,
    organizacaoTipo: org.tipo,
    papel,
    magicLink: `${env.frontendUrl}/convite/organizacao/${rawToken}`,
    expiresAt,
    acessoAPartirDe: status === "agendado" ? org.dataInicio : null,
  }).catch((e) => console.error("[org-invite email]", (e as Error)?.message ?? e));
}

const PAPEIS_GRUPO = ["matriz", "holding", "investida", "filial", "outros"];
/** Valida ISO date; devolve Date, null (limpar) ou undefined (não mexer). */
function parseDataOpcional(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * F3 DOS ACESSOS SAAS (2026-07-17) — gestão de ORGANIZAÇÕES e convites.
 *
 *  - Criar organização, vincular/desvincular EMPRESAS: só equipe Quantua
 *    (é quem contrata e fatura — a fronteira de dados nasce aqui).
 *  - Convidar/remover MEMBROS: Quantua OU um "gestor" da própria organização
 *    (o gestor do grupo/escritório distribui acesso À EQUIPE DELE, nunca além
 *    das empresas já vinculadas pela Quantua).
 *  - Aceite do convite: público via magic link de uso único (padrão TeamInvite);
 *    cria o User com tipoUsuario derivado do tipo da organização.
 *
 * Toda mutação emite trilha de auditoria (LGPD: concessão e revogação de
 * acesso a dados de empresa ficam rastreáveis).
 */

const router = Router();

const hashToken = (raw: string): string => crypto.createHash("sha256").update(raw).digest("hex");

/** Caller é gestor da organização? (Quantua passa por requireQuantua nas rotas próprias.) */
async function ehGestor(userId: string, organizacaoId: string): Promise<boolean> {
  const m = await prisma.organizacaoMembro.findFirst({
    where: { organizacaoId, userId, papel: "gestor" },
    select: { id: true },
  });
  return !!m;
}

async function ehQuantua(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, tipoUsuario: true } });
  return !!u && u.role !== "client" && u.tipoUsuario !== "empresa" && u.tipoUsuario !== "parceiro";
}

/** Quantua OU gestor da organização — gate das rotas de membros/convites. */
async function podeGerirMembros(userId: string, organizacaoId: string): Promise<boolean> {
  return (await ehQuantua(userId)) || (await ehGestor(userId, organizacaoId));
}

// ── ACEITE PÚBLICO (antes do requireAuth) ────────────────────────────────────

// GET /organizacoes/convites/:token — preview do convite (tela de aceite).
router.get("/convites/:token", async (req, res): Promise<void> => {
  const convite = await prisma.organizacaoConvite.findUnique({
    where: { tokenHash: hashToken(String(req.params.token)) },
    include: { organizacao: { select: { nome: true, tipo: true, subtipo: true } } },
  });
  if (!convite || convite.status !== "pending") { res.status(404).json({ error: "Convite não encontrado ou já utilizado" }); return; }
  if (convite.expiresAt < new Date()) { res.status(410).json({ error: "Convite expirado — peça um novo" }); return; }
  res.json({
    email: convite.email,
    papel: convite.papel,
    organizacao: convite.organizacao.nome,
    tipo: convite.organizacao.tipo,
    subtipo: convite.organizacao.subtipo,
  });
});

// POST /organizacoes/convites/:token/aceitar — cria o usuário externo e vincula.
router.post("/convites/:token/aceitar", async (req, res): Promise<void> => {
  const { nome, senha } = req.body ?? {};
  if (typeof nome !== "string" || nome.trim().length < 2) { res.status(400).json({ error: "Informe seu nome" }); return; }
  if (typeof senha !== "string" || senha.length < 8) { res.status(400).json({ error: "Senha precisa de ao menos 8 caracteres" }); return; }

  const convite = await prisma.organizacaoConvite.findUnique({
    where: { tokenHash: hashToken(String(req.params.token)) },
    include: { organizacao: { select: { id: true, nome: true, tipo: true } } },
  });
  if (!convite || convite.status !== "pending") { res.status(404).json({ error: "Convite não encontrado ou já utilizado" }); return; }
  if (convite.expiresAt < new Date()) { res.status(410).json({ error: "Convite expirado — peça um novo" }); return; }

  const email = convite.email.toLowerCase();
  const jaExiste = await prisma.user.findUnique({ where: { email }, select: { id: true, tipoUsuario: true } });
  // tipoUsuario derivado do TIPO da organização — nunca escolhido pelo convidado.
  const tipoUsuario = convite.organizacao.tipo === "grupo" ? "empresa" : "parceiro";

  const user = jaExiste
    ? jaExiste
    : await prisma.user.create({
        data: {
          email,
          name: nome.trim().slice(0, 120),
          passwordHash: await bcrypt.hash(senha, 12),
          tipoUsuario,
          role: null,
          emailConfirmedAt: new Date(), // o magic link chegou pelo e-mail convidado
          invitedAt: new Date(),
          // Externo NÃO passa pelo onboarding de workspace (fluxo de firma) —
          // o aceite do convite é o onboarding dele.
          onboardedAt: new Date(),
        },
        select: { id: true, tipoUsuario: true },
      });
  // Usuário existente: só vincula se for do MESMO tipo externo (nunca rebaixa/
  // eleva conta Quantua nem mistura portal) — segurança acima da conveniência.
  if (jaExiste && jaExiste.tipoUsuario !== tipoUsuario) {
    res.status(409).json({ error: "Este e-mail já tem uma conta de outro tipo — fale com a Quantua." });
    return;
  }

  // A DATA DE INÍCIO do acesso do membro = o momento do aceite (primeiro acesso).
  // No re-aceite, preserva a data original (não reinicia a vigência de quem já entrou).
  const agora = new Date();
  await prisma.organizacaoMembro.upsert({
    where: { organizacaoId_userId: { organizacaoId: convite.organizacaoId, userId: user.id } },
    update: { papel: convite.papel },
    create: { organizacaoId: convite.organizacaoId, userId: user.id, papel: convite.papel, dataInicio: agora },
  });
  await prisma.organizacaoConvite.update({
    where: { id: convite.id },
    data: { status: "accepted", acceptedAt: new Date() },
  });
  void registrarAuditoria({
    userId: user.id, entity: "organizacao", entityId: convite.organizacaoId,
    field: "convite aceito", after: { email, papel: convite.papel, tipoUsuario }, source: "organizacoes",
  });
  res.status(201).json({ ok: true, email });
});

// ── DALI EM DIANTE: autenticado ──────────────────────────────────────────────
router.use(requireAuth);

// GET /organizacoes — lista (Quantua: todas · gestor/membro externo: as dele).
router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const quantua = await ehQuantua(req.userId!);
  const orgs = await prisma.organizacao.findMany({
    where: quantua ? {} : { membros: { some: { userId: req.userId! } } },
    include: { _count: { select: { membros: true, empresas: true } } },
    orderBy: { createdAt: "desc" },
  });
  const agora = new Date();
  res.json(orgs.map((o) => ({
    id: o.id, nome: o.nome, tipo: o.tipo, subtipo: o.subtipo, cnpj: o.cnpj,
    status: statusOrganizacao(o, agora),
    dataInicio: o.dataInicio, dataFim: o.dataFim, suspenso: o.suspenso,
    criadaEm: o.createdAt, membros: o._count.membros, empresas: o._count.empresas,
  })));
});

// POST /organizacoes — cria (só Quantua).
router.post("/", requireQuantua, async (req: AuthRequest, res: Response): Promise<void> => {
  const { nome, tipo, subtipo, cnpj } = req.body ?? {};
  if (typeof nome !== "string" || nome.trim().length < 2) { res.status(400).json({ error: "Informe o nome da organização" }); return; }
  if (tipo !== "grupo" && tipo !== "parceiro") { res.status(400).json({ error: 'tipo deve ser "grupo" ou "parceiro"' }); return; }
  const org = await prisma.organizacao.create({
    data: {
      nome: nome.trim().slice(0, 160),
      tipo,
      subtipo: typeof subtipo === "string" && subtipo.trim() ? subtipo.trim().slice(0, 60) : null,
      cnpj: typeof cnpj === "string" && cnpj.trim() ? cnpj.trim().slice(0, 20) : null,
    },
  });
  void registrarAuditoria({
    userId: req.userId!, entity: "organizacao", entityId: org.id, field: "criação",
    after: { nome: org.nome, tipo: org.tipo, subtipo: org.subtipo }, source: "organizacoes",
  });
  res.status(201).json(org);
});

// GET /organizacoes/:id — detalhe (Quantua ou membro da organização).
router.get("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const quantua = await ehQuantua(req.userId!);
  const org = await prisma.organizacao.findFirst({
    where: quantua ? { id } : { id, membros: { some: { userId: req.userId! } } },
    include: {
      membros: { include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: "asc" } },
      empresas: { include: { company: { select: { id: true, razaoSocial: true, nomeFantasia: true, cnpj: true } } }, orderBy: { createdAt: "asc" } },
      convites: { where: { status: "pending" }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!org) { res.status(404).json({ error: "Organização não encontrada" }); return; }
  const souGestor = await ehGestor(req.userId!, id);
  res.json({
    id: org.id, nome: org.nome, tipo: org.tipo, subtipo: org.subtipo, cnpj: org.cnpj,
    status: statusOrganizacao(org, new Date()),
    dataInicio: org.dataInicio, dataFim: org.dataFim, suspenso: org.suspenso,
    // Só a Quantua edita nome/ciclo de vida da organização; gestor gere a equipe.
    podeEditar: quantua,
    podeGerir: quantua || souGestor,
    membros: org.membros.map((m) => ({ userId: m.userId, nome: m.user.name, email: m.user.email, papel: m.papel, desde: m.createdAt, dataInicio: m.dataInicio, dataFim: m.dataFim })),
    empresas: org.empresas.map((e) => ({
      companyId: e.companyId, vinculo: e.vinculo, papelGrupo: e.papelGrupo,
      nome: e.company.nomeFantasia || e.company.razaoSocial, cnpj: e.company.cnpj,
    })),
    convitesPendentes: org.convites.map((c) => ({ id: c.id, email: c.email, papel: c.papel, expiraEm: c.expiresAt })),
  });
});

// PATCH /organizacoes/:id — edita nome e CICLO DE VIDA (só Quantua).
// Status é derivado (dataInicio/dataFim/suspenso); dataFim >= dataInicio.
router.patch("/:id", requireQuantua, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const org = await prisma.organizacao.findUnique({ where: { id } });
  if (!org) { res.status(404).json({ error: "Organização não encontrada" }); return; }
  const { nome, subtipo } = req.body ?? {};
  const dataInicio = parseDataOpcional(req.body?.dataInicio);
  const dataFim = parseDataOpcional(req.body?.dataFim);
  if (req.body?.dataInicio !== undefined && dataInicio === undefined) { res.status(400).json({ error: "Data de início inválida" }); return; }
  if (req.body?.dataFim !== undefined && dataFim === undefined) { res.status(400).json({ error: "Data de fim inválida" }); return; }
  // dataFim >= dataInicio (usando os valores EFETIVOS após a edição).
  const iniEfetivo = dataInicio !== undefined ? dataInicio : org.dataInicio;
  const fimEfetivo = dataFim !== undefined ? dataFim : org.dataFim;
  if (iniEfetivo && fimEfetivo && fimEfetivo.getTime() < iniEfetivo.getTime()) {
    res.status(400).json({ error: "A data de fim não pode ser anterior à data de início." }); return;
  }
  const data: Record<string, unknown> = {};
  if (typeof nome === "string" && nome.trim().length >= 2) data.nome = nome.trim().slice(0, 160);
  if (typeof subtipo === "string") data.subtipo = subtipo.trim() ? subtipo.trim().slice(0, 60) : null;
  if (dataInicio !== undefined) data.dataInicio = dataInicio;
  if (dataFim !== undefined) data.dataFim = dataFim;
  if (typeof req.body?.suspenso === "boolean") data.suspenso = req.body.suspenso;
  if (Object.keys(data).length === 0) { res.status(400).json({ error: "Nada para atualizar" }); return; }

  const atualizado = await prisma.organizacao.update({ where: { id }, data });
  const statusNovo = statusOrganizacao(atualizado, new Date());
  void registrarAuditoria({
    userId: req.userId!, entity: "organizacao", entityId: id, field: "ciclo de vida / cadastro",
    before: { nome: org.nome, status: statusOrganizacao(org, new Date()), dataInicio: org.dataInicio, dataFim: org.dataFim, suspenso: org.suspenso },
    after: { nome: atualizado.nome, status: statusNovo, dataInicio: atualizado.dataInicio, dataFim: atualizado.dataFim, suspenso: atualizado.suspenso },
    source: "organizacoes",
  });
  res.json({ ok: true, status: statusNovo });
});

// DELETE /organizacoes/:id — exclui a organização (só Quantua). O cascade do
// schema remove membros, vínculos de empresa e convites: TODOS os membros
// perdem o acesso imediatamente (as CONTAS continuam existindo, mas sem
// vínculo não enxergam empresa nenhuma — fail-closed). Fica na trilha.
router.delete("/:id", requireQuantua, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const org = await prisma.organizacao.findUnique({
    where: { id },
    include: { _count: { select: { membros: true, empresas: true } } },
  });
  if (!org) { res.status(404).json({ error: "Organização não encontrada" }); return; }
  await prisma.organizacao.delete({ where: { id } });
  void registrarAuditoria({
    userId: req.userId!, entity: "organizacao", entityId: id, field: "organização excluída (todos os acessos revogados)",
    before: { nome: org.nome, tipo: org.tipo, membros: org._count.membros, empresas: org._count.empresas },
    source: "organizacoes",
  });
  res.status(204).send();
});

// POST /organizacoes/:id/empresas — vincula empresa (só Quantua; empresa do escopo).
router.post("/:id/empresas", requireQuantua, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const { companyId, papelGrupo } = req.body ?? {};
  const org = await prisma.organizacao.findUnique({ where: { id } });
  if (!org) { res.status(404).json({ error: "Organização não encontrada" }); return; }
  const company = await prisma.company.findFirst({ where: { id: String(companyId ?? ""), ...whereEmpresaVisivel(req) } });
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  const papel = PAPEIS_GRUPO.includes(String(papelGrupo)) ? String(papelGrupo) : null;
  const vinculo = await prisma.organizacaoEmpresa.upsert({
    where: { organizacaoId_companyId: { organizacaoId: id, companyId: company.id } },
    update: { papelGrupo: papel },
    create: { organizacaoId: id, companyId: company.id, vinculo: org.tipo === "grupo" ? "dona" : "atendida", papelGrupo: papel },
  });
  void registrarAuditoria({
    userId: req.userId!, entity: "organizacao", entityId: id, field: "empresa vinculada",
    after: { companyId: company.id, empresa: company.nomeFantasia || company.razaoSocial, papelGrupo: papel }, source: "organizacoes",
  });
  res.status(201).json(vinculo);
});

// DELETE /organizacoes/:id/empresas/:companyId — desvincula (só Quantua).
router.delete("/:id/empresas/:companyId", requireQuantua, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const companyId = String(req.params.companyId);
  const del = await prisma.organizacaoEmpresa.deleteMany({ where: { organizacaoId: id, companyId } });
  if (del.count === 0) { res.status(404).json({ error: "Vínculo não encontrado" }); return; }
  void registrarAuditoria({
    userId: req.userId!, entity: "organizacao", entityId: id, field: "empresa desvinculada",
    after: { companyId }, source: "organizacoes",
  });
  res.status(204).send();
});

// POST /organizacoes/:id/convites — convida membro (Quantua OU gestor da org).
router.post("/:id/convites", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = String(req.params.id);
  if (!(await podeGerirMembros(req.userId!, id))) { res.status(403).json({ error: "Só a Quantua ou um gestor da organização convida membros" }); return; }
  const { email, papel } = req.body ?? {};
  const emailNorm = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailNorm)) { res.status(400).json({ error: "E-mail inválido" }); return; }
  const papelNorm = papel === "gestor" ? "gestor" : "membro";
  const org = await prisma.organizacao.findUnique({ where: { id } });
  if (!org) { res.status(404).json({ error: "Organização não encontrada" }); return; }
  // Organização CANCELADA não dá acesso — convidar seria inútil/confuso.
  if (statusOrganizacao(org, new Date()) === "cancelado") {
    res.status(409).json({ error: "Organização cancelada (fim do acesso no passado) — reative a vigência antes de convidar." }); return;
  }
  // Exige DATA DE INÍCIO do acesso antes de convidar (a vigência é definida pela
  // Quantua). Sem ela não há período de acesso contratado — nada de onboarding.
  if (!org.dataInicio) {
    res.status(409).json({ error: "Defina a data de início do acesso (vigência) antes de convidar." }); return;
  }

  const pendente = await prisma.organizacaoConvite.findFirst({ where: { organizacaoId: id, email: emailNorm, status: "pending" } });
  if (pendente) { res.status(409).json({ error: "Já existe convite pendente para este e-mail" }); return; }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const expiraEm = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const convite = await prisma.organizacaoConvite.create({
    data: { organizacaoId: id, email: emailNorm, papel: papelNorm, tokenHash: hashToken(rawToken), expiresAt: expiraEm, invitedById: req.userId! },
  });
  await enviarEmailConviteOrg(org, emailNorm, papelNorm, rawToken, expiraEm);
  void registrarAuditoria({
    userId: req.userId!, entity: "organizacao", entityId: id, field: "convite enviado",
    after: { email: emailNorm, papel: papelNorm }, source: "organizacoes",
  });
  // O e-mail vai automático; o link também volta na resposta como FALLBACK
  // (reenviar/copiar), útil se o provedor de e-mail não estiver configurado.
  res.status(201).json({ id: convite.id, email: emailNorm, papel: papelNorm, expiraEm, magicLink: `/convite/organizacao/${rawToken}`, emailEnviado: env.email.provider === "resend" });
});

// POST /organizacoes/:id/convites/:conviteId/reenviar — gera NOVO link (o antigo
// deixa de valer) e reenvia o e-mail. Uso único preservado.
router.post("/:id/convites/:conviteId/reenviar", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = String(req.params.id);
  if (!(await podeGerirMembros(req.userId!, id))) { res.status(403).json({ error: "Sem permissão" }); return; }
  const convite = await prisma.organizacaoConvite.findFirst({ where: { id: String(req.params.conviteId), organizacaoId: id, status: "pending" } });
  if (!convite) { res.status(404).json({ error: "Convite pendente não encontrado" }); return; }
  const org = await prisma.organizacao.findUnique({ where: { id } });
  if (!org) { res.status(404).json({ error: "Organização não encontrada" }); return; }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const expiraEm = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.organizacaoConvite.update({ where: { id: convite.id }, data: { tokenHash: hashToken(rawToken), expiresAt: expiraEm } });
  await enviarEmailConviteOrg(org, convite.email, convite.papel, rawToken, expiraEm);
  void registrarAuditoria({
    userId: req.userId!, entity: "organizacao", entityId: id, field: "convite reenviado",
    after: { email: convite.email }, source: "organizacoes",
  });
  res.json({ ok: true, email: convite.email, expiraEm, magicLink: `/convite/organizacao/${rawToken}`, emailEnviado: env.email.provider === "resend" });
});

// DELETE /organizacoes/:id/convites/:conviteId — revoga convite pendente.
router.delete("/:id/convites/:conviteId", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = String(req.params.id);
  if (!(await podeGerirMembros(req.userId!, id))) { res.status(403).json({ error: "Sem permissão" }); return; }
  const upd = await prisma.organizacaoConvite.updateMany({
    where: { id: String(req.params.conviteId), organizacaoId: id, status: "pending" },
    data: { status: "revoked" },
  });
  if (upd.count === 0) { res.status(404).json({ error: "Convite não encontrado" }); return; }
  void registrarAuditoria({
    userId: req.userId!, entity: "organizacao", entityId: id, field: "convite revogado",
    after: { conviteId: String(req.params.conviteId) }, source: "organizacoes",
  });
  res.status(204).send();
});

// PUT /organizacoes/:id/membros/:userId — muda papel e VIGÊNCIA (Quantua OU gestor).
// dataFim é como se CANCELA o acesso de quem saiu da organização (sem apagar a
// conta nem o histórico). dataFim >= dataInicio.
router.put("/:id/membros/:userId", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = String(req.params.id);
  if (!(await podeGerirMembros(req.userId!, id))) { res.status(403).json({ error: "Sem permissão" }); return; }
  const membro = await prisma.organizacaoMembro.findFirst({ where: { organizacaoId: id, userId: String(req.params.userId) } });
  if (!membro) { res.status(404).json({ error: "Membro não encontrado" }); return; }

  const dataInicio = parseDataOpcional(req.body?.dataInicio);
  const dataFim = parseDataOpcional(req.body?.dataFim);
  if (req.body?.dataInicio !== undefined && dataInicio === undefined) { res.status(400).json({ error: "Data de início inválida" }); return; }
  if (req.body?.dataFim !== undefined && dataFim === undefined) { res.status(400).json({ error: "Data de fim inválida" }); return; }
  const iniEfetivo = dataInicio !== undefined ? dataInicio : membro.dataInicio;
  const fimEfetivo = dataFim !== undefined ? dataFim : membro.dataFim;
  if (iniEfetivo && fimEfetivo && fimEfetivo.getTime() < iniEfetivo.getTime()) {
    res.status(400).json({ error: "A data de fim não pode ser anterior à data de início." }); return;
  }

  const data: Record<string, unknown> = {};
  if (req.body?.papel !== undefined) data.papel = req.body.papel === "gestor" ? "gestor" : "membro";
  if (dataInicio !== undefined) data.dataInicio = dataInicio;
  if (dataFim !== undefined) data.dataFim = dataFim;
  await prisma.organizacaoMembro.update({ where: { id: membro.id }, data });
  void registrarAuditoria({
    userId: req.userId!, entity: "organizacao", entityId: id, field: "membro atualizado (papel/vigência)",
    after: { membro: String(req.params.userId), ...data }, source: "organizacoes",
  });
  res.json({ ok: true });
});

// DELETE /organizacoes/:id/membros/:userId — remove membro (revoga o acesso).
router.delete("/:id/membros/:userId", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const alvo = String(req.params.userId);
  if (!(await podeGerirMembros(req.userId!, id))) { res.status(403).json({ error: "Sem permissão" }); return; }
  // Gestor não remove a si mesmo (evita organização órfã sem querer) — a Quantua pode.
  if (alvo === req.userId && !(await ehQuantua(req.userId!))) {
    res.status(409).json({ error: "Gestor não remove o próprio acesso — peça à Quantua." });
    return;
  }
  const del = await prisma.organizacaoMembro.deleteMany({ where: { organizacaoId: id, userId: alvo } });
  if (del.count === 0) { res.status(404).json({ error: "Membro não encontrado" }); return; }
  void registrarAuditoria({
    userId: req.userId!, entity: "organizacao", entityId: id, field: "membro removido (acesso revogado)",
    after: { membro: alvo }, source: "organizacoes",
  });
  res.status(204).send();
});

export default router;
