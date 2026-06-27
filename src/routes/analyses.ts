import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import multer from "multer";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { downloadFile, uploadFile, deleteFile, getSignedDownloadUrl } from "../services/storage";
import { parseDocument, dadosExtraidosToRaw, type ExtractedRow, type ParsedDocument } from "../services/parser";
import { generateAnalysis } from "../services/claude";
import { mapExtractedToBP, mapExtractedToDRE, normalizeDRESigns, recomputeDRESubtotals, detectPeriodos, normalizePeriods } from "../services/account-mapper";
import { calculateIndicators } from "../services/indicator-calculator";
import { extractFinancialsWithAI, foldBP, foldDRE } from "../services/ai-extraction";
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

// Endpoint principal: dispara extração dos documentos + geração da análise com Claude
router.post("/:id/process", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const analysis = await prisma.analysis.findFirst({
    where: { id, userId: { in: req.scopeUserIds! } },
    include: { company: true, documents: true },
  });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  if (analysis.documents.length === 0) {
    res.status(400).json({ error: "Nenhum documento enviado para esta análise" });
    return;
  }

  try {
    // 1. Atualiza status para "Extraindo"
    await prisma.analysis.update({ where: { id: analysis.id }, data: { status: "Extraindo" } });

    // 2. Baixa e parseia cada documento (ou usa dados editados manualmente)
    const parsedDocs: ParsedDocument[] = await Promise.all(
      analysis.documents.map(async (doc) => {
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
    const allPeriodos = detectPeriodos(parsedDocs);
    let structuredBP: BPLineItem[] = [];
    let structuredDRE: DRELineItem[] = [];
    const unmatchedAccounts: UnmatchedAccount[] = [];

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

    for (const doc of parsedDocs) {
      const docType = detectDocType(doc);
      console.log(`[process] Doc "${doc.tipo}" detected as ${docType}, linhas: ${doc.linhas.length}, raw length: ${doc.raw.length}`);

      if (docType === "BP" || docType === "BOTH") {
        const bpResult = mapExtractedToBP(doc.linhas, dictForBP);
        if (structuredBP.length === 0) {
          structuredBP = bpResult.items;
        } else {
          // Merge new periods into existing BP structure
          console.log(`[process] Merging additional BP document into existing (${Object.keys(bpResult.items[0]?.valores || {}).join(", ")})`);
          mergeBPItems(structuredBP, bpResult.items);
        }
        unmatchedAccounts.push(...bpResult.unmatched);
      }
      if (docType === "DRE" || docType === "BOTH") {
        const dreResult = mapExtractedToDRE(doc.linhas, dictForDRE);
        if (structuredDRE.length === 0) {
          structuredDRE = dreResult.items;
        } else {
          // Merge new periods into existing DRE structure
          console.log(`[process] Merging additional DRE document into existing (${Object.keys(dreResult.items[0]?.valores || {}).join(", ")})`);
          mergeDREItems(structuredDRE, dreResult.items);
        }
        unmatchedAccounts.push(...dreResult.unmatched);
      }

      // Fallback: if docType is UNKNOWN but user said it's DRE/BP, try anyway
      if (docType === "UNKNOWN" && doc.linhas.length > 0) {
        const tipoNorm = doc.tipo.toLowerCase();
        if (tipoNorm.includes("dre") || tipoNorm.includes("resultado")) {
          console.log(`[process] Fallback: treating UNKNOWN doc as DRE based on tipo="${doc.tipo}"`);
          const dreResult = mapExtractedToDRE(doc.linhas, dictForDRE);
          if (structuredDRE.length === 0) {
            structuredDRE = dreResult.items;
          } else {
            mergeDREItems(structuredDRE, dreResult.items);
          }
          unmatchedAccounts.push(...dreResult.unmatched);
        } else if (tipoNorm.includes("balan") || tipoNorm.includes("balancete")) {
          console.log(`[process] Fallback: treating UNKNOWN doc as BP based on tipo="${doc.tipo}"`);
          const bpResult = mapExtractedToBP(doc.linhas, dictForBP);
          if (structuredBP.length === 0) {
            structuredBP = bpResult.items;
          } else {
            mergeBPItems(structuredBP, bpResult.items);
          }
          unmatchedAccounts.push(...bpResult.unmatched);
        }
      }
    }

    // Normaliza sinais (deduções/custos/despesas → negativos) e recalcula os
    // subtotais do DRE padrão em cascata a partir das linhas de input
    normalizeDRESigns(structuredDRE, allPeriodos);
    recomputeDRESubtotals(structuredDRE, allPeriodos);

    const indicadores = calculateIndicators(structuredBP, structuredDRE, allPeriodos);

    // Run validation checks on structured data
    const validacao = validateFinancialData(structuredBP, structuredDRE, allPeriodos);
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

    const dadosEstruturados: DadosEstruturados = {
      bp: structuredBP,
      dre: structuredDRE,
      indicadores,
      periodos: allPeriodos,
      unmatchedAccounts,
      version: 2,
    };

    // Calculate document-level confidence from validation
    const docConfianca = validacao.confiancaGeral;

    await prisma.analysis.update({
      where: { id: analysis.id },
      data: {
        dadosEstruturados: { ...dadosEstruturados, validacao } as any,
        periodo: allPeriodos.join(" a "),
      },
    });

    // 3. Atualiza status para "Gerando diagnóstico"
    await prisma.analysis.update({ where: { id: analysis.id }, data: { status: "Gerando diagnóstico" } });

    // 4. Chama Claude para gerar a análise
    const resultado = await generateAnalysis(
      parsedDocs,
      {
        razaoSocial: analysis.company.razaoSocial,
        setor: analysis.company.setor ?? "Não informado",
        porte: analysis.company.porte ?? "Não informado",
      },
      analysis.periodo ?? "Período não informado"
    );

    // 5. Salva resultado e marca como concluída
    // Combine Claude's confidence with validation confidence for final score
    const finalConfianca = Math.round((resultado.confianca + docConfianca) / 2);
    const updated = await prisma.analysis.update({
      where: { id: analysis.id },
      data: {
        status: "Concluída",
        resultado: resultado as object,
        confianca: finalConfianca,
      },
    });

    res.json(updated);
  } catch (err) {
    await prisma.analysis.update({ where: { id: analysis.id }, data: { status: "Erro" } });
    console.error("Erro ao processar análise:", err);
    res.status(500).json({ error: "Erro ao processar análise", detail: String(err) });
  }
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
  res.json(analysis.dadosEstruturados);
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
  const periodos: string[] = dados.periodos ?? Object.keys(arvoreBP ?? arvoreDRE ?? {});
  const naoMapeados: any[] = [];
  if (arvoreBP) { const r = foldBP(arvoreBP, periodos, dictRows); dados.bp = r.bp; dados.arvoreOriginalBP = arvoreBP; naoMapeados.push(...r.naoMapeados); }
  if (arvoreDRE) { const r = foldDRE(arvoreDRE, periodos, dictRows); dados.dre = r.dre; dados.arvoreOriginalDRE = arvoreDRE; naoMapeados.push(...r.naoMapeados); }
  dados.naoMapeados = naoMapeados;
  dados.indicadores = calculateIndicators(dados.bp ?? [], dados.dre ?? [], periodos);

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
  const newIndicadores = calculateIndicators(dados.bp, dados.dre, dados.periodos);

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

    const { bp, dre, periodos, declarados, arvoreOriginalBP, arvoreOriginalDRE, naoMapeados } =
      await extractFinancialsWithAI(buffers, periodosAlvo, dictRows);
    const indicadores = calculateIndicators(bp, dre, periodos);

    // Reconciliação: subtotal computado vs DECLARADO no PDF (vindo da própria IA)
    const p0 = periodos[0];
    const decl = declarados[p0] ?? {};
    const comp = (c: string) => dre.find((d) => d.conta === c)?.valores[p0] ?? 0;
    const reconciliacao = ["Receita Líquida", "Lucro Bruto", "Lucro Líquido"]
      .filter((c) => typeof decl[c] === "number" && decl[c] !== 0)
      .map((conta) => {
        const declarado = decl[conta];
        const computado = comp(conta);
        const ok = Math.abs(Math.abs(computado) - Math.abs(declarado)) < Math.max(Math.abs(declarado) * 0.01, 1000);
        return { conta, declarado, computado, ok };
      });

    res.json({ bp, dre, indicadores, periodos, reconciliacao, arvoreOriginalBP, arvoreOriginalDRE, naoMapeados });
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
  const validacao = validateFinancialData(dados.bp, dados.dre, dados.periodos);

  // Also run Benford's Law
  const allValues: number[] = [];
  for (const bp of dados.bp) {
    allValues.push(...Object.values(bp.valores).filter(v => v !== 0));
  }
  for (const dre of dados.dre) {
    allValues.push(...Object.values(dre.valores).filter(v => v !== 0));
  }
  const benford = benfordAnalysis(allValues);

  res.json({ ...validacao, benford });
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

  // Build per-document stats
  const documents = analysis.documents.map((doc) => {
    const dadosExtraidos = doc.dadosExtraidos as any;
    const linhas: Array<{ conta: string; valores: Record<string, number> }> = dadosExtraidos?.linhas || [];
    const periodos: string[] = dadosExtraidos?.periodos || [];

    // Detect how many accounts were classified vs unmatched
    const totalLinhas = linhas.length;
    const contasNaoClassificadas = dados?.unmatchedAccounts?.filter((u) => {
      // Check if this unmatched account came from this document's linhas
      return linhas.some((l) => l.conta === u.conta);
    }).length ?? 0;
    const contasMapeadas = totalLinhas - contasNaoClassificadas;

    // For BP documents, check if AT === PT (balance equation)
    let balanceia: boolean | null = null;
    let totalAtivo: number | null = null;
    let totalPassivo: number | null = null;
    const tipoBP = doc.tipo.toLowerCase().includes("balan") || doc.tipo.toLowerCase().includes("balancete");

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

  // Overall summary
  const allPeriodos = dados?.periodos || [];
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

    const doc = await prisma.document.create({
      data: {
        analysisId: analysis.id,
        companyId: analysis.companyId,
        nome: req.file.originalname,
        tipo: detectDocType(req.file.originalname, req.file.mimetype),
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
