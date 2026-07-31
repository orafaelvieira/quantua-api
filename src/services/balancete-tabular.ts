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

const ultimoDia = (mes: number, ano: number): number => new Date(ano, mes, 0).getDate();

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

/** Acha a linha de cabeçalho e mapeia as colunas PELO NOME (ordem é livre). */
function acharColunas(m: Matriz): { linhaCabecalho: number; cols: Colunas } | null {
  for (let i = 0; i < Math.min(m.length, 40); i++) {
    const cels = m[i].map(norm);
    const acha = (re: RegExp): number => cels.findIndex((c) => re.test(c));
    const classificacao = acha(/^classifica|^class\b|^codigo reduzido classifica/);
    const anterior = acha(/saldo ant/);
    const debito = acha(/^debito|^deb\b|^total.*debito|^movimento.*debito/);
    const credito = acha(/^credito|^cred\b|^total.*credito|^movimento.*credito/);
    const atual = acha(/saldo atual|saldo final|^saldo$/);
    // Nome: coluna de descrição; sem ela não há conta.
    const nome = acha(/nome da conta|^descricao|^conta contabil|^historico|^nome$/);
    if (classificacao >= 0 && anterior >= 0 && debito >= 0 && credito >= 0 && atual >= 0 && nome >= 0) {
      return { linhaCabecalho: i, cols: { classificacao, nome, anterior, debito, credito, atual } };
    }
  }
  return null;
}

/**
 * A matriz É um balancete? Assinatura ESTRUTURAL (cabeçalho com classificação +
 * saldo anterior/débito/crédito/saldo atual e linhas de conta abaixo) — nunca o
 * nome do arquivo. Espelha `pareceBalancete` do caminho PDF.
 */
export function pareceBalanceteTabular(m: Matriz): { balancete: boolean; evidencias: string[] } {
  const evidencias: string[] = [];
  const cab = m.slice(0, 12).map((l) => l.join(" ")).join(" ").toLowerCase();
  if (/balancete/.test(cab)) evidencias.push("título 'balancete' no cabeçalho da planilha");
  const achado = acharColunas(m);
  if (achado) evidencias.push("colunas Classificação · Saldo anterior · Débito · Crédito · Saldo atual");
  let contas = 0;
  if (achado) {
    for (let i = achado.linhaCabecalho + 1; i < m.length; i++) {
      const cls = (m[i]?.[achado.cols.classificacao] ?? "").trim();
      if (/^\d+(\.\d+)*$/.test(cls)) contas++;
    }
    if (contas >= 10) evidencias.push(`${contas} linhas de conta com classificação hierárquica`);
  }
  return { balancete: !!achado && contas >= 10, evidencias };
}

/**
 * Parser tabular: matriz → BalanceteParseado (mesmo contrato do PDF).
 * Best-effort no mesmo espírito: o que não reconhece vira aviso, nunca exceção.
 */
export function parseBalanceteMatriz(m: Matriz): BalanceteParseado {
  const avisos: string[] = [];
  const { inicio, fim } = periodoDaMatriz(m);
  if (!fim) avisos.push("Período do cabeçalho não identificado.");

  const achado = acharColunas(m);
  if (!achado) {
    avisos.push("Cabeçalho de balancete não encontrado na planilha (esperado: Classificação · Saldo anterior · Débito · Crédito · Saldo atual).");
    return { periodoInicio: inicio, periodoFim: fim, ordemColunas: "ant-d-c-atual", linhas: [], avisos };
  }
  const { cols } = achado;

  const linhas: LinhaBalancete[] = [];
  let totais: { debito: number; credito: number } | undefined;
  for (let i = achado.linhaCabecalho + 1; i < m.length; i++) {
    const linha = m[i] ?? [];
    const cls = (linha[cols.classificacao] ?? "").toString().trim();
    const nome = (linha[cols.nome] ?? "").toString().trim().replace(/\s{2,}/g, " ");
    // Linha de TOTAIS declarados ("Total de débitos … créditos …") — vira prova.
    const juntada = norm(linha.join(" "));
    if (/tota(l|is) (de |dos )?debitos?/.test(juntada) && !cls) {
      const d = valorPtBr(linha[cols.debito] ?? ""), c = valorPtBr(linha[cols.credito] ?? "");
      if (d.valor || c.valor) totais = { debito: Math.abs(d.valor), credito: Math.abs(c.valor) };
      continue;
    }
    // Conta = classificação hierárquica ("01.1.1.02.002" ou "1") + nome.
    if (!/^\d+(\.\d+)*$/.test(cls) || !nome) continue;
    const ant = valorPtBr(linha[cols.anterior] ?? "");
    const deb = valorPtBr(linha[cols.debito] ?? "");
    const cred = valorPtBr(linha[cols.credito] ?? "");
    const atual = valorPtBr(linha[cols.atual] ?? "");
    linhas.push({
      classificacao: cls,
      nivel: cls.split(".").length,
      nome,
      saldoAnterior: ant.valor,
      naturezaAnterior: ant.natureza,
      debito: Math.abs(deb.valor),
      credito: Math.abs(cred.valor),
      saldoAtual: atual.valor,
      naturezaAtual: atual.natureza,
    });
  }
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

/** XLSX/XLS → matriz da aba que PARECE balancete (senão, a primeira). */
export function xlsxParaMatriz(buffer: Buffer): Matriz {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false, raw: false });
  let melhor: Matriz = [];
  for (const nomeAba of wb.SheetNames) {
    const m = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[nomeAba], { header: 1, raw: false, defval: "" })
      .map((l) => (Array.isArray(l) ? l.map((c) => (c ?? "").toString().trim()) : []));
    if (!melhor.length) melhor = m;
    if (pareceBalanceteTabular(m).balancete) return m;
  }
  return melhor;
}

/** Extensões aceitas nesta via (o PDF continua no caminho de texto). */
export const ehArquivoTabular = (nome: string): boolean => /\.(csv|xlsx|xlsm|xls)$/i.test(nome ?? "");

/** Ponto de entrada: arquivo tabular → BalanceteParseado. */
export function parseBalanceteTabular(buffer: Buffer, nome: string): BalanceteParseado {
  const matriz = /\.csv$/i.test(nome) ? csvParaMatriz(buffer) : xlsxParaMatriz(buffer);
  return parseBalanceteMatriz(matriz);
}
