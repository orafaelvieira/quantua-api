import { Router, Response } from "express";
import multer from "multer";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { uploadFile, deleteFile } from "../services/storage";

const router = Router();
router.use(requireAuth);

/**
 * Fix multer filename encoding: when the browser sends UTF-8 filenames,
 * multer may interpret the bytes as Latin-1, producing mojibake
 * (e.g., "AÃ§ÃoCorretora" instead of "AçãoCorretora").
 * Re-encode from latin1→utf8 to recover the correct characters.
 */
function fixFilename(raw: string): string {
  try {
    const fixed = Buffer.from(raw, "latin1").toString("utf8");
    // Verify it produced valid UTF-8 (no replacement chars that weren't in original)
    if (!fixed.includes("\uFFFD") || raw.includes("\uFFFD")) return fixed;
  } catch {
    // If conversion fails, return original
  }
  return raw;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel", "application/pdf",
      "text/csv", "application/octet-stream"];
    const allowedExt = /\.(xlsx|xls|pdf|csv)$/i.test(file.originalname);
    cb(null, allowedExt || allowed.includes(file.mimetype));
  },
});

const uploadSchema = z.object({
  analysisId: z.string().uuid(),
  companyId: z.string().uuid(),
  tipo: z.enum(["DRE", "Balanço Patrimonial", "Balancete", "Outro"]),
  competencia: z.string().optional(),
  moeda: z.string().default("BRL"),
});

router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysisId = req.query.analysisId as string | undefined;
  const companyId = req.query.companyId as string | undefined;
  const documents = await prisma.document.findMany({
    where: {
      company: { userId: req.userId! },
      ...(analysisId ? { analysisId } : {}),
      ...(companyId ? { companyId } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(documents);
});

router.post("/upload", upload.single("file"), async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.file) { res.status(400).json({ error: "Nenhum arquivo enviado" }); return; }

  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const { analysisId, companyId, tipo, competencia, moeda } = parsed.data;

  // Verifica que a análise pertence ao usuário
  const analysis = await prisma.analysis.findFirst({ where: { id: analysisId, userId: req.userId! } });
  if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

  const nome = fixFilename(req.file.originalname);
  const key = `uploads/${req.userId}/${analysisId}/${Date.now()}-${nome}`;
  const storagePath = await uploadFile(req.file.buffer, key, req.file.mimetype);
  const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

  const tamanho = req.file.size > 1024 * 1024
    ? `${(req.file.size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(req.file.size / 1024)} KB`;

  const doc = await prisma.document.create({
    data: {
      analysisId,
      companyId,
      nome,
      tipo,
      competencia,
      moeda,
      storagePath,
      hash,
      tamanho,
      status: "Pendente",
    },
  });

  res.status(201).json(doc);
});

// Salvar dados brutos editados manualmente
const dadosExtraidosSchema = z.object({
  linhas: z.array(z.object({
    conta: z.string(),
    valores: z.record(z.string(), z.number()),
  })),
  periodos: z.array(z.string()),
});

router.put("/:id/dados-extraidos", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const parsed = dadosExtraidosSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const doc = await prisma.document.findFirst({
    where: { id, company: { userId: req.userId! } },
  });
  if (!doc) { res.status(404).json({ error: "Documento não encontrado" }); return; }

  const updated = await prisma.document.update({
    where: { id },
    data: {
      dadosExtraidos: { linhas: parsed.data.linhas, periodos: parsed.data.periodos },
      editadoManualmente: true,
      status: "Processado",
    },
  });

  res.json(updated);
});

// Update document type
router.put("/:id/tipo", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const { tipo } = req.body;
  if (!tipo || !["DRE", "Balanço Patrimonial", "Balancete", "Outro"].includes(tipo)) {
    res.status(400).json({ error: "Tipo inválido" });
    return;
  }

  const doc = await prisma.document.findFirst({
    where: { id, company: { userId: req.userId! } },
  });
  if (!doc) { res.status(404).json({ error: "Documento não encontrado" }); return; }

  const updated = await prisma.document.update({
    where: { id },
    data: { tipo },
  });
  res.json(updated);
});

router.delete("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const doc = await prisma.document.findFirst({
    where: { id, company: { userId: req.userId! } },
  });
  if (!doc) { res.status(404).json({ error: "Documento não encontrado" }); return; }

  if (doc.storagePath) await deleteFile(doc.storagePath);
  await prisma.document.delete({ where: { id } });
  res.status(204).send();
});

export default router;
