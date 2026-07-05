import { Router, Response } from "express";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { requireRole } from "../middleware/permissions";
import { getPeerDistribution } from "../services/peer-benchmark";
import { PEER_INDICATOR_MAP } from "../services/peer-indicator-map";
import { sincronizarCvm, sincronizarHistoricoCvm, recalcularIndicadoresTudo, getProgressoHistorico, estadoHistorico, planoHistorico, checarAtualizacoesCvm, arquivosVigiados } from "../services/cvm-sync";
import { runtimeState } from "../services/runtime-state";

const router = Router();
router.use(requireAuth);
router.use(requireRole("partner")); // base de comparáveis = consulta interna (sócio)

/* ───────── Fonte CVM (dados abertos) — sincronização server-side ───────── */

// GET /peers/cvm/status — estado por arquivo vigiado + totais da base CVM.
router.get("/cvm/status", async (_req: AuthRequest, res: Response): Promise<void> => {
  const [estados, empresas, periodos, indicadores, avisos, historico] = await Promise.all([
    // "_historico" é a linha-reservada do snapshot de progresso, não um arquivo da CVM
    prisma.cvmSyncState.findMany({ where: { arquivo: { not: "_historico" } }, orderBy: { arquivo: "asc" } }),
    prisma.cvmCompany.count(),
    prisma.cvmPeriod.count(),
    prisma.cvmIndicator.count(),
    prisma.systemNotice.findMany({ where: { tipo: "cvm_update", lida: false }, orderBy: { createdAt: "desc" } }),
    estadoHistorico(),
  ]);
  res.json({
    vigiados: arquivosVigiados().map(({ tipo, ano }) => `${tipo}_${ano}`),
    estados,
    totais: { empresas, periodos, indicadores },
    avisos,
    historico: { ...historico, planoTotal: planoHistorico().length },
    seedsRodando: runtimeState.seedsRodando,
  });
});

// POST /peers/cvm/sync-historico — seed completo (DFP 2010 + ITR 2011 → hoje),
// intercalado por ano, em background NO SERVIDOR. Retomável (pula o que já foi
// processado). O painel acompanha o progresso pelo GET /status.
router.post("/cvm/sync-historico", async (req: AuthRequest, res: Response): Promise<void> => {
  const prog = getProgressoHistorico();
  if (prog.emAndamento) { res.status(409).json({ error: "Sincronização do histórico já em andamento" }); return; }
  if (runtimeState.seedsRodando) { res.status(409).json({ error: "O servidor acabou de reiniciar e está carregando os dados de boot (~2 min). Tente de novo em instantes." }); return; }
  const reprocessar = req.body?.reprocessar === true; // recalibração: re-roda TODOS os arquivos
  sincronizarHistoricoCvm(reprocessar).catch((e) => console.error("[peers/cvm/sync-historico] falhou:", e));
  res.status(202).json({ ok: true, total: planoHistorico().length, reprocessar });
});

// POST /peers/cvm/sync { tipo: "itr"|"dfp", ano } — baixa da CVM NO SERVIDOR e processa.
// Operação longa (download + ~600 empresas) — o frontend usa timeout estendido.
router.post("/cvm/sync", async (req: AuthRequest, res: Response): Promise<void> => {
  const tipo = req.body?.tipo === "dfp" ? "dfp" : "itr";
  const ano = parseInt(String(req.body?.ano ?? new Date().getUTCFullYear()), 10);
  if (!Number.isFinite(ano) || ano < 2010 || ano > 2100) { res.status(400).json({ error: "ano inválido" }); return; }
  if (getProgressoHistorico().emAndamento) { res.status(409).json({ error: "Aguarde a sincronização do histórico terminar" }); return; }
  if (runtimeState.seedsRodando) { res.status(409).json({ error: "O servidor acabou de reiniciar e está carregando os dados de boot (~2 min). Tente de novo em instantes." }); return; }
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

// POST /peers/cvm/recalcular — recálculo geral de indicadores a partir dos períodos
// já persistidos (erro de FÓRMULA; sem download/parse, ~20-30 min, mesmo progresso).
router.post("/cvm/recalcular", async (_req: AuthRequest, res: Response): Promise<void> => {
  if (getProgressoHistorico().emAndamento) { res.status(409).json({ error: "Já há um processamento em andamento" }); return; }
  if (runtimeState.seedsRodando) { res.status(409).json({ error: "O servidor acabou de reiniciar e está carregando os dados de boot (~2 min). Tente de novo em instantes." }); return; }
  recalcularIndicadoresTudo().catch((e) => console.error("[peers/cvm/recalcular] falhou:", e));
  res.status(202).json({ ok: true });
});

// POST /peers/cvm/setores — enriquece as empresas CVM com ticker + taxonomia B3
// (join exato código↔CNPJ via API de listadas da B3 + ClassifSetorial oficial).
router.post("/cvm/setores", async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { atualizarSetoresCvm } = await import("../services/b3-empresas");
    const resultado = await atualizarSetoresCvm();
    metaEstudoCache = null; // os dropdowns de estudo devem refletir a taxonomia nova já
    res.json(resultado);
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : "Falha ao consultar a B3" });
  }
});

// GET /peers/cvm/estudo/meta — opções p/ o painel de estudos (indicadores/períodos/setores).
let metaEstudoCache: { em: number; dados: object } | null = null;
router.get("/cvm/estudo/meta", async (_req: AuthRequest, res: Response): Promise<void> => {
  if (metaEstudoCache && Date.now() - metaEstudoCache.em < 10 * 60_000) { res.json(metaEstudoCache.dados); return; }
  const [nomes, dts, classifs] = await Promise.all([
    prisma.cvmIndicator.findMany({ where: { visao: "ANO" }, distinct: ["nome"], select: { nome: true } }),
    prisma.cvmPeriod.findMany({ distinct: ["dtFim"], select: { dtFim: true }, orderBy: { dtFim: "desc" } }),
    prisma.cvmCompany.findMany({ where: { classificacao: { not: null } }, distinct: ["classificacao", "setor", "subsetor"], select: { classificacao: true, setor: true, subsetor: true } }),
  ]);
  const dados = {
    indicadores: nomes.map((n) => n.nome).sort(),
    periodos: dts.map((d) => d.dtFim.toISOString().slice(0, 10)),
    // árvore da taxonomia B3 p/ a cascata Classificação → Setor → Subsetor
    arvore: classifs.map((c) => ({ classificacao: c.classificacao, setor: c.setor, subsetor: c.subsetor })),
  };
  metaEstudoCache = { em: Date.now(), dados };
  res.json(dados);
});

// GET /peers/cvm/estudo — ranking + distribuição de um indicador na base CVM.
// ?nome=&visao=TRI|ANO|LTM&dtFim=AAAA-MM-DD&classificacao=&setor=&ordem=desc&limite=50
router.get("/cvm/estudo", async (req: AuthRequest, res: Response): Promise<void> => {
  const nome = String(req.query.nome ?? "");
  const visao = ["TRI", "ANO", "LTM"].includes(String(req.query.visao)) ? String(req.query.visao) : "LTM";
  const dtFim = String(req.query.dtFim ?? "");
  if (!nome || !/^\d{4}-\d{2}-\d{2}$/.test(dtFim)) { res.status(400).json({ error: "nome e dtFim são obrigatórios" }); return; }
  const classificacao = req.query.classificacao ? String(req.query.classificacao) : null;
  const setor = req.query.setor ? String(req.query.setor) : null;
  const subsetor = req.query.subsetor ? String(req.query.subsetor) : null;
  const ordem = req.query.ordem === "asc" ? "asc" : "desc";
  const limite = Math.min(2000, Math.max(5, parseInt(String(req.query.limite ?? "50"), 10) || 50)); // 2000 = export completo

  const linhas = await prisma.cvmIndicator.findMany({
    where: {
      nome, visao, dtFim: new Date(`${dtFim}T00:00:00Z`), valor: { not: null },
      company: {
        ...(classificacao ? { classificacao } : {}),
        ...(setor ? { setor } : {}),
        ...(subsetor ? { subsetor } : {}),
        // "listadas=1": só negociadas na B3 (com ticker). Não listadas também são
        // OFICIAIS (capital aberto presta contas à CVM igual) — o usuário escolhe.
        ...(req.query.listadas === "1" ? { ticker: { not: null } } : {}),
      },
    },
    include: { company: { select: { denom: true, ticker: true, pregao: true, classificacao: true, setor: true } } },
  });
  const valores = linhas.map((l) => l.valor as number).sort((a, b) => a - b);
  const q = (p: number) => valores.length ? valores[Math.min(valores.length - 1, Math.floor(p * (valores.length - 1)))] : null;
  linhas.sort((a, b) => (ordem === "desc" ? (b.valor as number) - (a.valor as number) : (a.valor as number) - (b.valor as number)));
  res.json({
    n: valores.length,
    distribuicao: { p25: q(0.25), p50: q(0.5), p75: q(0.75), min: valores[0] ?? null, max: valores[valores.length - 1] ?? null },
    ranking: linhas.slice(0, limite).map((l, i) => ({
      posicao: i + 1, empresa: l.company.pregao ?? l.company.denom, ticker: l.company.ticker,
      classificacao: l.company.classificacao, setor: l.company.setor, valor: l.valor,
    })),
  });
});

// GET /peers/cvm/empresas?search=&classificacao=&setor=&subsetor=&all=1 — picker/diretório.
// Filtros de taxonomia (classificacao/setor/subsetor) combinam em AND com a busca e com all=1.
router.get("/cvm/empresas", async (req: AuthRequest, res: Response): Promise<void> => {
  const s = String(req.query.search ?? "").trim();
  const todas = req.query.all === "1"; // lista completa p/ o dropdown com filtro client-side
  const classificacao = req.query.classificacao ? String(req.query.classificacao) : null;
  const setor = req.query.setor ? String(req.query.setor) : null;
  const subsetor = req.query.subsetor ? String(req.query.subsetor) : null;
  if (!todas && s.length < 2) { res.json([]); return; }
  const taxonomia = {
    ...(classificacao ? { classificacao } : {}),
    ...(setor ? { setor } : {}),
    ...(subsetor ? { subsetor } : {}),
  };
  const busca = todas ? {} : { OR: [{ denom: { contains: s, mode: "insensitive" as const } }, { pregao: { contains: s, mode: "insensitive" as const } }, { ticker: { contains: s.toUpperCase() } }] };
  const empresas = await prisma.cvmCompany.findMany({
    where: { ...taxonomia, ...busca },
    select: { cnpj: true, denom: true, ticker: true, pregao: true, classificacao: true, setor: true, subsetor: true },
    orderBy: { denom: "asc" },
    ...(todas ? {} : { take: 20 }),
  });
  res.json(empresas);
});

// GET /peers/cvm/matriz?cnpj=&visao= — matriz indicador × período de UMA empresa
// (todos os dtFims da visão, DESC, no máx 12). Só leitura; prova de auditoria multi-período.
router.get("/cvm/matriz", async (req: AuthRequest, res: Response): Promise<void> => {
  const cnpj = String(req.query.cnpj ?? "").replace(/[^\d]/g, "");
  const visao = ["TRI", "ANO", "LTM"].includes(String(req.query.visao)) ? String(req.query.visao) : "LTM";
  if (cnpj.length !== 14) { res.status(400).json({ error: "cnpj é obrigatório" }); return; }
  const [cadastro, indicadores] = await Promise.all([
    prisma.cvmCompany.findUnique({ where: { cnpj }, select: { denom: true, ticker: true, pregao: true, classificacao: true, setor: true, subsetor: true } }),
    prisma.cvmIndicator.findMany({
      where: { cnpj, visao },
      select: { dtFim: true, nome: true, valor: true, texto: true },
      orderBy: { dtFim: "desc" },
    }),
  ]);
  if (!cadastro) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  // Períodos DESC, no máx 12 (os mais recentes).
  const periodos = [...new Set(indicadores.map((i) => i.dtFim.toISOString().slice(0, 10)))]
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, 12);
  const periodoSet = new Set(periodos);
  // Agrupa por nome do indicador; valores/texto por dtFim.
  const porNome = new Map<string, { valores: Record<string, number | null>; texto: Record<string, string | null> }>();
  for (const ind of indicadores) {
    const dt = ind.dtFim.toISOString().slice(0, 10);
    if (!periodoSet.has(dt)) continue;
    let linha = porNome.get(ind.nome);
    if (!linha) { linha = { valores: {}, texto: {} }; porNome.set(ind.nome, linha); }
    linha.valores[dt] = ind.valor ?? null;
    linha.texto[dt] = ind.texto ?? null;
  }
  const linhas = [...porNome.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "pt-BR"))
    .map(([nome, { valores, texto }]) => ({ nome, valores, texto }));
  res.json({ empresa: cadastro, periodos, linhas });
});

// GET /peers/cvm/empresa?cnpj=&dtFim=&visao= — DRE/BP/DFC da visão + indicadores
// gravados: a PROVA de qualquer indicador (drill-down de auditoria).
router.get("/cvm/empresa", async (req: AuthRequest, res: Response): Promise<void> => {
  const cnpj = String(req.query.cnpj ?? "").replace(/[^\d]/g, "");
  const dtFim = String(req.query.dtFim ?? "");
  const visao = ["TRI", "ANO", "LTM"].includes(String(req.query.visao)) ? String(req.query.visao) as "TRI" | "ANO" | "LTM" : "LTM";
  if (cnpj.length !== 14 || !/^\d{4}-\d{2}-\d{2}$/.test(dtFim)) { res.status(400).json({ error: "cnpj e dtFim são obrigatórios" }); return; }
  // ANO = exercício fechado: aceitar trimestre devolveria acumulado PARCIAL rotulado
  // como ano (flagrado pelo usuário: 1T26 exibido como "ANO 2025").
  if (visao === "ANO" && !dtFim.endsWith("12-31")) { res.status(400).json({ error: "Visão ANO só existe em fechamentos (31/12) — escolha um período de fechamento." }); return; }
  // ANO = exercício fechado: aceitar trimestre aqui devolveria o acumulado parcial
  // rotulado como ano (flagrado pelo usuário: 1T26 exibido como ANO 2025).
  if (visao === "ANO" && !dtFim.endsWith("12-31")) { res.status(400).json({ error: "Visão ANO só existe em fechamentos (31/12) — escolha um período de fechamento." }); return; }

  const { carregaEmpresasDoBanco } = await import("../services/cvm-sync");
  const { dreTrimestre, dreLtm } = await import("../services/cvm-metrics");
  const dt = new Date(`${dtFim}T00:00:00Z`);
  const dtMin = new Date(Date.UTC(dt.getUTCFullYear() - 2, dt.getUTCMonth(), 1)); // folga p/ LTM
  const emp = (await carregaEmpresasDoBanco([cnpj], dtMin, dt)).get(cnpj);
  const per = emp?.periodos[dtFim];
  if (!emp || !per) { res.status(404).json({ error: "Empresa/período não encontrado" }); return; }

  const dre = visao === "ANO" ? per.dreYtd : visao === "TRI" ? dreTrimestre(emp, dtFim) : dreLtm(emp, dtFim);
  // Rótulo fiel à CVM: a 3.01 é receita LÍQUIDA (a CVM não publica bruta) — internamente
  // ela ocupa a conta "Receita Bruta" do modelo gerencial (deduções zero), mas exibir
  // esse nome interno confunde a auditoria (flagrado pelo usuário).
  if (dre && dre["Receita Bruta"] !== undefined && dre["Receita Líquida"] === undefined) {
    dre["Receita Líquida"] = dre["Receita Bruta"];
    delete dre["Receita Bruta"];
  }
  // Indicadores DIRETO do motor (mesmos valores dos persistidos, mas com grupo/
  // tipo/fórmula/status) — permite à tela agrupar igual à aba Indicadores do IBR.
  const { indicadoresDaEmpresa } = await import("../services/cvm-metrics");
  const visaoInd = indicadoresDaEmpresa(emp, dtFim).find((v) => v.visao === visao);
  const label = Object.keys(visaoInd?.indicadores[0]?.valores ?? {})[0];
  const [cadastro, periodos] = await Promise.all([
    prisma.cvmCompany.findUnique({ where: { cnpj } }),
    prisma.cvmPeriod.findMany({ where: { cnpj }, distinct: ["dtFim"], select: { dtFim: true }, orderBy: { dtFim: "desc" } }),
  ]);
  res.json({
    empresa: cadastro,
    periodosDisponiveis: periodos.map((p) => p.dtFim.toISOString().slice(0, 10)),
    bp: per.bp,
    dre: dre ?? null,
    dreAviso: dre ? null : `Sem DRE na visão ${visao} para este período (janela incompleta).`,
    dfcYtd: per.dfcYtd,
    indicadores: (visaoInd?.indicadores ?? []).map((i) => {
      const v = i.valores[label];
      return {
        nome: i.nome, grupo: i.tipo || "Outros", tipoDado: i.tipoDado ?? "Índice",
        formula: i.formula ?? "", valor: typeof v === "number" ? v : null, texto: typeof v === "string" ? v : null,
        status: i.status?.[label] ?? null,
      };
    }),
  });
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
