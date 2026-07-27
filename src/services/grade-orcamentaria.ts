/**
 * GRADE ORÇAMENTÁRIA (F5 do PLANO_ORCAMENTO_QUANTUA.md, 27/07/2026).
 *
 * As REGRAS RÁPIDAS da grade: em vez de digitar 12 células, o analista aplica
 * uma regra sobre o realizado — a prática universal do orçamento incremental.
 *
 *  - repetir        → ano anterior, mês a mês;
 *  - mais-pct       → ano anterior × (1 + X%);
 *  - anual-sazonal  → um TOTAL anual distribuído pela sazonalidade do realizado
 *                     (sem curva conhecida, divide igual — e a memória declara);
 *  - pct-receita    → a linha passa a % da receita (muda o MODO, não a série).
 *
 * Puro e determinístico (padrão model-engine): quem chama passa a referência do
 * realizado; aqui só a matemática + a MEMÓRIA de cálculo (trilha/tela). A
 * gravação acontece pelo PUT de bloco existente — que carrega as travas (F4,
 * linha de histórico, auditoria) por um único caminho.
 */
import { Serie } from "./model-engine";

export type RegraGrade = "repetir" | "mais-pct" | "anual-sazonal" | "pct-receita";

export interface AplicarRegraInput {
  regra: RegraGrade;
  /** Meses do exercício a preencher ("2027-01"…"2027-12"), já dentro do horizonte. */
  mesesAlvo: string[];
  /** Realizado MENSAL da linha (qualquer ano — o casamento é pelo Nº do mês). */
  refMensal?: Serie | null;
  /** Total ANUAL de referência (fallback quando não há mensal). */
  refAnual?: number | null;
  /** mais-pct (0.05 = +5%) e pct-receita (0.12 = 12% da receita). */
  pct?: number;
  /** anual-sazonal: o total do ano a distribuir. */
  valorAnual?: number;
}

export interface AplicarRegraSaida {
  /** Série nova para os meses-alvo (regras de valor). */
  valores?: Serie;
  /** pct-receita: a linha muda de modo em vez de ganhar série. */
  modo?: "pctReceita";
  pct?: number;
  /** Memória de cálculo legível — vai para a tela e para a trilha. */
  memoria: string;
}

/**
 * Base MENSAL por número do mês (1..12) a partir do realizado. Com mais de um
 * ano na série, vale o ANO MAIS RECENTE que tem o mês — o orçamento parte do
 * último realizado, não da média histórica (média esconde tendência).
 */
export function baseMensalPorNumero(refMensal: Serie | null | undefined): Map<number, number> {
  const out = new Map<number, { ano: number; valor: number }>();
  for (const [mes, valor] of Object.entries(refMensal ?? {})) {
    const m = /^(\d{4})-(\d{2})$/.exec(mes);
    if (!m || !Number.isFinite(valor)) continue;
    const ano = Number(m[1]);
    const num = Number(m[2]);
    const atual = out.get(num);
    if (!atual || ano > atual.ano) out.set(num, { ano, valor });
  }
  return new Map([...out.entries()].map(([num, { valor }]) => [num, valor]));
}

const mesNum = (mes: string): number => Number(mes.split("-")[1]);

export function aplicarRegraGrade(i: AplicarRegraInput): AplicarRegraSaida {
  if (i.regra === "pct-receita") {
    const pct = i.pct ?? 0;
    return {
      modo: "pctReceita",
      pct,
      memoria: `Linha passou a ${(pct * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}% da receita (o valor acompanha a receita projetada do mês).`,
    };
  }

  const base = baseMensalPorNumero(i.refMensal);
  const temMensal = base.size > 0;
  const anualRef = i.refAnual ?? null;

  if (i.regra === "repetir" || i.regra === "mais-pct") {
    const fator = i.regra === "mais-pct" ? 1 + (i.pct ?? 0) : 1;
    const valores: Serie = {};
    if (temMensal) {
      for (const mes of i.mesesAlvo) valores[mes] = (base.get(mesNum(mes)) ?? 0) * fator;
    } else if (anualRef !== null && Number.isFinite(anualRef)) {
      // Sem mensal: reparte o anual igual — declarado na memória, nunca em silêncio.
      const porMes = anualRef / 12;
      for (const mes of i.mesesAlvo) valores[mes] = porMes * fator;
    } else {
      return { valores: {}, memoria: "Sem realizado de referência — nada aplicado. Digite os meses ou use um valor anual." };
    }
    const pctTxt = i.regra === "mais-pct" ? ` ${(i.pct ?? 0) >= 0 ? "+" : ""}${((i.pct ?? 0) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%` : "";
    return {
      valores,
      memoria: temMensal
        ? `Realizado do último ano, mês a mês${pctTxt}.`
        : `Realizado anual ÷ 12 (sem abertura mensal no realizado)${pctTxt}.`,
    };
  }

  // anual-sazonal
  const total = i.valorAnual ?? 0;
  const valores: Serie = {};
  if (temMensal) {
    let soma = 0;
    for (const mes of i.mesesAlvo) soma += Math.max(0, base.get(mesNum(mes)) ?? 0);
    if (soma > 0) {
      for (const mes of i.mesesAlvo) valores[mes] = (Math.max(0, base.get(mesNum(mes)) ?? 0) / soma) * total;
      return { valores, memoria: `Total anual distribuído pela sazonalidade do realizado (curva do último ano).` };
    }
  }
  const porMes = i.mesesAlvo.length > 0 ? total / i.mesesAlvo.length : 0;
  for (const mes of i.mesesAlvo) valores[mes] = porMes;
  return { valores, memoria: `Total anual dividido igualmente entre ${i.mesesAlvo.length} meses (sem curva de sazonalidade no realizado).` };
}

/** Meses de um ANO-calendário que caem dentro do horizonte do modelo. */
export function mesesDoAnoNoHorizonte(mesInicial: string, horizonteMeses: number, ano: string): string[] {
  const [y0, m0] = mesInicial.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < horizonteMeses; i++) {
    const total = y0 * 12 + (m0 - 1) + i;
    const y = Math.floor(total / 12);
    if (String(y) !== ano) continue;
    out.push(`${y}-${String((total % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

/**
 * Referência ANUAL de uma linha a partir do histórico por linha do seed
 * ({período: valor} — "31/12/2025" ou "2025"): vale o período mais recente.
 */
export function refAnualDaLinha(porPeriodo: Record<string, number> | undefined): { valor: number; periodo: string } | null {
  if (!porPeriodo) return null;
  let melhor: { valor: number; periodo: string; ano: number } | null = null;
  for (const [periodo, valor] of Object.entries(porPeriodo)) {
    const ano = Number((periodo.match(/\d{4}/g) ?? []).pop() ?? NaN);
    if (!Number.isFinite(ano) || !Number.isFinite(valor)) continue;
    if (!melhor || ano > melhor.ano) melhor = { valor, periodo, ano };
  }
  return melhor ? { valor: melhor.valor, periodo: melhor.periodo } : null;
}
