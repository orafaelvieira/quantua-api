import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import multer from "multer";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { downloadFile, uploadFile, deleteFile, getSignedDownloadUrl } from "../services/storage";
import { parseDocument, dadosExtraidosToRaw, type ExtractedRow, type ParsedDocument } from "../services/parser";
import { generateAnalysis } from "../services/claude";
import { comparePeersForIndicators, type PeerComparisonRow } from "../services/peer-benchmark";
import { PEER_INDICATOR_MAP } from "../services/peer-indicator-map";
import { comparePeersCvm, CVM_COMPARAVEIS } from "../services/peer-benchmark-cvm";
import { researchCompanyWeb, researchSectorBenchmarksWeb } from "../services/web-research";
import { buildMateriaisContext, MATERIAL_TIPO } from "../services/material-context";
import { sugerirClassificacoesIA, chaveNM } from "../services/classification-suggest";
import { mapExtractedToBP, mapExtractedToDRE, normalizeDRESigns, recomputeDRESubtotals, detectPeriodos, normalizePeriods, sugerirConta, ordPeriodo } from "../services/account-mapper";
import { DRE_TEMPLATE } from "../services/financial-templates";
import { buildIndicators } from "../services/indicator-config";
import { buildIndirectCashFlow } from "../services/cash-flow-indirect";
import { extractFinancialsWithAI, foldBP, foldDRE, type NaoMapeado } from "../services/ai-extraction";
import { getActiveModelVersions, loadActiveBPModel, loadActiveDREModel } from "../services/model-version";
import { getCurrentDictionaryVersion } from "../services/dictionary-version";
import { validateFinancialData, benfordAnalysis } from "../services/validation";
import type { DadosEstruturados, BPLineItem, DRELineItem, UnmatchedAccount } from "../types/financial";

const router = Router();
router.use(requireAuth);

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
  // Texto livre quando o picker está em "Outros" (setor fora da taxonomia B3).
  sectorCustom: z.string().max(120).optional(),
  documentChecklist: z.array(z.object({
    id: z.string(),
    label: z.string(),
    status: z.enum(["have", "requested", "na", "uploaded", "approved", "rejected", "pending"]),
  })).optional(),
  engagement: z.object({
    requestedBy: z.string().min(2),
    requestedByType: z.enum(["lender", "investor", "advisor", "other"]).default("lender"),
    scope: z.string().default(""),
    deadline: z.string().optional(),
    feeAmount: z.number().optional(),
    feeCurrency: z.string().default("BRL"),
  }).optional(),
});

router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const companyId = req.query.companyId as string | undefined;
  const analyses = await prisma.analysis.findMany({
    where: {
      userId: { in: req.scopeUserIds! },
      ...(companyId ? { companyId } : {}),
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
    where: { id: parsed.data.companyId, userId: { in: req.scopeUserIds! } },
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
    where: { id, userId: { in: req.scopeUserIds! } },
    include: {
      company: true,
      documents: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  res.json(analysis);
});

router.delete("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const existing = await prisma.analysis.findFirst({ where: { id, userId: { in: req.scopeUserIds! } } });
  if (!existing) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  await prisma.analysis.delete({ where: { id } });
  res.status(204).send();
});

// Cancela um processamento em andamento. Marca "Cancelada" SÓ se ainda está processando.
// O job em background (assíncrono) checa o status nos pontos de transição e aborta — então
// um cancelamento durante a EXTRAÇÃO evita até a chamada de análise da IA (economiza crédito).
router.post("/:id/cancel", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const existing = await prisma.analysis.findFirst({ where: { id, userId: { in: req.scopeUserIds! } } });
  if (!existing) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const r = await prisma.analysis.updateMany({
    where: { id, status: { in: ["Extraindo", "Gerando diagnóstico"] } },
    data: { status: "Cancelada" },
  });
  res.json({ cancelled: r.count > 0, status: r.count > 0 ? "Cancelada" : existing.status });
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
  const existing = await prisma.analysis.findFirst({ where: { id, userId: { in: req.scopeUserIds! } } });
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

  const { periodo, dtFim, rows: allRows } = valores.length
    ? await comparePeersCvm({ classificacao: seg.classificacao, setor: seg.setor }, valores)
    : { periodo: null, dtFim: null, rows: [] as PeerComparisonRow[] };
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

  return { year, periodo, segment: segLabel, coverage, rows, external };
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
  // "Extraindo" cobre o fluxo automático do /process (extração → geração). "Erro"/"Cancelada"
  // entram para permitir "Regerar só a análise" (reusa a extração já feita, sem re-extrair — o
  // /generate valida antes que há indicadores).
  const iniciou = await prisma.analysis.updateMany({
    where: { id: analysisId, status: { in: ["Extraindo", "Pronta para gerar", "Revisão necessária", "Concluída", "Erro", "Cancelada"] } },
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
    await prisma.analysis.updateMany({
      where: { id: analysisId, status: "Gerando diagnóstico" },
      data: { status: "Erro", resultado: { erro: `Geração da análise: ${msg}` } as object },
    });
    console.error(`[generate] ${analysisId} erro:`, err);
  }
}

router.post("/:id/process", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, userId: { in: req.scopeUserIds! } },
    include: { company: true, documents: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  // Materiais complementares (notas/apresentações) NÃO entram na extração financeira —
  // são resumidos depois, na geração da análise (buildMateriaisContext).
  const financialDocs = analysis.documents.filter((d) => d.tipo !== MATERIAL_TIPO);
  if (financialDocs.length === 0) {
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

          // Caso contrário, re-parsear o arquivo original
          const buffer = await downloadFile(doc.storagePath!);
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

    // Pre-fetch dictionary entries for this user (BP + DRE)
    const dictEntries = await prisma.accountDictionary.findMany({
      where: {
        OR: [{ userId: null }, { userId: { in: req.scopeUserIds! } }],
      },
      select: { nomeOriginal: true, contaDestino: true, grupoConta: true, userId: true, tipo: true },
    });

    // User entries override global entries with same nomeOriginal+grupoConta
    type DictRow = typeof dictEntries[number];
    const buildDictForType = (tipo: string) => {
      // Key: nomeOriginal_lower|grupoConta_lower for group-aware dedup
      const dictMap = new Map<string, { contaDestino: string; grupoConta: string }>();
      // First add global entries
      for (const e of dictEntries.filter((e: DictRow) => e.userId === null && e.tipo === tipo)) {
        const key = `${e.nomeOriginal.toLowerCase()}|${(e.grupoConta || "").toLowerCase()}`;
        dictMap.set(key, { contaDestino: e.contaDestino, grupoConta: e.grupoConta || "" });
      }
      // Then override with user entries
      for (const e of dictEntries.filter((e: DictRow) => e.userId !== null && e.tipo === tipo)) {
        const key = `${e.nomeOriginal.toLowerCase()}|${(e.grupoConta || "").toLowerCase()}`;
        dictMap.set(key, { contaDestino: e.contaDestino, grupoConta: e.grupoConta || "" });
      }
      return Array.from(dictMap.entries()).map(([key, val]) => ({
        nomeOriginal: key.split("|")[0],
        contaDestino: val.contaDestino,
        grupoConta: val.grupoConta,
      }));
    };
    const dictForBP = buildDictForType("BP");
    const dictForDRE = buildDictForType("DRE");
    const bpModel = await loadActiveBPModel(); // bridge: BP padrão vem do banco (editável), não do template do código
    const dreModel = await loadActiveDREModel(); // bridge: DRE padrão idem (contas do editor entram no dropdown e na cascata)

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

    // Merge function: combine values from a second document into existing structured data.
    // For each item in newItems, find the matching item in existing by `conta` name
    // and copy over values for periods that don't exist yet.
    function mergeBPItems(existing: BPLineItem[], newItems: BPLineItem[]): void {
      const existingMap = new Map<string, BPLineItem>();
      for (const item of existing) existingMap.set(item.conta, item);

      for (const newItem of newItems) {
        const target = existingMap.get(newItem.conta);
        if (target) {
          // Merge periods: copy new period values that don't exist in existing
          for (const [periodo, valor] of Object.entries(newItem.valores)) {
            if (target.valores[periodo] === undefined || target.valores[periodo] === 0) {
              target.valores[periodo] = valor;
            }
          }
        } else {
          // New account not in existing — append it
          existing.push(newItem);
          existingMap.set(newItem.conta, newItem);
        }
      }
    }

    function mergeDREItems(existing: DRELineItem[], newItems: DRELineItem[]): void {
      const existingMap = new Map<string, DRELineItem>();
      for (const item of existing) existingMap.set(item.conta, item);

      for (const newItem of newItems) {
        const target = existingMap.get(newItem.conta);
        if (target) {
          for (const [periodo, valor] of Object.entries(newItem.valores)) {
            if (target.valores[periodo] === undefined || target.valores[periodo] === 0) {
              target.valores[periodo] = valor;
            }
          }
        } else {
          existing.push(newItem);
          existingMap.set(newItem.conta, newItem);
        }
      }
    }

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
        if (querBP) { const r = mapExtractedToBP(doc.linhas, dictForBP, bpModel); if (!bp.length) bp = r.items; else mergeBPItems(bp, r.items); unm.push(...r.unmatched); }
        if (querDRE) { const r = mapExtractedToDRE(doc.linhas, dictForDRE); if (!dre.length) dre = r.items; else mergeDREItems(dre, r.items); unm.push(...r.unmatched); }
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
    const validacao = escolhido.validacao;
    const custoExtracaoUsd = custoTotalUsd;

    // DRE já normalizada/recalculada e validada na cascata (avalia) → só os indicadores.
    const indicadores = await buildIndicators(structuredBP, structuredDRE, allPeriodos);
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
    const nmParaSugerir = (usouIA ? hibridoNaoMapeados : []) as import("../services/ai-extraction").NaoMapeado[];
    if (nmParaSugerir.length > 0) {
      try {
        const dreModelAtivo = await loadActiveDREModel();
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
    const modeloVersoes = await getActiveModelVersions();
    const dicionarioVersao = await getCurrentDictionaryVersion(); // carimba a versão do dicionário usada no fold (pinagem interna)
    const dadosEstruturados: DadosEstruturados = {
      bp: structuredBP,
      dre: structuredDRE,
      indicadores,
      periodos: allPeriodos,
      unmatchedAccounts: escolhido.unmatched,
      declarados: declaradosDRE,
      arvoreOriginalBP: arvoreOriginalBP,
      arvoreOriginalDRE: arvoreOriginalDRE,
      naoMapeados: usouIA ? hibridoNaoMapeados : [],
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

    await prisma.analysis.update({
      where: { id: analysis.id },
      data: {
        dadosEstruturados: { ...dadosEstruturados, validacao } as any,
        periodo: allPeriodos.join(" a "),
      },
    });

    // 3. GATE: só dispara a IA se a extração FECHOU (5/5) E está 100% classificada (sem N3
    //    órfã com valor). Senão para em "Revisão necessária" — o analista classifica a conta
    //    (alimenta o dicionário) e dispara a análise via POST /:id/generate. Evita gastar
    //    crédito de IA em DF incompleto. (Se virou "Cancelada", o updateMany não casa
    //    "Extraindo" → no-op, e a IA não roda.)
    const naoClassMateriais = ((usouIA ? hibridoNaoMapeados : (escolhido.unmatched ?? [])) as any[])
      .filter((n) => Object.values(n?.valores ?? {}).some((v) => typeof v === "number" && v !== 0)).length;
    const bpLimpo = escolhido.fecha === true && naoClassMateriais === 0;
    // "verde só com prova": a DRE só conta como provada se foi VERIFICADA contra os subtotais
    // declarados no documento (verificada && ok). DRE não verificável (sem declarados) NÃO prova.
    const dreProvada = validacao.reconciliacaoDRE.verificada === true && validacao.reconciliacaoDRE.ok === true;

    if (!bpLimpo) {
      // Não fecha (faltam contas / desbalanceado) ou há N3 não classificada → precisa corrigir.
      await prisma.analysis.updateMany({
        where: { id: analysis.id, status: "Extraindo" },
        data: { status: "Revisão necessária" },
      });
      console.log(`[process] ${analysis.id}: extração não-limpa (fecha=${escolhido.fecha}, naoClassificadas=${naoClassMateriais}) → "Revisão necessária" — IA NÃO disparada`);
      return;
    }
    if (!dreProvada) {
      // BP fecha e tudo classificado, MAS a DRE não pôde ser PROVADA por reconciliação
      // (documento sem subtotais declarados). Não auto-roda — o analista decide via "Gerar análise".
      await prisma.analysis.updateMany({
        where: { id: analysis.id, status: "Extraindo" },
        data: { status: "Pronta para gerar" },
      });
      console.log(`[process] ${analysis.id}: BP fecha mas DRE não verificada (sem declarados) → "Pronta para gerar" (analista decide) — IA NÃO disparada`);
      return;
    }

    // 4. Prova COMPLETA (BP fecha + 0 não classificadas + DRE verificada) → roda a ÚNICA passada
    //    de IA automaticamente (preenche o IBR).
    const ws = await prisma.workspace.findFirst({ where: { members: { some: { id: req.userId! } } }, select: { aiAnalysisModel: true } });
    await runAnalysisBackground(analysis.id, ws?.aiAnalysisModel);
    // resposta (202) já foi enviada — frontend acompanha por polling do status.
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
    where: { id, userId: { in: req.scopeUserIds! } },
    select: { id: true, dadosEstruturados: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const dados = analysis.dadosEstruturados as any;
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
    where: { id, userId: { in: req.scopeUserIds! } },
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
  res.json(dadosOut);
});

router.put("/:id/dados-estruturados/bp", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, userId: { in: req.scopeUserIds! } },
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
    where: { id, userId: { in: req.scopeUserIds! } },
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
router.put("/:id/dores", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, userId: { in: req.scopeUserIds! } },
    select: { id: true },
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
  res.json({ ok: true, total: dores.length });
});

// Re-dobra (fold) a árvore original guardada com o dicionário ATUAL — sem IA.
// Usado após o analista classificar uma conta "Outros": reprocessa de graça.
router.post("/:id/refold", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, userId: { in: req.scopeUserIds! } },
    select: { dadosEstruturados: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  const dados = analysis.dadosEstruturados as any;
  const arvoreBP = dados?.arvoreOriginalBP;
  const arvoreDRE = dados?.arvoreOriginalDRE;
  if (!arvoreBP && !arvoreDRE) { res.status(400).json({ error: "Sem árvore original — rode 'Conciliar com IA' primeiro" }); return; }

  const dictRows = await prisma.accountDictionary.findMany({
    where: { OR: [{ userId: null }, { userId: { in: req.scopeUserIds! } }] },
    select: { nomeOriginal: true, contaDestino: true, grupoConta: true },
  });
  // Ordena e PERSISTE em ordem cronológica — o refold é o caminho que conserta os
  // IBRs antigos gravados com períodos na ordem dos documentos.
  const periodos: string[] = [...(dados.periodos ?? Object.keys(arvoreBP ?? arvoreDRE ?? {}))]
    .sort((a, b) => ordPeriodo(a) - ordPeriodo(b));
  dados.periodos = periodos;
  const naoMapeados: any[] = [];
  const bpModelRefold = await loadActiveBPModel(); // bridge: re-dobra com o modelo de BP vigente do banco
  const dreModelRefold = await loadActiveDREModel();
  const alertasComp: any[] = [];
  if (arvoreBP) { const r = foldBP(arvoreBP, periodos, dictRows, bpModelRefold); dados.bp = r.bp; dados.arvoreOriginalBP = arvoreBP; alertasComp.push(...r.alertasComposicao); naoMapeados.push(...r.naoMapeados); }
  if (arvoreDRE) { const r = foldDRE(arvoreDRE, periodos, dictRows, dreModelRefold); dados.dre = r.dre; dados.arvoreOriginalDRE = arvoreDRE; alertasComp.push(...r.alertasComposicao); naoMapeados.push(...r.naoMapeados); }
  dados.alertasComposicao = alertasComp;
  // Carry-over das sugestões IA (cacheadas na extração) para os que continuam não-mapeados.
  const sugAntigas = (dados as any).sugestoesIA ?? {};
  const sugNovas: Record<string, any> = {};
  for (const nm of naoMapeados) { const k = chaveNM(nm as any); if (sugAntigas[k]) sugNovas[k] = sugAntigas[k]; }
  (dados as any).sugestoesIA = sugNovas;
  dados.naoMapeados = naoMapeados;
  dados.indicadores = await buildIndicators(dados.bp ?? [], dados.dre ?? [], periodos);
  dados.fluxoCaixa = buildIndirectCashFlow(dados.bp ?? [], dados.dre ?? [], periodos); // FC acompanha o refold (grátis)

  await prisma.analysis.update({ where: { id }, data: { dadosEstruturados: dados } });
  res.json({ ok: true, naoMapeados: naoMapeados.length });
});

// Salva a árvore original do BP (auditoria original ↔ padrão) + não-mapeados
router.put("/:id/dados-estruturados/arvore", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, userId: { in: req.scopeUserIds! } },
    select: { dadosEstruturados: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  const dados = (analysis.dadosEstruturados as any) || { bp: [], dre: [], indicadores: [], periodos: [], version: 1 };
  dados.arvoreOriginalBP = req.body.arvoreOriginalBP ?? null;
  dados.arvoreOriginalDRE = req.body.arvoreOriginalDRE ?? null;
  dados.naoMapeados = req.body.naoMapeados ?? [];
  if (req.body.declarados) dados.declarados = req.body.declarados; // base da trava de reconciliação após aplicar a IA
  const mv = await getActiveModelVersions(); // carimba a versão de modelo usada (pinagem)
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
    where: { id, userId: { in: req.scopeUserIds! } },
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

router.post("/:id/recalcular-indicadores", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, userId: { in: req.scopeUserIds! } },
    select: { dadosEstruturados: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  if (!analysis.dadosEstruturados) { res.status(400).json({ error: "Sem dados estruturados" }); return; }

  const dados = analysis.dadosEstruturados as any as DadosEstruturados;
  const newIndicadores = await buildIndicators(dados.bp, dados.dre, dados.periodos);

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
    where: { id, userId: { in: req.scopeUserIds! } },
    include: { documents: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  // Apenas DEMONSTRAÇÕES (BP/DRE/Balancete) — ignora data-room/contratos/etc.
  const docs = analysis.documents.filter(
    (d) => d.storagePath && /dre|resultado|demonstra|balan|patrimonial|\bbp\b/i.test(`${d.tipo} ${d.nome}`)
  );
  if (docs.length === 0) { res.status(400).json({ error: "Nenhuma demonstração (BP/DRE) disponível para reconciliar" }); return; }

  // Períodos autoritativos: os já usados na análise (alinha o resultado ao display).
  const periodosAlvo: string[] = ((analysis.dadosEstruturados as any)?.periodos as string[]) ?? [];

  try {
    // Download em paralelo
    const buffers = await Promise.all(
      docs.map(async (d) => ({ buffer: await downloadFile(d.storagePath!), tipo: d.tipo }))
    );

    // Dicionário (global + workspace) para o fold das árvores BP e DRE
    const dictRows = await prisma.accountDictionary.findMany({
      where: { OR: [{ userId: null }, { userId: { in: req.scopeUserIds! } }] },
      select: { nomeOriginal: true, contaDestino: true, grupoConta: true },
    });

    const bpModel = await loadActiveBPModel(); // bridge: usa o modelo de BP vigente do banco
    const dreModelIA = await loadActiveDREModel();
    const { bp, dre, periodos, declarados, arvoreOriginalBP, arvoreOriginalDRE, naoMapeados } =
      await extractFinancialsWithAI(buffers, periodosAlvo, dictRows, bpModel, { dreModel: dreModelIA });
    const indicadores = await buildIndicators(bp, dre, periodos);

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
router.get("/:id/validacao", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, userId: { in: req.scopeUserIds! } },
    select: { dadosEstruturados: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  if (!analysis.dadosEstruturados) { res.status(400).json({ error: "Sem dados estruturados" }); return; }

  const dados = analysis.dadosEstruturados as any as DadosEstruturados;
  const validacao = validateFinancialData(dados.bp, dados.dre, dados.periodos, (dados as any).declarados);

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

  res.json({ ...validacao, benford, composicaoOk: errosComp.length === 0, alertasComposicao: alertasComp });
});

// Validation report — per-document extraction stats + overall summary
router.get("/:id/validation-report", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, userId: { in: req.scopeUserIds! } },
    include: { documents: { orderBy: { createdAt: "asc" } } },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  const dados = analysis.dadosEstruturados as any as DadosEstruturados | null;

  // Pendências VIVAS do motor árvore: `naoMapeados` é atualizado pelo /refold quando o
  // analista classifica (o legado `unmatchedAccounts` fica congelado na extração — usá-lo
  // deixava o relatório defasado após reclassificações).
  const normRel = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
  const temArvore = !!((dados as any)?.arvoreOriginalBP || (dados as any)?.arvoreOriginalDRE);
  const naoMapList: Array<{ nome: string; periodo?: string; tipo?: string }> =
    Array.isArray((dados as any)?.naoMapeados) ? (dados as any).naoMapeados : [];
  // Nomes de linhas por tipo de documento (para atribuir pendência órfã só onde faz sentido)
  const nomesPorTipo: Record<"BP" | "DRE", Set<string>> = { BP: new Set(), DRE: new Set() };
  for (const doc of analysis.documents) {
    const t = doc.tipo.toLowerCase().includes("balan") ? "BP" : "DRE";
    for (const l of ((doc.dadosExtraidos as any)?.linhas ?? []) as Array<{ conta: string }>) nomesPorTipo[t].add(normRel(l.conta));
  }

  // Build per-document stats
  const documents = analysis.documents.map((doc) => {
    const dadosExtraidos = doc.dadosExtraidos as any;
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
      if (contasNaoClassificadas > totalLinhas * 0.5) {
        status = status === "error" ? "error" : "warning";
      }
      issues.push(`${contasNaoClassificadas} conta(s) não classificada(s)`);
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
      where: { id, userId: { in: req.scopeUserIds! } },
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

router.delete("/:id/documents/:docId", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  const docId = req.params.docId;
  if (!id || !docId || typeof id !== "string" || typeof docId !== "string") {
    res.status(404).json({ error: "ID inválido" }); return;
  }
  const analysis = await prisma.analysis.findFirst({
    where: { id, userId: { in: req.scopeUserIds! } },
    select: { id: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  const doc = await prisma.document.findFirst({
    where: { id: docId, analysisId: analysis.id },
  });
  if (!doc) { res.status(404).json({ error: "Documento não encontrado" }); return; }

  if (doc.storagePath) {
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
    where: { id: docId, analysis: { id, userId: { in: req.scopeUserIds! } } },
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
    where: { id, userId: { in: req.scopeUserIds! } },
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
