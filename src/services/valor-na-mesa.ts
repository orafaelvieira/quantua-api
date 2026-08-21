/**
 * VALOR NA MESA — ÂNCORA DETERMINÍSTICA (decisão 08/07/2026).
 *
 * O placar era 100% estimado pela IA e flutuava a cada regeração (R$ 4,2M → 3,7M na
 * Move Farma) porque a IA escolhia alavancas diferentes. Arquitetura em dois estratos:
 *
 *   ESTRATO 1 (este serviço) — ALAVANCAS CANÔNICAS calculadas pelo MOTOR a partir dos
 *   gaps da empresa vs a MEDIANA dos pares. Cada alavanca só dispara quando a empresa
 *   está do lado ruim da régua — o resultado é naturalmente específico por empresa:
 *     · Prazo de recebimento acima da mediana → dias de excesso × receita diária;
 *     · Estoque acima da mediana → dias de excesso × custo diário de mercadoria;
 *     · Prazo de pagamento abaixo da mediana → dias a alongar × compras diárias;
 *     · Margem EBITDA abaixo da mediana → gap × receita (recuperável POR ANO).
 *
 *   ESTRATO 2 (IA, no prompt) — alavancas ESPECÍFICAS aditivas (ex.: disciplina de
 *   distribuição, ativo ocioso), cada uma com memória de cálculo; a IA não pode
 *   alterar as canônicas (entram como fato "já contado").
 *
 * Mesma extração + mesmos pares = mesmas canônicas, sempre. A variação entre
 * regenerações fica confinada ao estrato da IA — e visível como tal.
 */
import type { PeerComparisonRow } from "./peer-benchmark";
import { diasBaseDe, diasYTD, diasDoPeriodo } from "./indicator-calculator";

export interface AlavancaValor {
  origem: "motor" | "analise";
  titulo: string;
  /** "caixa" = liberação única (giro) · "margem" = resultado recuperável POR ANO. */
  tipo: "caixa" | "margem";
  valor: number;
  /** A conta explicada em PROSA (leitor leigo) — memória de cálculo auditável. */
  memoria: string;
}

export interface ValorCanonico {
  caixaLiberavel: number;
  margemRecuperavelAno: number;
  total: number;
  alavancas: AlavancaValor[];
  base: { segmento: string | null; periodo: string | null };
  /** A LEITURA ESCRITA PELO MOTOR, dos próprios números. */
  leitura: string;
}

/**
 * A PROSA SEGUE O MOTOR (dono, 21/08/2026: "o motor calcula, manda e a prosa
 * segue o motor").
 *
 * A leitura vinha da IA (`ai.valorNaMesaLeitura`) enquanto a manchete vinha
 * daqui — e as duas discordavam na mesma caixa: "R$ 284,30 mi" no título e
 * "da ordem de R$ 273 milhões" no texto ao lado. Agora quem calcula escreve.
 *
 * A leitura também precisa dizer COMO se chega ao número ("o relatório traz
 * clareza em como conseguir o valor sugerido"): cada alavanca vira uma ação
 * concreta, com o quanto vale e o que tem de mudar para valer.
 *
 * E DECLARA A NATUREZA DE CADA PARCELA. Caixa liberável é liberação ÚNICA
 * (dinheiro preso no giro que volta uma vez); margem recuperável é resultado
 * POR ANO. Somar os dois num número só é útil como ordem de grandeza, mas o
 * texto tem de dizer que são naturezas diferentes — senão o leitor lê o total
 * como se fosse dinheiro anual, ou como se fosse tudo à vista.
 */
export function leituraDoValor(
  caixaLiberavel: number,
  margemRecuperavelAno: number,
  alavancas: AlavancaValor[],
  base: { segmento: string | null; periodo: string | null },
): string {
  if (alavancas.length === 0) return "";
  const partes: string[] = [];

  const temCaixa = caixaLiberavel > 0;
  const temMargem = margemRecuperavelAno > 0;
  if (temCaixa && temMargem) {
    partes.push(
      `São duas naturezas diferentes somadas: ${reais(caixaLiberavel)} de caixa que volta UMA VEZ, ` +
      `hoje preso no ciclo, e ${reais(margemRecuperavelAno)} de resultado A CADA ANO.`,
    );
  } else if (temCaixa) {
    partes.push(`${reais(caixaLiberavel)} de caixa preso no ciclo, que volta uma única vez ao ser liberado.`);
  } else if (temMargem) {
    partes.push(`${reais(margemRecuperavelAno)} de resultado recuperável a cada ano.`);
  }

  // COMO CHEGAR LÁ: as três maiores alavancas viram ação, na ordem do dinheiro.
  const maiores = [...alavancas].sort((x, y) => y.valor - x.valor).slice(0, 3);
  if (maiores.length > 0) {
    const lista = maiores
      .map((a) => `${a.titulo} (${reais(a.valor)}${a.tipo === "margem" ? "/ano" : ""})`)
      .join("; ");
    partes.push(`O que responde pela maior parte: ${lista}. Cada alavanca traz abaixo a conta que a sustenta.`);
  }

  const ref = base.segmento
    ? `Os alvos vêm da mediana das empresas comparáveis de ${base.segmento}`
    : "Os alvos vêm da mediana das empresas comparáveis";
  partes.push(
    `${ref}: é o que empresas do mesmo porte e setor já praticam, não um cenário ideal. ` +
    `Ainda assim é ordem de grandeza para priorizar, não promessa — cada número precisa ser validado contra o contrato e a carteira antes de virar meta.`,
  );

  return partes.join(" ");
}

const MIN_DIAS = 3;        // gap menor que isso é ruído de medição, não alavanca
const MIN_VALOR = 10_000;  // alavanca abaixo de R$ 10 mil não vira manchete
const MIN_GAP_MARGEM = 0.005; // 0,5 ponto percentual

function ordPeriodo(p: string): number {
  const m = p.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return Number(`${m[3]}${m[2]}${m[1]}`);
  const y = p.match(/20\d{2}/);
  return y ? Number(`${y[0]}0000`) : 0;
}

/** R$ em linguagem de gente ("R$ 1,4 milhão", "R$ 320 mil"). */
function reais(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `R$ ${(a / 1_000_000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${a >= 2_000_000 ? "milhões" : "milhão"}`;
  if (a >= 1_000) return `R$ ${Math.round(a / 1_000).toLocaleString("pt-BR")} mil`;
  return `R$ ${Math.round(a).toLocaleString("pt-BR")}`;
}

interface IndLite { nome: string; valores: Record<string, number | string | null> }

/**
 * Calcula as alavancas canônicas. Retorna null quando não há base (sem pares com
 * mediana ou sem receita) — aí o placar volta a ser 100% da IA, declarado como tal.
 */
export function calcularValorCanonico(
  indicadores: IndLite[],
  periodos: string[],
  peerRows: PeerComparisonRow[],
  dre: Array<{ conta: string; valores: Record<string, number> }> | null | undefined,
  base: { segmento: string | null; periodo: string | null },
  /**
   * Períodos de BALANCETE (DRE acumulada no ano) — a MESMA lista que
   * `buildIndicators` recebe. A alavanca tem de sair da MESMA régua de dias que
   * produziu o prazo que a disparou: o PMR de 130 dias da Belagro foi medido
   * sobre 150 dias (YTD de 5 meses), enquanto a venda diária saía de `/365`.
   * O descasamento de 2,4333× publicava R$ 87,3 mi onde a própria régua do
   * relatório dá R$ 212,4 mi — e não reconciliava com o saldo do balanço.
   */
  periodosYTD?: string[],
  /** Colunas que cobrem o EXERCÍCIO INTEIRO — base anual da alavanca de margem.
   *  Inferir "fechado" pela ausência em `periodosYTD` derrubava a base para 2024
   *  (R$ 592,0 mi) quando o fechamento certo era 2025 (R$ 741,1 mi), e podia até
   *  eleger um balancete de JANEIRO a "exercício fechado". */
  periodosFechados?: string[],
): ValorCanonico | null {
  if (!peerRows?.length || !indicadores?.length || !periodos?.length) return null;
  const ord = [...periodos].sort((a, b) => ordPeriodo(a) - ordPeriodo(b));
  const ult = ord[ord.length - 1];
  const ytd = new Set(periodosYTD ?? []);
  // Mesma regra do indicator-calculator: balancete usa a base da SUA periodicidade.
  const diasBase = diasBaseDe(ult, ord, [...ytd]);
  const val = (nome: string): number | null => {
    const v = indicadores.find((i) => i.nome === nome)?.valores?.[ult];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const mediana = (nome: string): number | null => {
    const r = peerRows.find((x) => x.indicador === nome);
    return r && Number.isFinite(r.p50) ? r.p50 : null;
  };

  const receita = val("Receita Líquida");
  if (receita == null || receita <= 0) return null;
  // BASE ANUAL da alavanca de margem. Anualizar a receita parcial por 365/dias
  // pressupõe distribuição UNIFORME — premissa falsa em negócio sazonal: na
  // Belagro, 73% da receita do YTD está em dois dos cinco meses, então os meses
  // restantes não repetem o ritmo. Quando existe exercício FECHADO na série, ele
  // é a base honesta; só na falta dele se recorre à extrapolação (declarada).
  const fechados = new Set(periodosFechados ?? []);
  const anual = (() => {
    for (let i = ord.length - 1; i >= 0; i--) {
      const p = ord[i];
      if (!fechados.has(p)) continue;                 // prova POSITIVA de exercício
      const v = indicadores.find((x) => x.nome === "Receita Líquida")?.valores?.[p];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return { receita: v, periodo: p, extrapolada: false };
    }
    return { receita: receita * (365 / (diasBase || 365)), periodo: ult, extrapolada: true };
  })();
  const receitaDia = receita / diasBase;
  // Custo diário de mercadoria (base do estoque e das compras): Custo Operacional da
  // DRE do último período. Sem ele, as alavancas de estoque/fornecedores não disparam.
  const custoOp = dre?.find((l) => l.conta === "Custo Operacional")?.valores?.[ult];
  const custoDia = typeof custoOp === "number" && custoOp !== 0 ? Math.abs(custoOp) / diasBase : null;

  const alavancas: AlavancaValor[] = [];
  const dias = (n: number) => Math.round(n).toLocaleString("pt-BR");

  // 1) Prazo de RECEBIMENTO acima da mediana (menor é melhor) → caixa preso nos clientes.
  {
    const pmr = val("Prazo Médio Contas a Receber"), p50 = mediana("Prazo Médio Contas a Receber");
    if (pmr != null && p50 != null && pmr - p50 >= MIN_DIAS) {
      const delta = pmr - p50;
      const valor = Math.round(delta * receitaDia);
      if (valor >= MIN_VALOR) alavancas.push({
        origem: "motor", tipo: "caixa", valor,
        titulo: "Receber dos clientes no prazo do setor",
        memoria: `A empresa recebe em ${dias(pmr)} dias; a mediana dos concorrentes recebe em ${dias(p50)}. Cada dia de venda parada nos clientes vale ${reais(receitaDia)} — encurtar os ${dias(delta)} dias de excesso libera cerca de ${reais(valor)} de caixa, uma única vez.`,
      });
    }
  }
  // 2) ESTOQUE acima da mediana (menor é melhor) → caixa parado na prateleira.
  {
    const pme = val("Prazo Médio Estoque"), p50 = mediana("Prazo Médio Estoque");
    if (pme != null && p50 != null && custoDia != null && pme - p50 >= MIN_DIAS) {
      const delta = pme - p50;
      const valor = Math.round(delta * custoDia);
      if (valor >= MIN_VALOR) alavancas.push({
        origem: "motor", tipo: "caixa", valor,
        titulo: "Girar o estoque no ritmo do setor",
        memoria: `A mercadoria fica ${dias(pme)} dias parada; nos concorrentes, ${dias(p50)}. Ao custo diário de compras de ${reais(custoDia)}, reduzir os ${dias(delta)} dias de excesso libera cerca de ${reais(valor)} de caixa.`,
      });
    }
  }
  // 3) Prazo de PAGAMENTO abaixo da mediana (maior é melhor) → financiamento gratuito não usado.
  {
    const pmp = val("Prazo Médio Fornecedores"), p50 = mediana("Prazo Médio Fornecedores");
    if (pmp != null && p50 != null && custoDia != null && p50 - pmp >= MIN_DIAS) {
      const delta = p50 - pmp;
      const valor = Math.round(delta * custoDia);
      if (valor >= MIN_VALOR) alavancas.push({
        origem: "motor", tipo: "caixa", valor,
        titulo: "Pagar fornecedores no prazo que o setor pratica",
        memoria: `A empresa paga em ${dias(pmp)} dias; a mediana do setor consegue ${dias(p50)}. Alongar os ${dias(delta)} dias que faltam, com compras diárias de ${reais(custoDia)}, mantém no caixa cerca de ${reais(valor)}.`,
      });
    }
  }
  // 4) MARGEM EBITDA abaixo da mediana (maior é melhor) → resultado anual recuperável.
  {
    const mg = val("Margem EBITDA"), p50 = mediana("Margem EBITDA");
    if (mg != null && p50 != null && p50 - mg >= MIN_GAP_MARGEM) {
      const gap = p50 - mg;
      const valor = Math.round(gap * anual.receita);
      if (valor >= MIN_VALOR) alavancas.push({
        origem: "motor", tipo: "margem", valor,
        titulo: "Levar a margem operacional à mediana do setor",
        memoria: `A margem EBITDA é de ${(mg * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% contra ${(p50 * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% na mediana dos concorrentes. Fechar essa diferença sobre a receita de ${reais(anual.receita)}${anual.extrapolada ? ` (extrapolada dos ${reais(receita)} medidos em ${diasBase} dias — não há exercício fechado na série)` : ` do exercício fechado em ${anual.periodo}`} recupera cerca de ${reais(valor)} de resultado por ano — direcional, a validar na árvore de custos.`,
      });
    }
  }

  const caixaLiberavel = alavancas.filter((a) => a.tipo === "caixa").reduce((s, a) => s + a.valor, 0);
  const margemRecuperavelAno = alavancas.filter((a) => a.tipo === "margem").reduce((s, a) => s + a.valor, 0);
  return {
    caixaLiberavel,
    margemRecuperavelAno,
    total: caixaLiberavel + margemRecuperavelAno,
    alavancas,
    base,
    leitura: leituraDoValor(caixaLiberavel, margemRecuperavelAno, alavancas, base),
  };
}
