import { prisma } from "../db/client";
import { resolveScopeUserIds } from "../middleware/auth";

/**
 * ESCOPO DE ACESSO POR TIPO DE USUÁRIO (2026-07-17) — modelo SaaS.
 *
 *   QUANTUA  (tipoUsuario "quantua"; nível fino em role) → vê tudo do workspace:
 *            scopeCompanyIds null = SEM restrição por empresa; escrita liberada.
 *   EMPRESA  (tipoUsuario "empresa") → membro de Organizacao "grupo": acessa
 *            TODAS as empresas do grupo (holding/matriz/investidas/filiais).
 *   PARCEIRO (tipoUsuario "parceiro") → membro de Organizacao "parceiro"
 *            (contabilidade/advocacia/…): acessa as empresas ATENDIDAS.
 *
 * CICLO DE VIDA (segurança): o acesso do externo depende do STATUS da organização
 * e da VIGÊNCIA do membro:
 *   - membro fora de [dataInicio, dataFim]        → não recebe nada (saiu da org);
 *   - org "cancelado" (dataFim passou) ou          → empresa NÃO entra no escopo;
 *     "agendado" (dataInicio no futuro)
 *   - org "suspenso" (inadimplência)               → empresa entra SÓ PARA LEITURA;
 *   - org "ativo"                                  → empresa entra com escrita.
 *
 * Regra de ouro: para externos, scopeCompanyIds é LISTA FECHADA (nunca null);
 * sem vínculo = vazio = não vê nada.
 */

export type StatusOrganizacao = "ativo" | "suspenso" | "cancelado" | "agendado";

export interface EscopoAcesso {
  tipoUsuario: "quantua" | "empresa" | "parceiro";
  scopeUserIds: string[];
  /** null = sem restrição por empresa (Quantua). Lista = empresas visíveis (LEITURA). */
  scopeCompanyIds: string[] | null;
  /** Subconjunto de scopeCompanyIds que está SOMENTE CONSULTA (org suspensa). */
  scopeCompanyIdsSomenteLeitura: string[];
  /** true = TODA a visibilidade do externo é somente-leitura (nenhuma org ativa). */
  somenteLeitura: boolean;
  /** Organizações em que o usuário é "gestor" (pode conceder acessos). */
  gestorDe: string[];
}

interface UsuarioMin {
  id: string;
  tipoUsuario: string;
  role: string | null;
}

export interface OrgVigencia {
  dataInicio: Date | null;
  dataFim: Date | null;
  suspenso: boolean;
}

/** Status DERIVADO da organização (nunca gravado). Ordem de precedência importa. */
export function statusOrganizacao(org: OrgVigencia, agora: Date): StatusOrganizacao {
  if (org.dataFim && org.dataFim.getTime() <= agora.getTime()) return "cancelado";
  if (org.dataInicio && org.dataInicio.getTime() > agora.getTime()) return "agendado";
  if (org.suspenso) return "suspenso";
  return "ativo";
}

/** O membro está com o acesso vigente hoje? (fora da janela = saiu/ainda não entrou) */
export function membroVigente(m: { dataInicio: Date | null; dataFim: Date | null }, agora: Date): boolean {
  if (m.dataInicio && m.dataInicio.getTime() > agora.getTime()) return false;
  if (m.dataFim && m.dataFim.getTime() <= agora.getTime()) return false;
  return true;
}

interface VinculoOrg {
  organizacaoId: string;
  papel: string;
  status: StatusOrganizacao;
  membroVigente: boolean;
  companyIds: string[];
}

/** Núcleo PURO da resolução — testável sem banco. */
export function montarEscopo(user: UsuarioMin, scopeUserIds: string[], vinculos: VinculoOrg[]): EscopoAcesso {
  const externo = user.tipoUsuario === "empresa" || user.tipoUsuario === "parceiro";
  if (!externo) {
    return {
      tipoUsuario: "quantua", scopeUserIds, scopeCompanyIds: null,
      scopeCompanyIdsSomenteLeitura: [], somenteLeitura: false, gestorDe: [],
    };
  }
  const leitura = new Set<string>(); // ativo + suspenso
  const escrita = new Set<string>(); // só ativo
  for (const v of vinculos) {
    // Membro fora de vigência OU org sem acesso (cancelado/agendado) → ignora.
    if (!v.membroVigente) continue;
    if (v.status === "cancelado" || v.status === "agendado") continue;
    for (const c of v.companyIds) {
      leitura.add(c);
      if (v.status === "ativo") escrita.add(c);
    }
  }
  const somenteLeituraCos = [...leitura].filter((c) => !escrita.has(c));
  return {
    tipoUsuario: user.tipoUsuario as "empresa" | "parceiro",
    scopeUserIds: [user.id], // externo nunca herda o workspace Quantua
    scopeCompanyIds: [...leitura],
    scopeCompanyIdsSomenteLeitura: somenteLeituraCos,
    // Só é "tudo somente-leitura" quando há visibilidade mas ZERO empresa com escrita.
    somenteLeitura: leitura.size > 0 && escrita.size === 0,
    gestorDe: vinculos.filter((v) => v.papel === "gestor" && v.membroVigente && v.status !== "cancelado").map((v) => v.organizacaoId),
  };
}

/** Carregador: resolve o escopo completo de um usuário a partir do banco. */
export async function resolverEscopoAcesso(userId: string): Promise<EscopoAcesso> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, tipoUsuario: true, role: true },
  });
  if (!user) {
    return { tipoUsuario: "quantua", scopeUserIds: [userId], scopeCompanyIds: null, scopeCompanyIdsSomenteLeitura: [], somenteLeitura: false, gestorDe: [] };
  }
  if (user.tipoUsuario !== "empresa" && user.tipoUsuario !== "parceiro") {
    return montarEscopo(user, await resolveScopeUserIds(userId), []);
  }

  const agora = new Date();
  const membros = await prisma.organizacaoMembro.findMany({
    where: { userId },
    select: {
      organizacaoId: true,
      papel: true,
      dataInicio: true,
      dataFim: true,
      organizacao: {
        select: {
          dataInicio: true, dataFim: true, suspenso: true,
          empresas: { select: { companyId: true } },
        },
      },
    },
  });
  const vinculos: VinculoOrg[] = membros.map((m) => ({
    organizacaoId: m.organizacaoId,
    papel: m.papel,
    status: statusOrganizacao(m.organizacao, agora),
    membroVigente: membroVigente(m, agora),
    companyIds: m.organizacao.empresas.map((e) => e.companyId),
  }));
  return montarEscopo(user, [userId], vinculos);
}
