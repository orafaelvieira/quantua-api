/**
 * FLUXO DE CAIXA pelo método INDIRETO — 100% determinístico, SEM IA.
 *
 * Gerado a partir do BP + DRE estruturados (modelo padrão), por VARIAÇÃO entre
 * períodos consecutivos (requer ≥2). Filosofia "verde só com prova":
 *
 *   FCO = Lucro Líquido + D&A (não-caixa) − Equivalência Patrimonial (não-caixa)
 *         ± Δ capital de giro (ativos operacionais −Δ; passivos operacionais +Δ)
 *   FCI = −(ΔImobilizado + ΔIntangível + D&A)  ← capex BRUTO estimado
 *         −(ΔInvestimentos − Equivalência)      ← participações ex-equivalência
 *         −Δ demais ativos de investimento
 *   FCF = ΔEmpréstimos/Financiamentos ± Δ demais passivos de financiamento
 *         + (ΔPL − Lucro Líquido)               ← aportes, dividendos e ajustes
 *
 * PROVA DE FECHAMENTO: FCO+FCI+FCF = ΔCaixa e Equivalentes observado no BP.
 * Pela construção acima a identidade fecha ALGEBRICAMENTE sempre que AT=PT nos
 * dois períodos — se não fechar, o problema é de extração (selo vermelho).
 */
import type { BPLineItem, DRELineItem } from "../types/financial";

export type BucketFC = "caixa" | "fco" | "fci" | "fcf";

const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

// Linhas do modelo padrão com destino EXPLÍCITO (nome → bucket). Linhas adicionadas
// pelo usuário no editor de modelos caem no fallback por palavra-chave (determinístico).
const BUCKET_EXPLICITO: Record<string, BucketFC> = {
  "caixa e equivalentes de caixa": "caixa",
  // FCI — investimento
  "aplicacoes financeiras - lp": "fci",
  "investimentos": "fci",
  "imobilizado": "fci",
  "intangivel": "fci",
  "bens a alienar": "fci",
  "ativo diferido": "fci",
  "ativos com partes relacionadas - cp": "fci",
  "ativos com partes relacionadas - lp": "fci",
  // FCF — financiamento (passivos onerosos, dividendos, capital)
  "emprestimos e financiamentos - cp": "fcf",
  "emprestimos e financiamentos - lp": "fcf",
  "passivos com partes relacionadas - cp": "fcf",
  "passivos com partes relacionadas - lp": "fcf",
  "dividendos e jcp a pagar": "fcf",
  "dividendos e juros sobre o capital proprio": "fcf",
  "adiantamento para futuro aumento capital - lp": "fcf",
};

/** Bucket de uma linha de INPUT do BP (nível 2). Fallback por palavra-chave cobre
 *  contas adicionadas pelo usuário no editor de modelos. */
export function bucketDaConta(conta: string): BucketFC {
  const n = norm(conta);
  const exp = BUCKET_EXPLICITO[n];
  if (exp) return exp;
  if (/caixa e equivalentes/.test(n)) return "caixa";
  if (/emprest|financiament|debentur|arrendament/.test(n)) return "fcf";
  if (/dividendo|jcp|juros sobre o capital|aumento capital/.test(n)) return "fcf";
  if (/imobilizado|intangivel|investimento|aplicac/.test(n)) return "fci";
  return "fco"; // capital de giro / operacional por padrão
}

export interface FCLinha { nome: string; valores: Record<string, number> }
export interface ProvaFC {
  periodo: string;           // período FINAL da variação (coluna)
  caixaInicial: number;
  caixaFinal: number;
  deltaObservado: number;    // ΔCaixa no BP
  deltaCalculado: number;    // FCO+FCI+FCF
  fecha: boolean;            // |dif| ≤ R$1
}
export interface FluxoCaixaIndireto {
  colunas: string[];         // períodos-coluna (cada um = variação vs período anterior)
  fco: FCLinha[];
  fci: FCLinha[];
  fcf: FCLinha[];
  totais: { fco: Record<string, number>; fci: Record<string, number>; fcf: Record<string, number>; geracaoTotal: Record<string, number> };
  prova: ProvaFC[];
  avisos: string[];
}

const TOL_FECHA = 1; // R$1 — mesma régua do AT=PT

/**
 * Monta o FC indireto. Retorna null quando há menos de 2 períodos (sem variação
 * não há método indireto — o chamador exibe o aviso de período curto).
 */
export function buildIndirectCashFlow(
  bp: BPLineItem[],
  dre: DRELineItem[],
  periodos: string[],
): FluxoCaixaIndireto | null {
  if (!periodos || periodos.length < 2) return null;

  const avisos: string[] = [];
  const bpVal = (conta: string, p: string): number => bp.find((l) => l.conta === conta)?.valores[p] ?? 0;
  const dreVal = (conta: string, p: string): number => dre.find((l) => l.conta === conta)?.valores[p] ?? 0;

  // Inputs do BP (nível 2) — subtotais/totais ficam de fora (senão contaria em dobro).
  const inputsBP = bp.filter((l) => l.nivel >= 2);
  const ehPassivo = (l: BPLineItem) => ["PC", "PO", "PF", "PNC"].includes(l.classificacao);
  const ehPL = (l: BPLineItem) => l.classificacao === "PL";

  const colunas: string[] = [];
  const fcoMap = new Map<string, Record<string, number>>();
  const fciMap = new Map<string, Record<string, number>>();
  const fcfMap = new Map<string, Record<string, number>>();
  const push = (map: Map<string, Record<string, number>>, nome: string, p: string, v: number) => {
    if (!map.has(nome)) map.set(nome, {});
    map.get(nome)![p] = (map.get(nome)![p] ?? 0) + v;
  };
  const totais: FluxoCaixaIndireto["totais"] = { fco: {}, fci: {}, fcf: {}, geracaoTotal: {} };
  const prova: ProvaFC[] = [];

  for (let i = 1; i < periodos.length; i++) {
    const p0 = periodos[i - 1];
    const p1 = periodos[i];
    colunas.push(p1);

    const lucro = dreVal("Lucro Líquido", p1);
    const da = dreVal("Depreciação e Amortização", p1);     // armazenada NEGATIVA
    const eqP = dreVal("Equivalência Patrimonial", p1);      // sinal real (lucro + / prejuízo −)

    // ── FCO: lucro + não-caixa ──
    push(fcoMap, "Lucro Líquido do período", p1, lucro);
    if (da !== 0) push(fcoMap, "(+) Depreciação e Amortização (não-caixa)", p1, -da);
    if (eqP !== 0) push(fcoMap, "(−) Equivalência Patrimonial (não-caixa)", p1, -eqP);

    // ── Variações patrimoniais linha a linha ──
    let deltaPL = 0;
    let deltaImobIntang = 0;
    let deltaInvest = 0;
    for (const l of inputsBP) {
      const delta = (l.valores[p1] ?? 0) - (l.valores[p0] ?? 0);
      if (ehPL(l)) { deltaPL += delta; continue; }        // PL agregado (aportes/dividendos/ajustes)
      if (delta === 0) continue;
      const bucket = bucketDaConta(l.conta);
      if (bucket === "caixa") continue;                    // caixa é o ALVO da prova, não componente
      const nomeIt = norm(l.conta);
      if (bucket === "fci" && /imobilizado|intangivel/.test(nomeIt)) { deltaImobIntang += delta; continue; }
      if (bucket === "fci" && nomeIt === "investimentos") { deltaInvest += delta; continue; }
      // Ativo: aumento CONSOME caixa (−Δ). Passivo: aumento GERA caixa (+Δ).
      const efeito = ehPassivo(l) ? delta : -delta;
      const rotulo = `Δ ${l.conta}`;
      if (bucket === "fco") push(fcoMap, rotulo, p1, efeito);
      else if (bucket === "fci") push(fciMap, rotulo, p1, efeito);
      else push(fcfMap, rotulo, p1, efeito);
    }

    // ── FCI: capex bruto (Δ líquido + D&A) e participações ex-equivalência ──
    const capexBruto = -(deltaImobIntang - da); // da é negativa → −(Δ + |D&A|)
    if (capexBruto !== 0) push(fciMap, "Aquisições de Imobilizado/Intangível (capex bruto estimado)", p1, capexBruto);
    const investExEq = -(deltaInvest - eqP);
    if (investExEq !== 0) push(fciMap, "Investimentos em participações (ex-equivalência)", p1, investExEq);

    // ── FCF: movimentações do PL fora do resultado ──
    const plForaResultado = deltaPL - lucro;
    if (Math.abs(plForaResultado) > 0.005) push(fcfMap, "Aportes, dividendos e ajustes do PL (ΔPL − lucro)", p1, plForaResultado);

    // ── Totais + prova de fechamento ──
    const soma = (map: Map<string, Record<string, number>>) =>
      [...map.values()].reduce((s, v) => s + (v[p1] ?? 0), 0);
    totais.fco[p1] = soma(fcoMap);
    totais.fci[p1] = soma(fciMap);
    totais.fcf[p1] = soma(fcfMap);
    totais.geracaoTotal[p1] = totais.fco[p1] + totais.fci[p1] + totais.fcf[p1];

    const caixaInicial = bpVal("Caixa e Equivalentes de Caixa", p0);
    const caixaFinal = bpVal("Caixa e Equivalentes de Caixa", p1);
    const deltaObservado = caixaFinal - caixaInicial;
    const deltaCalculado = totais.geracaoTotal[p1];
    const fecha = Math.abs(deltaCalculado - deltaObservado) <= TOL_FECHA;
    prova.push({ periodo: p1, caixaInicial, caixaFinal, deltaObservado, deltaCalculado, fecha });
    if (!fecha) {
      avisos.push(
        `${p1}: FC calculado (${deltaCalculado.toFixed(2)}) ≠ ΔCaixa do BP (${deltaObservado.toFixed(2)}) — ` +
        `verifique a extração dos dois períodos (a identidade só fecha com AT=PT em ambos).`
      );
    }
  }

  const toLinhas = (map: Map<string, Record<string, number>>): FCLinha[] =>
    [...map.entries()]
      .filter(([, valores]) => Object.values(valores).some((v) => Math.abs(v) > 0.005))
      .map(([nome, valores]) => ({ nome, valores }));

  return { colunas, fco: toLinhas(fcoMap), fci: toLinhas(fciMap), fcf: toLinhas(fcfMap), totais, prova, avisos };
}
