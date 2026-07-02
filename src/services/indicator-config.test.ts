import { describe, it, expect } from "vitest";
import { calculateIndicators, statusPorSemaforo, SEMAFORO_DEFAULTS } from "./indicator-calculator";
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
