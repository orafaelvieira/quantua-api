import { Router, Response } from "express";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

// GET /dictionary — list all entries for current user (global + user-specific)
// Query params: ?search=, ?tipo=BP|DRE, ?grupo=
router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const { search, tipo, grupo } = req.query;

  const where: any = {
    OR: [
      { userId: null },                        // global seed entries
      { userId: { in: req.scopeUserIds! } },   // entries do workspace (firma)
    ],
  };

  if (tipo) where.tipo = tipo as string;
  if (grupo) where.grupoConta = { contains: grupo as string, mode: "insensitive" };
  if (search) {
    where.AND = [
      {
        OR: [
          { nomeOriginal: { contains: search as string, mode: "insensitive" } },
          { contaDestino: { contains: search as string, mode: "insensitive" } },
        ],
      },
    ];
  }

  const entries = await prisma.accountDictionary.findMany({
    where,
    orderBy: [{ grupoConta: "asc" }, { contaDestino: "asc" }, { nomeOriginal: "asc" }],
  });
  res.json(entries);
});

// GET /dictionary/template — list all BP template accounts (for dropdowns)
router.get("/template", async (_req: AuthRequest, res: Response): Promise<void> => {
  // Import BP_TEMPLATE from financial-templates
  const { BP_TEMPLATE } = require("../services/financial-templates");
  // Group by parent account
  const grouped: Record<string, string[]> = {};
  for (const item of BP_TEMPLATE) {
    const parent = getParentGroup(item);
    if (!grouped[parent]) grouped[parent] = [];
    if (!grouped[parent].includes(item.conta)) {
      grouped[parent].push(item.conta);
    }
  }
  res.json({ template: BP_TEMPLATE, grouped });
});

// Helper to determine parent group based on classificacao
function getParentGroup(item: { classificacao: string; conta: string; nivel: number }): string {
  if (item.nivel <= 1) return item.conta;
  // Map classificacao to parent
  const map: Record<string, string> = {
    AF: "Ativo Circulante", AO: "Ativo Circulante",
    ANC: "Ativo Não Circulante",
    PO: "Passivo Circulante", PF: "Passivo Circulante",
    PNC: "Passivo Não Circulante",
    PL: "Patrimônio Líquido",
  };
  return map[item.classificacao] || item.conta;
}

// POST /dictionary — add entry
router.post("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const { nomeOriginal, contaDestino, grupoConta, tipo } = req.body;

  if (!nomeOriginal || !contaDestino || !grupoConta) {
    res.status(400).json({ error: "nomeOriginal, contaDestino e grupoConta são obrigatórios" });
    return;
  }

  const entry = await prisma.accountDictionary.create({
    data: {
      nomeOriginal,
      contaDestino,
      grupoConta,
      tipo: tipo || "BP",
      userId: req.userId!,
    },
  });
  res.status(201).json(entry);
});

// PUT /dictionary/:id — update entry
router.put("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const existing = await prisma.accountDictionary.findFirst({
    where: { id },
  });

  if (!existing) {
    res.status(404).json({ error: "Entrada não encontrada" });
    return;
  }

  // Pode editar entradas do próprio workspace (não as globais do sistema)
  if (existing.userId !== null && !req.scopeUserIds!.includes(existing.userId)) {
    res.status(403).json({ error: "Sem permissão para editar esta entrada" });
    return;
  }

  const { nomeOriginal, contaDestino, grupoConta } = req.body;

  // If it's a global entry, create a user override instead of modifying
  if (existing.userId === null) {
    const override = await prisma.accountDictionary.create({
      data: {
        nomeOriginal: nomeOriginal || existing.nomeOriginal,
        contaDestino: contaDestino || existing.contaDestino,
        grupoConta: grupoConta || existing.grupoConta,
        tipo: existing.tipo,
        userId: req.userId!,
      },
    });
    res.json(override);
    return;
  }

  const updated = await prisma.accountDictionary.update({
    where: { id },
    data: {
      ...(nomeOriginal && { nomeOriginal }),
      ...(contaDestino && { contaDestino }),
      ...(grupoConta && { grupoConta }),
    },
  });
  res.json(updated);
});

// DELETE /dictionary/:id — delete entry (only user-owned)
router.delete("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const existing = await prisma.accountDictionary.findFirst({
    where: { id },
  });

  if (!existing) {
    res.status(404).json({ error: "Entrada não encontrada" });
    return;
  }

  if (existing.userId === null) {
    res.status(403).json({ error: "Não é possível excluir entradas globais do sistema" });
    return;
  }

  if (!req.scopeUserIds!.includes(existing.userId)) {
    res.status(403).json({ error: "Sem permissão" });
    return;
  }

  await prisma.accountDictionary.delete({ where: { id } });
  res.status(204).send();
});

// POST /dictionary/classify — bulk classify unmatched accounts
// Body: { analysisId?: string, entries: Array<{ nomeOriginal, contaDestino, grupoConta }> }
router.post("/classify", async (req: AuthRequest, res: Response): Promise<void> => {
  const { entries, analysisId } = req.body;

  if (!entries || !Array.isArray(entries)) {
    res.status(400).json({ error: "entries deve ser um array" });
    return;
  }

  const created = [];
  for (const entry of entries) {
    if (!entry.nomeOriginal || !entry.contaDestino || !entry.grupoConta) continue;

    try {
      const result = await prisma.accountDictionary.upsert({
        where: {
          nomeOriginal_tipo_grupoConta_userId: {
            nomeOriginal: entry.nomeOriginal,
            tipo: entry.tipo || "BP",
            grupoConta: entry.grupoConta,
            userId: req.userId!,
          },
        },
        update: {
          contaDestino: entry.contaDestino,
        },
        create: {
          nomeOriginal: entry.nomeOriginal,
          contaDestino: entry.contaDestino,
          grupoConta: entry.grupoConta,
          tipo: entry.tipo || "BP",
          userId: req.userId!,
        },
      });
      created.push(result);
    } catch (err) {
      // skip duplicates
      console.error("Error classifying entry:", entry.nomeOriginal, err);
    }
  }

  res.json({ classified: created.length, entries: created });
});

export default router;
