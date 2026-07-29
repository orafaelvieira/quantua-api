/**
 * MEMÓRIA DE CÁLCULO DO EXCEL → LINHA DE RECEITA COM DRIVERS (29/07/2026).
 *
 * A planilha do analista tem a conta desenhada: uma linha por variável, um mês
 * por coluna e a fórmula na linha do resultado. Aqui essa matriz vira uma linha
 * de receita do motor — cada variável um nó (com os valores mensais que ele
 * digitou) e a fórmula um nó `formula` com a MESMA expressão.
 *
 * O que não traduz não vira palpite: a linha entra como série de valores (o
 * comportamento de sempre) e o motivo volta em `avisos`.
 */
import { lerMes } from "./planilha-contas";
import { traduzirFormulaExcel, naturezaDoDriver, ehVariavelDeImposto, type ContextoFormula } from "./formula-excel";

export interface NoMontado {
  id: string;
  tipo: "serie" | "taxa" | "preco" | "formula";
  nome: string;
  unidade: "#" | "%" | "R$" | "R$/un";
  params: Record<string, unknown>;
}

export interface LinhaReceitaMontada {
  id: string;
  nome: string;
  template: "excel";
  nodeRaiz: string;
  nodes: NoMontado[];
  /** A fórmula original, como estava na planilha — proveniência. */
  formulaOriginal: string;
  /** Nomes das variáveis criadas, na ordem em que a fórmula as usa. */
  variaveis: string[];
  /** A fórmula desconta imposto? (o modelo também calcula na aba Impostos) */
  temFatorImposto: boolean;
}

export interface ResultadoMemoria {
  linhas: LinhaReceitaMontada[];
  avisos: string[];
}

const txt = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());
const numero = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = txt(v).replace(/[R$\s%]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * Lê a aba e monta as linhas de receita que TÊM FÓRMULA.
 *
 * @param linhas    matriz de VALORES (o que o Excel calculou)
 * @param formulas  matriz de FÓRMULAS na mesma forma (célula sem fórmula = null)
 * @param opts.aliquotaImpostos alíquota da empresa (0.0925 = 9,25%) para a
 *        linha de imposto que o analista deixou em branco na planilha.
 */
export function montarReceitasDeMemoria(
  linhas: unknown[][],
  formulas: Array<Array<string | null>> | undefined,
  opts: { anoRef: string; idBase: string; aliquotaImpostos?: number | null },
): ResultadoMemoria {
  const avisos: string[] = [];
  const out: LinhaReceitaMontada[] = [];
  if (!Array.isArray(linhas) || linhas.length === 0 || !formulas) return { linhas: out, avisos };

  // 1) Cabeçalho: a primeira linha com 2+ rótulos de mês manda nas colunas.
  let linhaCab = -1;
  const mesDaColuna = new Map<number, string>();
  for (let r = 0; r < Math.min(linhas.length, 40); r++) {
    const cols = linhas[r] ?? [];
    const achados = new Map<number, string>();
    for (let c = 0; c < cols.length; c++) {
      const m = lerMes(cols[c]);
      if (m) achados.set(c, `${m.ano ?? Number(opts.anoRef)}-${String(m.mes).padStart(2, "0")}`);
    }
    if (achados.size >= 2) { linhaCab = r; for (const [c, m] of achados) mesDaColuna.set(c, m); break; }
  }
  if (linhaCab < 0) return { linhas: out, avisos };

  const primeiraColMes = Math.min(...mesDaColuna.keys());

  // 2) Coluna do NOME: entre as colunas antes dos meses, a que mais tem texto.
  let colNome = -1;
  let melhor = 0;
  for (let c = 0; c < primeiraColMes; c++) {
    let textos = 0;
    for (let r = linhaCab + 1; r < linhas.length; r++) {
      const v = (linhas[r] ?? [])[c];
      if (txt(v) && numero(v) === null) textos++;
    }
    if (textos > melhor) { melhor = textos; colNome = c; }
  }
  if (colNome < 0) return { linhas: out, avisos };

  // 3) As linhas de dados, com valores e fórmulas por mês.
  interface LinhaAba { r: number; nome: string; valores: Record<string, number>; formulaPorCol: Map<number, string> }
  const dados: LinhaAba[] = [];
  for (let r = linhaCab + 1; r < linhas.length; r++) {
    const nome = txt((linhas[r] ?? [])[colNome]);
    if (!nome) continue;
    const valores: Record<string, number> = {};
    const formulaPorCol = new Map<number, string>();
    for (const [c, mes] of mesDaColuna) {
      const n = numero((linhas[r] ?? [])[c]);
      if (n !== null) valores[mes] = n;
      const f = (formulas[r] ?? [])[c];
      if (typeof f === "string" && f.trim()) formulaPorCol.set(c, f.trim());
    }
    dados.push({ r, nome, valores, formulaPorCol });
  }
  const porLinhaExcel = new Map(dados.map((d) => [d.r, d]));

  // 4) Cada linha COM FÓRMULA vira uma linha de receita com drivers.
  let seq = 0;
  for (const alvo of dados) {
    if (alvo.formulaPorCol.size === 0) continue;

    const idLinha = `${opts.idBase}m${seq++}`;
    const nodes: NoMontado[] = [];
    const idPorLinha = new Map<number, string>();
    const constantes = new Map<string, string>();
    const variaveis: string[] = [];

    // Nó de cada variável referenciável (todas as linhas da aba: a fórmula
    // escolhe quais usa; só as usadas entram na árvore no fim).
    for (const d of dados) {
      if (d.r === alvo.r) continue;
      idPorLinha.set(d.r, `${idLinha}_v${d.r}`);
    }

    const ctx: ContextoFormula = {
      mesDaColuna,
      noDaLinha: idPorLinha,
      constanteDe: (lin, col) => {
        const chave = `${lin}:${col}`;
        if (constantes.has(chave)) return constantes.get(chave)!;
        const v = numero((linhas[lin] ?? [])[col]);
        if (v === null) return null;
        const id = `${idLinha}_k${lin}_${col}`;
        constantes.set(chave, id);
        const rotulo = txt((linhas[lin] ?? [])[colNome]) || `Premissa ${String.fromCharCode(65 + col)}${lin + 1}`;
        const nat = naturezaDoDriver(rotulo, [v]);
        nodes.push({ id, tipo: nat.tipo, nome: rotulo, unidade: nat.unidade, params: { valorMensal: v, crescimentoAnual: 0 } });
        return id;
      },
    };

    // Traduz a fórmula: tenta as colunas de mês em ordem — a primeira pode
    // referenciar um mês que está fora da planilha (dez do ano anterior).
    let traducao: ReturnType<typeof traduzirFormulaExcel> = null;
    let formulaUsada = "";
    for (const [c, f] of [...alvo.formulaPorCol].sort((a, b) => a[0] - b[0])) {
      traducao = traduzirFormulaExcel(f, c, ctx);
      if (traducao) { formulaUsada = f; break; }
    }
    if (!traducao) {
      avisos.push(`"${alvo.nome}": não consegui reproduzir a fórmula do Excel (${[...alvo.formulaPorCol.values()][0] ?? "?"}) — a linha entra com os valores calculados.`);
      continue;
    }

    // Nós das variáveis que a fórmula REALMENTE usou.
    let temFatorImposto = false;
    for (const lin of traducao.linhasUsadas) {
      const d = porLinhaExcel.get(lin);
      const id = idPorLinha.get(lin)!;
      if (!d) continue;
      const vals = Object.values(d.valores);
      const nat = naturezaDoDriver(d.nome, vals);
      const ehImposto = ehVariavelDeImposto(d.nome);
      if (ehImposto) temFatorImposto = true;
      // IMPOSTO SEM NÚMERO na planilha: usa a alíquota da EMPRESA (pedido do
      // usuário — "além de buscar o % de impostos da empresa").
      const semValor = vals.length === 0 || vals.every((v) => v === 0);
      if (ehImposto && semValor && typeof opts.aliquotaImpostos === "number" && opts.aliquotaImpostos > 0) {
        nodes.push({ id, tipo: "taxa", nome: d.nome, unidade: "%", params: { valorMensal: opts.aliquotaImpostos, crescimentoAnual: 0 } });
        avisos.push(`"${d.nome}" estava sem número na planilha — usei a alíquota da empresa (${(opts.aliquotaImpostos * 100).toFixed(2)}%).`);
      } else {
        nodes.push({ id, tipo: nat.tipo, nome: d.nome, unidade: nat.unidade, params: { modoPreenchimento: "mes", valores: d.valores, valorMensal: 0, crescimentoAnual: 0 } });
      }
      variaveis.push(d.nome);
    }

    const idRaiz = `${idLinha}_receita`;
    nodes.push({ id: idRaiz, tipo: "formula", nome: `Memória de Cálculo — ${alvo.nome}`, unidade: "R$", params: { expr: traducao.expr } });
    out.push({
      id: idLinha, nome: alvo.nome, template: "excel", nodeRaiz: idRaiz, nodes,
      formulaOriginal: formulaUsada, variaveis, temFatorImposto,
    });
  }

  return { linhas: out, avisos };
}
