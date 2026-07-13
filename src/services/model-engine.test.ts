import { describe, it, expect } from "vitest";
import { calcularModelo, mesAdd, backfillPremissasAoRecuar, BlocoModelo, ModeloInput } from "./model-engine";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** SaaS: base de clientes (corkscrew + novos − churn) × ARPU. */
function blocoSaas(): BlocoModelo {
  return {
    id: "b1",
    tipo: "receitas",
    nome: "Receitas",
    ativo: true,
    config: {
      linhasReceita: [
        {
          id: "lin-saas",
          nome: "Assinaturas",
          template: "saas",
          nodeRaiz: "receita",
          nodes: [
            { id: "novos", tipo: "serie", nome: "Novos clientes", unidade: "#", papel: "novos", params: { valorMensal: 10 } },
            { id: "churnRate", tipo: "taxa", nome: "Churn mensal", unidade: "%", papel: "churnRate", params: { valorMensal: 0.02 } },
            { id: "cancelados", tipo: "fluxo", nome: "Cancelamentos", unidade: "#", params: { expr: "clientes * churnRate" } },
            { id: "clientes", tipo: "estoque", nome: "Base de clientes", unidade: "#", papel: "baseClientes", params: { saldoInicial: 100, entradasRef: "novos", saidasRef: "cancelados" } },
            { id: "arpu", tipo: "preco", nome: "Ticket médio mensal", unidade: "R$/un", papel: "arpu", params: { valorMensal: 200 } },
            { id: "receita", tipo: "formula", nome: "Receita de assinaturas", unidade: "R$", params: { expr: "clientes * arpu" } },
          ],
        },
      ],
    },
  };
}

/** Transacional (modelo Quantua de Valuation): TPV × take rate. */
function blocoTransacional(): BlocoModelo {
  return {
    id: "b1",
    tipo: "receitas",
    nome: "Receitas",
    ativo: true,
    config: {
      linhasReceita: [
        {
          id: "lin-cambio",
          nome: "Rendas de câmbio",
          template: "transacional",
          nodeRaiz: "receita",
          nodes: [
            // TPV mensal médio da planilha de referência (2025): 6.666.479,30 / 0,00465 / 12 ≈ 119.470.000
            { id: "tpv", tipo: "serie", nome: "Volume transacionado (TPV)", unidade: "R$", papel: "tpv", params: { valorMensal: 119_470_000, crescimentoAnual: 0.4 } },
            { id: "take", tipo: "taxa", nome: "Take rate", unidade: "%", papel: "takeRate", params: { valorMensal: 0.00465 } },
            { id: "receita", tipo: "formula", nome: "Receita de câmbio", unidade: "R$", params: { expr: "tpv * take" } },
          ],
        },
      ],
    },
  };
}

function blocoCustosSimples(): BlocoModelo {
  return {
    id: "b3",
    tipo: "custos",
    nome: "Custos",
    ativo: true,
    config: {
      linhasCusto: [
        { id: "cmv", nome: "Custos variáveis", modo: "pctReceita", pct: 0.3 },
        { id: "aluguel", nome: "Aluguel", modo: "fixoReajuste", valorMensal: 10_000, reajusteAnual: 0.05 },
      ],
    },
  };
}

function blocoReceitaSerie(params: Record<string, unknown>): BlocoModelo {
  return {
    id: "b1", tipo: "receitas", nome: "Receitas", ativo: true,
    config: {
      linhasReceita: [{
        id: "vendas", nome: "Vendas", nodeRaiz: "v_receita",
        nodes: [{ id: "v_receita", tipo: "serie", nome: "Receita — Vendas", unidade: "R$", params }],
      }],
    },
  };
}

function inputDe(blocks: BlocoModelo[], extra?: Partial<ModeloInput>): ModeloInput {
  return { mesInicial: "2026-01", horizonteMeses: 24, blocks, ...extra };
}

// ── mesAdd ──────────────────────────────────────────────────────────────────

describe("mesAdd", () => {
  it("soma meses com virada de ano", () => {
    expect(mesAdd("2026-01", 0)).toBe("2026-01");
    expect(mesAdd("2026-01", 11)).toBe("2026-12");
    expect(mesAdd("2026-01", 12)).toBe("2027-01");
    expect(mesAdd("2026-11", 3)).toBe("2027-02");
  });
});

// ── SaaS: corkscrew + KPIs ──────────────────────────────────────────────────

describe("fixture SaaS (base × ARPU com churn)", () => {
  it("roda o corkscrew mês a mês (saldo M-1 + novos − churn)", () => {
    const r = calcularModelo(inputDe([blocoSaas()]));
    // Mês 1: cancelados = 100 × 2% = 2; clientes = 100 + 10 − 2 = 108
    expect(r.series["cancelados"]["2026-01"]).toBeCloseTo(2, 6);
    expect(r.series["clientes"]["2026-01"]).toBeCloseTo(108, 6);
    // Mês 2: cancelados = 108 × 2% = 2,16; clientes = 108 + 10 − 2,16 = 115,84 → 116
    // (base de clientes é INTEIRA: o saldo arredonda a cada mês)
    expect(r.series["clientes"]["2026-02"]).toBe(116);
    // Receita mês 1 = 108 × 200 = 21.600
    expect(r.series["receita"]["2026-01"]).toBeCloseTo(21_600, 2);
    expect(r.erros).toEqual([]);
  });

  it("deriva KPIs quando os papéis existem (base, MRR, churn)", () => {
    const r = calcularModelo(inputDe([blocoSaas()]));
    const ids = r.kpis.map((k) => k.id);
    expect(ids).toContain("base-clientes");
    expect(ids).toContain("mrr");
    expect(ids).toContain("churn");
    const mrr = r.kpis.find((k) => k.id === "mrr")!;
    expect(mrr.valores["2026-01"]).toBeCloseTo(21_600, 2);
  });

  it("cenário: override no churn muda a trajetória", () => {
    const base = calcularModelo(inputDe([blocoSaas()]));
    const pessimista = calcularModelo(inputDe([blocoSaas()], { overrides: { churnRate: { valorMensal: 0.08 } } }));
    expect(pessimista.series["clientes"]["2026-12"]).toBeLessThan(base.series["clientes"]["2026-12"]);
  });

  it("serieManual sobrepõe o cálculo no mês editado", () => {
    const bloco = blocoSaas();
    bloco.config.linhasReceita![0].nodes.find((n) => n.id === "novos")!.serieManual = { "2026-03": 50 };
    const r = calcularModelo(inputDe([bloco]));
    expect(r.series["novos"]["2026-03"]).toBe(50);
    expect(r.series["novos"]["2026-04"]).toBe(10);
  });
});

// ── Transacional: fórmula, crescimento e agregação ──────────────────────────

describe("fixture transacional (TPV × take rate — modelo Quantua de Valuation)", () => {
  it("receita mês 1 = TPV × take rate", () => {
    const r = calcularModelo(inputDe([blocoTransacional()]));
    expect(r.series["receita"]["2026-01"]).toBeCloseTo(119_470_000 * 0.00465, 2);
  });

  it("agregação anual = soma dos 12 meses", () => {
    const r = calcularModelo(inputDe([blocoTransacional()]));
    const soma2026 = r.meses.filter((m) => m.startsWith("2026")).reduce((s, m) => s + r.dre.find((l) => l.id === "receita-total")!.valores[m], 0);
    expect(r.agregacoes.anual["receita-total"]["2026"]).toBeCloseTo(soma2026, 2);
    // Crescimento composto: mês 13 = base × 1,4
    expect(r.series["tpv"]["2027-01"]).toBeCloseTo(119_470_000 * 1.4, 0);
  });

  it("DRE com custos: % receita e fixo com reajuste anual", () => {
    const r = calcularModelo(inputDe([blocoTransacional(), blocoCustosSimples()]));
    const receita1 = r.dre.find((l) => l.id === "receita-total")!.valores["2026-01"];
    expect(r.dre.find((l) => l.id === "cmv")!.valores["2026-01"]).toBeCloseTo(receita1 * 0.3, 2);
    expect(r.dre.find((l) => l.id === "aluguel")!.valores["2026-01"]).toBe(10_000);
    expect(r.dre.find((l) => l.id === "aluguel")!.valores["2027-01"]).toBeCloseTo(10_500, 2);
    const lucroBruto = r.dre.find((l) => l.id === "lucro-bruto")!;
    expect(lucroBruto.valores["2026-01"]).toBeCloseTo(receita1 - receita1 * 0.3 - 10_000, 2);
  });
});

// ── Preenchimento por ano e por mês (agilidade estilo Excel) ────────────────

describe("modos de preenchimento de série (simples | ano | mês)", () => {
  it("por ANO em [R$]: o número é o TOTAL do ano, espalhado nos 12 meses", () => {
    const r = calcularModelo(inputDe([blocoReceitaSerie({ modoPreenchimento: "ano", valoresAno: { "2026": 1_200_000, "2027": 2_400_000 } })]));
    expect(r.series["v_receita"]["2026-03"]).toBeCloseTo(100_000, 2);
    expect(r.series["v_receita"]["2027-03"]).toBeCloseTo(200_000, 2);
    expect(r.agregacoes.anual["receita-total"]["2026"]).toBeCloseTo(1_200_000, 2);
  });

  it("por ANO em [R$] com ANO PARCIAL: divide pelos meses do ano no horizonte", () => {
    // Horizonte começa em julho: 2026 tem 6 meses. Total do ano informado (15.000)
    // deve virar 2.500/mês — e a DRE anual de 2026 deve mostrar os 15.000 EXATOS.
    const r = calcularModelo({
      mesInicial: "2026-07",
      horizonteMeses: 18,
      blocks: [blocoReceitaSerie({ modoPreenchimento: "ano", valoresAno: { "2026": 15_000, "2027": 24_000 } })],
    });
    expect(r.series["v_receita"]["2026-07"]).toBeCloseTo(2_500, 2);
    expect(r.agregacoes.anual["receita-total"]["2026"]).toBeCloseTo(15_000, 2);
    expect(r.series["v_receita"]["2027-03"]).toBeCloseTo(2_000, 2);
    expect(r.agregacoes.anual["receita-total"]["2027"]).toBeCloseTo(24_000, 2);
  });

  it("por ANO: ano vazio CONTINUA o último informado pela taxa mensal (não cai no Simples)", () => {
    // 2026 parcial (6m) = 10.000 → taxa 1.666,67/mês. 2027 vazio → 20.000 (ano cheio).
    // O Simples do driver (50.000/mês) NÃO pode vazar para os anos vazios.
    const r = calcularModelo({
      mesInicial: "2026-07",
      horizonteMeses: 18,
      blocks: [blocoReceitaSerie({ modoPreenchimento: "ano", valorMensal: 50_000, crescimentoAnual: 0.1, valoresAno: { "2026": 10_000 } })],
    });
    expect(r.agregacoes.anual["receita-total"]["2026"]).toBeCloseTo(10_000, 2);
    expect(r.agregacoes.anual["receita-total"]["2027"]).toBeCloseTo(20_000, 2);
    expect(r.series["v_receita"]["2027-05"]).toBeCloseTo(10_000 / 6, 2);
  });

  it("por ANO crescimento em ANO PARCIAL: o % aplica sobre a taxa MENSAL", () => {
    // 2026 (6m) = 10.000 (1.666,67/mês); 2027 +15% → 1.916,67/mês × 12 = 23.000.
    const r = calcularModelo({
      mesInicial: "2026-07",
      horizonteMeses: 18,
      blocks: [blocoReceitaSerie({
        modoPreenchimento: "ano", modoAno: "crescimento",
        valoresAno: { "2026": 10_000 },
        crescimentoPorAno: { "2027": 0.15 },
      })],
    });
    expect(r.agregacoes.anual["receita-total"]["2027"]).toBeCloseTo(23_000, 2);
  });

  it("multiplicador de CENÁRIO escala o driver em qualquer modo (Por ano incluso)", () => {
    const bloco = blocoReceitaSerie({ modoPreenchimento: "ano", valoresAno: { "2026": 1_200_000 } });
    const base = calcularModelo(inputDe([bloco]));
    const otimista = calcularModelo(inputDe([bloco], { overrides: { v_receita: { multiplicador: 1.5 } } }));
    expect(otimista.agregacoes.anual["receita-total"]["2026"]).toBeCloseTo(base.agregacoes.anual["receita-total"]["2026"] * 1.5, 2);
  });

  it("por ANO com SAZONALIDADE: rateia pelo peso do mês e o total do ano fecha exato", () => {
    // Curva com dezembro pesando o dobro (fatores média 1: 11 meses = 12/13, dez = 24/13).
    const saz = Array(12).fill(12 / 13);
    saz[11] = 24 / 13;
    const r = calcularModelo(inputDe([blocoReceitaSerie({ modoPreenchimento: "ano", sazonalidade: saz, valoresAno: { "2026": 1_300_000, "2027": 1_300_000 } })]));
    // Dez recebe o dobro de um mês comum: 100k×12 comuns? não — 12 pesos: 11×(12/13) + 24/13 = 12; dez = 1.3mi×(24/13)/12 = 200k
    expect(r.series["v_receita"]["2026-12"]).toBeCloseTo(200_000, 2);
    expect(r.series["v_receita"]["2026-03"]).toBeCloseTo(100_000, 2);
    expect(r.agregacoes.anual["receita-total"]["2026"]).toBeCloseTo(1_300_000, 2);
  });

  it("por ANO com sazonalidade em ANO PARCIAL: normaliza pelos meses presentes e fecha o total", () => {
    const saz = Array(12).fill(12 / 13);
    saz[11] = 24 / 13; // dezembro pesa o dobro
    const r = calcularModelo({
      mesInicial: "2026-07",
      horizonteMeses: 6, // jul–dez/2026
      blocks: [blocoReceitaSerie({ modoPreenchimento: "ano", sazonalidade: saz, valoresAno: { "2026": 700_000 } })],
    });
    // Pesos presentes: 5×(12/13) + 24/13 = 84/13; dez = 700k×(24/13)/(84/13) = 200k; jul = 100k
    expect(r.series["v_receita"]["2026-12"]).toBeCloseTo(200_000, 2);
    expect(r.series["v_receita"]["2026-07"]).toBeCloseTo(100_000, 2);
    expect(r.agregacoes.anual["receita-total"]["2026"]).toBeCloseTo(700_000, 2);
  });

  it("por ANO informando CRESCIMENTO: ano 1 valor, demais % sobre o anterior", () => {
    // Ano 1 = 1.000/ano; 2027 +15%; 2028 +10% → 1.000, 1.150, 1.265.
    const r = calcularModelo({
      mesInicial: "2026-01",
      horizonteMeses: 36,
      blocks: [blocoReceitaSerie({
        modoPreenchimento: "ano", modoAno: "crescimento",
        valoresAno: { "2026": 1_000 },
        crescimentoPorAno: { "2027": 0.15, "2028": 0.1 },
      })],
    });
    expect(r.agregacoes.anual["receita-total"]["2026"]).toBeCloseTo(1_000, 2);
    expect(r.agregacoes.anual["receita-total"]["2027"]).toBeCloseTo(1_150, 2);
    expect(r.agregacoes.anual["receita-total"]["2028"]).toBeCloseTo(1_265, 2);
  });

  it("por ANO em QUANTIDADE [#]: o número é o TOTAL do ano (extensiva, divide pelos meses)", () => {
    const bloco: BlocoModelo = {
      id: "b1", tipo: "receitas", nome: "Receitas", ativo: true,
      config: {
        linhasReceita: [{
          id: "lin", nome: "Vendas", nodeRaiz: "r",
          nodes: [
            { id: "qtd", tipo: "serie", nome: "Quantidade", unidade: "#", params: { modoPreenchimento: "ano", valoresAno: { "2026": 120_000 } } },
            { id: "preco", tipo: "preco", nome: "Valor por unidade", unidade: "R$/un", params: { modoPreenchimento: "ano", valoresAno: { "2026": 100 } } },
            { id: "r", tipo: "formula", nome: "Receita", unidade: "R$", params: { expr: "qtd * preco" } },
          ],
        }],
      },
    };
    const r = calcularModelo(inputDe([bloco]));
    // 120.000 un no ANO = 10.000/mês; preço vigente 100 → 1 mi/mês, 12 mi no ano.
    expect(r.series["qtd"]["2026-05"]).toBeCloseTo(10_000, 2);
    expect(r.series["preco"]["2026-05"]).toBeCloseTo(100, 6);
    expect(r.agregacoes.anual["receita-total"]["2026"]).toBeCloseTo(12_000_000, 2);
  });

  it("por ANO em taxa/preço: o número é o valor vigente no ano (não divide por 12)", () => {
    const bloco: BlocoModelo = {
      id: "b1", tipo: "receitas", nome: "Receitas", ativo: true,
      config: {
        linhasReceita: [{
          id: "lin", nome: "Câmbio", nodeRaiz: "r",
          nodes: [
            { id: "vol", tipo: "serie", nome: "Volume", unidade: "R$", params: { valorMensal: 1_000_000 } },
            { id: "tx", tipo: "taxa", nome: "Take rate", unidade: "%", params: { modoPreenchimento: "ano", valoresAno: { "2026": 0.01, "2027": 0.012 } } },
            { id: "r", tipo: "formula", nome: "Receita", unidade: "R$", params: { expr: "vol * tx" } },
          ],
        }],
      },
    };
    const r = calcularModelo(inputDe([bloco]));
    expect(r.series["tx"]["2026-05"]).toBeCloseTo(0.01, 6);
    expect(r.series["tx"]["2027-05"]).toBeCloseTo(0.012, 6);
  });

  it("por MÊS: grade explícita vence; mês não preenchido cai na base", () => {
    const r = calcularModelo(inputDe([blocoReceitaSerie({ modoPreenchimento: "mes", valorMensal: 50_000, valores: { "2026-01": 80_000, "2026-02": 90_000 } })]));
    expect(r.series["v_receita"]["2026-01"]).toBe(80_000);
    expect(r.series["v_receita"]["2026-02"]).toBe(90_000);
    expect(r.series["v_receita"]["2026-03"]).toBeCloseTo(50_000, 2);
  });

  it("O MENSAL MANDA: valor mensal explícito vence qualquer modo", () => {
    const r = calcularModelo(inputDe([blocoReceitaSerie({ modoPreenchimento: "ano", valoresAno: { "2026": 120_000 }, valores: { "2026-01": 99_999 } })]));
    expect(r.series["v_receita"]["2026-01"]).toBe(99_999); // mês explícito
    expect(r.series["v_receita"]["2026-02"]).toBeCloseTo(10_000, 2); // resto vem do anual
  });
});

// ── Custos: base por produto, % por ano, reajuste por índice ────────────────

describe("linhas de custo/despesa flexíveis (feedback da validação)", () => {
  it("% por ano calendário substitui o % flat no ano configurado", () => {
    const custos: BlocoModelo = {
      id: "b3", tipo: "custos", nome: "Custos", ativo: true,
      config: { linhasCusto: [{ id: "cmv", nome: "CMV", modo: "pctReceita", pct: 0.3, pctPorAno: { "2027": 0.25 } }] },
    };
    const r = calcularModelo(inputDe([blocoTransacional(), custos]));
    const receita = r.dre.find((l) => l.id === "receita-total")!;
    const custosTotal = r.dre.find((l) => l.id === "custos-total")!;
    expect(custosTotal.valores["2026-06"]).toBeCloseTo(receita.valores["2026-06"] * 0.3, 2);
    expect(custosTotal.valores["2027-06"]).toBeCloseTo(receita.valores["2027-06"] * 0.25, 2);
  });

  it("% sobre a receita de um PRODUTO específico (baseRef), não da receita total", () => {
    const receitas: BlocoModelo = {
      id: "b1", tipo: "receitas", nome: "Receitas", ativo: true,
      config: {
        linhasReceita: [
          { id: "prodA", nome: "Produto A", nodeRaiz: "a_receita", nodes: [{ id: "a_receita", tipo: "serie", nome: "Receita A", unidade: "R$", params: { valorMensal: 100_000 } }] },
          { id: "prodB", nome: "Produto B", nodeRaiz: "b_receita", nodes: [{ id: "b_receita", tipo: "serie", nome: "Receita B", unidade: "R$", params: { valorMensal: 50_000 } }] },
        ],
      },
    };
    const custos: BlocoModelo = {
      id: "b3", tipo: "custos", nome: "Custos", ativo: true,
      config: { linhasCusto: [{ id: "comissao", nome: "Comissão do Produto B", modo: "pctReceita", pct: 0.1, baseRef: "prodB" }] },
    };
    const r = calcularModelo(inputDe([receitas, custos]));
    // 10% de 50.000 (produto B), não 10% de 150.000 (total)
    expect(r.dre.find((l) => l.id === "custos-total")!.valores["2026-01"]).toBeCloseTo(5_000, 2);
    // Com 2 produtos, a DRE abre a receita por produto
    expect(r.dre.some((l) => l.id === "prodA")).toBe(true);
    expect(r.dre.some((l) => l.id === "prodB")).toBe(true);
  });

  it("reajuste por índice varia por ano calendário (reajustePorAno)", () => {
    const despesas: BlocoModelo = {
      id: "b4", tipo: "despesas", nome: "Despesas", ativo: true,
      config: { linhasCusto: [{ id: "aluguel", nome: "Aluguel", modo: "fixoReajuste", valorMensal: 10_000, reajusteAnual: 0.04, reajustePorAno: { "2027": 0.1 } }] },
    };
    const r = calcularModelo(inputDe([blocoTransacional(), despesas]));
    const desp = r.dre.find((l) => l.id === "despesas-total")!;
    expect(desp.valores["2026-05"]).toBe(10_000); // 1º ano: valor base
    expect(desp.valores["2027-05"]).toBeCloseTo(11_000, 2); // 2027: índice específico 10%
  });

  it("a DRE SEMPRE abre por produto/linha (mesmo com uma linha só)", () => {
    const r = calcularModelo(inputDe([blocoTransacional(), blocoCustosSimples()]));
    expect(r.dre.some((l) => l.id === "lin-cambio" && l.grupo === "receita")).toBe(true);
    expect(r.dre.some((l) => l.id === "cmv")).toBe(true);
    expect(r.dre.some((l) => l.id === "custos-total")).toBe(true);
  });
});

// ── Checks ──────────────────────────────────────────────────────────────────

describe("checks determinísticos", () => {
  it("análise dimensional pega linha de receita que não fecha em R$", () => {
    const bloco = blocoSaas();
    // Sabotagem: receita = clientes × churnRate (# × % = #, não R$)
    const receita = bloco.config.linhasReceita![0].nodes.find((n) => n.id === "receita")!;
    receita.params = { expr: "clientes * churnRate" };
    const r = calcularModelo(inputDe([bloco]));
    const dim = r.checks.find((c) => c.id === "dimensional")!;
    expect(dim.ok).toBe(false);
    expect(dim.prova).toContain("Receita de assinaturas");
  });

  it("soma de unidades diferentes é erro dimensional", () => {
    const bloco = blocoSaas();
    const receita = bloco.config.linhasReceita![0].nodes.find((n) => n.id === "receita")!;
    receita.params = { expr: "clientes + arpu" };
    const r = calcularModelo(inputDe([bloco]));
    expect(r.checks.find((c) => c.id === "dimensional")!.ok).toBe(false);
  });

  it("detecta ciclo no grafo com o caminho", () => {
    const bloco: BlocoModelo = {
      id: "b1", tipo: "receitas", nome: "Receitas", ativo: true,
      config: {
        linhasReceita: [{
          id: "lin", nome: "Circular", nodeRaiz: "a",
          nodes: [
            { id: "a", tipo: "formula", nome: "A", unidade: "R$", params: { expr: "b * 2" } },
            { id: "b", tipo: "formula", nome: "B", unidade: "R$", params: { expr: "a * 2" } },
          ],
        }],
      },
    };
    const r = calcularModelo(inputDe([bloco]));
    expect(r.checks.find((c) => c.id === "grafo-ciclos")!.ok).toBe(false);
    expect(r.erros.some((e) => e.includes("Ciclo"))).toBe(true);
  });

  it("referência órfã vira check vermelho, não crash", () => {
    const bloco = blocoSaas();
    bloco.config.linhasReceita![0].nodes.find((n) => n.id === "receita")!.params = { expr: "clientes * precoQueNaoExiste" };
    const r = calcularModelo(inputDe([bloco]));
    const orf = r.checks.find((c) => c.id === "grafo-orfaos")!;
    expect(orf.ok).toBe(false);
    expect(orf.prova).toContain("precoQueNaoExiste");
  });

  it("taxa com papel ocupacao acima de 100% estoura o check de capacidade", () => {
    const bloco: BlocoModelo = {
      id: "b1", tipo: "receitas", nome: "Receitas", ativo: true,
      config: {
        linhasReceita: [{
          id: "lin", nome: "Diárias", nodeRaiz: "receita",
          nodes: [
            { id: "ocupacao", tipo: "taxa", nome: "Taxa de ocupação", unidade: "%", papel: "ocupacao", params: { valorMensal: 1.15 } },
            { id: "capacidade", tipo: "capacidade", nome: "Leitos × dias", unidade: "#", params: { valorMensal: 900 } },
            { id: "diaria", tipo: "preco", nome: "Diária", unidade: "R$/un", params: { valorMensal: 350 } },
            { id: "receita", tipo: "formula", nome: "Receita de diárias", unidade: "R$", params: { expr: "capacidade * ocupacao * diaria" } },
          ],
        }],
      },
    };
    const r = calcularModelo(inputDe([bloco]));
    const cap = r.checks.find((c) => c.id === "capacidade")!;
    expect(cap.ok).toBe(false);
    expect(cap.prova).toContain("Taxa de ocupação");
  });
});

describe("ano corrente com realizado de REFERÊNCIA (premissa cobre o ano inteiro)", () => {
  it("a premissa anual segue a MESMA regra dos demais anos (÷ meses do ano no horizonte)", () => {
    // Realizado jan–jun presente como referência — NÃO altera o cálculo:
    // 2026 = 120.000 ÷ 12 meses; o analista ajusta meses à mão se quiser.
    const realizado = {
      meses: ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"],
      porGrupo: { receita: Object.fromEntries(Array.from({ length: 6 }, (_, k) => [`2026-0${k + 1}`, 1_000_000])) },
    };
    const r = calcularModelo({
      mesInicial: "2026-01",
      horizonteMeses: 24,
      blocks: [blocoReceitaSerie({ modoPreenchimento: "ano", valoresAno: { "2026": 120_000 } })],
      realizado,
    });
    expect(r.series["v_receita"]["2026-03"]).toBeCloseTo(10_000, 2);
    expect(r.series["v_receita"]["2026-09"]).toBeCloseTo(10_000, 2);
    expect(r.agregacoes.anual["receita-total"]["2026"]).toBeCloseTo(120_000, 2);
    // Mês ajustado à mão vence; o ano passa a somar o ajuste
    const r2 = calcularModelo({
      mesInicial: "2026-01",
      horizonteMeses: 24,
      blocks: [blocoReceitaSerie({ modoPreenchimento: "ano", valoresAno: { "2026": 120_000 }, valores: { "2026-01": 25_000 } })],
      realizado,
    });
    expect(r2.series["v_receita"]["2026-01"]).toBe(25_000);
  });
});

// ── Realizado ───────────────────────────────────────────────────────────────

describe("realizado como referência (não sobrepõe premissas)", () => {
  it("totais vêm SEMPRE das premissas; statusMes é sempre projeção", () => {
    const r = calcularModelo(inputDe([blocoTransacional(), blocoCustosSimples()], {
      realizado: {
        meses: ["2026-01", "2026-02"],
        porGrupo: {
          receita: { "2026-01": 500_000, "2026-02": 520_000 },
          custos: { "2026-01": 150_000, "2026-02": 155_000 },
        },
      },
    }));
    expect(r.statusMes["2026-01"]).toBe("proj");
    const receita = r.dre.find((l) => l.id === "receita-total")!;
    expect(receita.valores["2026-01"]).toBeCloseTo(119_470_000 * 0.00465, 2); // premissa, não 500.000
    const c = r.checks.find((ch) => ch.id === "realizado")!;
    expect(c.ok).toBe(true);
    expect(c.prova).toContain("referência");
  });

  it("sem realizado, o check informa modelo 100% premissa (sem alarme)", () => {
    const r = calcularModelo(inputDe([blocoTransacional()]));
    const c = r.checks.find((ch) => ch.id === "realizado")!;
    expect(c.ok).toBe(true);
    expect(c.prova).toContain("100% premissa");
  });
});

describe("custos e despesas com DRIVERS (mesma estrutura das receitas)", () => {
  it("linha de custo 'por variável': variável vigente × custo unitário, no grupo custos", () => {
    const custos: BlocoModelo = {
      id: "b3", tipo: "custos", nome: "Custos", ativo: true,
      config: {
        linhasReceita: [{
          id: "folha", nome: "Folha operacional", template: "porVariavel", nodeRaiz: "folha_total",
          nodes: [
            { id: "folha_var", tipo: "capacidade", nome: "Pessoas", unidade: "#", params: { valorMensal: 10 } },
            { id: "folha_unit", tipo: "preco", nome: "Custo por pessoa", unidade: "R$/un", params: { valorMensal: 8_000 } },
            { id: "folha_total", tipo: "formula", nome: "Total — Folha", unidade: "R$", params: { expr: "folha_var * folha_unit" } },
          ],
        }],
      },
    };
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), custos]));
    expect(r.erros).toEqual([]);
    // Linha única no grupo: a DRE mostra só o total (regra de abertura 2+).
    expect(r.series["folha_total"]["2026-01"]).toBeCloseTo(80_000, 6);
    const custosTotal = r.dre.find((l) => l.id === "custos-total")!;
    expect(custosTotal.valores["2026-01"]).toBeCloseTo(80_000, 6);
  });

  it("fórmula de custo referencia o nó sintético receita_total (% da receita via drivers)", () => {
    const despesas: BlocoModelo = {
      id: "b4", tipo: "despesas", nome: "Despesas", ativo: true,
      config: {
        linhasReceita: [{
          id: "comissao", nome: "Comissões", template: "personalizada", nodeRaiz: "com_total",
          nodes: [
            { id: "com_pct", tipo: "taxa", nome: "% de comissão", unidade: "%", params: { valorMensal: 0.05 } },
            { id: "com_total", tipo: "formula", nome: "Total — Comissões", unidade: "R$", params: { expr: "com_pct * receita_total" } },
          ],
        }],
      },
    };
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), despesas]));
    expect(r.erros).toEqual([]);
    // receita_total existe e soma as raízes de receita
    expect(r.series["receita_total"]["2026-01"]).toBeCloseTo(100_000, 6);
    expect(r.dre.find((l) => l.id === "despesas-total")!.valores["2026-01"]).toBeCloseTo(5_000, 6);
    // EBITDA = 100.000 − 0 (custos) − 5.000
    expect(r.dre.find((l) => l.id === "ebitda")!.valores["2026-01"]).toBeCloseTo(95_000, 6);
  });

  it("linha drivers de custo que não fecha em R$ acusa na prova dimensional", () => {
    const custos: BlocoModelo = {
      id: "b3", tipo: "custos", nome: "Custos", ativo: true,
      config: {
        linhasReceita: [{
          id: "errada", nome: "Linha errada", nodeRaiz: "e_qtd",
          nodes: [{ id: "e_qtd", tipo: "serie", nome: "Quantidade", unidade: "#", params: { valorMensal: 5 } }],
        }],
      },
    };
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), custos]));
    const dim = r.checks.find((c) => c.id === "dimensional")!;
    expect(dim.ok).toBe(false);
    expect(dim.prova).toContain("Linha errada");
  });

  it("linhas simples e com drivers convivem no mesmo bloco (soma dos dois jeitos)", () => {
    const custos: BlocoModelo = {
      ...blocoCustosSimples(),
      config: {
        ...blocoCustosSimples().config,
        linhasReceita: [{
          id: "crescente", nome: "Manutenção", template: "crescimento", nodeRaiz: "man_total",
          nodes: [{ id: "man_total", tipo: "serie", nome: "Total — Manutenção", unidade: "R$", params: { valorMensal: 2_000, crescimentoAnual: 0 } }],
        }],
      },
    };
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), custos]));
    expect(r.erros).toEqual([]);
    // pctReceita 30% de 100k + aluguel 10k + manutenção 2k = 42k
    expect(r.dre.find((l) => l.id === "custos-total")!.valores["2026-01"]).toBeCloseTo(42_000, 6);
  });
});

describe("custo por variável de OUTRA linha (aluguel ÷ headcount × headcount)", () => {
  it("fórmula do custo referencia variável # de uma linha de receita; vigente repete nos meses", () => {
    const receitas: BlocoModelo = {
      id: "b1", tipo: "receitas", nome: "Receitas", ativo: true,
      config: {
        linhasReceita: [{
          id: "serv", nome: "Serviços", nodeRaiz: "s_receita",
          nodes: [
            { id: "s_headcount", tipo: "capacidade", nome: "Profissionais", unidade: "#", params: { valorMensal: 20 } },
            { id: "s_ticket", tipo: "preco", nome: "Receita por profissional", unidade: "R$/un", params: { valorMensal: 15_000 } },
            { id: "s_receita", tipo: "formula", nome: "Receita — Serviços", unidade: "R$", params: { expr: "s_headcount * s_ticket" } },
          ],
        }],
      },
    };
    const despesas: BlocoModelo = {
      id: "b4", tipo: "despesas", nome: "Despesas", ativo: true,
      config: {
        linhasReceita: [{
          id: "aluguel", nome: "Aluguel", template: "porVariavel", nodeRaiz: "aluguel_total",
          nodes: [
            // custo unitário: aluguel 2026 informado ÷ headcount 2026 = 500 R$/pessoa/mês
            { id: "aluguel_custoUnit", tipo: "preco", nome: "Custo por unidade", unidade: "R$/un", params: { valorMensal: 500 } },
            { id: "aluguel_total", tipo: "formula", nome: "Total — Aluguel", unidade: "R$", params: { expr: "s_headcount * aluguel_custoUnit" } },
          ],
        }],
      },
    };
    const r = calcularModelo(inputDe([receitas, despesas]));
    expect(r.erros).toEqual([]);
    // vigente × vigente: 20 pessoas × 500 = 10.000/mês, todos os meses
    expect(r.series["aluguel_total"]["2026-01"]).toBeCloseTo(10_000, 6);
    expect(r.series["aluguel_total"]["2026-12"]).toBeCloseTo(10_000, 6);
    const linha = r.dre.find((l) => l.id === "aluguel")!;
    expect(linha.grupo).toBe("despesas"); // abre por linha SEMPRE, mesmo sozinha
    expect(r.agregacoes.anual["aluguel"]["2026"]).toBeCloseTo(120_000, 4);
  });
});

describe("anterior(x) — variação mês a mês na fórmula", () => {
  it("comissão de 10% sobre o CRESCIMENTO da receita do produto (mês atual − mês anterior)", () => {
    const receitas = blocoReceitaSerie({ valores: { "2026-01": 100_000, "2026-02": 110_000, "2026-03": 130_000, "2026-04": 120_000 } });
    const despesas: BlocoModelo = {
      id: "b4", tipo: "despesas", nome: "Despesas", ativo: true,
      config: {
        linhasReceita: [{
          id: "comissao", nome: "Comissão sobre crescimento", template: "personalizada", nodeRaiz: "com_total",
          nodes: [
            { id: "com_pct", tipo: "taxa", nome: "% de comissão", unidade: "%", params: { valorMensal: 0.1 } },
            { id: "com_total", tipo: "formula", nome: "Total — Comissão", unidade: "R$", params: { expr: "max(v_receita - anterior(v_receita), 0) * com_pct" } },
          ],
        }],
      },
    };
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 4, blocks: [receitas, despesas] });
    expect(r.erros).toEqual([]);
    // dimensional ok: (R$ − R$) × % = R$; max com literal 0 assume a unidade do outro lado
    expect(r.checks.find((c) => c.id === "dimensional")!.ok).toBe(true);
    const com = r.series["com_total"];
    expect(com["2026-01"]).toBeCloseTo(0, 6);        // 1º mês: sem anterior → variação zero
    expect(com["2026-02"]).toBeCloseTo(1_000, 6);    // (110k − 100k) × 10%
    expect(com["2026-03"]).toBeCloseTo(2_000, 6);    // (130k − 110k) × 10%
    expect(com["2026-04"]).toBeCloseTo(0, 6);        // caiu → max(…, 0)
  });

  it("anterior() não cria ciclo: custo pode olhar a própria receita defasada", () => {
    const receitas = blocoReceitaSerie({ valorMensal: 50_000 });
    const custos: BlocoModelo = {
      id: "b3", tipo: "custos", nome: "Custos", ativo: true,
      config: {
        linhasReceita: [{
          id: "reposicao", nome: "Reposição", template: "personalizada", nodeRaiz: "rep_total",
          nodes: [{ id: "rep_total", tipo: "formula", nome: "Total", unidade: "R$", params: { expr: "anterior(v_receita) * 0.2" } }],
        }],
      },
    };
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 3, blocks: [receitas, custos] });
    expect(r.erros).toEqual([]);
    expect(r.series["rep_total"]["2026-02"]).toBeCloseTo(10_000, 6);
  });
});

describe("anterior(x, n) e futuro(x, n) — deslocamento de N meses", () => {
  const receitaCrescente = () => blocoReceitaSerie({
    valores: { "2026-01": 100, "2026-02": 200, "2026-03": 300, "2026-04": 400, "2026-05": 500, "2026-06": 600 },
  });

  it("anterior(x, 3): olha 3 meses atrás; antes do horizonte vale o próprio mês", () => {
    const despesas: BlocoModelo = {
      id: "b4", tipo: "despesas", nome: "Despesas", ativo: true,
      config: {
        linhasReceita: [{
          id: "d1", nome: "Defasada", template: "personalizada", nodeRaiz: "d1_total",
          nodes: [{ id: "d1_total", tipo: "formula", nome: "Total", unidade: "R$", params: { expr: "anterior(v_receita, 3) * 0.5" } }],
        }],
      },
    };
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 6, blocks: [receitaCrescente(), despesas] });
    expect(r.erros).toEqual([]);
    expect(r.series["d1_total"]["2026-04"]).toBeCloseTo(50, 6);  // receita de jan (100) × 0,5
    expect(r.series["d1_total"]["2026-06"]).toBeCloseTo(150, 6); // receita de mar (300) × 0,5
    expect(r.series["d1_total"]["2026-01"]).toBeCloseTo(50, 6);  // antes do horizonte → o próprio mês
  });

  it("futuro(x, 3): 10% sobre a receita de 3 meses à frente; além do horizonte vale zero", () => {
    const despesas: BlocoModelo = {
      id: "b4", tipo: "despesas", nome: "Despesas", ativo: true,
      config: {
        linhasReceita: [{
          id: "f1", nome: "Comissão antecipada", template: "personalizada", nodeRaiz: "f1_total",
          nodes: [{ id: "f1_total", tipo: "formula", nome: "Total", unidade: "R$", params: { expr: "futuro(v_receita, 3) * 0.1" } }],
        }],
      },
    };
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 6, blocks: [receitaCrescente(), despesas] });
    expect(r.erros).toEqual([]);
    expect(r.series["f1_total"]["2026-01"]).toBeCloseTo(40, 6); // receita de abr (400) × 10%
    expect(r.series["f1_total"]["2026-03"]).toBeCloseTo(60, 6); // receita de jun (600) × 10%
    expect(r.series["f1_total"]["2026-04"]).toBeCloseTo(0, 6);  // jul não existe no horizonte → 0
    expect(r.series["f1_total"]["2026-06"]).toBeCloseTo(0, 6);
  });

  it("cadeia de futuro(): B usa futuro(A) e C usa futuro(B) — ondas em sequência", () => {
    const custos: BlocoModelo = {
      id: "b3", tipo: "custos", nome: "Custos", ativo: true,
      config: {
        linhasReceita: [
          {
            id: "cb", nome: "B", template: "personalizada", nodeRaiz: "b_total",
            nodes: [{ id: "b_total", tipo: "formula", nome: "B", unidade: "R$", params: { expr: "futuro(v_receita, 1) * 0.1" } }],
          },
          {
            id: "cc", nome: "C", template: "personalizada", nodeRaiz: "c_total",
            nodes: [{ id: "c_total", tipo: "formula", nome: "C", unidade: "R$", params: { expr: "futuro(b_total, 1) * 2" } }],
          },
        ],
      },
    };
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 6, blocks: [receitaCrescente(), custos] });
    expect(r.erros).toEqual([]);
    expect(r.series["b_total"]["2026-01"]).toBeCloseTo(20, 6); // fev (200) × 10%
    expect(r.series["c_total"]["2026-01"]).toBeCloseTo(60, 6); // b_total de fev (30) × 2
  });

  it("ciclo no tempo (A usa futuro de quem depende de A) vira erro, não trava", () => {
    const custos: BlocoModelo = {
      id: "b3", tipo: "custos", nome: "Custos", ativo: true,
      config: {
        linhasReceita: [
          {
            id: "ca", nome: "A", template: "personalizada", nodeRaiz: "a_total",
            nodes: [{ id: "a_total", tipo: "formula", nome: "A", unidade: "R$", params: { expr: "futuro(b2_total, 1)" } }],
          },
          {
            id: "cb2", nome: "B2", template: "personalizada", nodeRaiz: "b2_total",
            nodes: [{ id: "b2_total", tipo: "formula", nome: "B2", unidade: "R$", params: { expr: "a_total * 2" } }],
          },
        ],
      },
    };
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 3, blocks: [receitaCrescente(), custos] });
    expect(r.erros.some((e) => e.includes("circular no tempo"))).toBe(true);
  });
});

describe("não operacionais (abaixo do EBITDA)", () => {
  it("receita e despesa não operacionais entram após o EBITDA e fecham o resultado", () => {
    const recNaoOp: BlocoModelo = {
      id: "b5", tipo: "receitasNaoOp", nome: "Receitas não operacionais", ativo: true,
      config: { linhasCusto: [{ id: "alugueis", nome: "Aluguéis recebidos", modo: "fixoReajuste", valorMensal: 5_000, reajusteAnual: 0 }] },
    };
    const despNaoOp: BlocoModelo = {
      id: "b6", tipo: "despesasNaoOp", nome: "Despesas não operacionais", ativo: true,
      config: { linhasCusto: [{ id: "multas", nome: "Multas e indenizações", modo: "fixoReajuste", valorMensal: 2_000, reajusteAnual: 0 }] },
    };
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), blocoCustosSimples(), recNaoOp, despNaoOp]));
    expect(r.erros).toEqual([]);
    const ids = r.dre.map((l) => l.id);
    // ordem: EBITDA → (+) rec não op → linhas → (−) desp não op → linhas → resultado
    expect(ids.indexOf("rec-naoop-total")).toBeGreaterThan(ids.indexOf("ebitda"));
    expect(ids.indexOf("resultado-apos-naoop")).toBeGreaterThan(ids.indexOf("desp-naoop-total"));
    const ebitda = r.dre.find((l) => l.id === "ebitda")!.valores["2026-01"];
    const final = r.dre.find((l) => l.id === "resultado-apos-naoop")!.valores["2026-01"];
    expect(final).toBeCloseTo(ebitda + 5_000 - 2_000, 6);
    // linha individual aberta
    expect(r.dre.find((l) => l.id === "alugueis")!.valores["2026-01"]).toBeCloseTo(5_000, 6);
  });

  it("sem linhas não operacionais a DRE não ganha a seção (modelos antigos intactos)", () => {
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), blocoCustosSimples()]));
    expect(r.dre.some((l) => l.id === "rec-naoop-total")).toBe(false);
    expect(r.dre.some((l) => l.id === "resultado-apos-naoop")).toBe(false);
  });
});

describe("B6 — capex, waterfall de depreciação e imobilizado", () => {
  it("safra deprecia LINEAR pela taxa da linha a partir do mês seguinte, até esgotar", () => {
    const capex: BlocoModelo = {
      id: "b7", tipo: "capex", nome: "Investimentos", ativo: true,
      config: {
        // 1.200 investidos em janeiro; 12% a.a. → 1%/mês do valor = 12/mês a partir de FEV
        linhasCusto: [{ id: "maq", nome: "Máquinas", modo: "serie", valores: { "2026-01": 1_200 }, depreciacaoAnual: 0.12 }],
      },
    };
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), capex]));
    expect(r.erros).toEqual([]);
    expect(r.series["capex_total"]["2026-01"]).toBeCloseTo(1_200, 6);
    expect(r.series["depreciacao_total"]["2026-01"]).toBeCloseTo(0, 6);   // entra em operação no mês seguinte
    expect(r.series["depreciacao_total"]["2026-02"]).toBeCloseTo(12, 6);  // 1.200 × 1%
    expect(r.series["imobilizado_liquido"]["2026-01"]).toBeCloseTo(1_200, 6);
    expect(r.series["imobilizado_liquido"]["2026-03"]).toBeCloseTo(1_200 - 24, 6);
    // DRE: D&A e EBIT presentes; EBIT = EBITDA − D&A
    const ebitda = r.dre.find((l) => l.id === "ebitda")!.valores["2026-02"];
    expect(r.dre.find((l) => l.id === "ebit")!.valores["2026-02"]).toBeCloseTo(ebitda - 12, 6);
  });

  it("imobilizado LEGADO deprecia sobre o saldo inicial até esgotar; nunca negativo", () => {
    const capex: BlocoModelo = {
      id: "b7", tipo: "capex", nome: "Investimentos", ativo: true,
      // 1.000 já existentes, 60% a.a. → 50/mês; esgota no mês 20 (dentro de 24 meses)
      config: { saldoInicialImobilizado: 1_000, depreciacaoLegadoAnual: 0.6 },
    };
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), capex]));
    expect(r.series["depreciacao_total"]["2026-01"]).toBeCloseTo(50, 6);
    expect(r.series["imobilizado_liquido"]["2026-12"]).toBeCloseTo(1_000 - 600, 6);
    expect(r.series["imobilizado_liquido"]["2027-12"]).toBeCloseTo(0, 6); // esgotou, não fica negativo
    expect(r.series["depreciacao_total"]["2027-12"]).toBeCloseTo(0, 6);
  });

  it("sem bloco capex a DRE não ganha D&A/EBIT (modelos antigos intactos)", () => {
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), blocoCustosSimples()]));
    expect(r.dre.some((l) => l.id === "ebit")).toBe(false);
    expect(r.dre.some((l) => l.id === "depreciacao-total")).toBe(false);
  });

  it("com capex E não operacionais, o resultado após não op parte do EBIT", () => {
    const capex: BlocoModelo = {
      id: "b7", tipo: "capex", nome: "Investimentos", ativo: true,
      config: { saldoInicialImobilizado: 1_200, depreciacaoLegadoAnual: 0.12 }, // 12/mês
    };
    const recNaoOp: BlocoModelo = {
      id: "b5", tipo: "receitasNaoOp", nome: "Receitas não operacionais", ativo: true,
      config: { linhasCusto: [{ id: "alug", nome: "Aluguéis", modo: "fixoReajuste", valorMensal: 1_000, reajusteAnual: 0 }] },
    };
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), capex, recNaoOp]));
    const ebit = r.dre.find((l) => l.id === "ebit")!.valores["2026-01"];
    expect(r.dre.find((l) => l.id === "resultado-apos-naoop")!.valores["2026-01"]).toBeCloseTo(ebit + 1_000, 6);
  });
});

describe("auto-referência defasada: piso no próprio resultado do mês anterior", () => {
  it("investimento = Δheadcount × custo unitário, no mínimo o investimento do mês passado", () => {
    const receitas: BlocoModelo = {
      id: "b1", tipo: "receitas", nome: "Receitas", ativo: true,
      config: {
        linhasReceita: [{
          id: "serv", nome: "Serviços", nodeRaiz: "s_receita",
          nodes: [
            // headcount: 10 → 13 → 14 → 14 (delta 3, 1, 0)
            { id: "s_head", tipo: "capacidade", nome: "Profissionais", unidade: "#", params: { valores: { "2026-01": 10, "2026-02": 13, "2026-03": 14, "2026-04": 14 } } },
            { id: "s_receita", tipo: "formula", nome: "Receita", unidade: "R$", params: { expr: "s_head * 1000" } },
          ],
        }],
      },
    };
    const capex: BlocoModelo = {
      id: "b7", tipo: "capex", nome: "Investimentos", ativo: true,
      config: {
        linhasReceita: [{
          id: "maq", nome: "Máquinas", template: "personalizada", nodeRaiz: "maq_total", depreciacaoAnual: 0.1,
          nodes: [
            { id: "maq_unit", tipo: "preco", nome: "Custo por profissional", unidade: "R$/un", params: { valorMensal: 1_000 } },
            { id: "maq_total", tipo: "formula", nome: "Memória", unidade: "R$", params: { expr: "max((s_head - anterior(s_head)) * maq_unit, anterior(maq_total))" } },
          ],
        }],
      },
    };
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 4, blocks: [receitas, capex] });
    expect(r.erros).toEqual([]);
    const inv = r.series["maq_total"];
    expect(inv["2026-01"]).toBeCloseTo(0, 6);      // 1º mês: sem anterior → Δ0, piso 0
    expect(inv["2026-02"]).toBeCloseTo(3_000, 6);  // Δ3 × 1.000
    expect(inv["2026-03"]).toBeCloseTo(3_000, 6);  // Δ1 × 1.000 = 1.000 < piso 3.000 → mantém 3.000
    expect(inv["2026-04"]).toBeCloseTo(3_000, 6);  // Δ0 → piso mantém
  });
});

describe("media(x, n) — média móvel", () => {
  it("média dos 3 últimos meses (aquece com o mês corrente no início)", () => {
    const receitas = blocoReceitaSerie({ valores: { "2026-01": 100, "2026-02": 200, "2026-03": 300, "2026-04": 400 } });
    const despesas: BlocoModelo = {
      id: "b4", tipo: "despesas", nome: "Despesas", ativo: true,
      config: {
        linhasReceita: [{
          id: "prov", nome: "Provisão", template: "personalizada", nodeRaiz: "prov_total",
          nodes: [{ id: "prov_total", tipo: "formula", nome: "Total", unidade: "R$", params: { expr: "media(v_receita, 3) * 0.1" } }],
        }],
      },
    };
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 4, blocks: [receitas, despesas] });
    expect(r.erros).toEqual([]);
    expect(r.series["prov_total"]["2026-01"]).toBeCloseTo(10, 6);              // (100+100+100)/3 × 10%
    expect(r.series["prov_total"]["2026-03"]).toBeCloseTo(20, 6);              // (300+200+100)/3 × 10%
    expect(r.series["prov_total"]["2026-04"]).toBeCloseTo(30, 6);              // (400+300+200)/3 × 10%
  });
});

describe("ativos existentes por classe + carência de depreciação", () => {
  it("cada classe deprecia pela sua taxa; taxa 0 (terrenos) não deprecia", () => {
    const capex: BlocoModelo = {
      id: "b7", tipo: "capex", nome: "Investimentos", ativo: true,
      config: {
        ativosExistentes: [
          { id: "a1", nome: "Máquinas", valor: 1_200, taxaAnual: 0.12 },   // 12/mês
          { id: "a2", nome: "Terrenos", valor: 500, taxaAnual: 0 },        // nunca deprecia
          { id: "a3", nome: "Software (intangível)", valor: 600, taxaAnual: 0.2 }, // 10/mês
        ],
      },
    };
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), capex]));
    expect(r.erros).toEqual([]);
    expect(r.series["depreciacao_total"]["2026-01"]).toBeCloseTo(22, 6); // 12 + 0 + 10
    expect(r.series["imobilizado_liquido"]["2026-01"]).toBeCloseTo(2_300 - 22, 6);
  });

  it("carência: cultura em formação só começa a exaurir depois de N meses", () => {
    const capex: BlocoModelo = {
      id: "b7", tipo: "capex", nome: "Investimentos", ativo: true,
      config: {
        // 1.200 plantados em jan/2026; carência 12 meses → exaure a partir de fev/2027
        linhasCusto: [{ id: "cultura", nome: "Cultura em formação", modo: "serie", valores: { "2026-01": 1_200 }, depreciacaoAnual: 0.12, carenciaMeses: 12 }],
      },
    };
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), capex]));
    expect(r.series["depreciacao_total"]["2026-06"]).toBeCloseTo(0, 6);   // em formação
    expect(r.series["depreciacao_total"]["2027-01"]).toBeCloseTo(0, 6);   // último mês de carência
    expect(r.series["depreciacao_total"]["2027-02"]).toBeCloseTo(12, 6);  // formou → 1% a.m.
    expect(r.series["imobilizado_liquido"]["2026-12"]).toBeCloseTo(1_200, 6);
  });

  it("retrocompatibilidade: os 2 campos antigos seguem valendo sem ativosExistentes", () => {
    const capex: BlocoModelo = {
      id: "b7", tipo: "capex", nome: "Investimentos", ativo: true,
      config: { saldoInicialImobilizado: 1_200, depreciacaoLegadoAnual: 0.12 },
    };
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), capex]));
    expect(r.series["depreciacao_total"]["2026-01"]).toBeCloseTo(12, 6);
  });
});

describe("B7 — capital de giro por dias (PMR/PME/PMP)", () => {
  it("contas = base do mês × dias/30; NCG e ΔNCG fecham", () => {
    const giro: BlocoModelo = {
      id: "b8", tipo: "giro", nome: "Capital de giro", ativo: true,
      config: { pmr: 60, pme: 30, pmp: 45 },
    };
    // receita 100k/mês; custos 30% = 30k/mês
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), blocoCustosSimples(), giro]));
    expect(r.erros).toEqual([]);
    // CR = 100k × 60/30 = 200k · Estoques = 40k × 30/30 = 40k · Fornecedores = 40k × 45/30 = 60k
    // (custos do mês = 30% de 100k + aluguel 10k = 40k)
    expect(r.series["contas_a_receber"]["2026-01"]).toBeCloseTo(200_000, 4);
    expect(r.series["estoques_giro"]["2026-01"]).toBeCloseTo(40_000, 4);
    expect(r.series["fornecedores_giro"]["2026-01"]).toBeCloseTo(60_000, 4);
    expect(r.series["ncg"]["2026-01"]).toBeCloseTo(180_000, 4);
    expect(r.series["delta_ncg"]["2026-01"]).toBeCloseTo(0, 6); // 1º mês: variação zero
    // receita flat → NCG estável → deltas seguintes ~0 (aluguel reajusta só na virada)
    expect(r.series["delta_ncg"]["2026-06"]).toBeCloseTo(0, 4);
  });

  it("dias por ano: ano sem valor cai no flat; sem dias configurados não gera séries", () => {
    const giro: BlocoModelo = {
      id: "b8", tipo: "giro", nome: "Capital de giro", ativo: true,
      config: { pmr: 30, pmrPorAno: { "2027": 60 } },
    };
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), giro]));
    expect(r.series["contas_a_receber"]["2026-06"]).toBeCloseTo(100_000, 4);  // 30/30
    expect(r.series["contas_a_receber"]["2027-06"]).toBeCloseTo(200_000, 4);  // 60/30
    const sem = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), { id: "b8", tipo: "giro", nome: "g", ativo: true, config: {} }]));
    expect(sem.series["ncg"]).toBeUndefined();
  });
});

describe("B4 — pessoas (folha por posição)", () => {
  const posBase = {
    id: "dev", nome: "Desenvolvedor", classificacao: "despesa" as const, tipoContrato: "clt" as const,
    salarioMensal: 10_000, modoQtd: "ano" as const,
  };

  it("RAMPA: a variação do ano distribui linear pelos meses (dez = alvo), inteiro", () => {
    const folha: BlocoModelo = {
      id: "b9", tipo: "folha", nome: "Pessoas", ativo: true,
      config: { encargosPorContrato: { clt: 0 }, posicoes: [{ ...posBase, qtdPorAno: { "2026": 10, "2027": 22 }, distribuicao: "rampa" }] },
    };
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), folha]));
    expect(r.erros).toEqual([]);
    const q = r.series["folha_dev_qtd"];
    expect(q["2026-06"]).toBe(10);                    // 1º ano: alvo o ano inteiro
    expect(q["2027-01"]).toBe(11);                    // rampa: +1 por mês
    expect(q["2027-06"]).toBe(16);
    expect(q["2027-12"]).toBe(22);                    // dezembro = alvo
    // custo acompanha a rampa: jan/2027 = 11 × 10.000
    expect(r.series["folha_dev_custo"]["2027-01"]).toBeCloseTo(110_000, 4);
  });

  it("JANEIRO (padrão): muda tudo na virada do ano; ano vazio repete o anterior", () => {
    const folha: BlocoModelo = {
      id: "b9", tipo: "folha", nome: "Pessoas", ativo: true,
      config: { posicoes: [{ ...posBase, encargosPct: 0, qtdPorAno: { "2026": 10, "2027": 22 }, distribuicao: "janeiro" }] },
    };
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), folha]));
    const q = r.series["folha_dev_qtd"];
    expect(q["2026-12"]).toBe(10);
    expect(q["2027-01"]).toBe(22);
  });

  it("POR VARIÁVEL: 1 pessoa a cada 50 unidades (arredonda p/ cima, com mínimo)", () => {
    const receitas: BlocoModelo = {
      id: "b1", tipo: "receitas", nome: "Receitas", ativo: true,
      config: {
        linhasReceita: [{
          id: "serv", nome: "Serviços", nodeRaiz: "s_receita",
          nodes: [
            { id: "s_clientes", tipo: "capacidade", nome: "Clientes ativos", unidade: "#", params: { valores: { "2026-01": 90, "2026-02": 140, "2026-03": 260 } } },
            { id: "s_receita", tipo: "formula", nome: "Receita", unidade: "R$", params: { expr: "s_clientes * 100" } },
          ],
        }],
      },
    };
    const folha: BlocoModelo = {
      id: "b9", tipo: "folha", nome: "Pessoas", ativo: true,
      config: { posicoes: [{ ...posBase, id: "sup", nome: "Suporte", encargosPct: 0, modoQtd: "variavel", variavelRef: "s_clientes", unidadesPorPessoa: 50, qtdMinima: 2 }] },
    };
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 3, blocks: [receitas, folha] });
    const q = r.series["folha_sup_qtd"];
    expect(q["2026-01"]).toBe(2); // ceil(90/50)=2
    expect(q["2026-02"]).toBe(3); // ceil(140/50)=3
    expect(q["2026-03"]).toBe(6); // ceil(260/50)=6
  });

  it("encargos por contrato + dissídio na data-base + entrada na DRE", () => {
    const folha: BlocoModelo = {
      id: "b9", tipo: "folha", nome: "Pessoas", ativo: true,
      config: {
        posicoes: [
          // CLT produção: encargos default 68%; dissídio 10% em janeiro
          { id: "op", nome: "Operador", classificacao: "custo", tipoContrato: "clt", salarioMensal: 2_000, dissidioAnual: 0.1, mesDissidio: 1, modoQtd: "ano", qtdPorAno: { "2026": 5 } },
          // PJ administrativo: 0% de encargos
          { id: "adm", nome: "Analista PJ", classificacao: "despesa", tipoContrato: "pj", salarioMensal: 8_000, modoQtd: "ano", qtdPorAno: { "2026": 2 } },
        ],
      },
    };
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), folha]));
    // jan/2026 (sem reajuste no início): 5 × 2.000 × 1,68 = 16.800
    expect(r.series["folha_op_custo"]["2026-01"]).toBeCloseTo(16_800, 4);
    // jan/2027: dissídio 10% → 5 × 2.200 × 1,68 = 18.480
    expect(r.series["folha_op_custo"]["2027-01"]).toBeCloseTo(18_480, 4);
    // PJ: 2 × 8.000 = 16.000, sem encargos
    expect(r.series["folha_adm_custo"]["2026-01"]).toBeCloseTo(16_000, 4);
    // DRE: folha produção nos custos; PJ adm nas despesas
    expect(r.dre.find((l) => l.id === "folha-custos")!.valores["2026-01"]).toBeCloseTo(16_800, 4);
    expect(r.dre.find((l) => l.id === "folha-despesas")!.valores["2026-01"]).toBeCloseTo(16_000, 4);
    expect(r.series["headcount_total"]["2026-01"]).toBe(7);
  });
});

describe("ordem da folha na DRE", () => {
  it("Folha e encargos é a PRIMEIRA linha aberta, logo abaixo do total do grupo", () => {
    const folha: BlocoModelo = {
      id: "b9", tipo: "folha", nome: "Pessoas", ativo: true,
      config: { posicoes: [{ id: "adm", nome: "Analista", classificacao: "despesa", tipoContrato: "pj", salarioMensal: 8_000, modoQtd: "ano", qtdPorAno: { "2026": 2 } }] },
    };
    const despesas: BlocoModelo = {
      id: "b4", tipo: "despesas", nome: "Despesas", ativo: true,
      config: { linhasCusto: [{ id: "mkt", nome: "Marketing", modo: "pctReceita", pct: 0.1 }] },
    };
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), despesas, folha]));
    const ids = r.dre.map((l) => l.id);
    expect(ids.indexOf("folha-despesas")).toBe(ids.indexOf("despesas-total") + 1); // logo abaixo do total
    expect(ids.indexOf("folha-despesas")).toBeLessThan(ids.indexOf("mkt"));
  });
});

describe("pessoas por variável: cobertura é POR MÊS", () => {
  it("pessoas = valor da variável no mês ÷ cobertura mensal (arredonda p/ cima)", () => {
    const receitas: BlocoModelo = {
      id: "b1", tipo: "receitas", nome: "Receitas", ativo: true,
      config: {
        linhasReceita: [{
          id: "v", nome: "Vendas", nodeRaiz: "v_r",
          nodes: [
            // vendas: 160/mês → ~1.920 no ano (fluxo, extensiva)
            { id: "v_qtd", tipo: "serie", nome: "Quantidade", unidade: "#", params: { valorMensal: 160 } },
            { id: "v_r", tipo: "formula", nome: "Receita", unidade: "R$", params: { expr: "v_qtd * 100" } },
          ],
        }],
      },
    };
    const folha: BlocoModelo = {
      id: "b9", tipo: "folha", nome: "Pessoas", ativo: true,
      config: {
        posicoes: [{ id: "an", nome: "Analista", classificacao: "despesa", tipoContrato: "pj", salarioMensal: 5_000, modoQtd: "variavel", variavelRef: "v_qtd", unidadesPorPessoa: 50 }],
      },
    };
    const r = calcularModelo(inputDe([receitas, folha]));
    // 160 vendas no mês ÷ 50 por pessoa/mês = 3,2 → 4 pessoas
    expect(r.series["folha_an_qtd"]["2026-06"]).toBe(4);
  });
});

describe("B8 — dívida por contrato", () => {
  const TAXA_1PCT_MES = Math.pow(1.01, 12) - 1; // a.a. cujo mensal composto = 1%

  function blocoDivida(contratos: object[]): BlocoModelo {
    return { id: "b10", tipo: "divida", nome: "Dívida", ativo: true, config: { contratos } as BlocoModelo["config"] };
  }

  it("SAC existente: quota fixa, juros decrescentes, saldo zera na última parcela", () => {
    const divida = blocoDivida([{
      id: "d1", nome: "Capital de giro", sistema: "sac",
      saldoInicial: 120_000, prazoMeses: 12, taxaAnual: TAXA_1PCT_MES,
    }]);
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), divida]));
    expect(r.erros).toEqual([]);
    // quota = 120.000/12 = 10.000; juros mês 1 = 120.000 × 1% = 1.200
    expect(r.series["divida_d1_juros"]["2026-01"]).toBeCloseTo(1_200, 2);
    expect(r.series["divida_d1_saldo"]["2026-01"]).toBeCloseTo(110_000, 2);
    // juros mês 2 sobre o saldo que sobrou: 110.000 × 1% = 1.100
    expect(r.series["divida_d1_juros"]["2026-02"]).toBeCloseTo(1_100, 2);
    // saldo zera em dez/26 e fica zero depois (sem juros)
    expect(r.series["divida_d1_saldo"]["2026-12"]).toBeCloseTo(0, 2);
    expect(r.series["divida_d1_juros"]["2027-03"]).toBeCloseTo(0, 2);
    expect(r.checks.find((c) => c.id === "divida-corkscrew")!.ok).toBe(true);
  });

  it("PRICE: parcela fixa (juros + amortização constantes) e saldo zera no fim", () => {
    const divida = blocoDivida([{
      id: "d2", nome: "Financiamento", sistema: "price",
      saldoInicial: 100_000, prazoMeses: 12, taxaAnual: TAXA_1PCT_MES,
    }]);
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), divida]));
    const juros = r.series["divida_d2_juros"];
    const amort = r.series["amortizacao_divida_total"];
    // PMT clássico: 100.000 × 1% / (1 − 1,01⁻¹²) = 8.884,88
    expect((juros["2026-01"] ?? 0) + (amort["2026-01"] ?? 0)).toBeCloseTo(8_884.88, 1);
    expect((juros["2026-06"] ?? 0) + (amort["2026-06"] ?? 0)).toBeCloseTo(8_884.88, 1);
    expect(r.series["divida_d2_saldo"]["2026-12"]).toBeCloseTo(0, 2);
  });

  it("BULLET captado no meio: captação no mês, juros no caminho, principal todo no vencimento", () => {
    const divida = blocoDivida([{
      id: "d3", nome: "Debênture", sistema: "bullet",
      principal: 50_000, mesCaptacao: "2026-03", prazoMeses: 6, taxaAnual: TAXA_1PCT_MES,
    }]);
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), divida]));
    expect(r.series["captacao_divida_total"]["2026-03"]).toBeCloseTo(50_000, 2);
    // captação do mês não paga juros no próprio mês
    expect(r.series["divida_d3_juros"]["2026-03"]).toBeCloseTo(0, 2);
    expect(r.series["divida_d3_juros"]["2026-04"]).toBeCloseTo(500, 2);
    // vencimento = captação + 6 meses (set/26): paga tudo, saldo zera
    expect(r.series["amortizacao_divida_total"]["2026-09"]).toBeCloseTo(50_000, 2);
    expect(r.series["divida_d3_saldo"]["2026-09"]).toBeCloseTo(0, 2);
    expect(r.series["divida_d3_saldo"]["2026-08"]).toBeCloseTo(50_000, 2);
  });

  it("carência: só juros até a 1ª parcela; DRE ganha juros e Resultado antes dos impostos", () => {
    const divida = blocoDivida([{
      id: "d4", nome: "BNDES", sistema: "sac",
      saldoInicial: 60_000, prazoMeses: 6, carenciaMeses: 3, taxaAnual: TAXA_1PCT_MES,
    }]);
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), divida]));
    // meses 1-3: sem amortização (saldo parado), só juros
    expect(r.series["divida_d4_saldo"]["2026-03"]).toBeCloseTo(60_000, 2);
    expect(r.series["divida_d4_saldo"]["2026-04"]).toBeCloseTo(50_000, 2); // 1ª quota 60k/6
    // DRE: juros abaixo do EBITDA e LAIR fecha a cascata
    const ids = r.dre.map((l) => l.id);
    expect(ids.indexOf("juros-divida")).toBeGreaterThan(ids.indexOf("ebitda"));
    expect(ids[ids.length - 1]).toBe("lair");
    const ebitda = r.dre.find((l) => l.id === "ebitda")!.valores["2026-01"];
    const lair = r.dre.find((l) => l.id === "lair")!.valores["2026-01"];
    expect(lair).toBeCloseTo(ebitda - 600, 2); // 60.000 × 1%
  });

  it("taxa POR ANO reprecifica os juros (ano sem valor cai na taxa base)", () => {
    const taxa2pct = Math.pow(1.02, 12) - 1;
    const divida = blocoDivida([{
      id: "d5", nome: "CDI+", sistema: "bullet",
      saldoInicial: 100_000, prazoMeses: 36, taxaAnual: TAXA_1PCT_MES,
      taxaPorAno: { "2027": taxa2pct },
    }]);
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), divida]));
    expect(r.series["divida_d5_juros"]["2026-06"]).toBeCloseTo(1_000, 1);
    expect(r.series["divida_d5_juros"]["2027-06"]).toBeCloseTo(2_000, 1);
  });

  it("sem contratos: nada de dívida na DRE nem nas séries", () => {
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), blocoDivida([])]));
    expect(r.series["divida_total"]).toBeUndefined();
    expect(r.dre.find((l) => l.id === "juros-divida")).toBeUndefined();
  });
});

describe("F2 — Fluxo de Caixa indireto + Balanço projetado (prova de fechamento)", () => {
  const modeloCompleto = (): BlocoModelo[] => [
    blocoReceitaSerie({ valorMensal: 200_000 }),
    { id: "b3", tipo: "custos", nome: "Custos", ativo: true, config: { linhasCusto: [{ id: "cmv", nome: "CMV", modo: "pctReceita", pct: 0.4 }] } },
    { id: "b6", tipo: "capex", nome: "Capex", ativo: true, config: { linhasCusto: [{ id: "maq", nome: "Máquinas", modo: "serie", valores: { "2026-02": 120_000 }, depreciacaoAnual: 0.1 }] } },
    { id: "b7", tipo: "giro", nome: "Giro", ativo: true, config: { pmr: 30, pme: 20, pmp: 25, caixaInicial: 50_000 } },
    { id: "b8", tipo: "divida", nome: "Dívida", ativo: true, config: { contratos: [{ id: "d1", nome: "Giro bancário", sistema: "price", saldoInicial: 300_000, prazoMeses: 24, taxaAnual: 0.15 }] } as BlocoModelo["config"] },
    { id: "b10", tipo: "impostos", nome: "Impostos", ativo: true, config: { impostos: { regime: "presumido", presuncaoIRPJ: 0.08, presuncaoCSLL: 0.12 } } as BlocoModelo["config"] },
  ];

  it("PROVA: Ativo = Passivo + PL em todos os meses (modelo com tudo ligado)", () => {
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 36, blocks: modeloCompleto() });
    expect(r.erros).toEqual([]);
    const check = r.checks.find((c) => c.id === "bp-fecha")!;
    expect(check.ok).toBe(true);
    // Conferência direta, mês a mês, fora do check:
    for (const mes of r.meses) {
      const dif = (r.series["bp_ativo"][mes] ?? 0) - (r.series["bp_passivo"][mes] ?? 0) - (r.series["bp_pl"][mes] ?? 0);
      expect(Math.abs(dif)).toBeLessThan(0.01);
    }
    // Caixa fim = caixa inicial + soma das variações (corkscrew fecha).
    const somaVar = r.meses.reduce((s, m) => s + (r.series["fc_variacao"][m] ?? 0), 0);
    const ultimo = r.meses[r.meses.length - 1];
    expect(r.series["caixa_final"][ultimo]).toBeCloseTo(50_000 + somaVar, 2);
    // FCO do mês = resultado + depreciação − ΔNCG (régua do método indireto).
    const m = "2026-06";
    const esperado = (r.series["lucro_liquido"][m] ?? 0) + (r.series["depreciacao_total"][m] ?? 0) - (r.series["delta_ncg"][m] ?? 0);
    expect(r.series["fc_fco"][m]).toBeCloseTo(esperado, 4);
    // Estruturas de exibição existem, com os grupos contábeis.
    expect(r.fc.find((l) => l.id === "fc-caixa-fim")).toBeDefined();
    expect(r.fc.find((l) => l.id === "fc-fci")).toBeDefined(); // FCI separado do FCF
    expect(r.bp.find((l) => l.id === "bp-ativo")!.nome).toBe("ATIVO");
    expect(r.bp.find((l) => l.id === "bp-ativo-circ")).toBeDefined();
    expect(r.bp.find((l) => l.id === "bp-passivo-nc")).toBeDefined();
    // AC + ANC = ATIVO e PC + PNC + PL = ATIVO, mês a mês.
    for (const mes of r.meses) {
      expect((r.series["bp_ativo_circulante"][mes] ?? 0) + (r.series["bp_ativo_nao_circulante"][mes] ?? 0)).toBeCloseTo(r.series["bp_ativo"][mes] ?? 0, 6);
      expect((r.series["bp_passivo_circulante"][mes] ?? 0) + (r.series["bp_passivo_nao_circulante"][mes] ?? 0) + (r.series["bp_pl"][mes] ?? 0)).toBeCloseTo(r.series["bp_ativo"][mes] ?? 0, 2);
    }
  });

  it("dívida no Balanço abre CURTO × LONGO prazo pelo cronograma de amortização", () => {
    // SAC 240k em 24 meses sem juros: quota 10k. No mês 1 (saldo 230k), os
    // próximos 12 meses amortizam 120k → CP 120k, LP 110k. No mês 13 (saldo
    // 110k), tudo vence em 12 meses → CP 110k, LP 0.
    const blocks: BlocoModelo[] = [
      blocoReceitaSerie({ valorMensal: 100_000 }),
      { id: "b8", tipo: "divida", nome: "Dívida", ativo: true, config: { contratos: [{ id: "d1", nome: "SAC", sistema: "sac", saldoInicial: 240_000, prazoMeses: 24, taxaAnual: 0 }] } as BlocoModelo["config"] },
    ];
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 24, blocks });
    expect(r.series["divida_cp_total"]["2026-01"]).toBeCloseTo(120_000, 2);
    expect(r.series["divida_lp_total"]["2026-01"]).toBeCloseTo(110_000, 2);
    expect(r.series["divida_cp_total"]["2027-01"]).toBeCloseTo(110_000, 2);
    expect(r.series["divida_lp_total"]["2027-01"]).toBeCloseTo(0, 2);
    expect(r.bp.find((l) => l.id === "bp-divida-cp")).toBeDefined();
    expect(r.bp.find((l) => l.id === "bp-divida-lp")).toBeDefined();
  });

  it("caixa NEGATIVO: o check aponta o vale (a operação não se paga)", () => {
    const blocks: BlocoModelo[] = [
      blocoReceitaSerie({ valorMensal: 10_000 }),
      { id: "b4", tipo: "despesas", nome: "Despesas", ativo: true, config: { linhasCusto: [{ id: "d1", nome: "Fixas", modo: "fixoReajuste", valorMensal: 50_000 }] } },
      { id: "b7", tipo: "giro", nome: "Giro", ativo: true, config: { pmr: 30, caixaInicial: 10_000 } },
    ];
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 12, blocks });
    const check = r.checks.find((c) => c.id === "caixa-minimo")!;
    expect(check.ok).toBe(false);
    expect(check.prova).toContain("NEGATIVO");
    expect(r.checks.find((c) => c.id === "bp-fecha")!.ok).toBe(true); // fecha mesmo no vermelho
  });

  it("OUTROS ITENS DO BALANÇO: prazo médio, constante e cronograma — e a prova segue fechando", () => {
    const giro: BlocoModelo = {
      id: "b7", tipo: "giro", nome: "Giro", ativo: true,
      config: {
        caixaInicial: 100_000,
        itensBalanco: [
          // Impostos a pagar por PRAZO MÉDIO sobre os impostos do mês (30 dias = 1 mês de imposto).
          { id: "imp", nome: "Impostos a pagar", classificacao: "pc", modo: "dias", base: "impostos", dias: 30 },
          // Mútuo parado no ativo não circulante.
          { id: "mutuo", nome: "Mútuo com controladora", classificacao: "anc", modo: "constante", saldo: 80_000 },
          // Adiantamento de clientes por prazo médio sobre a receita.
          { id: "adiant", nome: "Adiantamentos de clientes", classificacao: "pc", modo: "dias", base: "receita", dias: 15 },
          // Cronograma: saldo a receber liquidado em 2027.
          { id: "cron", nome: "Créditos a receber (acordo)", classificacao: "ac", modo: "porAno", saldoPorAno: { "2026": 60_000, "2027": 0 } },
        ],
      },
    };
    const r = calcularModelo({
      mesInicial: "2026-01", horizonteMeses: 24,
      blocks: [
        blocoReceitaSerie({ valorMensal: 100_000 }),
        { id: "b10", tipo: "impostos", nome: "Impostos", ativo: true, config: { impostos: { regime: "presumido", presuncaoIRPJ: 0.32, presuncaoCSLL: 0.32, issPct: 0.05 } } as BlocoModelo["config"] },
        giro,
      ],
    });
    expect(r.erros).toEqual([]);
    // Prazo médio: 30 dias = exatamente 1 mês de impostos (receita + IRPJ/CSLL).
    const impostosMes = (r.series["impostos_receita_total"]["2026-06"] ?? 0) + (r.series["irpj_csll_total"]["2026-06"] ?? 0);
    expect(r.series["bpitem_imp"]["2026-06"]).toBeCloseTo(impostosMes, 2);
    // Adiantamento: 15 dias = meia receita do mês.
    expect(r.series["bpitem_adiant"]["2026-06"]).toBeCloseTo(50_000, 2);
    // Cronograma: 60k em 2026, zero em 2027 — a liquidação DEVOLVE o caixa no FCO de jan/2027.
    expect(r.series["bpitem_cron"]["2026-12"]).toBeCloseTo(60_000, 2);
    expect(r.series["bpitem_cron"]["2027-01"]).toBeCloseTo(0, 2);
    const fcOutros = r.fc.find((l) => l.id === "fc-outros")!;
    expect(fcOutros.valores["2027-01"]).toBeCloseTo(60_000, 2); // ativo caiu → caixa entrou
    // Itens aparecem nos grupos certos do BP e a PROVA continua fechando.
    expect(r.bp.find((l) => l.id === "bp-item-mutuo")).toBeDefined();
    expect(r.checks.find((c) => c.id === "bp-fecha")!.ok).toBe(true);
  });

  it("modelo enxuto (só receita): FC = resultado e o balanço ainda fecha", () => {
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 })]));
    expect(r.series["fc_fco"]["2026-03"]).toBeCloseTo(r.series["v_receita"]["2026-03"], 4);
    expect(r.checks.find((c) => c.id === "bp-fecha")!.ok).toBe(true);
  });
});

describe("F3 — impostos (Simples, Presumido, Real)", () => {
  const blocoImp = (impostos: Record<string, unknown>): BlocoModelo =>
    ({ id: "b10", tipo: "impostos", nome: "Impostos", ativo: true, config: { impostos } as BlocoModelo["config"] });

  it("SIMPLES anexo III: alíquota efetiva da LC 123 sobre o RBT12 (janela móvel)", () => {
    // Receita 100k/mês, RBT12 inicial 1,2 mi → faixa 4 do anexo III: nominal 16%,
    // dedução 35.640 → efetiva = (1,2mi×0,16 − 35.640) ÷ 1,2mi = 13,03%.
    const r = calcularModelo(inputDe([
      blocoReceitaSerie({ valorMensal: 100_000 }),
      blocoImp({ regime: "simples", anexo: "III", rbt12Inicial: 1_200_000 }),
    ]));
    expect(r.erros).toEqual([]);
    const efetiva = (1_200_000 * 0.16 - 35_640) / 1_200_000;
    expect(r.series["aliquota_efetiva_simples"]["2026-01"]).toBeCloseTo(efetiva, 6);
    expect(r.dre.find((l) => l.id === "impostos-receita")!.valores["2026-01"]).toBeCloseTo(100_000 * efetiva, 2);
    expect(r.dre.find((l) => l.id === "receita-liquida")!.valores["2026-01"]).toBeCloseTo(100_000 * (1 - efetiva), 2);
    // Sem IRPJ separado no Simples; lucro líquido existe.
    expect(r.dre.find((l) => l.id === "irpj-csll")).toBeUndefined();
    expect(r.dre.find((l) => l.id === "lucro-liquido")).toBeDefined();
    expect(r.checks.find((c) => c.id === "impostos-regime")!.ok).toBe(true);
  });

  it("SIMPLES fator R: folha ≥ 28% da receita usa o anexo III (mais barato que o V)", () => {
    const folhaDe = (salario: number): BlocoModelo => ({
      id: "b9", tipo: "folha", nome: "Pessoas", ativo: true,
      config: { encargosPorContrato: { clt: 0 }, posicoes: [{ id: "p", nome: "Equipe", classificacao: "custo", tipoContrato: "clt", salarioMensal: salario, modoQtd: "ano", qtdPorAno: { "2026": 1 } }] },
    });
    const imp = blocoImp({ regime: "simples", anexo: "V", usarFatorR: true, rbt12Inicial: 1_200_000 });
    const comFolhaAlta = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), folhaDe(30_000), imp]));
    const comFolhaBaixa = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), folhaDe(10_000), imp]));
    const dasAlta = comFolhaAlta.dre.find((l) => l.id === "impostos-receita")!.valores["2026-06"];
    const dasBaixa = comFolhaBaixa.dre.find((l) => l.id === "impostos-receita")!.valores["2026-06"];
    expect(dasAlta).toBeLessThan(dasBaixa); // 30% de folha → anexo III; 10% → anexo V
  });

  it("SIMPLES acima do teto de 4,8 mi: check aponta a migração de regime", () => {
    const r = calcularModelo(inputDe([
      blocoReceitaSerie({ valorMensal: 450_000 }),
      blocoImp({ regime: "simples", anexo: "I", rbt12Inicial: 5_000_000 }),
    ]));
    const check = r.checks.find((c) => c.id === "impostos-regime")!;
    expect(check.ok).toBe(false);
    expect(check.prova).toContain("4,8");
  });

  it("PRESUMIDO serviços: PIS/COFINS+ISS na receita; IRPJ 15%+adicional e CSLL 9% na presunção", () => {
    const r = calcularModelo(inputDe([
      blocoReceitaSerie({ valorMensal: 100_000 }),
      blocoImp({ regime: "presumido", presuncaoIRPJ: 0.32, presuncaoCSLL: 0.32, issPct: 0.05 }),
    ]));
    // Sobre a receita: 3,65% + 5% = 8,65% → 8.650.
    expect(r.dre.find((l) => l.id === "impostos-receita")!.valores["2026-01"]).toBeCloseTo(8_650, 2);
    // IRPJ: base 32.000 → 15% = 4.800 + 10% de (32.000−20.000) = 1.200 → 6.000; CSLL: 32.000×9% = 2.880.
    expect(r.dre.find((l) => l.id === "irpj-csll")!.valores["2026-01"]).toBeCloseTo(6_000 + 2_880, 2);
    expect(r.dre.find((l) => l.id === "lucro-liquido")).toBeDefined();
  });

  it("PRESUMIDO acima de R$ 78 mi/ano: check aponta a obrigação do Lucro Real", () => {
    const r = calcularModelo(inputDe([
      blocoReceitaSerie({ valorMensal: 7_000_000 }), // 84 mi/ano
      blocoImp({ regime: "presumido", aplicarLC224: false }), // isola o teste do 78 mi
    ]));
    const check = r.checks.find((c) => c.id === "impostos-regime")!;
    expect(check.ok).toBe(false);
    expect(check.prova).toContain("78");
    // Sem a LC 224, a presunção não muda com o faturamento — segue 8%/12%:
    const baseIr = 7_000_000 * 0.08;
    const esperado = baseIr * 0.15 + (baseIr - 20_000) * 0.10 + 7_000_000 * 0.12 * 0.09;
    expect(r.dre.find((l) => l.id === "irpj-csll")!.valores["2026-01"]).toBeCloseTo(esperado, 2);
  });

  it("LC 224/2025: presunção +10% SÓ na parcela anual acima de R$ 5 mi (exemplo da lei)", () => {
    // Serviços (32%/32%), receita 1 mi/mês: o acumulado cruza 5 mi no mês 5 —
    // até lá presunção cheia; do mês 6 em diante, o mês inteiro é excedente
    // (base 35,2%). No ANO: 5 mi a 32% + 7 mi a 35,2% (régua exata da lei).
    const r = calcularModelo(inputDe([
      blocoReceitaSerie({ valorMensal: 1_000_000 }),
      blocoImp({ regime: "presumido", presuncaoIRPJ: 0.32, presuncaoCSLL: 0.32 }),
    ]));
    const linha = r.dre.find((l) => l.id === "irpj-csll")!.valores;
    const irpjCsllDe = (baseIr: number, baseCs: number) => baseIr * 0.15 + Math.max(0, baseIr - 20_000) * 0.10 + baseCs * 0.09;
    expect(linha["2026-04"]).toBeCloseTo(irpjCsllDe(320_000, 320_000), 2);   // dentro dos 5 mi: 32%
    expect(linha["2026-06"]).toBeCloseTo(irpjCsllDe(352_000, 352_000), 2);   // excedente: 32% × 1,10 = 35,2%
    // Desligando (empresa com liminar), o mês 6 volta à presunção cheia:
    const sem = calcularModelo(inputDe([
      blocoReceitaSerie({ valorMensal: 1_000_000 }),
      blocoImp({ regime: "presumido", presuncaoIRPJ: 0.32, presuncaoCSLL: 0.32, aplicarLC224: false }),
    ]));
    expect(sem.dre.find((l) => l.id === "irpj-csll")!.valores["2026-06"]).toBeCloseTo(irpjCsllDe(320_000, 320_000), 2);
  });

  it("REAL: prejuízo fiscal acumula e compensa com a trava de 30%", () => {
    // Meses 1-2: custos 150k > receita 100k → LAIR −50k/mês (prejuízo 100k).
    // Mês 3 em diante: custos 0 → base 100k, compensa 30k → 70k tributáveis.
    const custos: BlocoModelo = {
      id: "b3", tipo: "custos", nome: "Custos", ativo: true,
      config: { linhasCusto: [{ id: "c1", nome: "Custos", modo: "serie", valores: { "2026-01": 150_000, "2026-02": 150_000 } }] },
    };
    const r = calcularModelo(inputDe([
      blocoReceitaSerie({ valorMensal: 100_000 }),
      custos,
      blocoImp({ regime: "real", pisCofinsPct: 0 }),
    ]));
    expect(r.series["prejuizo_fiscal_acumulado"]["2026-02"]).toBeCloseTo(100_000, 2);
    // Mês 3: IRPJ 70k×15% + (70k−20k)×10% = 15.500; CSLL 70k×9% = 6.300.
    expect(r.dre.find((l) => l.id === "irpj-csll")!.valores["2026-03"]).toBeCloseTo(21_800, 2);
    expect(r.series["prejuizo_fiscal_acumulado"]["2026-03"]).toBeCloseTo(70_000, 2);
    // Lucro líquido do mês 3 = 100k − 21,8k.
    expect(r.dre.find((l) => l.id === "lucro-liquido")!.valores["2026-03"]).toBeCloseTo(78_200, 2);
  });

  it("sem regime configurado, a DRE não muda (retrocompatível)", () => {
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), blocoImp({})]));
    expect(r.dre.find((l) => l.id === "impostos-receita")).toBeUndefined();
    expect(r.dre.find((l) => l.id === "lucro-liquido")).toBeUndefined();
    expect(r.dre.find((l) => l.id === "lucro-bruto")!.valores["2026-01"]).toBeCloseTo(100_000, 2);
  });
});

describe("fixo + reajuste pelo ÍNDICE OFICIAL (snapshot BCB)", () => {
  it("reajusteIndice=igpm: aluguel corrige na virada do ano pelo % do snapshot", () => {
    const despesas: BlocoModelo = {
      id: "b4", tipo: "despesas", nome: "Despesas", ativo: true,
      config: { linhasCusto: [{ id: "alug", nome: "Aluguel", modo: "fixoReajuste", valorMensal: 1_000, reajusteIndice: "igpm" }] },
    };
    const r = calcularModelo({
      mesInicial: "2026-01", horizonteMeses: 36,
      blocks: [blocoReceitaSerie({ valorMensal: 100_000 }), despesas],
      indicesMacro: { indices: { igpm: { "2026": 10, "2027": 5 } } }, // %-números
    });
    const alug = r.dre.find((l) => l.id === "alug")!.valores;
    expect(alug["2026-06"]).toBeCloseTo(1_000, 4);        // 1º ano = base
    expect(alug["2027-06"]).toBeCloseTo(1_100, 4);        // virada de 2027 corrige pelo IGP-M de 2026 (10%)
    expect(alug["2028-06"]).toBeCloseTo(1_100 * 1.05, 4); // virada de 2028 pelo IGP-M de 2027 (5%)
  });

  it("headcount_total soma TODAS as posições (premissa E por variável) e puxa custo", () => {
    const folha: BlocoModelo = {
      id: "b9", tipo: "folha", nome: "Pessoas", ativo: true,
      config: {
        encargosPorContrato: { clt: 0 },
        posicoes: [
          { id: "a", nome: "A", classificacao: "despesa", tipoContrato: "clt", salarioMensal: 1_000, modoQtd: "ano", qtdPorAno: { "2026": 6 } },
          // Vendedores: 100.000 de receita ÷ 25.000 por pessoa = 4.
          { id: "v", nome: "Vendedor", classificacao: "despesa", tipoContrato: "clt", salarioMensal: 1_000, modoQtd: "variavel", variavelRef: "v_receita", unidadesPorPessoa: 25_000 },
        ],
      },
    };
    const aluguel: BlocoModelo = {
      id: "b4", tipo: "despesas", nome: "Despesas", ativo: true,
      config: {
        linhasReceita: [{
          id: "alug", nome: "Aluguel por pessoa", template: "porVariavel", nodeRaiz: "al_r",
          nodes: [
            { id: "al_unit", tipo: "preco", nome: "R$ por pessoa", unidade: "R$/un", params: { valorMensal: 150 } },
            { id: "al_r", tipo: "formula", nome: "Total", unidade: "R$", params: { expr: "headcount_total * al_unit" } },
          ],
        }],
      },
    };
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), folha, aluguel]));
    expect(r.erros).toEqual([]);
    expect(r.series["headcount_total"]["2026-06"]).toBe(10); // 6 + 4
    expect(r.dre.find((l) => l.id === "alug")!.valores["2026-06"]).toBeCloseTo(1_500, 4);
  });

  it("sem snapshot, reajusteIndice cai nos %s manuais (nunca trava o modelo)", () => {
    const despesas: BlocoModelo = {
      id: "b4", tipo: "despesas", nome: "Despesas", ativo: true,
      config: { linhasCusto: [{ id: "alug", nome: "Aluguel", modo: "fixoReajuste", valorMensal: 1_000, reajusteIndice: "igpm", reajusteAnual: 0.08 }] },
    };
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 24, blocks: [blocoReceitaSerie({ valorMensal: 100_000 }), despesas] });
    expect(r.dre.find((l) => l.id === "alug")!.valores["2027-06"]).toBeCloseTo(1_080, 4);
  });
});

describe("headcount por premissa como variável do negócio", () => {
  const folhaDev = (modoQtd: "ano" | "variavel"): BlocoModelo => ({
    id: "b9", tipo: "folha", nome: "Pessoas", ativo: true,
    config: {
      encargosPorContrato: { clt: 0 },
      posicoes: [{
        id: "dev", nome: "Desenvolvedor", classificacao: "despesa", tipoContrato: "clt",
        salarioMensal: 1_000, modoQtd,
        ...(modoQtd === "ano" ? { qtdPorAno: { "2026": 10 } } : { variavelRef: "v_receita", unidadesPorPessoa: 10_000 }),
      }],
    },
  });
  const custoTI: BlocoModelo = {
    id: "b3", tipo: "custos", nome: "Custos", ativo: true,
    config: {
      linhasReceita: [{
        id: "ti", nome: "Licenças de TI", template: "porVariavel", nodeRaiz: "ti_r",
        nodes: [
          { id: "ti_unit", tipo: "preco", nome: "Custo por pessoa", unidade: "R$/un", params: { valorMensal: 200 } },
          { id: "ti_r", tipo: "formula", nome: "Total", unidade: "R$", params: { expr: "folha_dev_qtd * ti_unit" } },
        ],
      }],
    },
  };

  it("posição POR ANO puxa custo: pessoas × R$/pessoa (mesma quantidade da folha)", () => {
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), folhaDev("ano"), custoTI]));
    expect(r.erros).toEqual([]);
    expect(r.checks.find((c) => c.id === "grafo-orfaos")!.ok).toBe(true);
    expect(r.series["folha_dev_qtd"]["2026-06"]).toBe(10);
    expect(r.dre.find((l) => l.id === "ti")!.valores["2026-06"]).toBeCloseTo(10 * 200, 4);
  });

  it("posição POR VARIÁVEL também é variável do negócio (avaliada em cadeia no grafo)", () => {
    // receita 100.000/mês ÷ 10.000 por pessoa = 10 pessoas → custo TI = 10 × 200.
    const r = calcularModelo(inputDe([blocoReceitaSerie({ valorMensal: 100_000 }), folhaDev("variavel"), custoTI]));
    expect(r.erros).toEqual([]);
    expect(r.checks.find((c) => c.id === "grafo-orfaos")!.ok).toBe(true);
    expect(r.series["folha_dev_qtd"]["2026-06"]).toBe(10);
    expect(r.dre.find((l) => l.id === "ti")!.valores["2026-06"]).toBeCloseTo(10 * 200, 4);
    // E a folha usa o MESMO número do grafo (fonte única — zero divergência).
    expect(r.series["folha_dev_custo"]["2026-06"]).toBeCloseTo(10 * 1_000, 4);
  });
});

describe("índices macro (snapshot BCB) como variáveis de fórmula", () => {
  // 12,682503...% a.a. → mensal equivalente EXATAMENTE 1% ((1,01)^12 − 1).
  const AA_1PCT_MES = (Math.pow(1.01, 12) - 1) * 100;
  const snapshot = {
    atualizadoEm: "2026-07-11T12:00:00Z",
    cambioAtual: 5.0,
    indices: {
      igpm: { "2026": AA_1PCT_MES },
      cambioNivel: { "2026": 6.0 },
    },
  };

  function blocoAluguel(expr: string): BlocoModelo {
    return {
      id: "b1", tipo: "receitas", nome: "Receitas", ativo: true,
      config: {
        linhasReceita: [{
          id: "alug", nome: "Aluguel", template: "personalizada", nodeRaiz: "alug_r",
          nodes: [
            { id: "alug_base", tipo: "preco", nome: "Aluguel base", unidade: "R$", params: { valorMensal: 1000 } },
            { id: "alug_r", tipo: "formula", nome: "Receita", unidade: "R$", params: { expr } },
          ],
        }],
      },
    };
  }

  it("aluguel corrigido pelo IGP-M: base × fator acumulado (1º mês = 1, depois compõe)", () => {
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 12, blocks: [blocoAluguel("alug_base * macro_igpm_acum")], indicesMacro: snapshot });
    expect(r.erros).toEqual([]);
    expect(r.series["alug_r"]["2026-01"]).toBeCloseTo(1000, 4);
    expect(r.series["alug_r"]["2026-02"]).toBeCloseTo(1010, 4);
    expect(r.series["alug_r"]["2026-12"]).toBeCloseTo(1000 * Math.pow(1.01, 11), 4);
  });

  it("taxa mensal equivalente: 12 meses compostos fecham o ano do snapshot", () => {
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 12, blocks: [blocoAluguel("alug_base * (1 + macro_igpm)")], indicesMacro: snapshot });
    expect(r.erros).toEqual([]);
    expect(r.series["macro_igpm"]["2026-06"]).toBeCloseTo(0.01, 10);
    expect(r.series["alug_r"]["2026-03"]).toBeCloseTo(1010, 4);
  });

  it("ano ALÉM do snapshot repete o último; câmbio interpola da PTAX ao fim do ano", () => {
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 24, blocks: [blocoAluguel("alug_base * macro_igpm_acum")], indicesMacro: snapshot });
    expect(r.series["macro_igpm"]["2027-06"]).toBeCloseTo(0.01, 10); // 2027 repete 2026
    // Câmbio: base 5,00 (PTAX) → 6,00 no fim de 2026, linear; 2027 fica em 6,00.
    expect(r.series["macro_cambio"]["2026-06"]).toBeCloseTo(5 + 1 * (6 / 12), 6);
    expect(r.series["macro_cambio"]["2026-12"]).toBeCloseTo(6.0, 6);
    expect(r.series["macro_cambio"]["2027-06"]).toBeCloseTo(6.0, 6);
  });

  it("sem snapshot, referência macro_* vira erro apontado (check de órfãos)", () => {
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 12, blocks: [blocoAluguel("alug_base * macro_igpm_acum")] });
    const check = r.checks.find((c) => c.id === "grafo-orfaos")!;
    expect(check.ok).toBe(false);
    expect(check.prova).toContain("macro_igpm_acum");
  });
});

describe("backfill de premissas ao RECUAR o início", () => {
  function blocoComMeses(valores: Record<string, number>): BlocoModelo {
    return {
      id: "b1", tipo: "receitas", nome: "Receitas", ativo: true,
      config: {
        linhasReceita: [{
          id: "lin1", nome: "Vendas", nodeRaiz: "v_r",
          nodes: [
            { id: "v_qtd", tipo: "serie", nome: "Quantidade", unidade: "#", params: { modoPreenchimento: "ano", valores: { ...valores } } },
            { id: "v_r", tipo: "formula", nome: "Receita", unidade: "R$", params: { expr: "v_qtd * 100" } },
          ],
        }],
      },
    };
  }

  it("meses novos repetem PARA TRÁS o primeiro mês informado (não viram zero)", () => {
    const bloco = blocoComMeses({ "2026-06": 83.33, "2026-07": 83.33, "2026-08": 83.33 });
    const memoria = backfillPremissasAoRecuar([bloco], "2026-01", "2026-06");
    const v = bloco.config.linhasReceita![0].nodes[0].params.valores as Record<string, number>;
    expect(v["2026-01"]).toBeCloseTo(83.33, 4);
    expect(v["2026-05"]).toBeCloseTo(83.33, 4);
    expect(v["2026-06"]).toBeCloseTo(83.33, 4); // originais intactos
    expect(memoria).toHaveLength(1);
    expect(memoria[0].blocoId).toBe("b1");
    // O motor passa a projetar os meses novos com a premissa (nada de zero).
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 12, blocks: [bloco] });
    expect(r.series["v_r"]["2026-01"]).toBeCloseTo(8_333, 0);
  });

  it("mês novo que JÁ tem valor explícito é preservado (voltar atrás não perde dado)", () => {
    const bloco = blocoComMeses({ "2026-03": 50, "2026-06": 80 });
    backfillPremissasAoRecuar([bloco], "2026-01", "2026-06");
    const v = bloco.config.linhasReceita![0].nodes[0].params.valores as Record<string, number>;
    expect(v["2026-03"]).toBe(50);  // digitado antes: intacto
    expect(v["2026-01"]).toBe(50);  // preenche só ANTES do primeiro informado
    expect(v["2026-04"]).toBeUndefined(); // buraco interno não é tapado
  });

  it("linhas de custo modo série também recebem o backfill", () => {
    const custos: BlocoModelo = {
      id: "b3", tipo: "custos", nome: "Custos", ativo: true,
      config: { linhasCusto: [{ id: "c1", nome: "Frete", modo: "serie", valores: { "2026-06": 1_000 } }] },
    };
    const memoria = backfillPremissasAoRecuar([custos], "2026-04", "2026-06");
    expect(custos.config.linhasCusto![0].valores!["2026-04"]).toBe(1_000);
    expect(custos.config.linhasCusto![0].valores!["2026-05"]).toBe(1_000);
    expect(memoria).toHaveLength(1);
  });

  it("início AVANÇANDO (ou igual) não mexe em nada", () => {
    const bloco = blocoComMeses({ "2026-01": 10 });
    expect(backfillPremissasAoRecuar([bloco], "2026-06", "2026-01")).toEqual([]);
    expect(backfillPremissasAoRecuar([bloco], "2026-01", "2026-01")).toEqual([]);
    const v = bloco.config.linhasReceita![0].nodes[0].params.valores as Record<string, number>;
    expect(Object.keys(v)).toEqual(["2026-01"]);
  });
});

describe("mês de início da projeção", () => {
  it("TUDO parte do mês de início: receita, custo e folha começam nele (nenhum mês antes)", () => {
    const custos: BlocoModelo = {
      id: "b3", tipo: "custos", nome: "Custos", ativo: true,
      config: { linhasCusto: [{ id: "cmv", nome: "CMV", modo: "pctReceita", pct: 0.4 }] },
    };
    const folha: BlocoModelo = {
      id: "b9", tipo: "folha", nome: "Pessoas", ativo: true,
      config: {
        encargosPorContrato: { clt: 0 },
        posicoes: [{
          id: "op", nome: "Operador", classificacao: "custo", tipoContrato: "clt",
          salarioMensal: 2_000, salarioPorAno: { "2026": 2_500 },
          modoQtd: "ano", qtdPorAno: { "2026": 4, "2027": 10 }, distribuicao: "rampa",
        }],
      },
    };
    const r = calcularModelo({
      mesInicial: "2026-07",
      horizonteMeses: 18, // jul/26 – dez/27
      blocks: [blocoReceitaSerie({ modoPreenchimento: "ano", valoresAno: { "2026": 60_000 } }), custos, folha],
    });
    expect(r.erros).toEqual([]);
    // O horizonte começa exatamente no mês de início — nada antes dele.
    expect(r.meses[0]).toBe("2026-07");
    expect(r.meses).toHaveLength(18);
    expect(r.series["v_receita"]["2026-06"]).toBeUndefined();
    // Receita anual distribui pelos 6 meses do ano parcial (10.000/mês).
    expect(r.series["v_receita"]["2026-07"]).toBeCloseTo(10_000, 2);
    // Custo % receita acompanha desde o 1º mês.
    expect(r.dre.find((l) => l.id === "cmv")!.valores["2026-07"]).toBeCloseTo(4_000, 2);
    // Folha: alvo do 1º ano vale desde o mês de início; salário do ano digitado
    // aplica já no 1º mês do horizonte (i = 0, mesmo fora de janeiro).
    expect(r.series["folha_op_qtd"]["2026-07"]).toBe(4);
    expect(r.series["folha_op_custo"]["2026-07"]).toBeCloseTo(4 * 2_500, 4);
    // Rampa do 2º ano parte do fim do 1º (4 → 10 ao longo de 2027, dez = alvo).
    expect(r.series["folha_op_qtd"]["2027-01"]).toBe(5);
    expect(r.series["folha_op_qtd"]["2027-12"]).toBe(10);
  });
});

describe("salário por ano", () => {
  it("ano digitado manda (desde janeiro); ano vazio herda + dissídio na data-base", () => {
    const folha: BlocoModelo = {
      id: "b9", tipo: "folha", nome: "Pessoas", ativo: true,
      config: {
        encargosPorContrato: { clt: 0 },
        posicoes: [{
          id: "an", nome: "Analista", classificacao: "despesa", tipoContrato: "clt",
          salarioMensal: 1_500, salarioPorAno: { "2028": 2_000 }, dissidioAnual: 0.1, mesDissidio: 1,
          modoQtd: "ano", qtdPorAno: { "2026": 1 },
        }],
      },
    };
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 48, blocks: [blocoReceitaSerie({ valorMensal: 100_000 }), folha] });
    const c = r.series["folha_an_custo"];
    expect(c["2026-06"]).toBeCloseTo(1_500, 4);   // ponto de partida
    expect(c["2027-06"]).toBeCloseTo(1_650, 4);   // ano vazio: dissídio 10%
    expect(c["2028-06"]).toBeCloseTo(2_000, 4);   // digitado MANDA (sem dissídio em cima)
    // 2029 vazio: herda 2.000 e dissídio corrige → 2.200
    expect(c["2029-06"]).toBeCloseTo(2_200, 4);
  });
});
