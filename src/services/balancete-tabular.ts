/**
 * BALANCETE TABULAR (CSV/XLSX) — 2026-07-31.
 *
 * Segunda VIA DE ENTRADA do balancete, ao lado do PDF. O contrato é o mesmo:
 * devolve `BalanceteParseado`, então conversão, provas de fechamento e fold
 * seguem IDÊNTICOS (nada do caminho PDF é tocado — regra "sem retrocesso").
 *
 * Por que um parser próprio em vez de reaproveitar o de texto: no PDF a
 * estrutura precisa ser INFERIDA do layout (posição, colunas coladas, tokens
 * monetários). Na planilha ela é DECLARADA no cabeçalho — as colunas têm nome.
 * Ler a declaração é mais fiel do que re-serializar a planilha em texto para
 * então adivinhá-la de novo.
 *
 * Formato dominado (corpus Belagro/Domínio):
 *   Balancete Consolidado de 01/04/2026 a 30/04/2026
 *   Conta;Classificação;Nome da conta contábil;Saldo anterior;Débito;Crédito;Saldo atual
 *   86;01.1.1.02.002;Caixa Econômica Federal - C/C ...;691,21;32.270,00;32.850,19;111,02
 * Negativo entre parênteses ("(188.484,06)") e natureza NÃO declarada — quem
 * decide o sinal é a equação do próprio documento (balancete-conversao).
 */
import * as XLSX from "xlsx";
import type { BalanceteParseado, LinhaBalancete } from "./balancete-parser";

/** Matriz de células como vem da planilha (linha → colunas), já como texto. */
export type Matriz = string[][];

const norm = (s: string): string =>
  (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

/** Colapsa nomes com letras espaçadas ("A T I V O" → "ATIVO") — praxe do Tango. */
const normalizarNome = (nome: string): string => {
  const s = (nome ?? "").trim().replace(/\s{2,}/g, " ");
  if (/^(?:[A-ZÀ-Ú] )+[A-ZÀ-Ú]$/.test(s)) return s.replace(/ /g, "");
  return s;
};

const ultimoDia = (mes: number, ano: number): number => new Date(ano, mes, 0).getDate();

/** Competência do documento → período de fallback quando a planilha não declara
 *  o próprio ("2022" → 01/01..31/12/2022; "2026-06" → mês; "a..b" → intervalo). */
export function periodoDaCompetencia(comp?: string | null): { inicio: string; fim: string } | null {
  const c = (comp ?? "").trim();
  let m = c.match(/^(\d{4})$/);
  if (m) return { inicio: `01/01/${m[1]}`, fim: `31/12/${m[1]}` };
  m = c.match(/^(\d{4})-(\d{2})$/);
  if (m) return { inicio: `01/${m[2]}/${m[1]}`, fim: `${String(ultimoDia(Number(m[2]), Number(m[1]))).padStart(2, "0")}/${m[2]}/${m[1]}` };
  m = c.match(/^(\d{4})-(\d{2})\.\.(\d{4})-(\d{2})$/);
  if (m) return { inicio: `01/${m[2]}/${m[1]}`, fim: `${String(ultimoDia(Number(m[4]), Number(m[3]))).padStart(2, "0")}/${m[4]}/${m[3]}` };
  return null;
}

/** Período declarado no cabeçalho da planilha ("de 01/04/2026 a 30/04/2026"). */
function periodoDaMatriz(m: Matriz): { inicio: string | null; fim: string | null } {
  const cab = m.slice(0, 12).map((l) => l.join(" ")).join(" ");
  let x = cab.match(/(\d{2}\/\d{2}\/\d{4})\s*(?:a|à|-|ate|até)\s*(\d{2}\/\d{2}\/\d{4})/i);
  if (x) return { inicio: x[1], fim: x[2] };
  x = cab.match(/(\d{2})\/(\d{4})\s*(?:a|à|-)\s*(\d{2})\/(\d{4})/);
  if (x) {
    const [, m1, a1, m2, a2] = x;
    return { inicio: `01/${m1}/${a1}`, fim: `${String(ultimoDia(Number(m2), Number(a2))).padStart(2, "0")}/${m2}/${a2}` };
  }
  return { inicio: null, fim: null };
}

/** Valor pt-BR: "1.234,56", "(1.234,56)" (negativo), "1.234,56 C". Vazio → 0. */
function valorPtBr(raw: string): { valor: number; natureza?: "D" | "C" } {
  const t = (raw ?? "").toString().trim();
  if (!t) return { valor: 0 };
  const natureza = /[DC]$/i.test(t.replace(/\s+$/, "")) ? (t.trim().slice(-1).toUpperCase() as "D" | "C") : undefined;
  let s = t.replace(/\s?[DC]$/i, "").trim();
  let negativo = false;
  if (s.startsWith("(") && s.endsWith(")")) { negativo = true; s = s.slice(1, -1); }
  if (s.startsWith("-")) { negativo = true; s = s.slice(1); }
  s = s.replace(/[R$\s]/g, "");
  // pt-BR: ponto é milhar, vírgula é decimal. Sem vírgula, ponto decimal (en-US) vale.
  const n = s.includes(",") ? parseFloat(s.replace(/\./g, "").replace(",", ".")) : parseFloat(s);
  if (!Number.isFinite(n)) return { valor: 0 };
  return { valor: negativo ? -n : n, natureza };
}

interface Colunas { classificacao: number; nome: number; anterior: number; debito: number; credito: number; atual: number }

/** Acha a linha de cabeçalho e mapeia as colunas PELO NOME (ordem é livre).
 *  `modo` distingue os dois formatos reais do corpus:
 *  - "nomeado": cada dado tem coluna própria (Domínio, EXTRAMED, encerramento);
 *  - "posicional": classificação e nome dividem a MESMA célula e as linhas de
 *    dados não alinham com o cabeçalho (Tango CSV) — o parse vai por padrão. */
function acharColunas(m: Matriz): { linhaCabecalho: number; cols: Colunas; temMovimento: boolean; modo: "nomeado" } | { linhaCabecalho: number; modo: "posicional" } | null {
  for (let i = 0; i < Math.min(m.length, 40); i++) {
    const cels = m[i].map(norm);
    const acha = (re: RegExp): number => cels.findIndex((c) => re.test(c));
    let classificacao = acha(/^classifica|^class\b|^codigo reduzido classifica/);
    const anterior = acha(/saldo ant/);
    const debito = acha(/^debito|^deb\b|^total.*debito|^movimento.*debito/);
    const credito = acha(/^credito|^cred\b|^total.*credito|^movimento.*credito/);
    const atual = acha(/saldo atual|saldo final|^saldo$/);
    // Coluna de MOVIMENTO líquido (encerramento): nunca é lida como valor, mas
    // sua EXISTÊNCIA muda a leitura posicional (4 numéricas podem ser
    // ant·D·C·mov com o atual zerado em branco).
    const temMovimento = acha(/^mov\b|^movimento|mov\s+periodo|movimento do per/) >= 0;
    // Nome: coluna de descrição.
    const nome = acha(/nome da conta|^descricao|^conta contabil|^historico|^nome$/);
    if (anterior < 0 || debito < 0 || credito < 0 || atual < 0) continue;
    // Encerramento: sem "Classificação", a coluna "Conta" carrega a corrida (1, 11, 111…).
    if (classificacao < 0 && nome >= 0) classificacao = acha(/^conta$/);
    if (classificacao >= 0 && nome >= 0) {
      return { linhaCabecalho: i, cols: { classificacao, nome, anterior, debito, credito, atual }, temMovimento, modo: "nomeado" };
    }
    // Tango: tem "Classificação" mas NÃO tem coluna de nome — os dois vêm juntos
    // na mesma célula ("1.01   ATIVO CIRCULANTE") e as linhas não alinham com o
    // cabeçalho. O parse posicional assume.
    if (classificacao >= 0 && nome < 0) return { linhaCabecalho: i, modo: "posicional" };
  }
  return null;
}

/** Valor monetário DECLARADO (tem centavos): "1.234,56", "(1.234,56)", "10,00",
 *  "157849.24", "1,234.56" — mas NUNCA um código de conta ("10000", "1.01"). */
const RE_CELULA_MONETARIA = /^\(?-?(?:\d{1,3}(?:[.,]\d{3})*|\d+)[.,]\d{2}\)?(?:\s?[DC])?$/i;

/** Linha de dados do modo POSICIONAL: célula "classificação + nome" + os valores
 *  monetários à direita dela (ant · débito · crédito · atual). */
function linhaPosicional(linha: string[]): { classificacao: string; nome: string; sintetica?: boolean; valores: string[] } | null {
  const cels = linha.map((c) => (c ?? "").trim());
  const iCls = cels.findIndex((c) => /^S?\d+(?:\.\d+)*\s{2,}\S/.test(c));
  if (iCls < 0) return null;
  const bruta = cels[iCls];
  const m = bruta.match(/^(S?)(\d+(?:\.\d+)*)\s{2,}(.+)$/);
  if (!m) return null;
  const sintetica = m[1] === "S" || cels.some((c) => c === "S") || undefined;
  const valores = cels.slice(iCls + 1).filter((c) => RE_CELULA_MONETARIA.test(c));
  if (valores.length !== 4) return null; // ant · D · C · atual — fora disso não é linha de conta
  return { classificacao: m[2], nome: normalizarNome(m[3]), sintetica, valores };
}

/**
 * A matriz É um balancete? Assinatura ESTRUTURAL (cabeçalho com classificação +
 * saldo anterior/débito/crédito/saldo atual e linhas de conta abaixo) — nunca o
 * nome do arquivo. Espelha `pareceBalancete` do caminho PDF.
 */
export function pareceBalanceteTabular(m: Matriz): { balancete: boolean; evidencias: string[] } {
  const evidencias: string[] = [];
  const cab = m.slice(0, 14).map((l) => l.join(" ")).join(" ").toLowerCase();
  if (/balancete/.test(cab)) evidencias.push("título 'balancete' no cabeçalho da planilha");
  const achado = acharColunas(m);
  if (achado) evidencias.push("colunas Classificação · Saldo anterior · Débito · Crédito · Saldo atual");
  let contas = 0;
  if (achado) {
    for (let i = achado.linhaCabecalho + 1; i < m.length; i++) {
      if (achado.modo === "nomeado") {
        const cls = (m[i]?.[achado.cols.classificacao] ?? "").trim();
        if (/^\d+(\.\d+)*$/.test(cls)) contas++;
      } else if (linhaPosicional(m[i] ?? [])) contas++;
    }
    if (contas >= 10) evidencias.push(`${contas} linhas de conta com classificação hierárquica`);
  }
  return { balancete: !!achado && contas >= 10, evidencias };
}

/**
 * Parser tabular: matriz → BalanceteParseado (mesmo contrato do PDF).
 * Best-effort no mesmo espírito: o que não reconhece vira aviso, nunca exceção.
 */
export function parseBalanceteMatriz(m: Matriz, periodoFallback?: { inicio: string; fim: string } | null): BalanceteParseado {
  const avisos: string[] = [];
  let { inicio, fim } = periodoDaMatriz(m);
  if (!fim && periodoFallback) {
    // A planilha não declara o período (EXTRAMED) — vale a COMPETÊNCIA do
    // documento, informada no upload/curadoria. Transparência via aviso.
    ({ inicio, fim } = periodoFallback);
    avisos.push(`Período assumido pela competência do documento (${inicio} a ${fim}) — a planilha não o declara.`);
  }
  if (!fim) avisos.push("Período do cabeçalho não identificado.");

  const achado = acharColunas(m);
  if (!achado) {
    avisos.push("Cabeçalho de balancete não encontrado na planilha (esperado: Classificação · Saldo anterior · Débito · Crédito · Saldo atual).");
    return { periodoInicio: inicio, periodoFim: fim, ordemColunas: "ant-d-c-atual", linhas: [], avisos };
  }

  interface Crua { classificacao: string; nome: string; sintetica?: boolean; ant: ReturnType<typeof valorPtBr>; deb: ReturnType<typeof valorPtBr>; cred: ReturnType<typeof valorPtBr>; atual: ReturnType<typeof valorPtBr> }
  const cruas: Crua[] = [];
  let totais: { debito: number; credito: number } | undefined;

  for (let i = achado.linhaCabecalho + 1; i < m.length; i++) {
    const linha = m[i] ?? [];
    const juntada = norm(linha.join(" "));
    if (achado.modo === "posicional") {
      const p = linhaPosicional(linha);
      if (!p) continue;
      const [a, d, c, s] = p.valores.map(valorPtBr);
      cruas.push({ classificacao: p.classificacao, nome: p.nome, sintetica: p.sintetica, ant: a, deb: d, cred: c, atual: s });
      continue;
    }
    const { cols } = achado;
    const cls = (linha[cols.classificacao] ?? "").toString().trim();
    let nome = normalizarNome((linha[cols.nome] ?? "").toString());
    // Linha de TOTAIS declarados ("Total de débitos … créditos …") — vira prova.
    if (/tota(l|is) (de |dos )?debitos?/.test(juntada) && !cls) {
      const d = valorPtBr(linha[cols.debito] ?? ""), c = valorPtBr(linha[cols.credito] ?? "");
      if (d.valor || c.valor) totais = { debito: Math.abs(d.valor), credito: Math.abs(c.valor) };
      continue;
    }
    // Conta = classificação hierárquica ("01.1.1.02.002") ou corrida ("11101") + nome.
    if (!/^\d+(\.\d+)*$/.test(cls)) continue;
    let vAnt = (linha[cols.anterior] ?? "").toString().trim();
    let vDeb = (linha[cols.debito] ?? "").toString().trim();
    let vCred = (linha[cols.credito] ?? "").toString().trim();
    let vAtual = (linha[cols.atual] ?? "").toString().trim();
    // LINHA DESALINHADA (caso CADMO/CAHYVA): a planilha INDENTA por coluna — o
    // nome (e parte dos valores) anda para a direita conforme a profundidade,
    // então os índices do cabeçalho não valem para os dados (às vezes SÓ UMA
    // coluna desanda — nas raízes do CADMO o Saldo Anterior fica 4 colunas à
    // direita e as demais batem). E no encerramento o saldo zerado vem como
    // célula VAZIA, que não é desalinhamento. Entre as leituras possíveis,
    // quem decide é a EQUAÇÃO da própria linha (ant ± movimento = atual):
    //   1. exata pelos índices do cabeçalho (vazias = 0);
    //   2. posicional [ant · D · C · atual] à direita do nome;
    //   3. posicional com movimento e atual em branco [ant · D · C · mov] —
    //      só quando o cabeçalho tem coluna de movimento.
    // A primeira que fecha vale; nenhuma fechando, fica a exata (o P3 acusa).
    const fecha = (q: [string, string, string, string]): boolean => {
      const [a, d, c, s] = q.map(valorPtBr);
      const D = Math.abs(d.valor), C = Math.abs(c.valor);
      if (a.natureza && s.natureza) {
        const antS = (a.natureza === "C" ? -1 : 1) * Math.abs(a.valor);
        const atualS = (s.natureza === "C" ? -1 : 1) * Math.abs(s.valor);
        return Math.abs(antS + D - C - atualS) <= 0.005;
      }
      return Math.abs(a.valor + D - C - s.valor) <= 0.005 || Math.abs(a.valor + C - D - s.valor) <= 0.005;
    };
    const candidatas: Array<{ q: [string, string, string, string]; nomeDe: string }> = [];
    if (nome) candidatas.push({ q: [vAnt, vDeb, vCred, vAtual], nomeDe: nome });
    const aDireita = linha.slice(cols.classificacao + 1).map((c) => (c ?? "").toString().trim());
    const iNome = aDireita.findIndex((c) => c && !/^\(?-?\d+([.,]\d+)*\)?(?:\s?[DC])?$/i.test(c));
    if (iNome >= 0) {
      const nomePos = normalizarNome(aDireita[iNome]);
      const numericas = aDireita.slice(iNome + 1).filter((c) => /^\(?-?(?:\d{1,3}(?:[.,]\d{3})*|\d+)(?:[.,]\d+)?\)?(?:\s?[DC])?$/i.test(c) && c !== "");
      if (numericas.length >= 5) candidatas.push({ q: [numericas[0], numericas[1], numericas[2], numericas[4]], nomeDe: nomePos });
      else if (numericas.length === 4) {
        candidatas.push({ q: [numericas[0], numericas[1], numericas[2], numericas[3]], nomeDe: nomePos });
        if (achado.temMovimento) candidatas.push({ q: [numericas[0], numericas[1], numericas[2], ""], nomeDe: nomePos });
      }
    }
    if (candidatas.length === 0) continue;
    const vencedora = candidatas.find((cand) => fecha(cand.q)) ?? candidatas[0];
    nome = vencedora.nomeDe;
    [vAnt, vDeb, vCred, vAtual] = vencedora.q;
    if (!nome) continue;
    cruas.push({
      classificacao: cls, nome,
      ant: valorPtBr(vAnt),
      deb: valorPtBr(vDeb),
      cred: valorPtBr(vCred),
      atual: valorPtBr(vAtual),
    });
  }

  // Nível: pontilhada = profundidade por pontos. Documento TODO corrido (nenhum
  // ponto — encerramento: 1, 11, 111, 1111…) = níveis pelos COMPRIMENTOS únicos
  // ordenados, como no parser de PDF (Pryor/Sage).
  const todoCorrido = cruas.length > 0 && cruas.every((c) => !c.classificacao.includes("."));
  const comprimentos = todoCorrido ? [...new Set(cruas.map((c) => c.classificacao.length))].sort((a, b) => a - b) : [];
  const nivelDe = (cls: string): number => {
    if (!todoCorrido) return cls.split(".").length;
    const idx = comprimentos.indexOf(cls.length);
    return idx >= 0 ? idx + 1 : Math.max(1, Math.ceil(cls.length / 2));
  };

  const linhas: LinhaBalancete[] = cruas.map((c) => ({
    classificacao: c.classificacao,
    nivel: nivelDe(c.classificacao),
    nome: c.nome,
    sintetica: c.sintetica,
    saldoAnterior: c.ant.valor,
    naturezaAnterior: c.ant.natureza,
    debito: Math.abs(c.deb.valor),
    credito: Math.abs(c.cred.valor),
    saldoAtual: c.atual.valor,
    naturezaAtual: c.atual.natureza,
  }));
  if (linhas.length === 0) avisos.push("Nenhuma linha de conta encontrada abaixo do cabeçalho.");

  return { periodoInicio: inicio, periodoFim: fim, ordemColunas: "ant-d-c-atual", linhas, totais, avisos };
}

// ── leitura dos arquivos ─────────────────────────────────────────────────────

/** Separador do CSV: o candidato que mais divide as primeiras linhas. */
function separadorCSV(texto: string): string {
  const amostra = texto.split(/\r?\n/).slice(0, 30);
  let melhor = ";", melhorScore = -1;
  for (const sep of [";", ",", "\t", "|"]) {
    const score = amostra.reduce((s, l) => s + (l.split(sep).length - 1), 0);
    if (score > melhorScore) { melhorScore = score; melhor = sep; }
  }
  return melhor;
}

/** Decodifica CSV respeitando o acento: UTF-8 (com/sem BOM) ou Windows-1252.
 *  O ERP brasileiro exporta em ANSI — decodificar como UTF-8 quebraria os nomes
 *  das contas ("Poupança" → "Poupan�a") e o dicionário nunca casaria. */
function decodificarCSV(buffer: Buffer): string {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.toString("utf8").slice(1);
  const comoUtf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  if (!comoUtf8.includes("�")) return comoUtf8;
  return new TextDecoder("windows-1252").decode(buffer);
}

/** CSV → matriz (respeita campo entre aspas com separador dentro). */
export function csvParaMatriz(buffer: Buffer): Matriz {
  const texto = decodificarCSV(buffer);
  const sep = separadorCSV(texto);
  const linhas: Matriz = [];
  for (const bruta of texto.split(/\r?\n/)) {
    const cels: string[] = [];
    let atual = "", dentroAspas = false;
    for (let i = 0; i < bruta.length; i++) {
      const c = bruta[i];
      if (dentroAspas) {
        if (c === '"' && bruta[i + 1] === '"') { atual += '"'; i++; }
        else if (c === '"') dentroAspas = false;
        else atual += c;
      } else if (c === '"') dentroAspas = true;
      else if (c === sep) { cels.push(atual); atual = ""; }
      else atual += c;
    }
    cels.push(atual);
    linhas.push(cels.map((c) => c.trim()));
  }
  return linhas;
}

/** Célula → texto para a matriz. Célula NUMÉRICA usa o VALOR CRU (ponto decimal,
 *  imune a locale): o mesmo arquivo real (EXTRAMED) mistura texto pt-BR
 *  ("31.816.189,57D") com número formatado en-US (" 143,466,683.75 ") na MESMA
 *  linha — ler o texto formatado corrompia os movimentos. Datas ficam com o
 *  texto formatado (o período é reconhecido por dd/mm/aaaa). */
function celulaTexto(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  if (cell.t === "n") {
    const w = (cell.w ?? "").toString();
    if (/[/]/.test(w)) return w.trim(); // formatada como data
    return String(cell.v ?? "");
  }
  return String(cell.w ?? cell.v ?? "").trim();
}

/** Aba → matriz com controle por célula (ver celulaTexto). */
function abaParaMatriz(ws: XLSX.WorkSheet | undefined): Matriz {
  const ref = ws?.["!ref"];
  if (!ws || !ref) return [];
  const r = XLSX.utils.decode_range(ref);
  const m: Matriz = [];
  for (let R = r.s.r; R <= r.e.r; R++) {
    const linha: string[] = [];
    for (let C = r.s.c; C <= r.e.c; C++) {
      linha.push(celulaTexto(ws[XLSX.utils.encode_cell({ r: R, c: C })] as XLSX.CellObject | undefined));
    }
    m.push(linha);
  }
  return m;
}

/** XLSX/XLS → matriz da aba que PARECE balancete (senão, a primeira). Quando a
 *  lib devolve TUDO vazio num .xls íntegro (caso CADMO/CAHYVA — BIFF8 com
 *  células no stream que o SheetJS 0.18 não materializa), entra o leitor BIFF
 *  mínimo próprio. */
export function xlsxParaMatriz(buffer: Buffer): Matriz {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  let melhor: Matriz = [];
  for (const nomeAba of wb.SheetNames) {
    const m = abaParaMatriz(wb.Sheets[nomeAba]);
    if (!melhor.length) melhor = m;
    if (pareceBalanceteTabular(m).balancete) return m;
  }
  if (melhor.length === 0) {
    const { biffParaMatriz } = require("./biff-fallback") as typeof import("./biff-fallback");
    const biff = biffParaMatriz(buffer);
    if (biff) return biff;
  }
  return melhor;
}

/** Extensões aceitas nesta via (o PDF continua no caminho de texto). */
export const ehArquivoTabular = (nome: string): boolean => /\.(csv|xlsx|xlsm|xls)$/i.test(nome ?? "");

/** Ponto de entrada: arquivo tabular → BalanceteParseado. `competencia` (do
 *  documento) vira o período quando a planilha não declara o próprio. */
export function parseBalanceteTabular(buffer: Buffer, nome: string, competencia?: string | null): BalanceteParseado {
  const matriz = /\.csv$/i.test(nome) ? csvParaMatriz(buffer) : xlsxParaMatriz(buffer);
  return parseBalanceteMatriz(matriz, periodoDaCompetencia(competencia));
}
