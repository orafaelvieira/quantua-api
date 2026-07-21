import { Router, Response } from "express";
import multer from "multer";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { whereEmpresaVisivel, whereRecursoEmpresa, guardaEscritaSuspensao } from "../services/escopo-empresa";
import { uploadFile, deleteFile } from "../services/storage";
import { registrarAuditoria } from "../services/audit-trail";
import { derivarDocumentosLogicos, periodosFaltantes } from "../services/fechamento-periodo";
import { montarLinhaAdotada, montarLinhaFixada, propagarMetadadosDoPool } from "../services/fixacao-pool";
import { curarUpload, validarEmpresaDoDocumento } from "../services/curadoria-pool";
import { downloadFile } from "../services/storage";

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
 *  cancelada não pode ser editado/substituído/excluído — evidência congelada.
 *  Documento de POOL (analysisId null, Data room da empresa) não tem IBR que o
 *  congele — a guarda não se aplica. */
async function analiseCancelada(analysisId: string | null): Promise<boolean> {
  if (!analysisId) return false;
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
  /// DATA ROOM ÚNICA (fase A): ausente = documento do POOL da empresa, enviado
  /// pelo workspace antes de (ou sem) qualquer IBR. Presente = fluxo de sempre.
  analysisId: z.string().uuid().optional(),
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

// GET /documents/pool?companyId= — a Data room da empresa na forma que o
// SELETOR do wizard consome (fase B): documentos LÓGICOS (cadeias de
// substituição fundidas — só a versão vigente é fixável) + os avisos do W2
// como gates ("falta mai/26"). Materiais indicam se o resumo de IA já existe
// (fixar herda o resumo — paga-se 1× por versão de arquivo).
router.get("/pool", async (req: AuthRequest, res: Response): Promise<void> => {
  const companyId = String(req.query.companyId ?? "");
  if (!companyId) { res.status(400).json({ error: "companyId é obrigatório" }); return; }
  const company = await prisma.company.findFirst({ where: { id: companyId, ...whereEmpresaVisivel(req) } });
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  const docs = await prisma.document.findMany({
    where: { companyId, analysisId: null },
    orderBy: { createdAt: "asc" },
  });
  const porId = new Map(docs.map((d) => [d.id, d]));
  const logicos = derivarDocumentosLogicos(docs);
  const documentos = logicos.map((l) => {
    const v = porId.get(l.vigente.id)!;
    const cache = v.dadosExtraidos as { resumo?: string } | null;
    return {
      id: v.id, nome: v.nome, tipo: v.tipo, competencia: v.competencia, moeda: v.moeda,
      versao: v.versao, status: v.status, tamanho: v.tamanho, criadoEm: v.createdAt,
      totalVersoes: l.versoes.length, temResumo: !!cache?.resumo,
    };
  });
  res.json({ documentos, faltantes: periodosFaltantes(logicos, new Date()) });
});

// POST /documents/pool/adotar — ADOÇÃO DE LEGADOS: documentos subidos direto
// em IBRs (antes da Data room única) viram linhas do POOL, para o seletor do
// wizard enxergá-los. Dedup por HASH (o mesmo arquivo re-subido em N IBRs vira
// UMA linha); material herda o resumo de IA; a linha do IBR fica INTOCADA
// (evidência dele — zero retrocesso). Curadoria best-effort preenche a
// competência que faltar (legados costumam não ter).
// body: { companyId }
router.post("/pool/adotar", async (req: AuthRequest, res: Response): Promise<void> => {
  const companyId = String((req.body ?? {}).companyId ?? "");
  if (!companyId) { res.status(400).json({ error: "companyId é obrigatório" }); return; }
  const company = await prisma.company.findFirst({ where: { id: companyId, ...whereEmpresaVisivel(req) } });
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  const [legados, poolAtual] = await Promise.all([
    prisma.document.findMany({
      where: { companyId, analysisId: { not: null }, fixadoDeId: null, status: { not: "Substituído" } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.document.findMany({ where: { companyId, analysisId: null }, select: { hash: true } }),
  ]);
  const hashesNoPool = new Set(poolAtual.map((d) => d.hash).filter(Boolean));

  let adotados = 0, pulados = 0;
  const avisos: string[] = [];
  for (const doc of legados) {
    if (!doc.hash || hashesNoPool.has(doc.hash)) { pulados++; continue; }
    hashesNoPool.add(doc.hash);

    const data = montarLinhaAdotada(doc);
    // Curadoria best-effort: legado costuma vir sem competência — o conteúdo
    // decide (mesmas regras do upload). Falha = segue com o que há.
    if (data.tipo !== "Material complementar") {
      try {
        if (doc.storagePath) {
          const det = await curarUpload(await downloadFile(doc.storagePath), doc.nome);
          if (det.tipo && det.tipo !== data.tipo) {
            avisos.push(`${doc.nome}: enviado como "${data.tipo}", mas o conteúdo é ${det.tipo} — tipo corrigido na adoção.`);
            data.tipo = det.tipo;
          }
          if (det.competencia && !data.competencia) {
            data.competencia = det.competencia;
            avisos.push(`${doc.nome}: competência identificada pelo conteúdo: ${det.competencia}.`);
          }
        }
      } catch (e: any) {
        console.warn(`[adotar] curadoria falhou para ${doc.nome} (segue sem):`, e?.message ?? e);
      }
    }

    const novo = await prisma.document.create({ data });
    adotados++;
    void registrarAuditoria({
      userId: req.userId!, entity: "document", entityId: novo.id,
      field: "adoção de documento legado na Data room da empresa",
      after: { nome: novo.nome, tipo: novo.tipo, competencia: novo.competencia, documentoOrigemId: doc.id, analiseOrigemId: doc.analysisId, hash: (novo.hash ?? "").slice(0, 12) },
      source: "data-room",
    });
  }

  res.json({ adotados, pulados, avisos });
});

router.post("/upload", upload.single("file"), async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.file) { res.status(400).json({ error: "Nenhum arquivo enviado" }); return; }

  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const { analysisId, companyId, tipo, competencia, moeda } = parsed.data;

  if (analysisId) {
    // Fluxo de sempre: a análise pertence ao usuário (e ancora o documento).
    const analysis = await prisma.analysis.findFirst({ where: { id: analysisId, ...whereRecursoEmpresa(req) } });
    if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
  } else {
    // POOL (fase A): sem análise, a validação de escopo é pela EMPRESA.
    const company = await prisma.company.findFirst({ where: { id: companyId, ...whereEmpresaVisivel(req) } });
    if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  }

  const nome = fixFilename(req.file.originalname);
  const key = `uploads/${req.userId}/${analysisId ?? `pool-${companyId}`}/${Date.now()}-${nome}`;
  const storagePath = await uploadFile(req.file.buffer, key, req.file.mimetype);
  const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

  const tamanho = req.file.size > 1024 * 1024
    ? `${(req.file.size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(req.file.size / 1024)} KB`;

  // Auto-detecção de BALANCETE pelo nome do arquivo (o wizard manda "Outro"
  // por padrão; a linha de extração de balancete depende do tipo correto).
  let tipoFinal = tipo === "Outro" && /balancete/i.test(nome) ? "Balancete" : tipo;
  let competenciaFinal: string | null = competencia ?? null;

  // CURADORIA ASSISTIDA (pedido do usuário, 20/07/2026): na porta do POOL —
  // a Data room é fonte única — tipo e competência não ficam só a cargo do
  // analista: o CONTEÚDO decide. Tipo divergente é CORRIGIDO (auditado, como
  // no /process); competência vazia é preenchida; declarada ≠ detectada vira
  // aviso (o humano declarou — o sistema aponta, não sobrescreve).
  let curadoria: { tipoDetectado: string | null; competenciaDetectada: string | null; evidencias: string[]; avisos: string[] } | null = null;
  if (!analysisId && tipoFinal !== "Material complementar") {
    try {
      const det = await curarUpload(req.file.buffer, nome);
      const avisos: string[] = [];

      // TRAVA DE EMPRESA ERRADA (21/07/2026): a Data room é POR EMPRESA — um
      // balancete da Belagro na Move Farma envenena período, cadência e
      // extração. Se o conteúdo cita OUTRA empresa cadastrada e NÃO cita a do
      // workspace, recusa com 409; o operador confirma explicitamente
      // (confirmarEmpresa=1) e a confirmação fica na trilha.
      if (det.texto && req.body?.confirmarEmpresa !== "1") {
        const [alvo, outras] = await Promise.all([
          prisma.company.findUnique({ where: { id: companyId }, select: { razaoSocial: true, nomeFantasia: true } }),
          prisma.company.findMany({
            where: { id: { not: companyId }, ...whereEmpresaVisivel(req) },
            select: { id: true, razaoSocial: true, nomeFantasia: true },
          }),
        ]);
        if (alvo) {
          const v = validarEmpresaDoDocumento(det.texto, alvo, outras);
          if (v.outraDetectada && !v.alvoNoDoc) {
            res.status(409).json({
              error: `Este documento parece ser da empresa "${v.outraDetectada.nome}", não de "${alvo.nomeFantasia || alvo.razaoSocial}". Confira o arquivo — a Data room é por empresa e um documento trocado contamina períodos e extração.`,
              empresaDivergente: { nome: v.outraDetectada.nome, id: v.outraDetectada.id },
              podeConfirmar: true,
            });
            return;
          }
          if (v.outraDetectada && v.alvoNoDoc) {
            avisos.push(`O documento cita também "${v.outraDetectada.nome}" — se for consolidado de grupo, tudo bem; se for do outro CNPJ, remova e envie na empresa certa.`);
          }
        }
      }

      const tipoDeclarado = tipoFinal;
      if (det.tipo && det.tipo !== tipoFinal) {
        tipoFinal = det.tipo;
        avisos.push(`Enviado como "${tipoDeclarado}", mas o conteúdo é ${det.tipo} — o tipo foi corrigido automaticamente.`);
      }
      if (det.competencia) {
        if (!competenciaFinal) {
          competenciaFinal = det.competencia;
          avisos.push(`Competência identificada pelo conteúdo: ${det.competencia}.`);
        } else if (competenciaFinal !== det.competencia) {
          avisos.push(`Competência declarada (${competenciaFinal}) difere da identificada no conteúdo (${det.competencia}) — confira.`);
        }
      }
      curadoria = { tipoDetectado: det.tipo, competenciaDetectada: det.competencia, evidencias: det.evidencias, avisos };
    } catch (e: any) {
      console.warn(`[upload] curadoria falhou para ${nome} (segue com o declarado):`, e?.message ?? e);
    }
  }

  const doc = await prisma.document.create({
    data: {
      analysisId: analysisId ?? null,
      companyId,
      nome,
      tipo: tipoFinal,
      competencia: competenciaFinal,
      moeda,
      storagePath,
      hash,
      tamanho,
      status: "Pendente",
    },
  });

  // Upload de POOL é mutação da Data room da empresa — trilha (regra da casa).
  // O fluxo com análise mantém o comportamento de sempre.
  if (!analysisId) {
    await registrarAuditoria({
      userId: req.userId!, entity: "document", entityId: doc.id,
      field: "upload na Data room da empresa",
      after: {
        nome, tipo: tipoFinal, competencia: competenciaFinal, companyId, hash: hash.slice(0, 12),
        ...(curadoria && curadoria.avisos.length
          ? { curadoria: { tipoDetectado: curadoria.tipoDetectado, competenciaDetectada: curadoria.competenciaDetectada, evidencias: curadoria.evidencias } }
          : {}),
        // Confirmação FORÇADA da trava de empresa: fica explícita na trilha.
        ...(req.body?.confirmarEmpresa === "1" ? { empresaConfirmadaManualmente: true } : {}),
      },
      source: "data-room",
    });
  }

  res.status(201).json({ ...doc, curadoria });
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

  const data = {
    tipo,
    // opcionais: só atualiza quando enviados (chamadas antigas com { tipo } seguem iguais).
    // moeda carrega unidade junto ("BRL (milhões)") — teto folgado, sem truncar.
    ...(typeof competencia === "string" ? { competencia: competencia.trim().slice(0, 40) || null } : {}),
    ...(typeof moeda === "string" && moeda.trim() ? { moeda: moeda.trim().slice(0, 24) } : {}),
  };
  const updated = await prisma.document.update({ where: { id }, data });
  // Fase B: correção na linha do POOL escorre para as fixações ainda Pendentes
  // (o pipeline lê a linha fixada; metadado pré-extração é fato do documento).
  if (!doc.analysisId) await propagarMetadadosDoPool(doc.id, data);
  res.json(updated);
});

// SUBSTITUIR documento (política 2026-07-15: nunca deletar o que foi processado).
// A versão antiga vira status "Substituído" — arquivo PRESERVADO no storage como
// evidência do que fundamentou versões anteriores dos produtos — e aponta para a
// sucessora. A nova entra "Pendente" com versão incrementada; o reprocessamento
// da análise passa a enxergar SÓ ela (o process filtra "Substituído").
//
// FASE B (fonte única): substituir uma linha FIXADA substitui NA DATA ROOM da
// empresa (a versão nova nasce no pool) e refixa a nova neste IBR — o pool nunca
// fica para trás; os OUTROS IBRs que fixaram a versão antiga acendem "insumo
// desatualizado" sozinhos (fixadoDe.substituidoPorId).
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
  const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
  const tamanho = req.file.size > 1024 * 1024
    ? `${(req.file.size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(req.file.size / 1024)} KB`;

  // Linha FIXADA: quem é substituído de verdade é o documento do POOL.
  if (doc.fixadoDeId) {
    // Anda até a versão VIGENTE do pool (outro fluxo pode já ter criado v3).
    let vigente = await prisma.document.findUnique({ where: { id: doc.fixadoDeId } });
    for (let i = 0; vigente?.substituidoPorId && i < 50; i++) {
      const prox = await prisma.document.findUnique({ where: { id: vigente.substituidoPorId } });
      if (!prox) break;
      vigente = prox;
    }
    if (!vigente) { res.status(409).json({ error: "Documento de origem não existe mais na Data room — selecione de novo pelo wizard." }); return; }

    const key = `uploads/${req.userId}/pool-${doc.companyId}/${Date.now()}-${nome}`;
    const storagePath = await uploadFile(req.file.buffer, key, req.file.mimetype);

    // v nova NASCE NO POOL (fonte única) herdando os metadados do insumo lógico.
    const novoPool = await prisma.document.create({
      data: {
        analysisId: null,
        companyId: doc.companyId,
        nome,
        tipo: vigente.tipo,
        competencia: vigente.competencia,
        moeda: vigente.moeda,
        storagePath, hash, tamanho,
        status: "Pendente",
        versao: vigente.versao + 1,
      },
    });
    await prisma.document.update({
      where: { id: vigente.id },
      data: { status: "Substituído", substituidoPorId: novoPool.id, motivoSubstituicao: motivo },
    });
    // Refixa a versão nova neste IBR; a fixação antiga vira evidência.
    const novoFixado = await prisma.document.create({ data: montarLinhaFixada(novoPool, { id: doc.analysisId!, companyId: doc.companyId }) });
    await prisma.document.update({
      where: { id: doc.id },
      data: { status: "Substituído", substituidoPorId: novoFixado.id, motivoSubstituicao: motivo },
    });
    void registrarAuditoria({
      userId: req.userId!, analysisId: doc.analysisId, entity: "document", entityId: vigente.id,
      field: "substituição de documento na Data room (via IBR) + refixação",
      before: { nome: vigente.nome, hash: vigente.hash, versao: vigente.versao },
      after: { nome: novoPool.nome, hash: novoPool.hash, versao: novoPool.versao, documentoPoolId: novoPool.id, documentoFixadoId: novoFixado.id },
      reason: motivo ?? undefined, source: "data-room",
    });
    res.status(201).json(novoFixado);
    return;
  }

  const key = `uploads/${req.userId}/${doc.analysisId ?? `pool-${doc.companyId}`}/${Date.now()}-${nome}`;
  const storagePath = await uploadFile(req.file.buffer, key, req.file.mimetype);

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

  // Fase B: documento do POOL com fixação viva em algum IBR não sai — os IBRs
  // dependem dele (arquivo compartilhado + proveniência).
  if (!doc.analysisId) {
    const fixacoes = await prisma.document.count({ where: { fixadoDeId: id } });
    if (fixacoes > 0) {
      res.status(409).json({
        error: "Este documento está fixado em IBR — remova a fixação lá (ou substitua o documento) antes de excluí-lo da Data room.",
      });
      return;
    }
  }

  // POLÍTICA (2026-07-15): documento que já participou de qualquer produto NUNCA é
  // deletado — é evidência; corrija com "Substituir". Exclusão real só para upload
  // errado que nunca foi processado nem substituído.
  // FIXAÇÃO (fase B) é exceção deliberada: desfixar remove só a SELEÇÃO — arquivo
  // e dados permanecem no pool; bloqueia-se apenas cadeia própria do IBR (v nova).
  const jaUsado = doc.fixadoDeId
    ? !!doc.substituidoPorId
    : doc.status !== "Pendente" || !!doc.dadosExtraidos || !!doc.substituidoPorId || doc.versao > 1;
  if (jaUsado) {
    res.status(409).json({
      error: "Documento já processado não pode ser excluído — use \"Substituir\" para enviar a versão corrigida (a antiga fica preservada como evidência).",
    });
    return;
  }

  // ARQUIVO COMPARTILHADO — nunca apagar do storage se QUALQUER outra linha
  // ainda aponta para o mesmo storagePath. Duas fontes de compartilhamento:
  //  (a) fixação (linha do IBR reusa o arquivo do pool);
  //  (b) ADOÇÃO de legado (linha nova do pool reusa o arquivo do documento do
  //      IBR antigo) — aqui a linha excluída NÃO tem fixadoDeId, então a
  //      checagem por flag não bastava: apagar o arquivo cegaria o IBR de
  //      origem, que continua apontando para ele. Bug de perda de dado achado
  //      na revisão de 21/07/2026 — a contagem abaixo é a guarda definitiva.
  if (doc.storagePath) {
    const outrasComMesmoArquivo = await prisma.document.count({
      where: { storagePath: doc.storagePath, id: { not: doc.id } },
    });
    if (outrasComMesmoArquivo === 0) await deleteFile(doc.storagePath);
  }
  await prisma.document.delete({ where: { id } });
  void registrarAuditoria({
    userId: req.userId!, analysisId: doc.analysisId, entity: "document", entityId: id,
    field: doc.fixadoDeId
      ? "desfixação de documento da Data room (arquivo e dados permanecem no pool)"
      : "exclusão de documento nunca processado",
    before: { nome: doc.nome, tipo: doc.tipo, hash: doc.hash },
    ...(doc.fixadoDeId ? { source: "data-room" } : {}),
  });
  res.status(204).send();
});

export default router;
