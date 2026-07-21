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
): Promise<ResultadoFixacao> {
  const fixados: DocumentoFixado[] = [];
  const erros: ErroFixacao[] = [];

  for (const documentId of documentIds) {
    const pool = await prisma.document.findFirst({
      where: { id: documentId, companyId: analysis.companyId, analysisId: null },
    });
    if (!pool) {
      erros.push({ documentId, erro: "Documento não encontrado na Data room da empresa." });
      continue;
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
 */
export function montarLinhaAdotada(doc: PoolDocMin & { companyId: string }): {
  analysisId: null; companyId: string; nome: string; tipo: string;
  competencia: string | null; moeda: string; storagePath: string | null;
  hash: string | null; tamanho: string | null; versao: number; status: string;
  dadosExtraidos?: object;
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
