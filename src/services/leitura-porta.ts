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
import { extrairComCascata, detectDocType, type DocParaCascata, type EscopoRegua } from "./extracao-cascata";
import { resolverCascataDicionario, whereCascataDicionarioAtiva } from "./dicionario-escopo";
import { resolverEscopoAcesso } from "./escopo-acesso";
import { loadActiveBPModel, loadActiveDREModel } from "./model-version";
import { IGNORAR_DESTINO } from "./account-mapper";
import { env } from "../config/env";
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
  /** Prova da cascata: qual nível venceu e o que fechou (a tela mostra o porquê). */
  integridade?: {
    fonte: "heuristico" | "hibrido" | "visao";
    score: number;
    /** Teto do score no escopo do documento (5 BP+DRE · 4 BP · 1 DRE). */
    scoreMax: number;
    fecha: boolean;
    equacaoPatrimonial: boolean;
    composicaoAtivo: boolean;
    composicaoPassivo: boolean;
  };
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
/** v3 (10/08/2026): a porta passou a usar a CASCATA COMPLETA do IBR
 *  (heurístico → Haiku → visão). Leituras da v2 são refeitas. */
/** v4 (10/08/2026): a prova da LEITURA deixou de ser afetada pela marcação de
 *  "ignorar" do analista — leituras da v3 guardaram integridade errada (caso
 *  Dunamys: 3/5 num balanço que fecha ao centavo) e são refeitas. */
export const VERSAO_LEITOR_DEMONSTRATIVO = 4;
const anoDe = (p: string): number => Number((p.match(/(\d{4})\s*$/) ?? [])[1] ?? 0);

/**
 * INSUMOS DA EMPRESA para a cascata — os MESMOS que o /process monta:
 * dicionário em cascata (global → workspace → empresa) resolvido por tipo, e
 * os modelos vigentes de BP/DRE. Rodando em BACKGROUND não há `req`, então o
 * escopo de acesso vem do DONO da empresa; sem isso a porta julgaria o
 * documento com dicionário vazio e daria score diferente do IBR.
 */
async function carregarInsumosDaEmpresa(companyId: string | null): Promise<{
  dictForBP: Array<{ nomeOriginal: string; contaDestino: string; grupoConta: string }>;
  dictForDRE: Array<{ nomeOriginal: string; contaDestino: string; grupoConta: string }>;
  bpModel: Awaited<ReturnType<typeof loadActiveBPModel>>;
  dreModel: Awaited<ReturnType<typeof loadActiveDREModel>>;
}> {
  const [bpModel, dreModel] = await Promise.all([
    loadActiveBPModel(companyId ?? undefined),
    loadActiveDREModel(companyId ?? undefined),
  ]);
  if (!companyId) return { dictForBP: [], dictForDRE: [], bpModel, dreModel };
  try {
    const empresa = await prisma.company.findUnique({ where: { id: companyId }, select: { userId: true } });
    if (!empresa) return { dictForBP: [], dictForDRE: [], bpModel, dreModel };
    const escopo = await resolverEscopoAcesso(empresa.userId);
    const entradas = await prisma.accountDictionary.findMany({
      where: whereCascataDicionarioAtiva(escopo.scopeUserIds, companyId),
      select: { nomeOriginal: true, contaDestino: true, grupoConta: true, userId: true, companyId: true, tipo: true },
    });
    const porTipo = (tipo: string) => resolverCascataDicionario(entradas, tipo).map((e) => ({
      nomeOriginal: e.nomeOriginal.toLowerCase(), contaDestino: e.contaDestino, grupoConta: e.grupoConta || "",
    }));
    return { dictForBP: porTipo("BP"), dictForDRE: porTipo("DRE"), bpModel, dreModel };
  } catch (e) {
    console.warn("[leitura-porta] dicionário da empresa indisponível (segue sem):", e instanceof Error ? e.message : e);
    return { dictForBP: [], dictForDRE: [], bpModel, dreModel };
  }
}

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

  // 2) CASCATA DO IBR — a MESMA função do /process (10/08/2026, pedido do dono:
  //    "faça exatamente a mesma coisa do IBR só que no Workspace").
  //    Heurístico → Haiku no texto → Sonnet no PDF, parando no primeiro nível
  //    que FECHA a integridade (equação patrimonial + composição dos dois lados
  //    + detalhe + DRE reconciliando). Era isso que faltava aqui: sem o degrau
  //    da visão, um BP lido pela metade virava número na tela.
  const semTexto = parsed.linhas.length === 0 && (!parsed.raw || parsed.raw.length < 200);
  if (semTexto && !/\.pdf$/i.test(nome)) {
    return { ...base, erro: "nenhum conteúdo legível reconhecido no arquivo" };
  }
  // PIN de período: com UM período conhecido a extração força tudo nele. Se a
  // competência declara um exercício que o detector NÃO achou (comparativo que
  // engoliu a coluna do exercício), o pin esmagaria as duas colunas numa só —
  // acrescenta o exercício declarado para a IA rotular pelas datas do documento.
  if (anoComp && !periodosDoc.some((p) => String(anoDe(p)) === anoComp)) {
    parsed = { ...parsed, periodos: [...periodosDoc, `31/12/${anoComp}`] };
  } else if (!parsed.periodos.length && periodosDoc.length) {
    parsed = { ...parsed, periodos: periodosDoc };
  }
  try {
    // MESMOS INSUMOS DO IBR: dicionário em cascata da empresa + modelos
    // vigentes. Rodando em background não existe `req` — o escopo de acesso
    // sai do DONO da empresa. Sem isto a porta julgaria o documento com um
    // dicionário vazio e daria score diferente do IBR para o mesmo arquivo.
    const insumos = await carregarInsumosDaEmpresa(ctx.companyId);
    // IGNORAR É DECISÃO DE MONTAGEM, NÃO DE LEITURA (10/08/2026 — caso Dunamys).
    // A conta "Lucros/Prejuízos Acumulados" estava marcada como ignorada no
    // dicionário da empresa. Na hora de MEDIR A EXTRAÇÃO isso derrubava
    // R$ 150.637,50 do PL, o balanço "não fechava" e o sistema acusava a
    // extração — que estava perfeita (Ativo = Passivo + PL = 801.403,25, igual
    // ao total impresso). Pior: a cascata escalava até a VISÃO tentando
    // consertar uma leitura correta. A prova da leitura mede o DOCUMENTO como
    // ele é; a conciliação, adiante, é que aplica as decisões do analista.
    const semIgnorar = (es: typeof insumos.dictForBP) => es.filter((e) => e.contaDestino !== IGNORAR_DESTINO);
    const insumosDaLeitura = { ...insumos, dictForBP: semIgnorar(insumos.dictForBP), dictForDRE: semIgnorar(insumos.dictForDRE) };
    // ESCOPO DA RÉGUA: um documento por vez não tem como provar as 5 provas.
    // O conteúdo decide (o `tipo` declarado é reserva) — e documento que traz
    // BP e DRE juntos (planilha "BP e DRE 2024.xlsx") volta ao escopo cheio.
    const doc: DocParaCascata = { nome, tipo, parsed, buffer: async () => buffer };
    const conteudo = detectDocType(parsed);
    const escopo: EscopoRegua = conteudo === "BOTH" ? "auto" : conteudo === "DRE" ? "DRE" : conteudo === "BP" ? "BP" : (ehBP ? "BP" : "DRE");
    const { escolhido, custoTotalUsd } = await comContextoIA(
      { produto: "data-room", origem: "leitura-porta-demonstrativo", companyId: ctx.companyId },
      () => extrairComCascata([doc], { ...insumosDaLeitura, hibridoAtivo: env.ibr.hibridoAtivo, origem: "porta", escopo, exigeArvore: true }),
    );
    const arvBP = renomearChaves((escolhido.arvoreBP ?? {}) as Record<string, unknown>);
    const arvDRE = renomearChaves((escolhido.arvoreDRE ?? {}) as Record<string, unknown>);
    // GUARDA AS DUAS ÁRVORES quando o documento traz as duas — o BP e a DRE no
    // mesmo arquivo é rotina em Excel de contabilidade, e guardar só uma
    // perdia metade do documento em silêncio.
    const temBP = Object.keys(arvBP).length > 0;
    const temDRE = Object.keys(arvDRE).length > 0;
    const periodos = [...new Set([...(temBP ? Object.keys(arvBP) : []), ...(temDRE ? Object.keys(arvDRE) : [])])];
    if (!periodos.length) {
      // O nível HEURÍSTICO não constrói árvore original (ele mapeia direto para
      // o modelo). Se ele venceu, a porta não tem o que guardar — e dizer
      // "não reconheceu colunas de período" seria mentira: o que faltou foi a
      // ESTRUTURA do documento (planilha achatada, aba sem hierarquia).
      const motivo = escolhido.fonte === "heuristico"
        ? "a leitura não reconheceu a hierarquia deste arquivo (planilha achatada ou sem coluna de período identificável) — confira o layout ou envie o PDF do demonstrativo"
        : "a extração não reconheceu colunas de período no documento";
      return { ...base, motor: escolhido.fonte === "heuristico" ? "deterministico" : "ia", custoUsd: custoTotalUsd, erro: motivo };
    }
    // Contas REALMENTE capturadas (a contagem do parser mede linhas do texto,
    // não contas do documento — número que enganava na tela).
    const contarNos = (arv: Record<string, unknown>): number => {
      let n = 0;
      const anda = (itens: unknown): void => {
        if (!Array.isArray(itens)) return;
        for (const it of itens as Array<{ filhos?: unknown }>) { n++; if (it?.filhos) anda(it.filhos); }
      };
      for (const capa of Object.values(arv)) {
        const grupos = (capa as { grupos?: Record<string, unknown> })?.grupos;
        if (grupos) for (const itens of Object.values(grupos)) anda(itens);
        else anda(capa);
      }
      return n;
    };
    const r = fecharLeitura({
      ...base, motor: escolhido.fonte === "heuristico" ? "deterministico" : "ia",
      ...(temBP ? { arvoreBP: arvBP } : {}),
      ...(temDRE ? { arvoreDRE: arvDRE, declarados: renomearChaves(escolhido.declarados) } : {}),
      periodos,
      totalContas: (temBP ? contarNos(arvBP) : 0) + (temDRE ? contarNos(arvDRE) : 0),
      custoUsd: custoTotalUsd,
    });
    // A PROVA VIAJA COM A LEITURA: quem consome sabe se o balanço fecha, sem
    // recalcular — e a tela pode dizer POR QUE não fecha.
    const v = escolhido.validacao;
    r.integridade = {
      fonte: escolhido.fonte, score: escolhido.score, scoreMax: escolhido.scoreMax, fecha: escolhido.fecha,
      equacaoPatrimonial: v.equacaoPatrimonial, composicaoAtivo: v.composicaoAtivo, composicaoPassivo: v.composicaoPassivo,
    };
    if (ehBP && !v.equacaoPatrimonial) {
      r.avisos.push("o balanço lido não fecha (Ativo ≠ Passivo + PL) mesmo depois da cascata completa de extração — confira o documento.");
    }
    return r;
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

/**
 * TETO DE LEITURAS SIMULTÂNEAS (10/08/2026). A Data room e a Conciliação
 * disparam `void gravarLeituraPorta` para CADA documento pendente ao abrir a
 * tela. Agora que a leitura pode escalar até a visão (Sonnet), dez documentos
 * numa empresa significavam dez cascatas ao mesmo tempo: pico de custo e uma
 * instância única do Cloud Run engasgada. Duas por vez — o resto espera.
 */
const TETO_SIMULTANEO = 2;
let emAndamento = 0;
const fila: Array<() => void> = [];
const entrarNaFila = (): Promise<void> =>
  emAndamento < TETO_SIMULTANEO
    ? ((emAndamento++), Promise.resolve())
    : new Promise<void>((resolve) => fila.push(() => { emAndamento++; resolve(); }));
const sairDaFila = (): void => {
  emAndamento--;
  const proximo = fila.shift();
  if (proximo) proximo();
};

export async function gravarLeituraPorta(documentId: string): Promise<void> {
  if (emLeitura.has(documentId)) return;
  emLeitura.add(documentId);
  await entrarNaFila();
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
    let tentativaAnterior = 0;
    if (ehDemonstrativo && doc.hash) {
      const atual = await prisma.documentoLeitura.findUnique({ where: { documentId: doc.id }, select: { hashArquivo: true, conteudo: true } });
      const c = atual?.conteudo as { erro?: string; versaoLeitor?: number; tentativas?: number; proximaTentativaEm?: string } | null;
      // Releitura quando: arquivo mudou, leitura com erro, ou LEITOR evoluiu.
      if (atual && atual.hashArquivo === doc.hash && !c?.erro && c?.versaoLeitor === VERSAO_LEITOR_DEMONSTRATIVO) return;
      // BACKOFF DA LEITURA QUE FALHA (10/08/2026): leitura com erro é reidratada
      // a cada listagem — e agora a cascata pode chegar à VISÃO. Sem freio, um
      // documento que sempre falha repaga IA em toda visita à Data room.
      if (atual && atual.hashArquivo === doc.hash && c?.erro) {
        tentativaAnterior = c.tentativas ?? 0;
        const proxima = c.proximaTentativaEm ? Date.parse(c.proximaTentativaEm) : 0;
        if (tentativaAnterior >= 3) return;                       // desiste: o analista reprocessa quando quiser
        if (proxima && Date.now() < proxima) return;              // ainda no intervalo
      }
    }
    const buffer = await downloadFile(doc.storagePath);
    const conteudo = ehBalancete
      ? await lerBalanceteDeterministico(buffer, doc.nome, doc.competencia)
      : await lerDemonstrativoHibrido(buffer, doc.nome, doc.tipo, doc.competencia, { companyId: doc.companyId, documentId: doc.id });
    if (ehDemonstrativo && (conteudo as { erro?: string }).erro) {
      const tentativas = tentativaAnterior + 1;
      Object.assign(conteudo, {
        tentativas,
        proximaTentativaEm: new Date(Date.now() + tentativas * 10 * 60_000).toISOString(),
      });
    }
    await prisma.documentoLeitura.upsert({
      where: { documentId: doc.id },
      create: { documentId: doc.id, hashArquivo: doc.hash, conteudo: conteudo as unknown as object },
      update: { hashArquivo: doc.hash, conteudo: conteudo as unknown as object, criadoEm: new Date() },
    });
  } catch (e) {
    console.warn(`[leitura-porta] falhou para ${documentId} (upload segue normal):`, e instanceof Error ? e.message : e);
  } finally {
    sairDaFila();
    emLeitura.delete(documentId);
  }
}
