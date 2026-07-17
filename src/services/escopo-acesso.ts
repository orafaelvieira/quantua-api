import { prisma } from "../db/client";
import { resolveScopeUserIds } from "../middleware/auth";

/**
 * ESCOPO DE ACESSO POR TIPO DE USUÁRIO (2026-07-17) — fundação do modelo SaaS.
 *
 *   QUANTUA  (tipoUsuario "quantua"; nível fino em role: operator/reviewer/
 *            partner) → vê tudo do workspace (como sempre): scopeCompanyIds
 *            null = SEM restrição por empresa.
 *   EMPRESA  (tipoUsuario "empresa") → membro de Organizacao tipo "grupo":
 *            acessa TODAS as empresas do grupo (holding + investidas/filiais).
 *   PARCEIRO (tipoUsuario "parceiro") → membro de Organizacao tipo "parceiro"
 *            (contabilidade/advocacia/…): acessa as empresas ATENDIDAS.
 *
 * Regra de ouro: para usuários externos, scopeCompanyIds é a LISTA FECHADA das
 * empresas visíveis — nunca null. Sem vínculo = lista vazia = não vê nada.
 * O portal legado (role "client") continua fora deste caminho.
 */

export interface EscopoAcesso {
  tipoUsuario: "quantua" | "empresa" | "parceiro";
  /** Donos de dados visíveis (equipe interna) — usado pelas queries atuais. */
  scopeUserIds: string[];
  /** null = sem restrição por empresa (Quantua). Lista = SÓ estas empresas. */
  scopeCompanyIds: string[] | null;
  /** Alguma organização em que o usuário é "gestor" (pode conceder acessos). */
  gestorDe: string[];
}

interface UsuarioMin {
  id: string;
  tipoUsuario: string;
  role: string | null;
}

interface VinculoOrg {
  organizacaoId: string;
  papel: string;
  companyIds: string[];
}

/** Núcleo PURO da resolução — testável sem banco. */
export function montarEscopo(user: UsuarioMin, scopeUserIds: string[], vinculos: VinculoOrg[]): EscopoAcesso {
  const externo = user.tipoUsuario === "empresa" || user.tipoUsuario === "parceiro";
  if (!externo) {
    return { tipoUsuario: "quantua", scopeUserIds, scopeCompanyIds: null, gestorDe: [] };
  }
  const companyIds = [...new Set(vinculos.flatMap((v) => v.companyIds))];
  return {
    tipoUsuario: user.tipoUsuario as "empresa" | "parceiro",
    // Externo: dados "próprios" são só os dele — nunca herda o workspace Quantua.
    scopeUserIds: [user.id],
    scopeCompanyIds: companyIds,
    gestorDe: vinculos.filter((v) => v.papel === "gestor").map((v) => v.organizacaoId),
  };
}

/** Carregador: resolve o escopo completo de um usuário a partir do banco. */
export async function resolverEscopoAcesso(userId: string): Promise<EscopoAcesso> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, tipoUsuario: true, role: true },
  });
  if (!user) return { tipoUsuario: "quantua", scopeUserIds: [userId], scopeCompanyIds: null, gestorDe: [] };

  if (user.tipoUsuario !== "empresa" && user.tipoUsuario !== "parceiro") {
    return montarEscopo(user, await resolveScopeUserIds(userId), []);
  }

  const membros = await prisma.organizacaoMembro.findMany({
    where: { userId },
    select: {
      organizacaoId: true,
      papel: true,
      organizacao: { select: { empresas: { select: { companyId: true } } } },
    },
  });
  const vinculos: VinculoOrg[] = membros.map((m) => ({
    organizacaoId: m.organizacaoId,
    papel: m.papel,
    companyIds: m.organizacao.empresas.map((e) => e.companyId),
  }));
  return montarEscopo(user, [userId], vinculos);
}
