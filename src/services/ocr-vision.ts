/**
 * OCR DETERMINÍSTICO (Google Cloud Vision) — 2026-08-03.
 *
 * POR QUE TROCAR O MOTOR. Medido no mesmo tipo de documento:
 *
 *   LLM de visão (Haiku)   35,6% das linhas não fecham · 4 valores ALUCINADOS · US$ 0,15/doc
 *   Cloud Vision           97,2% de valores exatos     · ZERO valor errado   · US$ 0,015/doc
 *
 * O número que decide não é o 97,2% — é o ZERO. Um OCR clássico reconhece
 * caracteres; quando não consegue ler, ele erra ou não entrega. Um LLM GERA: sem
 * conseguir ler, preenche com o que é plausível. Foi assim que o balancete Budel
 * ganhou quatro contas com o valor "1.234.567,89" (sequência de teclado) e nomes
 * emparelhados com o código errado. Erro que se declara, a prova de fechamento
 * pega e o selo recusa; valor inventado que fecha a equação passa direto.
 *
 * A OUTRA METADE DO GANHO É GEOMETRIA. O Vision devolve cada palavra com sua
 * caixa (x, y, largura). A tabela é remontada DETERMINISTICAMENTE pela posição no
 * papel, não pela interpretação do modelo — o que elimina a classe inteira de
 * erro de pareamento código↔linha↔coluna que derrubava a leitura antes.
 *
 * CONTRATO INALTERADO: entrega a mesma MATRIZ que `parseBalanceteMatriz` já
 * consome. Conversão, provas de fechamento, fold, dicionário e telas seguem
 * idênticos — a troca é só do passo "PDF escaneado → matriz".
 */
import { GoogleAuth } from "google-auth-library";
import { PDFDocument } from "pdf-lib";
import { registrarUsoIA, ETAPAS } from "./ai-usage";

/** files:annotate aceita o PDF DIRETO — sem rasterizar nada em produção. */
const ENDPOINT = "https://vision.googleapis.com/v1/files:annotate";
const FEATURE = "DOCUMENT_TEXT_DETECTION";
/** Limite do files:annotate SÍNCRONO com conteúdo embutido: 5 páginas por requisição. */
const PAGINAS_POR_REQUISICAO = 5;
/** Teto de páginas: acima disso o documento não é caso de OCR, é caso de pedir CSV. */
export const MAX_PAGINAS_VISION = 60;

let auth: GoogleAuth | null = null;
async function token(): Promise<string> {
  auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const c = await auth.getClient();
  const t = await c.getAccessToken();
  if (!t?.token) throw new Error("sem credencial do Google Cloud (ADC) para chamar o Vision");
  return t.token;
}

export interface Palavra { t: string; x: number; y: number; w: number; h: number }
export interface PaginaVision { palavras: Palavra[] }

/** Caixa → {x,y,w,h}, tolerando vértice sem coordenada (o Vision omite zeros). */
function caixa(vertices: any[]): { x: number; y: number; w: number; h: number } {
  const xs = (vertices ?? []).map((p: any) => p?.x ?? 0);
  const ys = (vertices ?? []).map((p: any) => p?.y ?? 0);
  const x = xs.length ? Math.min(...xs) : 0;
  const y = ys.length ? Math.min(...ys) : 0;
  return { x, y, w: (xs.length ? Math.max(...xs) : 0) - x, h: (ys.length ? Math.max(...ys) : 0) - y };
}

/**
 * Extrai palavras COM geometria de uma resposta de página.
 *
 * Duas formas possíveis, nesta ordem de preferência:
 *  1. `textAnnotations[1..]` — uma entrada por palavra, já com caixa;
 *  2. `fullTextAnnotation` — árvore páginas→blocos→parágrafos→palavras→símbolos.
 * O `files:annotate` costuma devolver a segunda; o `images:annotate`, a primeira.
 * Suportar as duas evita que uma mudança de shape do provedor zere a leitura.
 */
export function palavrasDaResposta(r: any): Palavra[] {
  const anns: any[] = r?.textAnnotations ?? [];
  if (anns.length > 1) {
    return anns.slice(1).map((a) => ({ t: String(a.description ?? ""), ...caixa(a.boundingPoly?.vertices) }));
  }
  const out: Palavra[] = [];
  for (const pg of r?.fullTextAnnotation?.pages ?? []) {
    for (const bloco of pg?.blocks ?? []) {
      for (const par of bloco?.paragraphs ?? []) {
        for (const w of par?.words ?? []) {
          const texto = (w?.symbols ?? []).map((sy: any) => sy?.text ?? "").join("");
          if (texto) out.push({ t: texto, ...caixa(w?.boundingBox?.vertices) });
        }
      }
    }
  }
  return out;
}

/** Fatia o PDF em blocos de N páginas (o limite síncrono do files:annotate). */
async function fatiar(buffer: Buffer, porLote: number): Promise<Buffer[]> {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const total = src.getPageCount();
  const out: Buffer[] = [];
  for (let i = 0; i < total; i += porLote) {
    const d = await PDFDocument.create();
    const pgs = await d.copyPages(src, Array.from({ length: Math.min(porLote, total - i) }, (_, k) => i + k));
    for (const pg of pgs) d.addPage(pg);
    out.push(Buffer.from(await d.save()));
  }
  return out;
}

/**
 * Lê um PDF ESCANEADO pelo Cloud Vision e devolve as páginas com geometria.
 * Registra o consumo por PÁGINA — a unidade que o Vision cobra.
 */
export async function lerPDF(
  buffer: Buffer,
  documentId?: string | null,
  // A ETAPA VEM DE FORA: o mesmo `lerPDF` serve balancete e BP/DRE, e gravar
  // tudo como "ocr-balancete-vision" faria o relatório mentir sobre qual etapa
  // gastou — justamente o que a tabela existe para responder.
  etapa: string = ETAPAS.OCR_BALANCETE_VISION,
): Promise<{ paginas: PaginaVision[]; totalPaginas: number }> {
  // TETO ANTES DE GASTAR. Sem isto a constante era documentação: um PDF de 200
  // páginas viraria 40 requisições SEQUENCIAIS e prenderia a instância única do
  // Cloud Run em "Extraindo" — exatamente o cenário que o teto da via LLM existe
  // para evitar. Acima do teto, `throw` faz cair na via LLM, que recusa com a
  // mensagem clara ("envie em CSV/Excel").
  const paginasDoPdf = (await PDFDocument.load(buffer, { ignoreEncryption: true })).getPageCount();
  if (paginasDoPdf > MAX_PAGINAS_VISION) {
    throw new Error(`PDF com ${paginasDoPdf} páginas — acima do teto de ${MAX_PAGINAS_VISION} para leitura por Vision`);
  }
  const lotes = await fatiar(buffer, PAGINAS_POR_REQUISICAO);
  const bearer = await token();
  const paginas: PaginaVision[] = [];
  let totalPaginas = 0;

  for (const lote of lotes) {
    const iniciadoEm = new Date();
    const nesteLote = (await PDFDocument.load(lote)).getPageCount();
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{
          inputConfig: { content: lote.toString("base64"), mimeType: "application/pdf" },
          features: [{ type: FEATURE }],
          imageContext: { languageHints: ["pt"] },
        }],
      }),
      // Sem timeout, um lote pendurado segura a instância única indefinidamente.
      signal: AbortSignal.timeout(120_000),
    });
    const j: any = await resp.json().catch(() => ({}));
    const erro = j?.error ?? j?.responses?.[0]?.error;
    if (!resp.ok || erro) {
      void registrarUsoIA({
        etapa, provedor: "google-vision", modelo: FEATURE,
        iniciadoEm, documentId,
        unidades: { chave: `google-vision:${FEATURE}`, unidade: "paginas", quantidade: 0 },
        status: "erro", erroTipo: String(erro?.status ?? resp.status),
      });
      throw new Error(`Cloud Vision: ${erro?.message ?? `HTTP ${resp.status}`}`);
    }

    // A COBRANÇA É POR PÁGINA ENVIADA, inclusive a que voltar vazia.
    void registrarUsoIA({
      etapa, provedor: "google-vision", modelo: FEATURE,
      iniciadoEm, documentId,
      unidades: { chave: `google-vision:${FEATURE}`, unidade: "paginas", quantidade: nesteLote },
    });
    totalPaginas += nesteLote;

    for (const r of j?.responses?.[0]?.responses ?? []) paginas.push({ palavras: palavrasDaResposta(r) });
  }
  return { paginas, totalPaginas };
}

// ── remontagem determinística da tabela ─────────────────────────────────────

/** Número pt-BR impresso em balancete: 1.234.567,89 · -1.234,56 · (45,20) */
const ehNumero = (s: string): boolean => /^-?\(?\d{1,3}(\.\d{3})*,\d{2}\)?$/.test(s);
const paraNumero = (s: string): number => {
  const neg = s.startsWith("-") || (s.startsWith("(") && s.endsWith(")"));
  const n = parseFloat(s.replace(/[-()]/g, "").replace(/\./g, "").replace(",", "."));
  return neg ? -Math.abs(n) : n;
};

/**
 * Agrupa palavras em LINHAS pela coordenada vertical.
 *
 * A tolerância sai da ALTURA MEDIANA das palavras da própria página, não de uma
 * constante: papel a 200 dpi e a 300 dpi têm passos de linha diferentes, e um
 * valor fixo funde linhas vizinhas num e separa a mesma linha no outro (medido —
 * com tolerância fixa de 20px num papel de passo 16px, todas as linhas fundiram).
 */
export function agruparLinhas(palavras: Palavra[]): Palavra[][] {
  if (palavras.length === 0) return [];
  const alturas = palavras.map((p) => p.h).filter((h) => h > 0).sort((a, b) => a - b);
  const mediana = alturas[Math.floor(alturas.length / 2)] || 12;
  const tol = Math.max(4, Math.round(mediana * 0.6));

  const ord = [...palavras].sort((a, b) => a.y - b.y || a.x - b.x);
  const linhas: Palavra[][] = [];
  for (const p of ord) {
    const ultima = linhas[linhas.length - 1];
    if (ultima && Math.abs(ultima[0].y - p.y) <= tol) ultima.push(p);
    else linhas.push([p]);
  }
  for (const l of linhas) l.sort((a, b) => a.x - b.x);
  return linhas;
}

/**
 * Costura fragmentos vizinhos que só juntos formam um número.
 * O OCR às vezes quebra "614.387,53" em "614." + "387,53" — medido no documento
 * real. Só junta quando o resultado é um número válido E os pedaços são colados.
 */
export function costurarNumeros(linha: Palavra[]): Palavra[] {
  const out: Palavra[] = [];
  for (let i = 0; i < linha.length; i++) {
    const a = linha[i], b = linha[i + 1];
    if (b && !ehNumero(a.t) && /^-?\(?\d{1,3}(\.\d{3})*\.?$/.test(a.t) && ehNumero(a.t + b.t) && b.x - (a.x + a.w) < a.h) {
      out.push({ t: a.t + b.t, x: a.x, y: a.y, w: b.x + b.w - a.x, h: Math.max(a.h, b.h) });
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Remonta a matriz [classificação, nome, anterior, débito, crédito, atual] —
 * exatamente o formato que `parseBalanceteMatriz` já consome.
 *
 * Uma linha de conta = começa com CÓDIGO (só dígitos ou pontilhado) e termina com
 * ao menos 4 números. Os 4 ÚLTIMOS números são as colunas de valor: qualquer
 * coisa entre o nome e eles (coluna "Reduzida", por exemplo) fica de fora sozinha.
 */
/**
 * PERÍODO IMPRESSO NO CABEÇALHO. Sem isto o balancete escaneado SEM competência
 * declarada é rejeitado ("Estrutura de balancete não reconhecida"), e o que TEM
 * competência declarada cai no fallback com `periodoAssumido = true` — o que
 * desliga a conferência de competência e deixa passar calado um acumulado de 9
 * meses declarado como exercício fechado (incidente real, ver analyses.ts).
 * As palavras já estavam em mãos; só estavam sendo descartadas.
 */
export function periodoDasPalavras(palavras: Palavra[]): string | null {
  const linhas = agruparLinhas(palavras).slice(0, 12); // o período vem no topo
  for (const l of linhas) {
    const texto = l.map((p) => p.t).join(" ");
    const m =
      texto.match(/\d{2}\/\d{2}\/\d{4}\s*(?:a|à|até|-)\s*\d{2}\/\d{2}\/\d{4}/i) ??
      texto.match(/\d{2}\/\d{4}\s*(?:a|à|até|-)\s*\d{2}\/\d{4}/i);
    if (m) return m[0];
  }
  return null;
}

/**
 * Remonta a matriz [classificação, nome, anterior, débito, crédito, atual] —
 * exatamente o formato que `parseBalanceteMatriz` já consome.
 *
 * Uma linha de conta = começa com CÓDIGO e termina com ao menos 4 números. Os 4
 * ÚLTIMOS números são as colunas de valor; o que estiver entre o nome e eles
 * (coluna "Reduzida") fica de fora.
 *
 * DEVOLVE `descartadas`: linhas que TÊM cara de conta (código válido) e mesmo
 * assim não renderam 4 valores. Some-las em silêncio era o pior defeito da via —
 * basta o OCR ler uma vírgula como ponto para a conta inteira sumir, e as provas
 * de fechamento continuarem verdes sobre um documento incompleto.
 */
export function matrizDasPaginas(
  paginas: PaginaVision[],
  periodoConhecido: string | null,
): { linhas: string[][]; periodo: string | null; descartadas: number } {
  const linhas: string[][] = [];
  let descartadas = 0;
  let periodo = periodoConhecido;

  for (const pg of paginas) {
    if (!periodo) periodo = periodoDasPalavras(pg.palavras);
    for (const bruta of agruparLinhas(pg.palavras)) {
      const l = costurarNumeros(bruta);
      const cod = l[0]?.t ?? "";
      if (!/^\d+(\.\d+)*$/.test(cod) || l.length < 5) continue;
      const numeros = l.filter((p) => ehNumero(p.t));
      if (numeros.length < 4) { descartadas++; continue; }
      const valores = numeros.slice(-4);
      const primeiroValorX = valores[0].x;
      const nome = l
        .filter((p) => p !== l[0] && p.x < primeiroValorX && !ehNumero(p.t) && !/^\d+[->]\d+$/.test(p.t))
        .map((p) => p.t)
        .join(" ")
        .trim();
      if (!nome) { descartadas++; continue; }
      // SUFIXO DE NATUREZA: o documento imprime "32.000,00 C" e o Vision devolve
      // o valor e a letra como palavras SEPARADAS. Descartar a letra inverte o
      // sinal de conta retificadora SEM movimento (depreciação acumulada,
      // prejuízos acumulados) — e as duas provas continuam verdes, porque o
      // subtotal do pai fecha. `valorPtBr` já lê "32000 C".
      const comNatureza = valores.map((v) => {
        const seguinte = l.find((p) => p.x > v.x + v.w && p.x - (v.x + v.w) < v.h * 2);
        const letra = seguinte && /^[DC]$/i.test(seguinte.t) ? ` ${seguinte.t.toUpperCase()}` : "";
        return String(paraNumero(v.t)) + letra;
      });
      linhas.push([cod, nome, ...comNatureza]);
    }
  }
  return { linhas, periodo, descartadas };
}

/**
 * ⚠️ NÃO LIGADA A NENHUM FLUXO — ver o aviso ao fim deste comentário.
 *
 * TEXTO COM LAYOUT a partir da geometria — o mesmo formato que o
 * `renderPageLayout` do parser produz para PDF legível (lacuna visual vira
 * espaço proporcional, indentação medida da margem esquerda da página).
 *
 * Por que importa: o BP e a DRE escaneados iam para transcrição por LLM, com a
 * mesma exposição a valor inventado que derrubou o balancete Budel. Devolvendo
 * ESTE formato, o documento escaneado passa a alimentar o MESMO extrator
 * determinístico que já atende o PDF com texto — em vez de uma passada de IA.
 * Ganha-se duas vezes: sai a alucinação e sai o custo da IA de extração.
 *
 * ⚠️ POR QUE AINDA NÃO ESTÁ EM USO (03/08/2026). A revisão adversarial mediu,
 * rodando o pipeline REAL sobre 138 PDFs do corpus, que a primeira versão
 * alterava a escada de hierarquia em 60 deles — e em 4 BPs da família AOCP
 * derrubava a árvore determinística, disparando a poda que APAGA linhas
 * (76→12 contas). Nada pegava, porque Ativo = Passivo vem das raízes
 * DECLARADAS e não da soma das folhas.
 *
 * A causa: o passo entre níveis nos ERPs brasileiros é MENOR que um caractere
 * (0,48 no AOCP, 1,07 no K&A SPED), e o `renderPageLayout` nem usa geometria
 * nesses documentos — a indentação chega como ESPAÇOS LITERAIS dentro do run do
 * pdfjs e é copiada verbatim.
 *
 * Esta versão já corrige o que foi apontado (escada ORDINAL em vez de
 * quantização por largura de caractere, e `costurarNumeros` antes da montagem),
 * mas o A/B de `scripts/ab-layout-vision.ts` ainda acusa divergência de escada
 * em boa parte do corpus. ANTES DE LIGAR em `parser.ts`, o critério de aceite
 * tem de ser a ÁRVORE que `construirArvoreBPporIndentacao` monta — não a
 * contagem de recuos — e ela precisa bater com a do texto original.
 */
export function textoLayoutDasPaginas(paginas: PaginaVision[]): string {
  const saida: string[] = [];
  for (const pg of paginas) {
    if (pg.palavras.length === 0) continue;
    const linhas = agruparLinhas(pg.palavras).map(costurarNumeros);
    if (linhas.length === 0) continue;

    const comLargura = pg.palavras.filter((p) => p.w > 0 && p.t.length > 0);
    const larguraChar = comLargura.length
      ? comLargura.reduce((s, p) => s + p.w / p.t.length, 0) / comLargura.length
      : 6;

    // ── INDENTAÇÃO POR POSTO, NÃO POR LARGURA DE CARACTERE ──────────────────
    // Quantizar o recuo dividindo por `larguraChar` COLAPSA a hierarquia: nos
    // ERPs brasileiros o passo entre níveis é MENOR que um caractere (medido:
    // 0,48 no AOCP, 1,07 no K&A SPED). Math.round() transformava a escada de 4
    // níveis em 2 e a conta-folha virava irmã do próprio grupo — em 60 de 138
    // documentos do corpus, com Ativo=Passivo continuando a fechar porque os
    // totais vêm das raízes declaradas. Aqui os x de início de linha viram uma
    // ESCADA ORDINAL: o que importa a jusante é a ORDEM dos níveis, não a
    // distância em caracteres.
    const inicios = [...new Set(linhas.map((l) => Math.round(l[0].x * 10) / 10))].sort((a, b) => a - b);
    // A TOLERÂNCIA SAI DO PASSO DO PRÓPRIO DOCUMENTO, nunca de uma constante.
    // Um piso fixo de 3px era MAIOR que o passo do AOCP e fundia três níveis
    // num só — a escada 4/5/6/7 virava 4/6/6/6 e a folha ficava irmã do grupo.
    // O passo é o menor avanço real entre posições de início de linha.
    const avancos = inicios.slice(1).map((x, i) => x - inicios[i]).filter((d) => d > 0.4);
    const passo = avancos.length ? Math.min(...avancos) : larguraChar;
    const tolerancia = Math.max(0.5, passo * 0.5);
    const postos: number[] = [];
    for (const x of inicios) {
      if (postos.length === 0 || x - postos[postos.length - 1] > tolerancia) postos.push(x);
    }
    const postoDe = (x: number): number => {
      let melhor = 0;
      for (let i = 0; i < postos.length; i++) if (x >= postos[i] - tolerancia) melhor = i;
      return melhor;
    };

    for (const linha of linhas) {
      let montado = "";
      for (let i = 0; i < linha.length; i++) {
        if (i > 0) {
          const ant = linha[i - 1];
          const larguraAnt = ant.t.length > 0 && ant.w > 0 ? ant.w / ant.t.length : larguraChar;
          const lacuna = linha[i].x - (ant.x + ant.w);
          // Lacuna grande vira coluna (espaços proporcionais); lacuna pequena é
          // separação de palavra e vira UM espaço.
          //
          // O número partido pelo OCR ("614." + "387,53") NÃO chega aqui: a
          // `costurarNumeros` acima já o remontou. Foi esse o defeito que a
          // revisão pegou — sem a costura, o espaço obrigatório entre palavras
          // fazia o extrator ler R$ 387,53 no lugar de R$ 614.387,53, e passava
          // calado porque a folha corrompida não move o Ativo nem o Passivo.
          if (lacuna > larguraAnt * 1.5) montado += " ".repeat(Math.max(1, Math.round(lacuna / larguraAnt)));
          else montado += " ";
        }
        montado += linha[i].t;
      }
      // 2 espaços por nível: escada inequívoca para quem lê indentação.
      saida.push("  ".repeat(postoDe(linha[0].x)) + montado);
    }
  }
  return saida.join("\n");
}
