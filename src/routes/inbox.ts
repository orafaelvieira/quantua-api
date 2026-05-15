import { Router, Response } from "express";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

type InboxItemType = "lead" | "engagement" | "analysis";

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

  const [leads, engagements, analyses] = await Promise.all([
    prisma.lead.findMany({
      where: { status: { in: ["new", "contacted"] } },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.engagement.findMany({
      where: { userId, state: "proposal_sent" },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        analysis: {
          select: {
            id: true,
            ibrType: true,
            company: { select: { setor: true } },
          },
        },
      },
    }),
    prisma.analysis.findMany({
      where: { userId, kind: "ibr", reviewState: "in_review" },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        company: { select: { razaoSocial: true, nomeFantasia: true, setor: true } },
        engagement: { select: { requestedBy: true, feeAmount: true } },
      },
    }),
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

  items.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));

  res.json({ items, total: items.length });
});

export default router;
