import { describe, expect, it } from "vitest";
import type { BPLineItem, DRELineItem } from "../types/financial";
import { calculateIndicators } from "./indicator-calculator";
import { recomputeDRESubtotals } from "./account-mapper";

/**
 * REGRESSÃO do caso de produção (IBR DUNAMYS, 14/08/2026): a aba Indicadores
 * exibia "Crescimento da Receita (YoY) = 423.750.634.875.618.400,0%".
 *
 * Causa: numa coluna sem movimento, as folhas da DRE se cancelavam e o subtotal
 * "Receita Líquida" virava um RESÍDUO de ponto flutuante (~2,1e-9) em vez de
 * zero. Como todos os guards comparavam com `!== 0` exato, o resíduo passava e
 * virava DENOMINADOR: 8.972.003 ÷ 2,1e-9 ≈ 4,2e15 → ×100 na tela.
 */
const P0 = "31/12/2023";
const FANTASMA = "31/12/2024"; // coluna sem movimento (o resíduo mora aqui)
const P1 = "31/12/2025";

const dreLinha = (conta: string, subtotal: boolean, v: Record<string, number>): DRELineItem => ({
  conta, subtotal, editado: false, valores: v,
});

describe("resíduo de ponto flutuante não vira denominador", () => {
  it("recomputeDRESubtotals grava ZERO quando as folhas se cancelam (não 1e-9)", () => {
    // Folhas que se cancelam: +1.000.000,10 e −1.000.000,10 somam 1e-10 em float.
    const dre: DRELineItem[] = [
      dreLinha("Receita Bruta", false, { [FANTASMA]: 1_000_000.1 }),
      dreLinha("Deduções da Receita Bruta", false, { [FANTASMA]: -1_000_000.1 }),
      dreLinha("Impostos s/ Faturamento", false, { [FANTASMA]: 0 }),
      dreLinha("Receita Líquida", true, { [FANTASMA]: 0 }),
      dreLinha("Custo Operacional", false, { [FANTASMA]: 0 }),
      dreLinha("Lucro Bruto", true, { [FANTASMA]: 0 }),
    ];
    recomputeDRESubtotals(dre, [FANTASMA]);
    const rl = dre.find((d) => d.conta === "Receita Líquida")!.valores[FANTASMA]!;
    expect(rl).toBe(0); // antes: 1.16e-10
  });

  it("YoY não explode quando o período anterior é uma coluna sem movimento", () => {
    const bp: BPLineItem[] = [
      { classificacao: "AT", conta: "Ativo Total", nivel: 0, editado: false, valores: { [P0]: 5_000_000, [FANTASMA]: 0, [P1]: 6_000_000 } },
      { classificacao: "PT", conta: "Passivo Total", nivel: 0, editado: false, valores: { [P0]: 5_000_000, [FANTASMA]: 0, [P1]: 6_000_000 } },
      { classificacao: "PL", conta: "Patrimônio Líquido", nivel: 1, editado: false, valores: { [P0]: 2_000_000, [FANTASMA]: 0, [P1]: 2_500_000 } },
      { classificacao: "AO", conta: "Contas a Receber - CP", nivel: 2, editado: false, valores: { [P0]: 800_000, [FANTASMA]: 0, [P1]: 900_000 } },
    ];
    // A coluna-fantasma carrega o resíduo EXATO do caso real.
    const residuo = 2.117284e-9;
    const dre: DRELineItem[] = [
      dreLinha("Receita Líquida", true, { [P0]: 6_301_667, [FANTASMA]: residuo, [P1]: 8_972_003 }),
      dreLinha("Custo Operacional", false, { [P0]: -3_000_000, [FANTASMA]: 0, [P1]: -4_000_000 }),
      dreLinha("Lucro Bruto", true, { [P0]: 3_301_667, [FANTASMA]: 0, [P1]: 4_972_003 }),
      dreLinha("Lucro Líquido", true, { [P0]: 1_000_000, [FANTASMA]: 0, [P1]: 1_500_000 }),
    ];
    const inds = calculateIndicators(bp, dre, [P0, FANTASMA, P1]);
    const yoy = inds.find((i) => i.nome === "Crescimento da Receita (YoY)")!;
    // Sem a guarda: 8.972.003 / 2,117284e-9 ≈ 4,2e15 (→ 4,2e17% na tela).
    expect(yoy.valores[P1]).toBeNull();
    // O período cuja base é real segue calculando normalmente.
    expect(yoy.valores[FANTASMA]).toBeCloseTo(-1, 5); // caiu de 6,3 mi para ~0

    // Mesmo denominador → mesma família de bugs: prazos e margens também protegidos.
    const pmr = inds.find((i) => i.nome === "Prazo Médio Contas a Receber")!;
    expect(pmr.valores[FANTASMA]).toBeNull();
    const margem = inds.find((i) => i.nome === "Margem Bruta")!;
    expect(margem.valores[FANTASMA]).toBeNull();
  });
});
