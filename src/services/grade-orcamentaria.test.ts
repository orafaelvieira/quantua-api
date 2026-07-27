import { describe, it, expect } from "vitest";
import { aplicarRegraGrade, baseMensalPorNumero, mesesDoAnoNoHorizonte, refAnualDaLinha } from "./grade-orcamentaria";
import { Serie } from "./model-engine";

const ALVO_2027 = Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, "0")}`);

// Realizado 2026: sazonal (jan 100 … dez 1200 — soma 7800)
const REF_2026: Serie = Object.fromEntries(
  Array.from({ length: 12 }, (_, i) => [`2026-${String(i + 1).padStart(2, "0")}`, (i + 1) * 100]),
);

describe("baseMensalPorNumero", () => {
  it("com dois anos na série, vale o mais recente por mês", () => {
    const ref: Serie = { "2025-03": 50, "2026-03": 80, "2025-07": 10 };
    const base = baseMensalPorNumero(ref);
    expect(base.get(3)).toBe(80); // 2026 vence 2025
    expect(base.get(7)).toBe(10); // só 2025 tem julho
  });
});

describe("aplicarRegraGrade", () => {
  it("repetir: ano anterior mês a mês, casando pelo número do mês", () => {
    const r = aplicarRegraGrade({ regra: "repetir", mesesAlvo: ALVO_2027, refMensal: REF_2026 });
    expect(r.valores!["2027-01"]).toBe(100);
    expect(r.valores!["2027-12"]).toBe(1200);
  });

  it("mais-pct aplica o fator sobre o realizado", () => {
    const r = aplicarRegraGrade({ regra: "mais-pct", pct: 0.1, mesesAlvo: ALVO_2027, refMensal: REF_2026 });
    expect(r.valores!["2027-06"]).toBeCloseTo(600 * 1.1, 10);
  });

  it("sem mensal, cai no anual ÷ 12 — e a memória declara", () => {
    const r = aplicarRegraGrade({ regra: "repetir", mesesAlvo: ALVO_2027, refAnual: 2400 });
    expect(r.valores!["2027-05"]).toBe(200);
    expect(r.memoria).toContain("÷ 12");
  });

  it("sem referência nenhuma, não inventa número", () => {
    const r = aplicarRegraGrade({ regra: "mais-pct", pct: 0.05, mesesAlvo: ALVO_2027 });
    expect(Object.keys(r.valores!)).toHaveLength(0);
    expect(r.memoria).toContain("nada aplicado");
  });

  it("anual-sazonal distribui o total pela curva do realizado e a soma FECHA", () => {
    const r = aplicarRegraGrade({ regra: "anual-sazonal", valorAnual: 15600, mesesAlvo: ALVO_2027, refMensal: REF_2026 });
    const soma = Object.values(r.valores!).reduce((s, v) => s + v, 0);
    expect(soma).toBeCloseTo(15600, 6);
    // dez pesa 12/78 da curva
    expect(r.valores!["2027-12"]).toBeCloseTo(15600 * (1200 / 7800), 6);
  });

  it("anual-sazonal sem curva divide igual", () => {
    const r = aplicarRegraGrade({ regra: "anual-sazonal", valorAnual: 1200, mesesAlvo: ALVO_2027 });
    expect(r.valores!["2027-02"]).toBe(100);
    expect(r.memoria).toContain("igualmente");
  });

  it("pct-receita muda o MODO, não a série", () => {
    const r = aplicarRegraGrade({ regra: "pct-receita", pct: 0.12, mesesAlvo: ALVO_2027 });
    expect(r.modo).toBe("pctReceita");
    expect(r.pct).toBe(0.12);
    expect(r.valores).toBeUndefined();
  });

  it("exercício parcial (ano de início fora de janeiro) preenche só os meses do horizonte", () => {
    const alvo = mesesDoAnoNoHorizonte("2026-07", 18, "2026"); // jul..dez/26
    expect(alvo).toHaveLength(6);
    const r = aplicarRegraGrade({ regra: "repetir", mesesAlvo: alvo, refMensal: REF_2026 });
    expect(r.valores!["2026-07"]).toBe(700);
    expect(r.valores!["2026-01"]).toBeUndefined();
  });
});

describe("mesesDoAnoNoHorizonte", () => {
  it("recorta o ano-calendário dentro do horizonte", () => {
    expect(mesesDoAnoNoHorizonte("2026-01", 24, "2027")).toHaveLength(12);
    expect(mesesDoAnoNoHorizonte("2026-01", 18, "2027")).toHaveLength(6);
    expect(mesesDoAnoNoHorizonte("2026-01", 12, "2028")).toHaveLength(0);
  });
});

describe("refAnualDaLinha", () => {
  it("vale o período mais recente, em qualquer formato", () => {
    expect(refAnualDaLinha({ "31/12/2024": 900, "31/12/2025": 1100 })).toEqual({ valor: 1100, periodo: "31/12/2025" });
    expect(refAnualDaLinha({ "2023": 5, "2025": 7 })!.valor).toBe(7);
    expect(refAnualDaLinha(undefined)).toBeNull();
  });
});
