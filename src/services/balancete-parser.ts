/**
 * PARSER DE BALANCETE (F1, 2026-07-18) — linha de extração SEPARADA de BP/DRE.
 *
 * Balancete de verificação: colunas Saldo anterior | Débito | Crédito | Saldo
 * atual por conta, hierarquia por classificação, e grupos de nível 1 que
 * misturam patrimonial (Ativo/Passivo) e resultado (numeração e composição
 * VARIAM por sistema contábil).
 *
 * Formatos dominados (corpus real de 7 sistemas — ver PLANO_BALANCETE_MENSAL.md):
 *  - Belagro/Questor: conta reduzida COLADA na classificação ("860"+"1.1.1.02.002"
 *    → "8601.1.1.02.002", alinhada à direita) — modo "colado";
 *  - Domínio (FT Perna/easelabs/ACM): "código classificação descrição", com a
 *    descrição da linha às vezes GRUDADA no início ("ATIVO CIRCULANTE2 1.1 …");
 *  - Pryor/Wolk (Sage): classificação corrida (1, 11, 111, 11112001) + coluna
 *    reduzida ("2-2", "-5") antes do nome;
 *  - SASIS/Pedreira: classificação pontilhada limpa + reduzida + sufixo " D"/" C";
 *  - Phonetrack/Tango: "conta S?classificação" com o S de sintética COLADO
 *    ("S1.1.01") e nomes espaçados ("A T I V O");
 *  - Protheus (SIGA): tabela com pipes e 5 colunas monetárias (Ant · D · C ·
 *    Movimento · Atual) — o movimento é descartado.
 *
 * Saída NEUTRA (valores brutos + natureza D/C quando declarada) — quem decide
 * sinal contábil e monta BP/DRE é o balancete-conversao.ts (determinístico).
 */

export interface LinhaBalancete {
  classificacao: string;
  /** Profundidade hierárquica (1 = grupo raiz). */
  nivel: number;
  nome: string;
  /** Conta sintética explícita (coluna/prefixo S) — quando o sistema marca. */
  sintetica?: boolean;
  saldoAnterior: number;
  naturezaAnterior?: "D" | "C";
  debito: number;
  credito: number;
  saldoAtual: number;
  naturezaAtual?: "D" | "C";
}

export interface BalanceteParseado {
  /** "DD/MM/AAAA" — início e fim do período declarado no cabeçalho. */
  periodoInicio: string | null;
  periodoFim: string | null;
  ordemColunas: "ant-d-c-atual" | "atual-ant-d-c";
  linhas: LinhaBalancete[];
  /** Linha "Total de débitos/créditos" quando o documento declara. */
  totais?: { debito: number; credito: number };
  avisos: string[];
}

// ── util numérico pt-BR ──────────────────────────────────────────────────────

/** Valor monetário pt-BR com sufixo D/C opcional: "1.234,56", "(1.234,56)", "1.234,56 D". */
const RE_VALOR = /\(?-?\d{1,3}(?:\.\d{3})*,\d{2}\)?(?:\s?[DC](?![A-Za-zÀ-ú0-9]))?/g;

interface Token { valor: number; natureza?: "D" | "C" }

function parseToken(raw: string): Token {
  const t = raw.trim();
  const natureza = /[DC]$/.test(t) ? (t.slice(-1) as "D" | "C") : undefined;
  let s = t.replace(/\s?[DC]$/, "").trim();
  let negativo = false;
  if (s.startsWith("(") && s.endsWith(")")) { negativo = true; s = s.slice(1, -1); }
  if (s.startsWith("-")) { negativo = true; s = s.slice(1); }
  const n = parseFloat(s.replace(/\./g, "").replace(",", "."));
  return { valor: negativo ? -n : n, natureza };
}

// ── período do cabeçalho ─────────────────────────────────────────────────────

const ultimoDia = (mes: number, ano: number): number => new Date(ano, mes, 0).getDate();

function extrairPeriodo(texto: string): { inicio: string | null; fim: string | null } {
  const cab = texto.slice(0, 3000);
  // "de 01/05/2026 a 31/05/2026" · "Período: 01/01/2024 - 31/12/2024" · "01/12/2023 ATE 31/12/2023"
  let m = cab.match(/(\d{2}\/\d{2}\/\d{4})\s*(?:a|à|-|ate|até)\s*(\d{2}\/\d{2}\/\d{4})/i);
  if (m) return { inicio: m[1], fim: m[2] };
  // "Período: 12/2020 a 12/2020" · "Período: 01/2019 a 10/2019" (MM/AAAA)
  m = cab.match(/(\d{2})\/(\d{4})\s*(?:a|à|-)\s*(\d{2})\/(\d{4})/);
  if (m) {
    const [, m1, a1, m2, a2] = m;
    return {
      inicio: `01/${m1}/${a1}`,
      fim: `${String(ultimoDia(Number(m2), Number(a2))).padStart(2, "0")}/${m2}/${a2}`,
    };
  }
  return { inicio: null, fim: null };
}

// ── nome ─────────────────────────────────────────────────────────────────────

/** Colapsa nomes com letras espaçadas ("A T I V O" → "ATIVO"). */
function normalizarNome(nome: string): string {
  const s = nome.trim().replace(/\s{2,}/g, " ");
  if (/^(?:[A-ZÀ-Ú] )+[A-ZÀ-Ú]$/.test(s)) return s.replace(/ /g, "");
  return s;
}

/** Remove reduzida/códigos residuais no INÍCIO do nome ("1-9 CAIXA", "-5 ITAU"). */
function limparInicioNome(s: string): string {
  return s
    .replace(/^[\s|]+/, "")
    .replace(/^\d*-\d+\s+/, "")
    .replace(/^\d+\s{2,}/, "")
    .trim();
}

// ── identificação pelo CONTEÚDO ──────────────────────────────────────────────

/**
 * O documento É um balancete? Decide pela ASSINATURA ESTRUTURAL, não pelo nome
 * do arquivo (o analista pode nomear errado): título "balancete" no cabeçalho,
 * ou colunas Saldo anterior/Débito/Crédito/Saldo com ≥10 linhas de 4-5 valores
 * monetários. Usado no /process para corrigir o roteamento automaticamente.
 */
export function pareceBalancete(texto: string): { balancete: boolean; evidencias: string[] } {
  const evidencias: string[] = [];
  const cab = texto.slice(0, 4000).toLowerCase().replace(/\s+/g, " ");
  const temTitulo = /balancete/.test(cab);
  if (temTitulo) evidencias.push("título 'balancete' no cabeçalho do documento");
  const temColunas = /saldo\s*ant/.test(cab) && /d[ée]bito/.test(cab) && /cr[ée]dito/.test(cab);
  if (temColunas) evidencias.push("colunas Saldo anterior · Débito · Crédito no cabeçalho");
  let linhas4Col = 0;
  for (const linha of texto.split("\n")) {
    const n = [...linha.replace(/\|/g, " ").matchAll(RE_VALOR)].length;
    if (n === 4 || n === 5) { linhas4Col++; if (linhas4Col >= 10) break; }
  }
  if (linhas4Col >= 10) evidencias.push("10+ linhas com 4-5 colunas monetárias (estrutura de balancete)");
  const balancete = temTitulo || (temColunas && linhas4Col >= 10);
  return { balancete, evidencias };
}

// ── parser principal ─────────────────────────────────────────────────────────

interface Candidata {
  original: string;
  cabecalho: string;
  tokens: Token[];
  /** Classificação pontilhada candidata (sem o prefixo S). */
  pontilhada?: string;
  /** Dígitos antes do primeiro ponto da pontilhada. */
  primeiraCorrida?: string;
  sinteticaPrefixo?: boolean;
}

export function parseBalanceteTexto(texto: string): BalanceteParseado {
  const avisos: string[] = [];
  const { inicio, fim } = extrairPeriodo(texto);
  if (!fim) avisos.push("Período do cabeçalho não identificado.");

  const cabecalhoDoc = texto.slice(0, 4000).toLowerCase().replace(/\s+/g, " ");

  // ordem de colunas: se "saldo atual" aparece ANTES de "saldo ant" no header
  const iAtual = cabecalhoDoc.search(/saldo\s*atual/);
  const iAnt = cabecalhoDoc.search(/saldo\s*ant/);
  const ordemColunas: "ant-d-c-atual" | "atual-ant-d-c" =
    iAtual >= 0 && iAnt >= 0 && iAtual < iAnt ? "atual-ant-d-c" : "ant-d-c-atual";

  // 5ª coluna de movimento (Protheus): Ant · D · C · Movimento · Atual
  const temColunaMovimento = /movimento\s+do\s+periodo|movimento\s+do\s+per[íi]odo/.test(cabecalhoDoc);
  const nValoresEsperados = temColunaMovimento ? 5 : 4;

  const linhasBrutas = texto.split("\n");

  // Totais declarados ("Total de débitos X Total de créditos Y")
  let totais: { debito: number; credito: number } | undefined;
  for (const l of linhasBrutas) {
    const m = l.replace(/\s+/g, " ").match(/tota(?:l|is)\s+de\s+d[ée]bitos?\s*:?\s*([\d.,]+).*?tota(?:l|is)\s+de\s+cr[ée]ditos?\s*:?\s*([\d.,]+)/i);
    if (m) { totais = { debito: Math.abs(parseToken(m[1]).valor), credito: Math.abs(parseToken(m[2]).valor) }; break; }
  }

  // ── 1ª passada: candidatas (linhas com o nº esperado de valores monetários) ──
  const candidatas: Candidata[] = [];
  for (const bruta of linhasBrutas) {
    const linha = bruta.replace(/\|/g, " "); // Protheus: pipes viram espaço
    const valores = [...linha.matchAll(RE_VALOR)];
    if (valores.length !== nValoresEsperados) continue;

    const cabecalho = linha.slice(0, valores[0].index).replace(/\s+$/, "");
    if (!/\d/.test(cabecalho)) continue; // linha de conta sempre tem código

    // Classificação pontilhada: entre os tokens pontilhados do cabeçalho,
    // vence o com MAIS pontos (classificação é mais profunda que números de
    // C/C no nome, ex. "070.665"); empate → o mais à esquerda.
    const pontilhadas = [...cabecalho.matchAll(/S?\d+(?:\.\d+)+/g)];
    let melhor: RegExpMatchArray | undefined;
    for (const p of pontilhadas) {
      const pontos = (p[0].match(/\./g) ?? []).length;
      const melhorPontos = melhor ? (melhor[0].match(/\./g) ?? []).length : -1;
      if (pontos > melhorPontos) melhor = p;
    }

    const cand: Candidata = { original: linha, cabecalho, tokens: valores.map((v) => parseToken(v[0])) };
    if (melhor) {
      const bruto = melhor[0];
      cand.sinteticaPrefixo = bruto.startsWith("S") || undefined;
      cand.pontilhada = bruto.replace(/^S/, "");
      cand.primeiraCorrida = cand.pontilhada.split(".")[0];
    }
    candidatas.push(cand);
  }

  if (candidatas.length === 0) {
    avisos.push("Nenhuma linha de conta com colunas monetárias encontrada.");
    return { periodoInicio: inicio, periodoFim: fim, ordemColunas, linhas: [], totais, avisos };
  }

  // ── modo do documento ──
  const comPontilhada = candidatas.filter((c) => c.pontilhada);
  const modoPontilhado = comPontilhada.length >= candidatas.length * 0.3;
  // "colado": conta reduzida grudada na classificação (1º segmento com 3+ dígitos)
  const modoColado = modoPontilhado &&
    comPontilhada.some((c) => (c.primeiraCorrida?.length ?? 0) >= 3);

  // comprimentos de classificação corrida (Pryor: 1/2/3/5/8 → níveis 1..5)
  const comprimentosCorridaSet = new Set<number>();

  interface Crua { classificacao: string; nome: string; sintetica?: boolean; tokens: Token[]; corrida: boolean }
  const cruas: Crua[] = [];

  for (const c of candidatas) {
    let classificacao = "";
    let sintetica = c.sinteticaPrefixo;
    let nome = "";
    let corrida = false;

    if (modoPontilhado && c.pontilhada) {
      classificacao = c.pontilhada;
      if (modoColado && c.primeiraCorrida && c.primeiraCorrida.length > 1) {
        // "8601.1.1.02.002" → conta "860" + classificação "1.1.1.02.002"
        classificacao = c.primeiraCorrida.slice(-1) + classificacao.slice(c.primeiraCorrida.length);
      }
      const brutoNaLinha = (c.sinteticaPrefixo ? "S" : "") + c.pontilhada;
      const pos = c.cabecalho.indexOf(brutoNaLinha);
      nome = limparInicioNome(c.cabecalho.slice(pos + brutoNaLinha.length));
    } else if (modoPontilhado) {
      // linha RAIZ em doc pontilhado ("      1 1  ATIVO" · "1901 ATIVO" ·
      // "1 S1 ATIVO" · "PASSIVO2 2  PASSIVO"): último token numérico antes do nome.
      const m = c.cabecalho.match(/^(?:.*[\s|])?(S?\d+)\s+([A-Za-zÀ-ú(].*)$/);
      if (!m) continue;
      let cls = m[1];
      if (cls.startsWith("S")) { sintetica = true; cls = cls.slice(1); }
      classificacao = modoColado && cls.length > 1 ? cls.slice(-1) : cls;
      nome = limparInicioNome(m[2]);
    } else {
      // modo corrida: primeiro run de dígitos do cabeçalho é a classificação
      const m = c.cabecalho.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) continue;
      classificacao = m[1];
      corrida = true;
      comprimentosCorridaSet.add(classificacao.length);
      nome = limparInicioNome(m[2]);
    }

    nome = normalizarNome(nome);
    if (!classificacao || !nome) continue;
    cruas.push({ classificacao, nome, sintetica, tokens: c.tokens, corrida });
  }

  const comprimentosCorrida = [...comprimentosCorridaSet].sort((a, b) => a - b);
  const nivelDe = (cls: string, ehCorrida: boolean): number => {
    if (!ehCorrida) return cls.split(".").length;
    const idx = comprimentosCorrida.indexOf(cls.length);
    return idx >= 0 ? idx + 1 : Math.max(1, Math.ceil(cls.length / 2));
  };

  const linhas: LinhaBalancete[] = cruas.map((c) => {
    // 5 colunas (movimento): Ant · D · C · Mov · Atual → descarta a 4ª
    const t = c.tokens.length === 5 ? [c.tokens[0], c.tokens[1], c.tokens[2], c.tokens[4]] : c.tokens;
    const [ant, deb, cred, atual] = ordemColunas === "ant-d-c-atual" ? t : [t[1], t[2], t[3], t[0]];
    return {
      classificacao: c.classificacao,
      nivel: nivelDe(c.classificacao, c.corrida),
      nome: c.nome,
      sintetica: c.sintetica,
      saldoAnterior: ant.valor,
      naturezaAnterior: ant.natureza,
      debito: Math.abs(deb.valor),
      credito: Math.abs(cred.valor),
      saldoAtual: atual.valor,
      naturezaAtual: atual.natureza,
    };
  });

  return { periodoInicio: inicio, periodoFim: fim, ordemColunas, linhas, totais, avisos };
}
