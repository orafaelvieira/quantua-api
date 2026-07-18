import { describe, it, expect } from "vitest";
import { avaliarContaParticular, grupoImediatoDoCaminho } from "./conta-particular";

const CAMINHO_MUTUO = "Ativo Circulante > ATIVO CIRCULANTE > DIREITOS REALIZAVEIS A CURTO PRAZO > EMPRÉSTIMOS A PESSOAS LIGADAS";

describe("avaliarContaParticular", () => {
  it("nome próprio em grupo de contraparte é particular (caso União Agro)", () => {
    const r = avaliarContaParticular("União Agro", CAMINHO_MUTUO);
    expect(r.particular).toBe(true);
    expect(r.bloqueioDuro).toBe(false);
  });

  it("razão social é particular em qualquer grupo", () => {
    expect(avaliarContaParticular("Transportes Silva LTDA", "Passivo Circulante > FORNECEDORES").particular).toBe(true);
    expect(avaliarContaParticular("Banco Sicredi S.A - C/C 000026920-6", "Ativo Circulante > BANCOS").particular).toBe(true);
    expect(avaliarContaParticular("AGRO COMERCIAL EIRELI", null).particular).toBe(true);
  });

  it("CNPJ/CPF no nome = bloqueio DURO (nunca vai ao global)", () => {
    const cnpj = avaliarContaParticular("Cliente 32.623.554/0001-31", "Clientes");
    expect(cnpj.particular).toBe(true);
    expect(cnpj.bloqueioDuro).toBe(true);
    const cpf = avaliarContaParticular("Mútuo João - 123.456.789-01", CAMINHO_MUTUO);
    expect(cpf.bloqueioDuro).toBe(true);
  });

  it("conta com vocabulário contábil genérico NÃO é particular, mesmo em grupo de contraparte", () => {
    expect(avaliarContaParticular("Clientes no exterior", "Ativo Circulante > CLIENTES").particular).toBe(false);
    expect(avaliarContaParticular("Adiantamento a fornecedores", "Ativo Circulante > DIREITOS").particular).toBe(false);
    expect(avaliarContaParticular("Duplicatas a receber", "Ativo Circulante > CLIENTES").particular).toBe(false);
  });

  it("conta genérica fora de grupo de contraparte não é particular", () => {
    expect(avaliarContaParticular("Energia elétrica", "Custos e Despesas > DESPESAS").particular).toBe(false);
    expect(avaliarContaParticular("Descontos Obtidos", "Receitas > FINANCEIRAS").particular).toBe(false);
    expect(avaliarContaParticular("Stonex", "Ativo Circulante > DISPONIBILIDADES").particular).toBe(false);
  });
});

describe("grupoImediatoDoCaminho", () => {
  it("extrai o último nível do caminho", () => {
    expect(grupoImediatoDoCaminho(CAMINHO_MUTUO)).toBe("EMPRÉSTIMOS A PESSOAS LIGADAS");
  });
  it("caminho raso ou vazio → null", () => {
    expect(grupoImediatoDoCaminho("Ativo Circulante")).toBe(null);
    expect(grupoImediatoDoCaminho(null)).toBe(null);
  });
});
