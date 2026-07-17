/**
 * SIMULAÇÃO DE MONTE CARLO do Valuation — mesma arquitetura do Crystal
 * Ball/@RISK, nascida da aba Monte_Carlo da planilha do modelo Quantua:
 *
 *   1) UNIFORMES u ∈ (0,1) por variável × ano × cenário — Monte Carlo puro
 *      (rng) ou LATIN HYPERCUBE (estratos permutados: converge ~5× mais
 *      rápido; default);
 *   2) CORRELAÇÕES por cópula gaussiana: z = Φ⁻¹(u), z' = L·z (Cholesky da
 *      matriz de pares informada), u' = Φ(z') — ano a ano, entre variáveis;
 *   3) DISTRIBUIÇÃO por variável via QUANTIL (triangular assimétrica, PERT,
 *      normal/lognormal truncadas, uniforme) → fator sobre a base do ano;
 *   4) PERSISTÊNCIA (inércia): fator efetivo do ano = ρ × fator do ano
 *      anterior + (1−ρ) × sorteio do ano — um ano ruim "contamina" o seguinte;
 *   5) o MODELO INTEIRO recalcula por cenário (motor determinístico) e o
 *      valuation FCD colhe EV e Equity;
 *   6) TORNADO: contribuição de cada variável à variância do resultado
 *      (Spearman² normalizado entre os fatores sorteados e o Equity).
 *
 * RNG com SEED (LCG): o mesmo seed reproduz TUDO — auditável.
 */
import { calcularModelo } from "./model-engine";
import type { ModeloInput, ScenarioOverrides, Serie } from "./model-engine";
import { equityFcd } from "./valuation-fcd";
import type { ParamsFcd } from "./valuation-fcd";
import { quantilDist, cholesky, invNormalPadrao, cdfNormalPadrao, spearman } from "./distribuicoes";
import type { DistMc } from "./distribuicoes";

export type AlvoMc = "no" | "linhaPct" | "linhaValor" | "wacc" | "g";

export interface McVariavelSpec {
  id: string;
  /** Rótulo para mensagens (a UI manda o nome exibido). */
  nome?: string;
  alvo: AlvoMc;
  /** id do nó (alvo "no") ou da linha de custo (linhaPct/linhaValor); vazio p/ wacc|g. */
  refId?: string;
  /** Sensibilidade multiplicativa sobre a base: −0.10 = −10%. */
  sensibMin: number;
  sensibMax: number;
  /** Distribuição do sorteio (default triangular). */
  dist?: DistMc;
  /** "Mais provável" (moda) como fator sobre a base; default 0 = a base. */
  modaPct?: number;
  /** Inércia entre anos (0 = anos independentes; 0.6 = 60% herdado do ano anterior). */
  persistencia?: number;
}

export interface McCorrelacao {
  a: string; // id da variável
  b: string;
  rho: number; // −0.95..0.95
}

export interface McInput {
  base: Omit<ModeloInput, "overrides">;
  /** Overrides do CENÁRIO ATIVO (a simulação roda por cima dele). */
  cenarioOverrides: ScenarioOverrides;
  variaveis: McVariavelSpec[];
  correlacoes?: McCorrelacao[];
  /** Amostragem: Latin Hypercube (default) ou Monte Carlo puro. */
  lhs?: boolean;
  n: number;
  seed: number;
  valuation: ParamsFcd;
}

export interface McTornadoItem {
  id: string;
  nome: string;
  /** Spearman entre os fatores sorteados da variável e o Equity. */
  correlacao: number;
  /** Contribuição à variância (Spearman² normalizado, soma = 1). */
  contribuicao: number;
}

export interface McResultado {
  ok: boolean;
  motivo?: string;
  seed: number;
  n: number;
  amostragem: "lhs" | "mc";
  /** Valuation com as premissas BASE (sem sorteio). */
  base: { ev: number; equity: number; equityFinal: number };
  /** Um valor por cenário simulado (números crus). */
  ev: number[];
  equity: number[];
  tornado: McTornadoItem[];
  avisos: string[];
}

/** LCG (Numerical Recipes) — determinístico por seed, suficiente p/ simulação. */
export function rngLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Triangular simétrica no intervalo [min, max]: min + ((max−min)/2)(u1+u2).
 *  (Mantida da 1ª versão — a macro da planilha; o motor novo usa quantis.) */
export function sorteioTriangular(rng: () => number, min: number, max: number): number {
  return min + ((max - min) / 2) * (rng() + rng());
}

interface AlvoResolvido {
  spec: McVariavelSpec;
  serieBase?: Serie;                       // alvo "no"
  pctBasePorAno?: Record<string, number>;  // alvo "linhaPct"
  valorMensalBase?: number;                // alvo "linhaValor"
}

/** Uniformes u ∈ (0,1): matriz [variável][ano][cenário].
 *  LHS: cada coluna (variável, ano) divide (0,1) em n estratos e sorteia um
 *  ponto por estrato, em ordem embaralhada — cobre a distribuição inteira. */
function gerarUniformes(k: number, nAnos: number, n: number, lhs: boolean, rng: () => number): number[][][] {
  const U: number[][][] = Array.from({ length: k }, () => Array.from({ length: nAnos }, () => new Array<number>(n)));
  for (let vi = 0; vi < k; vi++) {
    for (let a = 0; a < nAnos; a++) {
      const col = U[vi][a];
      if (lhs) {
        for (let t = 0; t < n; t++) col[t] = (t + rng()) / n;
        for (let t = n - 1; t > 0; t--) { // Fisher–Yates
          const j = Math.floor(rng() * (t + 1));
          const tmp = col[t]; col[t] = col[j]; col[j] = tmp;
        }
      } else {
        for (let t = 0; t < n; t++) col[t] = rng();
      }
    }
  }
  return U;
}

// Async: o loop de cenários CEDE o event loop a cada lote — uma simulação de
// 2.000 cenários leva dezenas de segundos em produção e, síncrona, travava a
// API inteira (inclusive os health checks do DO, que derrubariam a instância).
export async function rodarMonteCarlo(input: McInput): Promise<McResultado> {
  const avisos: string[] = [];
  const lhs = input.lhs !== false;
  const vazio = { ev: 0, equity: 0, equityFinal: 0 };
  const falha = (motivo: string): McResultado =>
    ({ ok: false, motivo, seed: input.seed, n: 0, amostragem: lhs ? "lhs" : "mc", base: vazio, ev: [], equity: [], tornado: [], avisos });

  if (!input.variaveis.length) return falha("Defina ao menos uma variável para simular.");

  // Cenário BASE (com os overrides do cenário ativo, sem sorteio)
  const resultadoBase = calcularModelo({ ...input.base, overrides: input.cenarioOverrides });
  const valBase = equityFcd(resultadoBase, input.valuation);
  if (!valBase.ok) return falha(valBase.motivo ?? "Valuation base inválido.");

  const meses = resultadoBase.meses;
  const anos = [...new Set(meses.map((m) => m.slice(0, 4)))];
  const linhaCustoDe = (id: string) => {
    for (const b of input.base.blocks) {
      const l = (b.config.linhasCusto ?? []).find((x) => x.id === id);
      if (l) return l;
    }
    return undefined;
  };

  // Resolve a BASE de cada variável uma única vez (validação antecipada)
  const alvos: AlvoResolvido[] = [];
  for (const spec of input.variaveis) {
    const rotulo = spec.nome ?? spec.refId ?? spec.alvo;
    if (!(spec.sensibMin < spec.sensibMax)) { avisos.push(`"${rotulo}": sensibilidade mínima deve ser menor que a máxima — variável ignorada.`); continue; }
    if (spec.alvo === "wacc" || spec.alvo === "g") { alvos.push({ spec }); continue; }
    if (!spec.refId) { avisos.push(`"${rotulo}": sem referência — variável ignorada.`); continue; }
    if (spec.alvo === "no") {
      const serie = resultadoBase.series[spec.refId];
      if (!serie) { avisos.push(`"${rotulo}": variável não encontrada no modelo — ignorada.`); continue; }
      alvos.push({ spec, serieBase: { ...serie } });
    } else {
      const linha = linhaCustoDe(spec.refId);
      if (!linha) { avisos.push(`"${rotulo}": linha não encontrada no modelo — ignorada.`); continue; }
      // A base respeita o cenário ativo (se ele já mexe nesta linha).
      const ovCen = input.cenarioOverrides[spec.refId] ?? {};
      if (spec.alvo === "linhaPct") {
        const pctFlat = typeof ovCen.pct === "number" ? ovCen.pct : (linha.pct ?? 0);
        const pctPorAno = (ovCen.pctPorAno ?? linha.pctPorAno) as Record<string, number> | undefined;
        const base: Record<string, number> = {};
        for (const ano of anos) base[ano] = typeof pctPorAno?.[ano] === "number" ? pctPorAno[ano] : pctFlat;
        alvos.push({ spec, pctBasePorAno: base });
      } else {
        alvos.push({ spec, valorMensalBase: typeof ovCen.valorMensal === "number" ? ovCen.valorMensal : (linha.valorMensal ?? 0) });
      }
    }
  }
  if (!alvos.length) return falha("Nenhuma variável válida para simular." + (avisos.length ? ` (${avisos[0]})` : ""));

  const k = alvos.length;
  const nAnos = anos.length;
  const n = input.n;
  const rng = rngLcg(input.seed);

  // 1) uniformes (LHS ou MC puro)
  const U = gerarUniformes(k, nAnos, n, lhs, rng);

  // 2) correlações por cópula gaussiana (ano a ano, entre variáveis)
  const pares = (input.correlacoes ?? []).filter((c) => Number.isFinite(c.rho) && c.rho !== 0);
  if (pares.length && k > 1) {
    const idxDe = new Map(alvos.map((a, i) => [a.spec.id, i]));
    const mat: number[][] = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)));
    let paresValidos = 0;
    for (const p of pares) {
      const i = idxDe.get(p.a);
      const j = idxDe.get(p.b);
      if (i === undefined || j === undefined || i === j) { avisos.push(`Correlação ignorada (variável não está na simulação): ${p.a} × ${p.b}.`); continue; }
      const rho = Math.max(-0.95, Math.min(0.95, p.rho));
      mat[i][j] = rho; mat[j][i] = rho;
      paresValidos++;
    }
    if (paresValidos) {
      let L = cholesky(mat);
      let encolhe = 0;
      while (!L && encolhe < 20) { // matriz inconsistente → encolhe até ficar viável
        for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) if (i !== j) mat[i][j] *= 0.9;
        L = cholesky(mat);
        encolhe++;
      }
      if (!L) {
        avisos.push("Matriz de correlações inconsistente — correlações NÃO aplicadas.");
      } else {
        if (encolhe) avisos.push(`As correlações informadas são matematicamente inconsistentes entre si — foram reduzidas (×${(0.9 ** encolhe).toFixed(2)}) até formarem uma matriz válida.`);
        const z = new Array<number>(k);
        for (let a = 0; a < nAnos; a++) {
          for (let t = 0; t < n; t++) {
            for (let vi = 0; vi < k; vi++) z[vi] = invNormalPadrao(U[vi][a][t]);
            for (let vi = k - 1; vi >= 0; vi--) {
              let s = 0;
              for (let j = 0; j <= vi; j++) s += L[vi][j] * z[j];
              U[vi][a][t] = cdfNormalPadrao(s);
            }
          }
        }
      }
    }
  }

  // 3) + 4) fatores por variável × ano × cenário (distribuição + persistência)
  const fatores: number[][][] = Array.from({ length: k }, () => Array.from({ length: nAnos }, () => new Array<number>(n)));
  for (let vi = 0; vi < k; vi++) {
    const spec = alvos[vi].spec;
    const dist: DistMc = spec.dist ?? "triangular";
    const moda = Math.min(spec.sensibMax, Math.max(spec.sensibMin, spec.modaPct ?? 0));
    const rho = Math.min(0.9, Math.max(0, spec.persistencia ?? 0));
    for (let t = 0; t < n; t++) {
      let anterior = 0;
      for (let a = 0; a < nAnos; a++) {
        const bruto = quantilDist(dist, U[vi][a][t], spec.sensibMin, moda, spec.sensibMax);
        const efetivo = a === 0 || rho === 0 ? bruto : rho * anterior + (1 - rho) * bruto;
        fatores[vi][a][t] = efetivo;
        anterior = efetivo;
      }
    }
  }

  // 5) recalcula o MODELO por cenário e colhe o valuation
  const ev: number[] = [];
  const equity: number[] = [];
  const fatorMedioValido: number[][] = alvos.map(() => []); // p/ tornado (só cenários válidos)
  let gClampado = 0;
  let cenariosInvalidos = 0;

  for (let t = 0; t < n; t++) {
    if (t % 25 === 24) await new Promise<void>((r) => setImmediate(r)); // respira: outras requisições atendem
    const overrides: ScenarioOverrides = { ...input.cenarioOverrides };
    let wacc = input.valuation.wacc;
    let g = input.valuation.g;
    const fatorMedio = new Array<number>(k);
    for (let vi = 0; vi < k; vi++) {
      const alvo = alvos[vi];
      const { spec } = alvo;
      const unico = spec.alvo === "wacc" || spec.alvo === "g" || spec.alvo === "linhaValor";
      fatorMedio[vi] = unico
        ? fatores[vi][0][t]
        : fatores[vi].reduce((s, porAno) => s + porAno[t], 0) / nAnos;
      if (spec.alvo === "wacc") { wacc = input.valuation.wacc * (1 + fatores[vi][0][t]); continue; }
      if (spec.alvo === "g") { g = input.valuation.g * (1 + fatores[vi][0][t]); continue; }
      const refId = spec.refId!;
      if (spec.alvo === "no") {
        const valores: Serie = {};
        for (let a = 0; a < nAnos; a++) {
          const f = 1 + fatores[vi][a][t];
          for (const m of meses) if (m.startsWith(anos[a])) valores[m] = (alvo.serieBase![m] ?? 0) * f;
        }
        // A série base já embute os efeitos do cenário (multiplicador etc.) —
        // por isso o override zera o multiplicador e desliga o modo anual
        // (o mensal manda: valores[mes] vence qualquer preenchimento).
        overrides[refId] = { ...(overrides[refId] ?? {}), valores, modoPreenchimento: null, multiplicador: 1 };
      } else if (spec.alvo === "linhaPct") {
        const pctPorAno: Record<string, number> = {};
        for (let a = 0; a < nAnos; a++) pctPorAno[anos[a]] = alvo.pctBasePorAno![anos[a]] * (1 + fatores[vi][a][t]);
        overrides[refId] = { ...(overrides[refId] ?? {}), pctPorAno };
      } else {
        overrides[refId] = { ...(overrides[refId] ?? {}), valorMensal: alvo.valorMensalBase! * (1 + fatores[vi][0][t]) };
      }
    }
    if (g >= wacc) { g = wacc - 0.0025; gClampado++; } // Gordon precisa de g < WACC

    const resultado = calcularModelo({ ...input.base, overrides });
    const val = equityFcd(resultado, { ...input.valuation, wacc, g });
    if (!val.ok) { cenariosInvalidos++; continue; }
    ev.push(val.ev);
    equity.push(val.equityFinal);
    for (let vi = 0; vi < k; vi++) fatorMedioValido[vi].push(fatorMedio[vi]);
  }

  // 6) tornado — contribuição de cada variável à variância do Equity
  const corrs = alvos.map((a, vi) => ({
    id: a.spec.id,
    nome: a.spec.nome ?? a.spec.refId ?? a.spec.alvo,
    correlacao: spearman(fatorMedioValido[vi], equity),
  }));
  const somaQuad = corrs.reduce((s, c) => s + c.correlacao * c.correlacao, 0);
  const tornado: McTornadoItem[] = corrs
    .map((c) => ({ ...c, contribuicao: somaQuad > 0 ? (c.correlacao * c.correlacao) / somaQuad : 0 }))
    .sort((a, b) => b.contribuicao - a.contribuicao);

  if (gClampado) avisos.push(`Em ${gClampado} cenário(s) o g sorteado alcançou o WACC e foi limitado a WACC − 0,25 p.p. (Gordon exige g < WACC).`);
  if (cenariosInvalidos) avisos.push(`${cenariosInvalidos} cenário(s) descartado(s) por resultado inválido.`);

  return {
    ok: true, seed: input.seed, n: ev.length, amostragem: lhs ? "lhs" : "mc",
    base: { ev: valBase.ev, equity: valBase.equity, equityFinal: valBase.equityFinal },
    ev, equity, tornado, avisos,
  };
}
