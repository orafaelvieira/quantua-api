import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { prisma } from "../db/client";

export interface AuthRequest extends Request {
  userId?: string;
  /**
   * Conjunto de userIds cujos dados o caller pode ver e editar.
   * Inclui todos os membros do mesmo workspace (firma) — visibilidade de firma.
   * Para role "client" e usuários sem workspace é apenas [userId] (isolado).
   * Resolvido em requireAuth; use em `where: { userId: { in: req.scopeUserIds! } }`.
   */
  scopeUserIds?: string[];
  /**
   * SaaS (2026-07-17): lista FECHADA de empresas visíveis para usuário externo
   * (tipoUsuario "empresa"/"parceiro"); null = sem restrição (Quantua).
   */
  scopeCompanyIds?: string[] | null;
  /** Subconjunto de scopeCompanyIds em SOMENTE CONSULTA (organização suspensa). */
  scopeCompanyIdsSomenteLeitura?: string[];
  /** true = toda a visibilidade do externo é somente-leitura (nenhuma org ativa). */
  somenteLeitura?: boolean;
}

/**
 * Resolve os userIds que compartilham dados com `userId`.
 * Membros do mesmo workspace veem/editam os mesmos registros (visibilidade de
 * firma). Clientes e usuários sem workspace ficam isolados em [userId], de modo
 * que a mudança é inócua até os fundadores passarem a dividir um workspace.
 */
export async function resolveScopeUserIds(userId: string): Promise<string[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, workspaceId: true },
  });
  if (!user || user.role === "client" || !user.workspaceId) {
    return [userId];
  }
  const members = await prisma.user.findMany({
    where: { workspaceId: user.workspaceId },
    select: { id: true },
  });
  return members.length ? members.map((m) => m.id) : [userId];
}

/**
 * Bloqueia usuários de PORTAL (role "client"). Use após requireAuth em routers
 * de ativos internos da firma — dicionário de contas, modelos padrão etc.
 * O cliente enxerga só o portal dele; esses ativos são IP da Quantua e, com os
 * parâmetros de contexto (?companyId=), nunca podem vazar entre empresas.
 */
export async function requireInternal(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { role: true } });
  if (user?.role === "client") {
    res.status(403).json({ error: "Acesso restrito à equipe interna" });
    return;
  }
  next();
}

/**
 * F2 SaaS: bloqueia TUDO que não é equipe Quantua — portal (role "client") E
 * usuários externos do SaaS (tipoUsuario "empresa"/"parceiro"). Aplicar nos
 * routers de FIRMA (inbox, billing, team, audit, operations, engagements,
 * indicators): esses dados nunca pertencem a um cliente. Fail-closed por
 * design — o gate independe dos filtros de query de cada rota.
 */
export async function requireQuantua(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { role: true, tipoUsuario: true },
  });
  if (!user || user.role === "client" || user.tipoUsuario === "empresa" || user.tipoUsuario === "parceiro") {
    res.status(403).json({ error: "Acesso restrito à equipe Quantua" });
    return;
  }
  next();
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "Token não fornecido" });
    return;
  }
  let userId: string;
  try {
    const payload = jwt.verify(token, env.jwtSecret) as { userId: string };
    userId = payload.userId;
  } catch {
    res.status(401).json({ error: "Token inválido ou expirado" });
    return;
  }
  req.userId = userId;
  try {
    req.scopeUserIds = await resolveScopeUserIds(userId);
    // Fundação SaaS: escopo por EMPRESA para usuários externos (empresa/parceiro).
    // Import tardio para evitar ciclo (escopo-acesso importa resolveScopeUserIds).
    const { resolverEscopoAcesso } = await import("../services/escopo-acesso");
    const escopo = await resolverEscopoAcesso(userId);
    req.scopeCompanyIds = escopo.scopeCompanyIds;
    req.scopeCompanyIdsSomenteLeitura = escopo.scopeCompanyIdsSomenteLeitura;
    req.somenteLeitura = escopo.somenteLeitura;
    if (escopo.tipoUsuario !== "quantua") req.scopeUserIds = escopo.scopeUserIds;
  } catch {
    res.status(500).json({ error: "Erro ao resolver sessão" });
    return;
  }
  next();
}
