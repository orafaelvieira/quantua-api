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
  } catch {
    res.status(500).json({ error: "Erro ao resolver sessão" });
    return;
  }
  next();
}
