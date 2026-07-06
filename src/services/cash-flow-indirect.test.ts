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

  it("períodos FORA DE ORDEM (ordem dos documentos) → pareia cronologicamente, nunca cruza anos", () => {
    // dados de produção reais vieram como ["31/12/2022","31/12/2020","31/12/2021"]
    const bp3 = BP.map((l) => ({
      ...l,
      valores: { "31/12/2020": l.valores["2022"], "31/12/2021": l.valores["2023"], "31/12/2022": l.valores["2023"] },
    }));
    const dre3: DRELineItem[] = [
      { conta: "Lucro Líquido", subtotal: false, editado: false, valores: { "31/12/2021": 170, "31/12/2022": 0 } },
      { conta: "Depreciação e Amortização", subtotal: false, editado: false, valores: { "31/12/2021": -40, "31/12/2022": 0 } },
    ];
    const fc = buildIndirectCashFlow(bp3, dre3, ["31/12/2022", "31/12/2020", "31/12/2021"])!;
    expect(fc.colunas).toEqual(["31/12/2021", "31/12/2022"]); // cronológico, não a ordem de entrada
    expect(fc.totais.geracaoTotal["31/12/2021"]).toBeCloseTo(160, 2); // variação 2020→2021 (mesma do caso base)
    expect(fc.prova.every((p) => p.fecha)).toBe(true);
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

  // ─── Partição FCO/FCI/FCF: contas que caíam no grupo errado (auditoria) ───
  it("Realizável a Longo Prazo e Dividendos a RECEBER são INVESTIMENTO (não FCO/FCF)", () => {
    expect(bucketDaConta("Realizável a Longo Prazo")).toBe("fci");
    expect(bucketDaConta("Dividendos a Receber - CP")).toBe("fci");
    expect(bucketDaConta("Dividendos a Receber -  Longo Prazo")).toBe("fci"); // espaço duplo do template
    // dividendos a PAGAR seguem financiamento (o que a empresa distribui)
    expect(bucketDaConta("Dividendos e JCP a Pagar")).toBe("fcf");
  });

  it("Δ Realizável a Longo Prazo aparece no FCI (não no FCO) e a identidade fecha igual", () => {
    // Fixture base + Realizável LP 0→50 (aplicação de caixa em investimento);
    // contrapartida: Empréstimos CP 230→280 no ano final (AT=PT preservado: 1250).
    const bp2 = BP.map((l) => {
      if (l.conta === "Ativo Total" || l.conta === "Passivo Total") return { ...l, valores: { "2022": 950, "2023": 1250 } };
      if (l.conta === "Ativo Não Circulante") return { ...l, valores: { "2022": 500, "2023": 610 } };
      if (l.conta === "Empréstimos e Financiamentos - CP") return { ...l, valores: { "2022": 180, "2023": 280 } };
      return l;
    });
    bp2.push(bpLine("ANC", "Realizável a Longo Prazo", 2, 0, 50));
    const fc = buildIndirectCashFlow(bp2, DRE, ["2022", "2023"])!;
    const noFCI = fc.fci.find((l) => l.nome === "Δ Realizável a Longo Prazo");
    expect(noFCI?.valores["2023"]).toBeCloseTo(-50, 2); // ativo cresceu → consumiu caixa
    expect(fc.fco.map((l) => l.nome)).not.toContain("Δ Realizável a Longo Prazo");
    expect(fc.prova[0].fecha).toBe(true); // mover de grupo NUNCA quebra a prova
  });

  // ─── Capital de Giro: sub-bloco DENTRO do FCO (CR, Estoques, Ativos Biológicos, Fornecedores) ───
  it("capital de giro: sub-bloco com as 4 contas, subtotal certo, FCO total e prova inalterados", () => {
    const fc = buildIndirectCashFlow(BP, DRE, ["2022", "2023"])!;
    const nomes = (fc.capitalGiro?.linhas ?? []).map((l) => l.nome);
    expect(nomes).toContain("Δ Contas a Receber - CP");
    expect(nomes).toContain("Δ Estoques - CP");
    expect(nomes).toContain("Δ Fornecedores - CP");
    // subtotal: −50 (CR subiu) + 20 (estoques caíram) + 50 (fornecedores subiram) = +20
    expect(fc.capitalGiro?.total["2023"]).toBeCloseTo(20, 2);
    // as linhas saem do array fco (sem dupla exibição)…
    expect(fc.fco.map((l) => l.nome)).not.toContain("Δ Contas a Receber - CP");
    // …mas o TOTAL do FCO segue incluindo o CG (identidade e Dickinson intactos)
    expect(fc.totais.fco["2023"]).toBeCloseTo(230, 2);
    expect(fc.prova[0].fecha).toBe(true);
  });

  it("capital de giro: Ativos Biológicos - CP entra no sub-bloco", () => {
    const bp3 = BP.map((l) => {
      if (l.conta === "Ativo Total" || l.conta === "Passivo Total") return { ...l, valores: { "2022": 950, "2023": 1230 } };
      if (l.conta === "Ativo Circulante") return { ...l, valores: { "2022": 450, "2023": 670 } };
      if (l.conta === "Empréstimos e Financiamentos - CP") return { ...l, valores: { "2022": 180, "2023": 260 } };
      return l;
    });
    bp3.push(bpLine("AO", "Ativos Biológicos - CP", 2, 0, 30));
    const fc = buildIndirectCashFlow(bp3, DRE, ["2022", "2023"])!;
    const bio = fc.capitalGiro?.linhas.find((l) => l.nome === "Δ Ativos Biológicos - CP");
    expect(bio?.valores["2023"]).toBeCloseTo(-30, 2);
    expect(fc.prova[0].fecha).toBe(true);
  });

  // ─── FCF: aporte de capital ABERTO (Δ Capital Social separado dos dividendos/ajustes) ───
  it("FCF abre o Δ Capital Social (aporte visível) e o restante fica em dividendos/ajustes", () => {
    const fc = buildIndirectCashFlow(BP, DRE, ["2022", "2023"])!;
    // Capital Social 300→320 = aporte de +20, agora em linha própria
    const aporte = fc.fcf.find((l) => /Δ Capital Social/.test(l.nome));
    expect(aporte?.valores["2023"]).toBeCloseTo(20, 2);
    // restante: ΔPL(150) − lucro(170) − Δcapital(20) = −40 (dividendos distribuídos)
    const ajustes = fc.fcf.find((l) => /dividendos e ajustes/i.test(l.nome));
    expect(ajustes?.valores["2023"]).toBeCloseTo(-40, 2);
    // total do FCF inalterado: +50 (empréstimos) + 20 (aporte) − 40 (dividendos) = 30
    expect(fc.totais.fcf["2023"]).toBeCloseTo(30, 2);
    expect(fc.prova[0].fecha).toBe(true);
  });
});
