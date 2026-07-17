import { describe, it, expect } from "vitest";
import { whereEmpresaVisivel, whereRecursoEmpresa } from "./escopo-empresa";
import type { AuthRequest } from "../middleware/auth";

const quantua = { scopeUserIds: ["u1", "u2"], scopeCompanyIds: null } as unknown as AuthRequest;
const externo = { scopeUserIds: ["ext"], scopeCompanyIds: ["c1", "c2"] } as unknown as AuthRequest;
const externoSemVinculo = { scopeUserIds: ["ext"], scopeCompanyIds: [] } as unknown as AuthRequest;

describe("whereEmpresaVisivel", () => {
  it("Quantua: por posse do workspace", () => {
    expect(whereEmpresaVisivel(quantua)).toEqual({ AND: [{ userId: { in: ["u1", "u2"] } }] });
  });
  it("externo: allowlist fechada", () => {
    expect(whereEmpresaVisivel(externo)).toEqual({ AND: [{ id: { in: ["c1", "c2"] } }] });
  });
  it("externo sem vínculo: lista vazia (não vê nada) — nunca cai no ramo Quantua", () => {
    expect(whereEmpresaVisivel(externoSemVinculo)).toEqual({ AND: [{ id: { in: [] } }] });
  });
  it("À PROVA DE SPREAD: `{ id, ...frag }` preserva o id pedido (bug flagrado no E2E)", () => {
    const where: Record<string, unknown> = { id: "empresa-pedida", ...whereEmpresaVisivel(externo) };
    // o id literal NÃO pode ser sobrescrito pelo filtro da allowlist
    expect(where.id).toBe("empresa-pedida");
    expect(where.AND).toEqual([{ id: { in: ["c1", "c2"] } }]);
  });
});

describe("whereRecursoEmpresa", () => {
  it("Quantua: dono OU empresa do workspace (cobre registro criado pelo cliente)", () => {
    expect(whereRecursoEmpresa(quantua)).toEqual({
      AND: [{ OR: [{ userId: { in: ["u1", "u2"] } }, { company: { userId: { in: ["u1", "u2"] } } }] }],
    });
  });
  it("externo: só empresas da allowlist", () => {
    expect(whereRecursoEmpresa(externo)).toEqual({ AND: [{ companyId: { in: ["c1", "c2"] } }] });
  });
  it("À PROVA DE SPREAD: `{ companyId, ...frag }` não é sobrescrito", () => {
    const where: Record<string, unknown> = { companyId: "outra", ...whereRecursoEmpresa(externo) };
    expect(where.companyId).toBe("outra"); // ambos valem (AND) — allowlist continua mandando
  });
});
