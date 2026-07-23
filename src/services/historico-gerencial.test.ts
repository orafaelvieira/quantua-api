import { describe, it, expect } from "vitest";
import {
  sugerirMapa, montarHistorico, paraHistoricoAnual, ladoProvavel,
  DESTINOS_BP, destinosDRE, todosDestinos,
} from "./historico-gerencial";

const P = ["2024", "2025"];

describe("ladoProvavel — partição DRE × Balanço", () => {
  it("reconhece contas de balanço", () => {
    for (const c of ["Caixa e bancos", "Estoques de mercadorias", "Fornecedores a pagar", "Imobilizado líquido", "Patrimônio Líquido"]) {
      expect(ladoProvavel(c), c).toBe("BP");
    }
  });

  it("reconhece contas de resultado", () => {
    for (const c of ["Receita de vendas", "Custo da mercadoria vendida", "Despesas administrativas", "Lucro líquido do exercício"]) {
      expect(ladoProvavel(c), c).toBe("DRE");
    }
  });

  it("não arrisca quando não há pista", () => {
    expect(ladoProvavel("Total geral")).toBeNull();
    expect(ladoProvavel("")).toBeNull();
  });
});

describe("sugerirMapa", () => {
  it("casa nome idêntico ao padrão da casa", () => {
    const m = sugerirMapa([{ conta: "Receita Bruta", valores: {} }]);
    expect(m[0].sugestao).toBe("dre:Receita Bruta");
    expect(m[0].motivo).toContain("idêntico");
  });

  it("casa ignorando acento, caixa e pontuação", () => {
    const m = sugerirMapa([{ conta: "  RECEITA BRUTA:  ", valores: {} }]);
    expect(m[0].sugestao).toBe("dre:Receita Bruta");
  });

  it("aproxima conta gerencial para a conta de balanço certa", () => {
    const m = sugerirMapa([{ conta: "Estoques de mercadorias", valores: {} }]);
    expect(m[0].sugestao).toBe("bp-estoques");
  });

  it("NUNCA cruza os lados: conta de balanço não vira conta de DRE", () => {
    const m = sugerirMapa([{ conta: "Fornecedores", valores: {} }]);
    expect(m[0].sugestao?.startsWith("bp-")).toBe(true);
  });

  it("deixa null quando não sabe (melhor pedir ao analista que errar)", () => {
    const m = sugerirMapa([{ conta: "Conta 4815162342", valores: {} }]);
    expect(m[0].sugestao).toBeNull();
  });

  it("preserva o índice e o nome original para a tela devolver o mapa", () => {
    const m = sugerirMapa([
      { conta: "Receita Bruta", valores: { "2024": 100 } },
      { conta: "Caixa", valores: { "2024": 50 } },
    ]);
    expect(m.map((x) => x.indice)).toEqual([0, 1]);
    expect(m[1].nomeOriginal).toBe("Caixa");
    expect(m[1].valores).toEqual({ "2024": 50 });
  });
});

/* Cada caso abaixo ERROU numa importação real (planilha gerencial de teste,
 * 22/07/2026) antes do dicionário de sinônimos entrar. São regressões. */
describe("sugerirMapa — vocabulário real de planilha gerencial", () => {
  const casos: Array<[string, string]> = [
    // "bruto" dominava a semelhança e levava faturamento para LUCRO bruto
    ["Faturamento bruto", "dre:Receita Bruta"],
    ["Faturamento", "dre:Receita Bruta"],
    ["Receita de vendas", "dre:Receita Bruta"],
    // "pessoal" caía em Despesas com P&D
    ["Despesas com pessoal", "dre:Despesas com Pessoas"],
    ["Despesa de folha de pagamento", "dre:Despesas com Pessoas"],
    ["Despesas administrativas", "dre:Despesas Gerais e Administrativas"],
    ["Custo da mercadoria vendida", "dre:Custo Operacional"],
    ["CMV", "dre:Custo Operacional"],
    ["Impostos sobre vendas", "dre:Impostos s/ Faturamento"],
    ["Lucro Líquido", "dre:Lucro Líquido"],
    ["Prejuízo líquido do exercício", "dre:Lucro Líquido"],
    ["Lucro Bruto", "dre:Lucro Bruto"],
    ["EBITDA", "dre:EBITDA"],
    // longo prazo ia para o CURTO prazo (o genérico casava primeiro)
    ["Financiamentos de longo prazo", "bp-divida-lp"],
    ["Empréstimos de curto prazo", "bp-divida-cp"],
    ["Empréstimos bancários", "bp-divida-cp"],
    ["Caixa e bancos", "bp-caixa"],
    ["Clientes a receber", "bp-cr"],
    ["Estoques de mercadorias", "bp-estoques"],
    ["Fornecedores", "bp-fornecedores"],
    // acento corrompido no parser fazia esta cair em "sem sugestão"
    ["Patrimônio Líquido", "bp-pl"],
    ["Ativo Total", "bp-ativo"],
    ["Passivo Total", "bp-passivo-pl"],
  ];

  for (const [entrada, esperado] of casos) {
    it(`"${entrada}" → ${esperado}`, () => {
      expect(sugerirMapa([{ conta: entrada, valores: {} }])[0].sugestao).toBe(esperado);
    });
  }
});

describe("montarHistorico", () => {
  const linhas = [
    { conta: "Vendas de produtos", valores: { "2024": 600, "2025": 700 } },
    { conta: "Vendas de serviços", valores: { "2024": 400, "2025": 500 } },
    { conta: "Caixa", valores: { "2024": 50, "2025": 80 } },
  ];

  it("SOMA linhas diferentes que apontam para a mesma conta canônica", () => {
    const r = montarHistorico(linhas, P, { 0: "dre:Receita Bruta", 1: "dre:Receita Bruta", 2: "bp-caixa" });
    expect(r.dre["Receita Bruta"]).toEqual({ "2024": 1000, "2025": 1200 });
    expect(r.bp["bp-caixa"]).toEqual({ "2024": 50, "2025": 80 });
  });

  it("linha sem destino é ignorada e o analista é avisado", () => {
    const r = montarHistorico(linhas, P, { 0: "dre:Receita Bruta", 1: null, 2: null });
    expect(r.dre["Receita Bruta"]).toEqual({ "2024": 600, "2025": 700 });
    expect(r.avisos.some((a) => a.includes("2 linha(s)"))).toBe(true);
  });

  it("acusa Ativo ≠ Passivo + PL (a planilha gerencial não é auditada)", () => {
    const r = montarHistorico(
      [
        { conta: "Ativo Total", valores: { "2024": 1000 } },
        { conta: "Passivo Total", valores: { "2024": 900 } },
      ],
      ["2024"],
      { 0: "bp-ativo", 1: "bp-passivo-pl" },
    );
    expect(r.avisos.some((a) => a.includes("Ativo") && a.includes("2024"))).toBe(true);
  });

  it("tolera arredondamento de centavos sem alarme falso", () => {
    const r = montarHistorico(
      [
        { conta: "Ativo Total", valores: { "2024": 1_000_000 } },
        { conta: "Passivo Total", valores: { "2024": 1_000_000.5 } },
      ],
      ["2024"],
      { 0: "bp-ativo", 1: "bp-passivo-pl" },
    );
    expect(r.avisos.some((a) => a.includes("Ativo"))).toBe(false);
  });
});

describe("paraHistoricoAnual — formato do IBR", () => {
  it("deriva custos e despesas dos subtotais quando a planilha os traz", () => {
    const m = montarHistorico(
      [
        { conta: "Receita Líquida", valores: { "2024": 1000 } },
        { conta: "Lucro Bruto", valores: { "2024": 400 } },
        { conta: "EBITDA", valores: { "2024": 250 } },
      ],
      ["2024"],
      { 0: "dre:Receita Líquida", 1: "dre:Lucro Bruto", 2: "dre:EBITDA" },
    );
    const h = paraHistoricoAnual(m);
    expect(h.linhas.custos["2024"]).toBe(600);   // 1000 − 400
    expect(h.linhas.despesas["2024"]).toBe(150); // 400 − 250
  });

  it("deriva a receita líquida quando só há bruta e deduções", () => {
    const m = montarHistorico(
      [
        { conta: "Receita Bruta", valores: { "2024": 1000 } },
        { conta: "Deduções da Receita Bruta", valores: { "2024": -150 } },
      ],
      ["2024"],
      { 0: "dre:Receita Bruta", 1: "dre:Deduções da Receita Bruta" },
    );
    const h = paraHistoricoAnual(m);
    expect(h.linhas.receita["2024"]).toBe(1000);
    expect(h.linhas.deducoes["2024"]).toBe(150);      // guardada em ABS
    expect(h.linhas.receitaLiquida["2024"]).toBe(850);
  });

  it("linha ausente NÃO vira zero — some do histórico (zero afirmaria um fato)", () => {
    const m = montarHistorico([{ conta: "Receita Bruta", valores: { "2024": 1000 } }], ["2024"], { 0: "dre:Receita Bruta" });
    const h = paraHistoricoAnual(m);
    expect(h.linhas.lucroLiquido).toBeUndefined();
    expect(h.linhas.ebitda).toBeUndefined();
  });

  it("preserva o sinal do resultado (prejuízo continua negativo)", () => {
    const m = montarHistorico([{ conta: "Lucro Líquido", valores: { "2024": -80 } }], ["2024"], { 0: "dre:Lucro Líquido" });
    const h = paraHistoricoAnual(m);
    expect(h.linhas.lucroLiquido["2024"]).toBe(-80);
  });
});

describe("catálogo de destinos", () => {
  it("os ids de balanço são os MESMOS que a rota do IBR usa (é o que faz os gráficos funcionarem)", () => {
    const ids = DESTINOS_BP.map((d) => d.id);
    for (const esperado of ["bp-caixa", "bp-cr", "bp-estoques", "bp-divida-cp", "bp-divida-lp", "bp-ativo", "bp-passivo-pl"]) {
      expect(ids, esperado).toContain(esperado);
    }
  });

  it("não há id repetido entre DRE e Balanço", () => {
    const ids = todosDestinos().map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("os destinos de DRE saem do modelo padrão da casa", () => {
    const nomes = destinosDRE().map((d) => d.nome);
    expect(nomes).toContain("Receita Bruta");
    expect(nomes).toContain("EBITDA");
    expect(nomes).toContain("Lucro Líquido");
  });
});
