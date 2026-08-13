import { describe, it, expect } from "vitest";
import { valorMonetarioNoNome, avaliaValorNoNome } from "./valor-no-nome";

describe("valorMonetarioNoNome — o print do dono", () => {
  const sujos = [
    ["RECLAMATORIA TRABALHISTA R$ 20.362,43 R$", "R$ 20.362,43"],
    ["PROVISÃO P/ IRPJ E CSLL R$ 104.261,48 R$", "R$ 104.261,48"],
    ["RECUPERAÇÃO JUDICIAL R$ 2.187.051,35 R$", "R$ 2.187.051,35"],
    ["ADIANTAMENTO DE CLIENTES R$ 220,00 R$", "R$ 220,00"],
    ["Cash and equivalents 1,234,567.89", "1,234,567.89"],
  ];
  for (const [nome, trecho] of sujos) {
    it(`recusa "${nome}"`, () => {
      expect(valorMonetarioNoNome(nome)).toBe(trecho);
      expect(avaliaValorNoNome(nome).bloqueado).toBe(true);
    });
  }

  it("a mesma conta SEM o valor passa — é a chave boa", () => {
    expect(valorMonetarioNoNome("RECUPERAÇÃO JUDICIAL")).toBeNull();
    expect(valorMonetarioNoNome("PROVISÃO P/ IRPJ E CSLL")).toBeNull();
  });
});

/**
 * A régua RECUSA gravação: um falso positivo deixa o analista sem classificar
 * uma conta real e o IBR trava com pendência. Estes casos vieram da revisão
 * adversarial, que derrubou a primeira versão da régua com eles.
 */
describe("valorMonetarioNoNome — o que NUNCA pode ser recusado", () => {
  const legitimos = [
    "PIS 1,65%", "PIS 1,65 %", "PIS 1,65 (NAO CUMULATIVO)", "COFINS 7,60 - NAO CUMULATIVO",
    "ISS 5,00 SOBRE SERVICOS", "INSS 11,00 RETIDO NA FONTE", "CSRF 4,65 RETIDA",
    "IPCA + 6,00% A.A.", "IPCA + 6,00 % A.A.", "SELIC 13,75 % A.A.", "TAXA SELIC 13,75 A.A.",
    "CDB 104,5% CDI", "DEBENTURES CDI + 3,25 A.A.", "PARTICIPACAO 50,00 NA COLIGADA",
    "Imobilizado (Notas 10,11)", "Contas a receber (Notas 5,10)",
    "Property, plant and equipment (Notes 10,11)",
    "LEI 12.973", "PARCELAMENTO LEI 11.941/09", "AGENCIA 0049", "CONTA 12345-6",
    "EMPRESTIMO CAIXA ECON. 1.495.929", "EMPRESTIMOS BB GIRO 856.105.965",
    "13o SALARIO", "ICMS 12%",
    "BALANÇO PATRIMONIAL FINDO EM 31 DE DEZEMBRO DE 2024 -  Em R$ 1",
    "DISPONIBILIDADES (Em R$ 1.000)", "ATIVO CIRCULANTE (R$ 1.000)",
    "CAPITAL SOCIAL 100.000 ACOES VALOR NOMINAL R$ 1,00",
  ];
  for (const nome of legitimos) {
    it(`libera "${nome}"`, () => {
      expect(valorMonetarioNoNome(nome)).toBeNull();
    });
  }
});

describe("valorMonetarioNoNome — o que ficou de fora, de propósito", () => {
  it("decimal solto sem moeda NÃO é acusado: é indistinguível de alíquota", () => {
    // "ADIANTAMENTO 220,00" seria valor, mas "PIS 1,65" tem a mesma forma —
    // 22 de 22 alíquotas reais cairiam. É o preço da certeza.
    expect(valorMonetarioNoNome("ADIANTAMENTO DE CLIENTES 220,00")).toBeNull();
  });

  it("milhar sem centavos NÃO é acusado: são números de contrato do acervo", () => {
    expect(valorMonetarioNoNome("EMPRESTIMO 1.495.929")).toBeNull();
  });
});
