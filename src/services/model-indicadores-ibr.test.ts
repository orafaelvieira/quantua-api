import { describe, it, expect } from "vitest";
import { calcularModelo } from "./model-engine";
import type { BlocoModelo } from "./model-engine";
import { projecaoComoDfsDoIbr, indicadoresIbrDoModelo } from "./model-indicadores-ibr";
import { INDICADORES_TEMPLATE } from "./financial-templates";

/**
 * ESPELHO DO IBR NO VALUATION/BP (pedido do usuário, 24/07/2026).
 *
 * O que estes testes protegem: que a projeção traduzida entra no MESMO calculador
 * do IBR com os sinais certos e os prazos certos — as duas coisas que, se
 * saírem erradas, produzem números plausíveis e falsos (margem acima de 100%,
 * prazo médio dobrado num ano parcial).
 */

const MESES = (ano: string) => Array.from({ length: 12 }, (_, i) => `${ano}-${String(i + 1).padStart(2, "0")}`);

/** Modelo mínimo: receita fixa de 1.000/mês e um custo de 30% da receita. */
function modeloBase(mesInicial = "2026-01", horizonteMeses = 24) {
  const blocks = [
    { id: "r", tipo: "receitas", nome: "Receitas", ordem: 0, ativo: true, config: {
      linhasReceita: [{ id: "lin1", nome: "Vendas", nodeRaiz: "n1",
        nodes: [{ id: "n1", nome: "Vendas", tipo: "serie", unidade: "R$", params: { modoPreenchimento: "simples", valorMensal: 1000, crescimentoAnual: 0 } }] }],
    } },
    { id: "c", tipo: "custos", nome: "Custos", ordem: 1, ativo: true, config: {
      linhasCusto: [{ id: "c1", nome: "Custo direto", modo: "pctReceita", pct: 0.3 }],
    } },
    { id: "g", tipo: "giro", nome: "Giro", ordem: 2, ativo: true, config: { pmr: 30, pme: 0, pmp: 15 } },
  ] as unknown as BlocoModelo[];
  return calcularModelo({ mesInicial, horizonteMeses, blocks } as never);
}

const valorDe = (inds: ReturnType<typeof indicadoresIbrDoModelo>, nome: string, ano: string) =>
  inds.find((i) => i.nome === nome)?.valores[ano] ?? null;

describe("projeção traduzida para o formato do IBR", () => {
  it("SINAL: as saídas viram NEGATIVAS (o motor guarda positivo e subtrai)", () => {
    const { dre } = projecaoComoDfsDoIbr(modeloBase(), ["2026", "2027"]);
    const conta = (c: string) => dre.find((l) => l.conta === c)!.valores["2026"];
    expect(conta("Receita Bruta")).toBeGreaterThan(0);
    // 12 × 1.000 × 30% = 3.600 de custo, que no IBR entra como −3.600.
    expect(conta("Custo Operacional")).toBeCloseTo(-3600, 6);
    expect(conta("Custo Operacional")).toBeLessThan(0);
  });

  it("a cascata do IBR FECHA com os subtotais do motor (lucro bruto = RL + custo)", () => {
    const { dre } = projecaoComoDfsDoIbr(modeloBase(), ["2026"]);
    const conta = (c: string) => dre.find((l) => l.conta === c)!.valores["2026"];
    // A conta do IBR é SOMA porque a saída já é negativa — se o sinal estivesse
    // invertido, esta igualdade quebraria.
    expect(conta("Receita Líquida") + conta("Custo Operacional")).toBeCloseTo(conta("Lucro Bruto"), 6);
  });

  it("BALANÇO é SALDO (fim do ano), não soma dos meses", () => {
    const { bp } = projecaoComoDfsDoIbr(modeloBase(), ["2026"]);
    const cr = bp.find((l) => l.conta === "Contas a Receber - CP")!.valores["2026"];
    // PMR de 30 dias sobre 1.000/mês ≈ um mês de receita — não 12 meses somados.
    expect(cr).toBeGreaterThan(0);
    expect(cr).toBeLessThan(2000);
  });

  it("classificação AO/PO preenchida — é dela que sai a NCG do IBR", () => {
    const { bp } = projecaoComoDfsDoIbr(modeloBase(), ["2026"]);
    expect(bp.find((l) => l.conta === "Contas a Receber - CP")!.classificacao).toBe("AO");
    expect(bp.find((l) => l.conta === "Fornecedores - CP")!.classificacao).toBe("PO");
  });

  it("ANO PARCIAL usa os dias REAIS (6 meses = 180), não 365", () => {
    // Horizonte começando em julho: 2026 tem 6 meses.
    const r = modeloBase("2026-07", 18);
    const { diasPorPeriodo } = projecaoComoDfsDoIbr(r, ["2026", "2027"]);
    expect(diasPorPeriodo["2026"]).toBe(180);
    expect(diasPorPeriodo["2027"]).toBe(365);
  });
});

describe("indicadores do modelo no catálogo do IBR", () => {
  it("devolve o catálogo INTEIRO do IBR, na mesma ordem", () => {
    const inds = indicadoresIbrDoModelo(modeloBase(), ["2026", "2027"]);
    expect(inds.length).toBe(INDICADORES_TEMPLATE.length);
    expect(inds.map((i) => i.nome)).toEqual(INDICADORES_TEMPLATE.map((t) => t.nome));
    expect(inds.map((i) => i.tipo)).toEqual(INDICADORES_TEMPLATE.map((t) => t.tipo));
  });

  it("MARGEM BRUTA bate com a premissa (custo de 30% ⇒ margem de 70%)", () => {
    const inds = indicadoresIbrDoModelo(modeloBase(), ["2026"]);
    expect(valorDe(inds, "Margem Bruta", "2026")).toBeCloseTo(0.7, 6);
  });

  it("PRAZO MÉDIO de recebimento devolve o PMR informado (30 dias)", () => {
    const inds = indicadoresIbrDoModelo(modeloBase(), ["2026", "2027"]);
    // 2027 é ano cheio: o prazo tem de reproduzir a premissa de giro.
    expect(valorDe(inds, "Prazo Médio Contas a Receber", "2027") as number).toBeCloseTo(30, 0);
  });

  it("ANO PARCIAL não infla o prazo médio (a armadilha dos 365 dias)", () => {
    const parcial = indicadoresIbrDoModelo(modeloBase("2026-07", 18), ["2026"]);
    // Com 365 dias sobre 6 meses de receita o PMR sairia ~2× (≈61 dias).
    expect(parcial.find((i) => i.nome === "Prazo Médio Contas a Receber")!.valores["2026"] as number)
      .toBeCloseTo(30, 0);
  });
});

describe("EVA (Valor Econômico Agregado)", () => {
  it("está no grupo de Rentabilidade, logo depois do ROIC", () => {
    const nomes = INDICADORES_TEMPLATE.filter((t) => t.tipo === "Indicadores de Rentabilidade").map((t) => t.nome);
    expect(nomes).toContain("EVA (Valor Econômico Agregado)");
    expect(nomes.indexOf("EVA (Valor Econômico Agregado)")).toBe(nomes.indexOf("ROIC (Retorno sobre Capital Investido)") + 1);
  });

  it("SEM custo de capital fica null — não inventa um WACC", () => {
    const inds = indicadoresIbrDoModelo(modeloBase(), ["2026"]);
    expect(valorDe(inds, "EVA (Valor Econômico Agregado)", "2026")).toBeNull();
  });

  it("COM custo de capital: EVA = (ROIC − custo) × Capital Investido", () => {
    const custoCapital = 0.12;
    const inds = indicadoresIbrDoModelo(modeloBase(), ["2026"], { custoCapital });
    const eva = valorDe(inds, "EVA (Valor Econômico Agregado)", "2026") as number;
    const roic = valorDe(inds, "ROIC (Retorno sobre Capital Investido)", "2026") as number;
    const nopat = valorDe(inds, "NOPAT", "2026") as number;
    expect(typeof eva).toBe("number");
    // As duas formas de escrever o EVA têm de dar o mesmo número.
    const capitalInvestido = nopat / roic;
    expect(eva).toBeCloseTo((roic - custoCapital) * capitalInvestido, 4);
    expect(eva).toBeCloseTo(nopat - capitalInvestido * custoCapital, 4);
  });

  it("custo de capital MAIOR que o ROIC ⇒ EVA negativo (destruiu valor)", () => {
    const inds = indicadoresIbrDoModelo(modeloBase(), ["2026"]);
    const roic = valorDe(inds, "ROIC (Retorno sobre Capital Investido)", "2026") as number;
    const caro = indicadoresIbrDoModelo(modeloBase(), ["2026"], { custoCapital: roic + 0.05 });
    expect(valorDe(caro, "EVA (Valor Econômico Agregado)", "2026") as number).toBeLessThan(0);
  });
});

describe("nada quebrou no IBR", () => {
  it("os anos do horizonte viram os PERÍODOS dos indicadores", () => {
    const anos = ["2026", "2027"];
    const inds = indicadoresIbrDoModelo(modeloBase(), anos);
    for (const i of inds) expect(Object.keys(i.valores).sort()).toEqual(anos);
  });

  it("um modelo sem giro nem dívida não explode — devolve zeros/null, não NaN", () => {
    const blocks = [
      { id: "r", tipo: "receitas", nome: "Receitas", ordem: 0, ativo: true, config: {
        linhasReceita: [{ id: "l", nome: "V", nodeRaiz: "n",
          nodes: [{ id: "n", nome: "V", tipo: "serie", unidade: "R$", params: { modoPreenchimento: "simples", valorMensal: 500, crescimentoAnual: 0 } }] }],
      } },
    ] as unknown as BlocoModelo[];
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 12, blocks } as never);
    const inds = indicadoresIbrDoModelo(r, ["2026"]);
    for (const i of inds) {
      const v = i.valores["2026"];
      if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
    }
    expect(MESES("2026").length).toBe(12); // sanidade do helper
  });
});
