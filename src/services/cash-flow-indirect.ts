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

// Colapsa espaços internos também: o template tem "Dividendos a Receber -  Longo Prazo"
// (espaço duplo) — sem o collapse, a chave explícita nunca casaria.
const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

// Linhas do modelo padrão com destino EXPLÍCITO (nome → bucket). Linhas adicionadas
// pelo usuário no editor de modelos caem no fallback por palavra-chave (determinístico).
const BUCKET_EXPLICITO: Record<string, BucketFC> = {
  "caixa e equivalentes de caixa": "caixa",
  // FCI — investimento
  "aplicacoes financeiras - lp": "fci",
  "investimentos": "fci",
  "imobilizado": "fci",
  "intangivel": "fci",
  // Redutoras da segregação 2026-07-16 — mesmo bloco do imob/intangível (o Δ
  // delas compõe o Δ LÍQUIDO no capex bruto; no fallback cairiam no FCO).
  "(-) depreciacao": "fci",
  "(-) amortizacao": "fci",
  "bens a alienar": "fci",
  "ativo diferido": "fci",
  "ativos com partes relacionadas - cp": "fci",
  "ativos com partes relacionadas - lp": "fci",
  // Realizável a LP = aplicações/depósitos de longo prazo — INVESTIMENTO (caía no
  // default operacional e distorcia a leitura FCO vs FCI; auditoria 2026-07).
  "realizavel a longo prazo": "fci",
  // Dividendos a RECEBER são ATIVO (retorno de participações) — investimento. A regra
  // de palavra-chave /dividendo/ os jogava em financiamento (que é dividendo a PAGAR).
  "dividendos a receber - cp": "fci",
  "dividendos a receber - longo prazo": "fci",
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
  // dividendos a RECEBER (ativo) antes da regra de financiamento — variantes custom
  if (/dividendo.*receber|receber.*dividendo/.test(n)) return "fci";
  if (/emprest|financiament|debentur|arrendament/.test(n)) return "fcf";
  if (/dividendo|jcp|juros sobre o capital|aumento capital/.test(n)) return "fcf";
  if (/imobilizado|intangivel|investimento|aplicac|realizavel a longo prazo|deprecia|amortiza/.test(n)) return "fci";
  return "fco"; // capital de giro / operacional por padrão
}

/** Contas do CAPITAL DE GIRO — sub-bloco próprio dentro do FCO (subtotal exibido).
 *  Régua definida pelo usuário (2026-07): CR, Estoques, Ativos Biológicos, Fornecedores. */
const CG_CONTAS = new Set([
  "contas a receber - cp",
  "estoques - cp",
  "ativos biologicos - cp",
  "fornecedores - cp",
]);

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
  fco: FCLinha[];            // SEM as linhas de capital de giro (exibidas no sub-bloco)
  /** Sub-bloco do FCO: variação do CAPITAL DE GIRO (CR, Estoques, Ativos Biológicos,
   *  Fornecedores) com subtotal próprio. `totais.fco` CONTINUA incluindo o CG — a
   *  identidade e o Dickinson não mudam. Ausente em dados persistidos antigos. */
  capitalGiro?: { linhas: FCLinha[]; total: Record<string, number> };
  fci: FCLinha[];
  fcf: FCLinha[];
  totais: { fco: Record<string, number>; fci: Record<string, number>; fcf: Record<string, number>; geracaoTotal: Record<string, number> };
  prova: ProvaFC[];
  avisos: string[];
}

const TOL_FECHA = 1; // R$1 — mesma régua do AT=PT

/** Ordena períodos cronologicamente ("31/12/2022" ou "2022"). O array guardado em
 *  dadosEstruturados pode vir na ordem dos DOCUMENTOS — parear sem ordenar cruzaria
 *  as variações entre anos errados (ex.: 2022→2020). */
const ordPeriodo = (p: string): number => {
  const m = p.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return Number(`${m[3]}${m[2]}${m[1]}`);
  const y = p.match(/\d{4}/);
  return y ? Number(`${y[0]}0000`) : 0;
};

/**
 * Monta o FC indireto. Retorna null quando há menos de 2 períodos (sem variação
 * não há método indireto — o chamador exibe o aviso de período curto).
 */
export function buildIndirectCashFlow(
  bp: BPLineItem[],
  dre: DRELineItem[],
  periodosBrutos: string[],
): FluxoCaixaIndireto | null {
  if (!periodosBrutos || periodosBrutos.length < 2) return null;
  const periodos = [...periodosBrutos].sort((a, b) => ordPeriodo(a) - ordPeriodo(b));

  const avisos: string[] = [];
  const bpVal = (conta: string, p: string): number => bp.find((l) => l.conta === conta)?.valores[p] ?? 0;
  const dreVal = (conta: string, p: string): number => dre.find((l) => l.conta === conta)?.valores[p] ?? 0;

  // Inputs do BP (nível 2) — subtotais/totais ficam de fora (senão contaria em dobro).
  const inputsBP = bp.filter((l) => l.nivel >= 2);
  const ehPassivo = (l: BPLineItem) => ["PC", "PO", "PF", "PNC"].includes(l.classificacao);
  const ehPL = (l: BPLineItem) => l.classificacao === "PL";

  const colunas: string[] = [];
  const fcoMap = new Map<string, Record<string, number>>();
  const cgMap = new Map<string, Record<string, number>>(); // capital de giro (sub-bloco do FCO)
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
    let deltaCapSocial = 0; // aporte/redução de capital — aberto em linha própria no FCF
    let deltaImobIntang = 0;
    let deltaInvest = 0;
    for (const l of inputsBP) {
      const delta = (l.valores[p1] ?? 0) - (l.valores[p0] ?? 0);
      if (ehPL(l)) {
        deltaPL += delta;                                  // PL agregado (identidade intacta)
        if (/capital social/.test(norm(l.conta))) deltaCapSocial += delta;
        continue;
      }
      if (delta === 0) continue;
      const bucket = bucketDaConta(l.conta);
      if (bucket === "caixa") continue;                    // caixa é o ALVO da prova, não componente
      const nomeIt = norm(l.conta);
      // Segregação 2026-07-16: "(-) Depreciação"/"(-) Amortização" (redutoras do
      // BP, valores negativos) entram no MESMO bloco do imob/intangível — o Δ do
      // bloco volta a ser o Δ LÍQUIDO e o capex bruto (Δ líquido + D&A) fica
      // idêntico ao de antes da segregação. Sem isso, o capex dobraria a D&A.
      if (bucket === "fci" && /imobilizado|intangivel|deprecia|amortiza/.test(nomeIt)) { deltaImobIntang += delta; continue; }
      if (bucket === "fci" && nomeIt === "investimentos") { deltaInvest += delta; continue; }
      // Ativo: aumento CONSOME caixa (−Δ). Passivo: aumento GERA caixa (+Δ).
      const efeito = ehPassivo(l) ? delta : -delta;
      const rotulo = `Δ ${l.conta}`;
      if (bucket === "fco") push(CG_CONTAS.has(nomeIt) ? cgMap : fcoMap, rotulo, p1, efeito);
      else if (bucket === "fci") push(fciMap, rotulo, p1, efeito);
      else push(fcfMap, rotulo, p1, efeito);
    }

    // ── FCI: capex bruto (Δ líquido + D&A) e participações ex-equivalência ──
    const capexBruto = -(deltaImobIntang - da); // da é negativa → −(Δ + |D&A|)
    if (capexBruto !== 0) push(fciMap, "Aquisições de Imobilizado/Intangível (capex bruto estimado)", p1, capexBruto);
    const investExEq = -(deltaInvest - eqP);
    if (investExEq !== 0) push(fciMap, "Investimentos em participações (ex-equivalência)", p1, investExEq);

    // ── FCF: movimentações do PL fora do resultado ──
    // Δ Capital Social ABERTO em linha própria (aporte/redução visível); o restante
    // (dividendos e demais ajustes) fica na linha agregada. A soma é a mesma de antes
    // (ΔPL − lucro) — identidade e prova intactas.
    const plForaResultado = deltaPL - lucro;
    const ajustesSemCapital = plForaResultado - deltaCapSocial;
    if (Math.abs(deltaCapSocial) > 0.005) push(fcfMap, "Δ Capital Social (aporte / redução de capital)", p1, deltaCapSocial);
    if (Math.abs(ajustesSemCapital) > 0.005) push(fcfMap, "Dividendos e ajustes do PL (ΔPL − lucro − Δ capital)", p1, ajustesSemCapital);

    // ── Totais + prova de fechamento ──
    const soma = (map: Map<string, Record<string, number>>) =>
      [...map.values()].reduce((s, v) => s + (v[p1] ?? 0), 0);
    totais.fco[p1] = soma(fcoMap) + soma(cgMap); // FCO INCLUI o capital de giro
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

  // Subtotal do capital de giro por coluna (a partir das linhas que sobreviveram ao filtro)
  const cgLinhas = toLinhas(cgMap);
  const cgTotal: Record<string, number> = {};
  for (const c of colunas) cgTotal[c] = cgLinhas.reduce((s, l) => s + (l.valores[c] ?? 0), 0);

  return {
    colunas,
    fco: toLinhas(fcoMap),
    capitalGiro: { linhas: cgLinhas, total: cgTotal },
    fci: toLinhas(fciMap),
    fcf: toLinhas(fcfMap),
    totais, prova, avisos,
  };
}
