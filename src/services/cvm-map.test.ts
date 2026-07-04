/**
 * TRAVA DE REGRESSÃO do mapa CVM — a composição AO/PO foi validada ao milhar
 * exato contra a base independente do usuário (04/07/2026: NCG/CDG/Tesouraria
 * de ABEV/PETR/MGLU/TOTS idênticos). Mudou o mapa? Este teste quebra ANTES de
 * qualquer reprocesso de 3-6h em produção.
 */
import { describe, it, expect } from "vitest";
import { CVM_BP_MAP, CVM_BP_CLASSIF, CVM_DRE_MAP } from "./cvm-map";

describe("cvm-map — travas de regressão", () => {
  it("AO = régua da planilha do usuário (6 contas)", () => {
    const ao = Object.entries(CVM_BP_CLASSIF).filter(([, c]) => c === "AO").map(([n]) => n).sort();
    expect(ao).toEqual([
      "Ativos Biológicos - CP",
      "Contas a Receber - CP",
      "Despesas Antecipadas - CP",
      "Estoques - CP",
      "Outros Ativos Circulantes",
      "Tributos a Recuperar - CP",
    ]);
  });

  it("PO = régua da planilha do usuário (3 contas)", () => {
    const po = Object.entries(CVM_BP_CLASSIF).filter(([, c]) => c === "PO").map(([n]) => n).sort();
    expect(po).toEqual([
      "Fornecedores - CP",
      "Obrigações Fiscais - CP",
      "Obrigações Sociais e Trabalhistas - CP",
    ]);
  });

  it("toda conta do BP mapeada tem classificação (sem cair no default silencioso)", () => {
    for (const conta of Object.values(CVM_BP_MAP)) {
      expect(CVM_BP_CLASSIF[conta], `conta sem classificação: ${conta}`).toBeTruthy();
    }
  });

  it("subtotais oficiais da DRE seguem ancorados (LL nunca volta pra cascata)", () => {
    expect(CVM_DRE_MAP["3.03"]).toBe("Lucro Bruto");
    expect(CVM_DRE_MAP["3.05"]).toBe("EBIT");
    expect(CVM_DRE_MAP["3.09"]).toBe("Lucro Líquido");
    expect(CVM_DRE_MAP["3.11"]).toBe("Lucro Líquido");
  });
});
