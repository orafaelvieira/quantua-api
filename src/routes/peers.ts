import { Router, Response } from "express";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { requireRole } from "../middleware/permissions";
import { getPeerDistribution } from "../services/peer-benchmark";
import { PEER_INDICATOR_MAP } from "../services/peer-indicator-map";
import { sincronizarCvm, sincronizarHistoricoCvm, getProgressoHistorico, planoHistorico, checarAtualizacoesCvm, arquivosVigiados } from "../services/cvm-sync";

const router = Router();
router.use(requireAuth);
router.use(requireRole("partner")); // base de comparáveis = consulta interna (sócio)

/* ───────── Fonte CVM (dados abertos) — sincronização server-side ───────── */

// GET /peers/cvm/status — estado por arquivo vigiado + totais da base CVM.
router.get("/cvm/status", async (_req: AuthRequest, res: Response): Promise<void> => {
  const [estados, empresas, periodos, indicadores, avisos] = await Promise.all([
    prisma.cvmSyncState.findMany({ orderBy: { arquivo: "asc" } }),
    prisma.cvmCompany.count(),
    prisma.cvmPeriod.count(),
    prisma.cvmIndicator.count(),
    prisma.systemNotice.findMany({ where: { tipo: "cvm_update", lida: false }, orderBy: { createdAt: "desc" } }),
  ]);
  res.json({
    vigiados: arquivosVigiados().map(({ tipo, ano }) => `${tipo}_${ano}`),
    estados,
    totais: { empresas, periodos, indicadores },
    avisos,
    historico: { ...getProgressoHistorico(), planoTotal: planoHistorico().length },
  });
});

// POST /peers/cvm/sync-historico — seed completo (DFP 2010 + ITR 2011 → hoje),
// intercalado por ano, em background NO SERVIDOR. Retomável (pula o que já foi
// processado). O painel acompanha o progresso pelo GET /status.
router.post("/cvm/sync-historico", async (_req: AuthRequest, res: Response): Promise<void> => {
  const prog = getProgressoHistorico();
  if (prog.emAndamento) { res.status(409).json({ error: "Sincronização do histórico já em andamento" }); return; }
  sincronizarHistoricoCvm().catch((e) => console.error("[peers/cvm/sync-historico] falhou:", e));
  res.status(202).json({ ok: true, total: planoHistorico().length });
});

// POST /peers/cvm/sync { tipo: "itr"|"dfp", ano } — baixa da CVM NO SERVIDOR e processa.
// Operação longa (download + ~600 empresas) — o frontend usa timeout estendido.
router.post("/cvm/sync", async (req: AuthRequest, res: Response): Promise<void> => {
  const tipo = req.body?.tipo === "dfp" ? "dfp" : "itr";
  const ano = parseInt(String(req.body?.ano ?? new Date().getUTCFullYear()), 10);
  if (!Number.isFinite(ano) || ano < 2010 || ano > 2100) { res.status(400).json({ error: "ano inválido" }); return; }
  if (getProgressoHistorico().emAndamento) { res.status(409).json({ error: "Aguarde a sincronização do histórico terminar" }); return; }
  try {
    const resultado = await sincronizarCvm(tipo, ano);
    // Sincronizou → avisos desta fonte deixam de ser pendência.
    await prisma.systemNotice.updateMany({
      where: { tipo: "cvm_update", chave: { startsWith: `cvm:${tipo}_${ano}:` }, lida: false },
      data: { lida: true },
    });
    res.json({ ok: true, ...resultado });
  } catch (e) {
    console.error("[peers/cvm/sync] falhou:", e);
    res.status(502).json({ error: e instanceof Error ? e.message : "Falha ao sincronizar com a CVM" });
  }
});

// POST /peers/cvm/check — checagem manual imediata (mesma rotina do cron semanal).
router.post("/cvm/check", async (_req: AuthRequest, res: Response): Promise<void> => {
  const resultados = await checarAtualizacoesCvm();
  res.json({ resultados });
});

// GET /peers/meta — opções de filtro + totais + data-base.
router.get("/meta", async (_req: AuthRequest, res: Response): Promise<void> => {
  const [classifs, setores, subsetores, anos, totalEmpresas, totalLinhas] = await Promise.all([
    prisma.peerCompany.findMany({ distinct: ["classificacao"], select: { classificacao: true }, orderBy: { classificacao: "asc" } }),
    prisma.peerCompany.findMany({ distinct: ["setor"], select: { setor: true, classificacao: true }, orderBy: { setor: "asc" } }),
    prisma.peerCompany.findMany({ where: { subsetor: { not: null } }, distinct: ["subsetor"], select: { subsetor: true, setor: true, classificacao: true }, orderBy: { subsetor: "asc" } }),
    prisma.peerLine.findMany({ distinct: ["year"], select: { year: true }, orderBy: { year: "desc" } }),
    prisma.peerCompany.count(),
    prisma.peerLine.count(),
  ]);
  res.json({
    classificacoes: classifs.map((c) => c.classificacao),
    setores: setores.map((s) => ({ setor: s.setor, classificacao: s.classificacao })),
    subsetores: subsetores.map((s) => ({ subsetor: s.subsetor, setor: s.setor, classificacao: s.classificacao })),
    anos: anos.map((a) => a.year),
    indicadores: Object.keys(PEER_INDICATOR_MAP), // nomes NOSSOS que têm par
    indicadorParaConta: PEER_INDICATOR_MAP,
    totalEmpresas,
    totalLinhas,
  });
});

// GET /peers?classificacao=&setor=&search= — lista de empresas.
router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const { classificacao, setor, subsetor, search } = req.query;
  const where: Record<string, unknown> = {};
  if (classificacao) where.classificacao = String(classificacao);
  if (setor) where.setor = String(setor);
  if (subsetor) where.subsetor = String(subsetor);
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

// GET /peers/distribution?conta=&year=&subsetor=&setor=&classificacao= — distribuição
// (mediana/quartis) com fallback em camadas (subsetor→setor→classificação→mercado).
router.get("/distribution", async (req: AuthRequest, res: Response): Promise<void> => {
  const conta = String(req.query.conta ?? "");
  const year = Number(req.query.year);
  const subsetor = req.query.subsetor ? String(req.query.subsetor) : null;
  const setor = req.query.setor ? String(req.query.setor) : null;
  const classificacao = req.query.classificacao ? String(req.query.classificacao) : null;
  if (!conta || !Number.isFinite(year)) { res.status(400).json({ error: "conta e year são obrigatórios" }); return; }
  const dist = await getPeerDistribution({ subsetor, setor, classificacao }, conta, year);
  res.json(dist);
});

// GET /peers/indicators-export?classificacao=&setor=&subsetor= — dados achatados dos
// indicadores (com par) p/ download CSV no front. Long format: 1 linha por empresa×indicador×ano.
router.get("/indicators-export", async (req: AuthRequest, res: Response): Promise<void> => {
  const { classificacao, setor, subsetor } = req.query;
  const companyWhere: Record<string, unknown> = {};
  if (classificacao) companyWhere.classificacao = String(classificacao);
  if (setor) companyWhere.setor = String(setor);
  if (subsetor) companyWhere.subsetor = String(subsetor);

  const contaParaInd = Object.fromEntries(Object.entries(PEER_INDICATOR_MAP).map(([ind, conta]) => [conta, ind]));
  const empresas = await prisma.peerCompany.findMany({
    where: companyWhere,
    select: { papel: true, nome: true, classificacao: true, setor: true, subsetor: true },
    orderBy: [{ classificacao: "asc" }, { setor: "asc" }, { nome: "asc" }],
  });
  const papeis = empresas.map((e) => e.papel);
  const compByPapel = new Map(empresas.map((e) => [e.papel, e]));
  const lines = await prisma.peerLine.findMany({
    where: { papel: { in: papeis }, documento: "INDICADOR", conta: { in: Object.values(PEER_INDICATOR_MAP) } },
    select: { papel: true, conta: true, year: true, value: true },
  });
  const rows = lines.map((l) => {
    const c = compByPapel.get(l.papel)!;
    return {
      papel: l.papel, nome: c.nome, classificacao: c.classificacao, setor: c.setor, subsetor: c.subsetor,
      indicador: contaParaInd[l.conta] ?? l.conta, ano: l.year, valor: l.value,
    };
  });
  res.json({ rows });
});

export default router;
