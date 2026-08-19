import { describe, it, expect } from "vitest";
import { calculateIndicators } from "./indicator-calculator";
import type { BPLineItem, DRELineItem } from "../types/financial";

// Dívida Líquida/EBITDA com EBITDA <= 0: a Belagro publicava −13,12 e o cartão de
// pares a classificava em P0 na régua "menor = melhor" — a MENOS alavancada do
// grupo, com R$ 54,1 mi de dívida líquida e EBITDA negativo.
const P = "31/05/2026";
const bp = (conta: string, classificacao: string, v: number): BPLineItem =>
  ({ conta, classificacao, nivel: 2, editado: false, valores: { [P]: v } });
const BP: BPLineItem[] = [
  bp("Ativo Total", "AT", 444_510_000), bp("Ativo Circulante", "AC", 413_250_000),
  bp("Caixa e Equivalentes de Caixa", "AF", 14_803_975),
  bp("Passivo Total", "PT", 444_510_000), bp("Passivo Circulante", "PC", 427_290_000),
  bp("Empréstimos e Financiamentos - CP", "PF", 65_010_000),
  bp("Empréstimos e Financiamentos - LP", "PF", 3_870_000),
  bp("Patrimônio Líquido", "PL", 12_238_818),
];
const dre = (conta: string, v: number): DRELineItem => ({ conta, subtotal: false, editado: false, valores: { [P]: v } });
const achar = (b: BPLineItem[], d: DRELineItem[]) =>
  calculateIndicators(b, d, [P]).find((i) => i.nome === "Dívida Líquida/EBITDA")!.valores[P];

describe("Dívida Líquida/EBITDA", () => {
  it("EBITDA negativo → N/M, não um múltiplo negativo comparável", () => {
    expect(achar(BP, [dre("EBITDA", -4_120_000)])).toBe("N/M");
  });

  it("EBITDA zero → N/M", () => {
    expect(achar(BP, [dre("EBITDA", 0)])).toBe("N/M");
  });

  it("N/M é excluído do percentil de pares (Number.isFinite falha)", () => {
    const v = achar(BP, [dre("EBITDA", -4_120_000)]);
    expect(Number.isFinite(typeof v === "number" ? v : Number(v))).toBe(false);
  });

  it("N/M não acende semáforo — não medido não é bom nem ruim", () => {
    const ind = calculateIndicators(BP, [dre("EBITDA", -4_120_000)], [P])
      .find((i) => i.nome === "Dívida Líquida/EBITDA")!;
    expect(ind.status[P]).toBeNull();
  });

  it("EBITDA positivo continua calculando o múltiplo", () => {
    const v = achar(BP, [dre("EBITDA", 13_800_000)]);
    expect(typeof v).toBe("number");
    expect(v as number).toBeCloseTo((68_880_000 - 14_803_975) / 13_800_000, 2);
  });
});
