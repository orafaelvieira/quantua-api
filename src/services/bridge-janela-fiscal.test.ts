import { describe, expect, it } from "vitest";
import type { BPLineItem, DRELineItem } from "../types/financial";
import { buildPontesVariacao } from "./bridge-variacao";
import { buildIndirectCashFlow } from "./cash-flow-indirect";

/**
 * JANELA DA HIERARQUIA DO CAIXA e CARGA TRIBUTÁRIA (defeitos vistos no IBR da
 * Belagro, 20/08/2026).
 *
 * O fluxo de caixa indireto mede o INTERVALO entre duas colunas: quando as duas
 * são balancete do mesmo exercício, ele desacumula e o FCO da coluna 31/12 é o
 * caixa de DEZEMBRO. A hierarquia, porém, lia EBITDA/IR/LAIR CRUS da coluna —
 * o ACUMULADO DO ANO. O resultado publicado misturava doze meses de resultado
 * com um mês de caixa, e o degrau "Var. capital de giro", que é derivado por
 * diferença (`giro = fco − lucro + da + eqP`), virava um PLUG que engolia os
 * outros onze meses. A prova fechava assim mesmo, porque ela testa a cascata da
 * DRE — nunca a janela. Foi assim que saiu "conversão de caixa −6%": −809 mil de
 * dezembro divididos por R$ 13,80 mi de EBITDA do ano inteiro.
 *
 * NENHUM teste da suíte pegava isso: todas as fixtures da ponte usam períodos
 * anuais sem `arvoresBalancete`, onde não há o que desacumular. Entrada pobre.
 */

const A24 = "31/12/2024";
const N25 = "30/11/2025";
const D25 = "31/12/2025";

const dreL = (conta: string, subtotal: boolean, v: Record<string, number>): DRELineItem => ({ conta, subtotal, editado: false, valores: v });
const bpL = (classificacao: string, conta: string, nivel: number, v: Record<string, number>): BPLineItem => ({ classificacao, conta, nivel, editado: false, valores: v });

/**
 * Série no formato da Belagro: três balancetes, dois deles fechando dezembro de
 * anos diferentes (o par ano-a-ano), e um mês intermediário que faz o FC
 * desacumular a última coluna.
 *
 * DRE ACUMULADA NO ANO. O intervalo de dezembro/2025 (D − N) é:
 *   EBITDA 30 · D&A −5 · RF −5 · LAIR 20 · IR −5 · LL 15
 * Se a hierarquia ler a coluna crua, ela publica EBITDA 330 — onze vezes maior.
 */
function serieBalancete() {
  const dre: DRELineItem[] = [
    dreL("Receita Bruta", false, { [A24]: 1100, [N25]: 1210, [D25]: 1320 }),
    dreL("Impostos s/ Faturamento", false, { [A24]: -100, [N25]: -110, [D25]: -120 }),
    dreL("Receita Líquida", true, { [A24]: 1000, [N25]: 1100, [D25]: 1200 }),
    dreL("Custo Operacional", false, { [A24]: -600, [N25]: -650, [D25]: -690 }),
    dreL("Lucro Bruto", true, { [A24]: 400, [N25]: 450, [D25]: 510 }),
    dreL("Despesas Gerais e Administrativas", false, { [A24]: -150, [N25]: -150, [D25]: -180 }),
    dreL("EBITDA", true, { [A24]: 250, [N25]: 300, [D25]: 330 }),
    dreL("Depreciação e Amortização", false, { [A24]: -40, [N25]: -45, [D25]: -50 }),
    dreL("EBIT", true, { [A24]: 210, [N25]: 255, [D25]: 280 }),
    dreL("Resultado Financeiro", true, { [A24]: -30, [N25]: -30, [D25]: -35 }),
    dreL("Resultado Não Operacional", true, { [A24]: 0, [N25]: 0, [D25]: 0 }),
    dreL("Resultado Antes do IR e CSLL", true, { [A24]: 180, [N25]: 225, [D25]: 245 }),
    dreL("IR e CSLL", false, { [A24]: -45, [N25]: -50, [D25]: -55 }),
    dreL("Lucro Líquido", true, { [A24]: 135, [N25]: 175, [D25]: 190 }),
  ];

  // BP fechado nas três datas. De N para D: caixa +20, clientes +10, fornecedores
  // +10, depreciação acumulada −5, lucros acumulados +15 (o LL de dezembro).
  const bp: BPLineItem[] = [
    bpL("AT", "Ativo Total", 0, { [A24]: 850, [N25]: 1012, [D25]: 1037 }),
    bpL("AC", "Ativo Circulante", 1, { [A24]: 450, [N25]: 540, [D25]: 570 }),
    bpL("AF", "Caixa e Equivalentes de Caixa", 2, { [A24]: 100, [N25]: 100, [D25]: 120 }),
    bpL("AO", "Contas a Receber - CP", 2, { [A24]: 200, [N25]: 260, [D25]: 270 }),
    bpL("AO", "Estoques - CP", 2, { [A24]: 150, [N25]: 180, [D25]: 180 }),
    bpL("ANC", "Ativo Não Circulante", 1, { [A24]: 400, [N25]: 472, [D25]: 467 }),
    bpL("ANC", "Imobilizado", 2, { [A24]: 500, [N25]: 622, [D25]: 622 }),
    bpL("ANC", "(-) Depreciação", 2, { [A24]: -100, [N25]: -150, [D25]: -155 }),
    bpL("PT", "Passivo Total", 0, { [A24]: 850, [N25]: 1012, [D25]: 1037 }),
    bpL("PC", "Passivo Circulante", 1, { [A24]: 250, [N25]: 290, [D25]: 300 }),
    bpL("PO", "Fornecedores - CP", 2, { [A24]: 120, [N25]: 150, [D25]: 160 }),
    bpL("PO", "Obrigações Tributárias - CP", 2, { [A24]: 50, [N25]: 50, [D25]: 50 }),
    bpL("PF", "Empréstimos e Financiamentos - CP", 2, { [A24]: 80, [N25]: 90, [D25]: 90 }),
    bpL("PNC", "Passivo Não Circulante", 1, { [A24]: 200, [N25]: 170, [D25]: 170 }),
    bpL("PNC", "Empréstimos e Financiamentos - LP", 2, { [A24]: 200, [N25]: 170, [D25]: 170 }),
    bpL("PL", "Patrimônio Líquido", 1, { [A24]: 400, [N25]: 552, [D25]: 567 }),
    bpL("PL", "Capital Social", 2, { [A24]: 265, [N25]: 377, [D25]: 377 }),
    bpL("PL", "Lucros/Prejuízos Acumulados", 2, { [A24]: 135, [N25]: 175, [D25]: 190 }),
  ];

  const periodos = [A24, N25, D25];
  const arvoresBalancete = periodos.map((periodo) => ({ periodo }));
  const fluxoCaixa = buildIndirectCashFlow(bp, dre, periodos, periodos); // 4o arg: colunas de BALANCETE (DRE acumulada) — e o que producao passa
  return { bp, dre, periodos, arvoresBalancete, balancetes: arvoresBalancete, fluxoCaixa };
}

describe("hierarquia do caixa — a DRE tem de cobrir a mesma janela que o FCO", () => {
  it("o par escolhido é ano-a-ano entre os dois dezembros", () => {
    const p = buildPontesVariacao(serieBalancete(), { regimeCadastro: "Lucro Real" })!;
    expect(p.regua).toBe("ano-a-ano");
    expect(p.par?.ate).toBe(D25);
  });

  it("o FCO desta coluna é o intervalo (dezembro), não o acumulado do ano", () => {
    const d = serieBalancete();
    expect(d.fluxoCaixa).not.toBeNull();
    // Caixa foi de 100 para 120 no intervalo: o FC mede o movimento, não o saldo.
    expect(d.fluxoCaixa!.prova.find((x) => x.periodo === D25)!.deltaObservado).toBeCloseTo(20, 6);
  });

  it("O DEFEITO: o EBITDA da hierarquia é o do INTERVALO (30), não o do ano (330)", () => {
    const p = buildPontesVariacao(serieBalancete(), { regimeCadastro: "Lucro Real" })!;
    const h = p.hierarquiaCaixa!;
    expect(h.intervaloDe).toBe(N25);
    expect(h.degraus[0]!.nome).toContain("EBITDA");
    expect(h.degraus[0]!.valor).toBeCloseTo(30, 6);
  });

  it("o degrau do giro deixa de ser um plug que engole onze meses", () => {
    const p = buildPontesVariacao(serieBalancete(), { regimeCadastro: "Lucro Real" })!;
    const h = p.hierarquiaCaixa!;
    const giro = h.degraus.find((g) => g.nome.toLowerCase().includes("capital de giro") && g.tipo !== "nivel")!;
    // Movimento real do giro em dezembro: clientes +10 (consome) e fornecedores
    // +10 (libera) → 0. Com a janela misturada isso vinha em centenas.
    expect(Math.abs(giro.valor)).toBeLessThan(20);
    expect(h.provaFco.fecha).toBe(true);
    expect(h.provaDeltaCaixa.fecha).toBe(true);
  });
});

describe("carga tributária — janela, sinal e base", () => {
  it("o LAIR é o do intervalo (20), não o acumulado do ano (245)", () => {
    const p = buildPontesVariacao(serieBalancete(), { regimeCadastro: "Lucro Real" })!;
    expect(p.hierarquiaCaixa!.premissas.lairPeriodo).toBeCloseTo(20, 6);
    expect(p.hierarquiaCaixa!.premissas.irPeriodo).toBeCloseTo(-5, 6);
  });

  it("a carga do período sai da mesma janela: 5 ÷ 20 = 25%", () => {
    const p = buildPontesVariacao(serieBalancete(), { regimeCadastro: "Lucro Real" })!;
    expect(p.hierarquiaCaixa!.premissas.aliquotaEfetiva).toBeCloseTo(0.25, 4);
  });

  it("o nominal só existe quando há nominal comparável ao LAIR", () => {
    const comReal = buildPontesVariacao(serieBalancete(), { regimeCadastro: "Lucro Real" })!;
    expect(comReal.hierarquiaCaixa!.premissas.nominalRegime).toBe(0.34);
    const presumido = buildPontesVariacao(serieBalancete(), { regimeCadastro: "Lucro Presumido" })!;
    // Presumido tem base própria (receita), não o LAIR — não há nominal a comparar.
    expect(presumido.hierarquiaCaixa!.premissas.nominalRegime).toBeNull();
    const semCadastro = buildPontesVariacao(serieBalancete())!;
    expect(semCadastro.hierarquiaCaixa!.premissas.nominalRegime).toBeNull();
  });

  it("CRÉDITO de imposto não vira alíquota positiva", () => {
    const d = serieBalancete();
    // Reversão de IR em dezembro: IR YTD passa de −50 para −45 (crédito de +5 no
    // intervalo). Com `Math.abs` isso publicava "25%" para quem GANHOU imposto.
    const dre = d.dre.map((l) => (l.conta === "IR e CSLL" ? { ...l, valores: { ...l.valores, [D25]: -45 } } : l));
    const p = buildPontesVariacao({ ...d, dre }, { regimeCadastro: "Lucro Real" })!;
    expect(p.hierarquiaCaixa!.premissas.irPeriodo).toBeCloseTo(5, 6);
    expect(p.hierarquiaCaixa!.premissas.aliquotaEfetiva).toBeNull();
  });
});

describe("conversão de caixa — só o período da análise", () => {
  it("uma entrada, do mesmo período da hierarquia", () => {
    const p = buildPontesVariacao(serieBalancete(), { regimeCadastro: "Lucro Real" })!;
    const t = p.hierarquiaCaixa!.taxaConversao;
    expect(t).toHaveLength(1);
    expect(t[0]!.periodo).toBe(D25);
  });

  it("numerador e denominador saem da MESMA janela", () => {
    const p = buildPontesVariacao(serieBalancete(), { regimeCadastro: "Lucro Real" })!;
    const t = p.hierarquiaCaixa!.taxaConversao[0]!;
    const h = p.hierarquiaCaixa!;
    expect(t.ebitda).toBeCloseTo(30, 6);            // dezembro, não 330 do ano
    expect(t.fco).toBeCloseTo(h.degraus.find((g) => g.nome.includes("FCO"))!.valor, 6);
    expect(t.taxa).toBeCloseTo(t.fco / t.ebitda, 4);
  });
});
