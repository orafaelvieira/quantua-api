/**
 * SNAPSHOT AUTOMÁTICO DIÁRIO (rede de segurança tipo Excel, 2026-07-21).
 *
 * O cron fotografa 1×/dia o estado EDITÁVEL de cada IBR e de cada modelo:
 * o que um clique errado pode destruir (extrações, correções manuais,
 * projeções, configs de bloco). Dedup por hash — dia sem mudança não grava.
 * Restaurar volta ao estado da foto; antes disso o estado ATUAL é fotografado
 * ("pre-restauracao") — a restauração nunca destrói nada.
 *
 * O que NÃO entra na foto (de propósito):
 *  - assinatura e reviewMeta (governança: atos, não conteúdo);
 *  - envelope de produto (produtoId/produtoVersao) e ehTeste (organização);
 *  - arquivos do storage (imutáveis por construção — a foto guarda metadados).
 *
 * Regras de restauração:
 *  - status VOLTA junto com o conteúdo (a foto é o estado inteiro, estilo
 *    Excel), EXCETO "Concluída"/"Concluído": conclusão é ATO com trilha —
 *    restaurar conteúdo jamais re-conclui um produto reaberto.
 *  - documento/bloco/cenário que não existe mais NÃO é recriado (a exclusão
 *    teve guarda e trilha próprias) — é reportado como ignorado.
 *
 * Puras e determinísticas, sem I/O — o job e as rotas fazem o acesso a banco.
 */
import crypto from "crypto";

/** Status em que a foto NÃO é tirada (estado a meio caminho de um processamento). */
export const STATUS_TRANSITORIOS = ["Extraindo", "Gerando diagnóstico"];

/** Quantas fotos automáticas ficam por entidade (as "pre-restauracao" nunca são podadas). */
export const MAX_FOTOS_AUTO = 30;

export function hashConteudo(conteudo: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(conteudo)).digest("hex");
}

// ── IBR (Analysis) ──────────────────────────────────────────────────────────

/** Campos do IBR que a foto captura e a restauração devolve. */
export const CAMPOS_FOTO_ANALISE = [
  "periodo", "status", "confianca", "resultado", "dadosEstruturados",
  "indicadorConfig", "documentChecklist", "stcf", "scenarios", "options",
  "projections", "executiveSummary", "questionnaire", "dores",
  "sectorId", "sectorCustom", "setorConfirmado",
] as const;

export interface DocFoto {
  id: string;
  nome: string;
  tipo: string;
  competencia: string | null;
  moeda: string;
  status: string;
  confianca: number | null;
  dadosExtraidos: unknown;
  editadoManualmente: boolean;
  versao: number;
  hash: string | null;
  fixadoDeId: string | null;
}

export interface ConteudoFotoAnalise {
  analysis: Record<string, unknown>;
  documentos: DocFoto[];
}

export function montarConteudoAnalise(
  analysis: Record<string, unknown>,
  documentos: DocFoto[],
): ConteudoFotoAnalise {
  const foto: Record<string, unknown> = {};
  for (const campo of CAMPOS_FOTO_ANALISE) foto[campo] = analysis[campo] ?? null;
  return {
    analysis: foto,
    // Ordena por id: a MESMA carga em ordem diferente de fetch não pode virar
    // hash novo (foto fantasma todo dia).
    documentos: [...documentos].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export interface RestauracaoAnalise {
  /** update no Analysis (campos da foto; status já resolvido pela regra). */
  data: Record<string, unknown>;
  /** updates por documento ainda existente. */
  docs: Array<{ id: string; data: Record<string, unknown> }>;
  /** nomes dos documentos da foto que não existem mais (não recriados). */
  docsIgnorados: string[];
  /** nomes dos documentos atuais que a foto não conhecia (ficam como estão). */
  docsForaDaFoto: string[];
}

export function aplicarFotoAnalise(
  conteudo: ConteudoFotoAnalise,
  statusAtual: string,
  docsAtuais: Array<{ id: string; nome: string }>,
): RestauracaoAnalise {
  const data: Record<string, unknown> = {};
  for (const campo of CAMPOS_FOTO_ANALISE) data[campo] = conteudo.analysis[campo] ?? null;
  // Conclusão é ATO (com trilha) — a foto nunca re-conclui um produto reaberto.
  if (conteudo.analysis.status === "Concluída" && statusAtual !== "Concluída") data.status = statusAtual;

  const atuaisPorId = new Map(docsAtuais.map((d) => [d.id, d]));
  const naFoto = new Set<string>();
  const docs: RestauracaoAnalise["docs"] = [];
  const docsIgnorados: string[] = [];
  for (const doc of conteudo.documentos) {
    naFoto.add(doc.id);
    if (!atuaisPorId.has(doc.id)) { docsIgnorados.push(doc.nome); continue; }
    docs.push({
      id: doc.id,
      data: {
        tipo: doc.tipo,
        competencia: doc.competencia,
        moeda: doc.moeda,
        status: doc.status,
        confianca: doc.confianca,
        dadosExtraidos: doc.dadosExtraidos === null ? null : (doc.dadosExtraidos as object),
        editadoManualmente: doc.editadoManualmente,
      },
    });
  }
  const docsForaDaFoto = docsAtuais.filter((d) => !naFoto.has(d.id)).map((d) => d.nome);
  return { data, docs, docsIgnorados, docsForaDaFoto };
}

// ── Modelo financeiro (FinancialModel) ──────────────────────────────────────

export const CAMPOS_FOTO_MODELO = [
  "nome", "objetivo", "mesInicial", "horizonteMeses", "visao",
  "cenarioAtivoId", "realizado", "indicesMacro", "status",
] as const;

export interface BlocoFoto {
  id: string;
  tipo: string;
  nome: string;
  ordem: number;
  modo: string;
  ativo: boolean;
  config: unknown;
}

export interface CenarioFoto {
  id: string;
  nome: string;
  isBase: boolean;
  overrides: unknown;
}

export interface ConteudoFotoModelo {
  model: Record<string, unknown>;
  blocks: BlocoFoto[];
  scenarios: CenarioFoto[];
}

export function montarConteudoModelo(
  model: Record<string, unknown>,
  blocks: BlocoFoto[],
  scenarios: CenarioFoto[],
): ConteudoFotoModelo {
  const foto: Record<string, unknown> = {};
  for (const campo of CAMPOS_FOTO_MODELO) foto[campo] = model[campo] ?? null;
  return {
    model: foto,
    blocks: [...blocks].sort((a, b) => a.id.localeCompare(b.id)),
    scenarios: [...scenarios].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export interface RestauracaoModelo {
  data: Record<string, unknown>;
  blocks: Array<{ id: string; data: Record<string, unknown> }>;
  scenarios: Array<{ id: string; data: Record<string, unknown> }>;
  ignorados: string[];
}

export function aplicarFotoModelo(
  conteudo: ConteudoFotoModelo,
  statusAtual: string,
  blocosAtuais: Array<{ id: string }>,
  cenariosAtuais: Array<{ id: string }>,
): RestauracaoModelo {
  const data: Record<string, unknown> = {};
  for (const campo of CAMPOS_FOTO_MODELO) data[campo] = conteudo.model[campo] ?? null;
  if (conteudo.model.status === "Concluído" && statusAtual !== "Concluído") data.status = statusAtual;
  // O cache de cálculo tem hash dos inputs de OUTRO estado — invalida para o
  // próximo open recalcular com as configs restauradas.
  data.resultadoCache = null;
  // Cenário ativo que não existe mais → não aponta para fantasma.
  const cenIds = new Set(cenariosAtuais.map((c) => c.id));
  if (data.cenarioAtivoId && !cenIds.has(data.cenarioAtivoId as string)) data.cenarioAtivoId = null;

  const blocoIds = new Set(blocosAtuais.map((b) => b.id));
  const ignorados: string[] = [];
  const blocks: RestauracaoModelo["blocks"] = [];
  for (const b of conteudo.blocks) {
    if (!blocoIds.has(b.id)) { ignorados.push(`bloco "${b.nome}"`); continue; }
    blocks.push({ id: b.id, data: { nome: b.nome, ordem: b.ordem, modo: b.modo, ativo: b.ativo, config: b.config as object } });
  }
  const scenarios: RestauracaoModelo["scenarios"] = [];
  for (const c of conteudo.scenarios) {
    if (!cenIds.has(c.id)) { ignorados.push(`cenário "${c.nome}"`); continue; }
    scenarios.push({ id: c.id, data: { nome: c.nome, overrides: c.overrides as object } });
  }
  return { data, blocks, scenarios, ignorados };
}
