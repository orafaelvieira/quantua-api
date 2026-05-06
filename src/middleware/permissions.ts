import { Response, NextFunction } from "express";
import { prisma } from "../db/client";
import { AuthRequest } from "./auth";

export type UserRole = "operator" | "reviewer" | "partner" | "client";

export interface RoleAuthRequest extends AuthRequest {
  userRole?: UserRole;
}

export function requireRole(...allowed: UserRole[]) {
  return async (req: RoleAuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.userId) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { role: true },
    });
    const role = (user?.role ?? null) as UserRole | null;
    if (!role || !allowed.includes(role)) {
      res.status(403).json({ error: "Acesso negado" });
      return;
    }
    req.userRole = role;
    next();
  };
}

/**
 * Gate para endpoints do portal que exigem que a engagement letter já tenha sido aceita.
 * NÃO aplicar em /client-portal/status — esse precisa funcionar pré-aceite para a UI
 * direcionar o cliente para a tela de aceite.
 */
export async function requireEngagementSigned(
  req: RoleAuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.userId) {
    res.status(401).json({ error: "Não autenticado" });
    return;
  }
  const company = await prisma.company.findFirst({
    where: { userId: req.userId },
    orderBy: { createdAt: "desc" },
    include: {
      analyses: {
        where: { kind: "ibr" },
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { engagement: true },
      },
    },
  });
  const engagement = company?.analyses[0]?.engagement;
  if (!engagement?.letterAcceptedAt) {
    res.status(403).json({ error: "Aceite a carta de engajamento", needsSign: true });
    return;
  }
  next();
}
