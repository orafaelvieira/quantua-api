/**
 * FIXAÇÃO DE DOCUMENTOS DO POOL (Data room única, fase B — Parte 12 do plano).
 *
 * O IBR não recebe mais uploads próprios: ele SELECIONA documentos da Data room
 * da empresa e os FIXA. Fixar cria uma linha própria do IBR (analysisId
 * preenchido) apontando para a linha do pool via fixadoDeId:
 *  (a) proveniência congelada — a linha do pool é imutável (substituir cria
 *      linha NOVA), então fixadoDe.versao é o selo "usa Balancete jun/26 v3";
 *  (b) espaço de trabalho da fotografia — dadosExtraidos e correções manuais
 *      são estado DO IBR; linha compartilhada vazaria correções entre IBRs.
 *
 * O ARQUIVO é guardado UMA vez: a linha fixada reaproveita o storagePath do
 * pool — por isso a exclusão de uma fixação NUNCA apaga o arquivo do storage.
 *
 * Materiais complementares: o resumo de IA é pago 1× por VERSÃO de arquivo —
 * a fixação herda dadosExtraidos.resumo quando o pool já o tem (status nasce
 * "Processado"); sem resumo, nasce "Pendente" e o primeiro uso resume e grava
 * o cache TAMBÉM na linha do pool (write-back em material-context).
 */
import { prisma } from "../db/client";
import { MATERIAL_TIPO } from "./material-context";
import { insumosDaBase, montarBaseContabil } from "./base-contabil";
import { resolverEscopoAcesso } from "./escopo-acesso";

export interface DocumentoFixado {
  id: string;
  nome: string;
  tipo: string;
  competencia: string | null;
  moeda: string;
  status: string;
  tamanho: string | null;
  versao: number;
  fixadoDeId: string | null;
  /** true = fixação já existia neste IBR (chamada idempotente). */
  jaExistia: boolean;
}

export interface ErroFixacao {
  documentId: string;
  erro: string;
  /** Gate W2: ao tentar fixar versão substituída, aponta a vigente. */
  vigenteId?: string;
}

export interface ResultadoFixacao {
  fixados: DocumentoFixado[];
  erros: ErroFixacao[];
}

type DocRow = NonNullable<Awaited<ReturnType<typeof prisma.document.findFirst>>>;

/** Campos do documento do pool que a montagem da linha fixada consome. */
export interface PoolDocMin {
  id: string;
  nome: string;
  tipo: string;
  competencia: string | null;
  moeda: string;
  storagePath: string | null;
  hash: string | null;
  tamanho: string | null;
  versao: number;
  dadosExtraidos: unknown;
}

/**
 * PURA: monta os dados da linha fixada a partir do documento do pool.
 * Regras: arquivo compartilhado (mesmo storagePath), versão ESPELHADA (é o selo
 * de proveniência), material com resumo herda o cache e nasce "Processado".
 */
export function montarLinhaFixada(
  pool: PoolDocMin,
  analysis: { id: string; companyId: string },
): {
  analysisId: string; companyId: string; nome: string; tipo: string;
  competencia: string | null; moeda: string; storagePath: string | null;
  hash: string | null; tamanho: string | null; versao: number; status: string;
  fixadoDeId: string; dadosExtraidos?: object;
} {
  const cache = pool.dadosExtraidos as { resumo?: string } | null;
  const herdaResumo = pool.tipo === MATERIAL_TIPO && !!cache?.resumo;
  return {
    analysisId: analysis.id,
    companyId: analysis.companyId,
    nome: pool.nome,
    tipo: pool.tipo,
    competencia: pool.competencia,
    moeda: pool.moeda,
    storagePath: pool.storagePath,
    hash: pool.hash,
    tamanho: pool.tamanho,
    versao: pool.versao,
    status: herdaResumo ? "Processado" : "Pendente",
    ...(herdaResumo ? { dadosExtraidos: pool.dadosExtraidos as object } : {}),
    fixadoDeId: pool.id,
  };
}

function shape(d: DocRow, jaExistia: boolean): DocumentoFixado {
  return {
    id: d.id, nome: d.nome, tipo: d.tipo, competencia: d.competencia,
    moeda: d.moeda, status: d.status, tamanho: d.tamanho, versao: d.versao,
    fixadoDeId: d.fixadoDeId, jaExistia,
  };
}

export async function fixarDocumentosDoPool(
  analysis: { id: string; companyId: string },
  documentIds: string[],
  scopeUserIds?: string[],
): Promise<ResultadoFixacao> {
  const fixados: DocumentoFixado[] = [];
  const erros: ErroFixacao[] = [];

  // A RÉGUA DA CONCILIAÇÃO É UMA SÓ, E É A DA BASE (12/08/2026).
  //
  // Existiam duas: a tela lia `conciliacaoPorDocumento` da base e esta função
  // recalculava por conta própria em conciliacao-documento.ts. Elas discordavam
  // num caso real e visível — leitura DETERMINÍSTICA de demonstrativo não grava
  // `integridade` (não passa pela cascata), a base considerava o documento
  // conciliado e a fixação respondia "a leitura não registrou as provas de
  // integridade". O analista via ✓ em todos os documentos da lista e um X
  // vermelho ao tentar usá-los. Regra da casa: dois caminhos para o mesmo
  // julgamento divergem sempre — agora é um.
  const escopo = scopeUserIds ?? (await (async () => {
    // Chamada sem escopo (rota legada): resolve pelo DONO da empresa, como a
    // leitura da porta já faz quando roda em background.
    const empresa = await prisma.company.findUnique({ where: { id: analysis.companyId }, select: { userId: true } });
    return empresa ? (await resolverEscopoAcesso(empresa.userId)).scopeUserIds : [];
  })());
  const insumos = await insumosDaBase(analysis.companyId, escopo);
  const base = await montarBaseContabil(analysis.companyId, escopo, insumos);
  const conciliacao = base.conciliacaoPorDocumento as Record<string, { ok: boolean; motivos: string[] }>;

  for (const documentId of documentIds) {
    const pool = await prisma.document.findFirst({
      where: { id: documentId, companyId: analysis.companyId, analysisId: null },
    });
    if (!pool) {
      erros.push({ documentId, erro: "Documento não encontrado na Data room da empresa." });
      continue;
    }

    // GARANTIA 6 (10/08/2026, palavras do dono): "documentos que ainda não
    // foram conciliados 100% não podem ser usados em IBR". A tela avisa antes,
    // mas a trava mora AQUI — chamada direta à API não pode furar a regra.
    // Material complementar fica fora: não vira número, não tem o que conciliar.
    if (!/material complementar/i.test(pool.tipo)) {
      const conc = conciliacao[pool.id];
      if (conc && !conc.ok) {
        erros.push({
          documentId,
          erro: `"${pool.nome}" ainda não está conciliado: ${conc.motivos.join(" · ")}. Trate na aba Conciliação contábil da empresa e tente de novo.`,
        });
        continue;
      }
    }

    // Gate W2: "existe v3 e você está fixando v2" — recusa e aponta a vigente.
    if (pool.status === "Substituído") {
      let vigente = pool;
      for (let i = 0; vigente.substituidoPorId && i < 50; i++) {
        const prox = await prisma.document.findUnique({ where: { id: vigente.substituidoPorId } });
        if (!prox) break;
        vigente = prox;
      }
      erros.push({
        documentId,
        erro: `Este documento foi substituído (v${pool.versao}) — fixe a versão vigente (v${vigente.versao}).`,
        vigenteId: vigente.id,
      });
      continue;
    }

    // Idempotente: o mesmo documento do pool fixado de novo no mesmo IBR reusa
    // a fixação viva (substituída dentro do IBR = cadeia própria, não reusa).
    const existente = await prisma.document.findFirst({
      where: { analysisId: analysis.id, fixadoDeId: pool.id, status: { not: "Substituído" } },
    });
    if (existente) {
      fixados.push(shape(existente, true));
      continue;
    }

    const novo = await prisma.document.create({ data: montarLinhaFixada(pool, analysis) });
    fixados.push(shape(novo, false));
  }

  return { fixados, erros };
}

/**
 * ADOÇÃO de documento LEGADO (subido direto num IBR, antes da Data room única)
 * como linha do POOL — PURA. O arquivo continua guardado UMA vez (mesmo
 * storagePath); a linha do IBR fica intocada (evidência dele, zero retrocesso).
 * Material com resumo herda o cache (pago 1× por versão de arquivo).
 *
 * DATA ORIGINAL (2026-07-21): a linha do pool nasce com o createdAt DO LEGADO,
 * não o da adoção — a adoção é catalogação, não chegada de documento novo.
 * Sem isso, adotar legado de período já fechado acendia o falso "retificado
 * após fechamento" (caso real AOCP: docs de 2023 adotados em jul/26 apareciam
 * como retificação de exercício fechado).
 */
export function montarLinhaAdotada(doc: PoolDocMin & { companyId: string; createdAt: Date }): {
  analysisId: null; companyId: string; nome: string; tipo: string;
  competencia: string | null; moeda: string; storagePath: string | null;
  hash: string | null; tamanho: string | null; versao: number; status: string;
  createdAt: Date; dadosExtraidos?: object;
} {
  const cache = doc.dadosExtraidos as { resumo?: string } | null;
  const herdaResumo = doc.tipo === MATERIAL_TIPO && !!cache?.resumo;
  return {
    analysisId: null,
    companyId: doc.companyId,
    nome: doc.nome,
    tipo: doc.tipo,
    competencia: doc.competencia,
    moeda: doc.moeda,
    storagePath: doc.storagePath,
    hash: doc.hash,
    tamanho: doc.tamanho,
    versao: 1, // cadeia NOVA no pool — versões futuras nascem aqui
    status: herdaResumo ? "Processado" : "Pendente",
    createdAt: doc.createdAt, // data ORIGINAL do upload no IBR
    ...(herdaResumo ? { dadosExtraidos: doc.dadosExtraidos as object } : {}),
  };
}

/**
 * Metadados corrigidos na linha do POOL (tipo/competência/moeda) escorrem para
 * as fixações ainda Pendentes — o pipeline lê a linha fixada, e uma correção
 * feita antes da extração é fato do documento, não estado do IBR. Fixações já
 * processadas não são tocadas (fotografia do IBR é imutável por fora).
 */
export async function propagarMetadadosDoPool(
  poolDocId: string,
  data: { tipo?: string; competencia?: string | null; moeda?: string },
): Promise<void> {
  if (Object.keys(data).length === 0) return;
  await prisma.document.updateMany({
    where: { fixadoDeId: poolDocId, status: "Pendente" },
    data,
  });
}

/**
 * GARANTIA 7 — o CONJUNTO de documentos contábeis deste IBR já fundamentou
 * outro? Compara o conjunto de documentos do POOL (fixadoDeId) — a identidade
 * do insumo, não a da linha fixada.
 *
 * Casos LEGÍTIMOS que a regra NÃO pode quebrar (revisão do fluxo do analista):
 *  - IBR CANCELADO: não é entrega, não conta;
 *  - NOVA VERSÃO do mesmo produto (mesmo `produtoId`): NÃO dispara. Versão é a
 *    evolução do MESMO trabalho — usar os mesmos documentos ali é a definição
 *    de versionar. Antes disparava como 409 confirmável, e o texto mandava
 *    "use Nova versão" para quem já ESTAVA na nova versão (flagrado pelo dono,
 *    14/08/2026): aviso autocontraditório treina o analista a confirmar sem
 *    ler, que é justamente o que mata o valor da garantia nos casos reais;
 *  - dois IBRs de períodos diferentes que compartilham UM balancete: conjuntos
 *    diferentes, não dispara.
 */
export async function conjuntoJaUsadoEmOutroIBR(
  analysisId: string,
  companyId: string,
): Promise<{ analysisId: string; nome: string; status: string; documentos: number } | null> {
  const contabil = (tipo: string) => !/material complementar/i.test(tipo);
  const [meus, eu] = await Promise.all([
    prisma.document.findMany({
      where: { analysisId, fixadoDeId: { not: null } },
      select: { fixadoDeId: true, tipo: true },
    }),
    prisma.analysis.findUnique({ where: { id: analysisId }, select: { produtoId: true } }),
  ]);
  const meuConjunto = new Set(meus.filter((d) => contabil(d.tipo)).map((d) => d.fixadoDeId!));
  if (meuConjunto.size === 0) return null;

  const outros = await prisma.document.findMany({
    where: { companyId, analysisId: { not: null, notIn: [analysisId] }, fixadoDeId: { in: [...meuConjunto] } },
    select: { analysisId: true, fixadoDeId: true, tipo: true, analysis: { select: { nome: true, status: true, produtoId: true } } },
  });
  const porAnalise = new Map<string, { nome: string; status: string; docs: Set<string> }>();
  for (const d of outros) {
    if (!d.analysisId || !d.fixadoDeId || !contabil(d.tipo)) continue;
    if (d.analysis?.status === "Cancelada") continue;
    // Versões do MESMO produto compartilham os insumos por definição.
    if (eu?.produtoId && d.analysis?.produtoId === eu.produtoId) continue;
    const atual = porAnalise.get(d.analysisId) ?? { nome: d.analysis?.nome ?? "IBR", status: d.analysis?.status ?? "?", docs: new Set<string>() };
    atual.docs.add(d.fixadoDeId);
    porAnalise.set(d.analysisId, atual);
  }
  for (const [id, a] of porAnalise) {
    // MESMO conjunto: todo documento meu está lá (o outro pode ter mais — se
    // tem mais, é um trabalho de escopo maior, não repetição).
    const cobreTudo = [...meuConjunto].every((d) => a.docs.has(d));
    if (cobreTudo) return { analysisId: id, nome: a.nome, status: a.status, documentos: meuConjunto.size };
  }
  return null;
}
