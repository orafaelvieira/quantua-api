/**
 * LEITURA NA PORTA (08/08/2026) — F1 do "realizado sem passar pelo IBR".
 *
 * Todo BALANCETE que entra no POOL da Data room da empresa é lido aqui,
 * DETERMINISTICAMENTE (parser tabular/PDF-texto + provas aritméticas da
 * conversão) — sem IA, sem OCR, custo zero. O resultado fica em
 * `DocumentoLeitura` (tabela própria, um-para-um com o documento) e qualquer
 * produto consome: o orçamento importa o realizado dali (F2), e o IBR poderá
 * reusar no futuro (F3) — hoje o caminho do IBR segue INTOCADO.
 *
 * Regras da casa que este arquivo respeita:
 * - NÃO grava em Document.dadosExtraidos: aquele campo participa das regras do
 *   IBR (herança de resumo na fixação; trava "já processado" na exclusão do
 *   pool) — a leitura da porta não pode mudar comportamento nenhum de lá.
 * - Falha de leitura NUNCA quebra o upload: roda em background (void), grava o
 *   erro no próprio registro e segue — documento ilegível é fato a mostrar,
 *   não exceção a estourar.
 * - Substituição troca o arquivo: a leitura carimba o hash do arquivo lido e
 *   quem consome confere (hash divergente = leitura de versão anterior).
 */
import { prisma } from "../db/client";
import { downloadFile } from "./storage";
import { extrairTextoLayoutPDF } from "./parser";
import { parseBalanceteTabular, ehArquivoTabular } from "./balancete-tabular";
import { parseBalanceteTexto, pareceBalancete, type BalanceteParseado, type LinhaBalancete } from "./balancete-parser";
import { converterBalancete, type ProvasBalancete } from "./balancete-conversao";

export interface LeituraPortaConteudo {
  versao: 1;
  origem: "tabular" | "pdf-texto";
  periodoInicio: string | null;
  periodoFim: string | null;
  /** Linhas FOLHA do balancete, no plano do cliente (código, nome, saldos). */
  linhas: LinhaBalancete[];
  totalContas: number;
  /** Provas aritméticas da conversão (P1 débito=crédito · P2 fechamento
   *  patrimonial · P3 coerência linha a linha) — "verde só com prova". */
  provas: ProvasBalancete | null;
  avisos: string[];
  /** Preenchido quando o documento não pôde ser lido deterministicamente
   *  (escaneado, não-balancete, formato desconhecido). Sem erro = leitura ok. */
  erro?: string;
}

/** Lê um balancete de um buffer, sem tocar em banco — puro e testável. */
export async function lerBalanceteDeterministico(
  buffer: Buffer,
  nome: string,
  competencia?: string | null,
): Promise<LeituraPortaConteudo> {
  const base: LeituraPortaConteudo = {
    versao: 1, origem: ehArquivoTabular(nome) ? "tabular" : "pdf-texto",
    periodoInicio: null, periodoFim: null, linhas: [], totalContas: 0,
    provas: null, avisos: [],
  };
  let parseado: BalanceteParseado | null = null;
  if (ehArquivoTabular(nome)) {
    parseado = parseBalanceteTabular(buffer, nome, competencia ?? null);
  } else if (/\.pdf$/i.test(nome)) {
    const texto = await extrairTextoLayoutPDF(buffer);
    if (!texto || texto.length < 300) {
      return { ...base, erro: "PDF sem camada de texto (escaneado?) — a leitura determinística não alcança; use o fluxo com OCR do produto." };
    }
    const parece = pareceBalancete(texto);
    if (!parece.balancete) {
      return { ...base, erro: `O conteúdo não parece um balancete (${parece.evidencias.join("; ") || "sem as colunas esperadas"}).` };
    }
    parseado = parseBalanceteTexto(texto);
  } else {
    return { ...base, erro: `Formato não suportado pela leitura determinística: ${nome.split(".").pop()}` };
  }
  if (!parseado || parseado.linhas.length === 0) {
    return { ...base, erro: "Nenhuma linha de conta reconhecida no documento.", avisos: parseado?.avisos ?? [] };
  }
  // A conversão dá as PROVAS (e detecta grupo-espelho); a leitura da porta
  // guarda as linhas cruas + provas — o fold canônico é decisão de cada
  // produto, nunca da porta.
  let provas: ProvasBalancete | null = null;
  const avisos = [...parseado.avisos];
  try {
    const conv = converterBalancete(parseado);
    provas = conv.provas;
    avisos.push(...conv.avisos.filter((a) => !avisos.includes(a)));
    for (const g of conv.gruposExcluidos) {
      avisos.push(`Grupo-espelho fora das demonstrações: ${g.nome} (${g.contas} contas).`);
    }
  } catch (e) {
    avisos.push(`Provas indisponíveis: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    ...base,
    periodoInicio: parseado.periodoInicio,
    periodoFim: parseado.periodoFim,
    linhas: parseado.linhas,
    totalContas: parseado.linhas.length,
    provas,
    avisos,
  };
}

/** Resumo curto para listagens (o conteúdo integral fica no registro). */
export function resumoDaLeitura(c: LeituraPortaConteudo): {
  ok: boolean; contas: number; periodo: string | null; fechamentoOk: boolean | null; erro: string | null;
} {
  return {
    ok: !c.erro,
    contas: c.totalContas,
    periodo: c.periodoInicio && c.periodoFim ? `${c.periodoInicio} a ${c.periodoFim}` : null,
    fechamentoOk: c.provas ? c.provas.fechamento.ok && c.provas.linhas.ok : null,
    erro: c.erro ?? null,
  };
}

/** Baixa, lê e grava a leitura de um documento do pool — para rodar em
 *  BACKGROUND no upload/substituição (`void gravarLeituraPorta(id)`).
 *  Engole toda falha com log: a porta nunca derruba o upload. */
export async function gravarLeituraPorta(documentId: string): Promise<void> {
  try {
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, nome: true, tipo: true, competencia: true, storagePath: true, hash: true, analysisId: true },
    });
    // Só documento do POOL (analysisId null): a linha fixada do IBR tem o
    // próprio pipeline e não é assunto da porta.
    if (!doc || doc.analysisId || !doc.storagePath) return;
    if (!/balancete/i.test(doc.tipo)) return;
    const buffer = await downloadFile(doc.storagePath);
    const conteudo = await lerBalanceteDeterministico(buffer, doc.nome, doc.competencia);
    await prisma.documentoLeitura.upsert({
      where: { documentId: doc.id },
      create: { documentId: doc.id, hashArquivo: doc.hash, conteudo: conteudo as unknown as object },
      update: { hashArquivo: doc.hash, conteudo: conteudo as unknown as object, criadoEm: new Date() },
    });
  } catch (e) {
    console.warn(`[leitura-porta] falhou para ${documentId} (upload segue normal):`, e instanceof Error ? e.message : e);
  }
}
