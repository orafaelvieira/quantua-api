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
): ValorCanonico | null {
  if (!peerRows?.length || !indicadores?.length || !periodos?.length) return null;
  const ord = [...periodos].sort((a, b) => ordPeriodo(a) - ordPeriodo(b));
  const ult = ord[ord.length - 1];
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
  const receitaDia = receita / 365;
  // Custo diário de mercadoria (base do estoque e das compras): Custo Operacional da
  // DRE do último período. Sem ele, as alavancas de estoque/fornecedores não disparam.
  const custoOp = dre?.find((l) => l.conta === "Custo Operacional")?.valores?.[ult];
  const custoDia = typeof custoOp === "number" && custoOp !== 0 ? Math.abs(custoOp) / 365 : null;

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
      const valor = Math.round(gap * receita);
      if (valor >= MIN_VALOR) alavancas.push({
        origem: "motor", tipo: "margem", valor,
        titulo: "Levar a margem operacional à mediana do setor",
        memoria: `A margem operacional é de ${(mg * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% contra ${(p50 * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% na mediana dos concorrentes. Fechar essa diferença sobre a receita de ${reais(receita)} recupera cerca de ${reais(valor)} de resultado por ano — direcional, a validar na árvore de custos.`,
      });
    }
  }

  const caixaLiberavel = alavancas.filter((a) => a.tipo === "caixa").reduce((s, a) => s + a.valor, 0);
  const margemRecuperavelAno = alavancas.filter((a) => a.tipo === "margem").reduce((s, a) => s + a.valor, 0);
  return { caixaLiberavel, margemRecuperavelAno, total: caixaLiberavel + margemRecuperavelAno, alavancas, base };
}
