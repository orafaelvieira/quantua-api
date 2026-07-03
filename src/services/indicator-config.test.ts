import { describe, it, expect } from "vitest";
import { calculateIndicators, statusPorSemaforo, SEMAFORO_DEFAULTS, diasDoPeriodo } from "./indicator-calculator";
import type { BPLineItem, DRELineItem } from "../types/financial";

const bpLine = (classificacao: string, conta: string, nivel: number, v: number): BPLineItem =>
  ({ classificacao, conta, nivel, editado: false, valores: { "2023": v } });
const dreLine = (conta: string, v: number): DRELineItem =>
  ({ conta, subtotal: false, editado: false, valores: { "2023": v } });

// BP simples: AC 500 (Caixa 100, CR 200, Estoques 200) · RLP 0 · PC 250 · PNC 150 · PL 400
const BP: BPLineItem[] = [
  bpLine("AC", "Ativo Circulante", 1, 500),
  bpLine("AF", "Caixa e Equivalentes de Caixa", 2, 100),
  bpLine("AO", "Contas a Receber - CP", 2, 200),
  bpLine("AO", "Estoques - CP", 2, 200),
  bpLine("PC", "Passivo Circulante", 1, 250),
  bpLine("PNC", "Passivo Não Circulante", 1, 150),
  bpLine("PL", "Patrimônio Líquido", 1, 400),
  bpLine("PT", "Passivo Total", 0, 800),
  bpLine("AT", "Ativo Total", 0, 800),
];
const DRE: DRELineItem[] = [dreLine("Receita Bruta", 1000), dreLine("Custo Operacional", -600)];

describe("Termômetro de Kanitz", () => {
  it("calcula FI = 0,05·(LL/PL) + 1,65·LG + 3,55·LS − 1,06·LC − 0,33·(Exigível/PL)", () => {
    const inds = calculateIndicators(BP, DRE, ["2023"]);
    const kanitz = inds.find((i) => i.nome === "Termômetro de Kanitz");
    // LL = 1000-600 = 400; PL 400 → x1=1 · LG = 500/400 = 1,25 · LS = 300/250 = 1,2
    // LC = 500/250 = 2 · Exig/PL = 400/400 = 1
    const esperado = 0.05 * 1 + 1.65 * 1.25 + 3.55 * 1.2 - 1.06 * 2 - 0.33 * 1;
    expect(kanitz?.valores["2023"]).toBeCloseTo(esperado, 6); // ≈ 3,9425 → solvente
    expect(kanitz?.status["2023"]).toBe("ok");
  });

  it("semáforo do Kanitz: penumbra (0 a −3) = atenção; < −3 = crítico", () => {
    const def = SEMAFORO_DEFAULTS["Termômetro de Kanitz"];
    expect(statusPorSemaforo(def, 1.5)).toBe("ok");
    expect(statusPorSemaforo(def, -1)).toBe("atencao");
    expect(statusPorSemaforo(def, -4)).toBe("critico");
  });
});

describe("semáforo configurável", () => {
  it("override do banco muda o status sem tocar no valor", () => {
    const semOverride = calculateIndicators(BP, DRE, ["2023"]);
    const lc1 = semOverride.find((i) => i.nome === "Liquidez Corrente");
    expect(lc1?.valores["2023"]).toBeCloseTo(2, 4);
    expect(lc1?.status["2023"]).toBe("ok"); // default: ok acima de 1,5

    const comOverride = calculateIndicators(BP, DRE, ["2023"], {
      "Liquidez Corrente": { direcao: "menor_ruim", critico: 2.5, atencao: 3.0 }, // exigente
    });
    const lc2 = comOverride.find((i) => i.nome === "Liquidez Corrente");
    expect(lc2?.valores["2023"]).toBeCloseTo(2, 4); // valor intacto
    expect(lc2?.status["2023"]).toBe("critico");    // status muda
  });

  it("direção maior_ruim funciona (endividamento)", () => {
    const def = SEMAFORO_DEFAULTS["Endividamento Geral"];
    expect(statusPorSemaforo(def, 0.9)).toBe("critico");
    expect(statusPorSemaforo(def, 0.6)).toBe("atencao");
    expect(statusPorSemaforo(def, 0.3)).toBe("ok");
  });
});

describe("correções e novos indicadores (jul/2026)", () => {
  // BP com ANC para o CDG pela ótica do financiamento
  const BP2: BPLineItem[] = [
    bpLine("AT", "Ativo Total", 0, 1000),
    bpLine("AC", "Ativo Circulante", 1, 500),
    bpLine("AF", "Caixa e Equivalentes de Caixa", 2, 100),
    bpLine("AO", "Contas a Receber - CP", 2, 200),
    bpLine("AO", "Estoques - CP", 2, 200),
    bpLine("ANC", "Ativo Não Circulante", 1, 500),
    bpLine("ANC", "Imobilizado", 2, 300),
    bpLine("ANC", "Investimentos", 2, 100),
    bpLine("ANC", "Intangível", 2, 100),
    bpLine("PT", "Passivo Total", 0, 1000),
    bpLine("PC", "Passivo Circulante", 1, 250),
    bpLine("PF", "Empréstimos e Financiamentos - CP", 2, 80),
    bpLine("PF", "Passivos com Partes Relacionadas - CP", 2, 40),
    bpLine("PNC", "Passivo Não Circulante", 1, 150),
    bpLine("PNC", "Empréstimos e Financiamentos - LP", 2, 120),
    bpLine("PL", "Patrimônio Líquido", 1, 600),
    bpLine("PL", "Lucros/Prejuízos Acumulados", 2, 150),
    bpLine("PL", "Reservas de Lucros", 2, 50),
  ];
  const DRE2: DRELineItem[] = [dreLine("Receita Bruta", 1000), dreLine("Custo Operacional", -600)];
  const val = (nome: string) => {
    const i = calculateIndicators(BP2, DRE2, ["2023"]).find((x) => x.nome === nome);
    return i?.valores["2023"];
  };

  it("CDG = (PL + PNC) − ANC (ótica do financiamento; = AC − PC quando o balanço fecha)", () => {
    expect(val("Capital de Giro (CDG)")).toBeCloseTo(600 + 150 - 500, 2); // 250 = 500-250 ✓
  });

  it("Capital de Terceiros = só empréstimos CP+LP; a versão + Partes Relacionadas inclui tudo", () => {
    expect(val("Capital de Terceiros")).toBeCloseTo(80 + 120, 2);
    expect(val("Capital de Terceiros + Partes Relacionadas")).toBeCloseTo(80 + 40 + 120, 2);
  });

  it("identidade DuPont: Margem Líquida × Giro do Ativo = ROA (na cascata da Rentabilidade)", () => {
    const inds = calculateIndicators(BP2, DRE2, ["2023"]);
    const rent = inds.filter((i) => i.tipo === "Indicadores de Rentabilidade").map((i) => i.nome);
    // cascata na ordem: Margem, Giro, ROA, Alavancagem, ROE, ROIC
    expect(rent).toEqual(["Margem Líquida", "Giro do Ativo", "ROA (Retorno sobre Ativos)", "Alavancagem", "ROE (Retorno sobre Patrimônio Líquido)", "ROIC (Retorno sobre Capital Investido)"]);
    const de = (nome: string) => inds.find((i) => i.tipo === "Indicadores de Rentabilidade" && i.nome === nome)?.valores["2023"] as number;
    expect(de("Margem Líquida") * de("Giro do Ativo")).toBeCloseTo(de("ROA (Retorno sobre Ativos)"), 10);
    expect(de("ROA (Retorno sobre Ativos)") * de("Alavancagem")).toBeCloseTo(de("ROE (Retorno sobre Patrimônio Líquido)"), 10);
  });

  it("Imobilização do PL = (Imobilizado + Investimentos + Intangível) / PL", () => {
    expect(val("Imobilização do Patrimônio Líquido")).toBeCloseTo(500 / 600, 4);
  });

  it("Altman Z-Score (EM) = 6,56·X1 + 3,26·X2 + 6,72·X3 + 1,05·X4", () => {
    // X1 = (500−250)/1000 = 0,25 · X2 = 200/1000 = 0,2 · X3 = EBIT 400/1000 = 0,4 · X4 = 600/400 = 1,5
    const esperado = 6.56 * 0.25 + 3.26 * 0.2 + 6.72 * 0.4 + 1.05 * 1.5;
    expect(val("Altman Z-Score (EM)")).toBeCloseTo(esperado, 4);
  });

  it("Crescimento da Receita (YoY) compara com o período anterior cronológico", () => {
    const bp3 = BP2.map((l) => ({ ...l, valores: { "2022": l.valores["2023"], "2023": l.valores["2023"] } }));
    const dre3: DRELineItem[] = [
      { conta: "Receita Bruta", subtotal: false, editado: false, valores: { "2022": 800, "2023": 1000 } },
    ];
    const inds = calculateIndicators(bp3, dre3, ["2023", "2022"]); // fora de ordem de propósito
    const g = inds.find((x) => x.nome === "Crescimento da Receita (YoY)");
    expect(g?.valores["2023"]).toBeCloseTo(0.25, 4); // 1000/800 − 1
    expect(g?.valores["2022"]).toBeNull();           // sem período anterior
  });

  it("dias do período: anual 365, mensal 30, trimestral 90, único intermediário = YTD (mês×30)", () => {
    expect(diasDoPeriodo("31/12/2022", ["31/12/2021", "31/12/2022"])).toBe(365);
    expect(diasDoPeriodo("31/03/2024", ["31/01/2024", "28/02/2024", "31/03/2024"])).toBe(30);
    expect(diasDoPeriodo("30/06/2024", ["31/03/2024", "30/06/2024", "30/09/2024"])).toBe(90);
    expect(diasDoPeriodo("31/03/2024", ["31/03/2024"])).toBe(90);  // balancete até março = 3 meses
    expect(diasDoPeriodo("31/12/2024", ["31/12/2024"])).toBe(365); // fechamento anual
  });
});
