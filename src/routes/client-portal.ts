import { Router, Response } from "express";
import multer from "multer";
import crypto from "crypto";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { requireRole, requireEngagementSigned } from "../middleware/permissions";
import { uploadFile } from "../services/storage";
import { getIntakeTemplate } from "../services/intake-templates";

const router = Router();
router.use(requireAuth);
router.use(requireRole("client"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

/**
 * Carrega a análise que pertence ao cliente logado. Para clientes,
 * a relação é via Company.userId == client.id.
 */
async function loadClientAnalysis(userId: string) {
  const company = await prisma.company.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  if (!company) return null;
  return prisma.analysis.findFirst({
    where: { companyId: company.id, kind: "ibr" },
    orderBy: { createdAt: "desc" },
    include: {
      company: true,
      documents: true,
      engagement: { include: { rt: { select: { id: true, name: true, email: true } } } },
    },
  });
}

function phaseFromState(reviewState: string, status: string, hasDocuments: boolean) {
  if (reviewState === "delivered") return "delivered";
  if (reviewState === "signed") return "delivery";
  if (reviewState === "approved") return "review";
  if (reviewState === "in_review" || reviewState === "revision_requested") return "review";
  if (status === "Concluída") return "analysis";
  if (hasDocuments) return "analysis";
  return "collection";
}

function dayOfEngagement(letterAcceptedAt: Date | null | undefined): number {
  if (!letterAcceptedAt) return 1;
  const days = Math.floor((Date.now() - letterAcceptedAt.getTime()) / (24 * 60 * 60 * 1000));
  return Math.max(1, Math.min(10, days + 1));
}

router.get("/status", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadClientAnalysis(req.userId!);
  if (!analysis) { res.status(404).json({ error: "Sem IBR ativo" }); return; }

  const checklist = (analysis.documentChecklist as { id: string; status: string }[] | null) ?? [];
  const pendingDocs = checklist.filter((c) => c.status === "requested" || c.status === "pending").length;
  const totalDocs = checklist.length;
  const questionnaire = (analysis.questionnaire as { questions?: unknown[]; answers?: Record<string, unknown> } | null) ?? null;
  const totalQuestions = questionnaire?.questions?.length ?? 0;
  const answered = questionnaire?.answers ? Object.keys(questionnaire.answers).length : 0;
  const eng = analysis.engagement;

  res.json({
    analysisId: analysis.id,
    engagementId: eng?.id ?? null,
    companyName: analysis.company?.razaoSocial ?? "Empresa",
    phase: phaseFromState(analysis.reviewState, analysis.status, analysis.documents.length > 0),
    day: eng ? dayOfEngagement(eng.letterAcceptedAt) : 1,
    totalDays: 10,
    expectedDeliveryDate: eng?.deadline?.toISOString(),
    rtName: eng?.rt?.name,
    rtEmail: eng?.rt?.email,
    pendingDocsCount: pendingDocs,
    totalDocsCount: totalDocs,
    pendingQuestionnaireCount: Math.max(0, totalQuestions - answered),
    totalQuestionnaireCount: totalQuestions,
    reportReady: analysis.reviewState === "signed" || analysis.reviewState === "delivered",
    engagement: eng
      ? {
          id: eng.id,
          requestedBy: eng.requestedBy,
          requestedByType: eng.requestedByType,
          scope: eng.scope,
          feeAmount: eng.feeAmount,
          feeCurrency: eng.feeCurrency,
          letterAcceptedAt: eng.letterAcceptedAt?.toISOString() ?? null,
        }
      : null,
  });
});

router.get("/docs", requireEngagementSigned, async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadClientAnalysis(req.userId!);
  if (!analysis) { res.json({ items: [], sections: [] }); return; }
  const checklist = (analysis.documentChecklist as Array<{
    id: string; label: string; status: string; required?: boolean;
    section?: string;
    uploadedAt?: string; fileName?: string; rejectionReason?: string;
    hash?: string;
  }> | null) ?? [];

  const sectionsMap = new Map<string, typeof checklist>();
  for (const item of checklist) {
    const sec = item.section ?? "A. Documentos";
    if (!sectionsMap.has(sec)) sectionsMap.set(sec, []);
    sectionsMap.get(sec)!.push(item);
  }
  const sections = [...sectionsMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, items]) => ({ name, items }));

  res.json({
    items: checklist,
    sections,
    receivedCount: checklist.filter((c) => c.status === "uploaded" || c.status === "approved").length,
    totalCount: checklist.length,
  });
});

router.post(
  "/docs/upload",
  requireEngagementSigned,
  upload.single("file"),
  async (req: AuthRequest, res: Response): Promise<void> => {
    if (!req.file) { res.status(400).json({ error: "Arquivo ausente" }); return; }
    const docRequestId = req.body?.docRequestId as string | undefined;
    if (!docRequestId) { res.status(400).json({ error: "docRequestId obrigatório" }); return; }

    const analysis = await loadClientAnalysis(req.userId!);
    if (!analysis) { res.status(404).json({ error: "Sem IBR ativo" }); return; }

    const key = `client-uploads/${analysis.id}/${docRequestId}/${Date.now()}-${req.file.originalname}`;
    const url = await uploadFile(req.file.buffer as Buffer, key, req.file.mimetype);

    const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

    await prisma.document.create({
      data: {
        analysisId: analysis.id,
        companyId: analysis.companyId,
        nome: req.file.originalname,
        tipo: "Outro",
        status: "Pendente",
        storagePath: url,
        hash,
        tamanho: `${(req.file.size / 1024).toFixed(0)} KB`,
      },
    });

    const checklist = ((analysis.documentChecklist as Array<Record<string, unknown>> | null) ?? []).slice();
    const idx = checklist.findIndex((c) => c.id === docRequestId);
    if (idx !== -1) {
      checklist[idx] = {
        ...checklist[idx],
        status: "uploaded",
        uploadedAt: new Date().toISOString(),
        fileName: req.file.originalname,
        hash,
      };
    } else {
      checklist.push({
        id: docRequestId,
        label: req.file.originalname,
        status: "uploaded",
        uploadedAt: new Date().toISOString(),
        fileName: req.file.originalname,
        hash,
      });
    }
    await prisma.analysis.update({
      where: { id: analysis.id },
      data: { documentChecklist: checklist as object },
    });

    res.status(201).json({ ok: true, hash });
  }
);

router.get("/questionnaire", requireEngagementSigned, async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadClientAnalysis(req.userId!);
  if (!analysis) { res.json({ questions: [], answers: {} }); return; }
  const data = (analysis.questionnaire as { questions?: unknown[]; answers?: Record<string, unknown> } | null) ?? null;
  res.json({
    questions: data?.questions ?? [],
    answers: data?.answers ?? {},
  });
});

router.put("/questionnaire", requireEngagementSigned, async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadClientAnalysis(req.userId!);
  if (!analysis) { res.status(404).json({ error: "Sem IBR ativo" }); return; }
  const answers = (req.body?.answers ?? {}) as Record<string, unknown>;
  const existing = (analysis.questionnaire as { questions?: unknown[]; answers?: Record<string, unknown> } | null) ?? {};
  const updated = await prisma.analysis.update({
    where: { id: analysis.id },
    data: {
      questionnaire: {
        questions: existing.questions ?? [],
        answers,
      } as object,
    },
  });
  res.json(updated.questionnaire);
});

/**
 * Intake form sectorizado. Pega template via sectorId e merge com respostas
 * salvas em Analysis.questionnaire.answers (mesmo storage do questionnaire legado).
 */
router.get("/intake-form", requireEngagementSigned, async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadClientAnalysis(req.userId!);
  if (!analysis) { res.status(404).json({ error: "Sem IBR ativo" }); return; }
  const template = getIntakeTemplate(analysis.sectorId);
  const data = (analysis.questionnaire as { answers?: Record<string, unknown> } | null) ?? {};
  res.json({
    template,
    answers: data.answers ?? {},
    answeredCount: Object.keys(data.answers ?? {}).length,
    totalCount: template.questions.length,
  });
});

router.put("/intake-form", requireEngagementSigned, async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadClientAnalysis(req.userId!);
  if (!analysis) { res.status(404).json({ error: "Sem IBR ativo" }); return; }
  const incoming = (req.body?.answers ?? {}) as Record<string, unknown>;
  const template = getIntakeTemplate(analysis.sectorId);
  const validIds = new Set(template.questions.map((q) => q.id));

  // Sanitiza: rejeita chaves fora do template e merge com existentes
  const existing = (analysis.questionnaire as { answers?: Record<string, unknown> } | null)?.answers ?? {};
  const merged: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (validIds.has(k)) merged[k] = v;
  }

  await prisma.analysis.update({
    where: { id: analysis.id },
    data: {
      questionnaire: {
        questions: template.questions,
        answers: merged,
      } as object,
    },
  });

  res.json({
    saved: true,
    answeredCount: Object.keys(merged).length,
    totalCount: template.questions.length,
  });
});

router.get("/deliverable", requireEngagementSigned, async (req: AuthRequest, res: Response): Promise<void> => {
  const analysis = await loadClientAnalysis(req.userId!);
  if (!analysis) { res.json({ ready: false }); return; }

  const ready = analysis.reviewState === "signed" || analysis.reviewState === "delivered";
  if (!ready) { res.json({ ready: false, message: "IBR ainda em elaboração ou revisão." }); return; }

  const sig = analysis.signature as { partnerName?: string; professionalRegistration?: string; signedAt?: string } | null;

  // Conta documentos e eventos para o "data room auditável"
  const [docCount, auditEventsCount] = await Promise.all([
    prisma.document.count({ where: { analysisId: analysis.id } }),
    prisma.auditEvent.count({ where: { analysisId: analysis.id } }),
  ]);

  // Recomendação derivada do executiveSummary (se existir)
  const summary = analysis.executiveSummary as { recommendation?: string; recommendationVersion?: string } | null;
  const recommendation = summary?.recommendation
    ? {
        headline: summary.recommendation,
        accentTerm: undefined,
        version: summary.recommendationVersion ?? "v1.0",
      }
    : null;

  res.json({
    ready: true,
    reportUrl: `/api/analyses/${analysis.id}/pdf`,
    signedAt: sig?.signedAt,
    partnerName: sig?.partnerName,
    professionalRegistration: sig?.professionalRegistration,
    dataRoom: {
      docCount,
      auditEvents: auditEventsCount,
      accessUntil: null, // 24 meses a partir de signedAt — frontend pode calcular
    },
    recommendation,
    companions: [],
  });
});

export default router;
