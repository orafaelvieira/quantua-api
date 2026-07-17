import type { Response, NextFunction } from "express";
import { prisma } from "../db/client";
import type { AuthRequest } from "../middleware/auth";

/**
 * F2 DOS ACESSOS SAAS (2026-07-17) — fragmentos de `where` que decidem QUAIS
 * EMPRESAS o caller enxerga. Segurança/LGPD acima de tudo:
 *
 *  - Usuário QUANTUA (scopeCompanyIds null): dados do workspace — o registro é
 *    do dono OU de empresa do workspace. O ramo `company.userId` cobre o caso
 *    INVERSO do SaaS: IBR/documento criado pelo cliente externo numa empresa da
 *    firma continua visível para a equipe (supervisão).
 *  - Usuário EXTERNO (empresa/parceiro): ALLOWLIST FECHADA — só registros de
 *    empresas explicitamente vinculadas à organização dele (scopeCompanyIds).
 *    Lista vazia = nada. Nunca por posse (userId), nunca por herança.
 *
 * Use SEMPRE estes fragmentos em queries de dado de empresa — nunca monte o
 * filtro à mão (um esquecimento = vazamento entre clientes).
 */

/**
 * Tabela Company: `{ id, ...whereEmpresaVisivel(req) }`.
 * SEMPRE embrulhado em `AND` — à prova de spread: os call sites espalham o
 * fragmento junto de chaves como `id`/`companyId`, e uma chave repetida no
 * spread SOBRESCREVERIA o filtro (o E2E de isolamento flagrou exatamente isso:
 * `{ id, ...{ id: { in: allowlist } } }` validava a empresa errada).
 */
export function whereEmpresaVisivel(req: AuthRequest): Record<string, unknown> {
  if (!req.scopeCompanyIds) return { AND: [{ userId: { in: req.scopeUserIds! } }] };
  return { AND: [{ id: { in: req.scopeCompanyIds } }] };
}

/** Tabelas com companyId + relação company (Analysis, Document): spread no where.
 *  Também embrulhado em `AND` — nunca colide com `companyId`/`OR` do call site. */
export function whereRecursoEmpresa(req: AuthRequest): Record<string, unknown> {
  if (!req.scopeCompanyIds) {
    return {
      AND: [{
        OR: [
          { userId: { in: req.scopeUserIds! } },
          { company: { userId: { in: req.scopeUserIds! } } },
        ],
      }],
    };
  }
  return { AND: [{ companyId: { in: req.scopeCompanyIds } }] };
}

/** Checagem pontual: a empresa `companyId` está visível para o caller? */
export async function empresaVisivel(req: AuthRequest, companyId: string): Promise<boolean> {
  if (req.scopeCompanyIds) return req.scopeCompanyIds.includes(companyId);
  const c = await prisma.company.findFirst({
    where: { id: companyId, userId: { in: req.scopeUserIds! } },
    select: { id: true },
  });
  return !!c;
}

// ── SOMENTE CONSULTA (organização SUSPENSA) — enforcement de segurança ────────
// Externo cuja organização está "suspenso" (inadimplência) LÊ mas não ESCREVE.
// O guard roda nos routers de dado de empresa; Quantua e externos de org ATIVA
// não são afetados. Fail-closed: usuário com empresa suspensa em rota de
// mutação cujo alvo não é resolvível → bloqueia.

const MSG_SOMENTE_CONSULTA =
  "Acesso somente consulta: a organização está suspensa. Regularize com a Quantua para voltar a editar.";
const METODO_SEGURO = new Set(["GET", "HEAD", "OPTIONS"]);

/** Resolve a empresa-alvo de uma requisição de mutação, por tipo de entidade da rota. */
async function resolverEmpresaAlvo(req: AuthRequest, entidade: "analysis" | "model" | "document" | "company-body"): Promise<string | null> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.companyId === "string" && body.companyId) return body.companyId;
  if (typeof req.query.companyId === "string" && req.query.companyId) return req.query.companyId;

  const idParam = typeof req.params.id === "string" ? req.params.id : null;
  const analysisIdBody = typeof body.analysisId === "string" ? body.analysisId : null;

  if (entidade === "analysis" && idParam) {
    const a = await prisma.analysis.findUnique({ where: { id: idParam }, select: { companyId: true } });
    return a?.companyId ?? null;
  }
  if (entidade === "model" && idParam) {
    const m = await prisma.financialModel.findUnique({ where: { id: idParam }, select: { companyId: true } });
    return m?.companyId ?? null;
  }
  if (entidade === "document") {
    if (idParam) {
      const d = await prisma.document.findUnique({ where: { id: idParam }, select: { companyId: true } });
      if (d?.companyId) return d.companyId;
    }
    if (analysisIdBody) {
      const a = await prisma.analysis.findUnique({ where: { id: analysisIdBody }, select: { companyId: true } });
      return a?.companyId ?? null;
    }
  }
  if (analysisIdBody) {
    const a = await prisma.analysis.findUnique({ where: { id: analysisIdBody }, select: { companyId: true } });
    return a?.companyId ?? null;
  }
  return null;
}

/** Middleware: bloqueia MUTAÇÃO quando a empresa-alvo está somente-consulta. */
export function guardaEscritaSuspensao(entidade: "analysis" | "model" | "document" | "company-body") {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (METODO_SEGURO.has(req.method.toUpperCase())) { next(); return; }
    if (!req.scopeCompanyIds) { next(); return; } // Quantua — sem restrição
    if (req.somenteLeitura) { res.status(403).json({ error: MSG_SOMENTE_CONSULTA }); return; } // tudo read-only
    const readOnly = req.scopeCompanyIdsSomenteLeitura ?? [];
    if (readOnly.length === 0) { next(); return; } // nenhuma org suspensa
    const alvo = await resolverEmpresaAlvo(req, entidade);
    // fail-closed: alvo não resolvível ou explicitamente suspenso → bloqueia.
    if (!alvo || readOnly.includes(alvo)) { res.status(403).json({ error: MSG_SOMENTE_CONSULTA }); return; }
    next();
  };
}
