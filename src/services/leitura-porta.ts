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
import { extrairTextoLayoutPDF, parseDocument, type ExtractedRow } from "./parser";
import { parseBalanceteTabular, ehArquivoTabular } from "./balancete-tabular";
import { parseBalanceteTexto, pareceBalancete, type BalanceteParseado, type LinhaBalancete } from "./balancete-parser";
import { converterBalancete, type ProvasBalancete } from "./balancete-conversao";
import { construirArvoreBPporIndentacao } from "./bp-tree-indent";
import { construirArvoreDREporIndentacao } from "./dre-tree-indent";
import { extractFinancialsWithAI } from "./ai-extraction";
import { comContextoIA } from "./ai-usage";

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

/** Leitura de DEMONSTRATIVO (DRE / Balanço Patrimonial) — 10/08/2026, pedido
 *  do dono: "não é apenas balancete — também balanço patrimonial e DRE".
 *  HÍBRIDA como no IBR: a linha DETERMINÍSTICA primeiro (árvore do BP por
 *  indentação; árvore da DRE com prova de partição — custo zero); quando ela
 *  não alcança, a MESMA extração de IA do IBR, com custo carimbado no escopo
 *  da EMPRESA (regra da casa: nenhum consumidor de IA sem trilha). A leitura
 *  fica gravada por hash do arquivo — reclassificar conta NUNCA repaga IA. */
export interface LeituraDemonstrativoConteudo {
  versao: 1;
  /** Versão do leitor que produziu esta leitura (releitura quando muda). */
  versaoLeitor?: number;
  tipoLeitura: "demonstrativo";
  motor: "deterministico" | "ia";
  /** Períodos canônicos ("31/12/AAAA") — colunas que o documento carrega. */
  periodos: string[];
  /** Árvore ORIGINAL (mesmo shape do IBR) — só o lado do documento. */
  arvoreBP?: unknown;
  arvoreDRE?: unknown;
  declarados?: Record<string, Record<string, number>>;
  custoUsd?: number;
  totalContas: number;
  /** Compat com resumoDaLeitura/pool (o demonstrativo não tem intervalo). */
  periodoInicio: null;
  periodoFim: null;
  provas: null;
  linhas: [];
  avisos: string[];
  erro?: string;
}

const canonicoAno = (p: string) => (/^\d{4}$/.test(p.trim()) ? `31/12/${p.trim()}` : p.trim());
const renomearChaves = <T,>(obj: Record<string, T>): Record<string, T> => {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) out[canonicoAno(k)] = v;
  return out;
};
/** Versão do LEITOR de demonstrativo — incrementar força releitura das
 *  gravadas (10/08/2026: v2 = colunas em ordem decrescente p/ o builder +
 *  aviso de competência divergente). */
export const VERSAO_LEITOR_DEMONSTRATIVO = 2;
const anoDe = (p: string): number => Number((p.match(/(\d{4})\s*$/) ?? [])[1] ?? 0);

export async function lerDemonstrativoHibrido(
  buffer: Buffer,
  nome: string,
  tipo: string,
  competencia: string | null | undefined,
  ctx: { companyId: string | null; documentId?: string },
): Promise<LeituraDemonstrativoConteudo> {
  const base: LeituraDemonstrativoConteudo = {
    versao: 1, versaoLeitor: VERSAO_LEITOR_DEMONSTRATIVO, tipoLeitura: "demonstrativo", motor: "deterministico",
    periodos: [], totalContas: 0,
    periodoInicio: null, periodoFim: null, provas: null, linhas: [],
    avisos: [],
  };
  const ehBP = /balan/i.test(tipo);
  // COMPETÊNCIA declarada ≠ período lido = aviso na cara (10/08/2026, caso
  // "BP 2022.pdf → 31/12/2021"): o documento pode ser mesmo do outro ano OU o
  // comparativo pode ter engolido a coluna do exercício — o analista decide.
  const anoComp = competencia && /^\d{4}$/.test(competencia.trim()) ? competencia.trim() : null;
  const fecharLeitura = (r: LeituraDemonstrativoConteudo): LeituraDemonstrativoConteudo => {
    if (anoComp && r.periodos.length && !r.periodos.some((p) => String(anoDe(p)) === anoComp)) {
      r.avisos.push(`competência declarada ${anoComp}, mas o documento traz ${r.periodos.join(" · ")} — confira se o arquivo é do exercício certo.`);
    }
    return r;
  };
  let parsed: Awaited<ReturnType<typeof parseDocument>>;
  try {
    parsed = await parseDocument(buffer, nome, tipo);
  } catch (e) {
    return { ...base, erro: `não foi possível ler o arquivo (${e instanceof Error ? e.message : String(e)})` };
  }
  const periodosDoc = parsed.periodos.length
    ? parsed.periodos
    : (competencia && /^\d{4}$/.test(competencia) ? [competencia] : []);

  // 1) Linha determinística (custo zero) — a mesma do IBR.
  if (ehBP) {
    // O builder do BP mapeia coluna→período por ÍNDICE sobre o texto cru, e o
    // detector devolve as datas em ordem CRESCENTE — mas o BP comparativo
    // brasileiro imprime o exercício ATUAL à esquerda. Ordem DECRESCENTE aqui,
    // senão a coluna de 2022 ganharia o rótulo de 2021 (e vice-versa).
    const colunas = [...periodosDoc].sort((a, b) => anoDe(b) - anoDe(a) || b.localeCompare(a));
    const arv = construirArvoreBPporIndentacao(parsed, colunas);
    if (arv) {
      const canon = renomearChaves(arv as Record<string, unknown>);
      return fecharLeitura({ ...base, motor: "deterministico", arvoreBP: canon, periodos: Object.keys(canon), totalContas: parsed.linhas.length });
    }
  } else {
    const det = construirArvoreDREporIndentacao(parsed.linhas, periodosDoc);
    if (det) {
      const canon = renomearChaves(det.secoes as Record<string, unknown>);
      return fecharLeitura({
        ...base, motor: "deterministico", arvoreDRE: canon, periodos: Object.keys(canon),
        declarados: renomearChaves(det.declarados), totalContas: parsed.linhas.length,
      });
    }
  }

  // 2) IA — a MESMA extração do IBR (que ainda tenta o determinístico por
  //    dentro), com o gasto atribuído à empresa via contexto.
  const semTexto = parsed.linhas.length === 0 && (!parsed.raw || parsed.raw.length < 200);
  if (semTexto && !/\.pdf$/i.test(nome)) {
    return { ...base, erro: "nenhum conteúdo legível reconhecido no arquivo" };
  }
  // raw = contexto>conta (p/ o LLM) · rawIndent = texto INDENTADO do parser
  // (p/ a árvore determinística interna) — o MESMO contrato do /process.
  const linhasToText = (linhas: ExtractedRow[]) =>
    linhas.map((l) => `${l.contexto ? l.contexto + " > " : ""}${l.conta} = ${JSON.stringify(l.valores)}`).join("\n");
  // PIN de período: com UM período conhecido a extração força tudo nele. Se a
  // competência declara um exercício que o detector NÃO achou (comparativo que
  // engoliu a coluna do exercício), o pin esmagaria as duas colunas numa só —
  // acrescenta o exercício declarado para a IA rotular pelas datas do documento.
  const periodosIA = anoComp && !periodosDoc.some((p) => String(anoDe(p)) === anoComp)
    ? [...periodosDoc, `31/12/${anoComp}`]
    : periodosDoc;
  const aiDoc = parsed.linhas.length
    ? { raw: linhasToText(parsed.linhas), rawIndent: parsed.raw, linhas: parsed.linhas, tipo, periodos: periodosIA }
    : { buffer, tipo, periodos: periodosIA };
  try {
    const r = await comContextoIA(
      { produto: "data-room", origem: "leitura-porta-demonstrativo", companyId: ctx.companyId },
      () => extractFinancialsWithAI([aiDoc], periodosIA),
    );
    const arvBP = renomearChaves(r.arvoreOriginalBP as Record<string, unknown>);
    const arvDRE = renomearChaves(r.arvoreOriginalDRE as unknown as Record<string, unknown>);
    const periodos = ehBP ? Object.keys(arvBP) : Object.keys(arvDRE);
    if (!periodos.length) return { ...base, motor: "ia", custoUsd: r.custo.usd, erro: "a extração não reconheceu colunas de período no documento" };
    return fecharLeitura({
      ...base, motor: "ia",
      ...(ehBP ? { arvoreBP: arvBP } : { arvoreDRE: arvDRE, declarados: renomearChaves(r.declarados) }),
      periodos, totalContas: parsed.linhas.length, custoUsd: r.custo.usd,
    });
  } catch (e) {
    return { ...base, erro: `extração falhou (${e instanceof Error ? e.message : String(e)})` };
  }
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
const DEMONSTRATIVO_RE = /^(dre|balan[çc]o patrimonial)$/i;
/** Documentos em leitura NESTE processo (instância única): a leitura de
 *  demonstrativo pode pagar IA — duas chamadas simultâneas pagariam duas. */
const emLeitura = new Set<string>();

export async function gravarLeituraPorta(documentId: string): Promise<void> {
  if (emLeitura.has(documentId)) return;
  emLeitura.add(documentId);
  try {
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, nome: true, tipo: true, competencia: true, storagePath: true, hash: true, analysisId: true, companyId: true },
    });
    // Só documento do POOL (analysisId null): a linha fixada do IBR tem o
    // próprio pipeline e não é assunto da porta.
    if (!doc || doc.analysisId || !doc.storagePath) return;
    const ehBalancete = /balancete/i.test(doc.tipo);
    const ehDemonstrativo = DEMONSTRATIVO_RE.test(doc.tipo.trim());
    if (!ehBalancete && !ehDemonstrativo) return;
    // DEMONSTRATIVO com leitura BOA do MESMO arquivo (hash) não se refaz —
    // pode ter custado IA e o custo é um só por versão do arquivo. Leitura com
    // ERRO pode tentar de novo (falha transitória de IA não pode congelar o
    // documento). Balancete (custo zero) mantém o comportamento de sempre.
    if (ehDemonstrativo && doc.hash) {
      const atual = await prisma.documentoLeitura.findUnique({ where: { documentId: doc.id }, select: { hashArquivo: true, conteudo: true } });
      const c = atual?.conteudo as { erro?: string; versaoLeitor?: number } | null;
      // Releitura quando: arquivo mudou, leitura com erro, ou LEITOR evoluiu.
      if (atual && atual.hashArquivo === doc.hash && !c?.erro && c?.versaoLeitor === VERSAO_LEITOR_DEMONSTRATIVO) return;
    }
    const buffer = await downloadFile(doc.storagePath);
    const conteudo = ehBalancete
      ? await lerBalanceteDeterministico(buffer, doc.nome, doc.competencia)
      : await lerDemonstrativoHibrido(buffer, doc.nome, doc.tipo, doc.competencia, { companyId: doc.companyId, documentId: doc.id });
    await prisma.documentoLeitura.upsert({
      where: { documentId: doc.id },
      create: { documentId: doc.id, hashArquivo: doc.hash, conteudo: conteudo as unknown as object },
      update: { hashArquivo: doc.hash, conteudo: conteudo as unknown as object, criadoEm: new Date() },
    });
  } catch (e) {
    console.warn(`[leitura-porta] falhou para ${documentId} (upload segue normal):`, e instanceof Error ? e.message : e);
  } finally {
    emLeitura.delete(documentId);
  }
}
