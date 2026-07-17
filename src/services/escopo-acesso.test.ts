import { describe, it, expect } from "vitest";
import { montarEscopo, statusOrganizacao, membroVigente } from "./escopo-acesso";

const quantua = { id: "u-interno", tipoUsuario: "quantua", role: "operator" };
const empresa = { id: "u-cliente", tipoUsuario: "empresa", role: null };
const parceiro = { id: "u-contab", tipoUsuario: "parceiro", role: null };

const AGORA = new Date("2026-07-17T12:00:00Z");
const ONTEM = new Date("2026-07-16T12:00:00Z");
const AMANHA = new Date("2026-07-18T12:00:00Z");

const vinc = (over = {}) => ({
  organizacaoId: "org-1", papel: "membro", status: "ativo" as const, membroVigente: true, companyIds: ["c1", "c2"],
  ...over,
});

describe("statusOrganizacao", () => {
  it("ativo quando sem datas e não suspenso", () => {
    expect(statusOrganizacao({ dataInicio: null, dataFim: null, suspenso: false }, AGORA)).toBe("ativo");
  });
  it("ativo com dataInicio no passado e sem fim", () => {
    expect(statusOrganizacao({ dataInicio: ONTEM, dataFim: null, suspenso: false }, AGORA)).toBe("ativo");
  });
  it("cancelado quando dataFim já passou (precede suspenso)", () => {
    expect(statusOrganizacao({ dataInicio: null, dataFim: ONTEM, suspenso: true }, AGORA)).toBe("cancelado");
  });
  it("agendado quando dataInicio ainda no futuro", () => {
    expect(statusOrganizacao({ dataInicio: AMANHA, dataFim: null, suspenso: false }, AGORA)).toBe("agendado");
  });
  it("suspenso quando marcado e dentro da vigência", () => {
    expect(statusOrganizacao({ dataInicio: ONTEM, dataFim: AMANHA, suspenso: true }, AGORA)).toBe("suspenso");
  });
});

describe("membroVigente", () => {
  it("vigente sem datas", () => expect(membroVigente({ dataInicio: null, dataFim: null }, AGORA)).toBe(true));
  it("não vigente antes do início", () => expect(membroVigente({ dataInicio: AMANHA, dataFim: null }, AGORA)).toBe(false));
  it("não vigente após a saída (dataFim passou)", () => expect(membroVigente({ dataInicio: null, dataFim: ONTEM }, AGORA)).toBe(false));
});

describe("montarEscopo", () => {
  it("Quantua: sem restrição, escrita liberada", () => {
    const e = montarEscopo(quantua, ["u-interno"], []);
    expect(e.scopeCompanyIds).toBeNull();
    expect(e.somenteLeitura).toBe(false);
    expect(e.scopeCompanyIdsSomenteLeitura).toEqual([]);
  });

  it("externo em org ATIVA: leitura e escrita das empresas", () => {
    const e = montarEscopo(empresa, ["x"], [vinc()]);
    expect(e.scopeCompanyIds?.sort()).toEqual(["c1", "c2"]);
    expect(e.scopeCompanyIdsSomenteLeitura).toEqual([]);
    expect(e.somenteLeitura).toBe(false);
    expect(e.scopeUserIds).toEqual(["u-cliente"]);
  });

  it("externo em org SUSPENSA: vê as empresas mas TUDO somente-leitura", () => {
    const e = montarEscopo(empresa, ["x"], [vinc({ status: "suspenso" })]);
    expect(e.scopeCompanyIds?.sort()).toEqual(["c1", "c2"]);
    expect(e.scopeCompanyIdsSomenteLeitura.sort()).toEqual(["c1", "c2"]);
    expect(e.somenteLeitura).toBe(true);
  });

  it("org CANCELADA ou AGENDADA: empresa NÃO entra no escopo", () => {
    expect(montarEscopo(empresa, ["x"], [vinc({ status: "cancelado" })]).scopeCompanyIds).toEqual([]);
    expect(montarEscopo(empresa, ["x"], [vinc({ status: "agendado" })]).scopeCompanyIds).toEqual([]);
  });

  it("membro fora de vigência (saiu): não recebe empresa nenhuma", () => {
    const e = montarEscopo(empresa, ["x"], [vinc({ membroVigente: false })]);
    expect(e.scopeCompanyIds).toEqual([]);
    expect(e.somenteLeitura).toBe(false);
  });

  it("MISTO: empresa de org ativa escreve; de org suspensa fica só-leitura", () => {
    const e = montarEscopo(parceiro, ["x"], [
      vinc({ organizacaoId: "ativa", status: "ativo", companyIds: ["cx"] }),
      vinc({ organizacaoId: "susp", status: "suspenso", companyIds: ["cy"] }),
    ]);
    expect(e.scopeCompanyIds?.sort()).toEqual(["cx", "cy"]);
    expect(e.scopeCompanyIdsSomenteLeitura).toEqual(["cy"]);
    expect(e.somenteLeitura).toBe(false); // tem escrita em cx
  });

  it("empresa compartilhada por org ativa E suspensa: ativa VENCE (escreve)", () => {
    const e = montarEscopo(parceiro, ["x"], [
      vinc({ organizacaoId: "a", status: "ativo", companyIds: ["shared"] }),
      vinc({ organizacaoId: "s", status: "suspenso", companyIds: ["shared"] }),
    ]);
    expect(e.scopeCompanyIds).toEqual(["shared"]);
    expect(e.scopeCompanyIdsSomenteLeitura).toEqual([]); // escrita via org ativa
  });

  it("gestor de org cancelada não conta como gestor", () => {
    const e = montarEscopo(empresa, ["x"], [vinc({ papel: "gestor", status: "cancelado" })]);
    expect(e.gestorDe).toEqual([]);
  });
});
