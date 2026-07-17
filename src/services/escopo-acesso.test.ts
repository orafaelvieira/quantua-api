import { describe, it, expect } from "vitest";
import { montarEscopo } from "./escopo-acesso";

const quantua = { id: "u-interno", tipoUsuario: "quantua", role: "operator" };
const socio = { id: "u-socio", tipoUsuario: "quantua", role: "partner" };
const empresa = { id: "u-cliente", tipoUsuario: "empresa", role: null };
const parceiro = { id: "u-contab", tipoUsuario: "parceiro", role: null };

describe("montarEscopo", () => {
  it("usuário Quantua: sem restrição por empresa (vê o workspace todo)", () => {
    const e = montarEscopo(quantua, ["u-interno", "u-socio"], []);
    expect(e.tipoUsuario).toBe("quantua");
    expect(e.scopeCompanyIds).toBeNull();
    expect(e.scopeUserIds).toEqual(["u-interno", "u-socio"]);
  });

  it("sócio/diretor: mesmo escopo de dados (o nível fino de permissão fica no role)", () => {
    const e = montarEscopo(socio, ["u-interno", "u-socio"], []);
    expect(e.scopeCompanyIds).toBeNull();
  });

  it("usuário EMPRESA: acessa todas as empresas do GRUPO (holding + investidas)", () => {
    const e = montarEscopo(empresa, ["ignorado"], [
      { organizacaoId: "grupo-1", papel: "gestor", companyIds: ["holding", "investida-a", "filial-b"] },
    ]);
    expect(e.tipoUsuario).toBe("empresa");
    expect(e.scopeCompanyIds).toEqual(["holding", "investida-a", "filial-b"]);
    // NUNCA herda o workspace Quantua — dados próprios são só os dele.
    expect(e.scopeUserIds).toEqual(["u-cliente"]);
    expect(e.gestorDe).toEqual(["grupo-1"]);
  });

  it("usuário PARCEIRO (contabilidade): união das empresas atendidas, sem duplicar", () => {
    const e = montarEscopo(parceiro, ["ignorado"], [
      { organizacaoId: "contab-1", papel: "membro", companyIds: ["cliente-x", "cliente-y"] },
      { organizacaoId: "contab-2", papel: "membro", companyIds: ["cliente-y", "cliente-z"] },
    ]);
    expect(e.tipoUsuario).toBe("parceiro");
    expect(e.scopeCompanyIds?.sort()).toEqual(["cliente-x", "cliente-y", "cliente-z"]);
    expect(e.gestorDe).toEqual([]);
  });

  it("externo SEM vínculo: lista FECHADA vazia — não vê empresa nenhuma", () => {
    const e = montarEscopo(empresa, ["ignorado"], []);
    expect(e.scopeCompanyIds).toEqual([]);
    expect(e.scopeCompanyIds).not.toBeNull();
  });
});
