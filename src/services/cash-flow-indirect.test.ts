import { describe, it, expect } from "vitest";
import { buildIndirectCashFlow, bucketDaConta } from "./cash-flow-indirect";
import type { BPLineItem, DRELineItem } from "../types/financial";

// BP sintético FECHADO (AT=PT nos dois períodos) — variações conhecidas:
//   Caixa            100 → 260   (ΔCaixa = +160 — o que a prova precisa bater)
//   Contas a Receber 200 → 250   (Δ+50  → FCO −50)
//   Estoques         150 → 130   (Δ−20  → FCO +20)
//   Imobilizado      500 → 560   (Δ+60; D&A 40 → capex bruto −100 no FCI)
//   Fornecedores     120 → 170   (Δ+50  → FCO +50)
//   Empréstimos CP   180 → 230   (Δ+50  → FCF +50)
//   Capital Social   300 → 320   (Δ+20  → aporte, FCF +20 via ΔPL−lucro)
//   Lucros Acum.     350 → 480   (Δ+130 = lucro 170 − dividendos 40 → FCF −40 via ΔPL−lucro)
//   PL total         650 → 800 (Δ150); lucro 170 → ΔPL−lucro = −20 (aporte +20, dividendos −40)
// Identidade: 170 (LL) + 40 (D&A) − 50 + 20 + 50 (FCO=230) − 100 (FCI) + 50 − 20 (FCF=30) = 160 ✓
const bpLine = (classificacao: string, conta: string, nivel: number, v0: number, v1: number): BPLineItem =>
  ({ classificacao, conta, nivel, editado: false, valores: { "2022": v0, "2023": v1 } });

const BP: BPLineItem[] = [
  bpLine("AT", "Ativo Total", 0, 950, 1200),
  bpLine("AC", "Ativo Circulante", 1, 450, 640),
  bpLine("AF", "Caixa e Equivalentes de Caixa", 2, 100, 260),
  bpLine("AO", "Contas a Receber - CP", 2, 200, 250),
  bpLine("AO", "Estoques - CP", 2, 150, 130),
  bpLine("ANC", "Ativo Não Circulante", 1, 500, 560),
  bpLine("ANC", "Imobilizado", 2, 500, 560),
  bpLine("PT", "Passivo Total", 0, 950, 1200),
  bpLine("PC", "Passivo Circulante", 1, 300, 400),
  bpLine("PO", "Fornecedores - CP", 2, 120, 170),
  bpLine("PF", "Empréstimos e Financiamentos - CP", 2, 180, 230),
  bpLine("PL", "Patrimônio Líquido", 1, 650, 800),
  bpLine("PL", "Capital Social", 2, 300, 320),
  bpLine("PL", "Lucros/Prejuízos Acumulados", 2, 350, 480),
];

const dreLine = (conta: string, v1: number): DRELineItem =>
  ({ conta, subtotal: false, editado: false, valores: { "2023": v1 } });
const DRE: DRELineItem[] = [
  dreLine("Lucro Líquido", 170),
  dreLine("Depreciação e Amortização", -40), // convenção: redutora negativa
];

describe("buildIndirectCashFlow", () => {
  it("FCO/FCI/FCF corretos e prova de fechamento BATE com o ΔCaixa do BP", () => {
    const fc = buildIndirectCashFlow(BP, DRE, ["2022", "2023"])!;
    expect(fc).not.toBeNull();
    expect(fc.colunas).toEqual(["2023"]);
    expect(fc.totais.fco["2023"]).toBeCloseTo(170 + 40 - 50 + 20 + 50, 2); // 230
    expect(fc.totais.fci["2023"]).toBeCloseTo(-100, 2);                    // capex bruto (Δ60 + D&A 40)
    expect(fc.totais.fcf["2023"]).toBeCloseTo(50 - 20, 2);                 // empréstimos +50; ΔPL−lucro −20
    expect(fc.totais.geracaoTotal["2023"]).toBeCloseTo(160, 2);
    expect(fc.prova[0].deltaObservado).toBeCloseTo(160, 2);
    expect(fc.prova[0].fecha).toBe(true);
    expect(fc.avisos.length).toBe(0);
  });

  it("linha de capex é BRUTA (Δ imobilizado líquido + D&A de volta)", () => {
    const fc = buildIndirectCashFlow(BP, DRE, ["2022", "2023"])!;
    const capex = fc.fci.find((l) => /capex/i.test(l.nome));
    expect(capex?.valores["2023"]).toBeCloseTo(-100, 2);
  });

  it("menos de 2 períodos → null (chamador exibe aviso de período curto)", () => {
    expect(buildIndirectCashFlow(BP, DRE, ["2023"])).toBeNull();
    expect(buildIndirectCashFlow(BP, DRE, [])).toBeNull();
  });

  it("BP que NÃO fecha (AT≠PT) → prova vermelha com aviso, nunca esconde", () => {
    const bpQuebrado = BP.map((l) =>
      l.conta === "Fornecedores - CP" ? { ...l, valores: { "2022": 120, "2023": 100 } } : l
    ); // tira 70 do passivo sem contrapartida → identidade não fecha
    const fc = buildIndirectCashFlow(bpQuebrado, DRE, ["2022", "2023"])!;
    expect(fc.prova[0].fecha).toBe(false);
    expect(fc.avisos.length).toBeGreaterThan(0);
  });

  it("multi-anual: 3 períodos → 2 colunas de variação", () => {
    const bp3 = BP.map((l) => ({ ...l, valores: { ...l.valores, "2024": l.valores["2023"] } }));
    const dre3 = [dreLine("Lucro Líquido", 170), dreLine("Depreciação e Amortização", -40)];
    dre3[0].valores["2024"] = 0; dre3[1].valores["2024"] = 0;
    const fc = buildIndirectCashFlow(bp3, dre3, ["2022", "2023", "2024"])!;
    expect(fc.colunas).toEqual(["2023", "2024"]);
    expect(fc.prova[1].deltaObservado).toBeCloseTo(0, 2); // 2024 = cópia de 2023, ΔCaixa 0
    expect(fc.prova[1].fecha).toBe(true);
  });

  it("equivalência patrimonial: estorno no FCO com contrapartida em Investimentos (identidade fecha)", () => {
    // Investimentos cresce 30 só por equivalência (nenhum caixa) — e o caixa não muda por isso.
    const bpEq = [
      bpLine("AT", "Ativo Total", 0, 500, 530),
      bpLine("AC", "Ativo Circulante", 1, 100, 100),
      bpLine("AF", "Caixa e Equivalentes de Caixa", 2, 100, 100),
      bpLine("ANC", "Ativo Não Circulante", 1, 400, 430),
      bpLine("ANC", "Investimentos", 2, 400, 430),
      bpLine("PT", "Passivo Total", 0, 500, 530),
      bpLine("PL", "Patrimônio Líquido", 1, 500, 530),
      bpLine("PL", "Lucros/Prejuízos Acumulados", 2, 500, 530),
    ];
    const dreEq = [dreLine("Lucro Líquido", 30), dreLine("Equivalência Patrimonial", 30)];
    const fc = buildIndirectCashFlow(bpEq, dreEq, ["2022", "2023"])!;
    expect(fc.totais.geracaoTotal["2023"]).toBeCloseTo(0, 2); // nada de caixa se moveu
    expect(fc.prova[0].fecha).toBe(true);
  });

  it("bucketDaConta: fallback por palavra-chave cobre conta adicionada pelo usuário", () => {
    expect(bucketDaConta("Debêntures a Pagar - LP")).toBe("fcf");
    expect(bucketDaConta("Obras em Andamento (Imobilizado)")).toBe("fci");
    expect(bucketDaConta("Adiantamento de Clientes")).toBe("fco");
  });
});
