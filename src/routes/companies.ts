import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { deleteFile } from "../services/storage";

const router = Router();

// CNPJ lookup proxy — avoids CORS issues when frontend calls BrasilAPI directly.
// User-Agent header required: BrasilAPI returns 403 to default Node fetch UA.
router.get("/cnpj/:cnpj", async (req: AuthRequest, res: Response): Promise<void> => {
  const digits = (req.params.cnpj as string).replace(/\D/g, "");
  if (digits.length !== 14) { res.status(400).json({ error: "CNPJ inválido" }); return; }

  try {
    const response = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${digits}`, {
      headers: {
        "User-Agent": "Quantua/1.0 (+https://quantua.com.br)",
        Accept: "application/json",
      },
    });
    if (response.status === 404) { res.status(404).json({ error: "CNPJ não encontrado na Receita Federal" }); return; }
    if (!response.ok) {
      console.error(`[BrasilAPI] CNPJ ${digits} → HTTP ${response.status}`);
      res.status(502).json({ error: "Erro ao consultar CNPJ" });
      return;
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("[BrasilAPI] fetch failed:", err);
    res.status(502).json({ error: "Falha ao conectar com a Receita Federal" });
  }
});

router.use(requireAuth);

const companySchema = z.object({
  razaoSocial: z.string().min(2),
  nomeFantasia: z.string().optional(),
  cnpj: z.string().optional(),
  setor: z.string().optional(),
  porte: z.string().optional(),
  uf: z.string().optional(),
});

router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const companies = await prisma.company.findMany({
    where: { userId: { in: req.scopeUserIds! } },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { analyses: true } } },
  });
  res.json(companies);
});

router.post("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = companySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const company = await prisma.company.create({
    data: { ...parsed.data, userId: req.userId! },
  });
  res.status(201).json(company);
});

router.get("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const company = await prisma.company.findFirst({
    where: { id, userId: { in: req.scopeUserIds! } },
    include: { analyses: { orderBy: { createdAt: "desc" }, take: 10 } },
  });
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  res.json(company);
});

router.put("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const existing = await prisma.company.findFirst({ where: { id, userId: { in: req.scopeUserIds! } } });
  if (!existing) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  const parsed = companySchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const company = await prisma.company.update({ where: { id }, data: parsed.data });
  res.json(company);
});

router.delete("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const existing = await prisma.company.findFirst({ where: { id, userId: { in: req.scopeUserIds! } } });
  if (!existing) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  try {
    // Delete associated storage files before cascading DB delete
    const docs = await prisma.document.findMany({
      where: { company: { id } },
      select: { storagePath: true },
    });

    for (const doc of docs) {
      if (doc.storagePath) {
        try { await deleteFile(doc.storagePath); } catch { /* ignore storage errors */ }
      }
    }

    await prisma.company.delete({ where: { id } });
    res.status(204).send();
  } catch (err: any) {
    console.error("Error deleting company:", err);
    res.status(500).json({ error: "Erro ao excluir empresa. Tente novamente." });
  }
});

export default router;
