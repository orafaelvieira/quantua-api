/**
 * FÓRMULA DO EXCEL → ÁRVORE DE DRIVERS (29/07/2026).
 *
 * Pedido do usuário: "preciso que o sistema reconheça e replique EXATAMENTE o
 * cálculo que estiver na planilha. Ex.: ((Volume de Vendas × Ticket Médio) ×
 * % da Empresa) × (1 − Impostos). O sistema vai criar exatamente assim quando
 * receber a planilha, criando as variáveis Volume de Vendas, Ticket Médio,
 * % da Empresa, além de buscar o % de impostos da empresa."
 *
 * A memória de cálculo do analista é uma matriz: cada LINHA é uma variável e
 * cada COLUNA é um mês. A célula de resultado traz a fórmula. Aqui a fórmula
 * vira a `expr` do motor (mesma gramática de `model-engine.ts`), trocando cada
 * referência de célula pelo ID DO NÓ da variável correspondente:
 *
 *     E5*E6*E7*(1-E8)   →   n_volume*n_ticket*n_pctempresa*(1-n_impostos)
 *
 * Regras de tradução (o que não couber devolve `null` — a linha então entra
 * como série de valores, que é o comportamento de sempre; nunca se inventa
 * cálculo):
 *   - referência na COLUNA DO MÊS que está sendo traduzido → o nó da linha;
 *   - referência a uma coluna de mês ANTERIOR → `anterior(no, n)`;
 *   - referência a coluna FIXA (premissa fora da grade de meses) → nó constante;
 *   - números (inclusive percentuais "10%"), + − × ÷ e parênteses;
 *   - função, referência a outra aba, intervalo (A1:B2) e ^ NÃO são suportados.
 */

/** Converte "E" → 4 (0-based); "AA" → 26. */
export function colunaDoRotulo(letras: string): number {
  let n = 0;
  for (const ch of letras.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export interface ContextoFormula {
  /** Coluna (0-based) → mês "YYYY-MM" das colunas que são mês. */
  mesDaColuna: Map<number, string>;
  /** Linha (0-based) → id do nó criado para aquela variável. */
  noDaLinha: Map<number, string>;
  /** Cria (ou reaproveita) um nó CONSTANTE para uma célula fixa fora da grade
   *  de meses — é a premissa que o analista digitou uma vez só. Devolve o id,
   *  ou null quando a célula não tem número. */
  constanteDe: (linha: number, coluna: number) => string | null;
}

/** Só o essencial: uma referência A1 (com ou sem $). */
const RE_TOKEN = /^(\$?[A-Za-z]{1,3}\$?\d{1,7})|^(\d+(?:[.,]\d+)?%?)|^([+\-*/()])|^\s+/;

export interface TraducaoFormula {
  expr: string;
  /** Linhas (0-based) da planilha que a fórmula usou — são os drivers da conta. */
  linhasUsadas: number[];
  /** Células fixas usadas como premissa ("$C$4"). */
  constantes: string[];
}

/**
 * Traduz a fórmula de UMA célula. `colAtual` é a coluna (0-based) da célula que
 * contém a fórmula — é o mês daquela coluna que define o "presente".
 */
export function traduzirFormulaExcel(
  formula: string,
  colAtual: number,
  ctx: ContextoFormula,
): TraducaoFormula | null {
  let resto = String(formula ?? "").trim().replace(/^=+/, "");
  if (!resto) return null;
  // Intervalos, funções, outra aba e potência ficam de fora — melhor cair para
  // "série de valores" do que traduzir errado um cálculo do cliente.
  if (/[:!^;]/.test(resto) || /[A-Za-z_]\s*\(/.test(resto)) return null;

  const partes: string[] = [];
  const linhasUsadas = new Set<number>();
  const constantes: string[] = [];
  let guarda = 0;

  while (resto.length > 0) {
    if (guarda++ > 500) return null;
    const m = RE_TOKEN.exec(resto);
    if (!m) return null;
    const token = m[0];
    resto = resto.slice(token.length);

    if (!token.trim()) continue;                       // espaço
    if (m[3]) { partes.push(m[3]); continue; }         // operador/parêntese

    if (m[2]) {                                        // número (ou percentual)
      const cru = m[2].replace(",", ".");
      const n = cru.endsWith("%") ? Number(cru.slice(0, -1)) / 100 : Number(cru);
      if (!Number.isFinite(n)) return null;
      partes.push(String(n));
      continue;
    }

    // Referência de célula
    const ref = m[1]!.replace(/\$/g, "");
    const mm = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(ref);
    if (!mm) return null;
    const col = colunaDoRotulo(mm[1]!);
    const lin = Number(mm[2]!) - 1;                    // A1 é 1-based

    const no = ctx.noDaLinha.get(lin);
    const mesRef = ctx.mesDaColuna.get(col);
    const mesAtual = ctx.mesDaColuna.get(colAtual);

    if (no && mesRef && mesAtual) {
      if (col === colAtual) { partes.push(no); linhasUsadas.add(lin); continue; }
      // Mês anterior: vira anterior(no, n) — é assim que o motor olha para trás.
      const n = colAtual - col;
      if (n > 0) { partes.push(`anterior(${no}, ${n})`); linhasUsadas.add(lin); continue; }
      return null;                                     // referência ao futuro: não traduz
    }
    if (no && !mesRef) {
      // Linha conhecida, coluna fora da grade de meses: é premissa fixa daquela
      // variável (o analista escreveu o número numa coluna só).
      const idc = ctx.constanteDe(lin, col);
      if (!idc) return null;
      partes.push(idc);
      constantes.push(ref.toUpperCase());
      continue;
    }
    // Célula fora das linhas mapeadas: premissa solta (ex.: $B$2 com a alíquota).
    const idc = ctx.constanteDe(lin, col);
    if (!idc) return null;
    partes.push(idc);
    constantes.push(ref.toUpperCase());
  }

  const expr = partes.join(" ").replace(/\s+/g, " ").trim();
  if (!expr) return null;
  // Sanidade: parênteses equilibrados e nada de operador sobrando na ponta.
  let nivel = 0;
  for (const ch of expr) {
    if (ch === "(") nivel++;
    else if (ch === ")") nivel--;
    if (nivel < 0) return null;
  }
  if (nivel !== 0) return null;
  if (/[+\-*/]$/.test(expr.trim())) return null;
  return { expr, linhasUsadas: [...linhasUsadas], constantes };
}

/** Natureza da variável pelo NOME e pelos valores — decide tipo/unidade do nó
 *  (o motor confere a dimensão: quantidade × preço = R$). */
export function naturezaDoDriver(nome: string, valores: number[]): { tipo: "serie" | "taxa" | "preco"; unidade: "#" | "%" | "R$" | "R$/un" } {
  const s = (nome || "").normalize("NFD").replace(new RegExp("[\\u0300-\\u036f]", "g"), "").toLowerCase();
  const finitos = valores.filter((v) => Number.isFinite(v));
  const todosFracao = finitos.length > 0 && finitos.every((v) => Math.abs(v) <= 1);
  if (/%|percent|aliquota|imposto|taxa|margem|comiss|desconto|churn|share|participac/.test(s) || (todosFracao && finitos.length > 0)) {
    return { tipo: "taxa", unidade: "%" };
  }
  if (/ticket|preco|preço|valor medio|valor unitario|arpu|tarifa/.test(s)) return { tipo: "preco", unidade: "R$/un" };
  if (/volume|quantidade|qtd|unidades|clientes|assinantes|pedidos|atendimentos|toneladas|litros|horas|sacas|cabecas/.test(s)) {
    return { tipo: "serie", unidade: "#" };
  }
  return { tipo: "serie", unidade: "R$" };
}

/** A variável é a alíquota de imposto da empresa? (para puxar do modelo quando
 *  a planilha deixa a linha vazia). */
export function ehVariavelDeImposto(nome: string): boolean {
  const s = (nome || "").normalize("NFD").replace(new RegExp("[\\u0300-\\u036f]", "g"), "").toLowerCase();
  return /imposto|tributo|aliquota|icms|iss|pis|cofins|simples/.test(s);
}
