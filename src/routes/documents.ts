import { Router, Response } from "express";
import multer from "multer";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { whereEmpresaVisivel, whereRecursoEmpresa, guardaEscritaSuspensao } from "../services/escopo-empresa";
import { uploadFile, deleteFile } from "../services/storage";
import { registrarAuditoria } from "../services/audit-trail";

const router = Router();
router.use(requireAuth);
// SOMENTE CONSULTA: org suspensa (inadimplência) lê mas não escreve.
router.use(guardaEscritaSuspensao("document"));

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

/** IBR cancelado é SOMENTE CONSULTA (2026-07-16): documento de análise
 *  cancelada não pode ser editado/substituído/excluído — evidência congelada. */
async function analiseCancelada(analysisId: string): Promise<boolean> {
  const a = await prisma.analysis.findUnique({ where: { id: analysisId }, select: { status: true } }).catch(() => null);
  return a?.status === "Cancelada";
}
const ERRO_CANCELADA = "IBR cancelado é somente consulta — documentos ficam congelados como evidência.";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel", "application/pdf",
      "text/csv", "application/octet-stream"];
    // Demonstrações: xlsx/xls/pdf/csv. Materiais complementares: + docx/doc/pptx/ppt/txt/md.
    const allowedExt = /\.(xlsx|xls|pdf|csv|docx|doc|pptx|ppt|txt|md)$/i.test(file.originalname);
    cb(null, allowedExt || allowed.includes(file.mimetype));
  },
});

const uploadSchema = z.object({
  analysisId: z.string().uuid(),
  companyId: z.string().uuid(),
  tipo: z.enum(["DRE", "Balanço Patrimonial", "Balancete", "Outro", "Material complementar"]),
  competencia: z.string().optional(),
  moeda: z.string().default("BRL"),
});

router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const analysisId = req.query.analysisId as string | undefined;
  const companyId = req.query.companyId as string | undefined;
  const documents = await prisma.document.findMany({
    where: {
      company: whereEmpresaVisivel(req),
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
  const analysis = await prisma.analysis.findFirst({ where: { id: analysisId, ...whereRecursoEmpresa(req) } });
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
    where: { id, company: whereEmpresaVisivel(req) },
  });
  if (!doc) { res.status(404).json({ error: "Documento não encontrado" }); return; }
  if (await analiseCancelada(doc.analysisId)) { res.status(409).json({ error: ERRO_CANCELADA }); return; }

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

// Update document metadata (tipo + competência/moeda). Antes só o tipo persistia —
// editar competência/moeda no wizard após o upload era perdido em silêncio.
router.put("/:id/tipo", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const { tipo, competencia, moeda } = req.body;
  if (!tipo || !["DRE", "Balanço Patrimonial", "Balancete", "Outro"].includes(tipo)) {
    res.status(400).json({ error: "Tipo inválido" });
    return;
  }

  const doc = await prisma.document.findFirst({
    where: { id, company: whereEmpresaVisivel(req) },
  });
  if (!doc) { res.status(404).json({ error: "Documento não encontrado" }); return; }
  if (await analiseCancelada(doc.analysisId)) { res.status(409).json({ error: ERRO_CANCELADA }); return; }

  const updated = await prisma.document.update({
    where: { id },
    data: {
      tipo,
      // opcionais: só atualiza quando enviados (chamadas antigas com { tipo } seguem iguais).
      // moeda carrega unidade junto ("BRL (milhões)") — teto folgado, sem truncar.
      ...(typeof competencia === "string" ? { competencia: competencia.trim().slice(0, 40) || null } : {}),
      ...(typeof moeda === "string" && moeda.trim() ? { moeda: moeda.trim().slice(0, 24) } : {}),
    },
  });
  res.json(updated);
});

// SUBSTITUIR documento (política 2026-07-15: nunca deletar o que foi processado).
// A versão antiga vira status "Substituído" — arquivo PRESERVADO no storage como
// evidência do que fundamentou versões anteriores dos produtos — e aponta para a
// sucessora. A nova entra "Pendente" com versão incrementada; o reprocessamento
// da análise passa a enxergar SÓ ela (o process filtra "Substituído").
router.post("/:id/substituir", upload.single("file"), async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.file) { res.status(400).json({ error: "Nenhum arquivo enviado" }); return; }
  const id = req.params.id as string;
  const doc = await prisma.document.findFirst({
    where: { id, company: whereEmpresaVisivel(req) },
  });
  if (!doc) { res.status(404).json({ error: "Documento não encontrado" }); return; }
  if (await analiseCancelada(doc.analysisId)) { res.status(409).json({ error: ERRO_CANCELADA }); return; }
  if (doc.status === "Substituído") {
    res.status(409).json({ error: "Documento já foi substituído — substitua a versão vigente" });
    return;
  }

  const motivo = typeof req.body?.motivo === "string" ? req.body.motivo.trim().slice(0, 300) || null : null;
  const nome = fixFilename(req.file.originalname);
  const key = `uploads/${req.userId}/${doc.analysisId}/${Date.now()}-${nome}`;
  const storagePath = await uploadFile(req.file.buffer, key, req.file.mimetype);
  const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
  const tamanho = req.file.size > 1024 * 1024
    ? `${(req.file.size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(req.file.size / 1024)} KB`;

  // Metadados herdam da versão anterior (tipo/competência/moeda) — o documento é o
  // MESMO insumo lógico, em versão nova. Dados extraídos/edições NÃO herdam: o
  // conteúdo mudou, a extração precisa ser refeita (reprocessar a análise).
  const novo = await prisma.document.create({
    data: {
      analysisId: doc.analysisId,
      companyId: doc.companyId,
      nome,
      tipo: doc.tipo,
      competencia: doc.competencia,
      moeda: doc.moeda,
      storagePath,
      hash,
      tamanho,
      status: "Pendente",
      versao: doc.versao + 1,
    },
  });
  await prisma.document.update({
    where: { id: doc.id },
    data: { status: "Substituído", substituidoPorId: novo.id, motivoSubstituicao: motivo },
  });
  void registrarAuditoria({
    userId: req.userId!, analysisId: doc.analysisId, entity: "document", entityId: doc.id,
    field: "substituição de documento",
    before: { nome: doc.nome, hash: doc.hash, versao: doc.versao },
    after: { nome: novo.nome, hash: novo.hash, versao: novo.versao, documentoNovoId: novo.id },
    reason: motivo ?? undefined,
  });

  res.status(201).json(novo);
});

// Cadeia de VERSÕES do documento (da vigente até a original), seguindo os
// ponteiros substituidoPorId para trás.
router.get("/:id/versoes", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const doc = await prisma.document.findFirst({
    where: { id, company: whereEmpresaVisivel(req) },
  });
  if (!doc) { res.status(404).json({ error: "Documento não encontrado" }); return; }

  // Anda para FRENTE até a versão vigente, depois para TRÁS coletando a cadeia.
  let vigente = doc;
  while (vigente.substituidoPorId) {
    const prox = await prisma.document.findUnique({ where: { id: vigente.substituidoPorId } });
    if (!prox) break;
    vigente = prox;
  }
  const cadeia = [vigente];
  let atual = vigente;
  for (let i = 0; i < 50; i++) { // trava de segurança contra ciclo
    const anterior = await prisma.document.findFirst({ where: { substituidoPorId: atual.id } });
    if (!anterior) break;
    cadeia.push(anterior);
    atual = anterior;
  }
  res.json(cadeia.map((d) => ({
    id: d.id, nome: d.nome, versao: d.versao, status: d.status, hash: d.hash,
    tamanho: d.tamanho, criadoEm: d.createdAt, motivoSubstituicao: d.motivoSubstituicao,
    vigente: d.id === vigente.id,
  })));
});

router.delete("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const doc = await prisma.document.findFirst({
    where: { id, company: whereEmpresaVisivel(req) },
  });
  if (!doc) { res.status(404).json({ error: "Documento não encontrado" }); return; }
  if (await analiseCancelada(doc.analysisId)) { res.status(409).json({ error: ERRO_CANCELADA }); return; }

  // POLÍTICA (2026-07-15): documento que já participou de qualquer produto NUNCA é
  // deletado — é evidência; corrija com "Substituir". Exclusão real só para upload
  // errado que nunca foi processado nem substituído.
  const jaUsado = doc.status !== "Pendente" || !!doc.dadosExtraidos || !!doc.substituidoPorId || doc.versao > 1;
  if (jaUsado) {
    res.status(409).json({
      error: "Documento já processado não pode ser excluído — use \"Substituir\" para enviar a versão corrigida (a antiga fica preservada como evidência).",
    });
    return;
  }

  if (doc.storagePath) await deleteFile(doc.storagePath);
  await prisma.document.delete({ where: { id } });
  void registrarAuditoria({
    userId: req.userId!, analysisId: doc.analysisId, entity: "document", entityId: id,
    field: "exclusão de documento nunca processado",
    before: { nome: doc.nome, tipo: doc.tipo, hash: doc.hash },
  });
  res.status(204).send();
});

export default router;
