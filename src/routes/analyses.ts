import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import multer from "multer";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { downloadFile, uploadFile, deleteFile, getSignedDownloadUrl } from "../services/storage";
import { parseDocument, dadosExtraidosToRaw, extrairTextoLayoutPDF, type ExtractedRow, type ParsedDocument } from "../services/parser";
import { parseBalanceteTexto, pareceBalancete } from "../services/balancete-parser";
import { converterBalancete, mesclarArvoresBalancete } from "../services/balancete-conversao";
import { generateAnalysis } from "../services/claude";
import { comparePeersForIndicators, type PeerComparisonRow } from "../services/peer-benchmark";
import { PEER_INDICATOR_MAP } from "../services/peer-indicator-map";
import { comparePeersCvm, CVM_COMPARAVEIS } from "../services/peer-benchmark-cvm";
import { researchCompanyWeb, researchSectorBenchmarksWeb } from "../services/web-research";
import { buildMateriaisContext, MATERIAL_TIPO } from "../services/material-context";
import { fixarDocumentosDoPool } from "../services/fixacao-pool";
import { sugerirClassificacoesIA, chaveNM } from "../services/classification-suggest";
import { mapExtractedToBP, mapExtractedToDRE, normalizeDRESigns, recomputeDRESubtotals, detectPeriodos, normalizePeriods, sugerirConta, ordPeriodo } from "../services/account-mapper";
import { DRE_TEMPLATE } from "../services/financial-templates";
import { buildIndicators, type ConfigRow } from "../services/indicator-config";
import { catalogoPadraoEfetivo, calibrarSemaforoComPares, sanitizeRowsIBR, type IBRIndicadorConfig } from "../services/indicador-config-ibr";
import { classificarSetor } from "../services/setor-classificador";
import { buildIndirectCashFlow } from "../services/cash-flow-indirect";
import { extractFinancialsWithAI, foldBP, foldDRE, type NaoMapeado } from "../services/ai-extraction";
import { getActiveModelVersions, loadActiveBPModel, loadActiveDREModel } from "../services/model-version";
import { getCurrentDictionaryVersion } from "../services/dictionary-version";
import { validateFinancialData, benfordAnalysis } from "../services/validation";
import { avaliarProntidaoGeracao } from "../services/prontidao-geracao";
import { resolverCascataDicionario, whereCascataDicionarioAtiva } from "../services/dicionario-escopo";
import { whereEmpresaVisivel, whereRecursoEmpresa, guardaEscritaSuspensao } from "../services/escopo-empresa";
import { registrarAuditoria, diffCampos } from "../services/audit-trail";
import type { DadosEstruturados, BPLineItem, DRELineItem, UnmatchedAccount } from "../types/financial";

const router = Router();
router.use(requireAuth);
// SOMENTE CONSULTA: org suspensa (inadimplência) lê mas não escreve.
router.use(guardaEscritaSuspensao("analysis"));

// IBR CANCELADO É SOMENTE CONSULTA (política 2026-07-16): consulta (GET) livre;
// NENHUMA mutação passa — reprocessar, regerar análise, indicadores, War Room,
// escopo, dores, documentos, assinatura, STCF, cenários… Guarda ÚNICO no router
// (fonte da verdade): qualquer botão esquecido na UI morre aqui com 409.
// ── ROTAS DE HIGIENIZAÇÃO — declaradas ANTES do guarda de cancelado ──────────
// (decisão do usuário, 21/07/2026). Declarar a rota antes do router.use elimina
// qualquer dependência do matching do guarda (a exceção por URL falhou em
// produção sem reprodução local — antes da rota, o guarda nem executa).

// EXCLUSÃO do IBR: rascunho/erro E CANCELADO (higienização — descartado não
// entra em relatório). Concluído continua inexcluível: cancele primeiro.
router.delete("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const existing = await prisma.analysis.findFirst({ where: { id, ...whereRecursoEmpresa(req) } });
  if (!existing) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  // POLÍTICA (2026-07-15): IBR concluído é produto emitido (pode ter valuation
  // vinculado e relatório entregue) — nunca some da base. Só CANCELAR, com motivo.
  if (existing.status === "Concluída") {
    res.status(409).json({ error: "IBR concluído não pode ser excluído — cancele (com motivo) para tirá-lo de circulação mantendo a evidência." });
    return;
  }
  // Valuation/modelo vinculado a este IBR perderia a fonte do histórico — bloqueia.
  const modelosVinculados = await prisma.financialModel.count({ where: { analysisSeedId: id } });
  if (modelosVinculados > 0) {
    res.status(409).json({ error: `Este IBR é a fonte de ${modelosVinculados} modelo(s) financeiro(s) (valuation/orçamento) — exclua ou cancele os modelos primeiro.` });
    return;
  }
  await prisma.analysis.delete({ where: { id } });
  // TRILHA da exclusão do IBR — analysisId NULL de propósito: com o id preenchido, o
  // cascade da análise apagaria a própria trilha da exclusão. entityId guarda o id.
  void registrarAuditoria({
    userId: req.userId!, entity: "analysis", entityId: id, field: "exclusão do IBR",
    before: { nome: existing.nome, status: existing.status, companyId: existing.companyId, criadoEm: existing.createdAt },
  });
  res.status(204).send();
});

// MARCAR COMO TESTE: tira o IBR de toda listagem e relatório futuro (a listagem
// padrão exclui ehTeste; os dados ficam na base como evidência, com trilha).
// Vale para qualquer status — inclusive Cancelada (é o caso típico).
// body: { teste: boolean } (false = desmarcar, via ?incluirTestes=1 na listagem)
router.post("/:id/marcar-teste", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const teste = req.body?.teste !== false; // default true
  const existing = await prisma.analysis.findFirst({ where: { id, ...whereRecursoEmpresa(req) }, select: { id: true, nome: true, ehTeste: true, status: true } });
  if (!existing) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  await prisma.analysis.update({ where: { id }, data: { ehTeste: teste } });
  void registrarAuditoria({
    userId: req.userId!, analysisId: id, entity: "analysis", entityId: id,
    field: teste ? "marcação de IBR como TESTE (fora de listagens e relatórios)" : "desmarcação de IBR de teste",
    before: { ehTeste: existing.ehTeste, status: existing.status, nome: existing.nome },
    after: { ehTeste: teste },
    source: "higienizacao",
  });
  res.json({ ok: true, ehTeste: teste });
});

router.use("/:id", async (req: AuthRequest, res: Response, next: () => void): Promise<void> => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") { next(); return; }
  const id = String(req.params.id ?? ""); // em router.use o param é string|string[]
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) { next(); return; }
  const a = await prisma.analysis.findUnique({ where: { id }, select: { status: true } }).catch(() => null);
  if (a?.status === "Cancelada") {
    res.status(409).json({ error: "IBR cancelado é somente consulta — nenhuma alteração é permitida. Se precisar retrabalhar, crie um novo IBR (a evidência deste fica preservada)." });
    return;
  }
  next();
});

const dataRoomUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const analysisSchema = z.object({
  companyId: z.string().uuid(),
  nome: z.string().min(2),
  periodo: z.string().optional(),
  tipo: z.enum(["Completa", "Rápida"]).default("Completa"),
  kind: z.enum(["ibr", "diagnostico"]).default("diagnostico"),
  // Pivot B2B-3 (v3, 2026-05-22+): wizard frontend bifurca em recorrente vs IBR pontual.
  // mode é a forma canônica; kind continua aceito para retrocompat.
  mode: z.enum(["recurring", "ibr"]).optional(),
  ibrType: z.enum(["light", "full", "crisis"]).optional(),
  sectorId: z.string().optional(),
  /** true = o analista ESCOLHEU ativamente no picker (diferente de sugestão de CNAE por inércia). */
  setorEscolhido: z.boolean().optional(),
  // Texto livre quando o picker está em "Outros" (setor fora da taxonomia B3).
  sectorCustom: z.string().max(120).optional(),
  documentChecklist: z.array(z.object({
    id: z.string(),
    label: z.string(),
    status: z.enum(["have", "requested", "na", "uploaded", "approved", "rejected", "pending"]),
  })).optional(),
  engagement: z.object({
    requestedBy: z.string().min(2),
    requestedByType: z.enum(["lender", "investor", "advisor", "empresa", "parceiro", "other"]).default("lender"),
    scope: z.string().default(""),
    deadline: z.string().optional(),
    feeAmount: z.number().optional(),
    feeCurrency: z.string().default("BRL"),
  }).optional(),
});

router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const companyId = req.query.companyId as string | undefined;
  // TESTES ficam fora de TODA listagem (e de tudo que deriva dela: lista de
  // IBRs, hub da empresa, pickers de valuation). ?incluirTestes=1 é a porta de
  // recuperação — sem UI por decisão do usuário ("não serem visualizados").
  const incluirTestes = req.query.incluirTestes === "1";
  const analyses = await prisma.analysis.findMany({
    where: {
      ...whereRecursoEmpresa(req),
      ...(companyId ? { companyId } : {}),
      ...(incluirTestes ? {} : { ehTeste: false }),
    },
    orderBy: { createdAt: "desc" },
    include: { company: { select: { razaoSocial: true, nomeFantasia: true } } },
  });
  res.json(analyses);
});

router.post("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = analysisSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const company = await prisma.company.findFirst({
    where: { id: parsed.data.companyId, ...whereEmpresaVisivel(req) },
  });
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  const { engagement, documentChecklist, ...analysisData } = parsed.data;

  // Resolve mode canônico: se frontend novo enviou mode, usa. Senão deriva de kind
  // legado (kind=ibr → mode=ibr; kind=diagnostico → mode=recurring).
  const resolvedMode = analysisData.mode ?? (analysisData.kind === "ibr" ? "ibr" : "recurring");

  // Modo recorrente ganha nextReviewAt agendado pra +30d (cadência padrão).
  // Cron diário scan-due-reviews varre análises vencendo e dispara email.
  const reviewCadenceDays = 30;
  const nextReviewAt =
    resolvedMode === "recurring"
      ? new Date(Date.now() + reviewCadenceDays * 24 * 60 * 60 * 1000)
      : null;

  const analysis = await prisma.analysis.create({
    data: {
      companyId: analysisData.companyId,
      nome: analysisData.nome,
      periodo: analysisData.periodo,
      tipo: analysisData.tipo,
      kind: analysisData.kind,
      mode: resolvedMode,
      ibrType: analysisData.ibrType,
      sectorId: analysisData.sectorId,
      // Confirma SÓ com escolha ativa (flag do wizard); sugestão de CNAE por inércia não.
      setorConfirmado: analysisData.setorEscolhido === true && !!analysisData.sectorId,
      sectorCustom: analysisData.sectorCustom,
      documentChecklist: documentChecklist as object | undefined,
      userId: req.userId!,
      nextReviewAt,
      reviewCadenceDays,
    },
  });

  // Cria Engagement vinculado quando IBR (mode canônico, ou kind legado).
  if ((resolvedMode === "ibr" || parsed.data.kind === "ibr") && engagement) {
    await prisma.engagement.create({
      data: {
        analysisId: analysis.id,
        userId: req.userId!,
        companyName: company.nomeFantasia ?? company.razaoSocial,
        requestedBy: engagement.requestedBy,
        requestedByType: engagement.requestedByType,
        scope: engagement.scope,
        deadline: engagement.deadline ? new Date(engagement.deadline) : null,
        feeAmount: engagement.feeAmount,
        feeCurrency: engagement.feeCurrency,
        state: "kicked_off",
      },
    });
  }

  res.status(201).json(analysis);
});

router.get("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    include: {
      company: true,
      documents: {
        orderBy: { createdAt: "asc" },
        // FIXAÇÃO (fase B): a linha do pool de origem — versão congelada é o selo
        // "usa vN"; substituidoPorId preenchido lá = insumo desatualizado aqui.
        include: { fixadoDe: { select: { versao: true, substituidoPorId: true } } },
      },
    },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  // EXTRAÇÃO DESATUALIZADA: algum documento financeiro vigente entrou DEPOIS da
  // última extração (upload novo ou substituição de versão) — os números exibidos
  // não refletem a base atual até reprocessar. Nada muda silencioso: só o aviso.
  const extraidoEm = (analysis.dadosEstruturados as any)?.extraidoEm as string | undefined;
  const extracaoDesatualizada = !!extraidoEm && analysis.documents.some((d) =>
    d.tipo !== MATERIAL_TIPO && d.status !== "Substituído" && d.createdAt > new Date(extraidoEm)
  );
  // VALUATIONS/MODELOS vinculados a este IBR (pode ser mais de um): o cabeçalho
  // do IBR mostra os links — a relação IBR↔produto fica visível dos dois lados.
  const modelosVinculados = await prisma.financialModel.findMany({
    where: { analysisSeedId: id },
    orderBy: { createdAt: "desc" },
    select: { id: true, nome: true, objetivo: true, status: true },
  });
  res.json({ ...analysis, extracaoDesatualizada, modelosVinculados });
});

// VERSÕES da extração (política 2026-07-15): trilha consultável de cada hash de
// versão com a proveniência completa dos insumos (documentos + dicionário +
// modelos padrão BP/DRE). A vigente é a de hash igual ao dadosEstruturados atual.
router.get("/:id/versoes", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { id: true, dadosEstruturados: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const versoes = await prisma.analysisVersion.findMany({
    where: { analysisId: id },
    orderBy: { criadoEm: "desc" },
  });
  const hashAtual = (analysis.dadosEstruturados as any)?.versaoExtracao ?? null;
  res.json({
    hashAtual,
    versoes: versoes.map((v) => ({ hash: v.hash, motivo: v.motivo, criadoEm: v.criadoEm, insumos: v.insumos, vigente: v.hash === hashAtual })),
  });
});

// (a rota DELETE /:id vive ANTES do guarda de cancelado — ver topo do arquivo.)

// CANCELAMENTO DEFINITIVO de IBR concluído (política 2026-07-15: concluído nunca
// é excluído — cancelar tira de circulação mantendo a evidência e a trilha).
router.post("/:id/cancelar", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const existing = await prisma.analysis.findFirst({ where: { id, ...whereRecursoEmpresa(req) } });
  if (!existing) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  if (existing.status !== "Concluída") {
    res.status(409).json({ error: `Cancelamento definitivo é para IBR concluído (status atual: "${existing.status}"). Enquanto não concluído, exclua normalmente.` });
    return;
  }
  const motivo = typeof req.body?.motivo === "string" ? req.body.motivo.trim().slice(0, 300) : "";
  await prisma.analysis.update({ where: { id }, data: { status: "Cancelada" } });
  void registrarAuditoria({
    userId: req.userId!, analysisId: id, entity: "analysis", entityId: id,
    field: "cancelamento definitivo do IBR", before: { status: "Concluída" }, after: { status: "Cancelada" },
    reason: motivo || undefined,
  });
  res.json({ ok: true, status: "Cancelada" });
});

// Cancela um processamento em andamento. Marca "Interrompida" SÓ se ainda está
// processando — estado REPROCESSÁVEL, diferente de "Cancelada" (cancelamento
// DEFINITIVO de IBR concluído, somente consulta — política 2026-07-16).
// O job em background (assíncrono) checa o status nos pontos de transição e aborta — então
// um cancelamento durante a EXTRAÇÃO evita até a chamada de análise da IA (economiza crédito).
router.post("/:id/cancel", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const existing = await prisma.analysis.findFirst({ where: { id, ...whereRecursoEmpresa(req) } });
  if (!existing) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const r = await prisma.analysis.updateMany({
    where: { id, status: { in: ["Extraindo", "Gerando diagnóstico"] } },
    data: { status: "Interrompida" },
  });
  res.json({ cancelled: r.count > 0, status: r.count > 0 ? "Interrompida" : existing.status });
});

/**
 * Adia a próxima revisão recorrente em N dias (default 7). Usado pelo RT
 * quando vê o item "due_review" no Inbox mas ainda não tem documentos
 * novos pra rodar a próxima rodada. Limpa lastReviewNotifiedAt pra que o
 * próximo email seja enviado quando o novo nextReviewAt se aproxime.
 *
 * Aceita apenas análises com mode=recurring.
 */
const snoozeSchema = z.object({
  days: z.number().int().min(1).max(60).default(7),
});

router.post("/:id/snooze-review", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const existing = await prisma.analysis.findFirst({ where: { id, ...whereRecursoEmpresa(req) } });
  if (!existing) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  if (existing.mode !== "recurring") {
    res.status(400).json({ error: "Snooze só faz sentido em análises recorrentes" });
    return;
  }
  const parsed = snoozeSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  // Soma N dias ao base — usa nextReviewAt atual se existir, senão usa now.
  const base = existing.nextReviewAt ?? new Date();
  const nextReviewAt = new Date(base.getTime() + parsed.data.days * 24 * 60 * 60 * 1000);

  const updated = await prisma.analysis.update({
    where: { id },
    data: { nextReviewAt, lastReviewNotifiedAt: null },
    select: { id: true, nextReviewAt: true },
  });

  res.json({ id: updated.id, nextReviewAt: updated.nextReviewAt?.toISOString() ?? null });
});

/** Ano (4 dígitos) de uma string de período ("2024", "31/12/2024"…), ou null. */
function yearOfPeriodo(p: string): number | null {
  const m = p.match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

export interface PeerExternalRef {
  indicador: string;
  referencia: number;
  fonte: string;
  higherIsBetter: boolean;
}

export interface PeerComparisonResult {
  year: number | null;
  /** rótulo do período de comparação na fonte CVM (ex.: "1T26 (LTM)"). */
  periodo?: string | null;
  segment: string | null;
  /** direta = par no próprio subsetor · aproximada = subiu p/ setor/classificação ·
   *  ausente = sem par relevante na base interna (cai na referência externa). */
  coverage: "direta" | "aproximada" | "ausente";
  /** Comparações internas RELEVANTES (descarta nível "mercado", enganoso p/ nicho). */
  rows: PeerComparisonRow[];
  /** Nomes das listadas usadas como pares — transparência de metodologia (Apêndice do PDF). */
  empresas?: string[];
  /** Referência externa (WEB) quando a base interna não cobre o subsetor.
   *  Preenchido pela pesquisa web (item 3); NÃO usa Premissas Setoriais
   *  (Damodaran/IBGE), que é base de projeção e não de pares. */
  external: PeerExternalRef[];
}

/**
 * Monta a comparação com o Benchmark Setorial (pares B3) para a análise:
 * resolve o segmento B3 do `sectorId`, posiciona a empresa vs pares do subsetor e,
 * quando a base interna NÃO tem par relevante (ex.: Financeiro), busca referência
 * EXTERNA (Premissas Setoriais) em vez de comparar contra o mercado inteiro
 * (que seria enganoso). Determinístico (sem IA). Null quando não há setor.
 */
/* ───────── SETOR CONFIRMADO (gate) ─────────
 * Setor errado envenena pares/semáforo/valor na mesa — a GERAÇÃO só roda com o setor
 * confirmado pelo analista (escolha explícita ou clique na proposta do classificador).
 * LEGADO sem migração: análise que JÁ FOI GERADA conta como confirmada. */
const PEND_SETOR = "Setor da empresa não confirmado — confirme a proposta do sistema (ou escolha o setor) no aviso da tela antes de gerar.";
function setorPendente(a: { setorConfirmado: boolean; resultado: unknown }): boolean {
  if (a.setorConfirmado) return false;
  const r = a.resultado as Record<string, unknown> | null;
  const jaGerada = !!r && typeof r === "object" && Object.keys(r).some((k) => k !== "erro");
  return !jaGerada;
}

/** AVISO DA CONVICÇÃO: setor CONFIRMADO pelo analista, mas os números aderem com
 *  folga a OUTRO setor (proposta do classificador armazenada) → aviso âmbar, nunca
 *  bloqueio — escolha explícita do humano manda. */
function avisoSetorDe(proposta: unknown, sectorId: string | null): string | null {
  const p = proposta as { recomendado?: { setor: string; sectorCode: string | null; dentro: number; total: number }; ranking?: Array<{ setor: string; sectorCode: string | null; dentro: number; total: number }> } | null;
  const rec = p?.recomendado;
  if (!rec?.sectorCode || !sectorId || rec.sectorCode === sectorId) return null;
  const atual = (p?.ranking ?? []).find((r) => r.sectorCode === sectorId);
  const fr = rec.dentro / rec.total;
  const fa = atual ? atual.dentro / atual.total : null;
  if (fa != null && fr - fa < 0.25) return null; // discordância fraca não vira aviso
  return `Os números da empresa aderem mais ao setor ${rec.setor} (${rec.dentro} de ${rec.total} indicadores na faixa dos pares${atual ? `, contra ${atual.dentro} de ${atual.total} no setor escolhido` : ""}) — revise a escolha do setor na aba Escopo.`;
}

/** Troca de setor → a calibração de indicadores POR PARES fica órfã. Recalibra na hora
 *  (re-seed do padrão + pares do setor novo, preservando personalizados do IBR). */
async function recalibrarConfigSeExistir(id: string): Promise<void> {
  const a = await prisma.analysis.findUnique({ where: { id }, select: { indicadorConfig: true, sectorId: true, dadosEstruturados: true } });
  if (!a?.indicadorConfig) return; // IBR nunca abriu a config — nada a recalibrar
  const dados = a.dadosEstruturados as any;
  const rows = await catalogoPadraoEfetivo();
  const anterior = a.indicadorConfig as unknown as IBRIndicadorConfig | null;
  for (const p of anterior?.rows?.filter((r) => !r.sistema && !rows.some((x) => x.nome === r.nome)) ?? []) rows.push(p);
  const pares = await calibrarSemaforoComPares(rows, a.sectorId, dados?.indicadores ?? [], dados?.periodos ?? []);
  const cfg: IBRIndicadorConfig = { calibrado: true, pares, atualizadoEm: new Date().toISOString(), rows };
  await prisma.analysis.update({ where: { id }, data: { indicadorConfig: cfg as unknown as object } });
  if (dados) await recalcularIndicadoresComConfig(id, dados, rows as unknown as ConfigRow[]);
}

/** Rows da config de indicadores DESTE IBR (null = usa o catálogo global). */
function rowsIBRDe(indicadorConfig: unknown): ConfigRow[] | null {
  const rows = (indicadorConfig as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) && rows.length > 0 ? (rows as ConfigRow[]) : null;
}

async function buildPeerComparison(
  sectorId: string | null,
  indicadores: Array<{ nome: string; valores: Record<string, unknown> }>,
  periodos: string[],
): Promise<PeerComparisonResult | null> {
  if (!sectorId || indicadores.length === 0 || periodos.length === 0) return null;

  const sector = await prisma.sector.findUnique({ where: { code: sectorId }, include: { parent: true } });
  if (!sector) return null;
  const seg = sector.parentCode && sector.parent
    ? { classificacao: sector.parent.name, setor: sector.name, subsetor: null as string | null }
    : { classificacao: sector.name, setor: null as string | null, subsetor: null as string | null };
  const segLabel = seg.setor ?? seg.classificacao;

  // FONTE CVM (fase 4): pares = base viva da CVM (~1.100 cias, LTM do trimestre
  // mais recente), no lugar do snapshot xlsx. Sem mapa de-para: CvmIndicator.nome
  // = nomes do MESMO motor. Normalização de segmento fica dentro do serviço.
  const ult = [...periodos].sort((a, b) => (yearOfPeriodo(a) ?? 0) - (yearOfPeriodo(b) ?? 0)).at(-1)!;

  const valores: Array<{ indicador: string; valor: number }> = [];
  for (const ind of indicadores) {
    if (!(ind.nome in CVM_COMPARAVEIS)) continue;
    const v = ind.valores?.[ult];
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) valores.push({ indicador: ind.nome, valor: n });
  }

  const { periodo, dtFim, rows: allRows, empresas } = valores.length
    ? await comparePeersCvm({ classificacao: seg.classificacao, setor: seg.setor }, valores)
    : { periodo: null, dtFim: null, rows: [] as PeerComparisonRow[], empresas: [] as string[] };
  const year = dtFim ? Number(dtFim.slice(0, 4)) : null;

  // RELEVÂNCIA: descarta linhas que só acharam pares no nível "mercado" (todas as
  // cias) — para segmento nicho isso não é par, é ruído. Mantém setor/classificação.
  const rows = allRows.filter((r) => r.level !== "mercado");
  // Só existe nível "setor" agora (pares = subsetor real; sem classificação/mercado).
  const coverage: PeerComparisonResult["coverage"] = rows.length > 0 ? "direta" : "ausente";

  // FALLBACK EXTERNO (cobertura não-direta): a referência NÃO vem das Premissas
  // Setoriais (Damodaran/IBGE = base de PROJEÇÃO, não de pares) — vem da WEB.
  // Preenchido pelo item 3 (pesquisa web); por ora fica vazio (seam).
  const external: PeerExternalRef[] = [];

  return { year, periodo, segment: segLabel, coverage, rows, external, empresas };
}

// Endpoint principal: dispara extração dos documentos + geração da análise com Claude
/**
 * ÚNICA passada de IA do IBR (camada interpretativa) — lê os dados JÁ extraídos/persistidos
 * (indicadores determinísticos; NÃO recalcula número) e PERSISTE o resultado nos campos do IBR.
 * Transiciona o status p/ "Gerando diagnóstico" (só de um estado válido — não ressuscita
 * "Cancelada") e, ao fim, "Concluída" (condicional, respeita cancelamento). Erro → "Erro".
 * Reutilizada pelo /process (auto, quando a extração fecha limpa) e pelo /generate (manual).
 */
async function runAnalysisBackground(
  analysisId: string,
  modelKey?: string | null,
  opts?: { reuseWeb?: boolean },
): Promise<void> {
  // "Extraindo" cobre o fluxo automático do /process (extração → geração). "Erro"/"Interrompida"
  // entram para permitir "Regerar só a análise" (reusa a extração já feita, sem re-extrair — o
  // /generate valida antes que há indicadores). "Cancelada" (definitivo) NUNCA entra: somente consulta.
  const iniciou = await prisma.analysis.updateMany({
    where: { id: analysisId, status: { in: ["Extraindo", "Pronta para gerar", "Revisão necessária", "Concluída", "Erro", "Interrompida"] } },
    data: { status: "Gerando diagnóstico" },
  });
  if (iniciou.count === 0) { console.log(`[generate] ${analysisId}: estado não permite gerar (cancelado/corrida) — abortado`); return; }

  try {
    const analysis = await prisma.analysis.findUnique({ where: { id: analysisId }, include: { company: true } });
    if (!analysis) return;
    const dados = analysis.dadosEstruturados as any;
    const indicadores = dados?.indicadores ?? [];
    const periodos: string[] = dados?.periodos ?? [];
    if (indicadores.length === 0) {
      await prisma.analysis.updateMany({
        where: { id: analysisId, status: "Gerando diagnóstico" },
        data: { status: "Erro", resultado: { erro: "Extração não produziu indicadores — verifique os documentos (formato/captura). A análise não pôde ser gerada." } as object },
      });
      console.log(`[generate] ${analysisId}: sem indicadores — Erro`);
      return;
    }

    // Benchmark Setorial (pares B3): posiciona a empresa vs listadas do subsetor.
    // Só leitura de DB. BEST-EFFORT — uma falha de query aqui NÃO pode derrubar o IBR.
    let peer: Awaited<ReturnType<typeof buildPeerComparison>> = null;
    try {
      peer = await buildPeerComparison(analysis.sectorId, indicadores, periodos);
    } catch (e: any) {
      console.error(`[generate] ${analysisId} peer falhou (segue sem):`, e?.message ?? e);
    }

    // Input 3: pesquisa web (notícias/mercado/contexto setorial). Best-effort —
    // se falhar, a análise segue sem. Custo vinculado ao IBR ([[registrar-custo-ia]]).
    // CACHE: no "Regerar só a análise" (reuseWeb), reaproveita a pesquisa já salva no
    // resultado anterior — evita re-buscar (tokens + US$) a cada regeração. O "Reprocessar
    // tudo" e o botão "atualizar pesquisa" passam reuseWeb=false para buscar de novo.
    const prev = analysis.resultado as { webResearch?: { resumo?: string; fontes?: { titulo: string; url: string }[] }; custoWebResearch?: any } | null;
    let web: Awaited<ReturnType<typeof researchCompanyWeb>> = null;
    const cachedWeb = opts?.reuseWeb && prev?.webResearch?.resumo?.trim()
      ? { resumo: prev.webResearch.resumo, fontes: prev.webResearch.fontes ?? [], custo: prev.custoWebResearch ?? null }
      : null;
    if (cachedWeb) {
      web = cachedWeb as unknown as typeof web;
      console.log(`[generate] ${analysisId} web: REUSADA do cache (0 buscas novas), ${cachedWeb.fontes.length} fontes`);
    } else {
      try {
        web = await researchCompanyWeb(
          {
            razaoSocial: analysis.company.razaoSocial,
            setor: analysis.sectorCustom ?? analysis.company.setor ?? null,
            site: (analysis.company as { site?: string | null }).site ?? null,
          },
          modelKey,
        );
      } catch (e: any) {
        console.error(`[generate] ${analysisId} web falhou (segue sem):`, e?.message ?? e);
      }
      if (web) console.log(`[generate] ${analysisId} web: ${web.custo.buscas} buscas, $${web.custo.usd.toFixed(4)}, ${web.fontes.length} fontes`);
    }

    // PARES VIA WEB — só quando NÃO há par B3 na base (setor "Outros"/custom →
    // coverage "ausente"). Preenche o `external` do peerComparison com as faixas
    // típicas do setor: referência DIRECIONAL, confiança baixa, NUNCA percentil/
    // semáforo duro. Custo vinculado ao IBR. Cache no reuseWeb (não re-busca à toa).
    let webPares: Awaited<ReturnType<typeof researchSectorBenchmarksWeb>> = null;
    if (peer && peer.coverage === "ausente") {
      const setorDesc = analysis.sectorCustom?.trim() || analysis.company.setor || peer.segment || "";
      const prevExternal = (analysis.resultado as { peerComparison?: { external?: unknown[] } } | null)?.peerComparison?.external;
      if (opts?.reuseWeb && Array.isArray(prevExternal) && prevExternal.length > 0) {
        peer.external = prevExternal as typeof peer.external;
        console.log(`[generate] ${analysisId} pares-web: REUSADOS do cache (${prevExternal.length} refs)`);
      } else if (setorDesc) {
        try {
          webPares = await researchSectorBenchmarksWeb(
            setorDesc,
            Object.entries(CVM_COMPARAVEIS).map(([nome, hib]) => ({ nome, higherIsBetter: hib })),
            modelKey,
          );
        } catch (e: any) {
          console.error(`[generate] ${analysisId} pares-web falhou (segue sem):`, e?.message ?? e);
        }
        if (webPares) {
          peer.external = webPares.refs;
          console.log(`[generate] ${analysisId} pares-web: ${webPares.refs.length} refs, $${webPares.custo.usd.toFixed(4)}`);
        }
      }
    }

    // Input 4: materiais complementares (notas/apresentações) resumidos pela IA.
    let materiais: Awaited<ReturnType<typeof buildMateriaisContext>> = null;
    try {
      materiais = await buildMateriaisContext(analysisId, modelKey);
    } catch (e: any) {
      console.error(`[generate] ${analysisId} materiais falhou (segue sem):`, e?.message ?? e);
    }
    if (materiais) console.log(`[generate] ${analysisId} materiais: ${materiais.blocos.length} resumos, $${(materiais.custo?.usd ?? 0).toFixed(4)}`);

    // A CAMADA DE RACIOCÍNIO (diagnóstico IBR) roda em OPUS — é a joia da coroa e justifica o
    // custo maior. Web/materiais (resumo) ficam no modelo configurado (mais barato). As linhas
    // da DRE entram para a árvore de custos do pilar Operacional.
    const analise = await generateAnalysis(
      indicadores,
      periodos,
      {
        razaoSocial: analysis.company.razaoSocial,
        setor: analysis.company.setor ?? "Não informado",
        porte: analysis.company.porte ?? "Não informado",
      },
      analysis.periodo ?? "Período não informado",
      "opus",
      peer,
      web ? { resumo: web.resumo, fontes: web.fontes } : null,
      materiais ? materiais.blocos : null,
      dados?.dre ?? null,
      dados?.fluxoCaixa ?? null, // estágio Dickinson pelos sinais de FCO/FCI/FCF (quando a prova fecha)
      Array.isArray(analysis.dores) ? (analysis.dores as never[]) : null, // fonte [5]: confronto declarado×observado
      dados?.bp ?? null, // caixa do BP → conta regressiva determinística (dias de caixa)
    );
    const resultado = {
      ...analise.result,
      custoAnalise: analise.custo,
      peerComparison: peer,
      webResearch: web ? { resumo: web.resumo, fontes: web.fontes } : null,
      custoWebResearch: web?.custo ?? null,
      custoWebPares: webPares?.custo ?? null, // pares via web (setor sem par B3)
      materiaisContexto: materiais ? { blocos: materiais.blocos } : null,
      custoMateriais: materiais?.custo ?? null,
    };
    console.log(`[generate] ${analysisId} análise: modelo=${analise.custo.modelo} custo=$${analise.custo.usd.toFixed(4)} (${analise.custo.inputTokens}+${analise.custo.outputTokens} tk)`);

    const docConfianca = typeof dados?.validacao?.confiancaGeral === "number" ? dados.validacao.confiancaGeral : analise.result.confianca;
    const finalConfianca = Math.round((analise.result.confianca + docConfianca) / 2);

    // Semeia opções estratégicas só se vazio (nunca sobrescreve o analista).
    const opcoesIA = analise.result.opcoesEstrategicas ?? [];
    const opcoesAtuais = (analysis.options as unknown[] | null) ?? [];
    const optionsSeed = opcoesAtuais.length === 0 && opcoesIA.length > 0
      ? opcoesIA.map((o) => ({ id: crypto.randomUUID(), ...o }))
      : null;

    // CONDICIONAL: só "Concluída" se ainda está "Gerando diagnóstico" (cancelamento descarta).
    const salvo = await prisma.analysis.updateMany({
      where: { id: analysisId, status: "Gerando diagnóstico" },
      data: {
        status: "Concluída",
        resultado: resultado as object,
        confianca: finalConfianca,
        ...(optionsSeed ? { options: optionsSeed as object } : {}),
      },
    });
    if (salvo.count === 0) { console.log(`[generate] ${analysisId} cancelada durante a IA — resultado descartado`); return; }
    console.log(`[generate] ${analysisId} CONCLUÍDA`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // PRESERVA o resultado anterior: gravar só { erro } apagava a análise boa que já
    // existia (incidente Move Farma 08/07 — resposta truncada destruiu o conteúdo).
    const atual = await prisma.analysis.findUnique({ where: { id: analysisId }, select: { resultado: true } }).catch(() => null);
    const base = atual?.resultado && typeof atual.resultado === "object" ? (atual.resultado as object) : {};
    await prisma.analysis.updateMany({
      where: { id: analysisId, status: "Gerando diagnóstico" },
      data: { status: "Erro", resultado: { ...base, erro: `Geração da análise: ${msg}` } as object },
    });
    console.error(`[generate] ${analysisId} erro:`, err);
  }
}

// Balancete de verificação = LINHA DE EXTRAÇÃO SEPARADA (F1 2026-07-18): tem
// estrutura própria (Ativo≠Passivo com resultado acumulado; DRE embutida no
// mesmo documento) e NUNCA entra na cascata BP/DRE — antes desta partição, o
// detectDocType mandava balancete para o fluxo de BP e poluía a extração
// (bug nº 4 do sweep do corpus).
const ehBalancete = (tipo: string): boolean => /balancete/i.test(tipo);

// Plug do PL no balancete (resultado acumulado que fecha o balanço): valor
// CALCULADO, não conta do documento — nunca deve entrar na fila de classificação
// (mapeia via alias p/ "Resultado do Exercício"; este filtro é cinto de segurança
// caso o modelo da empresa não tenha essa linha). Ver balancete-conversao.ts.
const ehPlugBalancete = (n: { nome?: string }): boolean => /apura[çc][ãa]o do balancete/i.test(n?.nome ?? "");
const semPlugBalancete = <T extends { nome?: string }>(arr: T[]): T[] => arr.filter((n) => !ehPlugBalancete(n));

// Períodos vindos de BALANCETE no IBR (DRE acumulada YTD): base dos dias dos
// prazos médios e da leitura mensal.
const periodosBalanceteDe = (dados: unknown): string[] => {
  const arr = Array.isArray((dados as any)?.arvoresBalancete) ? (dados as any).arvoresBalancete : [];
  return arr.map((b: any) => b?.periodo).filter((p: unknown): p is string => typeof p === "string" && p.length > 0);
};

// Aplica as PROVAS DETERMINÍSTICAS dos balancetes à validação do modelo.
// Balancete NÃO fecha AT=PT — o fechamento correto é Ativo − Passivo =
// resultado acumulado do ano (lucro ainda não transferido ao PL), provado ao
// centavo na conversão. Prova ok em todos os balancetes ⇒ reconciliação da DRE
// conta como VERIFICADA ("verde só com prova" — aqui a prova é matemática, não
// declarativa); prova falhando ⇒ erro que derruba o verde. Chamado no /process,
// no /refold e no GET /validacao (todos recalculam a validação do zero).
function aplicarProvasBalancete(
  validacao: ReturnType<typeof validateFinancialData>,
  dados: { balancetes?: unknown },
): void {
  const bals = Array.isArray(dados?.balancetes) ? (dados.balancetes as Array<Record<string, any>>) : [];
  if (bals.length === 0) return;
  const fmtBR = (n: number): string => n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let todasOk = true;
  let temProva = false;
  for (const b of bals) {
    const f = b.provas?.fechamento;
    if (b.erro || !f) { todasOk = false; continue; }
    temProva = true;
    if (f.ok) continue;
    todasOk = false;
    validacao.alertas.push({
      tipo: "erro", area: "Balancete",
      mensagem: `${b.nome}: fechamento não bate mesmo considerando o resultado acumulado (Ativo ${fmtBR(f.ativo)} − Passivo ${fmtBR(f.passivo)} − Resultado ${fmtBR(f.resultadoAcumulado)} = ${fmtBR(f.delta)}).`,
      detalhes: "No balancete o fechamento é Ativo − Passivo = resultado acumulado do período. A divergência indica conta perdida ou natureza errada na extração — revise antes de finalizar.",
    });
  }
  if (temProva && todasOk) {
    validacao.reconciliacaoDRE = { verificada: true, ok: validacao.reconciliacaoDRE.ok };
    validacao.alertas.push({
      tipo: "info", area: "Balancete",
      mensagem: "Fechamento do(s) balancete(s) provado ao centavo: Ativo − Passivo = resultado acumulado do período — a DRE reconcilia com o balanço por construção.",
    });
  } else {
    validacao.reconciliacaoDRE = { verificada: true, ok: false };
  }
}

// Merge por conta: copia valores de períodos ainda vazios (usado para juntar
// documentos anuais entre si e para APPENDAR os meses dos balancetes).
function mergeItensPorConta<T extends { conta: string; valores: Record<string, number> }>(existing: T[], newItems: T[]): void {
  const map = new Map<string, T>();
  for (const item of existing) map.set(item.conta, item);
  for (const novo of newItems) {
    const alvo = map.get(novo.conta);
    if (alvo) {
      for (const [periodo, valor] of Object.entries(novo.valores)) {
        if (alvo.valores[periodo] === undefined || alvo.valores[periodo] === 0) alvo.valores[periodo] = valor;
      }
    } else {
      existing.push(novo);
      map.set(novo.conta, novo);
    }
  }
}

router.post("/:id/process", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    include: { company: true, documents: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  // Materiais complementares (notas/apresentações) NÃO entram na extração financeira —
  // são resumidos depois, na geração da análise (buildMateriaisContext). Documentos
  // SUBSTITUÍDOS também não: a versão corrigida é quem representa o insumo (política
  // 2026-07-15 — a antiga fica só como evidência das versões anteriores do produto).
  const docsAtivos = analysis.documents.filter((d) => d.tipo !== MATERIAL_TIPO && d.status !== "Substituído");
  if (docsAtivos.length === 0) {
    res.status(400).json({ error: "Nenhuma demonstração contábil enviada para esta análise" });
    return;
  }

  // ASSÍNCRONO: marca "Extraindo" e RESPONDE JÁ (202). O processamento pesado (cascata de
  // extração + análise por IA) roda em background e pode levar minutos em IBR multi-ano — o
  // frontend acompanha por polling do status. Evita o timeout do proxy/LB (que aparecia como
  // "Erro de conexão" mesmo com o backend ainda processando).
  await prisma.analysis.update({ where: { id: analysis.id }, data: { status: "Extraindo" } });
  res.status(202).json({ id: analysis.id, status: "Extraindo" });

  try {

    // ── IDENTIFICAÇÃO DO TIPO PELO CONTEÚDO (2026-07-18) ──
    // O analista pode nomear o arquivo errado; o roteamento decide pelo DOCUMENTO:
    // balancete tem assinatura estrutural (título "balancete" ou colunas Saldo
    // anterior/Débito/Crédito com 10+ linhas de 4-5 valores). Rótulo divergente é
    // CORRIGIDO (persistido + auditado) e o analista é avisado. BP×DRE já é
    // decidido pelo conteúdo na cascata (detectDocType, "content first").
    const bufferCache = new Map<string, Buffer>();
    const baixarDoc = async (doc: { id: string; storagePath: string | null }): Promise<Buffer> => {
      const cache = bufferCache.get(doc.id);
      if (cache) return cache;
      const buffer = await downloadFile(doc.storagePath!);
      bufferCache.set(doc.id, buffer);
      return buffer;
    };
    const alertasTipoDoc: Array<{ tipo: "erro" | "aviso" | "info"; area: string; mensagem: string; detalhes?: string }> = [];
    for (const doc of docsAtivos) {
      if (!doc.storagePath || !/\.pdf$/i.test(doc.nome) || doc.editadoManualmente) continue;
      try {
        const texto = await extrairTextoLayoutPDF(await baixarDoc(doc));
        if (!texto || texto.length < 300) continue; // escaneado/sem texto — não dá para afirmar nada
        const det = pareceBalancete(texto);
        const rotulado = ehBalancete(doc.tipo);
        let tipoNovo: string | null = null;
        if (det.balancete && !rotulado) tipoNovo = "Balancete";
        // rótulo diz balancete, mas o conteúdo NÃO tem a estrutura nem o título → cascata BP/DRE
        else if (!det.balancete && rotulado) tipoNovo = "PDF";
        if (tipoNovo) {
          await prisma.document.update({ where: { id: doc.id }, data: { tipo: tipoNovo } });
          void registrarAuditoria({
            userId: req.userId!, analysisId: analysis.id, entity: "document", entityId: doc.id,
            field: "tipo (identificado pelo conteúdo)", before: { tipo: doc.tipo }, after: { tipo: tipoNovo, evidencias: det.evidencias }, source: "process",
          });
          alertasTipoDoc.push({
            tipo: "aviso", area: "Tipo de documento",
            mensagem: `${doc.nome}: enviado como "${doc.tipo}", mas o conteúdo é ${tipoNovo === "Balancete" ? "um BALANCETE" : "uma demonstração BP/DRE (não tem estrutura de balancete)"} — o sistema corrigiu o tipo automaticamente.`,
            detalhes: det.evidencias.length ? `Evidências: ${det.evidencias.join("; ")}.` : "Nenhuma assinatura de balancete encontrada no conteúdo.",
          });
          doc.tipo = tipoNovo; // partição abaixo usa o tipo corrigido
          console.log(`[process] tipo corrigido pelo conteúdo: ${doc.nome} → ${tipoNovo}`);
        }
      } catch (e: any) {
        console.warn(`[process] sniff de tipo falhou para ${doc.nome} (segue com o rótulo):`, e?.message ?? e);
      }
    }

    // Balancetes SAEM do fluxo BP/DRE (linha de extração separada, adiante).
    const balanceteDocs = docsAtivos.filter((d) => ehBalancete(d.tipo));
    const financialDocs = docsAtivos.filter((d) => !ehBalancete(d.tipo));

    // 2. Baixa e parseia cada documento (ou usa dados editados manualmente)
    const parsedDocs: ParsedDocument[] = await Promise.all(
      financialDocs.map(async (doc) => {
        try {
          // Se o documento foi editado manualmente, usar os dados editados
          if (doc.editadoManualmente && doc.dadosExtraidos) {
            const dados = doc.dadosExtraidos as any;
            const linhas: ExtractedRow[] = dados.linhas || (Array.isArray(dados) ? dados : []);
            const periodos: string[] = dados.periodos ||
              (linhas.length > 0 ? Object.keys(linhas[0].valores) : []);
            const raw = dadosExtraidosToRaw(doc.tipo, linhas, periodos);
            return { tipo: doc.tipo, linhas, periodos, raw };
          }

          // Caso contrário, re-parsear o arquivo original (cache do sniff de tipo)
          const buffer = await baixarDoc(doc);
          const parsed = await parseDocument(buffer, doc.nome, doc.tipo);

          // Calculate per-document confidence based on extraction quality
          const docLinhaCount = parsed.linhas.length;
          const docPeriodoCount = parsed.periodos.length;
          let perDocConfianca = 50; // base
          if (docLinhaCount >= 20) perDocConfianca += 20;
          else if (docLinhaCount >= 10) perDocConfianca += 15;
          else if (docLinhaCount >= 5) perDocConfianca += 10;
          if (docPeriodoCount >= 2) perDocConfianca += 15;
          else if (docPeriodoCount >= 1) perDocConfianca += 10;
          // Bonus for having account codes (structured extraction)
          const hasAccountCodes = parsed.linhas.some(l => l.code);
          if (hasAccountCodes) perDocConfianca += 10;
          perDocConfianca = Math.min(95, perDocConfianca);

          await prisma.document.update({
            where: { id: doc.id },
            data: {
              dadosExtraidos: { linhas: parsed.linhas, periodos: parsed.periodos } as any,
              status: "Processado",
              confianca: perDocConfianca,
            },
          });
          return parsed;
        } catch (err) {
          await prisma.document.update({ where: { id: doc.id }, data: { status: "Erro" } });
          throw err;
        }
      })
    );

    // 2.5 Normalize periods across documents (e.g., "31/12/2023" + "2023" → "31/12/2023")
    normalizePeriods(parsedDocs);
    let allPeriodos = detectPeriodos(parsedDocs);
    let structuredBP: BPLineItem[] = [];
    let structuredDRE: DRELineItem[] = [];

    // Dicionário em CASCATA (global → workspace → EMPRESA): entradas da empresa
    // deste IBR vencem; entradas de OUTRAS empresas nunca entram (isolamento).
    const dictEntries = await prisma.accountDictionary.findMany({
      where: whereCascataDicionarioAtiva(req.scopeUserIds!, analysis.companyId),
      select: { nomeOriginal: true, contaDestino: true, grupoConta: true, userId: true, companyId: true, tipo: true },
    });
    const dicionarioEntradasEmpresa = dictEntries.filter((e) => e.companyId !== null).length;
    const buildDictForType = (tipo: string) =>
      resolverCascataDicionario(dictEntries, tipo).map((e) => ({
        nomeOriginal: e.nomeOriginal.toLowerCase(),
        contaDestino: e.contaDestino,
        grupoConta: e.grupoConta || "",
      }));
    const dictForBP = buildDictForType("BP");
    const dictForDRE = buildDictForType("DRE");
    const bpModel = await loadActiveBPModel(analysis.companyId); // bridge: BP padrão vem do banco (cascata empresa→global)
    const dreModel = await loadActiveDREModel(analysis.companyId); // bridge: DRE padrão idem (contas do editor entram no dropdown e na cascata)

    // Auto-detect document type — content-first, tipo as fallback
    function detectDocType(doc: ParsedDocument): "BP" | "DRE" | "BOTH" | "UNKNOWN" {
      // 1. ALWAYS check content first (more reliable than user-provided tipo)
      const raw = doc.raw.toLowerCase();
      const hasBP = raw.includes("ativo circulante") || raw.includes("passivo circulante") || raw.includes("a t i v o");
      // DRE keywords — must be specific enough to NOT match BP account names
      // Avoid: "prejuizo" (matches BP "LUCROS OU PREJUIZOS ACUMULADOS")
      // Avoid: "resultado do exerc" (matches BP PL section "RESULTADO DO EXERCÍCIO")
      // Avoid: "despesas operacionais", "lucro bruto" (too generic, appear in some BPs)
      const hasDRE = raw.includes("receita bruta") || raw.includes("resultado liquido") ||
                     raw.includes("custo operacional") || raw.includes("custo produtos vendidos") ||
                     raw.includes("demonstrativo de resultado") || raw.includes("demonstração do resultado") ||
                     raw.includes("receita de vendas") || raw.includes("deducoes da receita") ||
                     raw.includes("deduções da receita") || raw.includes("despesas com vendas") ||
                     raw.includes("receita operacional líquida") || raw.includes("custo das mercadorias");

      if (hasBP && hasDRE) return "BOTH";
      if (hasBP) return "BP";
      if (hasDRE) return "DRE";

      // 2. Fallback: user-provided tipo field
      const tipoNorm = doc.tipo.toLowerCase();
      if (tipoNorm.includes("balan") || tipoNorm.includes("balancete")) return "BP";
      if (tipoNorm.includes("dre") || tipoNorm.includes("resultado") || tipoNorm.includes("demonstra")) return "DRE";

      return "UNKNOWN";
    }

    // (merge por conta: mergeItensPorConta, escopo de módulo — reusado no refold)

    // ── CASCATA cheapest-first: parser (grátis) → híbrido (IA Haiku) → [visão: passo 2] ──
    // Pega o 1º nível que FECHA no gate de integridade (Ativo=Passivo + composição AC+ANC /
    // PC+PNC+PL + detalhe completo + DRE reconciliando vs declarado). Se nenhum fecha, usa o
    // de maior score (a trava mostra vermelho). Mede o custo de IA de cada nível.
    const dictAll = [...dictForBP, ...dictForDRE];
    const HIBRIDO_ATIVO = env.ibr.hibridoAtivo;
    const linhasToText = (linhas: ExtractedRow[]) =>
      linhas.map((l) => `${l.contexto ? l.contexto + " > " : ""}${l.conta} = ${JSON.stringify(l.valores)}`).join("\n");

    interface Candidato {
      fonte: "heuristico" | "hibrido" | "visao";
      bp: BPLineItem[]; dre: DRELineItem[]; periodos: string[];
      declarados: Record<string, Record<string, number>>;
      unmatched: UnmatchedAccount[];              // N3 p/ tela manual (só do híbrido; heurístico = [])
      arvoreBP: unknown; arvoreDRE: unknown; naoMapeados: unknown[]; alertasComposicao: unknown[];
      custoUsd: number;
      validacao: ReturnType<typeof validateFinancialData>;
      score: number; fecha: boolean;
    }
    const scoreDe = (v: ReturnType<typeof validateFinancialData>) => {
      const dreOk = !v.reconciliacaoDRE.verificada || v.reconciliacaoDRE.ok;
      return (v.equacaoPatrimonial ? 1 : 0) + (v.composicaoAtivo ? 1 : 0) + (v.composicaoPassivo ? 1 : 0) + (v.detalheCompleto ? 1 : 0) + (dreOk ? 1 : 0);
    };
    const totalBP = (bp: BPLineItem[], conta: string, p: string) => bp.find((b) => b.conta === conta)?.valores[p] ?? 0;
    // Normaliza/recalcula a DRE do candidato e roda a trava — base da decisão da cascata.
    // IMPORTANTE: exige DADOS REAIS (Ativo e Passivo não-zero em algum período). Sem isso,
    // validateFinancialData marca equação=true VACUAMENTE (pula a checagem com totais 0) —
    // um resultado VAZIO não pode "fechar" nem vencer um parcial. Vazio → score 0.
    const avalia = (c: Omit<Candidato, "validacao" | "score" | "fecha">): Candidato => {
      normalizeDRESigns(c.dre, c.periodos);
      recomputeDRESubtotals(c.dre, c.periodos, dreModel.extrasPorBloco);
      const v = validateFinancialData(c.bp, c.dre, c.periodos, c.declarados);
      const temDados = c.periodos.some((p) => totalBP(c.bp, "Ativo Total", p) !== 0 && totalBP(c.bp, "Passivo Total", p) !== 0);
      const score = temDados ? scoreDe(v) : 0;
      return { ...c, validacao: v, score, fecha: temDados && score === 5 };
    };
    const declaradosDe = (dre: DRELineItem[], periodos: string[]) => {
      const decl: Record<string, Record<string, number>> = {};
      for (const p of periodos) for (const conta of ["Receita Líquida", "Lucro Bruto", "Lucro Líquido"]) {
        const v = dre.find((d) => d.conta === conta)?.valores[p] ?? 0;
        if (Math.abs(v) > 0.5) (decl[p] ??= {})[conta] = v;
      }
      return decl;
    };

    // Nível 1 — PARSER determinístico (heurístico, grátis).
    const rodaHeuristico = (): Candidato => {
      let bp: BPLineItem[] = [], dre: DRELineItem[] = [];
      const unm: UnmatchedAccount[] = [];
      for (const doc of parsedDocs) {
        const docType = detectDocType(doc);
        const tipoNorm = doc.tipo.toLowerCase();
        const querBP = docType === "BP" || docType === "BOTH" || (docType === "UNKNOWN" && doc.linhas.length > 0 && (tipoNorm.includes("balan") || tipoNorm.includes("balancete")));
        const querDRE = docType === "DRE" || docType === "BOTH" || (docType === "UNKNOWN" && doc.linhas.length > 0 && (tipoNorm.includes("dre") || tipoNorm.includes("resultado")));
        if (querBP) { const r = mapExtractedToBP(doc.linhas, dictForBP, bpModel); if (!bp.length) bp = r.items; else mergeItensPorConta(bp, r.items); unm.push(...r.unmatched); }
        if (querDRE) { const r = mapExtractedToDRE(doc.linhas, dictForDRE); if (!dre.length) dre = r.items; else mergeItensPorConta(dre, r.items); unm.push(...r.unmatched); }
      }
      const periodos = detectPeriodos(parsedDocs);
      // declarados capturados ANTES do recompute (avalia() recompõe a cascata depois)
      const declarados = declaradosDe(dre, periodos);
      // unmatched do heurístico é folha profunda (N4+) → NUNCA vai p/ a tela (dupla contagem).
      // Guardamos só p/ telemetria; a tela manual é N3-only (alimentada pelo híbrido).
      return avalia({ fonte: "heuristico", bp, dre, periodos, declarados, unmatched: [], arvoreBP: null, arvoreDRE: null, naoMapeados: [], alertasComposicao: [], custoUsd: 0 });
    };

    // N3 de BP não mapeados → tela manual (NUNCA N4+; a soma das folhas já está no N3).
    // Candidatos de sugestão. DRE: inputs do template. BP: filtrado POR LADO do grupo
    // (Ativo/Passivo/PL) — a sugestão NUNCA cruza Ativo↔Passivo (mesma regra do de-para).
    const candidatosDRE = DRE_TEMPLATE.filter((t) => !t.subtotal).map((t) => t.conta);
    const candidatosBPdoGrupo = (grupo: string): string[] => {
      const lado = grupo.startsWith("Ativo") ? "A" : grupo.startsWith("Passivo") ? "P" : grupo.startsWith("Patrim") ? "PL" : null;
      if (!lado) return bpModel.names;
      return bpModel.lines
        .filter((l) => l.tipo === "input" && (lado === "PL" ? l.classificacao === "PL" : lado === "P" ? (l.classificacao[0] === "P" && l.classificacao !== "PL") : l.classificacao[0] === "A"))
        .map((l) => l.conta);
    };
    const naoMapeadosParaTela = (naoMapeados: NaoMapeado[]): UnmatchedAccount[] => {
      // BP: nível N3 (primeira quebra). DRE: nível de seção-input. NUNCA folhas profundas
      // (sem dupla contagem). Reclassificar MOVE o valor (de "Outros" p/ a conta certa).
      const byKey = new Map<string, UnmatchedAccount>();
      for (const nm of naoMapeados) {
        if (nm?.tipo !== "BP" && nm?.tipo !== "DRE") continue;
        const key = `${nm.tipo}|${nm.nome}`;
        const contexto = nm.tipo === "BP" ? nm.grupo : `Hoje em: ${nm.destino}`;
        const sugestao = sugerirConta(nm.nome, nm.tipo === "BP" ? candidatosBPdoGrupo(nm.grupo) : candidatosDRE) ?? undefined;
        const cur = byKey.get(key) ?? { conta: nm.nome, valores: {}, contexto, tipo: nm.tipo, sugestao };
        cur.valores[nm.periodo] = (cur.valores[nm.periodo] ?? 0) + nm.valor;
        byKey.set(key, cur);
      }
      return [...byKey.values()];
    };
    const temDadosIA = (r: { bp: BPLineItem[]; dre: DRELineItem[] }) =>
      r.bp.some((b) => Object.values(b.valores).some((v) => v)) || r.dre.some((d) => Object.values(d.valores).some((v) => v));

    // Nível 2 — HÍBRIDO (parser → IA Haiku texto → fold N3). Período por-doc (pin). Custo medido.
    const rodaHibrido = async (): Promise<Candidato | null> => {
      // raw = linhasToText (limpo, p/ o LLM) · rawIndent = doc.raw do parser (INDENTADO, p/ a
      // árvore determinística por indentação — recupera as folhas Grau-4 que `linhas` colapsa).
      const aiDocs = parsedDocs.filter((d) => d.linhas.length > 0).map((d) => ({ raw: linhasToText(d.linhas), rawIndent: d.raw, tipo: d.tipo, periodos: d.periodos }));
      if (!aiDocs.length) return null;
      const r = await extractFinancialsWithAI(aiDocs, [], dictAll, bpModel, { dreModel });
      if (!temDadosIA(r)) return null;
      return avalia({ fonte: "hibrido", bp: r.bp, dre: r.dre, periodos: r.periodos, declarados: r.declarados, unmatched: naoMapeadosParaTela(r.naoMapeados as NaoMapeado[]), arvoreBP: r.arvoreOriginalBP, arvoreDRE: r.arvoreOriginalDRE, naoMapeados: r.naoMapeados, alertasComposicao: r.alertasComposicao, custoUsd: r.custo.usd });
    };

    // Nível 3 — VISÃO (Sonnet lê o PDF original). Caro: só como ÚLTIMO recurso. Re-baixa os
    // buffers sob demanda (não retém na memória). Pula docs editados manualmente. Usa o
    // período conhecido pelo parser (pin) p/ alinhar com o que o parser/híbrido já viram.
    const rodaVisao = async (): Promise<Candidato | null> => {
      const visDocs: Array<{ buffer: Buffer; tipo: string; periodos: string[] }> = [];
      for (let i = 0; i < financialDocs.length; i++) {
        const doc = financialDocs[i];
        if (doc.editadoManualmente || !doc.storagePath) continue;
        const buffer = await downloadFile(doc.storagePath);
        visDocs.push({ buffer, tipo: doc.tipo, periodos: parsedDocs[i]?.periodos ?? [] });
      }
      if (!visDocs.length) return null;
      const r = await extractFinancialsWithAI(visDocs, [], dictAll, bpModel, { dreModel }); // buffer → Sonnet visão
      if (!temDadosIA(r)) return null;
      return avalia({ fonte: "visao", bp: r.bp, dre: r.dre, periodos: r.periodos, declarados: r.declarados, unmatched: naoMapeadosParaTela(r.naoMapeados as NaoMapeado[]), arvoreBP: r.arvoreOriginalBP, arvoreDRE: r.arvoreOriginalDRE, naoMapeados: r.naoMapeados, alertasComposicao: r.alertasComposicao, custoUsd: r.custo.usd });
    };

    const custos: Array<{ fonte: string; usd: number }> = [];
    let escolhido = rodaHeuristico();
    custos.push({ fonte: "parser", usd: 0 });
    // Nível 2 — HÍBRIDO (Haiku, barato): escala se NÃO fechou 5/5 (tenta melhorar inclusive a
    // reconciliação da DRE, que é barata de tentar no texto).
    if (!escolhido.fecha && HIBRIDO_ATIVO) {
      try {
        const hib = await rodaHibrido();
        if (hib) { custos.push({ fonte: "hibrido", usd: hib.custoUsd }); if (hib.fecha || hib.score > escolhido.score) escolhido = hib; }
      } catch (e: any) { console.error("[process] híbrido falhou:", e?.message ?? e); }
    }
    // Nível 3 — VISÃO (Sonnet), só se ainda NÃO fechou 5/5 (último recurso). Integridade
    // COMPLETA é o critério: equação + composição (Ativo e Passivo) + detalhe + DRE
    // reconciliando. Eficiência vem de FECHAR nos níveis baratos (corrigir a extração), não
    // de relaxar o gate.
    if (!escolhido.fecha && HIBRIDO_ATIVO) {
      try {
        const vis = await rodaVisao();
        if (vis) { custos.push({ fonte: "visao", usd: vis.custoUsd }); if (vis.fecha || vis.score > escolhido.score) escolhido = vis; }
      } catch (e: any) { console.error("[process] visão falhou:", e?.message ?? e); }
    }
    const custoTotalUsd = custos.reduce((s, c) => s + c.usd, 0);
    const vv = escolhido.validacao;
    console.log(`[process] cascata: venceu=${escolhido.fonte} fecha=${escolhido.fecha} score=${escolhido.score}/5 [eq=${vv.equacaoPatrimonial} cA=${vv.composicaoAtivo} cP=${vv.composicaoPassivo} det=${vv.detalheCompleto} dre=${JSON.stringify(vv.reconciliacaoDRE)}] | ${custos.map((c) => `${c.fonte}:$${c.usd.toFixed(4)}`).join(" ")} | total=$${custoTotalUsd.toFixed(4)}`);

    // Materializa o vencedor. Árvore/N3 vêm direto do candidato (heurístico = null/[]; IA
    // texto OU visão = a captura N3) — NÃO gatear por "híbrido" senão a visão perde a árvore.
    structuredBP = escolhido.bp;
    structuredDRE = escolhido.dre;
    // Ordem CRONOLÓGICA sempre — o vencedor da cascata traz os períodos na ordem dos
    // DOCUMENTOS (ex.: 2022, 2020, 2021), o que desordenava FC, PDF e séries da análise.
    allPeriodos = [...escolhido.periodos].sort((a, b) => ordPeriodo(a) - ordPeriodo(b));
    const usouIA = escolhido.fonte !== "heuristico";
    const arvoreOriginalBP = escolhido.arvoreBP;
    const arvoreOriginalDRE = escolhido.arvoreDRE;
    const hibridoNaoMapeados = escolhido.naoMapeados;
    const declaradosDRE = escolhido.declarados;
    let validacao = escolhido.validacao;
    const custoExtracaoUsd = custoTotalUsd;

    // ── LINHA SEPARADA: BALANCETES (F1 2026-07-18) — determinística, custo 0 ──
    // parse layout → conversão com PROVAS (débitos=créditos; fechamento ao
    // centavo: Ativo − Passivo = resultado acumulado; PL ajustado com "Resultado
    // do Período") → MESMO fold/dicionário/modelos da cascata. O mês entra como
    // período novo MESCLADO aos anuais (BP no fim do mês; DRE acumulada YTD).
    const balancetes: Array<Record<string, unknown>> = [];
    const arvoresBalancete: Array<{ docId: string; nome: string; periodo: string; arvoreBP: unknown; arvoreDRE: unknown }> = [];
    const nmBalancete: NaoMapeado[] = [];
    for (const doc of balanceteDocs) {
      try {
        if (!doc.storagePath || !/\.pdf$/i.test(doc.nome)) {
          balancetes.push({ docId: doc.id, nome: doc.nome, erro: "Balancete é suportado apenas em PDF nesta fase" });
          await prisma.document.update({ where: { id: doc.id }, data: { status: "Erro" } });
          continue;
        }
        const buffer = await baixarDoc(doc);
        const texto = await extrairTextoLayoutPDF(buffer);
        if (!texto || texto.length < 100) {
          balancetes.push({ docId: doc.id, nome: doc.nome, erro: "PDF sem texto extraível (escaneado?) — OCR de balancete ainda não suportado" });
          await prisma.document.update({ where: { id: doc.id }, data: { status: "Erro" } });
          continue;
        }
        const parseado = parseBalanceteTexto(texto);
        const conv = converterBalancete(parseado);
        if (!conv.periodoBP || parseado.linhas.length < 5) {
          balancetes.push({ docId: doc.id, nome: doc.nome, erro: `Estrutura de balancete não reconhecida (${parseado.linhas.length} linhas; ${conv.avisos.join(" | ") || "sem avisos"})` });
          await prisma.document.update({ where: { id: doc.id }, data: { status: "Erro" } });
          continue;
        }
        // fold com o MESMO dicionário em cascata e modelos padrão da empresa
        const rB = foldBP(conv.arvoreBP as any, [conv.periodoBP], dictForBP, bpModel);
        const rD = foldDRE(conv.arvoreDRE as any, [conv.periodoBP], dictForDRE, dreModel);
        if (structuredBP.length === 0) structuredBP = rB.bp; else mergeItensPorConta(structuredBP, rB.bp);
        if (structuredDRE.length === 0) structuredDRE = rD.dre; else mergeItensPorConta(structuredDRE, rD.dre);
        if (!allPeriodos.includes(conv.periodoBP)) allPeriodos.push(conv.periodoBP);
        nmBalancete.push(...semPlugBalancete(rB.naoMapeados as NaoMapeado[]), ...(rD.naoMapeados as NaoMapeado[]));
        arvoresBalancete.push({ docId: doc.id, nome: doc.nome, periodo: conv.periodoBP, arvoreBP: conv.arvoreBP, arvoreDRE: conv.arvoreDRE });
        balancetes.push({
          docId: doc.id, nome: doc.nome, periodo: conv.periodoBP, periodoInicio: parseado.periodoInicio,
          provas: conv.provas, avisos: conv.avisos, linhas: parseado.linhas.length,
        });
        await prisma.document.update({
          where: { id: doc.id },
          data: {
            dadosExtraidos: { balancete: true, periodos: [conv.periodoBP], provas: conv.provas, avisos: conv.avisos, totalLinhas: parseado.linhas.length } as any,
            status: "Processado",
            // "verde só com prova": confiança alta SOMENTE com fechamento ao centavo
            confianca: conv.provas.fechamento.ok ? 95 : 40,
          },
        });
        console.log(`[process] balancete ${doc.nome}: período ${conv.periodoBP}, ${parseado.linhas.length} linhas, fechamento ${conv.provas.fechamento.ok ? "OK" : `Δ ${conv.provas.fechamento.delta}`}${conv.provas.exercicioEncerrado ? " (exercício encerrado)" : ""}`);
      } catch (err) {
        console.error(`[process] balancete ${doc.nome} falhou:`, err instanceof Error ? err.message : err);
        balancetes.push({ docId: doc.id, nome: doc.nome, erro: err instanceof Error ? err.message : String(err) });
        await prisma.document.update({ where: { id: doc.id }, data: { status: "Erro" } }).catch(() => {});
      }
    }
    if (balanceteDocs.length > 0) {
      allPeriodos = [...allPeriodos].sort((a, b) => ordPeriodo(a) - ordPeriodo(b));
      // RE-VALIDA o modelo MESCLADO: a validação da cascata cobriu só os
      // documentos anuais — os meses do balancete entram na régua aqui (a
      // equação patrimonial fecha nos meses porque o PL leva o "Resultado do
      // Período" apurado pela conversão). As provas determinísticas substituem
      // a reconciliação por declarados nos meses (aplicarProvasBalancete).
      validacao = validateFinancialData(structuredBP, structuredDRE, allPeriodos, declaradosDRE);
      aplicarProvasBalancete(validacao, { balancetes });
    }
    // Avisos de tipo corrigido pelo conteúdo entram na validação (e persistem adiante)
    validacao.alertas.push(...alertasTipoDoc);

    // DRE já normalizada/recalculada e validada na cascata (avalia) → só os indicadores.
    // Meses de balancete = DRE acumulada YTD → prazos médios com dias-base do mês.
    const periodosYTDProc = arvoresBalancete.map((a) => a.periodo).filter(Boolean);
    const indicadores = await buildIndicators(structuredBP, structuredDRE, allPeriodos, rowsIBRDe(analysis.indicadorConfig), periodosYTDProc);
    console.log(`[process] Validação: confiança=${validacao.confiancaGeral}%, equação=${validacao.equacaoPatrimonial}, alertas=${validacao.alertas.length}`);
    for (const alerta of validacao.alertas) {
      console.log(`[process]   [${alerta.tipo}] ${alerta.area}: ${alerta.mensagem}`);
    }

    // Run Benford's Law analysis on all financial values
    const allValues: number[] = [];
    for (const bp of structuredBP) {
      allValues.push(...Object.values(bp.valores).filter(v => v !== 0));
    }
    for (const dre of structuredDRE) {
      allValues.push(...Object.values(dre.valores).filter(v => v !== 0));
    }
    const benford = benfordAnalysis(allValues);
    if (!benford.passesTest) {
      console.log(`[process] ALERTA Benford: ${benford.details}`);
      validacao.alertas.push({
        tipo: "aviso",
        area: "Benford",
        mensagem: benford.details,
      });
    }

    // SUGESTÃO POR IA para as contas não-mapeadas (âmbar): UMA chamada Haiku no lote,
    // temperature 0, opções fechadas por grupo/natureza. Gerada AQUI (1x por extração)
    // e CACHEADA em dadosEstruturados — a tela nunca re-consulta IA. Best-effort.
    let sugestoesIA: Record<string, import("../services/classification-suggest").SugestaoIA> = {};
    let custoSugestoes: import("../services/ai-extraction").CustoIA | null = null;
    const nmParaSugerir = [...((usouIA ? hibridoNaoMapeados : []) as import("../services/ai-extraction").NaoMapeado[]), ...nmBalancete];
    if (nmParaSugerir.length > 0) {
      try {
        const dreModelAtivo = await loadActiveDREModel(analysis.companyId);
        const dreInputs = dreModelAtivo.lines.filter((l: { subtotal: boolean }) => !l.subtotal).map((l: { conta: string }) => l.conta);
        const receitaLinha = structuredDRE.find((l) => l.conta === "Receita Bruta");
        const ultimoP = [...allPeriodos].sort((a, b) => ordPeriodo(a) - ordPeriodo(b)).slice(-1)[0];
        const r = await sugerirClassificacoesIA(
          nmParaSugerir,
          { setor: analysis.sectorCustom ?? analysis.company.setor ?? null, receitaUltimoAno: receitaLinha && ultimoP ? receitaLinha.valores[ultimoP] ?? null : null },
          dreInputs,
        );
        sugestoesIA = r.sugestoes;
        custoSugestoes = r.custo;
        if (r.custo) console.log(`[process] sugestões IA: ${Object.keys(r.sugestoes).length}/${nmParaSugerir.length} contas, $${r.custo.usd.toFixed(4)}`);
      } catch (e: any) {
        console.warn(`[process] sugestões IA falharam (segue sem):`, e?.message ?? e);
      }
    }

    // Tela de classificação manual = N3 não-mapeados do vencedor (já é N3-only por
    // construção: heurístico entrega []; híbrido entrega os N3 de BP). NUNCA folhas N4+.
    const modeloVersoes = await getActiveModelVersions(analysis.companyId);
    const dicionarioVersao = await getCurrentDictionaryVersion(); // carimba a versão do dicionário usada no fold (pinagem interna)
    const dadosEstruturados: DadosEstruturados = {
      bp: structuredBP,
      dre: structuredDRE,
      indicadores,
      periodos: allPeriodos,
      unmatchedAccounts: [...escolhido.unmatched, ...naoMapeadosParaTela(nmBalancete)],
      declarados: declaradosDRE,
      arvoreOriginalBP: arvoreOriginalBP,
      arvoreOriginalDRE: arvoreOriginalDRE,
      naoMapeados: [...(usouIA ? (hibridoNaoMapeados as NaoMapeado[]) : []), ...nmBalancete],
      sugestoesIA,
      custoSugestoes,
      alertasComposicao: usouIA ? escolhido.alertasComposicao : [],
      modeloVersaoBP: modeloVersoes.bp,
      modeloVersaoDRE: modeloVersoes.dre,
      dicionarioVersao,
      fluxoCaixa: buildIndirectCashFlow(structuredBP, structuredDRE, allPeriodos),
      version: 2,
      custoExtracao: { usd: custoExtracaoUsd, fonte: escolhido.fonte, fecha: escolhido.fecha, niveis: custos },
    } as DadosEstruturados;
    // Linha de balancete: provas por documento + árvores mensais (o /refold as
    // re-dobra quando o dicionário/modelo muda — mesma mecânica das anuais).
    if (balanceteDocs.length > 0) {
      (dadosEstruturados as any).balancetes = balancetes;
      (dadosEstruturados as any).arvoresBalancete = arvoresBalancete;
    }
    // Correções de tipo pelo conteúdo: persistidas para o GET /validacao e o /refold
    // (que recalculam a validação do zero) continuarem mostrando o aviso ao analista.
    if (alertasTipoDoc.length > 0) (dadosEstruturados as any).alertasTipoDocumento = alertasTipoDoc;

    // HASH DE VERSÃO da extração (política 2026-07-15): proveniência COMPLETA dos
    // insumos usados — documentos (sha256 + versão), dicionário e modelos padrão de
    // BP/DRE — consultável em /analyses/:id/versoes. Produtos derivados carimbam
    // este hash no seed; divergência = histórico desatualizado.
    const extraidoEm = new Date().toISOString();
    const insumos = {
      // Proveniência inclui os BALANCETES (política de versionamento: todo insumo carimba o hash)
      documentos: [...financialDocs, ...balanceteDocs].map((d) => ({ id: d.id, nome: d.nome, tipo: d.tipo, hash: d.hash, versao: d.versao, editadoManualmente: d.editadoManualmente })),
      dicionarioVersao,
      // Cascata por empresa: quantas entradas PRÓPRIAS da empresa participaram
      // do fold (proveniência — o global sozinho não reproduz este resultado).
      dicionarioEntradasEmpresa,
      modeloVersaoBP: modeloVersoes.bp,
      modeloVersaoDRE: modeloVersoes.dre,
      // De onde veio cada modelo: "empresa" = modelo próprio (copy-on-write);
      // "global" = padrão Quantua. A versão sozinha não diz o escopo.
      modeloEscopoBP: modeloVersoes.bpEscopo,
      modeloEscopoDRE: modeloVersoes.dreEscopo,
      fonteExtracao: escolhido.fonte,
    };
    const versaoExtracao = crypto.createHash("sha256")
      .update(JSON.stringify({ documentos: insumos.documentos.map((d) => `${d.hash}:${d.versao}:${d.editadoManualmente}`).sort(), dicionarioVersao, modeloVersoes }))
      .digest("hex").slice(0, 12);
    (dadosEstruturados as any).extraidoEm = extraidoEm;
    (dadosEstruturados as any).versaoExtracao = versaoExtracao;
    (dadosEstruturados as any).insumos = insumos;

    // 3. GATE — régua ÚNICA de prontidão (prontidao-geracao.ts): documentos presentes
    //    (BP E DRE — "só BP" parava em 'Pronta para gerar' enganoso, flagrado pelo usuário),
    //    equação fechada, composição ok, 0 não classificadas com valor, DRE reconciliada
    //    quando verificável. A avaliação é PERSISTIDA em dados.prontidao (a UI lista as
    //    pendências) e a MESMA régua protege o POST /generate e é recalculada no /refold.
    const dadosComValidacao = { ...dadosEstruturados, validacao } as any;
    const prontidao = avaliarProntidaoGeracao(dadosComValidacao);
    dadosComValidacao.prontidao = prontidao;
    // INDICADORES SÓ COM EXTRAÇÃO VALIDADA (decisão do usuário 2026-07-06): número
    // derivado de DF não conciliada é enganoso — fica "sem informação" até as
    // pendências caírem; o /refold os calcula SOZINHO quando a última pendência sair.
    if (!prontidao.pronta) dadosComValidacao.indicadores = [];

    await prisma.analysis.update({
      where: { id: analysis.id },
      data: {
        dadosEstruturados: dadosComValidacao,
        periodo: allPeriodos.join(" a "),
      },
    });
    // Registro consultável da versão (idempotente por hash: reprocessar com os MESMOS
    // insumos não duplica a trilha — só extração com insumo novo cria versão nova).
    const versaoExistente = await prisma.analysisVersion.findFirst({ where: { analysisId: analysis.id, hash: versaoExtracao } });
    if (!versaoExistente) {
      await prisma.analysisVersion.create({
        data: { analysisId: analysis.id, hash: versaoExtracao, motivo: "extração", insumos: insumos as object },
      });
      void registrarAuditoria({
        userId: req.userId!, analysisId: analysis.id, entity: "analysis", entityId: analysis.id,
        field: "nova versão da extração", after: { hash: versaoExtracao, insumos }, source: "process",
      });
    }

    if (!prontidao.pronta) {
      // Pendências (documento faltando / não fecha / não classificadas / DRE divergente)
      // → o analista corrige (classificar é grátis) e o /refold reabre o caminho.
      // (Se virou "Cancelada", o updateMany não casa "Extraindo" → no-op.)
      await prisma.analysis.updateMany({
        where: { id: analysis.id, status: "Extraindo" },
        data: { status: "Revisão necessária" },
      });
      console.log(`[process] ${analysis.id}: extração com pendências → "Revisão necessária" — IA NÃO disparada: ${prontidao.pendencias.join(" | ")}`);
      return;
    }

    // 4. Extração VALIDADA. AUTO-GERAR está DESLIGADO por decisão do usuário (2026-07-06):
    //    o analista SEMPRE dá o OK antes da chamada de IA — gasto de token 100% previsível
    //    e um olhar humano antes da etapa mais cara (validações podem "fechar verde" com
    //    erro silencioso). Para religar: env AUTO_GERAR_ANALISE=true (exige também DRE
    //    PROVADA por reconciliação — regra original do auto).
    const dreProvada = validacao.reconciliacaoDRE.verificada === true && validacao.reconciliacaoDRE.ok === true;
    const AUTO_GERAR = process.env.AUTO_GERAR_ANALISE === "true";
    if (AUTO_GERAR && dreProvada && !setorPendente(analysis)) {
      const ws = await prisma.workspace.findFirst({ where: { members: { some: { id: req.userId! } } }, select: { aiAnalysisModel: true } });
      await runAnalysisBackground(analysis.id, ws?.aiAnalysisModel);
      // resposta (202) já foi enviada — frontend acompanha por polling do status.
      return;
    }
    // SETOR: extração validada → calcula a PROPOSTA do classificador (zero IA) SEMPRE
    // (alimenta o card de confirmação E o aviso da convicção). Sem confirmação, segura
    // em "Revisão necessária" com a pendência — a geração só destrava com o OK.
    try {
      const propostaSetor = await classificarSetor(dadosComValidacao.indicadores ?? [], allPeriodos);
      if (propostaSetor) await prisma.analysis.update({ where: { id: analysis.id }, data: { setorProposta: propostaSetor as unknown as object } });
    } catch (e) { console.warn(`[process] classificador de setor falhou (segue sem proposta):`, e instanceof Error ? e.message : e); }
    if (setorPendente(analysis)) {
      const prontidaoComSetor = { ...prontidao, pronta: false, pendencias: [...prontidao.pendencias, PEND_SETOR] };
      const dadosSetor = { ...dadosComValidacao, prontidao: prontidaoComSetor };
      await prisma.analysis.update({ where: { id: analysis.id }, data: { dadosEstruturados: dadosSetor as any } });
      await prisma.analysis.updateMany({
        where: { id: analysis.id, status: "Extraindo" },
        data: { status: "Revisão necessária" },
      });
      console.log(`[process] ${analysis.id}: extração validada, SETOR pendente de confirmação → "Revisão necessária"`);
      return;
    }
    await prisma.analysis.updateMany({
      where: { id: analysis.id, status: "Extraindo" },
      data: { status: "Pronta para gerar" },
    });
    console.log(`[process] ${analysis.id}: extração validada → "Pronta para gerar" (analista dá o OK) — IA NÃO disparada${prontidao.avisos.length ? ` · avisos: ${prontidao.avisos.join(" | ")}` : ""}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.analysis.update({ where: { id: analysis.id }, data: { status: "Erro", resultado: { erro: `Processamento (extração): ${msg}` } as object } });
    console.error("Erro ao processar análise:", err);
    // resposta (202) já foi enviada — o status "Erro" é entregue pelo polling.
  }
});

// Dispara a ÚNICA passada de IA manualmente (botão "Gerar análise"). Usado quando a extração
// parou em "Revisão necessária" (após o analista classificar as contas) ou "Pronta para gerar";
// também serve de "Regerar". Assíncrono (202 + polling), igual ao /process.
router.post("/:id/generate", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { id: true, dadosEstruturados: true, setorConfirmado: true, resultado: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const dados = analysis.dadosEstruturados as any;

  // TRAVA (decisão do usuário 2026-07-06): a IA só roda com a extração VALIDADA.
  // Guard por DADO (não por status) — vale para gerar E regerar, mesmo após edições.
  // ANTES do check de indicadores: com pendências os indicadores ficam vazios de
  // propósito, e o analista precisa ver as PENDÊNCIAS (409), não um 400 genérico.
  const prontidao = avaliarProntidaoGeracao(dados);
  const pendencias = [...prontidao.pendencias, ...(setorPendente(analysis) ? [PEND_SETOR] : [])];
  if (!prontidao.pronta || pendencias.length > prontidao.pendencias.length) {
    res.status(409).json({
      error: "A extração ainda não está validada — corrija as pendências antes de gerar (nenhum token foi gasto).",
      pendencias,
    });
    return;
  }
  if (!dados?.indicadores?.length) { res.status(400).json({ error: "Extraia os documentos primeiro (sem indicadores)" }); return; }

  const ws = await prisma.workspace.findFirst({ where: { members: { some: { id: req.userId! } } }, select: { aiAnalysisModel: true } });
  // "Regerar só a análise" reaproveita a pesquisa web já salva (reuseWeb) — barato. Passar
  // { refreshWeb: true } força uma nova busca (botão "atualizar pesquisa de mercado").
  const refreshWeb = req.body?.refreshWeb === true;
  res.status(202).json({ id, status: "Gerando diagnóstico" });
  // fire-and-forget: runAnalysisBackground faz a transição de status e persiste; o boot-recovery cobre órfãos.
  void runAnalysisBackground(id, ws?.aiAnalysisModel, { reuseWeb: !refreshWeb });
});

// === Structured Financial Data Endpoints ===

router.get("/:id/dados-estruturados", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { dadosEstruturados: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  if (!analysis.dadosEstruturados) { res.json({ bp: [], dre: [], indicadores: [], periodos: [], version: 1 }); return; }
  const dadosOut = analysis.dadosEstruturados as any;
  // Ocultação de indicadores aplicada NA LEITURA (config atual, não a do momento do
  // cálculo) — desativar na tela "Indicadores" reflete na hora em qualquer IBR, sem
  // precisar recalcular. Best-effort: erro na config nunca bloqueia os dados.
  try {
    if (Array.isArray(dadosOut?.indicadores) && dadosOut.indicadores.length > 0) {
      const inativos = await prisma.indicatorConfig.findMany({ where: { ativo: false }, select: { nome: true } });
      if (inativos.length > 0) {
        const off = new Set(inativos.map((i) => i.nome));
        dadosOut.indicadores = dadosOut.indicadores.map((ind: { nome: string; oculto?: boolean }) =>
          off.has(ind.nome) ? { ...ind, oculto: true } : ind.oculto ? { ...ind, oculto: false } : ind
        );
      } else if (dadosOut.indicadores.some((i: { oculto?: boolean }) => i.oculto)) {
        // ninguém mais desativado → limpa flags antigas gravadas no cálculo
        dadosOut.indicadores = dadosOut.indicadores.map((i: { oculto?: boolean }) => (i.oculto ? { ...i, oculto: false } : i));
      }
    }
  } catch { /* config indisponível — serve os dados como estão */ }
  // Linha de balancete: as árvores MENSAIS (arvoresBalancete) entram na resposta
  // mescladas em arvoreOriginalBP/DRE — a tela de auditoria/classificação
  // (Original ↔ padrão) lê essas chaves e passa a exibir os meses do balancete.
  // Mescla SÓ NA LEITURA: persistir junto faria o /refold dobrar os meses em
  // dobro (as balancete são re-dobradas pela própria lista arvoresBalancete).
  try { mesclarArvoresBalancete(dadosOut); } catch { /* best-effort — nunca bloqueia os dados */ }
  res.json(dadosOut);
});

router.put("/:id/dados-estruturados/bp", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { dadosEstruturados: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  const dados = (analysis.dadosEstruturados as any) || { bp: [], dre: [], indicadores: [], periodos: [], version: 1 };
  dados.bp = req.body.linhas;

  await prisma.analysis.update({
    where: { id },
    data: { dadosEstruturados: dados },
  });
  res.json({ ok: true });
});

router.put("/:id/dados-estruturados/dre", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { dadosEstruturados: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  const dados = (analysis.dadosEstruturados as any) || { bp: [], dre: [], indicadores: [], periodos: [], version: 1 };
  dados.dre = req.body.linhas;

  await prisma.analysis.update({
    where: { id },
    data: { dadosEstruturados: dados },
  });
  res.json({ ok: true });
});

// DORES declaradas (entrevista com o dono) — fonte [5] da análise. O confronto
// declarado×observado (confirmada / desmentida / ponto cego) nasce daqui.
// Atualiza o CADASTRO de uma análise já criada (nome / empresa / tipo / setor / tipo de
// IBR / engagement) — usado quando o analista VOLTA nas telas do wizard. Regra do
// usuário: até rodar a EXTRAÇÃO, tudo pode ser alterado — sem bloqueio e sem perder
// edição em silêncio (antes, mudar o Setor ao voltar era simplesmente descartado).
router.put("/:id/escopo", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { id: true, mode: true, nome: true, companyId: true, tipo: true, sectorId: true, sectorCustom: true, ibrType: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const data: Record<string, unknown> = {};
  if (typeof req.body?.nome === "string" && req.body.nome.trim()) data.nome = String(req.body.nome).trim().slice(0, 120);
  if (typeof req.body?.tipo === "string" && req.body.tipo.trim()) data.tipo = String(req.body.tipo).trim().slice(0, 40);
  if (typeof req.body?.companyId === "string" && req.body.companyId) {
    const company = await prisma.company.findFirst({
      where: { id: req.body.companyId, ...whereEmpresaVisivel(req) },
      select: { id: true },
    });
    if (!company) { res.status(400).json({ error: "Empresa não encontrada neste workspace" }); return; }
    data.companyId = company.id;
  }
  if (typeof req.body?.sectorId === "string" && req.body.sectorId) {
    data.sectorId = req.body.sectorId;
    // Só a escolha ATIVA do analista confirma (flag do frontend). Sugestão do CNAE
    // aceita por inércia fica registrada mas NÃO confirmada — o classificador valida
    // depois com os números (sugestão fraca nunca confirma sozinha).
    if (req.body?.setorEscolhido === true) (data as any).setorConfirmado = true;
  }
  // sectorCustom pode ser LIMPO (string vazia → null) quando o usuário troca "Outros" por setor real
  if (typeof req.body?.sectorCustom === "string") data.sectorCustom = req.body.sectorCustom.trim() || null;
  if (["light", "full", "crisis"].includes(String(req.body?.ibrType))) data.ibrType = String(req.body.ibrType);
  // mode e documentChecklist: hoje as telas estão OCULTAS no wizard (flags), mas o
  // update já os aceita — reativar as flags não ressuscita o bug de edição perdida.
  if (["recurring", "ibr"].includes(String(req.body?.mode))) data.mode = String(req.body.mode);
  if (Array.isArray(req.body?.documentChecklist)) data.documentChecklist = req.body.documentChecklist as object;
  if (Object.keys(data).length === 0 && !req.body?.engagement) { res.status(400).json({ error: "Nada para atualizar" }); return; }
  if (Object.keys(data).length > 0) await prisma.analysis.update({ where: { id }, data });
  // Setor MUDOU → recalibra a config de indicadores por pares (senão fica presa ao antigo).
  if (typeof data.sectorId === "string" && data.sectorId !== (analysis as any).sectorId) {
    await recalibrarConfigSeExistir(id).catch((e) => console.warn(`[escopo] recalibração pós-troca de setor falhou:`, e instanceof Error ? e.message : e));
  }

  // TRILHA: escopo do IBR editado no wizard (só o que mudou, com quem e quando).
  {
    const d = diffCampos(analysis as unknown as Record<string, unknown>, data,
      ["nome", "companyId", "tipo", "sectorId", "sectorCustom", "ibrType", "mode"]);
    if (d.mudou) {
      void registrarAuditoria({
        userId: req.userId!, analysisId: id, entity: "analysis", entityId: id,
        field: "escopo (wizard)", before: d.before, after: d.after,
      });
    }
  }

  // Engagement (registro próprio): atualiza o existente ou cria se ainda não houver.
  const eng = req.body?.engagement;
  if (eng && typeof eng === "object" && typeof eng.requestedBy === "string") {
    const existing = await prisma.engagement.findFirst({ where: { analysisId: id }, select: { id: true } });
    const engData = {
      requestedBy: String(eng.requestedBy).slice(0, 200),
      requestedByType: ["lender", "investor", "advisor", "empresa", "parceiro", "other"].includes(String(eng.requestedByType)) ? String(eng.requestedByType) : "other",
      scope: typeof eng.scope === "string" ? eng.scope.slice(0, 4000) : "",
      deadline: eng.deadline ? new Date(String(eng.deadline)) : null,
      feeAmount: typeof eng.feeAmount === "number" && Number.isFinite(eng.feeAmount) ? eng.feeAmount : null,
    };
    if (existing) {
      await prisma.engagement.update({ where: { id: existing.id }, data: engData });
    } else if (eng.requestedBy.trim()) {
      const comp = await prisma.analysis.findUnique({ where: { id }, select: { company: { select: { nomeFantasia: true, razaoSocial: true } } } });
      await prisma.engagement.create({
        data: {
          analysisId: id,
          userId: req.userId!,
          companyName: comp?.company?.nomeFantasia ?? comp?.company?.razaoSocial ?? "",
          ...engData,
          feeCurrency: "BRL",
          state: "kicked_off",
        },
      });
    }
  }
  res.json({ ok: true });
});

router.put("/:id/dores", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { id: true, dores: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const raw = req.body?.dores;
  if (!Array.isArray(raw)) { res.status(400).json({ error: "dores deve ser um array" }); return; }
  const SEVERIDADES = new Set(["alta", "media", "leve"]);
  const dores = raw
    .filter((d: unknown) => d && typeof d === "object")
    .map((d: Record<string, unknown>) => ({
      categoria: typeof d.categoria === "string" ? d.categoria.slice(0, 60) : "Geral",
      descricao: typeof d.descricao === "string" ? d.descricao.slice(0, 500) : "",
      severidade: SEVERIDADES.has(String(d.severidade)) ? String(d.severidade) : "media",
    }))
    .filter((d) => d.descricao.trim().length > 0)
    .slice(0, 30);
  await prisma.analysis.update({ where: { id }, data: { dores: dores as object[] } });
  // TRILHA: dores editadas (resumo por categoria — as descrições completas ficam no registro atual).
  const resumo = (lista: unknown) => Array.isArray(lista) ? { total: lista.length, categorias: (lista as Array<{ categoria?: string }>).map((x) => x?.categoria ?? "Geral") } : { total: 0, categorias: [] };
  void registrarAuditoria({
    userId: req.userId!, analysisId: id, entity: "analysis", entityId: id,
    field: "dores (kickoff)", before: resumo(analysis.dores), after: resumo(dores),
  });
  res.json({ ok: true, total: dores.length });
});

// Re-dobra (fold) a árvore original guardada com o dicionário ATUAL — sem IA.
// Usado após o analista classificar uma conta "Outros": reprocessa de graça.
router.post("/:id/refold", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { companyId: true, dadosEstruturados: true, indicadorConfig: true, setorConfirmado: true, resultado: true, setorProposta: true, sectorId: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const dados = analysis.dadosEstruturados as any;
  const arvoreBP = dados?.arvoreOriginalBP;
  const arvoreDRE = dados?.arvoreOriginalDRE;
  const arvoresBalanceteRefold: Array<{ periodo?: string; arvoreBP?: unknown; arvoreDRE?: unknown }> =
    Array.isArray(dados?.arvoresBalancete) ? dados.arvoresBalancete : [];
  if (!arvoreBP && !arvoreDRE && arvoresBalanceteRefold.length === 0) { res.status(400).json({ error: "Sem árvore original — rode 'Conciliar com IA' primeiro" }); return; }

  // Cascata global → workspace → EMPRESA, resolvida POR TIPO (BP e DRE têm
  // dicionários próprios — dedup misturado poderia derrubar uma entrada homônima).
  const dictRowsBrutos = await prisma.accountDictionary.findMany({
    where: whereCascataDicionarioAtiva(req.scopeUserIds!, analysis.companyId),
    select: { nomeOriginal: true, contaDestino: true, grupoConta: true, userId: true, companyId: true, tipo: true },
  });
  const dictRows = [...resolverCascataDicionario(dictRowsBrutos, "BP"), ...resolverCascataDicionario(dictRowsBrutos, "DRE")];
  // Ordena e PERSISTE em ordem cronológica — o refold é o caminho que conserta os
  // IBRs antigos gravados com períodos na ordem dos documentos.
  const periodos: string[] = [...(dados.periodos ?? Object.keys(arvoreBP ?? arvoreDRE ?? {}))]
    .sort((a, b) => ordPeriodo(a) - ordPeriodo(b));
  dados.periodos = periodos;
  const naoMapeados: any[] = [];
  const bpModelRefold = await loadActiveBPModel(analysis.companyId); // bridge: re-dobra com o modelo vigente (cascata empresa→global)
  const dreModelRefold = await loadActiveDREModel(analysis.companyId);
  const alertasComp: any[] = [];
  if (arvoreBP) { const r = foldBP(arvoreBP, periodos, dictRows, bpModelRefold); dados.bp = r.bp; dados.arvoreOriginalBP = arvoreBP; alertasComp.push(...r.alertasComposicao); naoMapeados.push(...r.naoMapeados); }
  if (arvoreDRE) { const r = foldDRE(arvoreDRE, periodos, dictRows, dreModelRefold); dados.dre = r.dre; dados.arvoreOriginalDRE = arvoreDRE; alertasComp.push(...r.alertasComposicao); naoMapeados.push(...r.naoMapeados); }
  // Linha de balancete: re-dobra as árvores MENSAIS com o dicionário atual e
  // mescla nos meses (as anuais acima zeram os meses; o merge só preenche vazios).
  for (const ab of arvoresBalanceteRefold) {
    if (!ab?.periodo) continue;
    if (ab.arvoreBP) { const r = foldBP(ab.arvoreBP as any, [ab.periodo], dictRows, bpModelRefold); if (!dados.bp?.length) dados.bp = r.bp; else mergeItensPorConta(dados.bp, r.bp); alertasComp.push(...r.alertasComposicao); naoMapeados.push(...semPlugBalancete(r.naoMapeados)); }
    if (ab.arvoreDRE) { const r = foldDRE(ab.arvoreDRE as any, [ab.periodo], dictRows, dreModelRefold); if (!dados.dre?.length) dados.dre = r.dre; else mergeItensPorConta(dados.dre, r.dre); alertasComp.push(...r.alertasComposicao); naoMapeados.push(...r.naoMapeados); }
  }
  dados.alertasComposicao = alertasComp;
  // Carry-over das sugestões IA (cacheadas na extração) para os que continuam não-mapeados.
  const sugAntigas = (dados as any).sugestoesIA ?? {};
  const sugNovas: Record<string, any> = {};
  for (const nm of naoMapeados) { const k = chaveNM(nm as any); if (sugAntigas[k]) sugNovas[k] = sugAntigas[k]; }
  (dados as any).sugestoesIA = sugNovas;
  dados.naoMapeados = naoMapeados;
  // FC continua visível mesmo sem validação completa: é SUPERFÍCIE DE AUDITORIA
  // (tem prova de fechamento própria) e ajuda a diagnosticar as pendências.
  dados.fluxoCaixa = buildIndirectCashFlow(dados.bp ?? [], dados.dre ?? [], periodos); // FC acompanha o refold (grátis)

  // VALIDAÇÃO + PRONTIDÃO acompanham o refold: reclassificar muda subtotais (DRE) e zera
  // pendências — sem recalcular, o gate ficava preso no estado da extração. Classificou a
  // última conta → status vira "Pronta para gerar" SOZINHO (sem beco sem saída); apareceu
  // pendência nova → volta a "Revisão necessária". Só mexe nos estados do checkpoint
  // (nunca rebaixa "Concluída"/"Gerando diagnóstico").
  if (dados.version === 2) {
    dados.validacao = validateFinancialData(dados.bp ?? [], dados.dre ?? [], periodos, (dados as any).declarados);
    aplicarProvasBalancete(dados.validacao, dados as any);
    dados.validacao.alertas.push(...(((dados as any).alertasTipoDocumento ?? []) as typeof dados.validacao.alertas));
  }
  const prontidaoRefold = avaliarProntidaoGeracao(dados);
  (dados as any).prontidao = prontidaoRefold;

  // INDICADORES: automáticos (sem pedido do analista), mas SÓ com extração validada —
  // caiu a última pendência, este refold já os calcula; com pendências, ficam vazios
  // ("sem informação" em vez de número enganoso). Overrides manuais são preservados.
  if (prontidaoRefold.pronta) {
    const novos = await buildIndicators(dados.bp ?? [], dados.dre ?? [], periodos, rowsIBRDe(analysis.indicadorConfig), periodosBalanceteDe(dados));
    for (const n of novos) {
      const antigo = (dados.indicadores as any[])?.find((i) => i?.nome === n.nome);
      if (antigo?.overrides) (n as any).overrides = antigo.overrides;
    }
    dados.indicadores = novos;
  } else {
    dados.indicadores = [];
  }

  // SETOR: com os indicadores prontos, o CLASSIFICADOR calcula/atualiza a proposta
  // (zero IA) SEMPRE — os indicadores acima NÃO dependem disto (senão o classificador
  // nunca teria números). Sem confirmação → PENDÊNCIA (gate); confirmado mas números
  // discordando forte → AVISO da convicção (âmbar, não bloqueia). Best-effort.
  let prontidaoFinal = prontidaoRefold;
  if (prontidaoRefold.pronta) {
    let proposta: unknown = (analysis as any).setorProposta ?? null;
    try {
      const nova = await classificarSetor(dados.indicadores ?? [], periodos);
      if (nova) { proposta = nova; await prisma.analysis.update({ where: { id }, data: { setorProposta: nova as unknown as object } }); }
    } catch (e) { console.warn(`[refold] classificador de setor falhou (segue sem proposta):`, e instanceof Error ? e.message : e); }
    if (setorPendente(analysis)) {
      prontidaoFinal = { ...prontidaoRefold, pronta: false, pendencias: [...prontidaoRefold.pendencias, PEND_SETOR] };
    } else {
      const aviso = avisoSetorDe(proposta, (analysis as any).sectorId ?? null);
      if (aviso) prontidaoFinal = { ...prontidaoRefold, avisos: [...prontidaoRefold.avisos, aviso] };
    }
  }
  (dados as any).prontidao = prontidaoFinal;

  await prisma.analysis.update({ where: { id }, data: { dadosEstruturados: dados } });
  await prisma.analysis.updateMany({
    where: { id, status: { in: ["Revisão necessária", "Pronta para gerar"] } },
    data: { status: prontidaoFinal.pronta ? "Pronta para gerar" : "Revisão necessária" },
  });
  res.json({ ok: true, naoMapeados: naoMapeados.length, prontidao: prontidaoFinal });
});

// Salva a árvore original do BP (auditoria original ↔ padrão) + não-mapeados
router.put("/:id/dados-estruturados/arvore", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { companyId: true, dadosEstruturados: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  const dados = (analysis.dadosEstruturados as any) || { bp: [], dre: [], indicadores: [], periodos: [], version: 1 };
  dados.arvoreOriginalBP = req.body.arvoreOriginalBP ?? null;
  dados.arvoreOriginalDRE = req.body.arvoreOriginalDRE ?? null;
  dados.naoMapeados = req.body.naoMapeados ?? [];
  if (req.body.declarados) dados.declarados = req.body.declarados; // base da trava de reconciliação após aplicar a IA
  const mv = await getActiveModelVersions(analysis.companyId); // carimba a versão de modelo usada (pinagem)
  dados.modeloVersaoBP = mv.bp;
  dados.modeloVersaoDRE = mv.dre;
  dados.dicionarioVersao = await getCurrentDictionaryVersion(); // versão do dicionário no re-fold
  // A extração por IA (árvore + fold) substitui o resultado do parser heurístico:
  // limpa a lista antiga de "não classificadas" (o que sobrar está em naoMapeados/Outros).
  dados.unmatchedAccounts = [];

  await prisma.analysis.update({ where: { id }, data: { dadosEstruturados: dados } });
  res.json({ ok: true });
});

router.put("/:id/dados-estruturados/indicadores/override", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { dadosEstruturados: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  const { nome, periodo, valor } = req.body;
  const dados = (analysis.dadosEstruturados as any) || { bp: [], dre: [], indicadores: [], periodos: [], version: 1 };

  const indicador = dados.indicadores?.find((i: any) => i.nome === nome);
  if (indicador) {
    if (!indicador.overrides) indicador.overrides = {};
    indicador.overrides[periodo] = valor;
  }

  await prisma.analysis.update({
    where: { id },
    data: { dadosEstruturados: dados },
  });
  res.json({ ok: true });
});

/* ───────── INDICADORES POR IBR: réplica editável do catálogo, calibrada pelos pares ─────────
 * GET  → seed-if-empty (copia o catálogo padrão) + calibração automática ÚNICA pelos
 *        quartis dos pares quando já há indicadores calculados (extração validada).
 * PUT  → salva edições (sanitizadas) + recalcula dados.indicadores se a extração está
 *        validada (mesmo gate do refold) + trilha de auditoria.
 * POST /recalibrar → re-seed do padrão + nova calibração pelos pares (auditada). */

async function recalcularIndicadoresComConfig(id: string, dados: any, rows: ConfigRow[]): Promise<boolean> {
  const prontidao = avaliarProntidaoGeracao(dados);
  if (!prontidao.pronta) return false; // sem extração validada, indicadores seguem vazios (gate)
  const novos = await buildIndicators(dados.bp ?? [], dados.dre ?? [], dados.periodos ?? [], rows, periodosBalanceteDe(dados));
  for (const n of novos) {
    const antigo = (dados.indicadores as any[])?.find((i) => i?.nome === n.nome);
    if (antigo?.overrides) (n as any).overrides = antigo.overrides;
  }
  dados.indicadores = novos;
  await prisma.analysis.update({ where: { id }, data: { dadosEstruturados: dados } });
  return true;
}

router.get("/:id/indicador-config", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { indicadorConfig: true, sectorId: true, dadosEstruturados: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  const dados = analysis.dadosEstruturados as any;
  let cfg = analysis.indicadorConfig as unknown as IBRIndicadorConfig | null;
  let mudou = false;
  let calibrouAgora = false;
  let ganhouPersonalizados = false;
  const padraoCat = await catalogoPadraoEfetivo();

  if (!cfg || !Array.isArray(cfg.rows) || cfg.rows.length === 0) {
    // Seed: réplica do catálogo padrão do dia (a partir daqui, evolui só neste IBR).
    cfg = { calibrado: false, pares: null, atualizadoEm: new Date().toISOString(), rows: padraoCat };
    mudou = true;
  } else {
    // PERSONALIZADOS criados no catálogo GLOBAL depois do snapshot deste IBR
    // entram por MERGE (por nome) — sem tocar em nada que o analista já
    // configurou aqui. Era o buraco do "criei o indicador e não aparece".
    const novos = padraoCat.filter((r) => !r.sistema && !cfg!.rows.some((x) => x.nome === r.nome));
    if (novos.length) {
      cfg = { ...cfg, rows: [...cfg.rows, ...novos], atualizadoEm: new Date().toISOString() };
      mudou = true;
      ganhouPersonalizados = true;
    }
  }
  // Calibração automática ÚNICA: precisa dos VALORES da empresa (base do pareamento CVM),
  // então só acontece quando a extração validada já produziu indicadores. Depois disso,
  // recalibrar é ação explícita (botão) — edição manual do analista nunca é sobrescrita.
  if (!cfg.calibrado && Array.isArray(dados?.indicadores) && dados.indicadores.length > 0) {
    const pares = await calibrarSemaforoComPares(cfg.rows, analysis.sectorId, dados.indicadores, dados.periodos ?? []);
    cfg = { ...cfg, calibrado: true, pares, atualizadoEm: new Date().toISOString() };
    mudou = true;
    calibrouAgora = true;
  }
  if (mudou) {
    await prisma.analysis.update({ where: { id }, data: { indicadorConfig: cfg as unknown as object } });
    // Recalcula quando o resultado VISÍVEL muda: semáforo calibrado agora ou
    // personalizado novo que precisa aparecer nos indicadores já calculados.
    const precisaRecalc = (calibrouAgora && (cfg.pares?.calibrados ?? 0) > 0) || ganhouPersonalizados;
    if (precisaRecalc) await recalcularIndicadoresComConfig(id, dados, cfg.rows as unknown as ConfigRow[]);
  }
  res.json(cfg);
});

router.put("/:id/indicador-config", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { indicadorConfig: true, dadosEstruturados: true, nome: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  const anterior = analysis.indicadorConfig as unknown as IBRIndicadorConfig | null;
  const padrao = await catalogoPadraoEfetivo();
  const rows = sanitizeRowsIBR(req.body?.rows, padrao);
  // Preserva a proveniência do semáforo quando os limiares não mudaram; senão "editado".
  for (const r of rows) {
    const ant = anterior?.rows?.find((a) => a.nome === r.nome);
    if (!ant) continue;
    if (ant.semCritico === r.semCritico && ant.semAtencao === r.semAtencao && ant.semDirecao === r.semDirecao) {
      r.origemSemaforo = ant.origemSemaforo ?? r.origemSemaforo;
    } else {
      r.origemSemaforo = "editado";
    }
  }
  const cfg: IBRIndicadorConfig = {
    calibrado: anterior?.calibrado ?? false,
    pares: anterior?.pares ?? null,
    atualizadoEm: new Date().toISOString(),
    rows,
  };
  await prisma.analysis.update({ where: { id }, data: { indicadorConfig: cfg as unknown as object } });

  const dados = analysis.dadosEstruturados as any;
  const recalculado = dados ? await recalcularIndicadoresComConfig(id, dados, rows as unknown as ConfigRow[]) : false;

  // Trilha de auditoria ([[auditabilidade-obrigatoria]]): resumo do que mudou.
  const antes = anterior?.rows ?? [];
  const mudancas: string[] = [];
  for (const r of rows) {
    const a = antes.find((x) => x.nome === r.nome);
    if (!a) { if (!r.sistema) mudancas.push(`+ ${r.nome} (personalizado)`); continue; }
    if (a.ativo !== r.ativo) mudancas.push(`${r.nome}: ${r.ativo ? "exibido" : "oculto"}`);
    if (a.semCritico !== r.semCritico || a.semAtencao !== r.semAtencao || a.semDirecao !== r.semDirecao) mudancas.push(`${r.nome}: semáforo`);
  }
  for (const a of antes.filter((x) => !x.sistema)) if (!rows.some((r) => r.nome === a.nome)) mudancas.push(`− ${a.nome}`);
  void registrarAuditoria({
    userId: req.userId!, analysisId: id, entity: "analysis", entityId: id,
    field: "indicadores do IBR", before: mudancas.length ? mudancas.slice(0, 30).join("; ") : "(sem mudança)", after: `${rows.length} indicadores`,
    source: "indicador-config-ibr", reason: "Configuração de indicadores do IBR",
  });
  res.json({ ok: true, config: cfg, indicadoresRecalculados: recalculado });
});

router.post("/:id/indicador-config/recalibrar", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { indicadorConfig: true, sectorId: true, dadosEstruturados: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const dados = analysis.dadosEstruturados as any;

  // Re-seed do padrão + calibração nova — descarta edições manuais de semáforo/exibição
  // (o frontend avisa antes). Personalizados DESTE IBR são preservados.
  const rows = await catalogoPadraoEfetivo();
  const anterior = analysis.indicadorConfig as unknown as IBRIndicadorConfig | null;
  for (const p of anterior?.rows?.filter((r) => !r.sistema && !rows.some((x) => x.nome === r.nome)) ?? []) rows.push(p);
  const pares = await calibrarSemaforoComPares(rows, analysis.sectorId, dados?.indicadores ?? [], dados?.periodos ?? []);
  const cfg: IBRIndicadorConfig = { calibrado: true, pares, atualizadoEm: new Date().toISOString(), rows };
  await prisma.analysis.update({ where: { id }, data: { indicadorConfig: cfg as unknown as object } });
  const recalculado = dados ? await recalcularIndicadoresComConfig(id, dados, rows as unknown as ConfigRow[]) : false;

  void registrarAuditoria({
    userId: req.userId!, analysisId: id, entity: "analysis", entityId: id,
    field: "indicadores do IBR", before: "recalibração pelos pares",
    after: pares ? `pares: ${pares.segmento} (${pares.calibrados} indicadores calibrados)` : "sem pares na base — semáforo padrão",
    source: "indicador-config-ibr", reason: "Recalibrar semáforo pelos pares do setor",
  });
  res.json({ ok: true, config: cfg, indicadoresRecalculados: recalculado });
});

router.post("/:id/recalcular-indicadores", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { dadosEstruturados: true, indicadorConfig: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  if (!analysis.dadosEstruturados) { res.status(400).json({ error: "Sem dados estruturados" }); return; }

  const dados = analysis.dadosEstruturados as any as DadosEstruturados;
  // Mesma trava do gate: sem extração validada não há indicador para recalcular —
  // eles são calculados AUTOMATICAMENTE quando a última pendência cai (refold).
  const prontidaoRecalc = avaliarProntidaoGeracao(dados);
  if (!prontidaoRecalc.pronta) {
    res.status(409).json({
      error: "Extração não validada — os indicadores são calculados automaticamente quando as pendências forem corrigidas.",
      pendencias: prontidaoRecalc.pendencias,
    });
    return;
  }
  const newIndicadores = await buildIndicators(dados.bp, dados.dre, dados.periodos, rowsIBRDe(analysis.indicadorConfig), periodosBalanceteDe(dados));

  // Preserve user overrides from old indicators
  for (const newInd of newIndicadores) {
    const oldInd = dados.indicadores?.find((i: any) => i.nome === newInd.nome);
    if (oldInd?.overrides) {
      newInd.overrides = oldInd.overrides;
    }
  }

  dados.indicadores = newIndicadores;

  await prisma.analysis.update({
    where: { id },
    data: { dadosEstruturados: dados as any },
  });
  res.json(dados);
});

// Reconciliação por IA (fallback acionado pelo analista) — reextrai os
// documentos via Claude (visão/PDF), recalcula e retorna a PROPOSTA para
// pré-visualização. NÃO salva — o analista aplica via PUT /dados-estruturados.
router.post("/:id/reconcile-ai", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    include: { documents: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  // Apenas DEMONSTRAÇÕES ANUAIS (BP/DRE) — ignora data-room/contratos/etc.
  // Balancete NÃO entra aqui: tem linha de extração própria e determinística
  // (o /process re-parseia e re-dobra de graça; a visão poluiria a estrutura).
  const docs = analysis.documents.filter(
    (d) => d.storagePath && !ehBalancete(d.tipo) && /dre|resultado|demonstra|balan|patrimonial|\bbp\b/i.test(`${d.tipo} ${d.nome}`)
  );
  if (docs.length === 0) { res.status(400).json({ error: "Nenhuma demonstração (BP/DRE) disponível para reconciliar" }); return; }

  // Períodos autoritativos: os já usados na análise (alinha o resultado ao display).
  const periodosAlvo: string[] = ((analysis.dadosEstruturados as any)?.periodos as string[]) ?? [];

  try {
    // Download em paralelo
    const buffers = await Promise.all(
      docs.map(async (d) => ({ buffer: await downloadFile(d.storagePath!), tipo: d.tipo }))
    );

    // Dicionário em cascata (global → workspace → EMPRESA) para o fold das árvores
    const dictBrutosIA = await prisma.accountDictionary.findMany({
      where: whereCascataDicionarioAtiva(req.scopeUserIds!, analysis.companyId),
      select: { nomeOriginal: true, contaDestino: true, grupoConta: true, userId: true, companyId: true, tipo: true },
    });
    const dictRows = [...resolverCascataDicionario(dictBrutosIA, "BP"), ...resolverCascataDicionario(dictBrutosIA, "DRE")];

    const bpModel = await loadActiveBPModel(analysis.companyId); // bridge: modelo vigente (cascata empresa→global)
    const dreModelIA = await loadActiveDREModel(analysis.companyId);
    const { bp, dre, periodos, declarados, arvoreOriginalBP, arvoreOriginalDRE, naoMapeados } =
      await extractFinancialsWithAI(buffers, periodosAlvo, dictRows, bpModel, { dreModel: dreModelIA });
    const indicadores = await buildIndicators(bp, dre, periodos, rowsIBRDe(analysis.indicadorConfig));

    // Reconciliação: subtotal computado vs DECLARADO no PDF (vindo da própria IA),
    // para TODOS os períodos (não só o primeiro).
    const reconciliacao = periodos.flatMap((p) => {
      const decl = declarados[p] ?? {};
      const comp = (c: string) => dre.find((d) => d.conta === c)?.valores[p] ?? 0;
      return ["Receita Líquida", "Lucro Bruto", "Lucro Líquido"]
        .filter((c) => typeof decl[c] === "number" && decl[c] !== 0)
        .map((conta) => {
          const declarado = decl[conta];
          const computado = comp(conta);
          const ok = Math.abs(Math.abs(computado) - Math.abs(declarado)) < Math.max(Math.abs(declarado) * 0.01, 1000);
          return { periodo: p, conta, declarado, computado, ok };
        });
    });

    res.json({ bp, dre, indicadores, periodos, reconciliacao, declarados, arvoreOriginalBP, arvoreOriginalDRE, naoMapeados });
  } catch (err: any) {
    console.error("[reconcile-ai] erro:", err?.message ?? err);
    res.status(500).json({ error: "Falha ao reconciliar com IA: " + (err?.message ?? "erro desconhecido") });
  }
});

// Validation endpoint — run validation on current structured data
/** Confirmação do SETOR (proposta do classificador ou escolha manual). Auditada; se o
 *  setor MUDOU, a calibração de indicadores por pares é refeita na hora (nada órfão). */
router.post("/:id/setor/confirmar", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const sectorId = typeof req.body?.sectorId === "string" ? req.body.sectorId.trim() : "";
  if (!sectorId) { res.status(400).json({ error: "Informe o setor (sectorId)" }); return; }
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { sectorId: true, setorConfirmado: true, dadosEstruturados: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const sector = await prisma.sector.findUnique({ where: { code: sectorId }, include: { parent: true } });
  if (!sector) { res.status(400).json({ error: "Setor inválido" }); return; }

  const mudou = analysis.sectorId !== sectorId;
  await prisma.analysis.update({ where: { id }, data: { sectorId, setorConfirmado: true } });
  // Confirmou e a extração já estava validada → destrava o checkpoint na hora.
  const dadosConf = analysis.dadosEstruturados as any;
  if (dadosConf && avaliarProntidaoGeracao(dadosConf).pronta) {
    await prisma.analysis.updateMany({ where: { id, status: "Revisão necessária" }, data: { status: "Pronta para gerar" } });
  }
  void registrarAuditoria({
    userId: req.userId!, analysisId: id, entity: "analysis", entityId: id,
    field: "setor da empresa", before: analysis.sectorId ?? "(não definido)", after: `${sector.name} (confirmado)`,
    source: "setor-classificador", reason: mudou ? "Confirmação do setor (alterado)" : "Confirmação do setor",
  });
  if (mudou) await recalibrarConfigSeExistir(id); // calibração por pares nunca fica presa ao setor antigo
  res.json({ ok: true, sectorId, recalibrado: mudou });
});

router.get("/:id/validacao", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { dadosEstruturados: true, setorConfirmado: true, resultado: true, setorProposta: true, sectorId: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  if (!analysis.dadosEstruturados) { res.status(400).json({ error: "Sem dados estruturados" }); return; }

  const dados = analysis.dadosEstruturados as any as DadosEstruturados;
  const validacao = validateFinancialData(dados.bp, dados.dre, dados.periodos, (dados as any).declarados);
  aplicarProvasBalancete(validacao, dados as any);
  validacao.alertas.push(...(((dados as any).alertasTipoDocumento ?? []) as typeof validacao.alertas));

  // Also run Benford's Law
  const allValues: number[] = [];
  for (const bp of dados.bp) {
    allValues.push(...Object.values(bp.valores).filter(v => v !== 0));
  }
  for (const dre of dados.dre) {
    allValues.push(...Object.values(dre.valores).filter(v => v !== 0));
  }
  const benford = benfordAnalysis(allValues);

  // PROVA DE COMPOSIÇÃO (motor árvore): nós cujo subtotal declarado não bate com a soma
  // dos filhos capturados. O total não quebra (delta preservado), mas a composição das
  // linhas do padrão precisa de revisão — entra como alerta de área própria.
  const alertasComp = ((dados as any).alertasComposicao ?? []) as Array<{ periodo: string; grupo: string; caminho: string; declarado: number; somaFilhos: number; delta: number; severidade?: "info" | "erro" }>;
  const fmtBR = (n: number) => n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  for (const a of alertasComp) {
    const ehInfo = a.severidade === "info";
    validacao.alertas.push({
      tipo: ehInfo ? "aviso" : "erro",
      area: "Composição",
      mensagem: `${a.periodo} · ${a.grupo}: "${a.caminho}" declara ${fmtBR(a.declarado)}, mas os filhos capturados somam ${fmtBR(a.somaFilhos)} (delta ${fmtBR(a.delta)}).`,
      detalhes: ehInfo
        ? "O nó foi classificado com o valor DECLARADO no documento — o total está correto; a captura do detalhe abaixo dele ficou incompleta (apenas transparência, sem impacto nos números)."
        : "O delta foi preservado em 'Outros' para o total não se perder — revise a captura/classificação deste nó.",
    });
  }
  const errosComp = alertasComp.filter((a) => a.severidade !== "info");

  // PRONTIDÃO AO VIVO (mesma régua do gate/POST generate) — a UI lista as pendências
  // e habilita/desabilita o "Gerar análise" por isto, nunca por status defasado.
  const prontidaoDados = avaliarProntidaoGeracao({ ...(dados as any), validacao });
  const pendSetor = setorPendente(analysis);
  let prontidao = pendSetor && prontidaoDados.pronta
    ? { ...prontidaoDados, pronta: false, pendencias: [...prontidaoDados.pendencias, PEND_SETOR] }
    : prontidaoDados;
  if (!pendSetor && prontidao.pronta) {
    const avisoConviccao = avisoSetorDe(analysis.setorProposta, analysis.sectorId);
    if (avisoConviccao) prontidao = { ...prontidao, avisos: [...prontidao.avisos, avisoConviccao] };
  }

  res.json({
    ...validacao, benford, composicaoOk: errosComp.length === 0, alertasComposicao: alertasComp, prontidao,
    // Card de confirmação do SETOR (classificador): proposta + estado atual.
    setor: { confirmado: !pendSetor, sectorId: analysis.sectorId, proposta: analysis.setorProposta ?? null },
  });
});

// Validation report — per-document extraction stats + overall summary
router.get("/:id/validation-report", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    include: { documents: { orderBy: { createdAt: "asc" } } },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  const dados = analysis.dadosEstruturados as any as DadosEstruturados | null;

  // O relatório valida DEMONSTRAÇÕES — materiais complementares (notas, PPT, docx)
  // NÃO passam pela extração; listá-los com "0 linhas · erro" só gerava confusão
  // (flagrado pelo usuário). Eles vivem na Data room e no resumo da IA da análise.
  const docsFinanceiros = analysis.documents.filter((d) => d.tipo !== "Material complementar");

  // Pendências VIVAS do motor árvore: `naoMapeados` é atualizado pelo /refold quando o
  // analista classifica (o legado `unmatchedAccounts` fica congelado na extração — usá-lo
  // deixava o relatório defasado após reclassificações).
  const normRel = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
  const temArvore = !!((dados as any)?.arvoreOriginalBP || (dados as any)?.arvoreOriginalDRE);
  const naoMapList: Array<{ nome: string; periodo?: string; tipo?: string }> =
    Array.isArray((dados as any)?.naoMapeados) ? (dados as any).naoMapeados : [];
  // Nomes de linhas por tipo de documento (para atribuir pendência órfã só onde faz sentido)
  const nomesPorTipo: Record<"BP" | "DRE", Set<string>> = { BP: new Set(), DRE: new Set() };
  for (const doc of docsFinanceiros) {
    const t = doc.tipo.toLowerCase().includes("balan") ? "BP" : "DRE";
    for (const l of ((doc.dadosExtraidos as any)?.linhas ?? []) as Array<{ conta: string }>) nomesPorTipo[t].add(normRel(l.conta));
  }

  // Build per-document stats
  const documents = docsFinanceiros.map((doc) => {
    const dadosExtraidos = doc.dadosExtraidos as any;

    // Linha de balancete: relatório pelas PROVAS da conversão determinística.
    // Aqui o fechamento correto é Ativo − Passivo = resultado acumulado do
    // período (não AT=PT) — o lucro do ano ainda não foi transferido ao PL.
    if (dadosExtraidos?.balancete === true || ehBalancete(doc.tipo)) {
      const provasBal = dadosExtraidos?.provas;
      const fech = provasBal?.fechamento;
      const totalLinhasBal: number = dadosExtraidos?.totalLinhas ?? 0;
      const periodosBal: string[] = dadosExtraidos?.periodos ?? [];
      // pendências deste doc = não-mapeados vivos nos MESES deste balancete
      const pendBal = new Set(
        naoMapList
          .filter((n) => n.periodo && periodosBal.includes(n.periodo))
          .map((n) => normRel(n.nome))
      ).size;
      let statusBal: "ok" | "warning" | "error" = "ok";
      const issuesBal: string[] = [];
      const erroBal = (dados as any)?.balancetes?.find?.((b: any) => b.docId === doc.id)?.erro;
      if (doc.status === "Erro" || totalLinhasBal === 0) {
        statusBal = "error";
        issuesBal.push(erroBal ?? "Falha na extração do balancete");
      }
      if (fech && !fech.ok) {
        statusBal = statusBal === "error" ? "error" : "warning";
        issuesBal.push(`Fechamento não bate mesmo considerando o resultado acumulado (Δ ${Number(fech.delta).toLocaleString("pt-BR", { minimumFractionDigits: 2 })})`);
      }
      if (pendBal > 0) {
        statusBal = statusBal === "error" ? "error" : "warning";
        issuesBal.push(`${pendBal} conta(s) não classificada(s) — classifique ou ignore na auditoria (grátis)`);
      }
      return {
        id: doc.id,
        nome: doc.nome,
        tipo: doc.tipo,
        status: statusBal,
        issues: issuesBal,
        stats: {
          linhasExtraidas: totalLinhasBal,
          periodosDetectados: periodosBal,
          contasMapeadas: Math.max(totalLinhasBal - pendBal, 0),
          contasNaoClassificadas: pendBal,
          totalAtivo: fech?.ativo ?? null,
          totalPassivo: fech?.passivo ?? null,
          balanceia: fech ? fech.ok === true : null,
          balancete: true,
          resultadoAcumulado: fech?.resultadoAcumulado ?? null,
          exercicioEncerrado: provasBal?.exercicioEncerrado === true,
        },
        confianca: doc.confianca ?? null,
      };
    }

    const linhas: Array<{ conta: string; valores: Record<string, number> }> = dadosExtraidos?.linhas || [];
    const periodos: string[] = dadosExtraidos?.periodos || [];

    // Detect how many accounts were classified vs unmatched
    const totalLinhas = linhas.length;
    const tipoBP = doc.tipo.toLowerCase().includes("balan") || doc.tipo.toLowerCase().includes("balancete");
    const tipoDoc: "BP" | "DRE" = tipoBP ? "BP" : "DRE";
    const linhasNorm = new Set(linhas.map((l) => normRel(l.conta)));
    let contasNaoClassificadas = 0;
    if (totalLinhas > 0) {
      if (temArvore) {
        // Motor árvore: lista viva, distinct por nome, atribuída pelo TIPO (BP/DRE) e
        // PERÍODO do documento. Pendência cujo nome não está em NENHUM doc do tipo
        // (divergência de captura) ainda conta no doc do período certo — nunca some.
        contasNaoClassificadas = new Set(
          naoMapList
            .filter((n) => (n.tipo ?? "BP") === tipoDoc)
            .filter((n) => !n.periodo || periodos.length === 0 || periodos.includes(n.periodo))
            .filter((n) => { const nn = normRel(n.nome); return linhasNorm.has(nn) || !nomesPorTipo[tipoDoc].has(nn); })
            .map((n) => normRel(n.nome))
        ).size;
      } else {
        // Legado (fluxo parser, sem árvore): unmatchedAccounts. Só conta se a pendência
        // tem VALOR num período DESTE documento — nome sozinho gera contagem fantasma
        // quando a mesma conta só ficou pendente em outro ano.
        contasNaoClassificadas = dados?.unmatchedAccounts?.filter((u) => {
          if (!linhas.some((l) => l.conta === u.conta)) return false;
          const vals = u.valores ?? {};
          const pers = Object.keys(vals);
          if (periodos.length === 0 || pers.length === 0) return true;
          return pers.some((p) => periodos.includes(p) && Math.abs(vals[p] ?? 0) > 0.005);
        }).length ?? 0;
      }
    }
    const contasMapeadas = totalLinhas - contasNaoClassificadas;

    // For BP documents, check if AT === PT (balance equation)
    let balanceia: boolean | null = null;
    let totalAtivo: number | null = null;
    let totalPassivo: number | null = null;

    if (tipoBP && dados?.bp && dados.bp.length > 0) {
      const allPeriodos = dados.periodos || [];
      // Check balance for each period
      let balanced = true;
      for (const p of allPeriodos) {
        const at = dados.bp.find((b) => b.conta === "ATIVO TOTAL")?.valores[p] ?? 0;
        const pt = dados.bp.find((b) => b.conta === "PASSIVO TOTAL")?.valores[p] ?? 0;
        if (totalAtivo === null) { totalAtivo = at; totalPassivo = pt; }
        if (Math.abs(at - pt) > 1) balanced = false; // tolerance of R$1
      }
      balanceia = balanced;
    }

    // Determine document status
    let status: "ok" | "warning" | "error" = "ok";
    const issues: string[] = [];

    if (totalLinhas === 0) {
      status = "error";
      issues.push("Nenhuma linha extraída do documento");
    }
    if (periodos.length === 0 && totalLinhas > 0) {
      status = "warning";
      issues.push("Nenhum período detectado");
    }
    if (contasNaoClassificadas > 0) {
      // QUALQUER pendência = ÂMBAR ("verde só com prova"): antes só virava warning
      // acima de 50% das linhas — 1 conta pendente ficava com check VERDE enquanto o
      // gate bloqueava a geração por ela (telas contando histórias diferentes,
      // flagrado pelo usuário). Verde volta sozinho quando a última for classificada.
      status = status === "error" ? "error" : "warning";
      issues.push(`${contasNaoClassificadas} conta(s) não classificada(s) — classifique ou ignore na auditoria (grátis)`);
    }
    if (balanceia === false) {
      status = status === "error" ? "error" : "warning";
      issues.push(`Ativo Total ≠ Passivo Total (AT=${totalAtivo?.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}, PT=${totalPassivo?.toLocaleString("pt-BR", { minimumFractionDigits: 2 })})`);
    }
    if (doc.status === "Erro") {
      status = "error";
      issues.push("Erro durante processamento");
    }

    return {
      id: doc.id,
      nome: doc.nome,
      tipo: doc.tipo,
      status,
      issues,
      stats: {
        linhasExtraidas: totalLinhas,
        periodosDetectados: periodos,
        contasMapeadas,
        contasNaoClassificadas,
        ...(tipoBP ? { totalAtivo, totalPassivo, balanceia } : {}),
      },
      confianca: doc.confianca ?? null,
    };
  });

  // Overall summary — períodos SEMPRE em ordem cronológica na exibição
  const allPeriodos = [...(dados?.periodos || [])].sort((a, b) => ordPeriodo(a) - ordPeriodo(b));
  const totalMapeadas = documents.reduce((sum, d) => sum + d.stats.contasMapeadas, 0);
  const totalLinhas = documents.reduce((sum, d) => sum + d.stats.linhasExtraidas, 0);
  const taxaClassificacao = totalLinhas > 0 ? Math.round((totalMapeadas / totalLinhas) * 1000) / 10 : 0;

  res.json({
    documents,
    overall: {
      periodosTotal: allPeriodos,
      documentosProcessados: documents.length,
      documentosComErro: documents.filter((d) => d.status === "error").length,
      documentosComAlerta: documents.filter((d) => d.status === "warning").length,
      taxaClassificacao,
    },
  });
});

/* ─────────────  Data Room (uploads internos pela equipe)  ───────────── */

router.post(
  "/:id/documents/upload",
  dataRoomUpload.single("file"),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const id = req.params.id;
    if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
    if (!req.file) { res.status(400).json({ error: "Arquivo ausente" }); return; }

    const analysis = await prisma.analysis.findFirst({
      where: { id, ...whereRecursoEmpresa(req) },
      select: { id: true, companyId: true },
    });
    if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

    const key = `data-room/${analysis.id}/${Date.now()}-${req.file.originalname}`;
    const url = await uploadFile(req.file.buffer as Buffer, key, req.file.mimetype);
    const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

    // Material complementar (notas/apresentações) vem com tipo explícito do corpo;
    // demais documentos têm o tipo detectado pelo nome/mimetype.
    const tipo = req.body?.tipo === MATERIAL_TIPO
      ? MATERIAL_TIPO
      : detectDocType(req.file.originalname, req.file.mimetype);

    const doc = await prisma.document.create({
      data: {
        analysisId: analysis.id,
        companyId: analysis.companyId,
        nome: req.file.originalname,
        tipo,
        status: "Pendente",
        storagePath: url,
        hash,
        tamanho: formatSize(req.file.size),
      },
    });

    const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { name: true } });
    await prisma.auditEvent.create({
      data: {
        analysisId: analysis.id,
        userId: req.userId!,
        userName: user?.name ?? "Usuário",
        entity: "document",
        entityId: doc.id,
        field: "upload",
        after: { nome: doc.nome, hash, tamanho: doc.tamanho } as object,
        source: "manual",
      },
    });

    res.status(201).json({
      id: doc.id,
      nome: doc.nome,
      tipo: doc.tipo,
      status: doc.status,
      hash: doc.hash,
      tamanho: doc.tamanho,
      createdAt: doc.createdAt.toISOString(),
    });
  },
);

// FIXAÇÃO (Data room única, fase B): o wizard SELECIONA documentos do pool da
// empresa e os fixa neste IBR — linha própria com proveniência congelada
// ("usa Balancete jun/26 v3") e herança do resumo de IA nos materiais.
// Idempotente: refixar o mesmo documento reusa a fixação viva.
// body: { documentIds: string[] }
router.post("/:id/documents/fixar", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const parsed = z.object({ documentIds: z.array(z.string().uuid()).min(1).max(100) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  // Cancelada já morre no guarda único do router (mutação em /:id → 409).
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { id: true, companyId: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  const resultado = await fixarDocumentosDoPool(analysis, parsed.data.documentIds);
  for (const f of resultado.fixados) {
    if (f.jaExistia) continue;
    void registrarAuditoria({
      userId: req.userId!, analysisId: analysis.id, entity: "document", entityId: f.id,
      field: "fixação de documento da Data room",
      after: { nome: f.nome, tipo: f.tipo, competencia: f.competencia, versaoFixada: f.versao, documentoPoolId: f.fixadoDeId },
      source: "data-room",
    });
  }
  res.json(resultado);
});

router.delete("/:id/documents/:docId", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  const docId = req.params.docId;
  if (!id || !docId || typeof id !== "string" || typeof docId !== "string") {
    res.status(404).json({ error: "ID inválido" }); return;
  }
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { id: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  const doc = await prisma.document.findFirst({
    where: { id: docId, analysisId: analysis.id },
  });
  if (!doc) { res.status(404).json({ error: "Documento não encontrado" }); return; }

  // POLÍTICA (2026-07-15): documento que já participou de qualquer produto NUNCA é
  // deletado — é evidência; corrija com "Substituir" (POST /documents/:id/substituir).
  // Exclusão real só para upload errado que nunca foi processado nem substituído.
  // FIXAÇÃO (fase B) é exceção deliberada: desfixar remove só a SELEÇÃO — arquivo
  // e dados permanecem no pool; bloqueia-se apenas cadeia própria do IBR (v nova).
  const jaUsado = doc.fixadoDeId
    ? !!doc.substituidoPorId
    : doc.status !== "Pendente" || !!doc.dadosExtraidos || !!doc.substituidoPorId || doc.versao > 1;
  if (jaUsado) {
    res.status(409).json({
      error: "Documento já processado não pode ser excluído — use \"Substituir\" para enviar a versão corrigida (a antiga fica preservada como evidência).",
    });
    return;
  }

  // Linha fixada compartilha o arquivo com o pool — NUNCA apagar do storage.
  if (doc.storagePath && !doc.fixadoDeId) {
    try { await deleteFile(doc.storagePath); } catch (e) { console.warn("deleteFile failed:", e); }
  }
  await prisma.document.delete({ where: { id: doc.id } });

  const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { name: true } });
  await prisma.auditEvent.create({
    data: {
      analysisId: analysis.id,
      userId: req.userId!,
      userName: user?.name ?? "Usuário",
      entity: "document",
      entityId: doc.id,
      field: "delete",
      before: { nome: doc.nome, hash: doc.hash } as object,
      source: "manual",
    },
  });

  res.status(204).end();
});

router.get("/:id/documents/:docId/download", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  const docId = req.params.docId;
  if (!id || !docId || typeof id !== "string" || typeof docId !== "string") {
    res.status(404).json({ error: "ID inválido" }); return;
  }
  const doc = await prisma.document.findFirst({
    where: { id: docId, analysis: { id, ...whereRecursoEmpresa(req) } },
  });
  if (!doc || !doc.storagePath) { res.status(404).json({ error: "Documento não encontrado" }); return; }

  try {
    const url = await getSignedDownloadUrl(doc.storagePath, 300);
    res.json({ url, expiresIn: 300, nome: doc.nome, hash: doc.hash });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Falha ao gerar URL" });
  }
});

router.get("/:id/data-room/manifest", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const analysis = await prisma.analysis.findFirst({
    where: { id, ...whereRecursoEmpresa(req) },
    select: { id: true, nome: true, documents: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="data-room-${analysis.id.slice(0,8)}-${date}.csv"`);

  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes('"') || s.includes(",") || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  res.write("id,nome,tipo,competencia,tamanho,status,sha256,created_at\n");
  for (const d of analysis.documents) {
    res.write([d.id, escape(d.nome), escape(d.tipo), escape(d.competencia ?? ""), escape(d.tamanho ?? ""), escape(d.status), d.hash ?? "", d.createdAt.toISOString()].join(",") + "\n");
  }
  res.end();
});

function detectDocType(filename: string, mimeType: string): string {
  // Balancete pelo nome do arquivo → roteia para a linha de extração própria
  if (/balancete/i.test(filename)) return "Balancete";
  const ext = filename.split(".").pop()?.toUpperCase();
  if (ext === "PDF" || mimeType === "application/pdf") return "PDF";
  if (ext === "XLSX" || ext === "XLS") return "XLSX";
  if (ext === "CSV") return "CSV";
  return "Outro";
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export default router;
