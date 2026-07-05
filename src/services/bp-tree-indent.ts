// ─────────────────────────── Árvore do BP por INDENTAÇÃO (determinística) ───────────────────────────
// O parser (parsePDF) preserva a HIERARQUIA do balanço na INDENTAÇÃO (posição x → espaços à
// esquerda). Balanços "Grau 4" de ERP (Fibracabos, SERPRO…) têm um nível intermediário
// (ex.: Passivo Circulante > "EXIGÍVEL A CURTO PRAZO" > 9 contas-folha). O Haiku que montava
// a árvore do BP COLAPSAVA esse nível numa linha só e descartava as filhas — a composição do
// PC ficava vazia e a linha agregada caía em "Outros Passivos Circulantes".
//
// Aqui reconstruímos a MESMA árvore que o LLM deveria produzir, mas de forma DETERMINÍSTICA:
// lê-se `doc.raw` (texto indentado), aninha-se por indentação (stack), e produz-se a shape
// EXATA que o foldBP já consome (ArvoreOriginalBP). A descida nas filhas já funciona (v30);
// só faltava CAPTURAR as filhas — é o que este módulo faz, sem tocar no fold.
//
// TRAVA "verde só com prova": a árvore só é devolvida se for CONFIÁVEL (≥3 níveis de
// indentação, grupos essenciais presentes, Ativo Total ≈ Passivo Total). Caso contrário
// retorna null e o chamador cai no LLM — logo, ZERO regressão em documentos que não se
// encaixam nesta reconstrução.

import type { ParsedDocument } from "./parser";
import { parseBRNumber } from "./parser";
import type { ArvoreOriginalBP, BPN3Item, BPN3Periodo } from "./ai-extraction";

// Normaliza acento/caixa/pontuação para comparar nomes de grupo de forma robusta.
const norm = (s: string): string =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Token de valor no padrão BR: "1.860.814,34", "-156.656,81", "(388.784,45)". SEMPRE com
// os 2 decimais após a vírgula — evita casar códigos de conta ("1.02.03") ou anos ("2020").
const BR_VALOR = /-?\(?[\d.]+,\d{2}\)?/g;

// Mapeia o NOME de um nó de nível-1 do documento para um dos 5 grupos do modelo (chaves de GRP
// em ai-extraction). Aceita com/sem acento e "NAO"/"NÃO". Wrappers de grupo (ex.: "EXIGÍVEL A
// CURTO PRAZO", "CIRCULANTE" solto) NÃO são grupos — o mapeamento acontece nos nós que dizem
// explicitamente ATIVO/PASSIVO + CIRCULANTE, ou PATRIMÔNIO LÍQUIDO.
function grupoDoNome(nomeRaw: string): keyof typeof GRUPO_CANON | null {
  const n = norm(nomeRaw);
  if (/\bpatrimonio liquido\b/.test(n)) return "PL";
  const circulante = /\bcirculante\b/.test(n);
  const naoCirc = /\bnao circulante\b/.test(n);
  if (/\bativo\b/.test(n)) {
    if (naoCirc) return "ANC";
    if (circulante) return "AC";
  }
  if (/\bpassivo\b/.test(n)) {
    if (naoCirc) return "PNC";
    if (circulante) return "PC";
  }
  return null;
}
const GRUPO_CANON = {
  AC: "Ativo Circulante",
  ANC: "Ativo Não Circulante",
  PC: "Passivo Circulante",
  PNC: "Passivo Não Circulante",
  PL: "Patrimônio Líquido",
} as const;

// LADO do documento: "ativo" ou "passivo". O nó-raiz de cada lado é o "ATIVO" / "PASSIVO"
// solto (sem "circulante"/"patrimônio") no topo da respectiva seção — o valor dele é o
// TOTAL DECLARADO daquele lado. Um nó de nível-1 sob "PASSIVO" que NÃO é um dos 5 grupos
// (ex.: "DIFERIDO"/Receitas Diferidas) é passivo-side e não pode ser perdido.
function ladoRaizDoNome(nomeRaw: string): "ativo" | "passivo" | null {
  const n = norm(nomeRaw);
  if (grupoDoNome(nomeRaw)) return null; // é um grupo específico, não o nó-raiz do lado
  if (/\bpatrimonio\b/.test(n)) return null;
  const soAtivo = /^ativo\b/.test(n) && !/passivo/.test(n);
  const soPassivo = /^passivo\b/.test(n) && !/ativo/.test(n);
  if (soAtivo) return "ativo";
  if (soPassivo) return "passivo";
  return null;
}

// Linhas que NÃO são conta: totais do documento e subtotais gerais. São redundantes (o total
// já vem no nó ATIVO/PASSIVO) e, no raw da Fibracabos, aparecem com indentação MAIOR que as
// folhas (13 vs 7) — por isso filtramos por NOME, não por indentação.
const ehLinhaTotal = (nome: string): boolean => /^total d|^subtotal/i.test(nome.trim());

interface NoIndent {
  nome: string;
  indent: number;
  valores: number[]; // um por período/coluna, na ordem do documento
  filhos: NoIndent[];
}

/** Extrai (nome, valores[]) de uma linha indentada. `nCols` = nº de períodos esperados:
 *  pega os `nCols` ÚLTIMOS números da linha (na ordem das colunas). Se a linha não termina
 *  em número, é cabeçalho/rodapé textual → retorna null. */
function parseLinha(linha: string, nCols: number): { nome: string; valores: number[] } | null {
  const semIndent = linha.replace(/\s+$/, "");
  const matches = [...semIndent.matchAll(BR_VALOR)].map((m) => ({ raw: m[0], idx: m.index ?? 0 }));
  if (matches.length === 0) return null;

  // Os valores ficam NO FIM da linha (colunas de período). Pega os últimos `nCols` tokens
  // que sejam realmente numéricos; se houver menos, usa quantos houver (linhas de 1 valor).
  const usar = matches.slice(Math.max(0, matches.length - Math.max(1, nCols)));
  const valores: number[] = [];
  for (const m of usar) {
    const v = parseBRNumber(m.raw);
    if (v === null) return null;
    valores.push(v);
  }
  if (valores.length === 0) return null;

  // O NOME é tudo antes do primeiro token de valor usado (o resto à direita são só números).
  const nome = semIndent.slice(0, usar[0].idx).trim();
  if (!nome) return null;
  return { nome, valores };
}

/** Aninha uma lista de nós por INDENTAÇÃO: cada nó é filho do anterior mais próximo com
 *  indentação MENOR (stack). Retorna os nós de nível 0 (raiz), com `filhos` preenchido. */
function aninharPorIndentacao(nos: NoIndent[]): NoIndent[] {
  const raiz: NoIndent[] = [];
  const stack: NoIndent[] = [];
  for (const no of nos) {
    while (stack.length && stack[stack.length - 1].indent >= no.indent) stack.pop();
    if (stack.length === 0) raiz.push(no);
    else stack[stack.length - 1].filhos.push(no);
    stack.push(no);
  }
  return raiz;
}

/** Converte um NoIndent (multi-período) num BPN3Item de UM período (índice `col`). */
function toBPN3(no: NoIndent, col: number): BPN3Item {
  const valor = no.valores[col] ?? no.valores[0] ?? 0;
  const item: BPN3Item = { nome: no.nome, valor };
  if (no.filhos.length) item.filhos = no.filhos.map((f) => toBPN3(f, col));
  return item;
}

interface GruposDoc {
  /** os 5 grupos do modelo, quando presentes */
  grupos: Partial<Record<keyof typeof GRUPO_CANON, NoIndent>>;
  /** nós-raiz de cada lado ("ATIVO"/"PASSIVO" soltos) — valor = total declarado do lado */
  raizAtivo: NoIndent | null;
  raizPassivo: NoIndent | null;
  /** grupos de nível-1 do lado PASSIVO que não são um dos 5 (ex.: "DIFERIDO") — vão p/ PNC
   *  para que o valor não se perca e o Passivo Total reconcilie */
  orfaosPassivo: NoIndent[];
}

/** Percorre a árvore do documento procurando: os nós-raiz de cada lado (ATIVO/PASSIVO), os
 *  5 grupos do modelo (em qualquer profundidade), e os grupos "órfãos" do lado passivo (nós
 *  irmãos dos 5 grupos, sob PASSIVO, que não mapeiam para nenhum — não podem ser perdidos). */
function coletarGrupos(raiz: NoIndent[]): GruposDoc {
  const grupos: Partial<Record<keyof typeof GRUPO_CANON, NoIndent>> = {};
  let raizAtivo: NoIndent | null = null;
  let raizPassivo: NoIndent | null = null;
  const orfaosPassivo: NoIndent[] = [];

  // `lado` = de qual raiz (ativo/passivo) o nó descende. Herdado do ancestral.
  const visitar = (no: NoIndent, lado: "ativo" | "passivo" | null): void => {
    const g = grupoDoNome(no.nome);
    if (g && !grupos[g]) {
      grupos[g] = no;
      return; // grupo capturado — não desce procurando OUTRO grupo aninhado
    }
    const ladoRaiz = ladoRaizDoNome(no.nome);
    if (ladoRaiz === "ativo" && !raizAtivo) { raizAtivo = no; }
    else if (ladoRaiz === "passivo" && !raizPassivo) { raizPassivo = no; }
    const ladoAtual = ladoRaiz ?? lado;
    // Nó de nível-1 sob PASSIVO que não é grupo nem raiz (ex.: "DIFERIDO"): órfão passivo.
    if (!g && !ladoRaiz && ladoAtual === "passivo" && no.filhos.length > 0 && lado === "passivo") {
      orfaosPassivo.push(no);
      return;
    }
    for (const f of no.filhos) visitar(f, ladoAtual);
  };
  for (const no of raiz) visitar(no, null);
  return { grupos, raizAtivo, raizPassivo, orfaosPassivo };
}

/** Promove wrappers-de-grupo: se um filho direto do grupo tem valor ≈ valor do grupo E tem
 *  filhos próprios, ele é o wrapper "próprio grupo" — some da árvore e seus filhos sobem. */
function filhosDoGrupo(grupo: NoIndent): NoIndent[] {
  const valGrupo = grupo.valores[0] ?? 0;
  const out: NoIndent[] = [];
  for (const f of grupo.filhos) {
    const ehWrapper =
      f.filhos.length > 0 &&
      Math.abs((f.valores[0] ?? 0) - valGrupo) <= Math.max(1, Math.abs(valGrupo) * 0.001) &&
      grupoDoNome(f.nome) === null; // o wrapper NÃO é ele mesmo um grupo do modelo
    if (ehWrapper) out.push(...f.filhos);
    else out.push(f);
  }
  return out;
}

/**
 * Reconstrói a árvore original do BP a partir da INDENTAÇÃO do texto do parser.
 * Retorna null (→ o chamador cai no LLM) se a reconstrução não for CONFIÁVEL.
 *
 * @param doc      documento já parseado (usa `doc.raw`)
 * @param periodos chaves de período na ORDEM das colunas do documento (multi-período)
 */
export function construirArvoreBPporIndentacao(
  doc: ParsedDocument,
  periodos: string[]
): ArvoreOriginalBP | null {
  const raw = doc.raw;
  if (!raw || typeof raw !== "string") return null;

  const cols = periodos.length || 1;

  // 1) Lê linhas → nós (nome + valores + indent), ignorando totais/subtotais gerais.
  const nos: NoIndent[] = [];
  const indentsDistintos = new Set<number>();
  for (const linha of raw.split("\n")) {
    if (!linha.trim()) continue;
    const parsed = parseLinha(linha, cols);
    if (!parsed) continue;
    if (ehLinhaTotal(parsed.nome)) continue;
    const indent = linha.length - linha.trimStart().length;
    indentsDistintos.add(indent);
    nos.push({ nome: parsed.nome, indent, valores: parsed.valores, filhos: [] });
  }

  // Trava (a): a hierarquia precisa de ≥3 níveis de indentação distintos — sem isso não há
  // grau 4 a reconstruir (documento plano cai no LLM).
  if (indentsDistintos.size < 3) return null;

  // 2) Aninha por indentação e localiza os 5 grupos, os nós-raiz de cada lado e órfãos.
  const raiz = aninharPorIndentacao(nos);
  const { grupos, raizAtivo, raizPassivo, orfaosPassivo } = coletarGrupos(raiz);

  // Trava (b): grupos essenciais presentes (AC + PC + PL no mínimo) E os totais DECLARADOS
  // de cada lado (nós-raiz ATIVO/PASSIVO). Sem os nós-raiz não há total confiável → LLM.
  if (!grupos.AC || !grupos.PC || !grupos.PL) return null;
  if (!raizAtivo || !raizPassivo) return null;

  // 3) Monta a shape por período. Totais = valor DECLARADO dos nós-raiz do documento
  //    (ATIVO / PASSIVO) — a prova de fechamento é confrontar esses dois.
  const arvore: ArvoreOriginalBP = {};
  for (let col = 0; col < cols; col++) {
    const p = periodos[col] ?? periodos[0] ?? String(col);
    const cap: BPN3Periodo = { grupos: {}, totais: {} };

    const valCol = (no: NoIndent): number => no.valores[col] ?? no.valores[0] ?? 0;
    for (const key of Object.keys(GRUPO_CANON) as Array<keyof typeof GRUPO_CANON>) {
      const g = grupos[key];
      if (!g) continue;
      cap.grupos[GRUPO_CANON[key]] = filhosDoGrupo(g).map((f) => toBPN3(f, col));
    }
    // Órfãos do lado passivo (ex.: "DIFERIDO"/Receitas Diferidas) → Passivo Não Circulante,
    // preservando a hierarquia interna. Assim nada se perde e o Passivo Total reconcilia.
    if (orfaosPassivo.length) {
      const alvo = (cap.grupos[GRUPO_CANON.PNC] ??= []);
      for (const o of orfaosPassivo) alvo.push(...filhosDoGrupo(o).map((f) => toBPN3(f, col)));
    }

    const ativoTotal = valCol(raizAtivo);
    const passivoTotal = valCol(raizPassivo);
    cap.totais = { "Ativo Total": ativoTotal, "Passivo Total": passivoTotal };

    // Trava (c): Ativo Total ≈ Passivo Total (tolerância R$ 1) para ESTE período. Se não
    // fechar, a captura é suspeita → cai no LLM (sem regressão).
    if (!(ativoTotal > 0) || !(passivoTotal > 0)) return null;
    if (Math.abs(ativoTotal - passivoTotal) > 1) return null;

    arvore[p] = cap;
  }

  return arvore;
}
