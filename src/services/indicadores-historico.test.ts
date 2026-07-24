import { describe, it, expect } from "vitest";
import { mesclarHistoricoIbr, rotuloPeriodoHistorico, indicadoresIbrDoModelo } from "./model-indicadores-ibr";
import type { HistoricoDfsIbr } from "./model-indicadores-ibr";
import { calcularModelo } from "./model-engine";
import type { BPLineItem, DRELineItem } from "../types/financial";

/**
 * HISTÓRICO + PROJEÇÃO NA MESMA TABELA (pedido do usuário, 24/07/2026).
 *
 * O que estes testes protegem: as colunas realizadas entram como períodos das
 * MESMAS linhas e passam pelo MESMO calculateIndicators — é isso que torna
 * legítima a leitura horizontal "realizado → projetado" de cada indicador.
 */

const P = (conta: string, valores: Record<string, number>, classificacao = "", nivel = 2) =>
  ({ conta, valores, classificacao, nivel, editado: false }) as BPLineItem;
const D = (conta: string, valores: Record<string, number>, subtotal = false) =>
  ({ conta, valores, subtotal, editado: false }) as DRELineItem;

const projFake = () => ({
  bp: [
    P("Ativo Total", { "2026": 1000 }, "AT", 0),
    P("Caixa e Equivalentes de Caixa", { "2026": 100 }, "AC", 3),
    P("(-) Depreciação", { "2026": -50 }, "AF", 3),
  ],
  dre: [D("Receita Bruta", { "2026": 500 }), D("Custo Operacional", { "2026": -200 })],
  diasPorPeriodo: { "2026": 365 },
});

const histFake = (): HistoricoDfsIbr => ({
  periodos: ["31/12/2024", "31/12/2025"],
  bp: [
    { conta: "ATIVO TOTAL", valores: { "31/12/2024": 800, "31/12/2025": 900 }, classificacao: "AT", nivel: 0 },
    { conta: "(-) DEPRECIACAO", valores: { "31/12/2024": -30, "31/12/2025": -40 }, classificacao: "AF", nivel: 3 },
    { conta: "Aplicações Financeiras", valores: { "31/12/2024": 15, "31/12/2025": 20 }, classificacao: "AC", nivel: 3 },
  ],
  dre: [{ conta: "Receita Bruta", valores: { "31/12/2024": 300, "31/12/2025": 400 } }],
});

describe("rotuloPeriodoHistorico", () => {
  it("fechamento de dezembro vira o ANO — mesma régua das colunas projetadas", () => {
    expect(rotuloPeriodoHistorico("31/12/2024")).toBe("2024");
    expect(rotuloPeriodoHistorico("2024-12-31")).toBe("2024");
  });

  it("período que NÃO é fechamento anual mantém a data — precisa se anunciar", () => {
    // Comparar um semestre com um ano cheio sem avisar seria leitura errada.
    expect(rotuloPeriodoHistorico("30/06/2024")).toBe("30/06/2024");
  });
});

describe("mesclarHistoricoIbr", () => {
  it("sem histórico, devolve a projeção intacta", () => {
    const r = mesclarHistoricoIbr(projFake(), ["2026"], undefined);
    expect(r.periodos).toEqual(["2026"]);
    expect(r.periodosHistoricos).toEqual([]);
    expect(r.bp).toHaveLength(3);
  });

  it("as colunas realizadas entram nas MESMAS linhas, casando por conta", () => {
    const r = mesclarHistoricoIbr(projFake(), ["2026"], histFake());
    const at = r.bp.find((l) => l.conta === "Ativo Total")!;
    expect(at.valores["2024"]).toBe(800);
    expect(at.valores["2025"]).toBe(900);
    expect(at.valores["2026"]).toBe(1000); // a projeção sobrevive
  });

  it("CAIXA/ACENTO não duplicam linha: '(-) DEPRECIACAO' casa com '(-) Depreciação'", () => {
    const r = mesclarHistoricoIbr(projFake(), ["2026"], histFake());
    const depr = r.bp.filter((l) => l.conta.toLowerCase().includes("deprecia"));
    expect(depr).toHaveLength(1);
    expect(depr[0].valores["2024"]).toBe(-30);
  });

  it("conta que só existe no histórico não some — entra como linha nova", () => {
    const r = mesclarHistoricoIbr(projFake(), ["2026"], histFake());
    const nova = r.bp.find((l) => l.conta === "Aplicações Financeiras")!;
    expect(nova).toBeDefined();
    expect(nova.valores["2025"]).toBe(20);
    expect(nova.valores["2026"]).toBeUndefined(); // projeção em branco, não zero
  });

  it("ordem das colunas: realizado ANTES do projetado, cronológica", () => {
    const r = mesclarHistoricoIbr(projFake(), ["2026", "2027"], histFake());
    expect(r.periodos).toEqual(["2024", "2025", "2026", "2027"]);
    expect(r.periodosHistoricos).toEqual(["2024", "2025"]);
  });

  it("período histórico que COLIDE com ano projetado é descartado", () => {
    // Sem isso o mesmo ano apareceria duas vezes, com números diferentes.
    const hist: HistoricoDfsIbr = {
      periodos: ["31/12/2025", "31/12/2026"],
      bp: [{ conta: "Ativo Total", valores: { "31/12/2025": 900, "31/12/2026": 950 } }],
    };
    const r = mesclarHistoricoIbr(projFake(), ["2026"], hist);
    expect(r.periodosHistoricos).toEqual(["2025"]);
    expect(r.bp.find((l) => l.conta === "Ativo Total")!.valores["2026"]).toBe(1000); // a PROJEÇÃO manda
  });

  it("período sem movimento no balanço não vira coluna vazia", () => {
    const hist: HistoricoDfsIbr = {
      periodos: ["31/12/2023", "31/12/2024"],
      bp: [{ conta: "Ativo Total", valores: { "31/12/2023": 0, "31/12/2024": 800 } }],
    };
    const r = mesclarHistoricoIbr(projFake(), ["2026"], hist);
    expect(r.periodosHistoricos).toEqual(["2024"]);
  });

  it("realizado é exercício fechado: 365 dias (senão os prazos médios saem tortos)", () => {
    const r = mesclarHistoricoIbr(projFake(), ["2026"], histFake());
    expect(r.diasPorPeriodo["2024"]).toBe(365);
    expect(r.diasPorPeriodo["2025"]).toBe(365);
  });
});

describe("ponta a ponta: indicadores com histórico", () => {
  const modelo = () =>
    calcularModelo({
      mesInicial: "2026-01",
      horizonteMeses: 12,
      blocks: [
        {
          id: "b1", tipo: "receitas", nome: "Receitas", ativo: true,
          config: { linhasCusto: [{ id: "r1", nome: "Receita", modo: "fixoReajuste", valorMensal: 100 }] },
        },
      ],
    } as never);

  it("a MESMA fórmula roda no realizado e no projetado", () => {
    const hist: HistoricoDfsIbr = {
      periodos: ["31/12/2025"],
      bp: [
        { conta: "Ativo Total", valores: { "31/12/2025": 2000 }, classificacao: "AT", nivel: 0 },
        { conta: "Patrimônio Líquido", valores: { "31/12/2025": 1000 }, classificacao: "PL", nivel: 1 },
        { conta: "Passivo Total", valores: { "31/12/2025": 2000 }, classificacao: "PT", nivel: 0 },
      ],
      dre: [
        { conta: "Receita Bruta", valores: { "31/12/2025": 1200 } },
        { conta: "Receita Líquida", valores: { "31/12/2025": 1200 }, subtotal: true },
        { conta: "Custo Operacional", valores: { "31/12/2025": -360 } },
        { conta: "Lucro Bruto", valores: { "31/12/2025": 840 }, subtotal: true },
      ],
    };
    const r = indicadoresIbrDoModelo(modelo(), ["2026"], { historico: hist });
    expect(r.periodos).toEqual(["2025", "2026"]);
    expect(r.periodosHistoricos).toEqual(["2025"]);

    const mb = r.indicadores.find((i) => i.nome === "Margem Bruta");
    expect(mb).toBeDefined();
    // 840 ÷ 1200 = 70% no REALIZADO, pela fórmula do IBR — sem conta paralela.
    expect(mb!.valores["2025"] as number).toBeCloseTo(0.7, 6);
    // E a coluna projetada continua presente na mesma linha.
    expect(mb!.valores).toHaveProperty("2026");
  });

  it("sem histórico o resultado é IDÊNTICO ao de antes (nada regride)", () => {
    const semHist = indicadoresIbrDoModelo(modelo(), ["2026"]);
    const comVazio = indicadoresIbrDoModelo(modelo(), ["2026"], { historico: { periodos: [], bp: [] } });
    expect(comVazio.periodos).toEqual(["2026"]);
    expect(JSON.stringify(comVazio.indicadores)).toBe(JSON.stringify(semHist.indicadores));
  });
});
