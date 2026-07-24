/**
 * INDICADORES DO VALUATION/BP COMO ESPELHO DO IBR (pedido do usuário, 24/07/2026).
 *
 * A aba Indicadores do modelo tinha um conjunto PRÓPRIO de indicadores — parecido
 * com o do IBR em espírito, diferente em nomes, fórmulas e agrupamento. Duas listas
 * para a mesma pergunta é uma divergência esperando para acontecer: o analista
 * compara "Margem EBITDA" do IBR com "Margem EBITDA" do Valuation e elas não
 * precisam bater.
 *
 * Aqui o problema é resolvido pela raiz: em vez de reescrever os indicadores, este
 * módulo TRADUZ a projeção do motor para o formato que o IBR já consome (BPLineItem
 * e DRELineItem por período) e chama `calculateIndicators` — o MESMO código, o
 * mesmo catálogo, os mesmos semáforos. Espelho por construção, não por cópia: quem
 * mexer numa fórmula do IBR amanhã mexe nas duas pontas de uma vez.
 *
 * As duas armadilhas do caminho, ambas cobertas por teste:
 *
 * 1. SINAL. No motor, as saídas são POSITIVAS e a cascata subtrai
 *    (`ebit = ebitda − depreciação`). No IBR, as saídas são NEGATIVAS e a cascata
 *    soma (`lucroBruto = receitaLíquida + custoOp`). Traduzir sem inverter daria
 *    margens absurdas — lucro bruto maior que a receita.
 *
 * 2. DIAS DO PERÍODO. Ano parcial do horizonte (um Valuation que começa em julho
 *    tem 6 meses em 2026) traz 6 meses de DRE. A heurística do IBR assumiria 365
 *    dias e os prazos médios sairiam ~2× inflados. Por isso os dias vão explícitos.
 */
import type { ResultadoModelo, LinhaDre, Serie } from "./model-engine";
import type { BPLineItem, DRELineItem, Indicador } from "../types/financial";
import { calculateIndicators } from "./indicator-calculator";
import type { SemaforoDef } from "./indicator-calculator";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Soma dos meses do ano presentes no horizonte (medida de FLUXO — DRE). */
function somaAno(serie: Serie | undefined, ano: string, meses: string[]): number {
  let s = 0;
  for (const m of meses) if (m.startsWith(ano)) s += num(serie?.[m]);
  return s;
}

/** Valor do ÚLTIMO mês do ano (medida de SALDO — balanço). */
function fimAno(serie: Serie | undefined, ano: string, meses: string[]): number {
  const doAno = meses.filter((m) => m.startsWith(ano));
  const ultimo = doAno[doAno.length - 1];
  return ultimo ? num(serie?.[ultimo]) : 0;
}

const acha = (linhas: LinhaDre[], id: string): Serie | undefined => linhas.find((l) => l.id === id)?.valores;

/**
 * Traduz o resultado do motor para o par (bp, dre) do IBR, um valor por ano.
 * Exportada para o teste conseguir provar sinal e fechamento sem passar pela rota.
 */
export function projecaoComoDfsDoIbr(resultado: ResultadoModelo, anos: string[]): {
  bp: BPLineItem[];
  dre: DRELineItem[];
  diasPorPeriodo: Record<string, number>;
} {
  const meses = resultado.meses;
  const porAnoFluxo = (serie: Serie | undefined): Record<string, number> =>
    Object.fromEntries(anos.map((a) => [a, somaAno(serie, a, meses)]));
  const porAnoSaldo = (serie: Serie | undefined): Record<string, number> =>
    Object.fromEntries(anos.map((a) => [a, fimAno(serie, a, meses)]));
  /** Saída da DRE: o motor guarda positivo, o IBR espera negativo. */
  const saida = (serie: Serie | undefined): Record<string, number> =>
    Object.fromEntries(anos.map((a) => [a, -Math.abs(somaAno(serie, a, meses))]));

  const d = (id: string) => acha(resultado.dre, id);
  const b = (id: string) => acha(resultado.bp, id);

  // ── DRE: as linhas CANÔNICAS do modelo padrão do IBR ──
  // Emitimos os subtotais direto; `computeIndicator` prefere o subtotal presente
  // à cascata, então o número do indicador é exatamente o do motor.
  const linhaDre = (conta: string, valores: Record<string, number>, subtotal = false): DRELineItem =>
    ({ conta, valores, subtotal, editado: false });

  const receitaBruta = porAnoFluxo(d("receita-total"));
  const receitaLiquidaSerie = d("receita-liquida") ?? d("receita-total");
  const dre: DRELineItem[] = [
    linhaDre("Receita Bruta", receitaBruta),
    linhaDre("Deduções da Receita Bruta", saida(d("deducoes-receita"))),
    linhaDre("Impostos s/ Faturamento", saida(d("impostos-receita"))),
    linhaDre("Receita Líquida", porAnoFluxo(receitaLiquidaSerie), true),
    linhaDre("Custo Operacional", saida(d("custos-total"))),
    linhaDre("Lucro Bruto", porAnoFluxo(d("lucro-bruto")), true),
    // O motor mantém UM total de despesas operacionais; no catálogo do IBR ele
    // entra em "Despesas Gerais e Administrativas" (as outras contas de despesa
    // ficam zeradas). O EBITDA vem do subtotal do motor, então o agrupamento não
    // altera nenhum indicador — só a linha em que a despesa aparece.
    linhaDre("Despesas Gerais e Administrativas", saida(d("despesas-total"))),
    linhaDre("EBITDA", porAnoFluxo(d("ebitda")), true),
    linhaDre("Depreciação e Amortização", saida(d("depreciacao-total"))),
    linhaDre("EBIT", porAnoFluxo(d("ebit")), true),
    linhaDre("Outras Receitas Não Operacionais", porAnoFluxo(d("rec-naoop-total"))),
    linhaDre("Outras Despesas Não Operacionais", saida(d("desp-naoop-total"))),
    linhaDre("Despesas Financeiras", saida(d("juros-divida"))),
    linhaDre("Resultado Antes do IR e CSLL", porAnoFluxo(d("lair")), true),
    linhaDre("IR e CSLL", saida(d("irpj-csll"))),
    linhaDre("Lucro Líquido", porAnoFluxo(d("lucro-liquido")), true),
  ];

  // ── BALANÇO: os nomes do motor já são os canônicos do IBR ──
  // `classificacao` importa para a NCG, que o IBR soma por classe (AO/PO): giro
  // operacional é contas a receber + estoques contra fornecedores.
  const linhaBp = (classificacao: string, conta: string, valores: Record<string, number>, nivel: number): BPLineItem =>
    ({ classificacao, conta, valores, nivel, editado: false });

  const bp: BPLineItem[] = [
    linhaBp("AT", "Ativo Total", porAnoSaldo(b("bp-ativo")), 0),
    linhaBp("AC", "Ativo Circulante", porAnoSaldo(b("bp-ativo-circ")), 1),
    linhaBp("AC", "Caixa e Equivalentes de Caixa", porAnoSaldo(b("bp-caixa")), 3),
    linhaBp("AO", "Contas a Receber - CP", porAnoSaldo(b("bp-cr")), 3),
    linhaBp("AO", "Estoques - CP", porAnoSaldo(b("bp-estoques")), 3),
    linhaBp("ANC", "Ativo Não Circulante", porAnoSaldo(b("bp-ativo-nc")), 1),
    linhaBp("AF", "Imobilizado", porAnoSaldo(b("bp-imobilizado")), 3),
    linhaBp("AF", "(-) Depreciação", porAnoSaldo(b("bp-depreciacao")), 3),
    linhaBp("AF", "Intangível", porAnoSaldo(b("bp-intangivel")), 3),
    linhaBp("AF", "(-) Amortização", porAnoSaldo(b("bp-amortizacao")), 3),
    linhaBp("PT", "Passivo Total", porAnoSaldo(b("bp-passivo-pl")), 0),
    linhaBp("PC", "Passivo Circulante", porAnoSaldo(b("bp-passivo-circ")), 1),
    linhaBp("PO", "Fornecedores - CP", porAnoSaldo(b("bp-fornecedores")), 3),
    linhaBp("PF", "Empréstimos e Financiamentos - CP", porAnoSaldo(b("bp-divida-cp")), 3),
    linhaBp("PNC", "Passivo Não Circulante", porAnoSaldo(b("bp-passivo-nc")), 1),
    linhaBp("PF", "Empréstimos e Financiamentos - LP", porAnoSaldo(b("bp-divida-lp")), 3),
    linhaBp("PL", "Patrimônio Líquido", porAnoSaldo(b("bp-pl")), 1),
  ];

  // Dias do período pelo nº REAL de meses projetados no ano (ver cabeçalho).
  const diasPorPeriodo: Record<string, number> = {};
  for (const a of anos) {
    const n = meses.filter((m) => m.startsWith(a)).length;
    diasPorPeriodo[a] = n >= 12 ? 365 : n * 30;
  }

  return { bp, dre, diasPorPeriodo };
}

/**
 * Indicadores do modelo no catálogo do IBR — a lista inteira, mesma ordem,
 * mesmos grupos, mesmos semáforos.
 */
export function indicadoresIbrDoModelo(
  resultado: ResultadoModelo,
  anos: string[],
  opts?: {
    custoCapital?: number;
    semaforoOverrides?: Record<string, SemaforoDef>;
    /** DFs REALIZADOS do IBR-fonte, no formato nativo de `dadosEstruturados`. */
    historico?: HistoricoDfsIbr;
  },
): { indicadores: Indicador[]; periodos: string[]; periodosHistoricos: string[]; mesesPorPeriodo: Record<string, number> } {
  const proj = projecaoComoDfsDoIbr(resultado, anos);
  const { bp, dre, diasPorPeriodo, periodos, periodosHistoricos } = mesclarHistoricoIbr(proj, anos, opts?.historico);
  // Meses REAIS de cada coluna. Com o histórico ao lado, um ano parcial vira
  // leitura errada sem aviso: um Valuation que começa em julho põe 6 meses de
  // 2026 ao lado de 2025 cheio, e o "Crescimento da Receita" acusa −41% de
  // queda que não existe. A tela precisa saber para marcar a coluna.
  const mesesPorPeriodo: Record<string, number> = {};
  for (const p of periodosHistoricos) mesesPorPeriodo[p] = 12; // exercício fechado do IBR
  for (const a of anos) mesesPorPeriodo[a] = resultado.meses.filter((m) => m.startsWith(a)).length;
  return {
    indicadores: calculateIndicators(bp, dre, periodos, opts?.semaforoOverrides, undefined, undefined, {
      diasPorPeriodo,
      custoCapital: opts?.custoCapital,
    }),
    periodos,
    periodosHistoricos,
    mesesPorPeriodo,
  };
}

/** DFs realizados como o IBR os guarda em `analysis.dadosEstruturados`. */
export interface HistoricoDfsIbr {
  periodos?: string[];
  bp?: Array<{ conta: string; valores: Record<string, number>; classificacao?: string; nivel?: number }>;
  dre?: Array<{ conta: string; valores: Record<string, number>; subtotal?: boolean }>;
}

/** Chave de casamento entre a conta extraída e a conta traduzida da projeção:
 *  sem acento, sem caixa, sem pontuação — "(-) Depreciação" casa com
 *  "(-) DEPRECIACAO". Diferença de grafia não pode virar linha duplicada. */
const DIACRITICOS = new RegExp(String.fromCharCode(91,92,117,48,51,48,48,45,92,117,48,51,54,102,93), "g"); // escapado de propósito: o caractere
// combinante literal já corrompeu um arquivo desta base (byte nulo no disco).
const chaveConta = (s: string): string =>
  s.normalize("NFD").replace(DIACRITICOS, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Rótulo da coluna histórica: fechamento de dezembro vira o ANO (para ficar na
 *  mesma régua das colunas projetadas); qualquer outra data mantém o original,
 *  porque um período de 30/06 comparado a um ano cheio precisa se anunciar. */
export function rotuloPeriodoHistorico(periodo: string): string {
  const m = periodo.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m && m[1] === "31" && m[2] === "12") return m[3];
  const iso = periodo.match(/^(\d{4})-12-31$/);
  if (iso) return iso[1];
  return periodo;
}

/**
 * HISTÓRICO + PROJEÇÃO NA MESMA TABELA (pedido do usuário, 24/07/2026).
 *
 * As colunas realizadas entram como PERÍODOS ADICIONAIS das mesmas linhas de BP
 * e DRE, e `calculateIndicators` roda uma vez sobre o conjunto inteiro. É o que
 * garante que "Margem EBITDA" de 2025 e de 2027 saiam da mesma fórmula — se o
 * histórico fosse calculado por outro caminho, a comparação que o analista faz
 * na horizontal deixaria de ser legítima.
 *
 * Um período histórico que colida com ano projetado é DESCARTADO: no intervalo
 * que o modelo projeta, quem manda é a projeção (a mesma regra que o Dashboard
 * já aplica), senão o ano apareceria duas vezes com números diferentes.
 */
export function mesclarHistoricoIbr(
  proj: { bp: BPLineItem[]; dre: DRELineItem[]; diasPorPeriodo: Record<string, number> },
  anos: string[],
  hist?: HistoricoDfsIbr,
): { bp: BPLineItem[]; dre: DRELineItem[]; diasPorPeriodo: Record<string, number>; periodos: string[]; periodosHistoricos: string[] } {
  const semHistorico = {
    ...proj, periodos: anos, periodosHistoricos: [] as string[],
  };
  if (!hist?.periodos?.length || !hist.bp?.length) return semHistorico;

  const primeiroProjetado = anos[0] ?? "";
  // Só períodos com movimento no balanço e anteriores ao horizonte projetado.
  const usaveis = hist.periodos
    .filter((p) => hist.bp!.some((l) => Math.abs(l.valores?.[p] ?? 0) > 0))
    .map((p) => ({ periodo: p, rotulo: rotuloPeriodoHistorico(p) }))
    .filter((x) => !primeiroProjetado || x.rotulo < primeiroProjetado)
    .sort((a, b) => a.rotulo.localeCompare(b.rotulo));
  if (!usaveis.length) return semHistorico;

  const rotulos = usaveis.map((x) => x.rotulo);

  /** Copia as colunas históricas para as linhas da projeção, casando por conta;
   *  conta que só existe no histórico entra como linha nova (com a projeção em
   *  branco), para nenhum dado extraído sumir da tabela. */
  function fundir<T extends { conta: string; valores: Record<string, number> }>(
    daProjecao: T[], doHistorico: Array<{ conta: string; valores: Record<string, number> }>, novaLinha: (l: { conta: string; valores: Record<string, number> }) => T,
  ): T[] {
    const porChave = new Map(daProjecao.map((l) => [chaveConta(l.conta), l]));
    const out = daProjecao.map((l) => ({ ...l, valores: { ...l.valores } }));
    const outPorChave = new Map(out.map((l) => [chaveConta(l.conta), l]));
    const extras: T[] = [];
    for (const lh of doHistorico) {
      const k = chaveConta(lh.conta);
      const alvo = outPorChave.get(k);
      if (alvo) {
        for (const { periodo, rotulo } of usaveis) alvo.valores[rotulo] = num(lh.valores?.[periodo]);
        continue;
      }
      if (porChave.has(k)) continue;
      const nova = novaLinha(lh);
      nova.valores = {};
      for (const { periodo, rotulo } of usaveis) nova.valores[rotulo] = num(lh.valores?.[periodo]);
      extras.push(nova);
      outPorChave.set(k, nova);
    }
    return [...out, ...extras];
  }

  const bp = fundir<BPLineItem>(proj.bp, hist.bp, (l) => ({
    classificacao: (l as { classificacao?: string }).classificacao ?? "",
    conta: l.conta, valores: {}, nivel: (l as { nivel?: number }).nivel ?? 2, editado: false,
  }));
  const dre = fundir<DRELineItem>(proj.dre, hist.dre ?? [], (l) => ({
    conta: l.conta, valores: {}, subtotal: (l as { subtotal?: boolean }).subtotal ?? false, editado: false,
  }));

  // Realizado do IBR é sempre exercício fechado — 365 dias, como o próprio IBR
  // assume ao calcular os prazos médios dele.
  const diasPorPeriodo = { ...proj.diasPorPeriodo };
  for (const r of rotulos) diasPorPeriodo[r] = 365;

  return { bp, dre, diasPorPeriodo, periodos: [...rotulos, ...anos], periodosHistoricos: rotulos };
}
