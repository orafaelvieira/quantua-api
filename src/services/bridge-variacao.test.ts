import { describe, expect, it } from "vitest";
import type { BPLineItem, DRELineItem } from "../types/financial";
import { buildIndirectCashFlow } from "./cash-flow-indirect";
import { buildPontesVariacao, parComparavelSrv } from "./bridge-variacao";

/**
 * Fixture sintética na CONVENÇÃO CANÔNICA (receitas +, despesas/IR −; subtotais
 * por soma; BP com classificacao/nivel). Dois exercícios consecutivos com
 * números redondos para as provas fecharem ao centavo.
 */
const P0 = "31/12/2024";
const P1 = "31/12/2025";

const dreLinha = (conta: string, subtotal: boolean, v0: number, v1: number): DRELineItem => ({
  conta, subtotal, editado: false, valores: { [P0]: v0, [P1]: v1 },
});

// DRE: RL 1000→1200 · Custo −600→−690 · LB 400→510 · Desp G&A −100→−120 ·
// Vendas −50→−60 · EBITDA 250→330 · D&A −40→−50 · EBIT 210→280 · RF −30→−35 ·
// LAIR 180→245 · IR −45→−61,25 (25%) · LL 135→183,75
const dre: DRELineItem[] = [
  dreLinha("Receita Bruta", false, 1100, 1320),
  dreLinha("Deduções da Receita Bruta", false, -60, -72),
  dreLinha("Impostos s/ Faturamento", false, -40, -48),
  dreLinha("Receita Líquida", true, 1000, 1200),
  dreLinha("Custo Operacional", false, -600, -690),
  dreLinha("Lucro Bruto", true, 400, 510),
  dreLinha("Despesas Gerais e Administrativas", false, -100, -120),
  dreLinha("Despesas com Vendas", false, -50, -60),
  dreLinha("EBITDA", true, 250, 330),
  dreLinha("Depreciação e Amortização", false, -40, -50),
  dreLinha("EBIT", true, 210, 280),
  dreLinha("Resultado Financeiro", true, -30, -35),
  dreLinha("Receitas Financeiras", false, 5, 5),
  dreLinha("Despesas Financeiras", false, -35, -40),
  dreLinha("Resultado Não Operacional", true, 0, 0),
  dreLinha("Resultado Antes do IR e CSLL", true, 180, 245),
  dreLinha("IR e CSLL", false, -45, -61.25),
  dreLinha("Lucro Líquido", true, 135, 183.75),
];

const bpLinha = (classificacao: string, conta: string, nivel: number, v0: number, v1: number): BPLineItem => ({
  classificacao, conta, nivel, editado: false, valores: { [P0]: v0, [P1]: v1 },
});

// BP fechado nos 2 períodos (AT = PT). Caixa 100→131,75; CR 200→260; Est 150→180;
// Fornecedores 120→150; Empréstimos CP 80→90, LP 200→220; PL 400→583,75 (lucro retido).
// Imobilizado cresce 40→(+capex 90, D&A -50): 350→390 líquido via bruto+redutora.
const bp: BPLineItem[] = [
  bpLinha("AT", "Ativo Total", 0, 850, 1043.75),
  bpLinha("AC", "Ativo Circulante", 1, 450, 571.75),
  bpLinha("AF", "Caixa e Equivalentes de Caixa", 2, 100, 131.75),
  bpLinha("AO", "Contas a Receber - CP", 2, 200, 260),
  bpLinha("AO", "Estoques - CP", 2, 150, 180),
  bpLinha("ANC", "Ativo Não Circulante", 1, 400, 472),
  bpLinha("ANC", "Imobilizado", 2, 500, 622),
  bpLinha("ANC", "(-) Depreciação", 2, -100, -150),
  bpLinha("PT", "Passivo Total", 0, 850, 1043.75),
  bpLinha("PC", "Passivo Circulante", 1, 250, 290),
  bpLinha("PO", "Fornecedores - CP", 2, 120, 150),
  bpLinha("PO", "Obrigações Tributárias - CP", 2, 50, 50),
  bpLinha("PF", "Empréstimos e Financiamentos - CP", 2, 80, 90),
  bpLinha("PNC", "Passivo Não Circulante", 1, 200, 170),
  bpLinha("PNC", "Empréstimos e Financiamentos - LP", 2, 200, 170),
  bpLinha("PL", "Patrimônio Líquido", 1, 400, 583.75),
  bpLinha("PL", "Capital Social", 2, 265, 265),
  bpLinha("PL", "Lucros/Prejuízos Acumulados", 2, 135, 318.75),
];

const periodos = [P0, P1];

function pontesDaFixture() {
  const fluxoCaixa = buildIndirectCashFlow(bp, dre, periodos);
  expect(fluxoCaixa).not.toBeNull();
  return { fc: fluxoCaixa!, pontes: buildPontesVariacao({ bp, dre, periodos, fluxoCaixa }, { regimeCadastro: "Lucro Real" })! };
}

describe("buildPontesVariacao — ponte de resultado", () => {
  it("EBITDA: Σ barras = Δ EBITDA, com prova fechada e barras por linha da DRE", () => {
    const { pontes } = pontesDaFixture();
    const p = pontes.ponteEbitda!;
    expect(p.inicial).toBe(250);
    expect(p.final).toBe(330);
    expect(p.prova.deltaObservado).toBe(80);
    expect(p.prova.fecha).toBe(true);
    const nomes = p.barras.map((b) => b.nome);
    expect(nomes).toContain("Δ Receita Bruta");
    expect(nomes).toContain("Δ Custo Operacional");
    // Barra de custo é NEGATIVA (custo cresceu → derruba o EBITDA).
    expect(p.barras.find((b) => b.nome === "Δ Custo Operacional")!.valor).toBe(-90);
  });

  it("Lucro Líquido: 1ª barra é o Δ EBITDA e a prova fecha até o LL", () => {
    const { pontes } = pontesDaFixture();
    const p = pontes.ponteLucro!;
    expect(p.barras[0]).toEqual({ nome: "Δ EBITDA", valor: 80 });
    expect(p.prova.deltaObservado).toBe(48.75);
    expect(p.prova.fecha).toBe(true);
  });

  it("documento só com subtotal (componentes zerados) NÃO fecha — ponte não vira número", () => {
    const soSubtotais = dre.map((l) => (l.subtotal ? l : { ...l, valores: { [P0]: 0, [P1]: 0 } }));
    const pontes = buildPontesVariacao({ bp, dre: soSubtotais, periodos, fluxoCaixa: null })!;
    expect(pontes.ponteEbitda!.prova.fecha).toBe(false);
  });
});

describe("buildPontesVariacao — hierarquia do caixa", () => {
  it("FCO recomposto (EBITDA + IR + RF + RNO + Δgiro) concilia com o FC indireto e a cadeia fecha no ΔCaixa", () => {
    const { fc, pontes } = pontesDaFixture();
    const h = pontes.hierarquiaCaixa!;
    expect(h.provaFco.fecha).toBe(true);
    expect(h.provaDeltaCaixa.fecha).toBe(true);
    expect(h.provaDeltaCaixa.deltaObservado).toBe(fc.prova.find((p) => p.periodo === P1)!.deltaObservado);
    // Degraus começam no EBITDA e terminam na variação do caixa.
    expect(h.degraus[0]!.nome).toContain("EBITDA");
    expect(h.degraus[h.degraus.length - 1]!.nome).toContain("Variação do caixa");
  });

  it("taxa de conversão de caixa = FCO/EBITDA por coluna provada; alíquota efetiva = IR/LAIR", () => {
    const { fc, pontes } = pontesDaFixture();
    const h = pontes.hierarquiaCaixa!;
    const t = h.taxaConversao.find((x) => x.periodo === P1)!;
    expect(t.ebitda).toBe(330);
    expect(t.taxa).toBeCloseTo(fc.totais.fco[P1]! / 330, 2);
    expect(h.premissas.aliquotaEfetiva).toBeCloseTo(0.25, 2);
    expect(h.premissas.regimeCadastro).toBe("Lucro Real");
  });

  it("item operacional FORA do sub-bloco de capital de giro (tributos) não quebra a conciliação", () => {
    // "Obrigações Tributárias - CP" é operacional (entra no FCO) mas NÃO faz parte
    // do sub-bloco capitalGiro do FC — a recomposição precisa considerá-la.
    const bpTrib = bp.map((l) => (l.conta === "Obrigações Tributárias - CP" ? { ...l, valores: { [P0]: 50, [P1]: 95 } } : l));
    // O caixa acompanha (passivo cresce → gera caixa) para o BP seguir fechando.
    const bpAj = bpTrib.map((l) => {
      if (l.conta === "Caixa e Equivalentes de Caixa") return { ...l, valores: { [P0]: 100, [P1]: 176.75 } };
      if (l.conta === "Ativo Circulante") return { ...l, valores: { [P0]: 450, [P1]: 616.75 } };
      if (l.conta === "Ativo Total") return { ...l, valores: { [P0]: 850, [P1]: 1088.75 } };
      if (l.conta === "Passivo Circulante") return { ...l, valores: { [P0]: 250, [P1]: 335 } };
      if (l.conta === "Passivo Total") return { ...l, valores: { [P0]: 850, [P1]: 1088.75 } };
      return l;
    });
    const fluxoCaixa = buildIndirectCashFlow(bpAj, dre, periodos)!;
    expect(fluxoCaixa.prova.find((p) => p.periodo === P1)!.fecha).toBe(true);
    const pontes = buildPontesVariacao({ bp: bpAj, dre, periodos, fluxoCaixa })!;
    expect(pontes.hierarquiaCaixa).not.toBeNull();
    expect(pontes.hierarquiaCaixa!.provaFco.fecha).toBe(true);
    expect(pontes.hierarquiaCaixa!.provaDeltaCaixa.fecha).toBe(true);
  });

  it("sem prova do FC fechada, a hierarquia não existe", () => {
    const { fc } = pontesDaFixture();
    const quebrado = { ...fc, prova: fc.prova.map((p) => ({ ...p, fecha: false })) };
    const pontes = buildPontesVariacao({ bp, dre, periodos, fluxoCaixa: quebrado })!;
    expect(pontes.hierarquiaCaixa).toBeNull();
  });
});

describe("buildPontesVariacao — NCG em dias e DuPont", () => {
  it("NCG: efeitos prazo + crescimento + demais itens fecham no ΔNCG", () => {
    const { pontes } = pontesDaFixture();
    const n = pontes.ponteNcg!;
    // NCG = AO − |PO|: (200+150) − (120+50) = 180 → (260+180) − (150+50) = 240.
    expect(n.ncgInicial).toBe(180);
    expect(n.ncgFinal).toBe(240);
    expect(n.prova.deltaObservado).toBe(60);
    expect(n.prova.fecha).toBe(true);
    // O ROTULO DIZ QUE E' EFEITO EM R$ e carrega o prazo que o causou — antes
    // era so' "Prazo de recebimento (PMR)" ao lado de um numero em reais, e o
    // dono perguntou "a coluna valor e' R$ ou dias?".
    const efPmr = n.efeitos.find((e) => e.nome.startsWith("Efeito do prazo de recebimento"));
    expect(efPmr, "linha do efeito do prazo de recebimento").toBeTruthy();
    expect(efPmr!.nome).toMatch(/\(\d+ → \d+ dias\)/);
    // e o METODO viaja junto, porque a decomposicao nao e' obvia
    expect(n.metodo).toContain("EFEITO DO PRAZO");
  });

  it("DuPont: decomposição sequencial exata (resíduo ~0) e conclusiva", () => {
    const { pontes } = pontesDaFixture();
    const d = pontes.dupont!;
    expect(d.conclusiva).toBe(true);
    const soma = d.efeitos.margem + d.efeitos.giro + d.efeitos.alavancagem + d.efeitos.residuo;
    expect(soma).toBeCloseTo(d.roeFinal - d.roeInicial, 3);
    expect(Math.abs(d.efeitos.residuo)).toBeLessThan(0.001);
  });

  it("ROE nulo nos dois períodos (DRE sem resultado) → sem seção DuPont (ruído, não leitura)", () => {
    const dreSemLucro = dre.map((l) => (l.conta === "Lucro Líquido" ? { ...l, valores: { [P0]: 0, [P1]: 0 } } : l));
    const pontes = buildPontesVariacao({ bp, dre: dreSemLucro, periodos, fluxoCaixa: null })!;
    expect(pontes.dupont).toBeNull();
  });

  it("PL economicamente negativo → DuPont não conclusiva com nota; convenção crédito-negativa não dispara", () => {
    // Economicamente negativo: PT positivo, PL negativo.
    const bpNeg = bp.map((l) => (l.conta === "Patrimônio Líquido" ? { ...l, valores: { [P0]: -50, [P1]: -30 } } : l));
    const p1 = buildPontesVariacao({ bp: bpNeg, dre, periodos, fluxoCaixa: null })!;
    expect(p1.dupont!.conclusiva).toBe(false);
    expect(p1.dupont!.nota).toMatch(/Patrimônio/);
    // Convenção: passivo INTEIRO negativo — PL "negativo" é só sinal do sistema.
    const bpConv = bp.map((l) =>
      ["PT", "PC", "PO", "PF", "PNC", "PL"].includes(l.classificacao)
        ? { ...l, valores: { [P0]: -(l.valores[P0] ?? 0), [P1]: -(l.valores[P1] ?? 0) } }
        : l
    );
    const p2 = buildPontesVariacao({ bp: bpConv, dre, periodos, fluxoCaixa: null })!;
    expect(p2.dupont!.conclusiva).toBe(true);
  });
});

describe("buildPontesVariacao — guardas de período", () => {
  it("menos de 2 períodos → null", () => {
    expect(buildPontesVariacao({ bp, dre, periodos: [P1], fluxoCaixa: null })).toBeNull();
  });

  it("lacuna da série entre o par → bloqueio explícito, nenhuma ponte calculada", () => {
    const serie = { ok: false, lacunas: [{ de: "01/01/2025", ate: "30/06/2025", rotulo: "1º semestre/2025" }] };
    const pontes = buildPontesVariacao({ bp, dre, periodos, fluxoCaixa: null, serie })!;
    expect(pontes.bloqueio).toMatch(/lacuna/);
    expect(pontes.ponteEbitda).toBeNull();
    expect(pontes.dupont).toBeNull();
  });

  it("heurística de legado: anos não consecutivos → bloqueio; YTDs do mesmo exercício → comparável", () => {
    expect(parComparavelSrv("31/12/2022", "31/12/2025").ok).toBe(false);
    expect(parComparavelSrv("31/03/2025", "30/09/2025").ok).toBe(true);
    expect(parComparavelSrv("31/12/2024", "31/05/2025").ok).toBe(true);
  });

  it("ano cheio vs YTD parcial (balancete) NÃO vira ponte de fluxo: recua para o par de janela igual e declara", () => {
    const MES = "31/05/2026";
    const anoAnterior = "31/12/2023";
    const comMes = {
      bp: bp.map((l) => ({ ...l, valores: { ...l.valores, [MES]: (l.valores[P1] ?? 0) * 0.4, [anoAnterior]: (l.valores[P0] ?? 0) * 0.9 } })),
      dre: dre.map((l) => ({ ...l, valores: { ...l.valores, [MES]: (l.valores[P1] ?? 0) * 0.4, [anoAnterior]: (l.valores[P0] ?? 0) * 0.9 } })),
      periodos: [anoAnterior, P0, P1, MES],
      fluxoCaixa: null,
      arvoresBalancete: [{ periodo: MES }],
    };
    const pontes = buildPontesVariacao(comMes)!;
    // O último par (ano cheio → YTD de 5 meses) é descartado; vale 2024 → 2025.
    expect(pontes.par).toMatchObject({ de: P0, ate: P1 }); // o par carrega tambem os rotulos prontos
    // O aviso NOMEIA o período que ficou de fora — em rótulo de leitura
    // (05/2026), nunca na data de fechamento (regra de período do dono).
    expect(pontes.avisoPar).toMatch(/05\/2026/);
    expect(pontes.avisoPar).not.toMatch(/31\/05\/2026/);
    expect(pontes.ponteEbitda!.prova.fecha).toBe(true);
  });

  it("par no fim da série (janelas iguais) não gera aviso de recuo", () => {
    const pontes = buildPontesVariacao({ bp, dre, periodos, fluxoCaixa: null })!;
    expect(pontes.par).toMatchObject({ de: P0, ate: P1 }); // o par carrega tambem os rotulos prontos
    expect(pontes.avisoPar).toBeNull();
  });
});
