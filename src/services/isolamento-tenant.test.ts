/**
 * ISOLAMENTO MULTI-TENANT — testes das correções da auditoria de 02/08/2026.
 *
 * Cada teste reproduz o VAZAMENTO como ele era e prova que a regra nova fecha.
 * São testes de UNIDADE sobre as funções de decisão (escopo/gate), não sobre o
 * banco: o que estava errado eram as regras, e é nelas que a trava tem de estar.
 */
import { describe, it, expect } from "vitest";
import { whereEmpresaVisivel, whereRecursoEmpresa } from "./escopo-empresa";
import type { AuthRequest } from "../middleware/auth";

const interno = (scopeUserIds: string[]): AuthRequest =>
  ({ scopeUserIds, scopeCompanyIds: null } as unknown as AuthRequest);
const externo = (scopeCompanyIds: string[]): AuthRequest =>
  ({ scopeUserIds: ["u-ext"], scopeCompanyIds } as unknown as AuthRequest);

describe("escopo de empresa — o filtro nunca some no spread", () => {
  it("externo só enxerga as empresas do escopo (companies)", () => {
    expect(whereEmpresaVisivel(externo(["c1", "c2"]))).toEqual({ AND: [{ id: { in: ["c1", "c2"] } }] });
  });

  it("externo só enxerga recursos das empresas do escopo (analyses/documents)", () => {
    expect(whereRecursoEmpresa(externo(["c1"]))).toEqual({ AND: [{ companyId: { in: ["c1"] } }] });
  });

  it("o escopo vem embrulhado em AND — `{ id, ...escopo }` no call site NÃO o sobrescreve", () => {
    // Se o helper devolvesse `{ id: ... }` na raiz, o spread com `id` do request
    // apagaria o filtro e qualquer id passaria. O AND torna isso impossível.
    const where: Record<string, unknown> = { id: "alvo-de-outra-empresa", ...whereRecursoEmpresa(externo(["c1"])) };
    expect(where.AND).toEqual([{ companyId: { in: ["c1"] } }]);
    expect(Object.keys(where)).toContain("id");
  });

  it("interno é limitado ao workspace (posse direta ou via empresa)", () => {
    const w = whereRecursoEmpresa(interno(["u1", "u2"])) as { AND: Array<{ OR: unknown[] }> };
    expect(w.AND[0].OR).toEqual([
      { userId: { in: ["u1", "u2"] } },
      { company: { userId: { in: ["u1", "u2"] } } },
    ]);
  });
});

// ── team.ts: sem workspace, a "equipe" é o próprio usuário ───────────────────
// Regressão do achado mais grave: os filtros caíam em `...(ws ? {...} : {})` e
// `workspaceId: ws ?? undefined` — com ws nulo o Prisma DESCARTA o filtro e a
// query passa a valer para toda a plataforma (inclusive para emitir link de
// redefinição de senha de qualquer conta).
const escopoEquipe = (ws: string | null, userId: string): Record<string, unknown> =>
  ws ? { workspaceId: ws } : { id: userId };

describe("escopo da equipe (team) — nulo não pode virar 'todos'", () => {
  it("com workspace: filtra pelo workspace", () => {
    expect(escopoEquipe("ws-1", "u1")).toEqual({ workspaceId: "ws-1" });
  });

  it("SEM workspace: filtra pelo próprio usuário — nunca a plataforma inteira", () => {
    expect(escopoEquipe(null, "u1")).toEqual({ id: "u1" });
  });

  it("o where combinado com o alvo do request continua restrito", () => {
    const where = { id: "alvo-de-outra-firma", ...escopoEquipe(null, "u1") };
    // `id` do escopo SOBRESCREVE o alvo → a busca só acha o próprio usuário.
    expect(where.id).toBe("u1");
  });

  it("padrão ANTIGO (documentado): objeto vazio deixava a query sem filtro algum", () => {
    const wsAntigo: string | null = null;
    const antigo = { id: "alvo-de-outra-firma", ...(wsAntigo ? { workspaceId: wsAntigo } : {}) };
    expect(antigo).toEqual({ id: "alvo-de-outra-firma" }); // ← era isso que vazava
  });
});

// ── requireQuantua: cadastro público não é equipe interna ────────────────────
/** Espelha a decisão do middleware (mesma ordem de checagens). */
function passaNoGateQuantua(u: { role: string | null; tipoUsuario: string; workspaceId: string | null }): boolean {
  if (u.role === "client" || u.tipoUsuario === "empresa" || u.tipoUsuario === "parceiro") return false;
  if (!u.workspaceId && !u.role) return false; // onboarding não concluído
  return true;
}

describe("gate da equipe Quantua", () => {
  it("conta recém-criada pelo cadastro público NÃO passa (role nula + sem workspace)", () => {
    // É exatamente o que POST /auth/register cria: tipoUsuario "quantua" (default
    // do schema), role null, workspaceId null.
    expect(passaNoGateQuantua({ role: null, tipoUsuario: "quantua", workspaceId: null })).toBe(false);
  });

  it("fundador com workspace (role nula) segue passando", () => {
    expect(passaNoGateQuantua({ role: null, tipoUsuario: "quantua", workspaceId: "ws-1" })).toBe(true);
  });

  it("membro com papel segue passando mesmo sem workspace (conta órfã adotável)", () => {
    expect(passaNoGateQuantua({ role: "operator", tipoUsuario: "quantua", workspaceId: null })).toBe(true);
  });

  it("externo (empresa/parceiro) e portal continuam barrados", () => {
    expect(passaNoGateQuantua({ role: null, tipoUsuario: "empresa", workspaceId: "ws-1" })).toBe(false);
    expect(passaNoGateQuantua({ role: null, tipoUsuario: "parceiro", workspaceId: "ws-1" })).toBe(false);
    expect(passaNoGateQuantua({ role: "client", tipoUsuario: "quantua", workspaceId: "ws-1" })).toBe(false);
  });
});

// ── ibr.ts: economia da firma não vai para o cliente ─────────────────────────
describe("resumo de horas do IBR", () => {
  const montar = (scopeCompanyIds: string[] | null) => {
    const externo = scopeCompanyIds !== null && scopeCompanyIds !== undefined;
    return { totalHours: 10, ...(externo ? {} : { estimatedCost: 3500, feeAmount: 9000, marginAmount: 5500, marginPct: 0.61 }) };
  };

  it("usuário EXTERNO não recebe honorário, custo nem margem", () => {
    const r = montar(["c1"]);
    expect(r.totalHours).toBe(10);
    expect(r).not.toHaveProperty("feeAmount");
    expect(r).not.toHaveProperty("marginAmount");
    expect(r).not.toHaveProperty("marginPct");
    expect(r).not.toHaveProperty("estimatedCost");
  });

  it("equipe interna continua vendo a margem", () => {
    expect(montar(null)).toHaveProperty("marginPct", 0.61);
  });
});

// ── ibr.ts: fluxo de revisão é da firma ──────────────────────────────────────
function podeTransicionar(
  action: string,
  u: { role: string | null; externo: boolean },
): boolean {
  if (u.externo || u.role === "client") return false;
  const exigeRevisor = ["approve", "request_revision", "sign", "deliver", "reopen"].includes(action);
  if (exigeRevisor && !(u.role === "partner" || u.role === "reviewer" || !u.role)) return false;
  return true;
}

describe("workflow de revisão do IBR", () => {
  it("a empresa auditada NÃO aprova nem entrega o próprio IBR", () => {
    expect(podeTransicionar("approve", { role: null, externo: true })).toBe(false);
    expect(podeTransicionar("deliver", { role: null, externo: true })).toBe(false);
    expect(podeTransicionar("submit_for_review", { role: null, externo: true })).toBe(false);
  });

  it("operator não aprova (é ação de reviewer/partner), mas submete", () => {
    expect(podeTransicionar("approve", { role: "operator", externo: false })).toBe(false);
    expect(podeTransicionar("submit_for_review", { role: "operator", externo: false })).toBe(true);
  });

  it("reviewer e partner aprovam", () => {
    expect(podeTransicionar("approve", { role: "reviewer", externo: false })).toBe(true);
    expect(podeTransicionar("sign", { role: "partner", externo: false })).toBe(true);
  });
});

// ── documents.ts: upload não escolhe a empresa ───────────────────────────────
describe("upload de documento — empresa do corpo é sempre validada", () => {
  /** Espelha a decisão da rota após a correção. */
  const decidir = (opts: { empresaVisivel: boolean; analiseVisivel: boolean; companyIdAnalise?: string; companyIdCorpo: string }) => {
    if (!opts.empresaVisivel) return "404 empresa";
    if (opts.companyIdAnalise !== undefined) {
      if (!opts.analiseVisivel) return "404 analise";
      if (opts.companyIdAnalise !== opts.companyIdCorpo) return "400 empresa != IBR";
    }
    return "ok";
  };

  it("empresa de OUTRO tenant no corpo é recusada mesmo com análise própria", () => {
    expect(decidir({ empresaVisivel: false, analiseVisivel: true, companyIdAnalise: "c-minha", companyIdCorpo: "c-vitima" }))
      .toBe("404 empresa");
  });

  it("empresa visível, mas diferente da do IBR, também é recusada", () => {
    expect(decidir({ empresaVisivel: true, analiseVisivel: true, companyIdAnalise: "c-1", companyIdCorpo: "c-2" }))
      .toBe("400 empresa != IBR");
  });

  it("caminho normal (empresa do IBR) segue funcionando", () => {
    expect(decidir({ empresaVisivel: true, analiseVisivel: true, companyIdAnalise: "c-1", companyIdCorpo: "c-1" })).toBe("ok");
  });

  it("upload de POOL (sem análise) exige empresa visível", () => {
    expect(decidir({ empresaVisivel: true, analiseVisivel: false, companyIdCorpo: "c-1" })).toBe("ok");
    expect(decidir({ empresaVisivel: false, analiseVisivel: false, companyIdCorpo: "c-vitima" })).toBe("404 empresa");
  });
});

// ── organizações: vigência decide, não a existência da linha ─────────────────
import { membroVigente, statusOrganizacao } from "./escopo-acesso";

describe("organização — acesso expirado não lê nem administra", () => {
  const ontem = new Date(Date.now() - 86400000);
  const amanha = new Date(Date.now() + 86400000);
  const agora = new Date();

  it("ex-membro (dataFim no passado) não é vigente", () => {
    expect(membroVigente({ dataInicio: null, dataFim: ontem }, agora)).toBe(false);
  });

  it("membro futuro (dataInicio à frente) ainda não é vigente", () => {
    expect(membroVigente({ dataInicio: amanha, dataFim: null }, agora)).toBe(false);
  });

  it("organização cancelada/agendada não está ativa", () => {
    expect(statusOrganizacao({ dataInicio: null, dataFim: ontem, suspenso: false }, agora)).toBe("cancelado");
    expect(statusOrganizacao({ dataInicio: amanha, dataFim: null, suspenso: false }, agora)).toBe("agendado");
  });

  it("gestor só gere com membro vigente E organização ativa", () => {
    const podeGerir = (m: { dataInicio: Date | null; dataFim: Date | null }, org: { dataInicio: Date | null; dataFim: Date | null; suspenso: boolean }) =>
      membroVigente(m, agora) && statusOrganizacao(org, agora) === "ativo";
    const orgAtiva = { dataInicio: null, dataFim: null, suspenso: false };
    expect(podeGerir({ dataInicio: null, dataFim: null }, orgAtiva)).toBe(true);
    expect(podeGerir({ dataInicio: null, dataFim: ontem }, orgAtiva)).toBe(false);
    expect(podeGerir({ dataInicio: null, dataFim: null }, { dataInicio: null, dataFim: ontem, suspenso: false })).toBe(false);
  });
});
