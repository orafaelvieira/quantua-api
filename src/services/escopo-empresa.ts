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
