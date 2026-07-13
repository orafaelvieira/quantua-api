/**
 * DISTRIBUIÇÕES do Monte Carlo — todas expressas como QUANTIL (inversa da
 * acumulada): fator = quantil(u), u ∈ (0,1). Trabalhar por quantil permite
 * Latin Hypercube (u estratificado) e correlação por cópula gaussiana
 * (u correlacionado) sem mudar nenhuma distribuição — mesmo desenho do
 * Crystal Ball/@RISK.
 *
 * Todas parametrizadas em FATOR sobre a base: min/max = sensibilidade
 * (−0.10 = −10%) e moda = "mais provável" (default 0 = a própria base).
 *   triangular  — pico na moda (com min/max simétricos e moda 0 reproduz a
 *                 triangular simétrica da planilha);
 *   pert        — beta suavizada (α=1+4(m−a)/(b−a)): a favorita para premissa
 *                 de especialista (menos peso nas pontas que a triangular);
 *   normal      — média na moda, σ=(max−min)/6, TRUNCADA em [min,max];
 *   lognormal   — normal truncada no espaço ln(1+f): assimétrica à direita,
 *                 nunca cruza −100%;
 *   uniforme    — só limites ("não sei nada além do intervalo").
 */

export type DistMc = "triangular" | "pert" | "normal" | "lognormal" | "uniforme";

export const DISTRIBUICOES_MC: Array<{ id: DistMc; nome: string }> = [
  { id: "triangular", nome: "Triangular (mín · mais provável · máx)" },
  { id: "pert", nome: "PERT (beta suavizada)" },
  { id: "normal", nome: "Normal truncada" },
  { id: "lognormal", nome: "Lognormal truncada" },
  { id: "uniforme", nome: "Uniforme (só os limites)" },
];

// ── Normal padrão ──────────────────────────────────────────────────────────

/** Φ⁻¹(p) — algoritmo de Acklam (erro relativo < 1.15e−9). */
export function invNormalPadrao(p: number): number {
  const pp = Math.min(1 - 1e-12, Math.max(1e-12, p));
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  let q: number, r: number;
  if (pp < pLow) {
    q = Math.sqrt(-2 * Math.log(pp));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (pp <= 1 - pLow) {
    q = pp - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - pp));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Φ(x) — via erf (Abramowitz & Stegun 7.1.26, |erro| < 1.5e−7). */
export function cdfNormalPadrao(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

// ── Beta (para a PERT) ─────────────────────────────────────────────────────

function lnGamma(x: number): number {
  // Lanczos g=7, n=9
  const g = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const xx = x - 1;
  let s = g[0];
  for (let i = 1; i < 9; i++) s += g[i] / (xx + i);
  const t = xx + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(s);
}

/** Fração continuada da incompleta beta (Numerical Recipes betacf). */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200, EPS = 3e-9, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** I_x(a,b) — beta incompleta REGULARIZADA (CDF da Beta(a,b)). */
export function cdfBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBt = lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(lnBt);
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Quantil da Beta(a,b) — Newton salvaguardado por bissecção. */
export function quantilBeta(u: number, a: number, b: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  let lo = 0, hi = 1;
  let x = a / (a + b); // chute inicial: média
  const lnB = lnGamma(a + b) - lnGamma(a) - lnGamma(b);
  for (let i = 0; i < 60; i++) {
    const f = cdfBeta(x, a, b) - u;
    if (f > 0) hi = x; else lo = x;
    if (Math.abs(f) < 1e-10) break;
    const pdf = Math.exp(lnB + (a - 1) * Math.log(Math.max(x, 1e-300)) + (b - 1) * Math.log(Math.max(1 - x, 1e-300)));
    let passo = pdf > 1e-300 ? x - f / pdf : NaN;
    if (!Number.isFinite(passo) || passo <= lo || passo >= hi) passo = (lo + hi) / 2; // bissecção
    x = passo;
  }
  return x;
}

// ── Quantis das distribuições do MC (em FATOR sobre a base) ────────────────

export function quantilTriangular(u: number, min: number, moda: number, max: number): number {
  if (max <= min) return min;
  const m = Math.min(max, Math.max(min, moda));
  const fc = (m - min) / (max - min);
  if (u < fc) return min + Math.sqrt(u * (max - min) * (m - min));
  return max - Math.sqrt((1 - u) * (max - min) * (max - m));
}

export function quantilUniforme(u: number, min: number, max: number): number {
  return min + u * (max - min);
}

export function quantilPert(u: number, min: number, moda: number, max: number): number {
  if (max <= min) return min;
  const m = Math.min(max, Math.max(min, moda));
  const alfa = 1 + (4 * (m - min)) / (max - min);
  const beta = 1 + (4 * (max - m)) / (max - min);
  return min + (max - min) * quantilBeta(u, alfa, beta);
}

/** Normal com média na moda e σ=(max−min)/6, TRUNCADA em [min,max]
 *  (truncagem exata: reescala u entre Φ(min) e Φ(max)). */
export function quantilNormalTruncada(u: number, min: number, moda: number, max: number): number {
  if (max <= min) return min;
  const m = Math.min(max, Math.max(min, moda));
  const sigma = (max - min) / 6;
  const pLo = cdfNormalPadrao((min - m) / sigma);
  const pHi = cdfNormalPadrao((max - m) / sigma);
  const x = m + sigma * invNormalPadrao(pLo + u * (pHi - pLo));
  return Math.min(max, Math.max(min, x));
}

/** Lognormal: normal truncada no espaço ln(1+f) — assimétrica à direita,
 *  fator nunca chega a −100%. Exige min > −1. */
export function quantilLognormalTruncada(u: number, min: number, moda: number, max: number): number {
  const a = Math.log(1 + Math.max(-0.999, min));
  const b = Math.log(1 + max);
  const m = Math.log(1 + Math.min(max, Math.max(min, moda)));
  return Math.exp(quantilNormalTruncada(u, a, m, b)) - 1;
}

/** Fator sorteado da distribuição escolhida (u ∈ (0,1) → fator sobre a base). */
export function quantilDist(dist: DistMc, u: number, min: number, moda: number, max: number): number {
  switch (dist) {
    case "pert": return quantilPert(u, min, moda, max);
    case "normal": return quantilNormalTruncada(u, min, moda, max);
    case "lognormal": return quantilLognormalTruncada(u, min, moda, max);
    case "uniforme": return quantilUniforme(u, min, max);
    default: return quantilTriangular(u, min, moda, max);
  }
}

// ── Álgebra p/ correlação e tornado ────────────────────────────────────────

/** Cholesky (matriz de correlação k×k). Retorna null se não for definida positiva. */
export function cholesky(mat: number[][]): number[][] | null {
  const k = mat.length;
  const L: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = 0; j <= i; j++) {
      let soma = mat[i][j];
      for (let p = 0; p < j; p++) soma -= L[i][p] * L[j][p];
      if (i === j) {
        if (soma <= 1e-12) return null;
        L[i][j] = Math.sqrt(soma);
      } else {
        L[i][j] = soma / L[j][j];
      }
    }
  }
  return L;
}

/** Postos com empates pela média (1-indexado) — base do Spearman. */
export function postos(valores: number[]): number[] {
  const idx = valores.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array(valores.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const media = (i + j) / 2 + 1;
    for (let p = i; p <= j; p++) r[idx[p][1]] = media;
    i = j + 1;
  }
  return r;
}

/** Correlação de Spearman (Pearson sobre os postos). */
export function spearman(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ra = postos(a.slice(0, n));
  const rb = postos(b.slice(0, n));
  const ma = ra.reduce((s, x) => s + x, 0) / n;
  const mb = rb.reduce((s, x) => s + x, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = ra[i] - ma, db = rb[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}
