// ─────────────────────── Árvore da DRE por INDENTAÇÃO (determinística) ───────────────────────
// Mesma filosofia do bp-tree-indent: o parser já entrega as linhas da DRE com a hierarquia
// (indent) e os subtotais DECLARADOS do documento (Receita Líquida, Lucro Bruto, Lucro
// Líquido). Reconstruímos aqui a MESMA árvore de seções que o LLM produziria (shape do
// foldDRE: DRESecaoItem[]) e os `declarados`, sem nenhuma chamada de IA.
//
// Caso motivador (AOCP, visualizador SPED, 2026-07-27): em produção a cascata caía no
// heurístico, que soma seção-pai E filhos (Receita ~2× a declarada). O híbrido corrigia,
// mas dependia do LLM — e documento herdado/editado chega sem o texto indentado original
// (dadosExtraidosToRaw achata), então qualquer falha de IA deixava o número errado no ar.
// Com a árvore determinística, a família SPED fecha com custo zero e sem IA.
//
// TRAVA "verde só com prova": a árvore só é devolvida se a PARTIÇÃO fechar — a soma de
// TODAS as seções-raiz tem de bater com o Lucro Líquido DECLARADO no documento (ao real,
// tolerância R$ 1) em cada período com dados. Qualquer divergência → null → fluxo LLM
// intacto (zero regressão em documentos que não se encaixam).

import type { ExtractedRow } from "./parser";
import type { ArvoreOriginalDRE, DRESecaoItem } from "./ai-extraction";

const norm = (s: string): string =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Linha de subtotal DECLARADO que a validação confronta (contrato de `declarados`). */
function declaradoCanonico(nome: string): "Receita Líquida" | "Lucro Bruto" | "Lucro Líquido" | null {
  const n = norm(nome);
  if (/^receitas? liquidas?( de vendas)?( do (periodo|exercicio))?$/.test(n)) return "Receita Líquida";
  if (/^(lucro|resultado) bruto( do (periodo|exercicio))?$/.test(n)) return "Lucro Bruto";
  if (/^(lucro|prejuizo|resultado) liquido( do (periodo|exercicio))?$/.test(n)) return "Lucro Líquido";
  if (/^(lucro|prejuizo) (liquido )?do (periodo|exercicio)$/.test(n)) return "Lucro Líquido";
  return null;
}

/** Subtotal ESTRUTURAL da cascata (declarado ou intermediário): não é seção — é transparente
 *  na árvore (os vizinhos re-aninham por indentação sem ele). "resultado\b" NÃO casa plurais
 *  ("RESULTADOS NÃO-OPERACIONAIS" é conta-folha legítima e continua na árvore). */
function ehSubtotalEstrutural(nome: string): boolean {
  if (declaradoCanonico(nome)) return true;
  const n = norm(nome);
  return (
    /^resultado (operacional|financeiro|antes|apos|liquido|do periodo|do exercicio)\b/.test(n) ||
    /^(lucro|prejuizo) (operacional|antes|apos)\b/.test(n) ||
    /^(ebitda|ebit|lajida|lajir|lair)\b/.test(n)
  );
}

interface NoDRE {
  nome: string;
  indent: number;
  valores: Record<string, number>;
  filhos: NoDRE[];
}

const TOLERANCIA = 1; // R$ — mesma régua do bp-tree-indent (prova de fechamento)

function toSecaoItem(no: NoDRE, p: string): DRESecaoItem {
  const item: DRESecaoItem = { nome: no.nome, valor: no.valores[p] ?? 0 };
  if (no.filhos.length) item.filhos = no.filhos.map((f) => toSecaoItem(f, p));
  return item;
}

/**
 * Reconstrói a árvore de seções da DRE + subtotais declarados a partir das LINHAS do parser
 * (indent + valores por período — funciona tanto no parse fresco quanto no cache herdado).
 * Retorna null (→ o chamador cai no LLM) se a prova de partição não fechar.
 */
export function construirArvoreDREporIndentacao(
  linhas: ExtractedRow[],
  periodos: string[]
): { secoes: ArvoreOriginalDRE; declarados: Record<string, Record<string, number>> } | null {
  if (linhas.length < 5) return null;
  // Sem indent numérico em TODAS as linhas não há hierarquia confiável (cache legado).
  if (linhas.some((l) => typeof l.indent !== "number")) return null;

  // 1) Separa subtotais estruturais (declarados/intermediários) das seções/contas.
  const declaradosRows: Array<{ conta: "Receita Líquida" | "Lucro Bruto" | "Lucro Líquido"; valores: Record<string, number> }> = [];
  const secaoRows: NoDRE[] = [];
  for (const l of linhas) {
    if (ehSubtotalEstrutural(l.conta)) {
      const canon = declaradoCanonico(l.conta);
      if (canon && !declaradosRows.some((d) => d.conta === canon)) declaradosRows.push({ conta: canon, valores: l.valores });
      continue; // transparente — filhos re-aninham por indentação
    }
    secaoRows.push({ nome: l.conta, indent: l.indent as number, valores: l.valores, filhos: [] });
  }
  const ll = declaradosRows.find((d) => d.conta === "Lucro Líquido");
  if (!ll) return null; // sem Lucro Líquido declarado não há prova possível

  // 2) Aninha por indentação (stack) — mesmo algoritmo do bp-tree-indent.
  const raiz: NoDRE[] = [];
  const stack: NoDRE[] = [];
  for (const no of secaoRows) {
    while (stack.length && stack[stack.length - 1].indent >= no.indent) stack.pop();
    if (stack.length === 0) raiz.push(no);
    else stack[stack.length - 1].filhos.push(no);
    stack.push(no);
  }
  if (raiz.length < 2) return null; // DRE de 1 seção não é uma cascata crível

  // 3) PROVA por período: Σ seções-raiz = Lucro Líquido declarado (a DRE é uma partição —
  //    receitas positivas, deduções/custos/despesas/IR negativos já vêm com sinal do parser).
  const provaPeriodos = periodos.length ? periodos : Object.keys(ll.valores);
  const periodosProvados: string[] = [];
  for (const p of provaPeriodos) {
    const declarado = ll.valores[p];
    const soma = raiz.reduce((s, no) => s + (no.valores[p] ?? 0), 0);
    if (declarado === undefined) {
      if (Math.abs(soma) > TOLERANCIA) return null; // seções têm valor mas não há LL p/ provar
      continue;
    }
    if (Math.abs(soma - declarado) > TOLERANCIA) return null;
    periodosProvados.push(p);
  }
  if (!periodosProvados.length) return null;

  // 4) Monta as shapes que o pipeline do LLM já consome.
  const secoes: ArvoreOriginalDRE = {};
  const declarados: Record<string, Record<string, number>> = {};
  for (const p of periodosProvados) {
    secoes[p] = raiz.map((no) => toSecaoItem(no, p));
    for (const d of declaradosRows) {
      const v = d.valores[p];
      if (typeof v === "number" && v !== 0) (declarados[p] ??= {})[d.conta] = v;
    }
  }
  return { secoes, declarados };
}
