import { Router, Response } from "express";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

// GET /standard-models — modelos padrão BP e DRE VIGENTES (ativo=true), com as linhas
// ordenadas. Base da tela de governança dos modelos (somente leitura por enquanto).
router.get("/", async (_req: AuthRequest, res: Response): Promise<void> => {
  const models = await prisma.standardModel.findMany({
    where: { ativo: true },
    include: { linhas: { orderBy: { ordem: "asc" } } },
  });
  const pick = (tipo: string) => {
    const m = models.find((x) => x.tipo === tipo);
    if (!m) return null;
    return {
      id: m.id,
      tipo: m.tipo,
      versao: m.versao,
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
      })),
    };
  };
  res.json({ bp: pick("BP"), dre: pick("DRE") });
});

// Só partner (ou role nula — contas-fundador no período de graça) edita os modelos.
// Operador/revisor/cliente só visualizam (afeta todas as análises futuras).
async function podeEditar(userId?: string): Promise<boolean> {
  if (!userId) return false;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!u) return false;
  return u.role === "partner" || u.role === null;
}

function slugify(nome: string): string {
  return nome
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "conta";
}

interface LinhaInput {
  codigo?: string; nome: string; grupo?: string; ordem?: number;
  tipo?: string; nivel?: number; sinal?: number | null;
}

// POST /standard-models/:tipo/versions — publica uma NOVA versão (rascunho → publicar).
// A versão vigente anterior é preservada (ativo=false) para auditoria e pinagem.
router.post("/:tipo/versions", async (req: AuthRequest, res: Response): Promise<void> => {
  const tipo = String(req.params.tipo).toUpperCase();
  if (tipo !== "BP" && tipo !== "DRE") { res.status(400).json({ error: "Tipo inválido (use BP ou DRE)" }); return; }
  if (!(await podeEditar(req.userId))) { res.status(403).json({ error: "Apenas partner pode editar os modelos padrão" }); return; }

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
    };
  });

  if (linhas.some((l) => !l.nome)) { res.status(400).json({ error: "Há contas sem nome" }); return; }

  // PROTEÇÃO DO ESQUELETO: nenhum subtotal/total da versão vigente pode sumir (por código).
  // Renomear o rótulo é permitido; remover/trocar o código não — a cascata depende dele.
  const vigente = await prisma.standardModel.findFirst({
    where: { tipo, ativo: true }, include: { linhas: true },
  });
  if (vigente) {
    const esqueletoAtual = vigente.linhas.filter((l) => l.tipo !== "input").map((l) => l.codigo);
    const novos = new Set(linhas.map((l) => l.codigo));
    const faltando = esqueletoAtual.filter((c) => !novos.has(c));
    if (faltando.length) {
      res.status(400).json({ error: `Subtotais/totais não podem ser removidos: ${faltando.join(", ")}` });
      return;
    }
  }

  const proxVersao = ((await prisma.standardModel.aggregate({ where: { tipo }, _max: { versao: true } }))._max.versao ?? 0) + 1;

  const criado = await prisma.$transaction(async (tx) => {
    await tx.standardModel.updateMany({ where: { tipo, ativo: true }, data: { ativo: false } });
    return tx.standardModel.create({
      data: {
        tipo, versao: proxVersao, ativo: true, nota,
        criadoPor: req.userId ?? null,
        linhas: { create: linhas },
      },
      include: { linhas: { orderBy: { ordem: "asc" } } },
    });
  });

  res.json({ ok: true, versao: criado.versao, totalLinhas: criado.linhas.length });
});

export default router;
