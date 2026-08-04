/**
 * REGISTRO DE CONSUMO DE IA — a porta única (2026-08-03).
 *
 * Regra do dono: "sempre precisaremos ter o custo de tudo que usar IA... quando a
 * Quantua escalar não podemos ser surpreendidos".
 *
 * DESENHO EM DUAS PEÇAS:
 *
 * 1. `comContextoIA(ctx, fn)` — o handler da rota declara UMA vez de quem é o
 *    gasto (produto, empresa, IBR, autor). O contexto viaja por AsyncLocalStorage
 *    até o fundo da pilha. Sem isso, dar autor às 15 etapas exigiria passar o
 *    usuário por 15 assinaturas de função — e a etapa que alguém esquecesse
 *    ficaria órfã em silêncio, que é exatamente o estado de hoje.
 *
 * 2. `registrarUsoIA(...)` — grava UMA linha por chamada física. Best-effort,
 *    como `registrarAuditoria`: falha ao gravar consumo NUNCA derruba a geração
 *    do cliente. Mas falha faz barulho no log.
 *
 * O QUE ESTA CAMADA NÃO FAZ: não decide preço (é `ai-pricing.ts`) e não interpreta
 * o resultado. Ela mede.
 */
import { prisma } from "../db/client";
import { AsyncLocalStorage } from "node:async_hooks";
import { PRECO_VERSAO, precificarTokens, precificarUnidades, type UsoTokens } from "./ai-pricing";

/** Etapas conhecidas. Slug estável — é a chave de agrupamento do relatório. */
export const ETAPAS = {
  EXTRACAO_HIBRIDA: "extracao-hibrida",
  EXTRACAO_VISAO: "extracao-visao",
  OCR_PARSER: "ocr-parser",
  OCR_BALANCETE: "ocr-balancete",
  OCR_BALANCETE_RELEITURA: "ocr-balancete-releitura",
  OCR_BALANCETE_VISION: "ocr-balancete-vision",
  OCR_DEMONSTRACAO_VISION: "ocr-demonstracao-vision",
  SUGESTOES_CLASSIFICACAO: "sugestoes-classificacao",
  PESQUISA_WEB_EMPRESA: "pesquisa-web-empresa",
  PESQUISA_WEB_PARES: "pesquisa-web-pares",
  RESUMO_MATERIAIS: "resumo-materiais",
  GERACAO_ANALISE: "geracao-analise",
  RECONCILIACAO_IA: "reconciliacao-ia",
  DE_PARA_ORCAMENTO: "de-para-orcamento",
  FORMULA_MODELO: "formula-modelo",
  DESCONHECIDA: "desconhecida",
} as const;

export interface CtxIA {
  produto: string;
  origem: string;
  workspaceId?: string | null;
  companyId?: string | null;
  analysisId?: string | null;
  modelId?: string | null;
  userId?: string | null;
  userName?: string | null;
  grupoId?: string | null;
}

const armazem = new AsyncLocalStorage<CtxIA>();

/** Declara de quem é o gasto para tudo que rodar dentro de `fn`. */
export function comContextoIA<T>(ctx: CtxIA, fn: () => Promise<T>): Promise<T> {
  const grupoId = ctx.grupoId ?? `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return armazem.run({ ...ctx, grupoId }, fn);
}

/**
 * Completa workspace e nome do autor a partir do banco, uma vez por requisição.
 *
 * Sem isto a dimensão de TENANT da tabela nasce toda nula: dá para somar o gasto
 * do mês, mas não dá para responder "quanto essa firma consumiu" — que é
 * exatamente a pergunta que a tabela existe para responder quando a plataforma
 * escalar. Best-effort e sem bloquear: falha aqui não pode derrubar a rota.
 */
export async function resolverAutorIA(): Promise<void> {
  const ctx = armazem.getStore();
  if (!ctx?.userId || (ctx.workspaceId && ctx.userName)) return;
  try {
    const u = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { name: true, email: true, workspaceId: true },
    });
    if (u) Object.assign(ctx, { workspaceId: u.workspaceId ?? null, userName: u.name ?? u.email ?? null });
  } catch (e) {
    console.warn("[ai-usage] não foi possível resolver autor/workspace:", e instanceof Error ? e.message : e);
  }
}

/** Contexto atual, ou o mínimo honesto quando ninguém declarou. */
export function contextoIA(): CtxIA {
  return armazem.getStore() ?? { produto: "desconhecido", origem: "desconhecida" };
}

export interface RegistroUsoIA {
  etapa: string;
  provedor: "anthropic" | "google-vision" | string;
  modelo: string;
  modeloSolicitado?: string | null;
  iniciadoEm: Date;
  /** Consumo por TOKEN (Anthropic). */
  tokens?: UsoTokens;
  /** Consumo por UNIDADE (Vision: páginas). `chave` indexa POR_UNIDADE. */
  unidades?: { chave: string; unidade: string; quantidade: number };
  documentId?: string | null;
  sequencia?: number;
  ehRetentativa?: boolean;
  status?: string;
  stopReason?: string | null;
  erroTipo?: string | null;
  observacao?: string | null;
}

/**
 * Grava UMA linha de consumo. Devolve o id (ou null se não gravou) para que um
 * reaproveitamento futuro possa apontar para o evento que de fato pagou.
 */
export async function registrarUsoIA(r: RegistroUsoIA): Promise<string | null> {
  try {
    const ctx = contextoIA();
    const fim = new Date();

    let usdTotal = 0;
    let desconhecido = false;
    let precoInput: number | null = null;
    let precoOutput: number | null = null;
    let precoCacheCriacao: number | null = null;
    let precoCacheLeitura: number | null = null;
    let precoUnitario: number | null = null;
    let unidade = "requisicoes";
    let quantidade = 1;

    if (r.unidades) {
      const p = precificarUnidades(r.unidades.chave, r.unidades.quantidade);
      usdTotal = p.usdTotal;
      desconhecido = p.desconhecido;
      precoUnitario = p.usdUnidade;
      unidade = r.unidades.unidade;
      quantidade = r.unidades.quantidade;
    } else {
      const t = r.tokens ?? {};
      const p = precificarTokens(r.modelo, t);
      usdTotal = p.usdTotal;
      desconhecido = p.desconhecido;
      if (p.preco) {
        precoInput = p.preco.inMtok;
        precoOutput = p.preco.outMtok;
        precoCacheCriacao = p.preco.cacheCriacaoMtok;
        precoCacheLeitura = p.preco.cacheLeituraMtok;
      }
      unidade = "tokens";
      quantidade =
        (t.inputTokens ?? 0) + (t.outputTokens ?? 0) + (t.cacheCriacaoTokens ?? 0) + (t.cacheLeituraTokens ?? 0);
    }

    const ev = await prisma.aiUsageEvent.create({
      data: {
        workspaceId: ctx.workspaceId ?? null,
        companyId: ctx.companyId ?? null,
        analysisId: ctx.analysisId ?? null,
        modelId: ctx.modelId ?? null,
        documentId: r.documentId ?? null,
        userId: ctx.userId ?? null,
        userName: ctx.userName ?? null,
        produto: ctx.produto,
        etapa: r.etapa || ETAPAS.DESCONHECIDA,
        origem: ctx.origem,
        grupoId: ctx.grupoId ?? null,
        sequencia: r.sequencia ?? 1,
        ehRetentativa: r.ehRetentativa ?? false,
        provedor: r.provedor,
        modelo: r.modelo,
        modeloSolicitado: r.modeloSolicitado ?? null,
        unidade,
        quantidade,
        inputTokens: r.tokens?.inputTokens ?? 0,
        outputTokens: r.tokens?.outputTokens ?? 0,
        cacheCriacaoTokens: r.tokens?.cacheCriacaoTokens ?? 0,
        cacheLeituraTokens: r.tokens?.cacheLeituraTokens ?? 0,
        buscasWeb: r.tokens?.buscasWeb ?? 0,
        usdTotal,
        precoVersao: PRECO_VERSAO,
        precoInput,
        precoOutput,
        precoCacheCriacao,
        precoCacheLeitura,
        precoUnitario,
        precoDesconhecido: desconhecido,
        iniciadoEm: r.iniciadoEm,
        finalizadoEm: fim,
        duracaoMs: fim.getTime() - r.iniciadoEm.getTime(),
        status: desconhecido ? "preco-desconhecido" : (r.status ?? "ok"),
        stopReason: r.stopReason ?? null,
        erroTipo: r.erroTipo ?? null,
        observacao: r.observacao ?? null,
        fonte: "medido",
      },
      select: { id: true },
    });
    if (desconhecido) {
      console.warn(`[ai-usage] PREÇO DESCONHECIDO para "${r.modelo}" (etapa ${r.etapa}) — evento gravado sem custo apurado, NÃO como zero.`);
    }
    return ev.id;
  } catch (e) {
    // Best-effort: nunca derrubar o trabalho do analista por falha de telemetria.
    console.warn("[ai-usage] falha ao registrar consumo:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * REAPROVEITAMENTO de resultado já pago (cache de OCR, pesquisa web herdada).
 * Linha com `usdTotal = 0` — o mês não cobra de novo — e `usdOriginal` guardando
 * o que de fato custou, para o histórico do IBR continuar honesto.
 */
export async function registrarReaproveitamentoIA(r: {
  etapa: string;
  provedor: string;
  modelo: string;
  usdOriginal: number;
  documentId?: string | null;
  hashInsumo?: string | null;
  eventoOriginalId?: string | null;
  observacao?: string | null;
}): Promise<void> {
  try {
    const ctx = contextoIA();
    const agora = new Date();
    await prisma.aiUsageEvent.create({
      data: {
        workspaceId: ctx.workspaceId ?? null,
        companyId: ctx.companyId ?? null,
        analysisId: ctx.analysisId ?? null,
        modelId: ctx.modelId ?? null,
        documentId: r.documentId ?? null,
        userId: ctx.userId ?? null,
        userName: ctx.userName ?? null,
        produto: ctx.produto,
        etapa: r.etapa,
        origem: ctx.origem,
        grupoId: ctx.grupoId ?? null,
        provedor: r.provedor,
        modelo: r.modelo,
        unidade: "requisicoes",
        quantidade: 0,
        usdTotal: 0,
        reaproveitado: true,
        usdOriginal: r.usdOriginal,
        eventoOriginalId: r.eventoOriginalId ?? null,
        hashInsumo: r.hashInsumo ?? null,
        iniciadoEm: agora,
        finalizadoEm: agora,
        duracaoMs: 0,
        status: "ok",
        observacao: r.observacao ?? "Resultado reaproveitado de processamento anterior — sem novo custo.",
        fonte: "medido",
      },
    });
  } catch (e) {
    console.warn("[ai-usage] falha ao registrar reaproveitamento:", e instanceof Error ? e.message : e);
  }
}

/** Lê o `usage` da resposta da Anthropic, inclusive os campos de cache. */
export function usoDaResposta(msg: any): UsoTokens {
  const u = msg?.usage ?? {};
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    // NUNCA eram lidos antes de 03/08/2026 — onde há cache de prompt, o custo
    // calculado não correspondia à fatura.
    cacheCriacaoTokens: u.cache_creation_input_tokens ?? 0,
    cacheLeituraTokens: u.cache_read_input_tokens ?? 0,
    buscasWeb: u.server_tool_use?.web_search_requests ?? 0,
  };
}

/**
 * MIDDLEWARE DE CONTEXTO — declara de quem é o gasto para a requisição inteira.
 *
 * Usa `AsyncLocalStorage.run` em volta do `next()`: todo o resto da cadeia (e
 * qualquer IA no fundo da pilha) enxerga o contexto, sem que nenhuma das 15
 * etapas precise receber o usuário por parâmetro.
 *
 * O escopo da EMPRESA só é conhecido depois da consulta ao banco — por isso o
 * objeto é mutável e o handler completa com `enriquecerContextoIA`.
 */
export function middlewareContextoIA(produto: string) {
  return (req: any, _res: any, next: any): void => {
    const ctx: CtxIA = {
      produto,
      // A rota é o gatilho: "process" | "generate" | "refold" | "reconcile-ai"...
      origem: String(req?.path ?? "").split("/").filter(Boolean).pop() ?? "desconhecida",
      analysisId: req?.params?.id ?? null,
      // `AuthRequest` deste projeto expõe `userId` (não `req.user`).
      userId: req?.userId ?? null,
      grupoId: `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    };
    armazem.run(ctx, () => next());
  };
}

/** Completa o contexto com o que só se sabe depois de consultar o banco. */
export function enriquecerContextoIA(patch: Partial<CtxIA>): void {
  const atual = armazem.getStore();
  if (!atual) return;
  Object.assign(atual, patch);
}
