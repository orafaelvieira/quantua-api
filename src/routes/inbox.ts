import { Router, Response } from "express";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

type InboxItemType = "lead" | "engagement" | "analysis" | "due_review";

interface InboxItem {
  id: string;
  type: InboxItemType;
  ref: string;
  requestedBy: string;
  targetCompany: string;
  sector?: string;
  debtVolume?: string;
  tier?: "Light" | "Full" | "Crisis";
  receivedAt: string;
  href: string;
  /** Pra due_review: dias até vencer (negativo = atrasado). */
  daysUntilDue?: number;
  /** Pra due_review: data programada da próxima revisão. */
  dueAt?: string;
}

function refForLead(id: string): string {
  return `LEAD-${id.slice(0, 8).toUpperCase()}`;
}
function refForEngagement(id: string, createdAt: Date): string {
  return `ENG-${createdAt.getFullYear()}-${id.slice(0, 6).toUpperCase()}`;
}
function refForAnalysis(id: string, createdAt: Date): string {
  return `IBR-${createdAt.getFullYear()}-${id.slice(0, 6).toUpperCase()}`;
}

function tierFromIbrType(ibrType: string | null | undefined): "Light" | "Full" | "Crisis" | undefined {
  if (ibrType === "light") return "Light";
  if (ibrType === "full") return "Full";
  if (ibrType === "crisis") return "Crisis";
  return undefined;
}

router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId!;

  // Filtros opcionais via query
  const typesParam = (req.query.types as string | undefined) ?? "";
  const includeTypes = typesParam
    ? new Set(typesParam.split(",").map((s) => s.trim()).filter(Boolean))
    : null;
  const q = ((req.query.q as string | undefined) ?? "").trim();
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  const dateFilter = (from || to)
    ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } }
    : {};

  const wantLeads = !includeTypes || includeTypes.has("lead");
  const wantEngagements = !includeTypes || includeTypes.has("engagement");
  const wantAnalyses = !includeTypes || includeTypes.has("analysis");
  const wantDueReviews = !includeTypes || includeTypes.has("due_review");

  // Janela de 14 dias pra trás (já vencidas) até 14 dias adiante (warning).
  const now = new Date();
  const in14Days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  const [leads, engagements, analyses, dueReviews] = await Promise.all([
    wantLeads
      ? prisma.lead.findMany({
          where: {
            status: { in: ["new", "contacted"] },
            ...dateFilter,
            ...(q ? { OR: [
              { targetCompany: { contains: q, mode: "insensitive" } },
              { contactName: { contains: q, mode: "insensitive" } },
              { contactEmail: { contains: q, mode: "insensitive" } },
            ] } : {}),
          },
          orderBy: { createdAt: "desc" },
          take: 50,
        })
      : Promise.resolve([]),
    wantEngagements
      ? prisma.engagement.findMany({
          where: {
            userId,
            state: "proposal_sent",
            ...dateFilter,
            ...(q ? { OR: [
              { companyName: { contains: q, mode: "insensitive" } },
              { requestedBy: { contains: q, mode: "insensitive" } },
            ] } : {}),
          },
          orderBy: { createdAt: "desc" },
          take: 50,
          include: {
            analysis: {
              select: { id: true, ibrType: true, company: { select: { setor: true } } },
            },
          },
        })
      : Promise.resolve([]),
    wantAnalyses
      ? prisma.analysis.findMany({
          where: {
            userId,
            kind: "ibr",
            reviewState: "in_review",
            ...dateFilter,
            ...(q ? { OR: [
              { nome: { contains: q, mode: "insensitive" } },
              { company: { is: { razaoSocial: { contains: q, mode: "insensitive" } } } },
              { company: { is: { nomeFantasia: { contains: q, mode: "insensitive" } } } },
            ] } : {}),
          },
          orderBy: { createdAt: "desc" },
          take: 50,
          include: {
            company: { select: { razaoSocial: true, nomeFantasia: true, setor: true } },
            engagement: { select: { requestedBy: true, feeAmount: true } },
          },
        })
      : Promise.resolve([]),
    wantDueReviews
      ? prisma.analysis.findMany({
          where: {
            userId,
            mode: "recurring",
            nextReviewAt: { lte: in14Days },
            ...(q ? { OR: [
              { nome: { contains: q, mode: "insensitive" } },
              { company: { is: { razaoSocial: { contains: q, mode: "insensitive" } } } },
              { company: { is: { nomeFantasia: { contains: q, mode: "insensitive" } } } },
            ] } : {}),
          },
          orderBy: { nextReviewAt: "asc" },
          take: 50,
          include: {
            company: { select: { razaoSocial: true, nomeFantasia: true, setor: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  const items: InboxItem[] = [];

  for (const lead of leads) {
    items.push({
      id: lead.id,
      type: "lead",
      ref: refForLead(lead.id),
      requestedBy: lead.contactName ?? lead.contactEmail,
      targetCompany: lead.targetCompany,
      debtVolume: lead.debtVolume ?? undefined,
      receivedAt: lead.createdAt.toISOString(),
      href: `/inbox/lead/${lead.id}`,
    });
  }

  for (const eng of engagements) {
    items.push({
      id: eng.id,
      type: "engagement",
      ref: refForEngagement(eng.id, eng.createdAt),
      requestedBy: eng.requestedBy,
      targetCompany: eng.companyName,
      sector: eng.analysis?.company?.setor ?? undefined,
      tier: tierFromIbrType(eng.analysis?.ibrType),
      receivedAt: eng.createdAt.toISOString(),
      href: `/engagements/${eng.id}`,
    });
  }

  for (const ana of analyses) {
    const companyName = ana.company?.nomeFantasia || ana.company?.razaoSocial || "Empresa";
    items.push({
      id: ana.id,
      type: "analysis",
      ref: refForAnalysis(ana.id, ana.createdAt),
      requestedBy: ana.engagement?.requestedBy ?? "—",
      targetCompany: companyName,
      sector: ana.company?.setor ?? undefined,
      tier: tierFromIbrType(ana.ibrType),
      receivedAt: ana.createdAt.toISOString(),
      href: `/analises/${ana.id}`,
    });
  }

  for (const ana of dueReviews) {
    if (!ana.nextReviewAt) continue;
    const companyName = ana.company?.nomeFantasia || ana.company?.razaoSocial || "Empresa";
    const daysUntilDue = Math.floor(
      (ana.nextReviewAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
    );
    items.push({
      id: ana.id,
      type: "due_review",
      ref: refForAnalysis(ana.id, ana.createdAt),
      requestedBy: "—",
      targetCompany: companyName,
      sector: ana.company?.setor ?? undefined,
      // Pra ordenação consistente com outros tipos, usa nextReviewAt no campo
      // receivedAt (mais antigo = mais urgente).
      receivedAt: ana.nextReviewAt.toISOString(),
      href: `/analises/${ana.id}`,
      daysUntilDue,
      dueAt: ana.nextReviewAt.toISOString(),
    });
  }

  // Due reviews vencidas vão pro topo; depois ordem decrescente por data.
  items.sort((a, b) => {
    if (a.type === "due_review" && b.type !== "due_review") return -1;
    if (b.type === "due_review" && a.type !== "due_review") return 1;
    if (a.type === "due_review" && b.type === "due_review") {
      return (a.daysUntilDue ?? 0) - (b.daysUntilDue ?? 0);
    }
    return b.receivedAt.localeCompare(a.receivedAt);
  });

  res.json({ items, total: items.length });
});

export default router;
