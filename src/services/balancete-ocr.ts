/**
 * BALANCETE ESCANEADO (OCR) — 2026-08-02. TERCEIRA via de entrada, ao lado do
 * PDF de texto e da planilha (CSV/Excel). Nada dos caminhos existentes é tocado.
 *
 * DESENHO: o OCR NÃO tenta reproduzir o layout do papel. Ele entrega uma
 * MATRIZ (código · nome · saldo anterior · débito · crédito · saldo atual) —
 * o mesmo formato que a via de PLANILHA já consome — e daí em diante quem
 * trabalha é o `parseBalanceteMatriz`, já validado contra 9 arquivos reais de
 * clientes (níveis por comprimento de código corrido, sufixo D/C, negativo
 * entre parênteses, coluna de movimento, linha desalinhada). Conversão, provas
 * e fold seguem idênticos.
 *
 * Quatro lições do documento real (Budel, via Projudi) que moldaram o código:
 *
 * 1. DETECÇÃO ESTRUTURAL, não por tamanho de texto: o PDF tem 4 KB de texto
 *    extraível que é só o CARIMBO do tribunal em cada página. O teste "texto <
 *    100 chars" passava batido e o documento rendia 0 contas. Quem decide é a
 *    estrutura: parse do texto sem linhas de conta + páginas com imagem.
 *
 * 2. NÚMERO EM FORMATO CANÔNICO. O modelo de visão normaliza os valores para
 *    en-US ("1,823,010.64") mesmo quando se pede pt-BR — e aí o parser pt-BR
 *    lia "1,82". Em vez de brigar com o locale, pedimos SEM separador de
 *    milhar e com ponto decimal ("1823010.64"), que não é ambíguo em lugar
 *    nenhum.
 *
 * 3. UMA COLUNA DE CÓDIGO SÓ. O documento traz "Classificação" (1704050005) E
 *    "Reduzida" (567>3); a segunda vazava para dentro do nome da conta.
 *
 * 4. LOTES PEQUENOS. Com 3 páginas por chamada a transcrição batia no teto de
 *    tokens e cortava contas no meio — a mesma armadilha das sugestões de
 *    classificação. 2 páginas cabem folgadas.
 *
 * PROVA NO LUGAR DE CONFIANÇA: o balancete se prova sozinho (saldo atual =
 * saldo anterior + débito − crédito). Toda linha que não fecha é SUSPEITA de
 * dígito errado e volta para uma releitura DIRIGIDA; o que continuar sem
 * fechar é reportado conta a conta. OCR nunca vira número "verde" sem prova.
 */
import { PDFDocument } from "pdf-lib";
import { createWithRetry, calcCusto, type CustoIA } from "./ai-extraction";
import { parseBalanceteMatriz, type Matriz } from "./balancete-tabular";
import type { BalanceteParseado, LinhaBalancete } from "./balancete-parser";

const MODELO_OCR = "claude-haiku-4-5-20251001";
/** Páginas por chamada — a transcrição precisa caber FOLGADA em max_tokens. */
const PAGINAS_POR_LOTE = 2;
const MAX_TOKENS = 8000;
const TOLERANCIA = 0.05;

/** Cabeçalho sintético: dá à matriz do OCR os nomes que o parser tabular procura. */
const CABECALHO = ["Classificação", "Nome da conta contábil", "Saldo anterior", "Débito", "Crédito", "Saldo atual"];

export interface ResultadoOCR {
  parseado: BalanceteParseado;
  custo: CustoIA | null;
  paginas: number;
  /** Contas que seguem sem fechar a equação após a releitura dirigida. */
  suspeitas: Array<{ classificacao: string; nome: string; anterior: number; debito: number; credito: number; atual: number }>;
  avisos: string[];
}

/** A conta fecha a equação do próprio documento? (mesma regra da prova P3.) */
export function linhaFecha(l: Pick<LinhaBalancete, "saldoAnterior" | "debito" | "credito" | "saldoAtual" | "naturezaAnterior" | "naturezaAtual">): boolean {
  const d = Math.abs(l.debito), c = Math.abs(l.credito);
  if (l.naturezaAnterior && l.naturezaAtual) {
    const ant = (l.naturezaAnterior === "C" ? -1 : 1) * Math.abs(l.saldoAnterior);
    const atual = (l.naturezaAtual === "C" ? -1 : 1) * Math.abs(l.saldoAtual);
    return Math.abs(ant + d - c - atual) <= TOLERANCIA;
  }
  return (
    Math.abs(l.saldoAnterior + d - c - l.saldoAtual) <= TOLERANCIA ||
    Math.abs(l.saldoAnterior + c - d - l.saldoAtual) <= TOLERANCIA
  );
}

/**
 * O PDF é ESCANEADO? Estrutural: o texto não rendeu linhas de conta E as
 * páginas iniciais têm imagem. `linhasDoTexto` vem do parse que já rodou.
 */
export async function pdfEscaneado(buffer: Buffer, linhasDoTexto: number): Promise<{ escaneado: boolean; paginas: number; motivo: string }> {
  if (linhasDoTexto >= 5) return { escaneado: false, paginas: 0, motivo: "o texto do PDF já rende linhas de conta" };
  try {
    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
    let escaneadas = 0;
    const amostra = Math.min(doc.numPages, 3);
    for (let n = 1; n <= amostra; n++) {
      const page = await doc.getPage(n);
      // PÁGINA ESCANEADA = POUCO TEXTO (03/08/2026 — caça de regressão). O teste
      // "tem imagem" sozinho disparava OCR pago por causa de um LOGOTIPO no
      // cabeçalho de um PDF de texto perfeitamente legível. Numa página
      // escaneada de verdade o texto é quase nada (só carimbo/rodapé); numa
      // página de texto com logo há centenas de caracteres.
      const txt = await page.getTextContent();
      const chars = txt.items.reduce((s: number, i: any) => s + String(i?.str ?? "").trim().length, 0);
      const ops = await page.getOperatorList();
      const temImagem = ops.fnArray.some((f: number) => f === pdfjs.OPS.paintImageXObject || f === pdfjs.OPS.paintJpegXObject || f === pdfjs.OPS.paintInlineImageXObject);
      if (temImagem && chars < 600) escaneadas++;
    }
    const escaneado = escaneadas > 0;
    return {
      escaneado,
      paginas: doc.numPages,
      motivo: escaneado
        ? `${escaneadas}/${amostra} páginas iniciais são imagem com texto irrelevante (carimbo/rodapé) e o parse não rendeu contas`
        : "as páginas têm texto de verdade — o problema não é digitalização, é o layout não reconhecido",
    };
  } catch (e: any) {
    return { escaneado: false, paginas: 0, motivo: `não foi possível inspecionar o PDF: ${e?.message ?? e}` };
  }
}

/** Fatia o PDF em lotes de páginas (cada lote vira uma chamada de visão). */
async function fatiarPDF(buffer: Buffer, porLote: number): Promise<Buffer[]> {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const total = src.getPageCount();
  const lotes: Buffer[] = [];
  for (let ini = 0; ini < total; ini += porLote) {
    const doc = await PDFDocument.create();
    const paginas = await doc.copyPages(src, Array.from({ length: Math.min(porLote, total - ini) }, (_, k) => ini + k));
    for (const p of paginas) doc.addPage(p);
    lotes.push(Buffer.from(await doc.save()));
  }
  return lotes;
}

const INSTRUCAO = `Você está lendo páginas escaneadas de um BALANCETE DE VERIFICAÇÃO brasileiro.

Transcreva TODAS as linhas de conta, uma por linha, com os 7 campos separados por TAB:
CODIGO<TAB>REDUZIDA<TAB>NOME<TAB>SALDO_ANTERIOR<TAB>DEBITO<TAB>CREDITO<TAB>SALDO_ATUAL

REGRAS (o descumprimento inutiliza a leitura):
1. NÚMEROS EM FORMATO CANÔNICO: sem separador de milhar, ponto como decimal, sinal de menos quando negativo. O impresso "1.823.010,64" (ou "1,823,010.64") vira 1823010.64; "(45,20)" vira -45.20. Sempre 2 casas decimais.
2. CÓDIGO: a coluna de CLASSIFICAÇÃO CONTÁBIL (a hierárquica, ex.: 1704050005), copiada dígito a dígito.
3. REDUZIDA: muitos balancetes trazem uma segunda coluna de código, curta, tipo "567>3", "2>7", "34>2". Ela tem campo PRÓPRIO aqui — escreva o que estiver lá, ou "-" quando não houver. NUNCA a coloque no campo NOME.
4. NOME: só a descrição em LETRAS da conta (ex.: CAIXA GERAL, BANCO ITAU, FORNECEDORES). Se estiver ilegível, escreva SEM_NOME.
5. Coluna vazia vale 0.00 — nunca deixe campo em branco (desalinha os 6 campos).
6. Se o documento marcar natureza D ou C no saldo, acrescente " D" ou " C" ao final DAQUELE valor (ex.: 1823010.64 D).
7. Transcreva TODAS as contas, inclusive saldo zero e linhas de TOTAL/GRUPO, na ordem impressa.
8. NÃO some, NÃO corrija, NÃO reordene, NÃO comente: só transcreva o impresso.
9. IGNORE carimbo de assinatura digital, identificador de processo judicial, número de página e rodapé.
10. Se alguma página trouxer o PERÍODO do balancete, escreva ANTES das contas uma única linha começando com PERIODO seguida do texto literal (ex.: PERIODO	Período: 07/2015 a 07/2015).`;

/** Uma chamada de visão sobre um lote de páginas. */
async function transcreverLote(pdfLote: Buffer, nLote: number, total: number): Promise<{ texto: string; inTok: number; outTok: number; truncado: boolean }> {
  const msg = await createWithRetry({
    model: MODELO_OCR,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfLote.toString("base64") } } as any,
        { type: "text", text: `${INSTRUCAO}\n\n(Lote ${nLote} de ${total} — transcreva TODAS as páginas deste lote, na ordem.)` },
      ] as any,
    }],
  });
  return {
    texto: msg.content?.[0]?.type === "text" ? msg.content[0].text : "",
    inTok: msg.usage?.input_tokens ?? 0,
    outTok: msg.usage?.output_tokens ?? 0,
    truncado: msg.stop_reason === "max_tokens",
  };
}

/** TSV do OCR → linhas da matriz (+ o texto literal do período, se veio). */
function tsvParaLinhas(tsv: string): { linhas: string[][]; periodo: string | null } {
  const linhas: string[][] = [];
  let periodo: string | null = null;
  for (const bruta of tsv.split(/\r?\n/)) {
    const campos = bruta.split("\t").map((c) => c.trim());
    if (campos.length >= 2 && /^periodo$/i.test(campos[0])) {
      periodo = campos.slice(1).join(" ").trim() || null;
      continue;
    }
    // 7 campos: CODIGO, REDUZIDA (descartada aqui — existe só para a coluna
    // ter casa própria e não invadir o nome), NOME e os 4 valores.
    if (campos.length < 7) continue;
    const [cod, , nome, ...valores] = campos;
    // Código de conta: dígitos (corrido) ou pontilhado. Nome obrigatório.
    if (!/^\d+(\.\d+)*$/.test(cod) || !nome) continue;
    linhas.push([cod, nome, ...valores.slice(0, 4)]);
  }
  return { linhas, periodo };
}

/** Monta a matriz no formato que o parser tabular consome. */
const montarMatriz = (linhas: string[][], periodo: string | null): Matriz =>
  [[periodo ?? ""], CABECALHO, ...linhas];

/**
 * OCR do balancete escaneado → BalanceteParseado (mesmo contrato das outras
 * duas vias), com auditoria aritmética e releitura dirigida.
 */
export async function ocrBalancete(buffer: Buffer, competencia?: string | null): Promise<ResultadoOCR> {
  const avisos: string[] = [];
  let inTok = 0, outTok = 0;

  const lotes = await fatiarPDF(buffer, PAGINAS_POR_LOTE);
  // TETO DE PÁGINAS (03/08/2026 — caça de regressão): sem ele, um documento de
  // 200 páginas viraria ~100 chamadas em série (mais de uma hora e vários
  // dólares), e a instância única do Cloud Run ficaria presa em "Extraindo".
  // Acima do teto, a extração falha com instrução clara em vez de queimar tudo.
  const MAX_PAGINAS = 40;
  const totalPaginas = lotes.length * PAGINAS_POR_LOTE;
  if (totalPaginas > MAX_PAGINAS) {
    const vazio = parseBalanceteMatriz(montarMatriz([], null));
    return {
      parseado: vazio, custo: null, paginas: totalPaginas, suspeitas: [],
      avisos: [`Documento escaneado com ~${totalPaginas} páginas — acima do limite de ${MAX_PAGINAS} para leitura por OCR (custo e tempo). Envie o balancete em CSV/Excel, ou divida o PDF por período.`],
    };
  }
  const tsvs: string[] = [];
  for (let i = 0; i < lotes.length; i++) {
    try {
      const r = await transcreverLote(lotes[i], i + 1, lotes.length);
      inTok += r.inTok; outTok += r.outTok;
      if (r.truncado) avisos.push(`A transcrição do lote ${i + 1}/${lotes.length} bateu no limite de tamanho — pode faltar conta desse trecho.`);
      tsvs.push(r.texto);
    } catch (e: any) {
      avisos.push(`Lote ${i + 1}/${lotes.length} falhou na leitura (${e?.message ?? e}) — as contas dessas páginas ficaram de fora.`);
    }
  }

  const { linhas, periodo } = tsvParaLinhas(tsvs.join("\n"));
  const custoDe = () => calcCusto(MODELO_OCR, inTok, outTok);
  if (linhas.length === 0) {
    const vazio = parseBalanceteMatriz(montarMatriz([], periodo));
    return { parseado: vazio, custo: custoDe(), paginas: lotes.length * PAGINAS_POR_LOTE, suspeitas: [], avisos: [...avisos, "A leitura não reconheceu nenhuma linha de conta."] };
  }

  // ── AUDITORIA ARITMÉTICA + RELEITURA DIRIGIDA ──────────────────────────────
  // Duas rodadas: a 1ª pega o grosso, a 2ª insiste no que sobrou (o resíduo
  // costuma ser dígito borrado, que uma leitura focada em poucas contas resolve).
  let matriz = montarMatriz(linhas, periodo);
  let p = parseBalanceteMatriz(matriz, competenciaComoPeriodo(competencia));
  let linhasAtuais = linhas;
  for (let rodada = 1; rodada <= 2; rodada++) {
    const naoFecham = p.linhas.filter((l) => !linhaFecha(l));
    if (naoFecham.length === 0 || naoFecham.length > 80) break;
    const melhorou = await releituraDirigida(buffer, naoFecham, periodo);
    inTok += melhorou.inTok; outTok += melhorou.outTok;
    if (melhorou.erro) { avisos.push(melhorou.erro); break; }
    if (melhorou.porCodigo.size === 0) break;
    linhasAtuais = linhasAtuais.map((l) => melhorou.porCodigo.get(l[0]) ?? l);
    matriz = montarMatriz(linhasAtuais, periodo);
    p = parseBalanceteMatriz(matriz, competenciaComoPeriodo(competencia));
    avisos.push(`Releitura ${rodada}: ${melhorou.porCodigo.size} conta(s) corrigidas e agora fecham a equação do documento.`);
  }
  // CONSERTO PELA ÁRVORE: o que a releitura não resolveu, a soma dos filhos
  // muitas vezes resolve — de graça e de forma determinística.
  const arv = consertarPelaArvore(linhasAtuais, periodo);
  if (arv.consertos.length > 0) {
    linhasAtuais = arv.linhas;
    p = parseBalanceteMatriz(montarMatriz(linhasAtuais, periodo), competenciaComoPeriodo(competencia));
    avisos.push(`${arv.consertos.length} conta(s) de grupo corrigidas pela soma dos filhos (a leitura do total divergia das contas que o compõem): ${arv.consertos.slice(0, 5).join(", ")}${arv.consertos.length > 5 ? "…" : ""}.`);
  }

  const suspeitas = p.linhas.filter((l) => !linhaFecha(l)).slice(0, 20).map((l) => ({
    classificacao: l.classificacao, nome: l.nome, anterior: l.saldoAnterior, debito: l.debito, credito: l.credito, atual: l.saldoAtual,
  }));
  if (suspeitas.length > 0) {
    avisos.push(`${suspeitas.length} conta(s) seguem sem fechar a equação após a releitura — confira estes valores no documento antes de usar os números.`);
  }
  avisos.push(`Números lidos por OCR (${p.linhas.length} contas em ${lotes.length * PAGINAS_POR_LOTE} páginas) — a extração é assistida por IA e as provas de fechamento valem como conferência.`);

  return { parseado: p, custo: custoDe(), paginas: lotes.length * PAGINAS_POR_LOTE, suspeitas, avisos };
}


/** RELEITURA DIRIGIDA: manda de volta só as contas que não fecham, pedindo
 *  conferência dígito a dígito. Troca apenas a linha cuja releitura PASSA a
 *  fechar — releitura que não melhora é descartada (nunca piora o que já
 *  estava bom, e nunca "conserta" inventando número). */
async function releituraDirigida(
  buffer: Buffer,
  naoFecham: LinhaBalancete[],
  periodo: string | null,
): Promise<{ porCodigo: Map<string, string[]>; inTok: number; outTok: number; erro?: string }> {
  const vazio = { porCodigo: new Map<string, string[]>(), inTok: 0, outTok: 0 };
  try {
    const r = await createWithRetry({
      model: MODELO_OCR,
      max_tokens: 4000,
      temperature: 0,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") } } as any,
          {
            type: "text",
            text: `As contas abaixo foram transcritas deste balancete escaneado, mas os numeros NAO fecham a equacao da propria linha (saldo atual = saldo anterior + debito - credito, ou + credito - debito nas contas credoras). Isso quase sempre e digito lido errado.

Releia SOMENTE estas contas na imagem, conferindo digito a digito, e devolva a transcricao corrigida no mesmo formato de 7 campos separados por TAB, com numeros canonicos (sem separador de milhar, ponto decimal):
CODIGO<TAB>REDUZIDA<TAB>NOME<TAB>SALDO_ANTERIOR<TAB>DEBITO<TAB>CREDITO<TAB>SALDO_ATUAL

Contas a reler:
${naoFecham.map((l) => [l.classificacao, l.nome].join("\t")).join("\n")}

Se ao reler a conta continuar nao fechando, transcreva o que esta impresso mesmo assim - NAO invente numero para fechar. Sem comentarios.`,
          },
        ] as any,
      }],
    });
    const { linhas: relidas } = tsvParaLinhas(r.content?.[0]?.type === "text" ? r.content[0].text : "");
    const porCodigo = new Map<string, string[]>();
    for (const nova of relidas) {
      const teste = parseBalanceteMatriz(montarMatriz([nova], periodo)).linhas[0];
      if (teste && linhaFecha(teste)) porCodigo.set(nova[0], nova);
    }
    return { porCodigo, inTok: r.usage?.input_tokens ?? 0, outTok: r.usage?.output_tokens ?? 0 };
  } catch (e: any) {
    return { ...vazio, erro: `A releitura das contas que nao fecham falhou (${e?.message ?? e}).` };
  }
}

/**
 * CONSERTO PELA ÁRVORE (determinístico, sem nova leitura).
 *
 * O balancete tem DUAS provas independentes: a equação da linha (saldo atual =
 * saldo anterior + débito − crédito) e a soma da hierarquia (pai = soma dos
 * filhos). Quando um NÓ-PAI falha a própria equação e a soma dos filhos —
 * todos eles coerentes — faz o pai fechar, o dígito errado estava no pai: a
 * leitura do papel é substituída pela soma dos filhos.
 *
 * Caso real (Budel): "110101 CAIXA" lido como 2.204,95 com filho único
 * "110101001 CAIXA" em 22.004,95 — o pai é que estava errado.
 *
 * Conservador por construção: só mexe em quem JÁ está errado, só quando os
 * filhos estão certos, e só se o conserto FIZER a equação do pai fechar. Cada
 * troca vira aviso auditável.
 */
function consertarPelaArvore(linhas: string[][], periodo: string | null): { linhas: string[][]; consertos: string[] } {
  const consertos: string[] = [];
  const parse = (ls: string[][]) => parseBalanceteMatriz(montarMatriz(ls, periodo)).linhas;
  const atuais = parse(linhas);
  if (atuais.length !== linhas.length) return { linhas, consertos }; // desalinhado: não arrisca

  // Filhos DIRETOS pelo prefixo do código (o mais longo que seja prefixo próprio).
  const idxPorCodigo = new Map<string, number>();
  atuais.forEach((l, i) => idxPorCodigo.set(l.classificacao, i));
  const filhos = new Map<number, number[]>();
  atuais.forEach((l, i) => {
    let paiIdx = -1, melhor = -1;
    for (const [cod, j] of idxPorCodigo) {
      if (j === i || !l.classificacao.startsWith(cod) || cod.length >= l.classificacao.length) continue;
      if (cod.length > melhor) { melhor = cod.length; paiIdx = j; }
    }
    if (paiIdx >= 0) (filhos.get(paiIdx) ?? filhos.set(paiIdx, []).get(paiIdx)!).push(i);
  });

  const saida = linhas.map((l) => [...l]);
  // Índice das 4 colunas de valor dentro da linha da matriz (cod, nome, 4 valores).
  const COLS: Array<{ campo: "saldoAnterior" | "debito" | "credito" | "saldoAtual"; pos: number }> = [
    { campo: "saldoAnterior", pos: 2 }, { campo: "debito", pos: 3 }, { campo: "credito", pos: 4 }, { campo: "saldoAtual", pos: 5 },
  ];
  for (const [paiIdx, filhosIdx] of filhos) {
    const pai = atuais[paiIdx];
    if (linhaFecha(pai)) continue;                                  // pai já está coerente
    if (!filhosIdx.every((i) => linhaFecha(atuais[i]))) continue;   // filhos duvidosos: não confia
    const soma = (campo: typeof COLS[number]["campo"]) =>
      Math.round(filhosIdx.reduce((s, i) => s + (atuais[i][campo] as number), 0) * 100) / 100;
    const candidato = { ...pai, saldoAnterior: soma("saldoAnterior"), debito: soma("debito"), credito: soma("credito"), saldoAtual: soma("saldoAtual") };
    if (!linhaFecha(candidato)) continue;                           // a soma não conserta: deixa como está
    for (const c of COLS) saida[paiIdx][c.pos] = String(candidato[c.campo]);
    consertos.push(`${pai.classificacao} ${pai.nome}`);
  }
  return { linhas: saida, consertos };
}

/** Competência do documento como período de fallback (a planilha faz igual). */
function competenciaComoPeriodo(comp?: string | null): { inicio: string; fim: string } | null {
  const c = (comp ?? "").trim();
  const ultimoDia = (m: number, a: number) => new Date(a, m, 0).getDate();
  let x = c.match(/^(\d{4})$/);
  if (x) return { inicio: `01/01/${x[1]}`, fim: `31/12/${x[1]}` };
  x = c.match(/^(\d{4})-(\d{2})$/);
  if (x) return { inicio: `01/${x[2]}/${x[1]}`, fim: `${String(ultimoDia(Number(x[2]), Number(x[1]))).padStart(2, "0")}/${x[2]}/${x[1]}` };
  x = c.match(/^(\d{4})-(\d{2})\.\.(\d{4})-(\d{2})$/);
  if (x) return { inicio: `01/${x[2]}/${x[1]}`, fim: `${String(ultimoDia(Number(x[4]), Number(x[3]))).padStart(2, "0")}/${x[4]}/${x[3]}` };
  return null;
}
