import { describe, it, expect } from "vitest";
import {
  invNormalPadrao, cdfNormalPadrao, cdfBeta, quantilBeta,
  quantilTriangular, quantilPert, quantilNormalTruncada, quantilLognormalTruncada, quantilUniforme,
  cholesky, spearman,
} from "./distribuicoes";

const mediaDe = (f: (u: number) => number, n = 20000): number => {
  let s = 0;
  for (let i = 0; i < n; i++) s += f((i + 0.5) / n); // grade uniforme = integral do quantil
  return s / n;
};

describe("normal padrão", () => {
  it("Φ e Φ⁻¹ são inversas e batem com valores conhecidos", () => {
    expect(invNormalPadrao(0.5)).toBeCloseTo(0, 6);
    expect(invNormalPadrao(0.975)).toBeCloseTo(1.959964, 4);
    expect(cdfNormalPadrao(0)).toBeCloseTo(0.5, 6);
    expect(cdfNormalPadrao(1.959964)).toBeCloseTo(0.975, 4);
    for (const p of [0.01, 0.2, 0.5, 0.8, 0.99]) {
      expect(cdfNormalPadrao(invNormalPadrao(p))).toBeCloseTo(p, 4);
    }
  });
});

describe("beta", () => {
  it("CDF e quantil são inversas; Beta(2,2) tem mediana 0,5", () => {
    expect(quantilBeta(0.5, 2, 2)).toBeCloseTo(0.5, 6);
    expect(cdfBeta(0.5, 2, 2)).toBeCloseTo(0.5, 6);
    for (const u of [0.05, 0.3, 0.7, 0.95]) {
      expect(cdfBeta(quantilBeta(u, 3.4, 1.6), 3.4, 1.6)).toBeCloseTo(u, 6);
    }
  });
});

describe("quantis do MC (fatores)", () => {
  it("triangular assimétrica: média = (min+moda+max)/3, dentro dos limites", () => {
    const media = mediaDe((u) => quantilTriangular(u, -0.3, 0, 0.1));
    expect(media).toBeCloseTo((-0.3 + 0 + 0.1) / 3, 3);
    expect(quantilTriangular(0.0001, -0.3, 0, 0.1)).toBeGreaterThanOrEqual(-0.3);
    expect(quantilTriangular(0.9999, -0.3, 0, 0.1)).toBeLessThanOrEqual(0.1);
  });

  it("PERT: média ≈ (min + 4·moda + max)/6 (regra clássica)", () => {
    const media = mediaDe((u) => quantilPert(u, -0.3, 0, 0.1));
    expect(media).toBeCloseTo((-0.3 + 4 * 0 + 0.1) / 6, 3);
  });

  it("normal truncada: mediana na moda, respeita os limites", () => {
    expect(quantilNormalTruncada(0.5, -0.2, 0.05, 0.3)).toBeCloseTo(0.05, 2);
    expect(quantilNormalTruncada(0.0001, -0.2, 0, 0.2)).toBeGreaterThanOrEqual(-0.2);
    expect(quantilNormalTruncada(0.9999, -0.2, 0, 0.2)).toBeLessThanOrEqual(0.2);
  });

  it("lognormal truncada: assimétrica à direita e nunca cruza os limites", () => {
    const mediana = quantilLognormalTruncada(0.5, -0.5, 0, 1.0);
    expect(mediana).toBeCloseTo(0, 2); // mediana na moda (fator 1)
    const p95 = quantilLognormalTruncada(0.95, -0.5, 0, 1.0);
    const p05 = quantilLognormalTruncada(0.05, -0.5, 0, 1.0);
    expect(p95 - mediana).toBeGreaterThan(mediana - p05); // cauda direita mais longa
    expect(p05).toBeGreaterThanOrEqual(-0.5);
    expect(p95).toBeLessThanOrEqual(1.0);
  });

  it("uniforme: linear nos limites", () => {
    expect(quantilUniforme(0.25, -0.1, 0.1)).toBeCloseTo(-0.05, 10);
  });
});

describe("álgebra", () => {
  it("cholesky reconstrói a matriz e rejeita matriz inválida", () => {
    const L = cholesky([[1, 0.6], [0.6, 1]])!;
    expect(L[0][0]).toBeCloseTo(1, 10);
    expect(L[1][0]).toBeCloseTo(0.6, 10);
    expect(L[1][0] * L[1][0] + L[1][1] * L[1][1]).toBeCloseTo(1, 10);
    expect(cholesky([[1, 1.5], [1.5, 1]])).toBeNull();
  });

  it("spearman: monotônica = 1, anti = −1", () => {
    const a = [1, 2, 3, 4, 5];
    expect(spearman(a, a.map((x) => x * 10))).toBeCloseTo(1, 10);
    expect(spearman(a, a.map((x) => -x))).toBeCloseTo(-1, 10);
  });
});
