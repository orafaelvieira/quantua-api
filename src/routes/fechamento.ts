/**
 * FECHAMENTO DE PERÍODO (Workspace FP&A, W2) — rotas.
 *
 * Camada ADITIVA sobre a Data room: os documentos lógicos são DERIVADOS dos
 * Documents existentes (tipo+competência+cadeia de substituição) — nenhum
 * fluxo de upload/substituição do IBR muda. Só se grava o que não se deriva:
 * o ato de fechar/reabrir período e o regime da empresa.
 *
 * Toda mutação emite trilha (regra da casa). Mutações levam companyId no body
 * para a guarda de suspensão resolver a empresa-alvo.
 */
import { Router, Response } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { whereEmpresaVisivel, guardaEscritaSuspensao } from "../services/escopo-empresa";
import { prisma } from "../db/client";
import { registrarAuditoria } from "../services/audit-trail";
import { propagarMetadadosDoPool } from "../services/fixacao-pool";
import {
  REGIMES,
  RegimeFechamento,
  derivarDocumentosLogicos,
  estadoDoPeriodo,
  podeFechar,
  podeReabrir,
  retificacoesAposFechamento,
  periodosFaltantes,
  DocFechamento,
} from "../services/fechamento-periodo";

const router = Router();
router.use(requireAuth);
router.use(guardaEscritaSuspensao("company-body"));

async function companyNoEscopo(companyId: string, req: AuthRequest) {
  return prisma.company.findFirst({ where: { id: companyId, ...whereEmpresaVisivel(req) } });
}

async function docsDaEmpresa(companyId: string): Promise<DocFechamento[]> {
  const docs = await prisma.document.findMany({
    // Fixações (fase B) ficam de fora: são a LENTE do IBR sobre um documento
    // que já está aqui — contá-las empilharia versões-fantasma no painel.
    where: { companyId, fixadoDeId: null },
    select: { id: true, nome: true, tipo: true, competencia: true, versao: true, status: true, substituidoPorId: true, createdAt: true, moeda: true, hash: true, analysisId: true },
  });
  // Legado ADOTADO no pool: a linha do pool passa a representá-lo — a cópia
  // do IBR (mesmo hash) sai da listagem para não aparecer em dobro.
  const hashesNoPool = new Set(docs.filter((d) => d.analysisId === null && d.hash).map((d) => d.hash));
  return docs.filter((d) => d.analysisId === null || !d.hash || !hashesNoPool.has(d.hash));
}

// Período fechável: mês ("2026-05") OU exercício/ano fechado ("2025") —
// "Exercício como período" (Parte 11 do plano), primeira fatia.
const RE_PERIODO = /^\d{4}(-\d{2})?$/;

// GET /fechamento?companyId= — o painel inteiro: regime, períodos (estado,
// documentos com pilha, retificações), documentos sem período e avisos.
router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const companyId = String(req.query.companyId ?? "");
  if (!companyId) { res.status(400).json({ error: "companyId é obrigatório" }); return; }
  const company = await companyNoEscopo(companyId, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  const [docs, registros, poolDocs] = await Promise.all([
    docsDaEmpresa(companyId),
    prisma.periodoEmpresa.findMany({ where: { companyId } }),
    // Documentos de POOL (sem análise): os únicos cuja competência pode ser
    // corrigida por aqui — os de IBR são geridos no fluxo do IBR.
    prisma.document.findMany({ where: { companyId, analysisId: null }, select: { id: true } }),
  ]);
  const poolIds = new Set(poolDocs.map((d) => d.id));
  const logicos = derivarDocumentosLogicos(docs);
  const porPeriodo = new Map<string, typeof logicos>();
  for (const l of logicos) {
    if (!l.competencia) continue;
    porPeriodo.set(l.competencia, [...(porPeriodo.get(l.competencia) ?? []), l]);
  }
  const regPorPeriodo = new Map(registros.map((r) => [r.periodo, r]));

  // União: períodos com documento + períodos com registro de fechamento.
  const chaves = [...new Set([...porPeriodo.keys(), ...registros.map((r) => r.periodo)])].sort().reverse();

  const periodos = chaves.map((periodo) => {
    const documentos = porPeriodo.get(periodo) ?? [];
    const reg = regPorPeriodo.get(periodo) ?? null;
    const retificacoes = retificacoesAposFechamento(reg, documentos);
    return {
      periodo,
      estado: estadoDoPeriodo(reg, documentos),
      fechadoEm: reg?.fechadoEm ?? null,
      reabertoEm: reg?.reabertoEm ?? null,
      reabertoMotivo: reg?.reabertoMotivo ?? null,
      retificadoAposFechamento: retificacoes.length > 0,
      retificacoes: retificacoes.map((r) => ({ id: r.id, nome: r.nome, criadoEm: r.createdAt })),
      documentos: documentos.map((d) => ({
        tipo: d.tipo,
        vigente: { id: d.vigente.id, nome: d.vigente.nome, status: d.vigente.status, moeda: d.vigente.moeda ?? "BRL" },
        totalVersoes: d.versoes.length,
        versoes: d.versoes.map((v, i) => ({ id: v.id, nome: v.nome, status: v.status, criadoEm: v.createdAt, exibicao: i + 1 })),
        // CURA pela Data room: só documento de POOL é editável por aqui.
        editavel: poolIds.has(d.vigente.id),
      })),
    };
  });

  const faltantes = periodosFaltantes(logicos, new Date());
  const retificados = periodos.filter((p) => p.retificadoAposFechamento).map((p) => p.periodo);

  res.json({
    regime: (company as { regimeFechamento?: string }).regimeFechamento ?? "contabil",
    periodos,
    // Documentos sem período: LISTADOS por inteiro, não só contados — um pool
    // que recebe e não mostra não é Data room (furo apontado pelo usuário).
    semPeriodo: logicos
      .filter((l) => !l.competencia)
      .map((l) => ({
        id: l.vigente.id,
        nome: l.vigente.nome,
        tipo: l.tipo,
        status: l.vigente.status,
        criadoEm: l.vigente.createdAt,
        totalVersoes: l.versoes.length,
        // Só documento de POOL pode ter a competência corrigida por aqui —
        // documento de IBR é gerido no fluxo do IBR (zero retrocesso).
        editavel: poolIds.has(l.vigente.id),
      })),
    avisos: {
      faltantes,
      retificados,
    },
  });
});

// PUT /fechamento/regime — regime de fechamento da empresa (decisão por empresa).
// body: { companyId, regime: "contabil" | "gerencial" }
router.put("/regime", async (req: AuthRequest, res: Response): Promise<void> => {
  const { companyId, regime } = (req.body ?? {}) as Record<string, string | undefined>;
  if (!companyId) { res.status(400).json({ error: "companyId é obrigatório" }); return; }
  if (!regime || !REGIMES.includes(regime as RegimeFechamento)) {
    res.status(400).json({ error: `regime inválido — use: ${REGIMES.join(" | ")}` });
    return;
  }
  const company = await companyNoEscopo(companyId, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  const antes = (company as { regimeFechamento?: string }).regimeFechamento ?? "contabil";
  await prisma.company.update({ where: { id: companyId }, data: { regimeFechamento: regime } });
  await registrarAuditoria({
    userId: req.userId!, entity: "company", entityId: companyId, field: "regime de fechamento",
    before: { regime: antes }, after: { regime }, source: "fechamento",
  });
  res.json({ ok: true, regime });
});

// PUT /fechamento/documentos/:docId/competencia — corrige a competência de um
// documento DE POOL (esquecida no upload é o caso comum — sem isso o documento
// fica invisível na cadência sem conserto). Documento de IBR é recusado: a
// competência dele é gerida no fluxo do IBR (zero retrocesso).
// body: { companyId, competencia: "YYYY-MM" (mês) | "YYYY" (ano fechado) | "" (limpa) }
router.put("/documentos/:docId/competencia", async (req: AuthRequest, res: Response): Promise<void> => {
  const { companyId, competencia } = (req.body ?? {}) as Record<string, string | undefined>;
  if (!companyId) { res.status(400).json({ error: "companyId é obrigatório" }); return; }
  const limpa = competencia === "" || competencia === null || competencia === undefined;
  if (!limpa && !/^\d{4}(-\d{2})?$/.test(competencia!)) {
    res.status(400).json({ error: "competencia deve ser YYYY-MM (mês) ou YYYY (ano fechado) — ou vazia, para limpar" });
    return;
  }
  const company = await companyNoEscopo(companyId, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  const doc = await prisma.document.findFirst({ where: { id: req.params.docId as string, companyId } });
  if (!doc) { res.status(404).json({ error: "Documento não encontrado nesta empresa" }); return; }
  if (doc.analysisId) {
    res.status(409).json({ error: "Este documento pertence a um IBR — a competência dele é gerida lá (Documentos do IBR)." });
    return;
  }

  const antes = doc.competencia;
  await prisma.document.update({
    where: { id: doc.id },
    data: { competencia: limpa ? null : competencia },
  });
  // Fase B: a correção escorre para fixações ainda Pendentes deste documento.
  await propagarMetadadosDoPool(doc.id, { competencia: limpa ? null : competencia! });
  await registrarAuditoria({
    userId: req.userId!, entity: "document", entityId: doc.id, field: "competência do documento (pool)",
    before: { competencia: antes }, after: { competencia: limpa ? null : competencia }, source: "data-room",
  });
  res.json({ ok: true, competencia: limpa ? null : competencia });
});

// POST /fechamento/fechar — o ATO de fechar o período (autor + hora na trilha).
// body: { companyId, periodo: "YYYY-MM" }
router.post("/fechar", async (req: AuthRequest, res: Response): Promise<void> => {
  const { companyId, periodo } = (req.body ?? {}) as Record<string, string | undefined>;
  if (!companyId || !periodo || !RE_PERIODO.test(periodo)) {
    res.status(400).json({ error: "companyId e periodo (YYYY-MM ou YYYY) são obrigatórios" });
    return;
  }
  const company = await companyNoEscopo(companyId, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  const reg = await prisma.periodoEmpresa.findUnique({ where: { companyId_periodo: { companyId, periodo } } });
  const pode = podeFechar(reg);
  if (!pode.ok) { res.status(409).json({ error: pode.erro }); return; }

  const agora = new Date();
  await prisma.periodoEmpresa.upsert({
    where: { companyId_periodo: { companyId, periodo } },
    create: { companyId, periodo, fechadoEm: agora, fechadoPorId: req.userId! },
    update: { fechadoEm: agora, fechadoPorId: req.userId! },
  });
  await registrarAuditoria({
    userId: req.userId!, entity: "periodo_empresa", entityId: `${companyId}:${periodo}`,
    field: "fechamento do período", after: { periodo, fechadoEm: agora.toISOString() }, source: "fechamento",
  });
  res.json({ ok: true, periodo, estado: "fechado" });
});

// POST /fechamento/reabrir — reabertura é ato auditável COM MOTIVO, sempre.
// body: { companyId, periodo, motivo }
router.post("/reabrir", async (req: AuthRequest, res: Response): Promise<void> => {
  const { companyId, periodo, motivo } = (req.body ?? {}) as Record<string, string | undefined>;
  if (!companyId || !periodo || !RE_PERIODO.test(periodo)) {
    res.status(400).json({ error: "companyId e periodo (YYYY-MM ou YYYY) são obrigatórios" });
    return;
  }
  const company = await companyNoEscopo(companyId, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  const reg = await prisma.periodoEmpresa.findUnique({ where: { companyId_periodo: { companyId, periodo } } });
  const pode = podeReabrir(reg, motivo);
  if (!pode.ok) { res.status(409).json({ error: pode.erro }); return; }

  const agora = new Date();
  await prisma.periodoEmpresa.update({
    where: { companyId_periodo: { companyId, periodo } },
    data: { reabertoEm: agora, reabertoPorId: req.userId!, reabertoMotivo: motivo!.trim().slice(0, 300) },
  });
  await registrarAuditoria({
    userId: req.userId!, entity: "periodo_empresa", entityId: `${companyId}:${periodo}`,
    field: "reabertura do período", after: { periodo, reabertoEm: agora.toISOString() },
    reason: motivo!.trim().slice(0, 300), source: "fechamento",
  });
  res.json({ ok: true, periodo, estado: "recebido" });
});

export default router;
