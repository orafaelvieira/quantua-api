import { Router, Response } from "express";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { requireRole } from "../middleware/permissions";
import { getPeerDistribution } from "../services/peer-benchmark";
import { PEER_INDICATOR_MAP } from "../services/peer-indicator-map";

const router = Router();
router.use(requireAuth);
router.use(requireRole("partner")); // base de comparáveis = consulta interna (sócio)

// GET /peers/meta — opções de filtro + totais + data-base.
router.get("/meta", async (_req: AuthRequest, res: Response): Promise<void> => {
  const [classifs, setores, anos, totalEmpresas, totalLinhas] = await Promise.all([
    prisma.peerCompany.findMany({ distinct: ["classificacao"], select: { classificacao: true }, orderBy: { classificacao: "asc" } }),
    prisma.peerCompany.findMany({ distinct: ["setor"], select: { setor: true, classificacao: true }, orderBy: { setor: "asc" } }),
    prisma.peerLine.findMany({ distinct: ["year"], select: { year: true }, orderBy: { year: "desc" } }),
    prisma.peerCompany.count(),
    prisma.peerLine.count(),
  ]);
  res.json({
    classificacoes: classifs.map((c) => c.classificacao),
    setores: setores.map((s) => ({ setor: s.setor, classificacao: s.classificacao })),
    anos: anos.map((a) => a.year),
    indicadores: Object.keys(PEER_INDICATOR_MAP), // nomes NOSSOS que têm par
    indicadorParaConta: PEER_INDICATOR_MAP,
    totalEmpresas,
    totalLinhas,
  });
});

// GET /peers?classificacao=&setor=&search= — lista de empresas.
router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const { classificacao, setor, search } = req.query;
  const where: Record<string, unknown> = {};
  if (classificacao) where.classificacao = String(classificacao);
  if (setor) where.setor = String(setor);
  if (search) {
    const s = String(search);
    where.OR = [
      { nome: { contains: s, mode: "insensitive" } },
      { papel: { contains: s.toUpperCase() } },
    ];
  }
  const empresas = await prisma.peerCompany.findMany({
    where,
    orderBy: [{ classificacao: "asc" }, { setor: "asc" }, { nome: "asc" }],
  });
  res.json(empresas);
});

// GET /peers/:papel/indicators — matriz indicador × ano (só os indicadores com par nosso).
router.get("/:papel/indicators", async (req: AuthRequest, res: Response): Promise<void> => {
  const papel = String(req.params.papel);
  const company = await prisma.peerCompany.findUnique({ where: { papel } });
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  const contas = Object.values(PEER_INDICATOR_MAP);
  const lines = await prisma.peerLine.findMany({
    where: { papel, documento: "INDICADOR", conta: { in: contas } },
    select: { conta: true, year: true, value: true },
    orderBy: [{ conta: "asc" }, { year: "asc" }],
  });
  res.json({ company, lines });
});

// GET /peers/distribution?conta=&year=&setor=&classificacao= — distribuição (mediana/quartis)
// com o fallback em camadas. Para a aba "Distribuição por setor".
router.get("/distribution", async (req: AuthRequest, res: Response): Promise<void> => {
  const conta = String(req.query.conta ?? "");
  const year = Number(req.query.year);
  const setor = req.query.setor ? String(req.query.setor) : null;
  const classificacao = req.query.classificacao ? String(req.query.classificacao) : null;
  if (!conta || !Number.isFinite(year)) { res.status(400).json({ error: "conta e year são obrigatórios" }); return; }
  const dist = await getPeerDistribution({ setor, classificacao }, conta, year);
  res.json(dist);
});

export default router;
