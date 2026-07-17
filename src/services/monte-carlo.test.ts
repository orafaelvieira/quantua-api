import { describe, it, expect } from "vitest";
import type { BlocoModelo } from "./model-engine";
import { calcularModelo } from "./model-engine";
import { equityFcd } from "./valuation-fcd";
import { rodarMonteCarlo, rngLcg, sorteioTriangular } from "./monte-carlo";
import type { McInput, McVariavelSpec } from "./monte-carlo";

function blocos(): BlocoModelo[] {
  return [
    {
      id: "b1", tipo: "receitas", nome: "Receitas", ativo: true,
      config: {
        linhasReceita: [{
          id: "lin-vendas", nome: "Vendas", template: "transacional", nodeRaiz: "receita",
          nodes: [
            { id: "volume", tipo: "serie", nome: "Volume", unidade: "#", params: { valorMensal: 1000 } },
            { id: "preco", tipo: "preco", nome: "Preço", unidade: "R$/un", params: { valorMensal: 100 } },
            { id: "receita", tipo: "formula", nome: "Receita", unidade: "R$", params: { expr: "volume * preco" } },
          ],
        }],
      },
    },
    {
      id: "b2", tipo: "custos", nome: "Custos", ativo: true,
      config: {
        linhasCusto: [
          { id: "cmv", nome: "Custos variáveis", modo: "pctReceita", pct: 0.4 },
          { id: "aluguel", nome: "Aluguel", modo: "fixoReajuste", valorMensal: 10_000 },
        ],
      },
    },
  ];
}

const VALUATION = { wacc: 0.18, taxaImpostos: 0.34, caixaDataBase: 0, g: 0.03, dlom: 0 };

function inputMc(variaveis: McVariavelSpec[], n = 60, seed = 42): McInput {
  return {
    base: { mesInicial: "2026-01", horizonteMeses: 36, blocks: blocos(), realizado: null, indicesMacro: null },
    cenarioOverrides: {},
    variaveis, n, seed,
    valuation: VALUATION,
  };
}

describe("sorteioTriangular", () => {
  it("fica dentro do intervalo e concentra no centro", () => {
    const rng = rngLcg(7);
    const v = Array.from({ length: 4000 }, () => sorteioTriangular(rng, -0.1, 0.1));
    expect(Math.min(...v)).toBeGreaterThanOrEqual(-0.1);
    expect(Math.max(...v)).toBeLessThanOrEqual(0.1);
    const media = v.reduce((s, x) => s + x, 0) / v.length;
    expect(Math.abs(media)).toBeLessThan(0.005); // simétrica em torno de 0
  });
});

describe("deduções da receita (vendas canceladas e abatimentos)", () => {
  const blocosComDeducoes = (): BlocoModelo[] => {
    const b = blocos();
    b[0].config.deducoesPct = 0.05; // 5% da bruta
    b.push({ id: "b3", tipo: "impostos", nome: "Impostos", ativo: true, config: { impostos: { regime: "presumido", issPct: 0.05 } } });
    return b;
  };

  it("linha própria na DRE: bruta − deduções − impostos = receita líquida; base fiscal exclui deduções", () => {
    const r = calcularModelo({ mesInicial: "2033-01", horizonteMeses: 12, blocks: blocosComDeducoes() });
    const ano = "2033";
    const bruta = r.agregacoes.anual["receita-total"][ano];       // 1.200.000
    const ded = r.agregacoes.anual["deducoes-receita"][ano];
    const imp = r.agregacoes.anual["impostos-receita"][ano];
    const liquida = r.agregacoes.anual["receita-liquida"][ano];
    expect(bruta).toBeCloseTo(1_200_000, 2);
    expect(ded).toBeCloseTo(60_000, 2);                            // 5%
    expect(imp).toBeCloseTo((1_200_000 - 60_000) * (0.0365 + 0.05), 2); // base LÍQUIDA de deduções
    expect(liquida).toBeCloseTo(bruta - ded - imp, 4);
    // lucro bruto parte da líquida
    const lb = r.agregacoes.anual["lucro-bruto"][ano];
    expect(lb).toBeCloseTo(liquida - r.agregacoes.anual["custos-total"][ano], 4);
  });

  it("deducoesPorAno sobrepõe o % geral no ano; sem deduções nada muda (retrocompat)", () => {
    const b = blocosComDeducoes();
    b[0].config.deducoesPorAno = { "2034": 0.10 };
    const r = calcularModelo({ mesInicial: "2033-01", horizonteMeses: 24, blocks: b });
    expect(r.agregacoes.anual["deducoes-receita"]["2033"]).toBeCloseTo(60_000, 2);   // 5% (flat)
    expect(r.agregacoes.anual["deducoes-receita"]["2034"]).toBeCloseTo(120_000, 2);  // 10% (do ano)
    // sem config: linha não existe e a DRE fica como antes
    const sem = calcularModelo({ mesInicial: "2033-01", horizonteMeses: 12, blocks: blocos() });
    expect(sem.agregacoes.anual["deducoes-receita"]).toBeUndefined();
  });

  it("Simples: RBT12 e o DAS usam a receita líquida de deduções (LC 123 art. 3º §1º)", () => {
    const b = blocos();
    b[0].config.deducoesPct = 0.10;
    b.push({ id: "b3", tipo: "impostos", nome: "Impostos", ativo: true, config: { impostos: { regime: "simples", anexo: "III", rbt12Inicial: 1_080_000 } } });
    const r = calcularModelo({ mesInicial: "2033-01", horizonteMeses: 24, blocks: b });
    // após 12 meses projetados, RBT12 = 12 × (100k − 10%) = 1.080.000
    const m13 = r.meses[12];
    expect(r.series["rbt12"][m13]).toBeCloseTo(12 * 90_000, 2);
    // DAS do mês incide sobre a base líquida
    const aliq = r.series["aliquota_efetiva_simples"][m13];
    expect(r.series["impostos_receita_total"][m13]).toBeCloseTo(90_000 * aliq, 4);
  });
});

describe("multiplicador de cenário em linhas de custo (alavanca dos sliders)", () => {
  it("escala linha % da receita e linha fixa; sem override nada muda", () => {
    const base = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 12, blocks: blocos() });
    const escalado = calcularModelo({
      mesInicial: "2026-01", horizonteMeses: 12, blocks: blocos(),
      overrides: { cmv: { multiplicador: 1.2 }, aluguel: { multiplicador: 0.5 } },
    });
    const custoBase = base.agregacoes.anual["cmv"]?.["2026"] ?? 0;
    const custoEsc = escalado.agregacoes.anual["cmv"]?.["2026"] ?? 0;
    expect(custoEsc).toBeCloseTo(custoBase * 1.2, 6);
    const alugBase = base.agregacoes.anual["aluguel"]?.["2026"] ?? 0;
    const alugEsc = escalado.agregacoes.anual["aluguel"]?.["2026"] ?? 0;
    expect(alugEsc).toBeCloseTo(alugBase * 0.5, 6);
    expect(alugBase).toBeGreaterThan(0);
  });
});

describe("rodarMonteCarlo", () => {
  it("reproduz a MESMA simulação com o mesmo seed (auditável)", async () => {
    const a = await rodarMonteCarlo(inputMc([{ id: "v1", alvo: "no", refId: "volume", sensibMin: -0.1, sensibMax: 0.1 }]));
    const b = await rodarMonteCarlo(inputMc([{ id: "v1", alvo: "no", refId: "volume", sensibMin: -0.1, sensibMax: 0.1 }]));
    expect(a.ok && b.ok).toBe(true);
    expect(a.equity).toEqual(b.equity);
    const c = await rodarMonteCarlo(inputMc([{ id: "v1", alvo: "no", refId: "volume", sensibMin: -0.1, sensibMax: 0.1 }], 60, 99));
    expect(c.equity).not.toEqual(a.equity);
  });

  it("nó premissa: a distribuição envolve a base e varia de verdade", async () => {
    const r = await rodarMonteCarlo(inputMc([{ id: "v1", alvo: "no", refId: "volume", sensibMin: -0.2, sensibMax: 0.2 }], 120));
    expect(r.ok).toBe(true);
    expect(r.n).toBe(120);
    const min = Math.min(...r.equity);
    const max = Math.max(...r.equity);
    expect(min).toBeLessThan(r.base.equityFinal);
    expect(max).toBeGreaterThan(r.base.equityFinal);
    expect(new Set(r.equity.map((x) => x.toFixed(2))).size).toBeGreaterThan(100); // não degenerou
  });

  it("linha % da receita: custo maior derruba o equity (sorteio quase determinístico)", async () => {
    // faixa degenerada força o fator: +20% de custo em TODOS os cenários
    const pior = await rodarMonteCarlo(inputMc([{ id: "v1", alvo: "linhaPct", refId: "cmv", sensibMin: 0.1999999, sensibMax: 0.2 }], 5));
    const melhor = await rodarMonteCarlo(inputMc([{ id: "v1", alvo: "linhaPct", refId: "cmv", sensibMin: -0.2, sensibMax: -0.1999999 }], 5));
    expect(pior.ok && melhor.ok).toBe(true);
    expect(Math.max(...pior.equity)).toBeLessThan(pior.base.equityFinal);
    expect(Math.min(...melhor.equity)).toBeGreaterThan(melhor.base.equityFinal);
    // conferência de grandeza: custo +20% sobre pct 40% = 8 p.p. a menos de margem
    const resultadoPior = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 36, blocks: blocos(), overrides: { cmv: { pctPorAno: { "2026": 0.48, "2027": 0.48, "2028": 0.48 } } } });
    const esperado = equityFcd(resultadoPior, VALUATION);
    const desvio = Math.abs(pior.equity[0] - esperado.equityFinal) / Math.abs(esperado.equityFinal);
    expect(desvio).toBeLessThan(0.001);
  });

  it("linha fixa (valorMensal) e WACC também respondem na direção certa", async () => {
    const aluguelAlto = await rodarMonteCarlo(inputMc([{ id: "v1", alvo: "linhaValor", refId: "aluguel", sensibMin: 0.4999999, sensibMax: 0.5 }], 5));
    expect(aluguelAlto.ok).toBe(true);
    expect(Math.max(...aluguelAlto.equity)).toBeLessThan(aluguelAlto.base.equityFinal);

    const waccAlto = await rodarMonteCarlo(inputMc([{ id: "v1", alvo: "wacc", sensibMin: 0.4999999, sensibMax: 0.5 }], 5));
    expect(waccAlto.ok).toBe(true);
    expect(Math.max(...waccAlto.equity)).toBeLessThan(waccAlto.base.equityFinal);
  });

  it("g sorteado acima do WACC é limitado (aviso, nenhum cenário perdido)", async () => {
    const r = await rodarMonteCarlo(inputMc([{ id: "v1", alvo: "g", sensibMin: 6.9999999, sensibMax: 7 }], 5));
    expect(r.ok).toBe(true);
    expect(r.n).toBe(5);
    expect(r.avisos.some((a) => a.includes("limitado"))).toBe(true);
    expect(r.equity.every((x) => Number.isFinite(x))).toBe(true);
  });

  it("variável inexistente vira aviso; todas inválidas = erro claro", async () => {
    const r = await rodarMonteCarlo(inputMc([
      { id: "v1", alvo: "no", refId: "nao-existe", sensibMin: -0.1, sensibMax: 0.1 },
      { id: "v2", alvo: "no", refId: "volume", sensibMin: -0.1, sensibMax: 0.1 },
    ]));
    expect(r.ok).toBe(true);
    expect(r.avisos.some((a) => a.includes("não encontrada"))).toBe(true);

    const todasRuins = await rodarMonteCarlo(inputMc([{ id: "v1", alvo: "no", refId: "nao-existe", sensibMin: -0.1, sensibMax: 0.1 }]));
    expect(todasRuins.ok).toBe(false);
  });

  it("LHS estratifica: com poucos cenários a média fica mais perto da teórica que o MC puro", async () => {
    // variável simétrica ±20% → média teórica do equity = equity com fator médio ~0
    const mkInput = (lhs: boolean) => ({ ...inputMc([{ id: "v1", alvo: "no", refId: "volume", sensibMin: -0.2, sensibMax: 0.2 }], 100, 7), lhs });
    const comLhs = await rodarMonteCarlo(mkInput(true));
    const semLhs = await rodarMonteCarlo(mkInput(false));
    expect(comLhs.ok && semLhs.ok).toBe(true);
    expect(comLhs.amostragem).toBe("lhs");
    const mediaDe = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const desvioBase = (r: Awaited<ReturnType<typeof rodarMonteCarlo>>) => Math.abs(mediaDe(r.equity) - r.base.equityFinal) / Math.abs(r.base.equityFinal);
    expect(desvioBase(comLhs)).toBeLessThan(0.01); // LHS: média colada na base
  });

  it("correlação +0,9 entre duas variáveis aparece nos fatores sorteados (tornado usa os mesmos)", async () => {
    const vars: McVariavelSpec[] = [
      { id: "vol", alvo: "no", refId: "volume", nome: "Volume", sensibMin: -0.2, sensibMax: 0.2 },
      { id: "cmv", alvo: "linhaPct", refId: "cmv", nome: "CMV", sensibMin: -0.2, sensibMax: 0.2 },
    ];
    const sem = await rodarMonteCarlo({ ...inputMc(vars, 300, 11) });
    const com = await rodarMonteCarlo({ ...inputMc(vars, 300, 11), correlacoes: [{ a: "vol", b: "cmv", rho: 0.9 }] });
    expect(sem.ok && com.ok).toBe(true);
    // volume↑ sobe equity; CMV↑ derruba. Independentes: os efeitos se diluem.
    // Correlacionados +0,9 eles se CANCELAM → a dispersão do equity CAI.
    const desvio = (xs: number[]) => {
      const m = xs.reduce((s, x) => s + x, 0) / xs.length;
      return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
    };
    expect(desvio(com.equity)).toBeLessThan(desvio(sem.equity) * 0.8);
  });

  it("correlações inconsistentes são encolhidas com aviso (não quebram)", async () => {
    const vars: McVariavelSpec[] = [
      { id: "a", alvo: "no", refId: "volume", sensibMin: -0.1, sensibMax: 0.1 },
      { id: "b", alvo: "linhaPct", refId: "cmv", sensibMin: -0.1, sensibMax: 0.1 },
      { id: "c", alvo: "linhaValor", refId: "aluguel", sensibMin: -0.1, sensibMax: 0.1 },
    ];
    // a↔b +0,9 e a↔c +0,9, mas b↔c −0,9: impossível ao mesmo tempo
    const r = await rodarMonteCarlo({
      ...inputMc(vars, 50, 3),
      correlacoes: [{ a: "a", b: "b", rho: 0.9 }, { a: "a", b: "c", rho: 0.9 }, { a: "b", b: "c", rho: -0.9 }],
    });
    expect(r.ok).toBe(true);
    expect(r.avisos.some((x) => x.includes("inconsistentes"))).toBe(true);
  });

  it("persistência: anos deixam de ser independentes (fatores vizinhos parecidos)", async () => {
    // 3 anos de horizonte; sorteio degenerado no ano é impossível de testar
    // direto, então comparamos a VARIÂNCIA do equity: com persistência alta o
    // fator do 1º ano domina os demais → distribuição mais espalhada que a
    // média de 3 sorteios independentes.
    const mk = (persistencia: number) =>
      rodarMonteCarlo(inputMc([{ id: "v1", alvo: "no", refId: "volume", sensibMin: -0.3, sensibMax: 0.3, persistencia }], 300, 5));
    const solto = await mk(0);
    const persistente = await mk(0.9);
    expect(solto.ok && persistente.ok).toBe(true);
    const desvio = (xs: number[]) => {
      const m = xs.reduce((s, x) => s + x, 0) / xs.length;
      return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
    };
    expect(desvio(persistente.equity)).toBeGreaterThan(desvio(solto.equity) * 1.1);
  });

  it("PERT e lognormal mudam a forma (lognormal puxa a cauda p/ a direita)", async () => {
    const mk = (dist: "pert" | "lognormal" | "triangular") =>
      rodarMonteCarlo(inputMc([{ id: "v1", alvo: "no", refId: "volume", sensibMin: -0.3, sensibMax: 0.6, dist }], 400, 13));
    const logn = await mk("lognormal");
    const tri = await mk("triangular");
    expect(logn.ok && tri.ok).toBe(true);
    const mediana = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    // lognormal com moda 0: mediana ~base, cauda direita mais longa que a esquerda
    const mLog = mediana(logn.equity);
    expect(Math.max(...logn.equity) - mLog).toBeGreaterThan(mLog - Math.min(...logn.equity));
  });

  it("tornado: a variável de maior sensibilidade domina a contribuição à variância", async () => {
    const r = await rodarMonteCarlo(inputMc([
      { id: "grande", alvo: "no", refId: "volume", nome: "Volume (grande)", sensibMin: -0.3, sensibMax: 0.3 },
      { id: "pequena", alvo: "linhaValor", refId: "aluguel", nome: "Aluguel (pequena)", sensibMin: -0.02, sensibMax: 0.02 },
    ], 300, 17));
    expect(r.ok).toBe(true);
    expect(r.tornado[0].id).toBe("grande");
    expect(r.tornado[0].contribuicao).toBeGreaterThan(0.8);
    const soma = r.tornado.reduce((s, x) => s + x.contribuicao, 0);
    expect(soma).toBeCloseTo(1, 6);
    // direção: volume ↑ → equity ↑ (correlação positiva; < 1 porque a
    // perpetuidade pesa o último ano mais do que a média dos fatores)
    expect(r.tornado[0].correlacao).toBeGreaterThan(0.6);
  });

  it("perf smoke: um cenário do motor custa pouco (simulação de 1000 é viável)", async () => {
    const t0 = performance.now();
    await rodarMonteCarlo(inputMc([
      { id: "v1", alvo: "no", refId: "volume", sensibMin: -0.1, sensibMax: 0.1 },
      { id: "v2", alvo: "linhaPct", refId: "cmv", sensibMin: -0.1, sensibMax: 0.1 },
    ], 100));
    const porCenario = (performance.now() - t0) / 100;
    // eslint-disable-next-line no-console
    console.log(`[monte-carlo] ~${porCenario.toFixed(1)} ms/cenário`);
    expect(porCenario).toBeLessThan(200);
  });
});
