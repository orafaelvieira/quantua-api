import { describe, it, expect } from "vitest";
import { montarReceitasDeMemoria } from "./memoria-calculo-receita";
import { calcularModelo } from "./model-engine";
import type { BlocoModelo } from "./model-engine";

/**
 * A planilha do usuário, ao pé da letra:
 *   Receita = ((Volume de Vendas × Ticket Médio) × % da Empresa) × (1 − Impostos)
 * O teste prova as duas pontas: a árvore criada É a fórmula dele, e o MOTOR
 * devolve o mesmo número que o Excel calculou.
 */

// Linha 0: título · linha 1: cabeçalho (A=nome, B..=meses) · 2..5: variáveis · 6: receita
const ABA: unknown[][] = [
  ["Memória de cálculo — Serviços"],
  ["Variável", "jan/26", "fev/26", "mar/26"],
  ["Volume de Vendas", 1000, 1100, 1200],
  ["Ticket Médio", 50, 50, 55],
  ["% da Empresa", 0.8, 0.8, 0.8],
  ["Impostos", 0.0925, 0.0925, 0.0925],
  ["Receita", 36300, 39930, 47916],
];
// Fórmulas: só a linha 6 (Receita) tem — B7 = ((B3*B4)*B5)*(1-B6) em A1 (1-based).
const FORMULAS: Array<Array<string | null>> = [
  [], [], [], [], [], [],
  [null, "((B3*B4)*B5)*(1-B6)", "((C3*C4)*C5)*(1-C6)", "((D3*D4)*D5)*(1-D6)"],
];

describe("montarReceitasDeMemoria", () => {
  it("cria as variáveis do Excel como drivers e a fórmula como nó raiz", () => {
    const r = montarReceitasDeMemoria(ABA, FORMULAS, { anoRef: "2026", idBase: "lin1" });
    expect(r.linhas).toHaveLength(1);
    const linha = r.linhas[0]!;
    expect(linha.nome).toBe("Receita");
    expect(linha.variaveis.sort()).toEqual(["% da Empresa", "Impostos", "Ticket Médio", "Volume de Vendas"]);
    expect(linha.formulaOriginal).toBe("((B3*B4)*B5)*(1-B6)");
    expect(linha.temFatorImposto).toBe(true);

    // A expressão do nó raiz é a MESMA conta, com os ids das variáveis.
    const raiz = linha.nodes.find((n) => n.id === linha.nodeRaiz)!;
    expect(raiz.tipo).toBe("formula");
    expect(raiz.unidade).toBe("R$");
    const expr = String(raiz.params.expr);
    expect(expr).toMatch(/^\( \( \w+ \* \w+ \) \* \w+ \) \* \( 1 - \w+ \)$/);

    // Unidades: quantidade × preço × % fecha em R$ (análise dimensional).
    const porNome = new Map(linha.nodes.map((n) => [n.nome, n]));
    expect(porNome.get("Volume de Vendas")!.unidade).toBe("#");
    expect(porNome.get("Ticket Médio")!.unidade).toBe("R$/un");
    expect(porNome.get("% da Empresa")!.unidade).toBe("%");
    expect(porNome.get("Impostos")!.unidade).toBe("%");
    // Cada variável guarda os MESES da planilha (não uma média).
    expect(porNome.get("Volume de Vendas")!.params.valores).toEqual({ "2026-01": 1000, "2026-02": 1100, "2026-03": 1200 });
  });

  it("o MOTOR reproduz o número do Excel mês a mês", () => {
    const r = montarReceitasDeMemoria(ABA, FORMULAS, { anoRef: "2026", idBase: "lin1" });
    const blocos = [{
      id: "b1", tipo: "receitas", nome: "Receitas", ordem: 0, ativo: true,
      config: { linhasReceita: r.linhas },
    }] as unknown as BlocoModelo[];
    const res = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 3, blocks: blocos });
    const receita = res.dre.find((l) => l.nome === "Receita");
    // 1000 × 50 × 0,8 × (1 − 0,0925) = 36.300
    expect(receita?.valores["2026-01"]).toBeCloseTo(36300, 2);
    expect(receita?.valores["2026-02"]).toBeCloseTo(39930, 2);   // 1100 × 50 × 0,8 × 0,9075
    expect(receita?.valores["2026-03"]).toBeCloseTo(47916, 2);   // 1200 × 55 × 0,8 × 0,9075
  });

  it("imposto em branco na planilha usa a alíquota da EMPRESA", () => {
    const aba = ABA.map((l) => [...l]);
    aba[5] = ["Impostos", null, null, null];               // o analista deixou vazio
    const r = montarReceitasDeMemoria(aba, FORMULAS, { anoRef: "2026", idBase: "lin1", aliquotaImpostos: 0.0925 });
    const no = r.linhas[0]!.nodes.find((n) => n.nome === "Impostos")!;
    expect(no.params.valorMensal).toBeCloseTo(0.0925, 6);
    expect(r.avisos.join(" ")).toMatch(/alíquota da empresa \(9,25%|9.25%\)/);
  });

  it("linha sem fórmula não vira memória de cálculo (segue como valor)", () => {
    const r = montarReceitasDeMemoria(ABA, [[], [], [], [], [], [], []], { anoRef: "2026", idBase: "lin1" });
    expect(r.linhas).toHaveLength(0);
  });

  it("fórmula que não sabemos traduzir avisa e não inventa cálculo", () => {
    const formulas: Array<Array<string | null>> = [
      [], [], [], [], [], [],
      [null, "SUM(B3:B6)", null, null],
    ];
    const r = montarReceitasDeMemoria(ABA, formulas, { anoRef: "2026", idBase: "lin1" });
    expect(r.linhas).toHaveLength(0);
    expect(r.avisos[0]).toMatch(/não consegui reproduzir a fórmula/i);
  });
});
