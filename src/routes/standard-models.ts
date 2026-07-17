import { Router, Response } from "express";
import { prisma } from "../db/client";
import { requireAuth, requireInternal, AuthRequest } from "../middleware/auth";
import { whereEmpresaVisivel } from "../services/escopo-empresa";

const router = Router();
router.use(requireAuth);
// Modelos padrão são ativo interno da firma — cliente de portal não lê nem lista.
router.use(requireInternal);

// ── ESCOPO POR EMPRESA (2026-07-17) ──────────────────────────────────────────
// companyId null = modelo GLOBAL (padrão Quantua, herdado por toda empresa nova).
// companyId preenchido = modelo PRÓPRIO da empresa (copy-on-write): a 1ª versão
// da empresa nasce da cópia do global vigente + edições; dali em diante os IBRs
// daquela empresa usam o modelo dela e os demais seguem no global.

/** Valida que a empresa pertence ao escopo do usuário; devolve o id ou null. */
async function companyNoEscopo(req: AuthRequest): Promise<string | null | "negada"> {
  const raw = req.query.companyId ?? req.body?.companyId;
  const companyId = typeof raw === "string" && raw ? raw : null;
  if (!companyId) return null;
  const c = await prisma.company.findFirst({ where: { id: companyId, ...whereEmpresaVisivel(req) }, select: { id: true } });
  return c ? c.id : "negada";
}

// GET /standard-models?companyId= — modelos VIGENTES efetivos (empresa ?? global),
// com o escopo de onde cada um veio. Sem companyId: global puro (como sempre).
router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const companyId = await companyNoEscopo(req);
  if (companyId === "negada") { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  const models = await prisma.standardModel.findMany({
    where: { ativo: true, OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])] },
    include: { linhas: { orderBy: { ordem: "asc" } } },
  });
  const pick = (tipo: string) => {
    const daEmpresa = companyId ? models.find((x) => x.tipo === tipo && x.companyId === companyId) : undefined;
    const m = daEmpresa ?? models.find((x) => x.tipo === tipo && x.companyId === null);
    if (!m) return null;
    return {
      id: m.id,
      tipo: m.tipo,
      versao: m.versao,
      escopo: m.companyId ? "empresa" : "global",
      nota: m.nota,
      criadoEm: m.createdAt,
      linhas: m.linhas.map((l) => ({
        codigo: l.codigo,
        nome: l.nome,
        grupo: l.grupo,
        ordem: l.ordem,
        tipo: l.tipo,
        nivel: l.nivel,
        sinal: l.sinal,
        descricao: l.descricao,
      })),
    };
  };
  res.json({ bp: pick("BP"), dre: pick("DRE") });
});

// Só partner (ou role nula — contas-fundador no período de graça) edita os modelos.
// Operador/revisor/cliente só visualizam (afeta todas as análises futuras).
async function podeEditar(userId?: string): Promise<boolean> {
  if (!userId) return false;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, tipoUsuario: true } });
  if (!u) return false;
  // F2 SaaS: usuário EXTERNO nunca edita o modelo GLOBAL — role null era o
  // período de graça dos fundadores e não pode valer para tipoUsuario externo.
  if (u.tipoUsuario === "empresa" || u.tipoUsuario === "parceiro") return false;
  return u.role === "partner" || u.role === null;
}

function slugify(nome: string): string {
  return nome
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "conta";
}

interface LinhaInput {
  codigo?: string; nome: string; grupo?: string; ordem?: number;
  tipo?: string; nivel?: number; sinal?: number | null; descricao?: string | null;
}

// CONTAS-ÂNCORA DO MOTOR (2026-07-17): o valuation, os indicadores e o fluxo de
// caixa indireto ancoram POR NOME nestas linhas de input (caixa da data-base,
// dívida implícita, PMR/PME/PMP, capex/D&A, folha na linha canônica…). Remover
// ou renomear uma âncora quebraria esses produtos EM SILÊNCIO — bloqueado em
// QUALQUER escopo (global e empresa). Adicionar/renomear as demais linhas é livre.
const CONTAS_ANCORA: Record<string, string[]> = {
  BP: [
    "Caixa e Equivalentes de Caixa",
    "Contas a Receber - CP",
    "Estoques - CP",
    "Fornecedores - CP",
    "Empréstimos e Financiamentos - CP",
    "Empréstimos e Financiamentos - LP",
    "Imobilizado",
    "(-) Depreciação",
    "Intangível",
    "(-) Amortização",
  ],
  DRE: [
    "Receita Bruta",
    "Deduções da Receita Bruta",
    "Impostos s/ Faturamento",
    "Custo Operacional",
    "Despesas com Pessoas",
    "Outras Receitas Operacionais",
    "Outras Despesas Operacionais",
    "Depreciação e Amortização",
    "Receitas Financeiras",
    "Despesas Financeiras",
    "Outras Receitas Não Operacionais",
    "Outras Despesas Não Operacionais",
    "IR e CSLL",
  ],
};
const normAncora = (s: string): string => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

// POST /standard-models/:tipo/versions — publica uma NOVA versão (rascunho → publicar).
// Com companyId (body): versão da EMPRESA (copy-on-write) — só os IBRs dela mudam.
// A versão vigente anterior do MESMO escopo é preservada (ativo=false) para auditoria.
router.post("/:tipo/versions", async (req: AuthRequest, res: Response): Promise<void> => {
  const tipo = String(req.params.tipo).toUpperCase();
  if (tipo !== "BP" && tipo !== "DRE") { res.status(400).json({ error: "Tipo inválido (use BP ou DRE)" }); return; }
  const companyId = await companyNoEscopo(req);
  if (companyId === "negada") { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  // Gate por ESCOPO (2026-07-17): o modelo GLOBAL segue só-partner (afeta toda
  // empresa nova). O modelo DA EMPRESA pode ser editado por qualquer usuário
  // com a empresa no escopo (requireInternal já barrou o portal) — a mudança
  // vale só para os IBRs dela, então o risco fica contido.
  if (!companyId && !(await podeEditar(req.userId))) { res.status(403).json({ error: "Apenas partner pode editar o modelo padrão GLOBAL" }); return; }

  const linhasIn: LinhaInput[] = Array.isArray(req.body?.linhas) ? req.body.linhas : [];
  const nota: string | null = typeof req.body?.nota === "string" ? req.body.nota.trim() || null : null;
  if (linhasIn.length === 0) { res.status(400).json({ error: "Modelo sem linhas" }); return; }

  // Normaliza: gera código para linhas novas, garante unicidade.
  const usados = new Set<string>();
  const linhas = linhasIn.map((l, i) => {
    let codigo = (l.codigo || slugify(l.nome)).trim();
    if (!codigo) codigo = `conta-${i}`;
    let c = codigo, n = 2;
    while (usados.has(c)) c = `${codigo}-${n++}`;
    usados.add(c);
    const tipoLinha = l.tipo === "subtotal" || l.tipo === "total" ? l.tipo : "input";
    return {
      codigo: c,
      nome: String(l.nome || "").trim(),
      grupo: String(l.grupo || ""),
      ordem: i,
      tipo: tipoLinha,
      nivel: typeof l.nivel === "number" ? l.nivel : tipoLinha === "input" ? 2 : 1,
      sinal: typeof l.sinal === "number" ? l.sinal : null,
      descricao: typeof l.descricao === "string" && l.descricao.trim() ? l.descricao.trim() : null,
    };
  });

  if (linhas.some((l) => !l.nome)) { res.status(400).json({ error: "Há contas sem nome" }); return; }

  // PROTEÇÃO DO ESQUELETO: nenhum subtotal/total do modelo EFETIVO atual (empresa ??
  // global) pode sumir (por código). Renomear o rótulo é permitido; remover/trocar o
  // código não — a cascata depende dele.
  const vigente = (companyId
    ? await prisma.standardModel.findFirst({ where: { tipo, ativo: true, companyId }, include: { linhas: true } })
    : null)
    ?? await prisma.standardModel.findFirst({ where: { tipo, ativo: true, companyId: null }, include: { linhas: true } });
  if (vigente) {
    const esqueletoAtual = vigente.linhas.filter((l) => l.tipo !== "input").map((l) => l.codigo);
    const novos = new Set(linhas.map((l) => l.codigo));
    const faltando = esqueletoAtual.filter((c) => !novos.has(c));
    if (faltando.length) {
      res.status(400).json({ error: `Subtotais/totais não podem ser removidos: ${faltando.join(", ")}` });
      return;
    }
  }

  // PROTEÇÃO DAS ÂNCORAS: toda conta-âncora precisa continuar existindo POR NOME.
  const nomesNovos = new Set(linhas.map((l) => normAncora(l.nome)));
  const ancorasFaltando = (CONTAS_ANCORA[tipo] ?? []).filter((a) => !nomesNovos.has(normAncora(a)));
  if (ancorasFaltando.length) {
    res.status(400).json({
      error: `Estas contas são âncoras do motor (valuation, indicadores, fluxo de caixa) e não podem ser removidas nem renomeadas: ${ancorasFaltando.join(" · ")}. Adicione novas linhas ou renomeie as demais à vontade.`,
    });
    return;
  }

  // Sequência de versão POR ESCOPO (global e cada empresa contam separado).
  const proxVersao = ((await prisma.standardModel.aggregate({ where: { tipo, companyId }, _max: { versao: true } }))._max.versao ?? 0) + 1;

  const criado = await prisma.$transaction(async (tx) => {
    await tx.standardModel.updateMany({ where: { tipo, ativo: true, companyId }, data: { ativo: false } });
    return tx.standardModel.create({
      data: {
        tipo, versao: proxVersao, ativo: true, nota, companyId,
        criadoPor: req.userId ?? null,
        linhas: { create: linhas },
      },
      include: { linhas: { orderBy: { ordem: "asc" } } },
    });
  });

  res.json({ ok: true, versao: criado.versao, escopo: companyId ? "empresa" : "global", totalLinhas: criado.linhas.length });
});

// GET /standard-models/:tipo/versions?companyId= — histórico do ESCOPO pedido
// (empresa ou global), mais nova primeiro.
router.get("/:tipo/versions", async (req: AuthRequest, res: Response): Promise<void> => {
  const tipo = String(req.params.tipo).toUpperCase();
  if (tipo !== "BP" && tipo !== "DRE") { res.status(400).json({ error: "Tipo inválido" }); return; }
  const companyId = await companyNoEscopo(req);
  if (companyId === "negada") { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  const versoes = await prisma.standardModel.findMany({
    where: { tipo, companyId },
    orderBy: { versao: "desc" },
    select: { versao: true, ativo: true, nota: true, criadoPor: true, createdAt: true, _count: { select: { linhas: true } } },
  });
  res.json(versoes.map((v) => ({
    versao: v.versao, ativo: v.ativo, nota: v.nota, criadoPor: v.criadoPor,
    criadoEm: v.createdAt, totalLinhas: v._count.linhas,
  })));
});

// GET /standard-models/:tipo/versions/:versao?companyId= — estrutura completa de UMA
// versão (histórica ou vigente) do escopo pedido.
router.get("/:tipo/versions/:versao", async (req: AuthRequest, res: Response): Promise<void> => {
  const tipo = String(req.params.tipo).toUpperCase();
  const versao = parseInt(String(req.params.versao), 10);
  if ((tipo !== "BP" && tipo !== "DRE") || !Number.isFinite(versao)) { res.status(400).json({ error: "Parâmetros inválidos" }); return; }
  const companyId = await companyNoEscopo(req);
  if (companyId === "negada") { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  const m = await prisma.standardModel.findFirst({
    where: { tipo, versao, companyId }, include: { linhas: { orderBy: { ordem: "asc" } } },
  });
  if (!m) { res.status(404).json({ error: "Versão não encontrada" }); return; }
  res.json({
    id: m.id, tipo: m.tipo, versao: m.versao, ativo: m.ativo, nota: m.nota, criadoEm: m.createdAt,
    escopo: m.companyId ? "empresa" : "global",
    linhas: m.linhas.map((l) => ({ codigo: l.codigo, nome: l.nome, grupo: l.grupo, ordem: l.ordem, tipo: l.tipo, nivel: l.nivel, sinal: l.sinal })),
  });
});

export default router;
