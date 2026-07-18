/**
 * CONTA REGRESSIVA DE CAIXA (2026-07-18) — determinística, ZERO IA.
 *
 * "Falta caixa" assusta; "no ritmo atual o caixa cobre 6 dias de operação" faz
 * agir. Este serviço traduz o caixa em TEMPO, que é a unidade que o dono da
 * empresa entende, usando só números já auditados (BP, DRE e o fluxo de caixa
 * indireto do motor).
 *
 * Duas leituras, porque uma só engana:
 *  1. DIAS DE CAIXA — por quantos dias o dinheiro disponível paga a operação
 *     (custos + despesas do dia a dia, já sem depreciação, que não sai do caixa).
 *     Vale para QUALQUER empresa, inclusive as que dão lucro.
 *  2. MESES ATÉ ZERAR — só quando a operação CONSOME caixa (geração operacional
 *     negativa): caixa dividido pela queima mensal. Quando a operação gera
 *     caixa, essa conta não existe e dizer o contrário seria alarmismo.
 *
 * Nunca inventa: se faltar o insumo, o campo volta null e a frase não é gerada.
 */

export interface LinhaFin { conta: string; valores: Record<string, number> }

export interface ContaRegressiva {
  periodo: string;
  caixa: number;
  /** Custos + despesas que passam pelo caixa, no período (valor absoluto). */
  desembolsoOperacionalAno: number | null;
  desembolsoDiario: number | null;
  /** Por quantos dias o caixa paga a operação. */
  diasDeCaixa: number | null;
  /** Geração (+) ou queima (−) de caixa da operação no período. */
  geracaoOperacional: number | null;
  /** Só quando a operação QUEIMA caixa: meses até o caixa zerar no ritmo atual. */
  mesesAteZerar: number | null;
  status: "critico" | "atencao" | "ok";
  /** Frase pronta, em linguagem de dono, para o relatório. */
  leitura: string;
}

const val = (linhas: LinhaFin[], conta: string, p: string): number | null => {
  const l = linhas.find((x) => x.conta === conta);
  const v = l?.valores?.[p];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

const dias = (n: number): string =>
  n >= 1 ? `${Math.round(n)} dia${Math.round(n) === 1 ? "" : "s"}` : "menos de 1 dia";

const reais = (v: number): string => {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `R$ ${(a / 1_000_000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${a >= 2_000_000 ? "milhões" : "milhão"}`;
  if (a >= 1_000) return `R$ ${Math.round(a / 1_000).toLocaleString("pt-BR")} mil`;
  return `R$ ${Math.round(a).toLocaleString("pt-BR")}`;
};

/**
 * @param periodo período mais recente (o retrato que vale para a decisão)
 * @param diasDoPeriodo 365 no anual; menor em balancete acumulado (mês × 30)
 */
export function calcularContaRegressiva(
  bp: LinhaFin[],
  dre: LinhaFin[],
  periodo: string,
  fcoDoPeriodo: number | null,
  diasDoPeriodo = 365,
): ContaRegressiva | null {
  const caixa = val(bp, "Caixa e Equivalentes de Caixa", periodo);
  if (caixa == null) return null;

  // Desembolso da operação: custo + despesas, SEM depreciação/amortização (não
  // sai do caixa). Os valores da DRE vêm negativos — usamos o módulo.
  const somaAbs = (contas: string[]): number =>
    contas.reduce((s, c) => s + Math.abs(val(dre, c, periodo) ?? 0), 0);
  const desembolso = somaAbs([
    "Custo Operacional", "Despesas com Pessoas", "Outras Despesas Operacionais",
    "Despesas Financeiras", "Impostos s/ Faturamento",
  ]) - Math.abs(val(dre, "Depreciação e Amortização", periodo) ?? 0);

  const desembolsoAno = desembolso > 0 ? desembolso : null;
  const desembolsoDiario = desembolsoAno != null ? desembolsoAno / diasDoPeriodo : null;
  const diasDeCaixa = desembolsoDiario != null && desembolsoDiario > 0 ? caixa / desembolsoDiario : null;

  const queima = fcoDoPeriodo != null && fcoDoPeriodo < 0 ? Math.abs(fcoDoPeriodo) : null;
  const mesesAteZerar = queima != null && queima > 0 ? caixa / (queima / (diasDoPeriodo / 30)) : null;

  const status: ContaRegressiva["status"] =
    (diasDeCaixa != null && diasDeCaixa < 15) || (mesesAteZerar != null && mesesAteZerar < 3) ? "critico"
    : (diasDeCaixa != null && diasDeCaixa < 45) || (mesesAteZerar != null && mesesAteZerar < 6) ? "atencao"
    : "ok";

  const partes: string[] = [];
  if (diasDeCaixa != null && desembolsoDiario != null) {
    partes.push(
      `A empresa tem ${reais(caixa)} disponíveis e gasta cerca de ${reais(desembolsoDiario)} por dia para funcionar, ` +
      `o que significa que o caixa de hoje paga ${dias(diasDeCaixa)} de operação`,
    );
  }
  if (mesesAteZerar != null) {
    partes.push(
      `a operação está consumindo caixa em vez de gerar, e no ritmo atual o dinheiro disponível se esgota em cerca de ` +
      `${mesesAteZerar < 1 ? "menos de um mês" : `${mesesAteZerar.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} meses`}`,
    );
  } else if (fcoDoPeriodo != null && fcoDoPeriodo > 0) {
    partes.push(`a operação gera caixa, cerca de ${reais(fcoDoPeriodo)} no período, o que dá fôlego para recompor a reserva`);
  }
  if (partes.length === 0) return null;

  const fecho =
    status === "critico"
      ? " Nesse patamar, qualquer atraso de cliente ou antecipação de fornecedor vira problema de pagamento no mesmo mês."
      : status === "atencao"
      ? " É uma reserva curta: um mês ruim de recebimento já aperta o pagamento das contas."
      : "";

  return {
    periodo, caixa,
    desembolsoOperacionalAno: desembolsoAno, desembolsoDiario, diasDeCaixa,
    geracaoOperacional: fcoDoPeriodo, mesesAteZerar, status,
    leitura: `${partes.join("; ")}.${fecho}`,
  };
}
