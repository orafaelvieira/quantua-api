import { Router, Response } from "express";
import crypto from "crypto";
import multer from "multer";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { requireRole } from "../middleware/permissions";
import { inviteLimiter } from "../middleware/rate-limit";
import { renderLetter, renderProposalHtml, type SignatureRenderInput } from "../services/letter-templates";
import { sendInviteEmail, sendEngagementSignedEmail } from "../services/email";
import { renderHtmlToPdf } from "../services/pdf-renderer";
import { uploadProposalPdf, getProposalSignedUrl } from "../services/proposal-storage";
import {
  uploadEngagementDocument,
  deleteEngagementDocument,
  getEngagementDocumentSignedUrl,
  type EngagementDocumentEntry,
} from "../services/engagement-documents";
import { env } from "../config/env";

const router = Router();
router.use(requireAuth);

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

function fixFilename(raw: string): string {
  try {
    const fixed = Buffer.from(raw, "latin1").toString("utf8");
    if (!fixed.includes("�") || raw.includes("�")) return fixed;
  } catch {
    /* fallthrough */
  }
  return raw;
}

function maskCpf(cpf: string | null | undefined): string | null {
  if (!cpf) return null;
  const digits = cpf.replace(/\D/g, "");
  if (digits.length < 4) return "•••";
  return `•••.•••.${digits.slice(-6, -3)}-${digits.slice(-2)}`;
}

function parseContractUrls(raw: unknown): EngagementDocumentEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (it): it is EngagementDocumentEntry =>
      it && typeof it === "object" && typeof (it as { id?: unknown }).id === "string",
  );
}

const engagementCreateSchema = z.object({
  companyName: z.string().min(2),
  requestedBy: z.string().min(2),
  requestedByType: z.enum(["lender", "investor", "advisor", "other"]).default("lender"),
  scope: z.string().default(""),
  state: z.enum(["lead", "proposal_sent", "won", "kicked_off", "completed", "lost"]).default("lead"),
  deadline: z.string().optional(),
  feeAmount: z.number().optional(),
  feeCurrency: z.string().default("BRL"),
  rtId: z.string().uuid().optional(),
  notes: z.string().optional(),
  /**
   * Promoção via dialog de triagem do Inbox. Quando preenchido, a criação
   * roda em transação: cria Engagement + atualiza Lead.status="converted".
   * Bloqueia se o Lead já está convertido (race condition em abas paralelas).
   */
  leadId: z.string().uuid().optional(),
});

const engagementUpdateSchema = engagementCreateSchema.partial();

const inviteClientSchema = z.object({
  email: z.string().email(),
  contactName: z.string().optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

const signLetterSchema = z.object({
  acceptedContentHash: z.string().min(8),
  signerCpf: z.string().optional(),
});

const VALID_TRANSITIONS: Record<string, string[]> = {
  lead: ["proposal_sent", "lost"],
  proposal_sent: ["won", "lost"],
  won: ["kicked_off", "lost"],
  kicked_off: ["completed"],
  completed: [],
  lost: [],
};

function hashInvitationToken(rawToken: string): string {
  return crypto
    .createHash("sha256")
    .update(rawToken + env.invitationSecret)
    .digest("hex");
}

router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const items = await prisma.engagement.findMany({
    where: { userId: { in: req.scopeUserIds! } },
    orderBy: { createdAt: "desc" },
    include: { rt: { select: { id: true, name: true } } },
  });
  const out = items.map((e) => ({
    ...e,
    rtName: e.rt?.name ?? null,
    deadline: e.deadline?.toISOString(),
    signedAt: e.signedAt?.toISOString(),
    letterAcceptedAt: e.letterAcceptedAt?.toISOString() ?? null,
  }));
  res.json(out);
});

router.get("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const eng = await prisma.engagement.findFirst({
    where: { id, userId: { in: req.scopeUserIds! } },
    include: {
      rt: { select: { id: true, name: true } },
      invitations: { orderBy: { createdAt: "desc" }, take: 10 },
      signatures: { orderBy: { signedAt: "desc" } },
    },
  });
  if (!eng) { res.status(404).json({ error: "Engagement não encontrado" }); return; }
  res.json({
    ...eng,
    rtName: eng.rt?.name ?? null,
    deadline: eng.deadline?.toISOString() ?? null,
    signedAt: eng.signedAt?.toISOString() ?? null,
    letterAcceptedAt: eng.letterAcceptedAt?.toISOString() ?? null,
    proposalGeneratedAt: eng.proposalGeneratedAt?.toISOString() ?? null,
    invitations: eng.invitations.map((inv) => ({
      id: inv.id,
      email: inv.email,
      status: inv.status,
      expiresAt: inv.expiresAt.toISOString(),
      usedAt: inv.usedAt?.toISOString() ?? null,
      lastSentAt: inv.lastSentAt.toISOString(),
      resendCount: inv.resendCount,
      createdAt: inv.createdAt.toISOString(),
    })),
    signatures: eng.signatures.map((sig) => ({
      id: sig.id,
      signerType: sig.signerType,
      signerName: sig.signerName,
      signerEmail: sig.signerEmail,
      signerCpfMasked: maskCpf(sig.signerCpf),
      contentHash: sig.contentHash,
      letterVersion: sig.letterVersion,
      signedAt: sig.signedAt.toISOString(),
      ipAddress: sig.ipAddress,
      userAgent: sig.userAgent,
    })),
    contractUrls: parseContractUrls(eng.contractUrls),
  });
});

router.post("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = engagementCreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const data = parsed.data;

  // Caminho com leadId: promoção via dialog de triagem do Inbox. Transação
  // garante atomicidade entre criação do Engagement e mudança de Lead.status.
  if (data.leadId) {
    try {
      const created = await prisma.$transaction(async (tx) => {
        const lead = await tx.lead.findUnique({ where: { id: data.leadId! } });
        if (!lead) throw new Error("LEAD_NOT_FOUND");
        if (lead.status === "converted") throw new Error("LEAD_ALREADY_CONVERTED");
        const eng = await tx.engagement.create({
          data: {
            userId: req.userId!,
            companyName: data.companyName,
            requestedBy: data.requestedBy,
            requestedByType: data.requestedByType,
            scope: data.scope,
            state: data.state,
            deadline: data.deadline ? new Date(data.deadline) : null,
            feeAmount: data.feeAmount,
            feeCurrency: data.feeCurrency,
            rtId: data.rtId,
            notes: data.notes,
          },
          include: { rt: { select: { id: true, name: true } } },
        });
        await tx.lead.update({
          where: { id: data.leadId! },
          data: { status: "converted" },
        });
        return eng;
      });
      res.status(201).json({
        ...created,
        rtName: created.rt?.name ?? null,
        deadline: created.deadline?.toISOString(),
        signedAt: created.signedAt?.toISOString(),
        promotedFromLeadId: data.leadId,
      });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "LEAD_NOT_FOUND") {
        res.status(404).json({ error: "Lead não encontrado" });
        return;
      }
      if (message === "LEAD_ALREADY_CONVERTED") {
        res.status(409).json({ error: "Este lead já foi convertido em engagement" });
        return;
      }
      throw err;
    }
  }

  // Caminho padrão: criação direta sem promover lead.
  const created = await prisma.engagement.create({
    data: {
      userId: req.userId!,
      companyName: data.companyName,
      requestedBy: data.requestedBy,
      requestedByType: data.requestedByType,
      scope: data.scope,
      state: data.state,
      deadline: data.deadline ? new Date(data.deadline) : null,
      feeAmount: data.feeAmount,
      feeCurrency: data.feeCurrency,
      rtId: data.rtId,
      notes: data.notes,
    },
    include: { rt: { select: { id: true, name: true } } },
  });
  res.status(201).json({
    ...created,
    rtName: created.rt?.name ?? null,
    deadline: created.deadline?.toISOString(),
    signedAt: created.signedAt?.toISOString(),
  });
});

router.put("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const eng = await prisma.engagement.findFirst({ where: { id, userId: { in: req.scopeUserIds! } } });
  if (!eng) { res.status(404).json({ error: "Engagement não encontrado" }); return; }
  const parsed = engagementUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const updated = await prisma.engagement.update({
    where: { id },
    data: {
      ...parsed.data,
      deadline: parsed.data.deadline ? new Date(parsed.data.deadline) : undefined,
    },
  });
  res.json(updated);
});

router.post("/:id/transition", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
  const eng = await prisma.engagement.findFirst({ where: { id, userId: { in: req.scopeUserIds! } } });
  if (!eng) { res.status(404).json({ error: "Engagement não encontrado" }); return; }
  const toState = (req.body?.toState as string) || "";
  const allowed = VALID_TRANSITIONS[eng.state] ?? [];
  if (!allowed.includes(toState)) {
    res.status(409).json({ error: `Transição inválida ${eng.state} → ${toState}` });
    return;
  }

  // Se for 'won' e não houver IBR vinculado, cria automaticamente.
  let analysisId = eng.analysisId;
  if (toState === "won" && !analysisId) {
    const existingCompany = await prisma.company.findFirst({
      where: { userId: { in: req.scopeUserIds! }, razaoSocial: eng.companyName },
    });
    const company =
      existingCompany ??
      (await prisma.company.create({
        data: {
          userId: req.userId!,
          razaoSocial: eng.companyName,
          status: "ativo",
        },
      }));
    const created = await prisma.analysis.create({
      data: {
        companyId: company.id,
        userId: req.userId!,
        nome: `IBR — ${eng.companyName}`,
        kind: "ibr",
        status: "Rascunho",
      },
    });
    analysisId = created.id;
  }

  const updated = await prisma.engagement.update({
    where: { id },
    data: {
      state: toState,
      ...(analysisId !== eng.analysisId ? { analysisId } : {}),
    },
    include: { rt: { select: { name: true } } },
  });
  res.json({
    ...updated,
    rtName: updated.rt?.name ?? null,
    deadline: updated.deadline?.toISOString(),
    signedAt: updated.signedAt?.toISOString(),
  });
});

/**
 * Renderiza a letter atual do engagement com hash de conteúdo.
 * Acessível por staff (dono do engagement) e por client (via Company.userId).
 */
router.get("/:id/letter", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }

  // Tenta como staff primeiro
  let eng = await prisma.engagement.findFirst({
    where: { id, userId: { in: req.scopeUserIds! } },
    include: { rt: { select: { name: true, professionalRegistration: true } } },
  });

  // Se não encontrou, tenta como cliente (via company.userId → analysis → engagement)
  if (!eng) {
    const company = await prisma.company.findFirst({
      where: { userId: req.userId },
      include: { analyses: { where: { kind: "ibr" }, include: { engagement: true } } },
    });
    const candidate = company?.analyses.find((a) => a.engagement?.id === id);
    if (candidate?.engagement) {
      eng = await prisma.engagement.findUnique({
        where: { id },
        include: { rt: { select: { name: true, professionalRegistration: true } } },
      });
    }
  }

  if (!eng) { res.status(404).json({ error: "Engagement não encontrado" }); return; }

  const letter = renderLetter({
    engagementId: eng.id,
    companyName: eng.companyName,
    requestedBy: eng.requestedBy,
    requestedByType: eng.requestedByType,
    scope: eng.scope,
    feeAmount: eng.feeAmount,
    feeCurrency: eng.feeCurrency,
    deadline: eng.deadline,
    rtName: eng.rt?.name ?? null,
    rtRegistration: eng.rt?.professionalRegistration ?? null,
  });

  res.json({
    engagement: {
      id: eng.id,
      companyName: eng.companyName,
      state: eng.state,
      letterAcceptedAt: eng.letterAcceptedAt?.toISOString() ?? null,
    },
    letter: {
      version: letter.version,
      contentHash: letter.contentHash,
      sections: letter.sections,
      meta: letter.meta,
      text: letter.text,
    },
  });
});

/**
 * Staff convida cliente. Idempotente por (engagementId, status="pending"):
 * se já existe, gera novo tokenHash (rotation) e re-envia.
 */
router.post(
  "/:id/invite-client",
  requireRole("partner", "operator"),
  inviteLimiter,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const id = req.params.id;
    if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
    const parsed = inviteClientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const { email, contactName, expiresInDays } = parsed.data;

    const eng = await prisma.engagement.findFirst({
      where: { id, userId: { in: req.scopeUserIds! } },
      include: { rt: { select: { name: true } } },
    });
    if (!eng) { res.status(404).json({ error: "Engagement não encontrado" }); return; }
    if (eng.state !== "won" && eng.state !== "kicked_off") {
      res.status(409).json({ error: "Engagement deve estar em 'won' ou 'kicked_off' para convidar cliente" });
      return;
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashInvitationToken(rawToken);
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    const existing = await prisma.clientInvitation.findFirst({
      where: { engagementId: id, status: "pending", email },
    });

    let invitation;
    if (existing) {
      invitation = await prisma.clientInvitation.update({
        where: { id: existing.id },
        data: {
          tokenHash,
          expiresAt,
          lastSentAt: new Date(),
          resendCount: { increment: 1 },
        },
      });
    } else {
      invitation = await prisma.clientInvitation.create({
        data: {
          engagementId: id,
          email,
          tokenHash,
          expiresAt,
          createdById: req.userId!,
        },
      });
    }

    const magicLink = `${env.frontendUrl}/convite/${rawToken}`;
    const emailResult = await sendInviteEmail({
      to: email,
      contactName,
      companyName: eng.companyName,
      rtName: eng.rt?.name ?? "Quantua",
      magicLink,
      expiresAt,
    });

    if (eng.analysisId) {
      await prisma.auditEvent.create({
        data: {
          analysisId: eng.analysisId,
          userId: req.userId!,
          userName: req.userId!,
          entity: "invitation",
          entityId: invitation.id,
          field: "sent",
          before: Prisma.JsonNull,
          after: { email, expiresAt: expiresAt.toISOString(), resendCount: invitation.resendCount },
          source: "manual",
        },
      });
    }

    res.status(201).json({
      invitationId: invitation.id,
      expiresAt: invitation.expiresAt.toISOString(),
      resendCount: invitation.resendCount,
      emailDelivered: emailResult.ok,
      emailError: emailResult.error,
    });
  }
);

/**
 * Cliente assina engagement letter (TOCTOU-safe via contentHash).
 * Cria EngagementSignature, atualiza letterAcceptedAt, dispara email para RT.
 */
router.post(
  "/:id/sign-letter",
  requireRole("client"),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const id = req.params.id;
    if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
    const parsed = signLetterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    // Cliente acessa engagement via Company.userId
    const company = await prisma.company.findFirst({
      where: { userId: req.userId! },
      include: {
        analyses: { where: { kind: "ibr" }, include: { engagement: { include: { rt: true } } } },
      },
    });
    const candidate = company?.analyses.find((a) => a.engagement?.id === id);
    const eng = candidate?.engagement;
    if (!eng) { res.status(404).json({ error: "Engagement não encontrado" }); return; }
    if (eng.letterAcceptedAt) {
      res.status(409).json({ error: "Carta já foi assinada", signedAt: eng.letterAcceptedAt.toISOString() });
      return;
    }

    const letter = renderLetter({
      engagementId: eng.id,
      companyName: eng.companyName,
      requestedBy: eng.requestedBy,
      requestedByType: eng.requestedByType,
      scope: eng.scope,
      feeAmount: eng.feeAmount,
      feeCurrency: eng.feeCurrency,
      deadline: eng.deadline,
      rtName: eng.rt?.name ?? null,
      rtRegistration: eng.rt?.professionalRegistration ?? null,
    });

    if (letter.contentHash !== parsed.data.acceptedContentHash) {
      res.status(409).json({
        error: "A carta foi atualizada. Recarregue para revisar a versão atual.",
        currentContentHash: letter.contentHash,
      });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId! } });
    if (!user) { res.status(401).json({ error: "Sessão inválida" }); return; }

    const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
    const userAgent = req.headers["user-agent"]?.slice(0, 500) || "unknown";

    await prisma.$transaction(async (tx) => {
      await tx.engagementSignature.create({
        data: {
          engagementId: eng.id,
          signerType: "client",
          signerUserId: user.id,
          signerName: user.name,
          signerEmail: user.email,
          signerCpf: parsed.data.signerCpf,
          contentHash: letter.contentHash,
          letterVersion: letter.version,
          ipAddress,
          userAgent,
        },
      });
      await tx.engagement.update({
        where: { id: eng.id },
        data: {
          letterAcceptedAt: new Date(),
          letterContentHash: letter.contentHash,
          letterVersion: letter.version,
        },
      });
      if (eng.analysisId) {
        await tx.auditEvent.create({
          data: {
            analysisId: eng.analysisId,
            userId: user.id,
            userName: user.name,
            entity: "engagement",
            entityId: eng.id,
            field: "letter_accepted",
            before: Prisma.JsonNull,
            after: { contentHash: letter.contentHash, version: letter.version },
            source: "client",
          },
        });
      }
    });

    if (eng.rt?.email) {
      await sendEngagementSignedEmail({
        to: eng.rt.email,
        rtName: eng.rt.name,
        clientName: user.name,
        companyName: eng.companyName,
        signedAt: new Date(),
        engagementUrl: `${env.frontendUrl}/engagements/${eng.id}`,
      });
    }

    res.status(201).json({
      signedAt: new Date().toISOString(),
      contentHash: letter.contentHash,
      letterVersion: letter.version,
    });
  }
);

/**
 * Carrega Engagement + RT + signatures e renderiza o HTML da proposta.
 * Compartilhado entre preview (GET /proposal-html) e geração PDF (POST).
 */
async function buildProposalHtmlForEngagement(
  engagementId: string,
  scopeUserIds: string[],
): Promise<{ engagement: NonNullable<Awaited<ReturnType<typeof prisma.engagement.findFirst>>>; html: string; letter: ReturnType<typeof renderLetter> } | null> {
  const eng = await prisma.engagement.findFirst({
    where: { id: engagementId, userId: { in: scopeUserIds } },
    include: {
      rt: { select: { name: true, professionalRegistration: true } },
      signatures: { orderBy: { signedAt: "asc" } },
    },
  });
  if (!eng) return null;

  const letter = renderLetter({
    engagementId: eng.id,
    companyName: eng.companyName,
    requestedBy: eng.requestedBy,
    requestedByType: eng.requestedByType,
    scope: eng.scope,
    feeAmount: eng.feeAmount,
    feeCurrency: eng.feeCurrency,
    deadline: eng.deadline,
    rtName: eng.rt?.name ?? null,
    rtRegistration: eng.rt?.professionalRegistration ?? null,
  });

  const signatures: SignatureRenderInput[] = eng.signatures.map((s) => ({
    signerType: s.signerType,
    signerName: s.signerName,
    signerEmail: s.signerEmail,
    signerCpf: s.signerCpf,
    signedAt: s.signedAt,
    contentHash: s.contentHash,
    letterVersion: s.letterVersion,
    ipAddress: s.ipAddress,
  }));

  const html = renderProposalHtml({ letter, signatures });
  return { engagement: eng, html, letter };
}

/**
 * Gera PDF real da proposta comercial.
 *
 * Pipeline: renderLetter → renderProposalHtml → renderHtmlToPdf (Puppeteer)
 * → upload Spaces → salva storagePath + hash + generatedAt → retorna
 * signed URL (24h). `proposalUrl` legado preservado pra retrocompat com
 * UI que ainda usa o browser-print fallback.
 *
 * Quando a carta já foi assinada (`letterAcceptedAt`), o PDF inclui seção
 * "Assinatura digital". Se o hash da carta mudou após assinatura
 * (`letterContentHash` diverge), `renderProposalHtml` marca cada
 * assinatura como "ASSINATURA INVÁLIDA" no PDF.
 */
router.post(
  "/:id/generate-proposal",
  requireRole("partner", "operator"),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      res.status(404).json({ error: "ID inválido" });
      return;
    }

    const built = await buildProposalHtmlForEngagement(id, req.scopeUserIds!);
    if (!built) {
      res.status(404).json({ error: "Engagement não encontrado" });
      return;
    }
    const { engagement: eng, html, letter } = built;

    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await renderHtmlToPdf(html);
    } catch (err) {
      console.error("[generate-proposal] PDF render falhou:", err);
      res.status(500).json({
        error: "Falha ao renderizar PDF da proposta",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let storagePath: string;
    let pdfHash: string;
    try {
      const uploaded = await uploadProposalPdf({
        engagementId: eng.id,
        version: letter.version,
        pdfBuffer,
      });
      storagePath = uploaded.storagePath;
      pdfHash = uploaded.pdfHash;
    } catch (err) {
      console.error("[generate-proposal] upload Spaces falhou:", err);
      res.status(500).json({
        error: "Falha ao subir PDF pro storage",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const proposalUrl = await getProposalSignedUrl(storagePath);
    const generatedAt = new Date();

    await prisma.engagement.update({
      where: { id: eng.id },
      data: {
        proposalPdfStoragePath: storagePath,
        proposalPdfHash: pdfHash,
        proposalGeneratedAt: generatedAt,
        // proposalUrl mantido pra UI legacy que ainda renderiza browser-print
        // (signed URL é temporária, não dá pra persistir).
        proposalUrl: `${env.frontendUrl || ""}/api/engagements/${eng.id}/proposal-html`,
      },
    });

    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { name: true },
    });
    if (eng.analysisId) {
      await prisma.auditEvent.create({
        data: {
          analysisId: eng.analysisId,
          userId: req.userId!,
          userName: user?.name ?? "Usuário",
          entity: "engagement",
          entityId: eng.id,
          field: "proposal_generated",
          after: {
            storagePath,
            pdfHash,
            version: letter.version,
            contentHash: letter.contentHash,
            generatedAt: generatedAt.toISOString(),
          } as object,
          source: "manual",
        },
      });
    }

    res.json({
      proposalUrl,
      proposalPdfStoragePath: storagePath,
      proposalPdfHash: pdfHash,
      proposalGeneratedAt: generatedAt.toISOString(),
      version: letter.version,
      contentHash: letter.contentHash,
    });
  },
);

/**
 * Preview HTML da proposta — RT abre em nova aba pra revisar layout
 * antes de gerar o PDF oficial via POST /:id/generate-proposal.
 *
 * Continua acessível pra retrocompat com UI legacy que faz Cmd+P → PDF.
 */
router.get("/:id/proposal-html", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") {
    res.status(404).send("ID inválido");
    return;
  }

  const built = await buildProposalHtmlForEngagement(id, req.scopeUserIds!);
  if (!built) {
    res.status(404).send("Engagement não encontrado");
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(built.html);
});

/**
 * Timeline unificada do engagement — agrega eventos de Engagement
 * (criação, transições, proposta, carta), ClientInvitation, EngagementSignature
 * e auto-criação do IBR. Ordenado desc por timestamp.
 */
interface TimelineEvent {
  id: string;
  type:
    | "engagement_created"
    | "ibr_created"
    | "proposal_generated"
    | "invitation_sent"
    | "invitation_resent"
    | "letter_accepted"
    | "signature_added"
    | "state_changed"
    | "document_uploaded";
  timestamp: string;
  actor: string;
  description: string;
  metadata?: Record<string, unknown>;
}

router.get("/:id/timeline", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }

  const eng = await prisma.engagement.findFirst({
    where: { id, userId: { in: req.scopeUserIds! } },
    include: {
      invitations: { orderBy: { createdAt: "desc" } },
      signatures: { orderBy: { signedAt: "desc" } },
      rt: { select: { name: true } },
    },
  });
  if (!eng) { res.status(404).json({ error: "Engagement não encontrado" }); return; }

  const owner = await prisma.user.findUnique({
    where: { id: eng.userId },
    select: { name: true },
  });
  const ownerName = owner?.name ?? "Usuário";

  const events: TimelineEvent[] = [];

  events.push({
    id: `created-${eng.id}`,
    type: "engagement_created",
    timestamp: eng.createdAt.toISOString(),
    actor: ownerName,
    description: `Engagement criado para ${eng.companyName}`,
    metadata: { requestedBy: eng.requestedBy, requestedByType: eng.requestedByType },
  });

  if (eng.proposalGeneratedAt) {
    events.push({
      id: `proposal-${eng.proposalPdfHash ?? eng.id}`,
      type: "proposal_generated",
      timestamp: eng.proposalGeneratedAt.toISOString(),
      actor: ownerName,
      description: `Proposta ${eng.letterVersion ?? "v1"} gerada`,
      metadata: {
        version: eng.letterVersion,
        pdfHash: eng.proposalPdfHash,
        contentHash: eng.letterContentHash,
      },
    });
  }

  if (eng.letterAcceptedAt) {
    events.push({
      id: `letter-accepted-${eng.letterContentHash ?? eng.id}`,
      type: "letter_accepted",
      timestamp: eng.letterAcceptedAt.toISOString(),
      actor: "Cliente",
      description: "Carta de engajamento aceita",
      metadata: { contentHash: eng.letterContentHash, version: eng.letterVersion },
    });
  }

  for (const inv of eng.invitations) {
    events.push({
      id: `inv-${inv.id}`,
      type: inv.resendCount > 0 ? "invitation_resent" : "invitation_sent",
      timestamp: inv.lastSentAt.toISOString(),
      actor: ownerName,
      description:
        inv.resendCount > 0
          ? `Convite reenviado para ${inv.email} (${inv.resendCount}× reenvios)`
          : `Convite enviado para ${inv.email}`,
      metadata: {
        invitationId: inv.id,
        status: inv.status,
        expiresAt: inv.expiresAt.toISOString(),
        resendCount: inv.resendCount,
      },
    });
  }

  for (const sig of eng.signatures) {
    events.push({
      id: `sig-${sig.id}`,
      type: "signature_added",
      timestamp: sig.signedAt.toISOString(),
      actor: sig.signerName,
      description:
        sig.signerType === "client"
          ? `Cliente assinou (${sig.signerEmail})`
          : `RT assinou (${sig.signerName})`,
      metadata: {
        signerType: sig.signerType,
        contentHash: sig.contentHash,
        letterVersion: sig.letterVersion,
        ipAddress: sig.ipAddress,
      },
    });
  }

  if (eng.analysisId) {
    const ibr = await prisma.analysis.findUnique({
      where: { id: eng.analysisId },
      select: { id: true, createdAt: true, nome: true },
    });
    if (ibr) {
      events.push({
        id: `ibr-${ibr.id}`,
        type: "ibr_created",
        timestamp: ibr.createdAt.toISOString(),
        actor: ownerName,
        description: `IBR criado: ${ibr.nome}`,
        metadata: { analysisId: ibr.id },
      });
    }
  }

  // AuditEvents extras (state_changed, document_uploaded etc.) registrados pelos endpoints novos
  if (eng.analysisId) {
    const audits = await prisma.auditEvent.findMany({
      where: {
        analysisId: eng.analysisId,
        entity: "engagement",
        entityId: eng.id,
        field: { in: ["state", "document_uploaded", "document_removed"] },
      },
      orderBy: { timestamp: "desc" },
    });
    for (const a of audits) {
      const type: TimelineEvent["type"] =
        a.field === "state"
          ? "state_changed"
          : "document_uploaded";
      const description =
        a.field === "state"
          ? `Estado mudou para ${(a.after as { to?: string } | null)?.to ?? "?"}`
          : a.field === "document_removed"
            ? `Documento removido: ${(a.before as { label?: string } | null)?.label ?? ""}`
            : `Documento anexado: ${(a.after as { label?: string } | null)?.label ?? ""}`;
      events.push({
        id: `audit-${a.id}`,
        type,
        timestamp: a.timestamp.toISOString(),
        actor: a.userName,
        description,
        metadata: { before: a.before, after: a.after },
      });
    }
  }

  events.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  res.json(events);
});

/**
 * Upload de documento contratual (NDA, contrato assinado, anexos).
 * Persiste em DigitalOcean Spaces e atualiza Engagement.contractUrls (JSON).
 */
router.post(
  "/:id/documents",
  requireRole("partner", "operator"),
  documentUpload.single("file"),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const id = req.params.id;
    if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }
    if (!req.file) { res.status(400).json({ error: "Nenhum arquivo enviado" }); return; }

    const eng = await prisma.engagement.findFirst({ where: { id, userId: { in: req.scopeUserIds! } } });
    if (!eng) { res.status(404).json({ error: "Engagement não encontrado" }); return; }

    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { name: true },
    });
    const filename = fixFilename(req.file.originalname);
    const customLabel = typeof req.body.label === "string" && req.body.label.trim() ? req.body.label.trim() : filename;

    const { doc } = await uploadEngagementDocument({
      engagementId: eng.id,
      filename,
      mimeType: req.file.mimetype || "application/octet-stream",
      buffer: req.file.buffer,
      uploadedBy: user?.name ?? "Usuário",
    });
    doc.label = customLabel;

    const current = parseContractUrls(eng.contractUrls);
    const next = [...current, doc];

    await prisma.engagement.update({
      where: { id: eng.id },
      data: { contractUrls: next as unknown as Prisma.InputJsonValue },
    });

    if (eng.analysisId) {
      await prisma.auditEvent.create({
        data: {
          analysisId: eng.analysisId,
          userId: req.userId!,
          userName: user?.name ?? "Usuário",
          entity: "engagement",
          entityId: eng.id,
          field: "document_uploaded",
          before: Prisma.JsonNull,
          after: { label: doc.label, id: doc.id, hash: doc.hash, size: doc.size },
          source: "manual",
        },
      });
    }

    const signedUrl = await getEngagementDocumentSignedUrl(doc.storagePath, doc.mimeType).catch(() => null);
    res.status(201).json({ ...doc, url: signedUrl });
  },
);

/**
 * Remove documento contratual do storage + da lista contractUrls.
 */
router.delete(
  "/:id/documents/:docId",
  requireRole("partner", "operator"),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const id = req.params.id;
    const docId = req.params.docId;
    if (!id || typeof id !== "string" || !docId || typeof docId !== "string") {
      res.status(404).json({ error: "Parâmetros inválidos" });
      return;
    }

    const eng = await prisma.engagement.findFirst({ where: { id, userId: { in: req.scopeUserIds! } } });
    if (!eng) { res.status(404).json({ error: "Engagement não encontrado" }); return; }

    const current = parseContractUrls(eng.contractUrls);
    const removed = current.find((d) => d.id === docId);
    if (!removed) { res.status(404).json({ error: "Documento não encontrado" }); return; }

    try {
      await deleteEngagementDocument(removed.storagePath);
    } catch (err) {
      console.warn("[delete-document] falha ao remover do Spaces:", err);
    }

    const next = current.filter((d) => d.id !== docId);
    await prisma.engagement.update({
      where: { id: eng.id },
      data: { contractUrls: next as unknown as Prisma.InputJsonValue },
    });

    if (eng.analysisId) {
      const user = await prisma.user.findUnique({
        where: { id: req.userId! },
        select: { name: true },
      });
      await prisma.auditEvent.create({
        data: {
          analysisId: eng.analysisId,
          userId: req.userId!,
          userName: user?.name ?? "Usuário",
          entity: "engagement",
          entityId: eng.id,
          field: "document_removed",
          before: { label: removed.label, id: removed.id, hash: removed.hash },
          after: Prisma.JsonNull,
          source: "manual",
        },
      });
    }

    res.status(204).end();
  },
);

/**
 * Snapshot do IBR vinculado — KPIs principais, status e completude estimada.
 * Retorna null se o engagement ainda não tem analysisId (pré-won).
 */
router.get("/:id/ibr-snapshot", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!id || typeof id !== "string") { res.status(404).json({ error: "ID inválido" }); return; }

  const eng = await prisma.engagement.findFirst({
    where: { id, userId: { in: req.scopeUserIds! } },
    select: { analysisId: true, deadline: true },
  });
  if (!eng) { res.status(404).json({ error: "Engagement não encontrado" }); return; }
  if (!eng.analysisId) { res.json(null); return; }

  const analysis = await prisma.analysis.findUnique({
    where: { id: eng.analysisId },
    include: {
      company: { select: { razaoSocial: true, setor: true } },
    },
  });
  if (!analysis) { res.json(null); return; }

  const resultado = (analysis.resultado as Record<string, unknown> | null) ?? {};
  const kpisRaw = (resultado.kpis as Record<string, { valor?: number }> | undefined) ?? {};

  const kpis = {
    receita: kpisRaw.receita?.valor ?? null,
    ebitda: kpisRaw.ebitda?.valor ?? null,
    margemEbitda: kpisRaw.margemEbitda?.valor ?? null,
  };

  // Completude estimada: presença de dados nas seções principais do resultado JSON
  // + presença de documentos (proxy de Data room) + Covenant table.
  const sections = [
    "kpis",
    "dreData",
    "semaforo",
    "swot",
    "recomendacoes",
    "destaques",
    "stcf",
    "scenarios",
    "options",
  ];
  const filledSections = sections.filter((k) => {
    const v = resultado[k];
    if (Array.isArray(v)) return v.length > 0;
    if (v && typeof v === "object") return Object.keys(v).length > 0;
    return false;
  }).length;
  const covenantsCount = await prisma.covenant
    .count({ where: { analysisId: analysis.id } })
    .catch(() => 0);
  const completedTabs = Math.min(10, filledSections + (covenantsCount > 0 ? 1 : 0));
  const totalTabs = 10;

  const daysUntilDeadline = eng.deadline
    ? Math.ceil((eng.deadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null;

  res.json({
    analysisId: analysis.id,
    nome: analysis.nome,
    status: analysis.status,
    reviewState: analysis.reviewState ?? null,
    companyName: analysis.company?.razaoSocial ?? null,
    sector: analysis.company?.setor ?? null,
    kpis,
    completedTabs,
    totalTabs,
    daysUntilDeadline,
    deadline: eng.deadline?.toISOString() ?? null,
  });
});

export default router;
