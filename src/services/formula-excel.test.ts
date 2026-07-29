import { describe, it, expect } from "vitest";
import { traduzirFormulaExcel, colunaDoRotulo, naturezaDoDriver, ehVariavelDeImposto, type ContextoFormula } from "./formula-excel";

/**
 * O contrato: a fórmula do analista vira a MESMA conta no motor. O que não
 * couber na gramática volta null — a conta entra como série de valores, nunca
 * como um cálculo inventado.
 */

// Planilha do exemplo do usuário (linhas 1-based do Excel):
//   5 Volume de Vendas   E5..
//   6 Ticket Médio       E6..
//   7 % da Empresa       E7..
//   8 Impostos           E8..
//   9 Receita            =E5*E6*E7*(1-E8)
// Colunas: D(3)=jan, E(4)=fev, F(5)=mar; B(1) fica fora da grade (premissa).
function ctxPadrao(): ContextoFormula {
  const constantes = new Map<string, string>();
  return {
    mesDaColuna: new Map([[3, "2026-01"], [4, "2026-02"], [5, "2026-03"]]),
    noDaLinha: new Map([[4, "n_volume"], [5, "n_ticket"], [6, "n_pct"], [7, "n_imposto"]]),
    constanteDe: (l, c) => {
      const k = `${l}:${c}`;
      if (!constantes.has(k)) constantes.set(k, `k_${l}_${c}`);
      return constantes.get(k)!;
    },
  };
}

describe("traduzirFormulaExcel", () => {
  it("replica o cálculo do usuário: volume × ticket × % × (1 − impostos)", () => {
    const r = traduzirFormulaExcel("=E5*E6*E7*(1-E8)", 4, ctxPadrao());
    expect(r?.expr).toBe("n_volume * n_ticket * n_pct * ( 1 - n_imposto )");
    expect(r?.linhasUsadas.sort()).toEqual([4, 5, 6, 7]);
  });

  it("aceita a fórmula com os parênteses do jeito que o analista escreveu", () => {
    const r = traduzirFormulaExcel("((E5*E6)*E7)*(1-E8)", 4, ctxPadrao());
    expect(r?.expr).toBe("( ( n_volume * n_ticket ) * n_pct ) * ( 1 - n_imposto )");
  });

  it("$ absoluto e minúsculas não atrapalham", () => {
    const r = traduzirFormulaExcel("=$E$5*e6", 4, ctxPadrao());
    expect(r?.expr).toBe("n_volume * n_ticket");
  });

  it("percentual literal vira fração", () => {
    const r = traduzirFormulaExcel("=E5*E6*(1-8%)", 4, ctxPadrao());
    expect(r?.expr).toBe("n_volume * n_ticket * ( 1 - 0.08 )");
  });

  it("mês anterior vira anterior(no, n) — é como o motor olha para trás", () => {
    const r = traduzirFormulaExcel("=D5*E6", 4, ctxPadrao());
    expect(r?.expr).toBe("anterior(n_volume, 1) * n_ticket");
  });

  it("célula fixa fora da grade de meses vira PREMISSA (nó constante)", () => {
    const r = traduzirFormulaExcel("=E5*$B$7", 4, ctxPadrao());
    expect(r?.expr).toBe("n_volume * k_6_1");
    expect(r?.constantes).toEqual(["B7"]);
  });

  it("devolve null no que não sabe traduzir — sem inventar cálculo", () => {
    const ctx = ctxPadrao();
    expect(traduzirFormulaExcel("=SUM(E5:E8)", 4, ctx)).toBeNull();       // função
    expect(traduzirFormulaExcel("=Premissas!E5*E6", 4, ctx)).toBeNull();  // outra aba
    expect(traduzirFormulaExcel("=E5^2", 4, ctx)).toBeNull();             // potência
    expect(traduzirFormulaExcel("=E5*(E6", 4, ctx)).toBeNull();           // parêntese aberto
    expect(traduzirFormulaExcel("=E5*", 4, ctx)).toBeNull();              // operador solto
    expect(traduzirFormulaExcel("", 4, ctx)).toBeNull();
  });

  it("referência a mês FUTURO não traduz (o orçamento se lê para frente)", () => {
    expect(traduzirFormulaExcel("=F5*E6", 4, ctxPadrao())).toBeNull();
  });
});

describe("colunaDoRotulo", () => {
  it("converte a letra da coluna", () => {
    expect(colunaDoRotulo("A")).toBe(0);
    expect(colunaDoRotulo("E")).toBe(4);
    expect(colunaDoRotulo("AA")).toBe(26);
  });
});

describe("naturezaDoDriver", () => {
  it("quantidade × preço fecha em R$ (a análise dimensional do motor exige)", () => {
    expect(naturezaDoDriver("Volume de Vendas", [1000, 1200])).toEqual({ tipo: "serie", unidade: "#" });
    expect(naturezaDoDriver("Ticket Médio", [50, 52])).toEqual({ tipo: "preco", unidade: "R$/un" });
  });

  it("% pelo nome OU pelos valores (0,8 é fração, não R$)", () => {
    expect(naturezaDoDriver("% da Empresa", [0.8, 0.8])).toEqual({ tipo: "taxa", unidade: "%" });
    expect(naturezaDoDriver("Participação", [0.35]).unidade).toBe("%");
    expect(naturezaDoDriver("Impostos", [0.0925]).unidade).toBe("%");
  });

  it("o resto é dinheiro", () => {
    expect(naturezaDoDriver("Receita de serviços", [120000]).unidade).toBe("R$");
  });
});

describe("ehVariavelDeImposto", () => {
  it("reconhece a linha de imposto (para puxar a alíquota da empresa)", () => {
    expect(ehVariavelDeImposto("Impostos")).toBe(true);
    expect(ehVariavelDeImposto("% Impostos s/ vendas")).toBe(true);
    expect(ehVariavelDeImposto("Alíquota efetiva")).toBe(true);
    expect(ehVariavelDeImposto("Ticket Médio")).toBe(false);
  });
});
