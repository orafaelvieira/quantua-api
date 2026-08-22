import { describe, it, expect } from "vitest";
import { classifyEstagio, estagioDickinsonDe, avaliarSolidez, oQueDefineDaSolidez, type FluxoCaixaLite } from "./estagio-ciclo";

type Lite = { nome: string; valores: Record<string, number | string | null> };
const ind = (nome: string, valores: Record<string, number | string>): Lite => ({ nome, valores });

/* ─────────── Fixture MOVE FARMA (números reais que motivaram a mudança) ───────────
 * 2024: FCO −2,19M · FCI +56,6 mil · FCF +1,18M (receita 18,8M → FCI é RUÍDO)
 * 2025: FCO +4,0M  · FCI +24,8 mil · FCF −3,41M (receita 26,3M → FCI é RUÍDO)
 * Antes: 2024 = "Retração" e 2025 = "Platô (shake-out)" numa empresa crescendo 39%. */
const MOVE = [
  ind("Receita Líquida", { "31/12/2023": 775891, "31/12/2024": 18847262, "31/12/2025": 26252581 }),
  ind("Margem EBITDA", { "31/12/2023": 0.10, "31/12/2024": 0.11, "31/12/2025": 0.131 }),
  ind("Liquidez Corrente", { "31/12/2024": 1.6, "31/12/2025": 1.98 }),
  ind("Liquidez Imediata", { "31/12/2024": 0.03, "31/12/2025": 0.21 }),
  ind("Situação de Liquidez (Fleuriet)", { "31/12/2024": "Sólida", "31/12/2025": "Insuficiente" }),
  ind("Termômetro de Kanitz", { "31/12/2024": 3.2, "31/12/2025": 1.9 }),
  ind("Altman Z-Score (EM)", { "31/12/2024": 2.9, "31/12/2025": 1.4 }),
] as never[];
const FC_MOVE: FluxoCaixaLite = {
  colunas: ["31/12/2024", "31/12/2025"],
  totais: {
    fco: { "31/12/2024": -2192832, "31/12/2025": 4005248 },
    fci: { "31/12/2024": 56590, "31/12/2025": 24821 },
    fcf: { "31/12/2024": 1182240, "31/12/2025": -3413365 },
  },
  prova: [{ periodo: "31/12/2024", fecha: true }, { periodo: "31/12/2025", fecha: true }],
};
const PERIODOS = ["31/12/2023", "31/12/2024", "31/12/2025"];

describe("estagio-ciclo — materialidade + persistência + solidez (2 eixos)", () => {
  it("tabela Dickinson com sinais neutros (materialidade)", () => {
    expect(estagioDickinsonDe(1, 0, -1)).toBe("Maturidade"); // gera caixa, não investe, devolve
    expect(estagioDickinsonDe(1, 1, -1)).toBe("Platô");      // desinveste DE VERDADE
    expect(estagioDickinsonDe(-1, 0, 1)).toBe(null);         // queima sem investir, captando: ambíguo
    expect(estagioDickinsonDe(0, -1, 1)).toBe(null);         // operação no zero a zero: ambíguo
  });

  it("MOVE FARMA: FCI de R$ 25 mil (0,09% da receita) NÃO vira 'desinvestimento' — nada de Platô", () => {
    const r = classifyEstagio(MOVE, PERIODOS, FC_MOVE);
    expect(r?.estagio).toBe("Maturidade"); // fco+ · fci≈0 · fcf− (2024 é ambíguo com materialidade)
    expect(r?.estagio).not.toBe("Platô");
    // justificativa em linguagem de gente, sem siglas
    expect(r?.justificativa).toContain("R$ 4,0 milhões");
    expect(r?.justificativa).not.toContain("FCO");
    expect(r?.justificativa).not.toContain("shake-out");
  });

  it("MOVE FARMA: eixo 2 anexado — solidez intermediária e DETERIORANDO", () => {
    const r = classifyEstagio(MOVE, PERIODOS, FC_MOVE);
    expect(r?.solidez?.nivel).toBe("intermediária"); // Fleuriet Insuficiente(1) + Kanitz solvente(2) + Altman cinzenta(1) = 4/6
    expect(r?.solidez?.score).toBe(4);
    expect(r?.solidez?.tendencia).toBe("deteriorando"); // 2024 era 6/6
    // Texto do CLIENTE: sem nome de método, mas os 3 termômetros continuam descritos.
    expect(r?.solidez?.componentes).toHaveLength(3);
    expect(r?.solidez?.componentes.join(" ")).toContain("A operação se financia sozinha?");
  });

  it("persistência: mesmo padrão nas 2 colunas provadas → 'leitura consistente'", () => {
    const fc: FluxoCaixaLite = {
      colunas: ["2023", "2024"],
      totais: { fco: { "2023": 500, "2024": 600 }, fci: { "2023": -200, "2024": -250 }, fcf: { "2023": -150, "2024": -180 } },
      prova: [{ periodo: "2023", fecha: true }, { periodo: "2024", fecha: true }],
    };
    const inds = [
      ind("Receita Líquida", { "2022": 1000, "2023": 1050, "2024": 1080 }),
      ind("Margem EBITDA", { "2024": 0.12 }),
      ind("Liquidez Corrente", { "2024": 1.8 }),
      ind("Liquidez Imediata", { "2024": 0.4 }),
    ] as never[];
    const r = classifyEstagio(inds, ["2022", "2023", "2024"], fc);
    expect(r?.estagio).toBe("Maturidade");
    expect(r?.justificativa).toContain("consistente");
  });

  it("TRANSIÇÃO: colunas provadas com estágios DIFERENTES → tendência multi-ano decide e narra os dois anos", () => {
    const fc: FluxoCaixaLite = {
      colunas: ["2023", "2024"],
      totais: {
        fco: { "2023": 300, "2024": 500 },
        fci: { "2023": -400, "2024": 300 },  // investia; passou a desinvestir (material)
        fcf: { "2023": 350, "2024": -400 },  // captava; passou a devolver
      },
      prova: [{ periodo: "2023", fecha: true }, { periodo: "2024", fecha: true }],
    };
    const inds = [
      ind("Receita Líquida", { "2022": 1000, "2023": 1400, "2024": 1900 }), // +36% no último ano
      ind("Margem EBITDA", { "2024": 0.14 }),
      ind("Liquidez Corrente", { "2024": 1.6 }),
      ind("Liquidez Imediata", { "2024": 0.3 }),
    ] as never[];
    const r = classifyEstagio(inds, ["2022", "2023", "2024"], fc);
    expect(r?.estagio).toBe("Crescimento"); // receita +36% com margem positiva manda
    expect(r?.justificativa).toContain("transição");
    expect(r?.justificativa.toLowerCase()).toContain("crescimento"); // narra os dois padrões
  });

  it("solvência COLAPSADA + caixa mínimo = Pressão de caixa mesmo com margem positiva", () => {
    const inds = [
      ind("Receita Líquida", { "2023": 1000, "2024": 1020 }),
      ind("Margem EBITDA", { "2024": 0.05 }), // positiva — a regra antiga NÃO dispararia
      ind("Liquidez Corrente", { "2024": 1.1 }),
      ind("Liquidez Imediata", { "2024": 0.02 }), // caixa no mínimo
      ind("Situação de Liquidez (Fleuriet)", { "2024": "Alto Risco" }),
      ind("Termômetro de Kanitz", { "2024": -4.2 }),
      ind("Altman Z-Score (EM)", { "2024": 0.6 }),
    ] as never[];
    const r = classifyEstagio(inds, ["2023", "2024"], null);
    expect(r?.estagio).toBe("Pressão de caixa");
    // O sinal que disparou aparece no texto como GATILHO declarado (21/08/2026):
    // "O que define o estágio: os testes de solidez da estrutura ficaram no
    // nível frágil (detalhado no quadro de fôlego financeiro) e o dinheiro em
    // conta cobre só X% dos compromissos de curto prazo".
    expect(r?.justificativa).toMatch(/O que define o estágio: a estrutura financeira está no nível frágil/);
    expect(r?.justificativa).toMatch(/dinheiro em conta cobre só/);
    // E o placar da coluna NÃO se repete aqui (ele abre o quadro de fôlego).
    expect(r?.justificativa).not.toMatch(/somaram \d+ de \d+/);
  });

  it("avaliarSolidez: componentes faltando → pontua só o disponível; sem nenhum → null", () => {
    const so = avaliarSolidez([ind("Termômetro de Kanitz", { "2024": 2.0 })] as never[], ["2023", "2024"]);
    expect(so?.max).toBe(2);
    expect(so?.nivel).toBe("sólida"); // 2/2
    expect(avaliarSolidez([ind("Receita Líquida", { "2024": 10 })] as never[], ["2024"])).toBeNull();
  });
});

describe("a heurística de receita/margem declara SÓ o que testou, com os números da empresa (21/08/2026)", () => {
  const ind = (receitas: number[], margem: number, lc: number) => {
    const ps = receitas.map((_, i) => String(2021 + i));
    const v = (xs: number[]) => Object.fromEntries(ps.map((p, i) => [p, xs[i]]));
    return {
      ps,
      indicadores: [
        { nome: "Receita Líquida", valores: v(receitas) },
        { nome: "Margem EBITDA", valores: v(receitas.map(() => margem)) },
        { nome: "Liquidez Corrente", valores: v(receitas.map(() => lc)) },
      ],
    };
  };

  it("Retração por dois anos seguidos de queda NÃO publica 'vem encolhendo, +180% no acumulado'", () => {
    // Série que CRESCEU no total (50 → 140) mas caiu dois anos seguidos: o
    // gatilho é a queda recente, e o texto tem de dizer isso, não um acumulado
    // positivo rotulado de encolhimento.
    const { ps, indicadores } = ind([50, 200, 150, 140], 0.1, 1.5);
    const r = classifyEstagio(indicadores, ps)!;
    expect(r.estagio).toBe("Retração");
    expect(r.justificativa).toMatch(/caiu em dois períodos seguidos: R\$ 200 em 2022, R\$ 150 em 2023 e R\$ 140 em 2024/);
    expect(r.justificativa).toMatch(/ainda que o acumulado do período siga positivo/);
    expect(r.justificativa).not.toMatch(/vem encolhendo/);
    expect(r.justificativa).not.toMatch(/180%/);
  });

  it("Platô com margem NEGATIVA diz a margem e por que não é crescimento — e não afirma 'sem aperto de caixa'", () => {
    const { ps, indicadores } = ind([1000, 1300], -0.05, 1.5);
    const r = classifyEstagio(indicadores, ps)!;
    expect(r.estagio).toBe("Platô");
    expect(r.justificativa).toMatch(/o faturamento cresceu \+30% no período/);
    expect(r.justificativa).toMatch(/fecha no vermelho: margem EBITDA de -5,0%/);
    expect(r.justificativa).toMatch(/A margem negativa impede a leitura de crescimento ou maturidade/);
    expect(r.justificativa).not.toMatch(/praticamente parado|sem aperto de caixa/);
  });

  it("Platô por liquidez < 1 (margem positiva, estável) diz a liquidez, não 'sem aperto de caixa'", () => {
    const { ps, indicadores } = ind([1000, 1020], 0.08, 0.8);
    const r = classifyEstagio(indicadores, ps)!;
    expect(r.estagio).toBe("Platô");
    expect(r.justificativa).toMatch(/liquidez corrente de 0,80/);
    expect(r.justificativa).toMatch(/impede a leitura de maturidade/);
  });

  it("Maturidade declara a margem e a liquidez que TESTOU", () => {
    const { ps, indicadores } = ind([1000, 1050], 0.12, 1.6);
    const r = classifyEstagio(indicadores, ps)!;
    expect(r.estagio).toBe("Maturidade");
    expect(r.justificativa).toMatch(/estável no período \(\+5%\)/);
    expect(r.justificativa).toMatch(/margem EBITDA de 12,0%/);
    expect(r.justificativa).toMatch(/liquidez corrente de 1,60/);
  });

  it("a frase do fôlego fala dos FATORES, nunca do placar", () => {
    // Um só fator lido: o que ficou sem base entra pela PERGUNTA, e o placar
    // (2 de 2) não aparece em lugar nenhum.
    expect(oQueDefineDaSolidez({
      nivel: "sólida", score: 2, max: 2, tendencia: null, testes: ["solvência"],
      componentes: ["Consegue honrar os compromissos? A nota está em terreno confortável."],
    })).toBe("O que define o fôlego financeiro: consegue honrar os compromissos? A nota está em terreno confortável. Não há base neste período para avaliar se a operação se financia sozinha e como um banco enxergaria a empresa, então o nível se apoia numa leitura só.");
    // Três fatores lidos + a direção da estrutura, sem uma palavra de régua.
    const tres = oQueDefineDaSolidez({
      nivel: "frágil", score: 0, max: 6, tendencia: "deteriorando",
      testes: ["capital de giro", "solvência", "risco de insolvência"],
      componentes: [
        "A operação se financia sozinha? Não, o giro depende de dinheiro de curto prazo.",
        "Consegue honrar os compromissos? A nota exige atenção imediata.",
        "Como um banco enxergaria a empresa? Pouca margem para absorver um período ruim.",
      ],
    });
    expect(tres).toBe("O que define o fôlego financeiro: a operação se financia sozinha? Não, o giro depende de dinheiro de curto prazo. Consegue honrar os compromissos? A nota exige atenção imediata. Como um banco enxergaria a empresa? Pouca margem para absorver um período ruim. A estrutura piorou em relação ao período anterior.");
    expect(tres).not.toMatch(METODO_DA_MATRIZ);
  });

  it("Dickinson Maturidade com financiamento no zero NÃO diz 'remunera sócios e credores'", () => {
    const ps = ["2023", "2024"];
    const v = (a: number, b: number) => ({ "2023": a, "2024": b });
    const indicadores = [
      { nome: "Receita Líquida", valores: v(1000, 1000) },
      { nome: "Margem EBITDA", valores: v(0.1, 0.1) },
      { nome: "Liquidez Corrente", valores: v(1.5, 1.5) },
    ];
    const fc = { colunas: ps, totais: { fco: v(100, 100), fci: v(-80, -80), fcf: v(0, 0) }, prova: ps.map((p) => ({ periodo: p, fecha: true })) };
    const r = classifyEstagio(indicadores, ps, fc)!;
    expect(r.estagio).toBe("Maturidade");
    expect(r.justificativa).toMatch(/sem depender de sócios nem credores/);
    expect(r.justificativa).not.toMatch(/remunera sócios e credores/);
  });
});

describe("o estágio NUNCA publica data crua (dono: mm/aaaa ou o ano, nunca 31/12/2025)", () => {
  const DATA_CRUA = /\d{2}\/\d{2}\/\d{4}/;
  const ind = (p: string[], receita: number[], margem: number[], liq: number) =>
    [
      { nome: "Receita Líquida", valores: Object.fromEntries(p.map((k, i) => [k, receita[i]!])) },
      { nome: "Margem EBITDA", valores: Object.fromEntries(p.map((k, i) => [k, margem[i]!])) },
      { nome: "Liquidez Corrente", valores: { [p[p.length - 1]!]: liq } },
    ] as never;
  const fluxo = (p: string[], fco: number[], fci: number[], fcf: number[]): FluxoCaixaLite => ({
    colunas: p,
    totais: {
      fco: Object.fromEntries(p.map((k, i) => [k, fco[i]!])),
      fci: Object.fromEntries(p.map((k, i) => [k, fci[i]!])),
      fcf: Object.fromEntries(p.map((k, i) => [k, fcf[i]!])),
    },
    prova: p.map((periodo) => ({ periodo, fecha: true })),
  });

  it("Dickinson consistente: fecha o ano em '2025', não em '31/12/2025'", () => {
    const p = ["31/12/2024", "31/12/2025"];
    const r = classifyEstagio(ind(p, [50e6, 55e6], [0.08, 0.075], 1.3), p, fluxo(p, [3e6, 4e6], [-1e6, -1.2e6], [-5e5, -8e5]));
    expect(r?.estagio).toBe("Maturidade");
    expect(r!.justificativa).toContain("O que define o estágio: em 2025, a operação gerou");
    expect(r!.justificativa).not.toMatch(/Dickinson|pelo método|o sentido dos três fluxos/i);
    expect(r!.justificativa).toContain("O mesmo padrão se repete em 2024");
    expect(DATA_CRUA.test(r!.justificativa)).toBe(false);
  });

  it("Dickinson em TRANSIÇÃO: nomeia os períodos sem data crua e sem dizer 'anos' para mês", () => {
    const p = ["31/12/2024", "31/05/2025"];
    const r = classifyEstagio(ind(p, [50e6, 20e6], [0.08, 0.01], 1.1), p, fluxo(p, [3e6, -2e6], [-1e6, 5e5], [-5e5, 1e6]));
    expect(r).toBeTruthy();
    expect(DATA_CRUA.test(r!.justificativa)).toBe(false);
    if (r!.justificativa.includes("Os sinais do fluxo de caixa mudaram")) {
      expect(r!.justificativa).toContain("05/2025");
      expect(r!.justificativa).toContain("entre os períodos");
    }
  });

  it("heurística de receita/margem: a série sai rotulada por ano/mês, nunca pela data", () => {
    const p = ["31/12/2023", "31/12/2024", "31/03/2025"];
    const r = classifyEstagio(ind(p, [100e6, 90e6, 20e6], [0.05, 0.02, -0.01], 0.9), p, null);
    expect(r).toBeTruthy();
    expect(DATA_CRUA.test(r!.justificativa)).toBe(false);
  });
});

/**
 * O MÉTODO DA MATRIZ NUNCA VAI PARA O DOCUMENTO (dono, 22/08/2026: "nunca
 * coloque o método de cálculo da matriz; a explicação tem que ser dos fatores
 * que trouxeram a empresa para esta posição"). Esta régua é aplicada a TODO
 * texto publicado pelos dois quadros.
 */
const METODO_DA_MATRIZ = /pontos?\b|placar|somou \d|de 6\b|\d+ testes?\b|passa por \d|três quartos|40%|Fleuriet|Kanitz|Altman|Z-Score|Dickinson|a matriz|o motor|metodologia|crit[ée]rio de classifica/i;

describe("o texto só afirma o que o motor mediu (achados da revisão adversarial 21/08)", () => {
  const ind = (vals: Record<string, Record<string, number>>) =>
    Object.entries(vals).map(([nome, valores]) => ({ nome, valores })) as never;

  it("#2 ACERVO: os nomes dos testes vêm dos componentes, não da ordem canônica", () => {
    // Fleuriet indisponível: rodaram solvência e risco de insolvência. Deduzir
    // "os 2 primeiros" publicava "capital de giro e solvência" — nome errado
    // no teste que rodou E no que faltou.
    const componentes = [
      "Consegue honrar os compromissos? A nota exige atenção imediata.",
      "Como um banco enxergaria a empresa? Pouca margem para absorver um período ruim.",
    ];
    const t = oQueDefineDaSolidez({ nivel: "sólida", score: 4, max: 4, tendencia: null, componentes });
    expect(t).toBe(
      "O que define o fôlego financeiro: consegue honrar os compromissos? A nota exige atenção imediata. " +
      "Como um banco enxergaria a empresa? Pouca margem para absorver um período ruim. " +
      "Não há base neste período para avaliar se a operação se financia sozinha.",
    );
    expect(t).not.toMatch(METODO_DA_MATRIZ);
  });

  it("#2 sem componentes reconhecíveis o texto NÃO inventa nome de teste", () => {
    const t = oQueDefineDaSolidez({ nivel: "frágil", score: 1, max: 4, tendencia: null, componentes: ["texto de acervo antigo", "outro"] });
    expect(t).toBe("O que define o fôlego financeiro: texto de acervo antigo. outro. As demais leituras da estrutura não tinham base neste período.");
    expect(t).not.toMatch(METODO_DA_MATRIZ);
  });

  it("#2 sem componentes não há fator para mostrar: só o nível, sem placar", () => {
    const t = oQueDefineDaSolidez({ nivel: "frágil", score: 0, max: 6, tendencia: null });
    expect(t).toBe("A estrutura financeira está frágil."); // concorda com A ESTRUTURA
    expect(t).not.toMatch(METODO_DA_MATRIZ);
  });

  it("#4 margem que arredonda para 0,0% é empate, não 'resultado operacional negativo'", () => {
    const p = ["2024", "2025"];
    const r = classifyEstagio(
      ind({
        "Receita Líquida": { "2024": 10e6, "2025": 10e6 },
        "Margem EBITDA": { "2024": 0.02, "2025": -0.0001 },
        "Liquidez Corrente": { "2024": 1.1, "2025": 0.7 },
      }),
      p,
    );
    expect(r?.estagio).toBe("Pressão de caixa");
    expect(r!.justificativa.toLowerCase()).toContain("a operação empata");
    expect(r!.justificativa).not.toContain("resultado operacional negativo");
    expect(r!.justificativa).not.toContain("-0,0%");
  });

  it("#13 margem positiva mínima não vira 'sobram cerca de R$ 0'", () => {
    const p = ["2024", "2025"];
    const r = classifyEstagio(
      ind({
        "Receita Líquida": { "2024": 10e6, "2025": 10e6 },
        "Margem EBITDA": { "2024": 0.05, "2025": 0.004 },
        "Liquidez Imediata": { "2024": 0.2, "2025": 0.01 },
        "Liquidez Corrente": { "2024": 1.2, "2025": 1.2 },
        "Situação de Liquidez (Fleuriet)": { "2025": 0 },
      }),
      p,
    );
    if (r?.estagio === "Pressão de caixa") {
      expect(r.justificativa).not.toContain("cerca de R$ 0 depois");
      expect(r.justificativa).toContain("menos de R$ 1");
    }
  });

  it("#5 sem margem na série o motor NÃO afirma que a operação não cobre os custos", () => {
    const p = ["2024", "2025"];
    const r = classifyEstagio(
      ind({
        "Receita Líquida": { "2024": 10e6, "2025": 10e6 },
        "Liquidez Imediata": { "2024": 0.2, "2025": 0.01 },
        "Liquidez Corrente": { "2024": 1.2, "2025": 0.9 },
        "Situação de Liquidez (Fleuriet)": { "2024": 0, "2025": 0 },
        "Termômetro de Kanitz": { "2024": -5, "2025": -6 },
        "Altman Z-Score (EM)": { "2024": 0.2, "2025": 0.1 },
      }),
      p,
    );
    expect(r?.estagio).toBe("Pressão de caixa");
    expect(r!.justificativa).not.toContain("voltar a cobrir os próprios custos");
  });

  it("#14 janela parcial COM lucro mantém a ressalva da janela", () => {
    const p = ["2025", "31/05/2026"];
    const r = classifyEstagio(
      ind({
        "Receita Líquida": { "2025": 30e6, "31/05/2026": 12e6 },
        "Margem EBITDA": { "2025": 0.1, "31/05/2026": 0.15 },
        "Liquidez Imediata": { "2025": 0.3, "31/05/2026": 0.02 },
        "Liquidez Corrente": { "2025": 1.4, "31/05/2026": 1.1 },
        "Situação de Liquidez (Fleuriet)": { "2025": 0, "31/05/2026": 0 },
        "Termômetro de Kanitz": { "2025": -5, "31/05/2026": -6 },
        "Altman Z-Score (EM)": { "2025": 0.3, "31/05/2026": 0.2 },
      }),
      p,
    );
    expect(r?.estagio).toBe("Pressão de caixa");
    expect(r!.justificativa).toContain("janela parcial");
    expect(r!.justificativa).toContain("exercício fechado anterior");
  });

  it("#9 liquidez corrente que arredonda para 0,00 declara a borda", () => {
    const p = ["2024", "2025"];
    const r = classifyEstagio(
      ind({
        "Receita Líquida": { "2024": 10e6, "2025": 8e6 },
        "Margem EBITDA": { "2024": -0.02, "2025": -0.05 },
        "Liquidez Corrente": { "2024": 0.5, "2025": 0.004 },
      }),
      p,
    );
    expect(r!.justificativa).toContain("liquidez corrente abaixo de 0,01");
    expect(r!.justificativa).not.toContain("liquidez corrente de 0,00");
  });

  it("#7 'caiu em dois períodos seguidos' exige DUAS quedas", () => {
    const p = ["2022", "2023", "2024"];
    const r = classifyEstagio(
      ind({
        "Receita Líquida": { "2022": 10e6, "2023": 10e6, "2024": 8e6 },
        "Margem EBITDA": { "2022": 0.05, "2023": 0.05, "2024": 0.04 },
        "Liquidez Corrente": { "2022": 1.5, "2023": 1.4, "2024": 1.3 },
      }),
      p,
    );
    expect(r?.estagio).toBe("Retração");
    expect(r!.justificativa).not.toContain("caiu em dois períodos seguidos");
  });

  it("#8 receita que sai de ZERO não vira 'estável (0%)'", () => {
    const p = ["2023", "2024"];
    const r = classifyEstagio(
      ind({
        "Receita Líquida": { "2023": 0, "2024": 5e6 },
        "Margem EBITDA": { "2023": 0.1, "2024": 0.2 },
        "Liquidez Corrente": { "2023": 2, "2024": 2 },
      }),
      p,
    );
    expect(r?.estagio).toBe("Crescimento");
    expect(r!.justificativa).toContain("saiu de zero em 2023 para R$ 5,0 milhões em 2024");
    expect(r!.justificativa).not.toContain("estável");
  });

  it("#11 empresas de escalas diferentes NÃO recebem o mesmo texto", () => {
    const base = (r0: number, r1: number) =>
      classifyEstagio(
        ind({
          "Receita Líquida": { "2023": r0, "2024": r1 },
          "Margem EBITDA": { "2023": 0.05, "2024": 0.05 },
          "Liquidez Corrente": { "2023": 1.5, "2024": 1.5 },
        }),
        ["2023", "2024"],
      );
    const a = base(1e6, 0.8e6)!, b = base(300e6, 240e6)!;
    expect(a.estagio).toBe("Retração");
    expect(a.justificativa).not.toBe(b.justificativa);
    expect(a.justificativa).toContain("R$ 1,0 milhão");
    expect(b.justificativa).toContain("R$ 300,0 milhões");
  });

  it("#6 o fecho da Retração não contradiz o fôlego: só fala de liquidez medida", () => {
    const apertada = classifyEstagio(
      ind({
        "Receita Líquida": { "2022": 10e6, "2023": 8e6, "2024": 6e6 },
        "Margem EBITDA": { "2022": 0.05, "2023": 0.04, "2024": 0.04 },
        "Liquidez Corrente": { "2022": 1.2, "2023": 0.8, "2024": 0.55 },
      }),
      ["2022", "2023", "2024"],
    )!;
    expect(apertada.estagio).toBe("Retração");
    expect(apertada.justificativa).toContain("aperto de curto prazo");
    expect(apertada.justificativa).not.toContain("não em pagar as contas do mês");

    const semLiquidez = classifyEstagio(
      ind({
        "Receita Líquida": { "2022": 10e6, "2023": 8e6, "2024": 6e6 },
        "Margem EBITDA": { "2022": 0.05, "2023": 0.04, "2024": 0.04 },
      }),
      ["2022", "2023", "2024"],
    )!;
    expect(semLiquidez.justificativa).not.toContain("curto prazo");
  });

  it("#12 nada de 'recuou -20%' nem de '-0%'", () => {
    const r = classifyEstagio(
      ind({
        "Receita Líquida": { "2023": 10e6, "2024": 7e6 },
        "Margem EBITDA": { "2023": 0.05, "2024": 0.05 },
        "Liquidez Corrente": { "2023": 1.5, "2024": 1.5 },
      }),
      ["2023", "2024"],
    )!;
    expect(r.justificativa).not.toMatch(/recuou -\d/);
    expect(r.justificativa).not.toContain("-0%");
  });

  it("#3 sem margem, o Platô não afirma margem negativa nem 'não avança' depois de +25%", () => {
    const r = classifyEstagio(
      ind({ "Receita Líquida": { "2023": 10e6, "2024": 12.5e6 } }),
      ["2023", "2024"],
    )!;
    expect(r.estagio).toBe("Platô");
    expect(r.justificativa).toContain("A margem não está disponível nesta série");
    expect(r.justificativa).not.toContain("A margem negativa impede");
    expect(r.justificativa).not.toContain("A empresa se mantém, mas não avança");
  });

  it("#15 o plural segue o número impresso: R$ 1.950.000 é 'R$ 2,0 milhões'", () => {
    const r = classifyEstagio(
      ind({
        "Receita Líquida": { "2023": 3e6, "2024": 1.95e6 },
        "Margem EBITDA": { "2023": 0.05, "2024": 0.05 },
        "Liquidez Corrente": { "2023": 1.5, "2024": 1.5 },
      }),
      ["2023", "2024"],
    )!;
    expect(r.justificativa).toContain("R$ 2,0 milhões");
    expect(r.justificativa).not.toContain("R$ 2,0 milhão");
  });
});

describe("ESPELHO: a frase do fôlego é idêntica nos dois repos (mesma fixture da bancada do app)", () => {
  const COMPONENTES_SEM_FLEURIET = ['Consegue honrar os compromissos? A nota exige atenção imediata.', 'Como um banco enxergaria a empresa? Pouca margem para absorver um período ruim.'];
  const COMPONENTES_SO_ALTMAN = ['Como um banco enxergaria a empresa? Pouca margem para absorver um período ruim.'];

  it("Fleuriet indisponível: publica os dois fatores lidos e diz o que ficou sem base", () => {
    expect(oQueDefineDaSolidez({ nivel: "intermediária", score: 3, max: 4, tendencia: null, componentes: COMPONENTES_SEM_FLEURIET }))
      .toBe("O que define o fôlego financeiro: consegue honrar os compromissos? A nota exige atenção imediata. Como um banco enxergaria a empresa? Pouca margem para absorver um período ruim. Não há base neste período para avaliar se a operação se financia sozinha.");
  });

  it("só o Altman: um fator lido, dois sem base — e nenhuma palavra de método", () => {
    const t = oQueDefineDaSolidez({ nivel: "frágil", score: 0, max: 2, tendencia: null, componentes: COMPONENTES_SO_ALTMAN });
    expect(t).toBe("O que define o fôlego financeiro: como um banco enxergaria a empresa? Pouca margem para absorver um período ruim. Não há base neste período para avaliar se a operação se financia sozinha e se a empresa consegue honrar os compromissos, então o nível se apoia numa leitura só.");
    expect(t).not.toMatch(METODO_DA_MATRIZ);
  });

  it("o motor GRAVA os testes que rodaram, para o app não ter de deduzi-los", () => {
    const s = avaliarSolidez(
      [
        { nome: "Termômetro de Kanitz", valores: { "2024": 1.5, "2025": 1.5 } },
        { nome: "Altman Z-Score (EM)", valores: { "2024": 1.5, "2025": 1.5 } },
      ] as never,
      ["2024", "2025"],
    );
    expect(s?.testes).toEqual(["solvência", "risco de insolvência"]);
    expect(s?.oQueDefine).toContain("Não há base neste período para avaliar se a operação se financia sozinha");
    expect(s?.oQueDefine).not.toMatch(METODO_DA_MATRIZ);
  });

  it("o componente do capital de giro não usa travessão (o PDF o troca por vírgula)", () => {
    const s = avaliarSolidez(
      [{ nome: "Situação de Liquidez (Fleuriet)", valores: { "2024": "Insuficiente", "2025": "Insuficiente" } }] as never,
      ["2024", "2025"],
    );
    expect(s?.componentes[0]).toContain("A operação se financia sozinha? Não, ");
    expect(s?.componentes.join(" ")).not.toContain("—");
  });
});

describe("NENHUM ramo do estágio publica o método (dono, 22/08/2026)", () => {
  const ind = (p: string[], receita: number[], margem: number[], liq: number) =>
    [
      { nome: "Receita Líquida", valores: Object.fromEntries(p.map((k, i) => [k, receita[i]!])) },
      { nome: "Margem EBITDA", valores: Object.fromEntries(p.map((k, i) => [k, margem[i]!])) },
      { nome: "Liquidez Corrente", valores: { [p[p.length - 1]!]: liq } },
    ] as never;
  const fluxo = (p: string[], fco: number[], fci: number[], fcf: number[]): FluxoCaixaLite => ({
    colunas: p,
    totais: {
      fco: Object.fromEntries(p.map((k, i) => [k, fco[i]!])),
      fci: Object.fromEntries(p.map((k, i) => [k, fci[i]!])),
      fcf: Object.fromEntries(p.map((k, i) => [k, fcf[i]!])),
    },
    prova: p.map((periodo) => ({ periodo, fecha: true })),
  });

  it("ramo dos FLUXOS: conta o que o caixa fez, sem nomear o modelo nem o critério", () => {
    const p = ["2024", "2025"];
    const r = classifyEstagio(ind(p, [50e6, 55e6], [0.08, 0.075], 1.3), p, fluxo(p, [3e6, 4e6], [-1e6, -1.2e6], [-5e5, -8e5]));
    expect(r?.estagio).toBe("Maturidade");
    expect(r!.justificativa).toContain("O que define o estágio: em 2025, a operação gerou");
    expect(r!.justificativa).not.toMatch(METODO_DA_MATRIZ);
    expect(r!.justificativa).not.toMatch(/o sentido dos três fluxos/i);
  });

  it("ramo da TRAJETÓRIA: abre no faturamento, sem enunciar o critério", () => {
    const p = ["2023", "2024", "2025"];
    const r = classifyEstagio(ind(p, [100e6, 90e6, 70e6], [0.05, 0.04, 0.03], 1.4), p, null);
    expect(r?.estagio).toBe("Retração");
    expect(r!.justificativa).toMatch(/^O que define o estágio: o faturamento caiu/);
    expect(r!.justificativa).not.toMatch(METODO_DA_MATRIZ);
    expect(r!.justificativa).not.toMatch(/a trajetória do faturamento e o sinal da margem/i);
  });

  it("ramo da PRESSÃO DE CAIXA: os gatilhos são fatos, e a estrutura entra só como posição", () => {
    const p = ["2024", "2025"];
    const r = classifyEstagio(
      [
        { nome: "Receita Líquida", valores: { "2024": 10e6, "2025": 9e6 } },
        { nome: "Margem EBITDA", valores: { "2024": 0.01, "2025": -0.03 } },
        { nome: "Liquidez Corrente", valores: { "2024": 1.05, "2025": 0.88 } },
        { nome: "Liquidez Imediata", valores: { "2024": 0.2, "2025": 0.01 } },
        { nome: "Termômetro de Kanitz", valores: { "2024": -4, "2025": -6 } },
        { nome: "Altman Z-Score (EM)", valores: { "2024": 0.4, "2025": 0.2 } },
      ] as never,
      p,
    );
    expect(r?.estagio).toBe("Pressão de caixa");
    expect(r!.justificativa).not.toMatch(METODO_DA_MATRIZ);
    expect(r!.justificativa).not.toMatch(/testes? de solidez|detalhado no quadro/i);
  });

  it("a solidez completa que vai para o documento também não carrega método", () => {
    const s = avaliarSolidez(
      [
        { nome: "Situação de Liquidez (Fleuriet)", valores: { "2024": "Insuficiente", "2025": "Muito Ruim" } },
        { nome: "Termômetro de Kanitz", valores: { "2024": -4, "2025": -6 } },
        { nome: "Altman Z-Score (EM)", valores: { "2024": 0.4, "2025": 0.2 } },
      ] as never,
      ["2024", "2025"],
    );
    expect(s?.oQueDefine).toMatch(/^O que define o fôlego financeiro: a operação se financia sozinha\?/);
    expect(s?.oQueDefine).not.toMatch(METODO_DA_MATRIZ);
    // e os componentes, que a frase embute, também não
    for (const c of s?.componentes ?? []) expect(c).not.toMatch(/pontos?\b|placar|somou \d|de 6\b/i);
  });
});
