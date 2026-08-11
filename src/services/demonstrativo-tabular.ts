/**
 * DEMONSTRATIVO EM PLANILHA (11/08/2026) — balanço e DRE em .xlsx/.xls/.csv.
 *
 * POR QUÊ: o balancete em planilha sempre foi lido bem (`balancete-tabular.ts`,
 * 12/12 no corpus — é o que alimenta o orçamento da Belagro). Balanço e DRE em
 * planilha caíam no parser genérico e vinham LIXO: medido no acervo real, 6 de
 * 10 arquivos rendiam ZERO linha, "Nota" virava nome de período e o Ativo Total
 * saía `{"Nota": 47473}`. Sem linhas, o degrau de IA recebe texto vazio e a
 * visão nem existe para planilha — era o formato sem nenhuma rede.
 *
 * ESTE LEITOR É DETERMINÍSTICO (zero IA) e reusa a máquina que já funciona:
 * decodificação de CSV (separador/encoding), matriz do xlsx com fallback BIFF e
 * número pt-BR. O que ele acrescenta é o que o demonstrativo tem de próprio:
 *
 *  1. COLUNAS DE PERÍODO pelo cabeçalho — "2024", "dez./2023", "31/12/2022" e
 *     o serial de data do Excel (45291 → 31/12/2023), que era o que fazia
 *     "Nota" virar período;
 *  2. HIERARQUIA POR POSIÇÃO DE COLUNA — no padrão das notas explicativas a
 *     conta anda para a DIREITA conforme desce ("Ativo" col 0, "Ativo
 *     circulante" col 1, "Disponível" col 2, "Caixa e bancos" col 3);
 *  3. HIERARQUIA POR ESPAÇOS à esquerda, quando nome e níveis dividem a mesma
 *     célula (padrão dos sistemas contábeis que exportam CSV);
 *  4. BALANÇO DE DUAS COLUNAS lado a lado — ativo à esquerda, passivo à
 *     direita NA MESMA LINHA (caso Tango). Lido como dois blocos, senão metade
 *     do balanço some.
 *
 * A saída é `ExtractedRow[]` com `indent` — exatamente o que as árvores
 * determinísticas de BP e DRE consomem. Quem prova o resultado é a cascata
 * (total impresso, Ativo=Passivo, conservação de valor).
 */
import * as XLSX from "xlsx";
import type { ExtractedRow } from "./parser";
import { type Matriz, csvParaMatriz, ehArquivoTabular } from "./balancete-tabular";

export interface DemonstrativoTabular {
  linhas: ExtractedRow[];
  periodos: string[];
  /** Texto indentado equivalente — alimenta o construtor de árvore do BP. */
  raw: string;
  avisos: string[];
}

const QUEBRA = String.fromCharCode(10);

const norm = (s: string): string =>
  (s ?? "").toString().normalize("NFKD").replace(/[̀-ͯ]/g, "").trim();

const MESES: Record<string, string> = {
  jan: "01", fev: "02", mar: "03", abr: "04", mai: "05", jun: "06",
  jul: "07", ago: "08", set: "09", out: "10", nov: "11", dez: "12",
};

/**
 * A célula é rótulo de PERÍODO? Devolve a forma canônica ("31/12/2023") ou null.
 * Reconhece: data cheia, "dez./2023", "2023", e o serial do Excel.
 */
export function periodoDaCelula(raw: string): string | null {
  const t = norm(raw).replace(/\s+/g, " ");
  if (!t) return null;
  // Data com barra: a planilha traz tanto "31/12/2022" (pt-BR) quanto
  // "12/31/23" (o Excel en-US formata assim, e foi o que quebrou a leitura do
  // Centauro). Quem manda é o componente > 12; empate fica em DD/MM (pt-BR).
  const barra = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (barra) {
    const a = Number(barra[1]), b = Number(barra[2]);
    const anoTxt = barra[3]!;
    const ano = anoTxt.length === 2 ? `20${anoTxt}` : anoTxt;
    const [dia, mes] = a > 12 ? [a, b] : b > 12 ? [b, a] : [a, b];
    if (mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31) {
      return `${String(dia).padStart(2, "0")}/${String(mes).padStart(2, "0")}/${ano}`;
    }
  }
  const mesAno = t.toLowerCase().match(/\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z.]*[\/\s-]*(\d{2,4})\b/);
  if (mesAno) {
    const ano = mesAno[2]!.length === 2 ? `20${mesAno[2]}` : mesAno[2]!;
    const mes = MESES[mesAno[1]!]!;
    const ultimo = new Date(Number(ano), Number(mes), 0).getDate();
    return `${ultimo}/${mes}/${ano}`;
  }
  // Ano puro — só quando a célula é SÓ o ano (senão "1439 TANGO" viraria período).
  const ano = t.match(/^(19|20)\d{2}$/);
  if (ano) return `31/12/${t}`;
  // Número solto NÃO vira data: o serial do Excel chega formatado (a matriz já
  // devolve "12/31/23"). Interpretar número cru como serial fazia VALOR virar
  // período — "30929" virava 04/09/1984 e o cabeçalho ia parar numa linha de
  // dados (medido no Centauro, 11/08/2026).
  return null;
}

/** Valor numérico pt-BR de uma célula; null quando não é número. */
export function valorDaCelula(raw: string): number | null {
  const t = norm(raw).replace(/R\$|\s/g, "");
  if (!t || /^[-–—]$/.test(t)) return null;
  let s = t, neg = false;
  if (s.startsWith("(") && s.endsWith(")")) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith("-")) { neg = true; s = s.slice(1); }
  if (!/^[\d.,]+$/.test(s)) return null;
  const n = s.includes(",") ? Number(s.replace(/\./g, "").replace(",", ".")) : Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** Índice da primeira célula com TEXTO (não número, não vazia) — é o "indent"
 *  quando a hierarquia é por posição de coluna. */
function colunaDoNome(linha: string[]): number {
  for (let c = 0; c < linha.length; c++) {
    const t = norm(linha[c] ?? "");
    if (!t) continue;
    if (valorDaCelula(t) !== null) return -1; // linha começa com número: não é nome
    if (/[a-zà-ú]/i.test(t)) return c;
  }
  return -1;
}

/** Período declarado no PREÂMBULO ("Período: 31/12/2022", "Balanço … em
 *  31/12/2022"). É o caso dos CSVs de sistema contábil, que não têm cabeçalho
 *  de colunas — sem isto o leitor devolvia null e o arquivo caía no lixo. */
export function periodoDoPreambulo(m: Matriz): string | null {
  for (const linha of m.slice(0, 20)) {
    const txt = norm((linha ?? []).join(" "));
    if (!txt) continue;
    const rotulado = txt.match(/per[ií]odo\s*:?\s*(?:\d{2}\/\d{2}\/\d{4}\s*(?:a|até|-)\s*)?(\d{2}\/\d{2}\/\d{4})/i);
    if (rotulado) return rotulado[1]!;
    const emData = txt.match(/em\s+(\d{2}\/\d{2}\/\d{4})/i);
    if (emData) return emData[1]!;
    const escrita = txt.match(/(\d{1,2})\s+de\s+([a-zç]+)\s+de\s+(\d{4})/i);
    if (escrita) {
      const mes = MESES[escrita[2]!.slice(0, 3).toLowerCase()];
      if (mes) return `${escrita[1]!.padStart(2, "0")}/${mes}/${escrita[3]}`;
    }
  }
  return null;
}

/** Colunas que CARREGAM VALOR, medidas por densidade — usado quando não há
 *  cabeçalho de período (o balanço de duas colunas tem duas dessas). */
function colunasPorDensidade(m: Matriz, apartirDe: number): number[] {
  const contagem = new Map<number, number>();
  for (let i = apartirDe; i < m.length; i++) {
    (m[i] ?? []).forEach((cel, c) => {
      if (valorDaCelula(cel ?? "") !== null && norm(cel ?? "")) contagem.set(c, (contagem.get(c) ?? 0) + 1);
    });
  }
  const minimo = Math.max(5, Math.floor((m.length - apartirDe) * 0.15));
  return [...contagem.entries()].filter(([, n]) => n >= minimo).map(([c]) => c).sort((a, b) => a - b);
}

interface Cabecalho { linha: number; colunas: Array<{ indice: number; periodo: string }> }

/** Acha a linha de cabeçalho: a que tem MAIS células de período. */
function acharCabecalho(m: Matriz): Cabecalho | null {
  let melhor: Cabecalho | null = null;
  for (let i = 0; i < Math.min(m.length, 25); i++) {
    const colunas: Cabecalho["colunas"] = [];
    (m[i] ?? []).forEach((cel, indice) => {
      const p = periodoDaCelula(cel ?? "");
      if (p) colunas.push({ indice, periodo: p });
    });
    // Período repetido na mesma linha = balanço de 2 colunas (ativo|passivo):
    // a mesma data aparece dos dois lados. Mantém as duas posições.
    if (colunas.length && (!melhor || colunas.length > melhor.colunas.length)) melhor = { linha: i, colunas };
  }
  return melhor;
}

/**
 * Blocos nome→valores de UMA linha, varrendo da esquerda para a direita.
 *
 * Um bloco começa em cada célula de TEXTO DE VERDADE e acumula as colunas de
 * valor que vierem depois dela. Isso resolve os dois formatos com a mesma
 * regra: no demonstrativo vertical a linha tem UM nome e N períodos; no
 * balanço de duas colunas tem DOIS nomes, cada um com o seu valor.
 *
 * Ignora a coluna "Nota" (referência a nota explicativa: "6 e 18", "24", "0") —
 * ela fica ENTRE o nome e os valores e, lida como nome, criava contas
 * fantasmas chamadas "6 e 18" e roubava o valor da conta de verdade.
 */
function blocosDaLinha(
  linha: string[],
  colunasValor: number[],
): Array<{ indent: number; nome: string; valores: Map<number, number> }> {
  const ehNota = (t: string) => /^\d+(\s*e\s*\d+)?$/.test(t.trim());
  const blocos: Array<{ indent: number; nome: string; valores: Map<number, number> }> = [];
  let atual: { indent: number; nome: string; valores: Map<number, number> } | null = null;
  for (let c = 0; c < linha.length; c++) {
    const bruto = (linha[c] ?? "").toString();
    const t = norm(bruto);
    if (colunasValor.includes(c)) {
      const v = valorDaCelula(bruto);
      if (atual && v !== null) atual.valores.set(c, v);
      continue;
    }
    if (!t) continue;
    if (valorDaCelula(bruto) !== null || ehNota(t)) continue; // nota/número solto
    if (!/[a-zà-ú]/i.test(t)) continue;                        // separador, símbolo
    if (atual && atual.valores.size) blocos.push(atual);
    const espacos = bruto.length - bruto.replace(/^\s+/, "").length;
    // NOME COM ACENTO: `norm` serve para COMPARAR, nunca para guardar — o nome
    // vai para a tela e para o dicionário, e "Obrigacoes a pagar" no lugar de
    // "Obrigações a pagar" suja os dois.
    atual = { indent: c * 10 + Math.min(espacos, 40), nome: bruto.trim().replace(/\s{2,}/g, " "), valores: new Map() };
  }
  if (atual && atual.valores.size) blocos.push(atual);
  return blocos;
}

export function parseDemonstrativoMatriz(m: Matriz): DemonstrativoTabular | null {
  // DUAS ESTRATÉGIAS, e vence a que LÊ MAIS CONTA. Escolher por heurística de
  // formato dava erro nos dois sentidos: a data de impressão do cabeçalho
  // ("13/01/2023 14:47") passava por período nos CSVs de sistema, e exigir
  // preâmbulo perdia a planilha com cabeçalho de colunas. Medir é mais barato
  // que adivinhar — as duas leituras são determinísticas e custam nada.
  const porCabecalho = acharCabecalho(m);
  const candidatos: Cabecalho[] = [];
  if (porCabecalho?.colunas.length) candidatos.push(porCabecalho);
  const per = periodoDoPreambulo(m);
  if (per) {
    const primeiraComTexto = m.findIndex((l) => (l ?? []).some((c) => /[a-zà-ú]{4}/i.test(norm(c ?? ""))));
    const cols = colunasPorDensidade(m, Math.max(0, primeiraComTexto));
    if (cols.length) candidatos.push({ linha: Math.max(0, primeiraComTexto - 1), colunas: cols.map((indice) => ({ indice, periodo: per })) });
  }
  if (!candidatos.length) return null;

  let melhor: DemonstrativoTabular | null = null;
  let melhorContas = 0;
  for (const cab of candidatos) {
    const r = lerComCabecalho(m, cab);
    if (!r) continue;
    const contas = r.linhas.filter((l) => Object.values(l.valores).some((v) => v !== 0)).length;
    if (contas > melhorContas) { melhor = r; melhorContas = contas; }
  }
  return melhorContas >= 5 ? melhor : null;
}

/** Leitura com um cabeçalho JÁ decidido (colunas de valor + período de cada). */
function lerComCabecalho(m: Matriz, cab: Cabecalho): DemonstrativoTabular | null {
  const periodos: string[] = [];
  for (const c of cab.colunas) if (!periodos.includes(c.periodo)) periodos.push(c.periodo);
  const colunasValor = cab.colunas.map((c) => c.indice);
  const periodoDaColuna = new Map(cab.colunas.map((c) => [c.indice, c.periodo]));

  const linhas: ExtractedRow[] = [];
  const avisos: string[] = [];
  const linhasTexto: string[] = [];
  for (let i = cab.linha + 1; i < m.length; i++) {
    const bruta = m[i] ?? [];
    if (!bruta.some((c) => norm(c ?? ""))) continue;
    const blocos = blocosDaLinha(bruta, colunasValor);
    if (!blocos.length) {
      // Linha só com nome (grupo sem valor na coluna): entra como estrutura,
      // porque a árvore precisa do nível para pendurar os filhos.
      const cn = colunaDoNome(bruta);
      const nome = cn >= 0 ? (bruta[cn] ?? "").toString().trim().replace(/\s{2,}/g, " ") : "";
      if (nome && nome.length > 2 && !/^(total|soma)\b/i.test(nome)) {
        const cel = (bruta[cn] ?? "").toString();
        const indent = cn * 10 + Math.min(cel.length - cel.replace(/^\s+/, "").length, 40);
        linhas.push({ conta: nome, valores: {}, indent });
        linhasTexto.push(" ".repeat(indent) + nome);
      }
      continue;
    }
    for (const b of blocos) {
      const valores: Record<string, number> = {};
      for (const [col, v] of b.valores) {
        const periodo = periodoDaColuna.get(col) ?? periodos[0]!;
        valores[periodo] = v;
      }
      linhas.push({ conta: b.nome, valores, indent: b.indent });
      const primeiro = [...b.valores.values()][0] ?? 0;
      linhasTexto.push(" ".repeat(b.indent) + b.nome + "  " + primeiro.toLocaleString("pt-BR", { minimumFractionDigits: 2 }));
    }
  }
  if (!linhas.length) return null;
  if (periodos.length > 4) avisos.push(periodos.length + " colunas de período reconhecidas — confira se alguma é nota/referência.");
  return { linhas, periodos, raw: linhasTexto.join(QUEBRA), avisos };
}

/** Célula como texto: data formatada vem pronta ("12/31/23"); número cru vem
 *  como número. Mesma régua do leitor de balancete. */
const celulaTexto = (cell: XLSX.CellObject | undefined): string => {
  if (!cell) return "";
  if (cell.t === "n") {
    const w = (cell.w ?? "").toString();
    return /[/]/.test(w) ? w.trim() : String(cell.v ?? "");
  }
  return String(cell.w ?? cell.v ?? "").trim();
};

/** TODAS as abas viram matriz — planilha de contador costuma ter "BP" e "DRE"
 *  em abas separadas (caso Centauro), e ler só uma perdia metade do arquivo
 *  (era o que fazia o cabeçalho verdadeiro sumir e um "2072" perdido virar
 *  período). */
function abasDaPlanilha(buffer: Buffer): Array<{ aba: string; matriz: Matriz }> {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  return wb.SheetNames.map((aba) => {
    const ws = wb.Sheets[aba];
    const ref = ws?.["!ref"];
    if (!ws || !ref) return { aba, matriz: [] as Matriz };
    const r = XLSX.utils.decode_range(ref);
    const matriz: Matriz = [];
    for (let R = r.s.r; R <= r.e.r; R++) {
      const linha: string[] = [];
      for (let C = r.s.c; C <= r.e.c; C++) linha.push(celulaTexto(ws[XLSX.utils.encode_cell({ r: R, c: C })] as XLSX.CellObject | undefined));
      matriz.push(linha);
    }
    return { aba, matriz };
  });
}

/** Ponto de entrada por arquivo (mesma régua de extensão do balancete). */
export function parseDemonstrativoTabular(buffer: Buffer, nome: string): DemonstrativoTabular | null {
  if (!ehArquivoTabular(nome)) return null;
  if (/\.csv$/i.test(nome)) {
    const m = csvParaMatriz(buffer);
    return m.length ? parseDemonstrativoMatriz(m) : null;
  }
  // Junta o que cada aba rendeu: BP numa, DRE noutra é o padrão do contador.
  const partes = abasDaPlanilha(buffer)
    .map(({ aba, matriz }) => ({ aba, r: matriz.length ? parseDemonstrativoMatriz(matriz) : null }))
    .filter((x): x is { aba: string; r: DemonstrativoTabular } => x.r !== null);
  if (!partes.length) return null;
  if (partes.length === 1) return partes[0]!.r;
  const linhas: ExtractedRow[] = [];
  const periodos: string[] = [];
  const avisos: string[] = [];
  const raw: string[] = [];
  for (const { aba, r } of partes) {
    for (const p of r.periodos) if (!periodos.includes(p)) periodos.push(p);
    // Nome repetido entre abas (ex.: "TOTAL") não pode colidir: a aba entra no
    // contexto, que a árvore usa como caminho.
    for (const l of r.linhas) linhas.push({ ...l, contexto: l.contexto ?? aba });
    raw.push([aba, r.raw].join(QUEBRA));
    avisos.push(...r.avisos);
  }
  return { linhas, periodos, raw: raw.join(QUEBRA), avisos };
}
