/**
 * MODELOS FINANCEIROS — rotas do produto Projeções/Orçamento/Valuation (F1).
 *
 * Determinístico de ponta a ponta (zero IA nesta fase → zero custo a registrar).
 * Toda mutação emite trilha via registrarAuditoria (regra da casa).
 */
import { Router, Response } from "express";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { whereEmpresaVisivel, guardaEscritaSuspensao } from "../services/escopo-empresa";
import { prisma } from "../db/client";
import { registrarAuditoria } from "../services/audit-trail";
import { calcularModelo, validarFormula, backfillPremissasAoRecuar, BlocoModelo, ScenarioOverrides, RealizadoModelo, IndicesMacroSnapshot, SERIES_MACRO, MACRO_CAMBIO, ResultadoModelo, LinhaDre } from "../services/model-engine";
import { calcularOrcadoRealizado, congelarOrcamento } from "../services/model-orcamento";
import { calcularPorUnidade, decomporFolha, validarEdicaoRestrita, RateioCC, CentroCustoDim } from "../services/estrutura-dimensional";
import { aplicarRegraGrade, mesesDoAnoNoHorizonte, refAnualDaLinha, RegraGrade } from "../services/grade-orcamentaria";
import { calcularMatrizGmd, normContaGmd } from "../services/gmd-matricial";
import { CENTROS_PADRAO, UNIDADE_PADRAO, contasDoEsqueleto, centroEquivalente } from "../services/esqueleto-orcamento";
import { planejarImportacaoPlanoContas, ContaImportada } from "../services/plano-contas";
import { lerPlanilhaDeContas, LeituraPlanilha } from "../services/planilha-contas";
import { agregarPorPeriodo, recorteJanelaMovel } from "../services/model-safra";
import { DIVERGENCIAS_BELAGRO, resumoDivergencias } from "../services/model-reconciliacao-belagro";
import { buscarIndicesEconomicos } from "../services/indices-economicos";
import { mesclarArvoresBalancete } from "../services/balancete-conversao";
import { buscarDadosWacc } from "../services/wacc-dados";
import { indicadoresIbrDoModelo } from "../services/model-indicadores-ibr";
import type { HistoricoDfsIbr } from "../services/model-indicadores-ibr";
import { indicesRealizadosPorAno } from "../services/indices-realizados";
import { catalogoPadraoEfetivo } from "../services/indicador-config-ibr";
import type { SemaforoDef } from "../services/indicator-calculator";
import { ERP_REFERENCIA, BETAS_EMERGING, BETAS_DATA, KROLL_DECIS, KROLL_FONTE, CSRP_FATORES } from "../services/wacc-referencias";
import { perguntarJson } from "../services/ai-extraction";
import { montarLinhaReceita, TEMPLATES_RECEITA } from "../services/model-templates";
import { derivarSeed, derivarHistoricoAnual, derivarRealizadoParcial, derivarAberturaReceita, derivarAberturaCustos, derivarAberturaCustosCanonica, derivarImobilizadoHistorico, derivarGiroHistorico, derivarDividaHistorico, derivarCaixaHistorico, derivarOutrosBalanco, regraDaConta } from "../services/model-seed";
import { rodarMonteCarlo, McVariavelSpec } from "../services/monte-carlo";
import { ConfigReforma } from "../services/reforma-tributaria";
import { avaliarProntidaoGeracao } from "../services/prontidao-geracao";
import { resolveSectorPremises } from "../services/sector-benchmark";
import { loadActiveDREModel, loadActiveBPModel } from "../services/model-version";
import { sugerirContaCanonica } from "../services/sugerir-conta-canonica";
import { buildIndirectCashFlow } from "../services/cash-flow-indirect";
import { cicloVidaModel } from "../services/ciclo-vida";
import { TipoProduto, dataBaseDoModelo } from "../services/produto-empresa";
import { vincularAoProduto, limparEnvelopeSeVazio, VinculoFeito, ColisaoProduto } from "../services/produto-vinculo";
import { montarConteudoModelo, aplicarFotoModelo, hashConteudo, type ConteudoFotoModelo } from "../services/snapshot-diario";
import { damodaranDoSetorB3, DAMODARAN_PT } from "../services/damodaran-b3";
import multer from "multer";
import { parseDocument } from "../services/parser";
import {
  sugerirMapa, montarHistorico, paraHistoricoAnual, todosDestinos,
  type MapaConfirmado, type LinhaCrua,
} from "../services/historico-gerencial";

const router = Router();
router.use(requireAuth);
// SOMENTE CONSULTA: org suspensa (inadimplência) lê mas não escreve.
router.use(guardaEscritaSuspensao("model"));

/** Empresa visível para o caller — F2 SaaS: Quantua por posse do workspace;
 *  externo pela ALLOWLIST fechada (whereEmpresaVisivel). */
async function companyNoEscopo(companyId: string, req: AuthRequest) {
  return prisma.company.findFirst({ where: { id: companyId, ...whereEmpresaVisivel(req) } });
}

async function modelNoEscopo(id: string, req: AuthRequest) {
  const model = await prisma.financialModel.findUnique({ where: { id } });
  if (!model) return null;
  const company = await companyNoEscopo(model.companyId, req);
  return company ? model : null;
}

/** Análise-fonte do seed: a mais recente COM dados extraídos — IBR Concluído
 *  primeiro; sem um, vale extração fechada de IBR em andamento (o histórico já
 *  existe mesmo antes de o relatório ser assinado). `not: Prisma.DbNull` é o
 *  filtro real de Json não-nulo (`not: undefined` não filtra nada). */
async function analiseFonteSeed(companyId: string) {
  const select = { id: true, nome: true, status: true, dadosEstruturados: true } as const;
  const comDados = { dadosEstruturados: { not: Prisma.DbNull } };
  return (
    (await prisma.analysis.findFirst({ where: { companyId, status: "Concluída", ...comDados }, orderBy: { createdAt: "desc" }, select })) ??
    (await prisma.analysis.findFirst({ where: { companyId, ...comDados }, orderBy: { createdAt: "desc" }, select }))
  );
}

/** Roda o motor com o cenário ativo e persiste o cache. */
async function calcularEGravar(modelId: string) {
  const model = await prisma.financialModel.findUnique({
    where: { id: modelId },
    include: { blocks: { orderBy: { ordem: "asc" } }, scenarios: true },
  });
  if (!model) return null;
  const cenario = model.scenarios.find((s) => s.id === model.cenarioAtivoId) ?? model.scenarios.find((s) => s.isBase);
  const resultado = calcularModelo({
    mesInicial: model.mesInicial,
    horizonteMeses: model.horizonteMeses,
    blocks: model.blocks.map((b) => ({ id: b.id, tipo: b.tipo, nome: b.nome, ativo: b.ativo, config: b.config as BlocoModelo["config"] })),
    overrides: (cenario?.overrides ?? {}) as ScenarioOverrides,
    realizado: (model.realizado as RealizadoModelo | null) ?? null,
    indicesMacro: (model.indicesMacro as IndicesMacroSnapshot | null) ?? null,
  });
  await prisma.financialModel.update({
    where: { id: modelId },
    data: { resultadoCache: { calculadoEm: new Date().toISOString(), cenario: cenario?.nome ?? "Base", ...resultado } as object },
  });
  return { resultado, cenario: cenario?.nome ?? "Base" };
}

// GET /models/indices-economicos?anos=2026,2027,… — projeções OFICIAIS (Banco
// Central: Boletim Focus + PTAX) para o assistente de taxa indexada (índice +
// spread) — um clique preenche a curva do índice. Sem custo (API pública).
router.get("/indices-economicos", async (req: AuthRequest, res: Response): Promise<void> => {
  const anos = String(req.query.anos ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d{4}$/.test(s));
  if (!anos.length) { res.status(400).json({ error: "anos é obrigatório (ex.: ?anos=2026,2027)" }); return; }
  try {
    res.json(await buscarIndicesEconomicos(anos));
  } catch (e) {
    console.error("[indices-economicos]", e instanceof Error ? e.message : e);
    res.status(502).json({ error: "Não foi possível consultar o Banco Central agora — tente novamente em instantes ou digite o índice manualmente." });
  }
});

// GET /models/wacc-referencias — datasets ANUAIS do WACC (Damodaran/Kroll/CSRP),
// embutidos no código (mesmas tabelas da planilha padrão; atualização anual).
router.get("/wacc-referencias", async (_req: AuthRequest, res: Response): Promise<void> => {
  // `setor` (inglês) continua sendo a CHAVE — é ela que casa com a tabela de
  // betas e com a fonte publicada. `setorPt` é só exibição (pedido do usuário,
  // 22/07/2026); a tela ordena e mostra em português, sem perder a origem.
  const betas = BETAS_EMERGING.map((b) => ({ ...b, setorPt: DAMODARAN_PT[b.setor] ?? b.setor }));
  res.json({ erp: ERP_REFERENCIA, betas, betasData: BETAS_DATA, kroll: KROLL_DECIS, krollFonte: KROLL_FONTE, csrpFatores: CSRP_FATORES });
});

// GET /models/wacc-dados — dados de MERCADO do WACC (Rf/risco-país/dif. vol/…),
// mesma matemática da planilha padrão, fontes públicas, cache 24h (?forcar=1).
router.get("/wacc-dados", async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const janela = Number(req.query.janela) || 60;
    res.json(await buscarDadosWacc(janela, req.query.forcar === "1", req.query.detalhe === "1"));
  } catch (e) {
    console.error("[wacc-dados]", e instanceof Error ? e.message : e);
    res.status(502).json({ error: "Não foi possível buscar os dados de mercado agora — tente novamente em instantes ou informe os valores manualmente." });
  }
});

// GET /models/fontes-dfs?companyId= — DFs JÁ TRABALHADAS na base (de IBR ou de
// valuation anterior): o wizard pergunta se o usuário quer usá-las ou enviar
// demonstrativos novos. Devolve nome, documentos, períodos e o selo "fechada"
// (mesma régua de prontidão do gate do IBR — verde só com prova).
router.get("/fontes-dfs", async (req: AuthRequest, res: Response): Promise<void> => {
  const companyId = req.query.companyId as string | undefined;
  if (!companyId) { res.status(400).json({ error: "companyId é obrigatório" }); return; }
  const company = await companyNoEscopo(companyId, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  const analises = await prisma.analysis.findMany({
    where: { companyId, dadosEstruturados: { not: Prisma.DbNull } },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, nome: true, status: true, createdAt: true, dadosEstruturados: true },
  });
  const docs = await prisma.document.findMany({
    where: { analysisId: { in: analises.map((a) => a.id) } },
    select: { analysisId: true, nome: true },
  });
  const fontes = analises
    .map((a) => {
      const de = a.dadosEstruturados as { periodos?: string[]; bp?: unknown[]; dre?: unknown[]; versaoExtracao?: string } | null;
      if (!de || (!de.bp?.length && !de.dre?.length)) return null;
      let fechada = false;
      let pendencias: string[] = [];
      try {
        const p = avaliarProntidaoGeracao(de as never);
        fechada = p.pronta;
        pendencias = p.pendencias ?? [];
      } catch { /* dados antigos sem validação: fica como não-fechada, sem quebrar */ }
      // Código de exibição do IBR (mesma derivação do cabeçalho da análise) e os
      // ANOS de histórico — o picker do valuation mostra "IBR-2026-042 · 2023-2025".
      const num = a.id.replace(/[^0-9]/g, "").slice(-3).padStart(3, "0");
      const codigo = `IBR-${new Date(a.createdAt).getFullYear()}-${num}`;
      const anos = [...new Set((de.periodos ?? []).map((p) => (p.match(/(\d{4})/) ?? [])[1]).filter(Boolean))].sort();
      return {
        id: a.id,
        nome: a.nome,
        codigo,
        status: a.status,
        // REGRA (2026-07-16): só IBR CONCLUÍDO ancora valuation — o picker mostra
        // todos, mas os não concluídos aparecem bloqueados com a orientação.
        concluido: a.status === "Concluída",
        criadaEm: a.createdAt,
        periodos: de.periodos ?? [],
        anos,
        versaoExtracao: de.versaoExtracao ?? null,
        documentos: docs.filter((d) => d.analysisId === a.id).map((d) => d.nome),
        fechada,
        pendencias,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  // "mais recente" = primeira da lista (ordenada por createdAt desc) — o picker destaca.
  res.json({ empresa: company.nomeFantasia || company.razaoSocial, fontes: fontes.map((f, i) => ({ ...f, maisRecente: i === 0 })) });
});

// GET /models/seed-preview?companyId=&analysisId= — o que o seed encontraria:
// histórico? abertura de receita? Alimenta o wizard (empresa nova = business
// plan em branco). analysisId fixa a FONTE escolhida na tela.
router.get("/seed-preview", async (req: AuthRequest, res: Response): Promise<void> => {
  const companyId = req.query.companyId as string | undefined;
  const analysisId = req.query.analysisId as string | undefined;
  if (!companyId) { res.status(400).json({ error: "companyId é obrigatório" }); return; }
  const company = await companyNoEscopo(companyId, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  const analysis = analysisId
    ? await prisma.analysis.findFirst({
        where: { id: analysisId, companyId },
        select: { id: true, nome: true, status: true, dadosEstruturados: true },
      })
    : await analiseFonteSeed(companyId);
  if (!analysis) { res.json({ temHistorico: false, linhasReceita: [], periodos: [] }); return; }
  const abertura = derivarAberturaReceita(analysis.dadosEstruturados);
  const de = analysis.dadosEstruturados as { periodos?: string[] } | null;
  res.json({
    temHistorico: true,
    fonte: analysis.status === "Concluída" ? analysis.nome : `${analysis.nome} (em andamento)`,
    periodos: de?.periodos ?? [],
    linhasReceita: abertura.map((a) => a.conta),
  });
});

// GET /models/templates — catálogo de templates de receita (cards do wizard).
router.get("/templates", async (_req: AuthRequest, res: Response): Promise<void> => {
  res.json({ templates: TEMPLATES_RECEITA });
});

// GET /models/reconciliacao-planilha — catálogo das divergências conhecidas
// entre o motor do Quantua e a planilha de referência (Business Plan Belagro).
// É a PROVA da decisão de corrigir os defeitos em vez de replicá-los: cada item
// diz onde a planilha erra, o que ela devolve e o que o motor devolve.
// Estático (sem escopo de empresa) — fica junto das demais rotas sem :id, antes
// de "/:id", que senão captura este caminho.
router.get("/reconciliacao-planilha", async (_req: AuthRequest, res: Response): Promise<void> => {
  res.json({
    divergencias: DIVERGENCIAS_BELAGRO,
    resumo: resumoDivergencias(),
    fonte: "PLANO_BUSINESS_PLAN_BELAGRO.md — engenharia reversa de Business Plan - Belagro_mai.26.xlsm",
  });
});

// GET /models/contas-destino — contas dos MODELOS PADRÃO ATIVOS de DRE e BP
// (sempre a versão vigente do banco). Alimenta o dropdown "Destino na DRE/
// Balanço": uma linha nova pode SOMAR/REDUZIR numa conta canônica existente em
// vez de abrir linha própria. DRE separa receita × custo × despesa pela POSIÇÃO
// da conta (antes/depois de Lucro Bruto / EBITDA) — o dropdown já vem agrupado.
router.get("/contas-destino", async (req: AuthRequest, res: Response): Promise<void> => {
  // ?companyId= → cascata empresa→global (modelo próprio da empresa, se houver)
  const companyId = typeof req.query.companyId === "string" && req.query.companyId ? req.query.companyId : null;
  const [dreModel, bpModel] = await Promise.all([loadActiveDREModel(companyId), loadActiveBPModel(companyId)]);
  const inputs = dreModel.lines.filter((l) => !l.subtotal).map((l) => l.conta);
  const contaIdx = (conta: string) => dreModel.lines.findIndex((l) => l.conta === conta);
  const idxRL = contaIdx("Receita Líquida");
  const idxLB = contaIdx("Lucro Bruto");
  const idxEbitda = contaIdx("EBITDA");
  // Classificação por POSIÇÃO na cascata (robusta, não por palavra): antes da
  // Receita Líquida = receita/deduções; RL→Lucro Bruto = custo; LB→EBITDA =
  // despesa; depois do EBITDA = financeiro/não-op/IR (grupo próprio).
  const receitaDed: string[] = [];
  const custos: string[] = [];
  const despesas: string[] = [];
  const abaixoEbitda: string[] = [];
  for (const c of inputs) {
    const i = contaIdx(c);
    if (idxRL >= 0 && i < idxRL) receitaDed.push(c);
    else if (idxRL >= 0 && idxLB >= 0 && i > idxRL && i < idxLB) custos.push(c);
    else if (idxLB >= 0 && idxEbitda >= 0 && i > idxLB && i < idxEbitda) despesas.push(c);
    else if (idxEbitda >= 0 && i > idxEbitda) abaixoEbitda.push(c);
    else receitaDed.push(c);
  }
  res.json({
    dre: { receita: receitaDed, custos, despesas, abaixoEbitda },
    bp: bpModel.lines.filter((l) => l.tipo === "input").map((l) => l.conta),
  });
});

// GET /models?companyId= — lista modelos do escopo (opcionalmente por empresa).
router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const companyId = req.query.companyId as string | undefined;
  const companies = await prisma.company.findMany({
    where: { ...whereEmpresaVisivel(req), ...(companyId ? { id: companyId } : {}) },
    select: { id: true, razaoSocial: true, nomeFantasia: true },
  });
  const porId = new Map(companies.map((c) => [c.id, c]));
  const models = await prisma.financialModel.findMany({
    where: { companyId: { in: companies.map((c) => c.id) } },
    orderBy: { updatedAt: "desc" },
    include: { scenarios: { select: { id: true, nome: true, isBase: true } } },
  });
  res.json({
    models: models.map((m) => {
      const cache = m.resultadoCache as { checks?: Array<{ ok: boolean }> } | null;
      return {
        id: m.id, nome: m.nome, objetivo: m.objetivo, status: m.status,
        // Ciclo unificado (21/07/2026): derivado, aditivo — normaliza o legado "Rascunho".
        cicloVida: cicloVidaModel(m.status), motivoVersao: m.motivoVersao,
        mesInicial: m.mesInicial, horizonteMeses: m.horizonteMeses, visao: m.visao,
        companyId: m.companyId, empresa: porId.get(m.companyId)?.nomeFantasia || porId.get(m.companyId)?.razaoSocial || "—",
        cenarioAtivo: m.scenarios.find((s) => s.id === m.cenarioAtivoId)?.nome ?? "Base",
        checksOk: cache?.checks ? cache.checks.every((c) => c.ok) : null,
        // Vínculo com o IBR que serve de histórico. Já existia no banco; passa a
        // sair na lista para o hub da empresa exibir a relação entre produtos.
        analysisSeedId: m.analysisSeedId,
        // Versão dentro do envelope: sem ela, duas versões do mesmo produto
        // aparecem como linhas IDÊNTICAS na seção de vínculos do workspace.
        produtoVersao: m.produtoVersao,
        updatedAt: m.updatedAt,
      };
    }),
  });
});

// NOVA VERSÃO do modelo (21/07/2026, "salvar como" com motivo): o concluído é
// imutável — atualizar = copiar para a versão seguinte, Em produção. Copia
// premissas por inteiro (blocos, cenários, realizado, índices macro), remapeia
// o cenário ativo e entra no MESMO envelope com produtoVersao seguinte.
// body: { motivo: string } — obrigatório (motivoVersao + trilha).
router.post("/:id/nova-versao", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const motivo = typeof req.body?.motivo === "string" ? req.body.motivo.trim().slice(0, 300) : "";
  if (!motivo) {
    res.status(400).json({ error: "Informe o MOTIVO da nova versão — ele fica no cabeçalho da versão e na trilha de auditoria." });
    return;
  }
  const origem = await prisma.financialModel.findUnique({
    where: { id },
    include: { blocks: true, scenarios: true },
  });
  if (!origem || !(await companyNoEscopo(origem.companyId, req))) {
    res.status(404).json({ error: "Modelo não encontrado" });
    return;
  }

  let produtoVersao: number | null = null;
  if (origem.produtoId) {
    const max = await prisma.financialModel.aggregate({ where: { produtoId: origem.produtoId }, _max: { produtoVersao: true } });
    produtoVersao = (max._max.produtoVersao ?? 0) + 1;
  }

  const novo = await prisma.financialModel.create({
    data: {
      companyId: origem.companyId,
      userId: req.userId!,
      nome: produtoVersao ? `${origem.nome.replace(/ · v\d+$/, "")} · v${produtoVersao}` : `${origem.nome} · nova versão`,
      objetivo: origem.objetivo,
      mesInicial: origem.mesInicial,
      horizonteMeses: origem.horizonteMeses,
      visao: origem.visao,
      analysisSeedId: origem.analysisSeedId,
      realizado: origem.realizado ?? undefined,
      resultadoCache: origem.resultadoCache ?? undefined,
      indicesMacro: origem.indicesMacro ?? undefined,
      status: "Em produção",
      produtoId: origem.produtoId,
      produtoVersao,
      motivoVersao: motivo,
    },
  });
  // Blocos e cenários copiados por inteiro; o cenário ativo aponta para a CÓPIA.
  for (const b of origem.blocks) {
    await prisma.modelBlock.create({
      data: { modelId: novo.id, tipo: b.tipo, nome: b.nome, ordem: b.ordem, modo: b.modo, ativo: b.ativo, config: b.config as object },
    });
  }
  let cenarioAtivoNovoId: string | null = null;
  for (const s of origem.scenarios) {
    const copia = await prisma.modelScenario.create({
      data: { modelId: novo.id, nome: s.nome, isBase: s.isBase, overrides: s.overrides as object },
    });
    if (s.id === origem.cenarioAtivoId) cenarioAtivoNovoId = copia.id;
  }
  if (cenarioAtivoNovoId) {
    await prisma.financialModel.update({ where: { id: novo.id }, data: { cenarioAtivoId: cenarioAtivoNovoId } });
  }

  void registrarAuditoria({
    userId: req.userId!, entity: "model", entityId: novo.id,
    field: "nova versão do modelo (criada a partir de versão anterior)",
    before: { origemId: origem.id, origemNome: origem.nome, origemStatus: origem.status },
    after: { nome: novo.nome, produtoVersao, blocos: origem.blocks.length, cenarios: origem.scenarios.length },
    reason: motivo, source: "models",
  });

  res.status(201).json({ id: novo.id, nome: novo.nome, produtoVersao });
});

// POST /models — cria modelo + blocos default + cenários (wizard).
// body: { companyId, nome?, objetivo?, mesInicial?, horizonteMeses?, templateReceita?, analysisSeedId?,
//         produtoId?, produtoNovo?: { tipo?, periodo?, complemento? } }
router.post("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const { companyId, nome, objetivo, mesInicial, horizonteMeses, templateReceita, analysisSeedId, semHistorico, produtoId, produtoNovo } = req.body ?? {};
  if (!companyId) { res.status(400).json({ error: "companyId é obrigatório" }); return; }
  const company = await companyNoEscopo(companyId, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  // REGRA (2026-07-15): todo VALUATION nasce vinculado a um IBR — o histórico da
  // projeção são as DFs do IBR (BP/DRE/FC já formatados e validados). Nem todo
  // IBR tem valuation; todo valuation tem IBR. "ambos" inclui valuation → exige.
  const exigeIBR = objetivo === "valuation" || objetivo === "ambos" || !objetivo;
  if (exigeIBR && !analysisSeedId) {
    res.status(400).json({ error: "Valuation exige um IBR vinculado — selecione o IBR da empresa que fornece o histórico (ou processe as demonstrações para criar um)." });
    return;
  }
  // REGRA (2026-07-16): o IBR vinculado precisa estar CONCLUÍDO — pendência
  // contábil ou análise não gerada = produto inacabado, não ancora valuation.
  if (exigeIBR && analysisSeedId) {
    const fonte = await prisma.analysis.findFirst({
      where: { id: analysisSeedId, companyId },
      select: { status: true, nome: true },
    });
    if (!fonte) { res.status(404).json({ error: "IBR vinculado não encontrado nesta empresa." }); return; }
    if (fonte.status !== "Concluída") {
      res.status(409).json({ error: `O IBR "${fonte.nome}" ainda não foi concluído (status: ${fonte.status}) — finalize a extração e gere a análise; só após a conclusão ele pode ancorar um valuation.` });
      return;
    }
  }

  // Seed determinístico do histórico: análise indicada ou a mais recente com dados
  // (mesma seleção do seed-preview — o wizard e a criação enxergam a mesma fonte).
  //
  // "SEGUIR SEM HISTÓRICO" É ESCOLHA, NÃO OMISSÃO (correção 22/07/2026): antes,
  // a ausência de analysisSeedId caía no fallback `analiseFonteSeed` e o modelo
  // nascia semeado com as DFs do IBR mais recente da empresa — o analista dizia
  // "não tenho histórico" e o Business Plan vinha cheio de números que ele não
  // pediu (bug relatado pelo usuário). Um BP de negócio NOVO tem de nascer
  // ZERADO; o fallback só vale para chamadas antigas que não declaram nada.
  const analysis = semHistorico === true
    ? null
    : analysisSeedId
      ? await prisma.analysis.findFirst({ where: { id: analysisSeedId, companyId }, select: { id: true, dadosEstruturados: true } })
      : await analiseFonteSeed(companyId);
  const seed = derivarSeed(analysis?.dadosEstruturados ?? null);

  const agora = new Date();
  const mesDefault = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}`;
  // Default: 5 anos SEMPRE fechando em dezembro (ano corrente entra parcial).
  const mesInicioNum = Number((mesInicial || mesDefault).split("-")[1]);
  const horizonteDefault = mesInicioNum === 1 ? 60 : (13 - mesInicioNum) + 60;

  // ANTI-VALE: se a extração tem o REALIZADO PARCIAL do ano de início (ex.: balancete
  // até 30/06), o horizonte recua para JANEIRO e os meses fechados entram como
  // realizado — o ano corrente fecha inteiro (real + projetado), sem vale no valuation.
  let mesInicialEfetivo = mesInicial || mesDefault;
  let horizonteEfetivo = Number(horizonteMeses) || horizonteDefault;
  const anoInicio = mesInicialEfetivo.slice(0, 4);
  const parcial = derivarRealizadoParcial(analysis?.dadosEstruturados ?? null, anoInicio);
  if (parcial && Number(mesInicialEfetivo.split("-")[1]) > 1) {
    const mesesRecuados = Number(mesInicialEfetivo.split("-")[1]) - 1;
    mesInicialEfetivo = `${anoInicio}-01`;
    horizonteEfetivo += mesesRecuados;
  }
  const historicoAnual = derivarHistoricoAnual(analysis?.dadosEstruturados ?? null, parcial ? [parcial.periodoFonte] : []);

  // ABERTURA DO HISTÓRICO: cada conta de receita da DRE vira uma LINHA do modelo
  // (com âncora e crescimento próprios) — o analista continua a projeção de cada
  // uma e pode somar fontes novas. Template "historico" pede isso explicitamente.
  const abertura = derivarAberturaReceita(analysis?.dadosEstruturados ?? null);
  const usarAbertura = templateReceita === "historico" && abertura.length > 0;
  const linhasReceita: ReturnType<typeof montarLinhaReceita>[] = [];
  const receitaPorLinha: Record<string, Record<string, number>> = {};
  const memoriaAbertura: string[] = [];

  // PREMISSAS DE MERCADO (valuation automático, 2026-07-16): o crescimento do
  // SETOR (pares CVM/benchmark) vira o ALVO do fade — CAGR da empresa no 1º ano
  // convergindo linearmente para o setor até o fim do horizonte. Crescimento
  // constante eterno superavalia; o fade é a regra de ouro do FCD, declarada e
  // editável ano a ano na tela (Por ano · % de crescimento).
  const fonteMeta = analysis
    ? await prisma.analysis.findFirst({ where: { id: analysis.id }, select: { sectorId: true, sectorCustom: true } })
    : null;
  const premissasSetor = await resolveSectorPremises({
    sectorCode: fonteMeta?.sectorId ?? null,
    setorText: fonteMeta?.sectorCustom ?? company.setor ?? null,
  }).catch(() => null);
  const crescTerminal = Math.max(0.02, Math.min(0.15, premissasSetor?.receitaGrowth ?? 0.065));
  const anosHorizonte: Array<{ ano: string; meses: number }> = (() => {
    const [y0, m0] = mesInicialEfetivo.split("-").map(Number);
    const cont = new Map<string, number>();
    for (let i = 0; i < horizonteEfetivo; i++) {
      const d = new Date(y0, (m0 ?? 1) - 1 + i, 1);
      const ano = String(d.getFullYear());
      cont.set(ano, (cont.get(ano) ?? 0) + 1);
    }
    return [...cont.entries()].map(([ano, meses]) => ({ ano, meses }));
  })();

  if (usarAbertura) {
    abertura.forEach((ab, idx) => {
      const linhaId = `lin${idx + 1}`;
      const periodosCom = Object.entries(ab.valores).filter(([, v]) => v > 0).map(([k]) => k);
      const ultimoP = periodosCom[periodosCom.length - 1];
      const primeiroP = periodosCom[0];
      const vUlt = ultimoP ? ab.valores[ultimoP] : 0;
      const v0 = primeiroP ? ab.valores[primeiroP] : 0;
      // CAGR do histórico COMPLETO da linha (1º→último ano com valor), não o
      // último YoY — um ano atípico deixa de ditar a projeção inteira
      // (valuation automático 2026-07-16). Mesma trava de sanidade de sempre.
      const anosSpan = (() => {
        const y = (p?: string) => Number((p?.match(/(\d{4})/) ?? [])[1] ?? 0);
        return Math.max(1, y(ultimoP) - y(primeiroP));
      })();
      const cresc = v0 > 0 && vUlt > 0 && periodosCom.length >= 2
        ? Math.max(-0.5, Math.min(1, Math.pow(vUlt / v0, 1 / anosSpan) - 1))
        : 0.1;
      const linhaMontada = montarLinhaReceita("generico", linhaId, ab.conta, { receitaMensal: vUlt / 12, crescimentoAnual: cresc });
      // FADE: CAGR no 1º ano → crescimento do setor no último, linear — gravado
      // como "Por ano · % de crescimento" (o analista vê e edita cada ano).
      const raiz = linhaMontada.nodes.find((n) => n.id === linhaMontada.nodeRaiz);
      if (raiz && anosHorizonte.length >= 2 && vUlt > 0) {
        const N = anosHorizonte.length;
        const crescimentoPorAno: Record<string, number> = {};
        for (let k = 1; k < N; k++) {
          const g = cresc + (crescTerminal - cresc) * (k / (N - 1));
          crescimentoPorAno[anosHorizonte[k].ano] = Math.round(g * 10000) / 10000;
        }
        raiz.params = {
          ...raiz.params,
          modoPreenchimento: "ano",
          modoAno: "crescimento",
          valoresAno: { [anosHorizonte[0].ano]: Math.round(vUlt * (1 + cresc) * (anosHorizonte[0].meses / 12) * 100) / 100 },
          crescimentoPorAno,
        };
      }
      linhasReceita.push(linhaMontada);
      receitaPorLinha[linhaId] = ab.valores;
      memoriaAbertura.push(`"${ab.conta}": base ${vUlt.toFixed(2)} (${ultimoP ?? "—"}), crescimento ${(cresc * 100).toFixed(1)}% (CAGR ${primeiroP ?? "—"}→${ultimoP ?? "—"}) em FADE até ${(crescTerminal * 100).toFixed(1)}% a.a. (setor) no último ano`);
    });
  } else if (objetivo === "orcamento") {
    // ORÇAMENTO (28/07/2026): abre com QUATRO linhas de receita prontas para
    // digitar (a empresa costuma ter algumas fontes: serviços, insumos, grãos…).
    // Nascem SIMPLES — um nó série, valor digitado direto no Orçamento — e cada
    // uma pode virar detalhada por driver (qtd × preço, clientes × ticket) na
    // aba Receitas quando a empresa tiver essa maturidade. Renomear é livre.
    for (let i = 1; i <= 4; i++) {
      const linha = montarLinhaReceita("generico", `lin${i}`, `Receita ${i}`, {
        receitaMensal: i === 1 ? seed.receitaMensal : 0,
        crescimentoAnual: i === 1 ? seed.crescimentoAnual : 0,
      });
      // Só a primeira herda a âncora do histórico. As outras nascem ZERADAS —
      // o template genérico tem um default de 100 mil/mês que aqui inventaria
      // receita que ninguém orçou (visto no teste de 28/07/2026).
      if (i > 1) {
        const raiz = linha.nodes.find((n) => n.id === linha.nodeRaiz);
        if (raiz) raiz.params = { ...raiz.params, valorMensal: 0, crescimentoAnual: 0 };
      }
      linhasReceita.push(linha);
    }
  } else {
    linhasReceita.push(montarLinhaReceita(templateReceita === "historico" ? "generico" : (templateReceita || "generico"), "lin1", "Receita principal", {
      receitaMensal: seed.receitaMensal,
      crescimentoAnual: seed.crescimentoAnual,
    }));
  }

  // ABERTURA DE CUSTOS/DESPESAS (decisão 2026-07-16): as VARIÁVEIS do modelo são
  // as contas CANÔNICAS do modelo padrão de DRE do IBR (o de-para documento →
  // padrão já foi feito pelo fold; o documento original fica nas DFs de origem).
  // Cada conta canônica vira uma linha com % da RECEITA BRUTA do último ano —
  // o analista troca o tipo por linha quando a conta pedir (fixo, variável...).
  // O histórico por linha fica TRAVADO em custoPorLinha — nunca editável.
  const aberturaCustos = derivarAberturaCustosCanonica(analysis?.dadosEstruturados ?? null);
  const receitaBrutaUlt = (() => {
    const hs = historicoAnual?.linhas.receita ?? {};
    const ps = historicoAnual?.periodos ?? [];
    for (let i = ps.length - 1; i >= 0; i--) if ((hs[ps[i]] ?? 0) > 0) return hs[ps[i]];
    return 0;
  })();
  const usarAberturaCustos = aberturaCustos.length > 0 && receitaBrutaUlt > 0;
  const linhasCustoSeed: Array<{ id: string; nome: string; modo: string; pct: number; grupoDre?: string; valorMensal?: number; reajusteAnual?: number; reajusteIndice?: string }> = [];
  const linhasDespesaSeed: typeof linhasCustoSeed = [];
  const custoPorLinha: Record<string, Record<string, number>> = {};
  const custoPorLinhaAssinado: Record<string, Record<string, number>> = {};
  const memoriaCustos: string[] = [];
  let linhasFixoAuto = 0;
  // Coeficiente de variação: régua da estabilidade de uma série (σ/μ).
  const cvDe = (xs: number[]): number => {
    if (xs.length < 2) return Infinity;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    if (m <= 0) return Infinity;
    return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length) / m;
  };
  if (usarAberturaCustos) {
    aberturaCustos.forEach((ab, idx) => {
      const ehCusto = ab.bloco === "custo";
      const alvo = ehCusto ? linhasCustoSeed : linhasDespesaSeed;
      const linhaId = `${ehCusto ? "custo" : "desp"}h${idx + 1}`;
      const periodosCom = Object.entries(ab.valores).filter(([, v]) => v > 0).map(([k]) => k);
      const ultimoP = periodosCom[periodosCom.length - 1];
      // CONTRIBUIÇÃO assinada da linha para o bloco: −v do documento. Conta de
      // gasto (v negativo) → % positivo; conta REDUTORA (créditos/devoluções,
      // v positivo dentro do bloco de custo) → % NEGATIVO — o motor subtrai e o
      // bloco projetado fecha com o histórico (não infla; caso Move Farma).
      const vAssinadoUlt = ultimoP ? (ab.valoresAssinados?.[ultimoP] ?? -ab.valores[ultimoP]) : 0;
      const contribuicaoUlt = -vAssinadoUlt;
      const pct = Math.max(-1, Math.min(1, contribuicaoUlt / receitaBrutaUlt));
      // Nome SEM o marcador "(-)"/"(=)" do documento — o sinal é do bloco, não do nome.
      const nome = ab.conta.replace(/^(\s*\(?[=\-−+]\)?\s*)+/, "").trim() || ab.conta;

      // MODO AUTOMÁTICO POR EVIDÊNCIA (valuation automático, 2026-07-16): a
      // série histórica decide como a conta se comporta — mais estável em R$
      // (aluguéis, honorários, licenças) projeta FIXO + reajuste IPCA; mais
      // estável como % da receita (comissões, fretes, insumos) projeta %.
      // Mesma leitura que um analista faria, DECLARADA na memória do seed.
      // Redutoras e séries curtas (<2 anos) ficam em % (comportamento de sempre).
      const contribPorAno = periodosCom
        .map((p) => ({ v: -(ab.valoresAssinados?.[p] ?? -ab.valores[p]), rec: historicoAnual?.linhas.receita[p] ?? 0 }))
        .filter((x) => x.v > 0 && x.rec > 0);
      let modoAuto: "pctReceita" | "fixoReajuste" = "pctReceita";
      let provaModo = "";

      // REGRA FIXA POR CONTA (decisão do usuário, 22/07/2026) — vem ANTES da
      // heurística: estas contas são custo FIXO, e projetá-las como % da receita
      // erra por construção (a conta não acompanha o faturamento). Ver
      // regraDaConta em model-seed.ts: CAGR próprio com cascata, ou IPCA.
      const regra = regraDaConta(nome, contribPorAno.map((x) => x.v));
      if (regra && pct > 0) {
        alvo.push({
          id: linhaId, nome, modo: "fixoReajuste", pct, valorMensal: contribuicaoUlt / 12,
          ...(regra.reajusteIndice ? { reajusteIndice: regra.reajusteIndice } : {}),
          // Sem índice oficial, o crescimento derivado manda. Com índice, este
          // valor é só o fallback de quem não tem snapshot macro.
          reajusteAnual: regra.reajusteAnual ?? 0.04,
        });
        linhasFixoAuto++;
        provaModo = `regra da conta — ${regra.prova}`;
      } else {
      if (contribPorAno.length >= 2 && pct > 0) {
        const cvRs = cvDe(contribPorAno.map((x) => x.v));
        const cvPct = cvDe(contribPorAno.map((x) => x.v / x.rec));
        if (cvRs < 0.20 && cvRs < cvPct - 0.03) {
          modoAuto = "fixoReajuste";
          provaModo = `fixo por estabilidade em R$ (CV ${(cvRs * 100).toFixed(0)}% em R$ vs ${(cvPct * 100).toFixed(0)}% como %)`;
          linhasFixoAuto++;
        }
      }
      if (modoAuto === "fixoReajuste") {
        // Fallback de reajuste declarado (4% a.a.) para modelo sem snapshot macro;
        // com snapshot, o índice oficial (IPCA) manda.
        alvo.push({ id: linhaId, nome, modo: "fixoReajuste", pct, valorMensal: contribuicaoUlt / 12, reajusteIndice: "ipca", reajusteAnual: 0.04 });
      } else {
        alvo.push({ id: linhaId, nome, modo: "pctReceita", pct });
      }
      }
      custoPorLinha[linhaId] = ab.valores;
      // Histórico ASSINADO (contribuição p/ o bloco): a Demonstração exibe a
      // linha e o subtotal do grupo com o MESMO sinal que fecha com o total.
      custoPorLinhaAssinado[linhaId] = Object.fromEntries(
        Object.entries(ab.valoresAssinados ?? {}).map(([p, v]) => [p, -v])
      );
      memoriaCustos.push(`"${nome}" (${ehCusto ? "custo" : "despesa"}${pct < 0 ? ", redutora" : ""}): ${contribuicaoUlt.toFixed(2)} em ${ultimoP ?? "—"} = ${(pct * 100).toFixed(2)}% da receita bruta${provaModo ? ` — ${provaModo}` : ""}`);
    });
  }

  // ── VALUATION AUTOMÁTICO (2026-07-16): dívida e impostos também nascem
  // preenchidos a partir do IBR/cadastro, com PREMISSA DECLARADA — o modelo
  // nasce calculável de ponta a ponta e o analista valida um checklist curto
  // em vez de montar tudo à mão. Nada silencioso: cada palpite vira ponto de
  // validação com a prova de onde veio.

  // DÍVIDA: saldo do último BP + taxa IMPLÍCITA da própria empresa (Despesas
  // Financeiras do ano ÷ saldo) — dado real do IBR, não chute de mercado.
  // Prazo/sistema são premissa-padrão (Price 48m) até o analista confirmar.
  const dividaHist = derivarDividaHistorico(analysis?.dadosEstruturados ?? null);
  const taxaImplicitaDivida = (() => {
    const hs = historicoAnual?.linhas.despesasFinanceiras ?? {};
    const ps = historicoAnual?.periodos ?? [];
    let despFinUlt = 0;
    for (let i = ps.length - 1; i >= 0; i--) if ((hs[ps[i]] ?? 0) > 0) { despFinUlt = hs[ps[i]]; break; }
    if (dividaHist.total > 0 && despFinUlt > 0) return Math.max(0.08, Math.min(0.45, despFinUlt / dividaHist.total));
    return 0.18; // premissa-padrão declarada quando o histórico não dá a taxa
  })();
  const contratosDividaSeed = dividaHist.total > 0
    ? [{
        id: "divida_hist", nome: `Dívida existente (BP ${dividaHist.periodo})`, sistema: "price",
        saldoInicial: Math.round(dividaHist.total * 100) / 100, prazoMeses: 48, taxaAnual: Math.round(taxaImplicitaDivida * 1000) / 1000,
      }]
    : [];

  // IMPOSTOS: regime lido do CADASTRO da empresa (Receita/CNPJ); sem cadastro,
  // Lucro Presumido como premissa-padrão declarada no checklist.
  const regimeCadastro = (company.regimeTributario ?? "").toLowerCase();
  const regimeAuto = regimeCadastro.includes("simples") ? "simples"
    : regimeCadastro.includes("real") ? "real"
    : regimeCadastro.includes("presumido") ? "presumido"
    : null;
  const regimeSeed = regimeAuto ?? "presumido";

  // WACC AUTOMÁTICO (2026-07-16): a aba já abre com os DADOS DE MERCADO
  // (Rf mediana 60m do T-Bond, risco-país EMBI+, diferencial de volatilidade —
  // snapshot com fonte e janela, auditável) e o SETOR DAMODARAN mapeado do
  // setor da empresa (damodaran_mappings). Tudo editável; o checklist cobra a
  // confirmação. Falha de fonte externa não trava a criação (campos ficam
  // vazios como antes — o botão Atualizar da aba cobre depois).
  const [dadosMercadoWacc, setorBetaAuto] = await Promise.all([
    buscarDadosWacc(60).catch((e) => { console.error("[models/create] dados de mercado do WACC falharam (a aba auto-carrega ao abrir):", e instanceof Error ? e.message : e); return null; }),
    (async () => {
      if (!fonteMeta?.sectorId) return null;
      // A tabela `damodaran_mappings` (códigos LEGADOS) ainda vence quando tem
      // entrada — é editável por seed. Sem ela, a cascata B3 resolve: subsetor
      // → setor-pai → mercado. Antes do de-para B3 (22/07/2026) todo IBR com
      // taxonomia nova ficava sem beta e o WACC usava 1,00 em silêncio.
      const m = await prisma.damodaranMapping.findFirst({ where: { sectorCode: fonteMeta.sectorId } });
      return m?.damodaranIndustry ?? damodaranDoSetorB3(fonteMeta.sectorId).industria;
    })().catch((e) => { console.error("[models/create] mapeamento Damodaran falhou:", e instanceof Error ? e.message : e); return null; }),
  ]);

  // CHECKLIST DE VALIDAÇÃO DO ANALISTA: os pontos que a automação NÃO decide
  // sozinha (ou decidiu por premissa-padrão) — exibidos no topo do modelo.
  const pontosValidacao = [
    { id: "pessoas", titulo: "Pessoas (headcount)", detalhe: "A folha está projetada como custo agregado da DRE (Despesas com Pessoas). É o único dado que não existe nas DFs — se o valuation exigir abertura por posição/headcount, preencha o bloco Pessoas." },
    ...(contratosDividaSeed.length ? [{ id: "divida", titulo: "Dívida: prazo e taxa", detalhe: `Saldo de R$ ${dividaHist.total.toLocaleString("pt-BR", { maximumFractionDigits: 0 })} do BP (${dividaHist.periodo}) com taxa implícita de ${(taxaImplicitaDivida * 100).toFixed(1)}% a.a. (Despesas Financeiras ÷ saldo) em Price 48 meses — confirme com os contratos reais.` }] : []),
    { id: "impostos", titulo: "Regime tributário", detalhe: regimeAuto ? `"${company.regimeTributario}" lido do cadastro da empresa — confirme na aba Impostos.` : "Sem regime no cadastro — assumido LUCRO PRESUMIDO como premissa-padrão. Confirme na aba Impostos." },
    { id: "crescimento", titulo: "Crescimento da receita (fade p/ o setor)", detalhe: `CAGR do histórico no 1º ano convergindo linearmente para ${(crescTerminal * 100).toFixed(1)}% a.a. (crescimento do setor) no último — os % de cada ano estão editáveis na aba Receitas (Por ano · % de crescimento). Valide contra pipeline/estratégia comercial.` },
    ...(premissasSetor ? [{
      id: "benchmark", titulo: "Benchmark setorial",
      detalhe: (() => {
        const ps = historicoAnual?.periodos ?? [];
        let mgEmpresa: number | null = null;
        for (let i = ps.length - 1; i >= 0; i--) {
          const rec = historicoAnual?.linhas.receita[ps[i]] ?? 0;
          const lb = historicoAnual?.linhas.lucroBruto[ps[i]] ?? 0;
          if (rec > 0) { mgEmpresa = lb / rec; break; }
        }
        return `Setor: crescimento ${(premissasSetor.receitaGrowth * 100).toFixed(1)}% a.a. · margem bruta ${(premissasSetor.margemBruta * 100).toFixed(0)}%${mgEmpresa !== null ? ` — a empresa fez ${(mgEmpresa * 100).toFixed(0)}% de margem bruta no último ano` : ""}. Use como régua ao afinar crescimento, custos e despesas.`;
      })(),
    }] : []),
    ...(linhasFixoAuto > 0 ? [{ id: "modos", titulo: `Contas em modo FIXO automático (${linhasFixoAuto})`, detalhe: "Séries estáveis em R$ nasceram como 'fixo + reajuste IPCA' (aluguéis, honorários, licenças…) — a prova de cada decisão está na memória do seed; revise na aba Custos e despesas." }] : []),
    {
      id: "wacc", titulo: "WACC e perpetuidade",
      detalhe: dadosMercadoWacc
        ? `A aba WACC já abre com Rf ${(dadosMercadoWacc.rf.valor * 100).toFixed(2)}% e risco-país ${(dadosMercadoWacc.riscoPais.valor * 100).toFixed(2)}% (medianas de 60 meses, fontes no snapshot)${setorBetaAuto ? ` e o setor Damodaran "${setorBetaAuto}"` : " — escolha o setor Damodaran do beta"}. Confirme prêmios (tamanho/iliquidez), estrutura de capital e o crescimento na perpetuidade antes de concluir.`
        : "Confirme a taxa de desconto e o crescimento na perpetuidade (abas WACC e Valuation) antes de concluir.",
    },
  ];

  // CARIMBO DE PROVENIÊNCIA do seed (política 2026-07-15): o modelo nasce
  // apontando o HASH da versão da extração que o semeou. Se a análise-fonte for
  // reprocessada depois (documento substituído, dicionário novo), o hash atual
  // diverge e o GET do modelo acende "histórico desatualizado".
  const deSeed = analysis?.dadosEstruturados as { versaoExtracao?: string; extraidoEm?: string } | null;
  const seed_ = analysis
    ? { analysisId: analysis.id, versaoExtracao: deSeed?.versaoExtracao ?? null, extraidoEm: deSeed?.extraidoEm ?? null, seedEm: new Date().toISOString(), pontosValidacao }
    : null;
  const realizado = historicoAnual || parcial || seed_
    ? {
        ...(historicoAnual ? { historicoAnual: { ...historicoAnual, ...(usarAbertura ? { receitaPorLinha } : {}), ...(usarAberturaCustos ? { custoPorLinha, custoPorLinhaAssinado } : {}) } } : {}),
        ...(parcial ? { meses: parcial.meses, porGrupo: parcial.porGrupo } : {}),
        ...(seed_ ? { seed: seed_ } : {}),
      }
    : null;

  const ehOrcamento = objetivo === "orcamento";
  const model = await prisma.financialModel.create({
    data: {
      companyId,
      userId: req.userId!,
      // Nome default: finalidade + ano de início ("Valuation 2026") — a empresa
      // já tem coluna própria na lista; repetir o nome dela aqui só duplica.
      nome: nome || `${({ valuation: "Valuation", orcamento: "Orçamento", "business-plan": "Business Plan" } as Record<string, string>)[objetivo] ?? "Modelo"} ${mesInicialEfetivo.slice(0, 4)}`,
      objetivo: objetivo || "ambos",
      // Ciclo de vida (2026-07-15): "Em produção" → "Concluído" → "Cancelado".
      // Enquanto "Em produção" pode ser excluído; depois de "Concluído", nunca.
      status: "Em produção",
      mesInicial: mesInicialEfetivo,
      horizonteMeses: horizonteEfetivo,
      analysisSeedId: analysis?.id ?? null,
      realizado: realizado ? (realizado as object) : undefined,
      blocks: {
        create: [
          // Deduções da receita (vendas canceladas/abatimentos) ancoradas no
          // histórico: % sobre a bruta do último período extraído.
          { tipo: "receitas", nome: "Receitas", ordem: 0, config: { linhasReceita, ...(seed.deducoesPct > 0 ? { deducoesPct: seed.deducoesPct } : {}) } as object },
          // Custos/Despesas: com histórico, UMA LINHA POR CONTA ORIGINAL do
          // documento (% da receita bruta do último ano; o analista troca o tipo
          // por linha). Sem abertura NENHUMA, as linhas agregadas de sempre.
          // NUNCA misturar: agregado + abertura no outro bloco somaria o mesmo
          // gasto DUAS vezes (a abertura já carrega o total do bloco vazio).
          // ORÇAMENTO (28/07/2026) não recebe as linhas agregadas: quem orça
          // trabalha conta a conta dentro do centro de custo, e "Custos sobre a
          // receita 0%" pendurada em "Não atribuído" só confundia — o analista
          // não sabia o que era nem por que estava ali. O plano de contas entra
          // pelo esqueleto/importação logo em seguida. Valuation e BP seguem
          // com o agregado (ali ele É a premissa).
          {
            tipo: "custos", nome: "Custos", ordem: 1,
            config: {
              linhasCusto: usarAberturaCustos
                ? linhasCustoSeed
                : ehOrcamento
                  ? []
                  : [{ id: "custos1", nome: "Custos sobre a receita", modo: "pctReceita", pct: seed.pctCustos }],
            } as object,
          },
          {
            tipo: "despesas", nome: "Despesas", ordem: 2,
            config: {
              linhasCusto: usarAberturaCustos
                ? linhasDespesaSeed
                : ehOrcamento
                  ? []
                  : [{ id: "desp1", nome: "Despesas operacionais", modo: "pctReceita", pct: seed.pctDespesas }],
            } as object,
          },
          // NÃO OPERACIONAIS (abaixo do EBITDA): nascem vazios — só aparecem na
          // Demonstração quando o analista adicionar linhas.
          { tipo: "receitasNaoOp", nome: "Receitas não operacionais", ordem: 3, config: {} as object },
          { tipo: "despesasNaoOp", nome: "Despesas não operacionais", ordem: 4, config: {} as object },
          // CAPEX nasce com os ATIVOS EXISTENTES do BP do IBR (Imobilizado/
          // Intangível líquidos, classe fiscal do catálogo: intangível AMORTIZA
          // a 20%, imobilizado DEPRECIA a 10% — declarado, o analista ajusta) +
          // a ABERTURA SEGREGADA (bruto/acumulada do BP v3) para o balanço
          // projetado continuar os saldos brutos e as redutoras do histórico.
          {
            tipo: "capex", nome: "Investimentos (Capex)", ordem: 5,
            config: {
              ativosExistentes: derivarImobilizadoHistorico(analysis?.dadosEstruturados ?? null).itens.map((it, k) => {
                const ehIntang = /intang/i.test(it.conta);
                const ehBio = /biol/i.test(it.conta);
                return {
                  id: `ativo_hist_${k}`, nome: `${it.conta} (histórico)`, valor: it.valor,
                  taxaAnual: ehIntang ? 0.20 : 0.10,
                  tipoAtivo: ehIntang ? "intangivelGeral" : ehBio ? "biologicoGeral" : "imobilizadoGeral",
                };
              }),
              ...(() => {
                const bpF = (analysis?.dadosEstruturados as { periodos?: string[]; bp?: Array<{ conta: string; valores: Record<string, number> }> } | null);
                const periodo = derivarImobilizadoHistorico(analysis?.dadosEstruturados ?? null).periodo;
                if (!periodo || !bpF?.bp) return {};
                const val = (conta: string) => Math.abs(bpF.bp!.find((l) => l.conta.trim().toLowerCase() === conta.toLowerCase())?.valores?.[periodo] ?? 0);
                const seg = { imobilizadoBruto: val("Imobilizado"), depreciacaoAcumulada: val("(-) Depreciação"), intangivelBruto: val("Intangível"), amortizacaoAcumulada: val("(-) Amortização") };
                return seg.imobilizadoBruto > 0 || seg.intangivelBruto > 0 ? { aberturaSegregada: seg } : {};
              })(),
            } as object,
          },
          // A projeção DÁ SEQUÊNCIA ao balanço inteiro: as contas do BP
          // histórico fora do giro/imobilizado/dívida nascem como "outros itens"
          // (saldo constante = repete o último valor; o analista muda o modo).
          {
            tipo: "giro", nome: "Capital de giro", ordem: 6,
            config: {
              // GIRO nasce ancorado nos DIAS do histórico do IBR (PMR/PME/PMP,
              // mesma régua dos indicadores) — sem isso o BP projetado nascia
              // sem Contas a Receber/Estoques/Fornecedores (F2, 2026-07-16).
              ...(() => {
                const g = derivarGiroHistorico(analysis?.dadosEstruturados ?? null);
                return { ...(g.pmr ? { pmr: g.pmr } : {}), ...(g.pme ? { pme: g.pme } : {}), ...(g.pmp ? { pmp: g.pmp } : {}) };
              })(),
              // CAIXA da data-base (BP do fecho anterior ao início da projeção)
              // — abre o balanço projetado e ancora a ponte EV→Equity.
              ...(() => {
                const cx = derivarCaixaHistorico(analysis?.dadosEstruturados ?? null);
                return cx.valor > 0 ? { caixaInicial: cx.valor } : {};
              })(),
              itensBalancoSeed: true,
              itensBalanco: derivarOutrosBalanco(analysis?.dadosEstruturados ?? null).itens.map((h, k) => ({
                id: `bi${k}_${Date.now().toString(36)}`, nome: h.conta, classificacao: h.classificacao,
                modo: "constante", saldo: h.valor, ordem: k,
              })),
            } as object,
          },
          { tipo: "folha", nome: "Pessoas", ordem: 7, config: {} as object },
          // Dívida/Impostos AUTOMÁTICOS (2026-07-16): saldo+taxa implícita do
          // IBR e regime do cadastro — premissas declaradas no checklist de
          // validação (pontosValidacao); o analista confirma, não monta do zero.
          { tipo: "divida", nome: "Dívida", ordem: 8, config: (contratosDividaSeed.length ? { contratos: contratosDividaSeed } : {}) as object },
          { tipo: "impostos", nome: "Impostos", ordem: 9, config: { impostos: { regime: regimeSeed } } as object },
          // WACC nasce com dados de mercado + setor Damodaran (2026-07-16) —
          // Rf/CDS/vol com fonte e janela no snapshot; tudo editável na aba.
          {
            tipo: "wacc", nome: "WACC", ordem: 10,
            // ANINHADO em `wacc` (correção 22/07/2026): a tela lê
            // `config.wacc.dadosMercado`/`.setorBeta` (types.ts: WaccConfig).
            // Gravado plano, tudo o que a criação buscou ficava INVISÍVEL — era
            // por isso que a aba WACC só "carregava" quando clicada (ela
            // refazia a busca do zero). Espelha o vizinho `impostos`.
            config: {
              wacc: {
                ...(dadosMercadoWacc ? { dadosMercado: dadosMercadoWacc } : {}),
                ...(setorBetaAuto ? { setorBeta: setorBetaAuto } : {}),
              },
            } as object,
          },
          { tipo: "valuation", nome: "Valuation", ordem: 11, config: {} as object },
          { tipo: "reforma", nome: "Reforma tributária", ordem: 12, config: {} as object },
          { tipo: "dashboard", nome: "Dashboard", ordem: 13, config: {} as object },
        ],
      },
      scenarios: { create: [{ nome: "Base", isBase: true }, { nome: "Otimista" }, { nome: "Pessimista" }] },
    },
    include: { scenarios: true },
  });
  const base = model.scenarios.find((s) => s.isBase)!;
  await prisma.financialModel.update({ where: { id: model.id }, data: { cenarioAtivoId: base.id } });

  // A ESTRUTURA DA EMPRESA É CADASTRO DO ANALISTA (28/07/2026 — corrigido no
  // mesmo dia): a criação do orçamento chegou a cadastrar unidade e centros de
  // custo sozinha quando a empresa não tinha nenhum. Errado — centro de custo é
  // o desenho organizacional do cliente, o sistema não inventa. Quem quiser o
  // ponto de partida clica em "Trazer estrutura padrão" na própria grade (o
  // convite aparece enquanto nenhuma conta estiver lotada num CC), e aí a
  // criação é um ato declarado, com trilha.

  await registrarAuditoria({
    userId: req.userId!,
    entity: "financial_model",
    entityId: model.id,
    field: "criação",
    after: { nome: model.nome, objetivo: model.objetivo, templateReceita: templateReceita || "generico", seedDe: analysis?.id ?? null, memoriaSeed: [...seed.memoria, ...(parcial?.memoria ?? []), ...(memoriaAbertura.length ? [`Abertura de receita do histórico (${memoriaAbertura.length} linha(s)):`, ...memoriaAbertura] : []), ...(memoriaCustos.length ? [`Abertura de custos/despesas do histórico (${memoriaCustos.length} linha(s), % da receita bruta do último ano):`, ...memoriaCustos] : [])] },
    source: "models",
  });

  // PRODUTO (envelope de versões) JÁ NA CRIAÇÃO — pedido do usuário (24/07/2026):
  // "cada vez que crio um novo documento ele fica como ainda sem produto; já
  // deve criar abaixo do produto devido". O modelo nasce DENTRO do envelope, em
  // vez de cair em "ainda sem produto" e exigir uma segunda viagem ao workspace.
  //
  // A versão continua DECLARADA, nunca inferida: quem declara é o wizard, que
  // mostra o destino (produto existente × produto novo) ANTES de criar. Sem
  // `produtoId`/`produtoNovo` no body, o comportamento é o de sempre — o modelo
  // nasce solto (compatibilidade com quem chama a API direto).
  //
  // O rótulo é a IDENTIDADE do envelope: se já existe um com o mesmo rótulo
  // normalizado, o modelo entra NELE como versão seguinte — nunca cria duplicata.
  let produtoVinculado: VinculoFeito | null = null;
  let colisaoProduto: ColisaoProduto | null = null;
  try {
    const r = await vincularAoProduto({
      companyId,
      empresaNome: company.nomeFantasia || company.razaoSocial,
      userId: req.userId!,
      origem: "model",
      registroId: model.id,
      objetivo: model.objetivo,
      tipoPadrao: (model.objetivo === "ambos" ? "valuation" : model.objetivo) as TipoProduto,
      destino: { produtoId, produtoNovo },
      // Valuation/BP: data-base = fecho do mês anterior ao início da projeção.
      dataBase: dataBaseDoModelo(mesInicialEfetivo),
      // Orçamento: o que identifica é o EXERCÍCIO, não a data-base.
      ano: mesInicialEfetivo.slice(0, 4),
    });
    produtoVinculado = r.vinculo ?? null;
    colisaoProduto = r.colisao ?? null;
  } catch {
    // O envelope é organização, não o produto em si: falhar aqui NUNCA derruba a
    // criação do modelo — ele fica solto e o workspace continua oferecendo
    // "Organizar…", exatamente como antes desta mudança.
  }

  // SNAPSHOT dos índices macro (BCB) já na criação — as variáveis macro_* das
  // fórmulas nascem funcionando. Sem internet, o modelo nasce sem snapshot e o
  // botão "Atualizar índices" resolve depois (nunca bloqueia a criação).
  try {
    const [yIni, mIni] = mesInicialEfetivo.split("-").map(Number);
    const anosHorizonte = [...new Set(Array.from({ length: horizonteEfetivo }, (_, i) => String(yIni + Math.floor((mIni - 1 + i) / 12))))];
    const dados = await buscarIndicesEconomicos(anosHorizonte);
    await prisma.financialModel.update({ where: { id: model.id }, data: { indicesMacro: { ...dados, atualizadoEm: new Date().toISOString() } as object } });
  } catch { /* sem conexão com o BCB agora — segue sem snapshot */ }

  const calc = await calcularEGravar(model.id);
  // `colisaoProduto` preenchido = o modelo existe, SOLTO, e o rótulo pedido já é
  // de outro produto: quem decide é o analista (declarar como próxima versão ×
  // diferenciar com um complemento). O wizard pergunta antes de sair da tela.
  res.status(201).json({ id: model.id, seedMemoria: seed.memoria, checks: calc?.resultado.checks ?? [], produto: produtoVinculado, colisaoProduto });
});

// POST /models/:id/atualizar-indices — renova o SNAPSHOT dos índices macro do
// modelo (BCB: Focus + PTAX, IGNORANDO o cache — botão "Atualizar" da tela) e
// recalcula. Auditado com antes/depois.

/** Concluído/Cancelado = produto emitido (política 2026-07-16): premissas e
 *  estrutura TRAVADAS. Para mexer, reabra o modelo (Concluído → Em produção,
 *  com motivo na trilha) ou rode uma nova versão do valuation. */
const travaEdicao = (model: { status: string }): string | null =>
  model.status === "Concluído" || model.status === "Cancelado"
    ? `Modelo "${model.status}" está travado para edição — reabra o modelo (com motivo) ou crie uma nova versão a partir do IBR.`
    : null;

// ── ORÇAMENTO CONGELADO e ORÇADO × REALIZADO (B12) ─────────────────────────

/** Resultado vivo do modelo: usa o cache quando existe, senão recalcula. */
async function resultadoVivo(modelId: string) {
  const model = await prisma.financialModel.findUnique({ where: { id: modelId }, select: { resultadoCache: true } });
  const cache = model?.resultadoCache as (ResultadoModelo & { cenario?: string; calculadoEm?: string }) | null;
  if (cache?.dre) return { resultado: cache as ResultadoModelo, cenario: cache.cenario ?? "Base" };
  const calc = await calcularEGravar(modelId);
  return calc ? { resultado: calc.resultado, cenario: calc.cenario } : null;
}

// POST /models/:id/orcamento/congelar — fotografa a projeção como ORÇAMENTO.
// Versionado e monotônico: congelar de novo NÃO apaga o anterior (política de
// versionamento de insumos — nunca deletar, substituir).
router.post("/:id/orcamento/congelar", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  { const trava = travaEdicao(model); if (trava) { res.status(409).json({ error: trava }); return; } }

  const calc = await resultadoVivo(model.id);
  if (!calc) { res.status(409).json({ error: "Não foi possível calcular o modelo para congelar o orçamento." }); return; }
  if (!calc.resultado.dre?.length) {
    res.status(409).json({ error: "O modelo ainda não tem DRE calculada — configure os blocos antes de congelar o orçamento." });
    return;
  }

  const { nome, observacao } = (req.body ?? {}) as { nome?: string; observacao?: string };
  const ultima = await prisma.modelSnapshot.findFirst({ where: { modelId: model.id }, orderBy: { versao: "desc" }, select: { versao: true } });
  const versao = (ultima?.versao ?? 0) + 1;

  const snap = congelarOrcamento({
    id: "", // o id real é o do registro; o conteúdo guarda só a fotografia
    nome: nome?.trim() || `Orçamento v${versao}`,
    cenario: calc.cenario,
    mesInicial: model.mesInicial,
    horizonteMeses: model.horizonteMeses,
    dre: calc.resultado.dre,
    bp: calc.resultado.bp,
    fc: calc.resultado.fc,
  });
  const conteudo = { dre: snap.dre, bp: snap.bp, fc: snap.fc };
  const contentHash = crypto.createHash("sha256").update(JSON.stringify(conteudo)).digest("hex");

  // F2 (25/07/2026): congelar cria RASCUNHO — a baseline (ativo) passa a ser
  // decidida pela APROVAÇÃO, não pelo último congelamento. Draft é foto barata;
  // aprovado é assinatura.
  const criado = await prisma.modelSnapshot.create({
    data: {
      modelId: model.id, versao, nome: snap.nome, cenario: snap.cenario,
      mesInicial: snap.mesInicial, horizonteMeses: snap.horizonteMeses,
      conteudo: conteudo as object, contentHash, ativo: false, status: "rascunho",
      userId: req.userId!, observacao: observacao?.trim().slice(0, 300) || null,
    },
  });

  await registrarAuditoria({
    userId: req.userId!, analysisId: model.analysisSeedId ?? null,
    entity: "model_snapshot", entityId: criado.id, field: "congelamento do orçamento",
    after: { versao, nome: criado.nome, cenario: criado.cenario, linhas: snap.dre.length, contentHash },
    source: "models", reason: observacao?.trim().slice(0, 300) || undefined,
  });

  res.json({ ok: true, snapshot: { ...criado, conteudo: undefined } });
});

// GET /models/:id/orcamento/snapshots — histórico de congelamentos (sem o
// conteúdo, que é grande; use o endpoint do :sid para abrir um).
router.get("/:id/orcamento/snapshots", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const snapshots = await prisma.modelSnapshot.findMany({
    where: { modelId: model.id },
    orderBy: { versao: "desc" },
    select: { id: true, versao: true, nome: true, cenario: true, mesInicial: true, horizonteMeses: true, contentHash: true, ativo: true, status: true, aprovadoPor: true, aprovadoEm: true, observacao: true, createdAt: true, userId: true },
  });
  // Nome de quem aprovou (para a tela) — sem expor o objeto de usuário inteiro.
  const idsAprovadores = [...new Set(snapshots.map((s) => s.aprovadoPor).filter((v): v is string => !!v))];
  const aprovadores = idsAprovadores.length
    ? new Map((await prisma.user.findMany({ where: { id: { in: idsAprovadores } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
    : new Map<string, string>();
  res.json({ snapshots: snapshots.map((s) => ({ ...s, aprovadoPorNome: s.aprovadoPor ? aprovadores.get(s.aprovadoPor) ?? null : null })) });
});

// PUT /models/:id/orcamento/snapshots/:sid/status — CICLO DE APROVAÇÃO (F2).
// rascunho → final (pronto para aprovação; qualquer interno) → APROVADO
// (papel partner — espelha o ibr.sign: orçamento aprovado é assinatura de
// sócio). Aprovar torna o snapshot a BASELINE do Orçado × Realizado (ativo) e
// desliga as demais. Reabrir exige motivo; tudo na trilha.
// body: { status: "rascunho" | "final" | "aprovado", motivo? }
router.put("/:id/orcamento/snapshots/:sid/status", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const snap = await prisma.modelSnapshot.findFirst({ where: { id: req.params.sid as string, modelId: model.id } });
  if (!snap) { res.status(404).json({ error: "Orçamento congelado não encontrado" }); return; }

  const { status, motivo } = (req.body ?? {}) as { status?: string; motivo?: string };
  if (status !== "rascunho" && status !== "final" && status !== "aprovado") {
    res.status(400).json({ error: "status deve ser rascunho, final ou aprovado" });
    return;
  }
  if (status === snap.status) { res.json({ ok: true, snapshot: { ...snap, conteudo: undefined } }); return; }

  const usuario = await prisma.user.findUnique({ where: { id: req.userId! }, select: { role: true, name: true } });
  if (status === "aprovado" && usuario?.role !== "partner") {
    res.status(403).json({ error: "Aprovar orçamento é assinatura de sócio (papel partner) — peça a aprovação a um sócio." });
    return;
  }
  // REABRIR um aprovado destrava a baseline — só com motivo, e fica na trilha.
  if (snap.status === "aprovado" && !motivo?.trim()) {
    res.status(400).json({ error: "Reabrir um orçamento APROVADO exige o motivo (fica na trilha de auditoria)." });
    return;
  }

  // F9 — BASE ZERO: aprovar exige que TODA linha com valor tenha justificativa.
  // É o contrato do OBZ: nada é herdado, tudo é defendido.
  if (status === "aprovado" && model.tipoOrcamento === "base-zero") {
    const blocks = await prisma.modelBlock.findMany({ where: { modelId: model.id, tipo: { in: ["custos", "despesas"] } } });
    const semJustificativa: string[] = [];
    for (const b of blocks) {
      for (const l of ((b.config ?? {}) as { linhasCusto?: Array<Record<string, unknown>> }).linhasCusto ?? []) {
        const temValor =
          (typeof l.pct === "number" && l.pct > 0) ||
          (typeof l.valorMensal === "number" && l.valorMensal > 0) ||
          (l.valores && typeof l.valores === "object" && Object.values(l.valores as Record<string, number>).some((v) => Number.isFinite(v) && v !== 0));
        const obz = l.obz as { justificativa?: string } | undefined;
        if (temValor && !obz?.justificativa?.trim()) semJustificativa.push(String(l.nome ?? l.id));
      }
    }
    if (semJustificativa.length > 0) {
      res.status(409).json({
        error: `Orçamento BASE ZERO: ${semJustificativa.length} linha(s) com valor sem justificativa — ${semJustificativa.slice(0, 5).join(", ")}${semJustificativa.length > 5 ? "…" : ""}. Justifique na grade (base zero: nada é herdado, tudo é defendido) antes de aprovar.`,
      });
      return;
    }
  }

  const atualizado = await prisma.$transaction(async (tx) => {
    if (status === "aprovado") {
      // Uma baseline só: aprovar esta desliga as demais.
      await tx.modelSnapshot.updateMany({ where: { modelId: model.id, ativo: true }, data: { ativo: false } });
    }
    return tx.modelSnapshot.update({
      where: { id: snap.id },
      data: status === "aprovado"
        ? { status, ativo: true, aprovadoPor: req.userId!, aprovadoEm: new Date() }
        : { status, ativo: false, aprovadoPor: null, aprovadoEm: null },
    });
  });

  await registrarAuditoria({
    userId: req.userId!, analysisId: model.analysisSeedId ?? null,
    entity: "model_snapshot", entityId: snap.id,
    field: status === "aprovado" ? "aprovação do orçamento" : snap.status === "aprovado" ? "reabertura do orçamento aprovado" : "status do orçamento",
    before: { status: snap.status, ativo: snap.ativo },
    after: { status: atualizado.status, ativo: atualizado.ativo, aprovadoPor: usuario?.name ?? req.userId },
    source: "models", reason: motivo?.trim().slice(0, 300) || undefined,
  });
  res.json({ ok: true, snapshot: { ...atualizado, conteudo: undefined } });
});

// GET /models/:id/orcamento/snapshots/:sid — um congelamento inteiro.
router.get("/:id/orcamento/snapshots/:sid", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const snap = await prisma.modelSnapshot.findFirst({ where: { id: req.params.sid as string, modelId: model.id } });
  if (!snap) { res.status(404).json({ error: "Orçamento congelado não encontrado" }); return; }
  res.json({ snapshot: snap });
});

// ── FOTOS DE SEGURANÇA (snapshot automático diário, 2026-07-21) ─────────────
// Rede de segurança tipo Excel: o cron fotografa 1×/dia o estado editável do
// modelo (blocos, cenários, horizonte). NÃO confundir com o ORÇAMENTO
// CONGELADO acima (emissão de negócio): a foto é proteção operacional.
// Restaurar fotografa o estado atual antes ("pre-restauracao").

router.get("/:id/snapshots-diarios", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const fotos = await prisma.snapshotDiario.findMany({
    where: { entidade: "model", entidadeId: model.id },
    orderBy: { criadoEm: "desc" },
    select: { id: true, criadoEm: true, origem: true, hash: true, conteudo: true },
  });
  res.json({
    fotos: fotos.map((f) => {
      const c = f.conteudo as unknown as ConteudoFotoModelo;
      return {
        id: f.id, criadoEm: f.criadoEm, origem: f.origem, hash: f.hash.slice(0, 12),
        resumo: { status: c.model?.status ?? null, blocos: c.blocks?.length ?? 0, cenarios: c.scenarios?.length ?? 0 },
      };
    }),
  });
});

// body: { motivo?: string }
router.post("/:id/snapshots-diarios/:snapshotId/restaurar", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  { const trava = travaEdicao(model); if (trava) { res.status(409).json({ error: trava }); return; } }
  const foto = await prisma.snapshotDiario.findFirst({
    where: { id: req.params.snapshotId as string, entidade: "model", entidadeId: model.id },
  });
  if (!foto) { res.status(404).json({ error: "Foto de segurança não encontrada para este modelo." }); return; }

  const [blocks, scenarios] = await Promise.all([
    prisma.modelBlock.findMany({ where: { modelId: model.id }, select: { id: true, tipo: true, nome: true, ordem: true, modo: true, ativo: true, config: true } }),
    prisma.modelScenario.findMany({ where: { modelId: model.id }, select: { id: true, nome: true, isBase: true, overrides: true } }),
  ]);

  // Foto do estado ATUAL antes de mexer — a restauração é reversível por construção.
  const conteudoAtual = montarConteudoModelo(model as unknown as Record<string, unknown>, blocks, scenarios);
  const preFoto = await prisma.snapshotDiario.create({
    data: {
      entidade: "model", entidadeId: model.id, companyId: model.companyId,
      conteudo: conteudoAtual as unknown as object, hash: hashConteudo(conteudoAtual), origem: "pre-restauracao",
    },
  });

  const r = aplicarFotoModelo(foto.conteudo as unknown as ConteudoFotoModelo, model.status, blocks, scenarios);
  await prisma.$transaction([
    prisma.financialModel.update({ where: { id: model.id }, data: r.data as object }),
    ...r.blocks.map((b) => prisma.modelBlock.update({ where: { id: b.id }, data: b.data as object })),
    ...r.scenarios.map((c) => prisma.modelScenario.update({ where: { id: c.id }, data: c.data as object })),
  ]);

  const motivo = typeof req.body?.motivo === "string" ? req.body.motivo.trim().slice(0, 300) : "";
  await registrarAuditoria({
    userId: req.userId!, analysisId: model.analysisSeedId ?? null,
    entity: "financial_model", entityId: model.id,
    field: "restauração de foto de segurança (snapshot diário)",
    before: { estadoAtualFotografadoEm: preFoto.id, statusAntes: model.status },
    after: {
      fotoRestaurada: foto.id, fotoDe: foto.criadoEm.toISOString(), origem: foto.origem,
      blocosRestaurados: r.blocks.length, cenariosRestaurados: r.scenarios.length, ignorados: r.ignorados,
    },
    reason: motivo || undefined,
    source: "snapshot-diario",
  });
  res.json({ ok: true, blocosRestaurados: r.blocks.length, cenariosRestaurados: r.scenarios.length, ignorados: r.ignorados, preRestauracaoId: preFoto.id });
});

// GET /models/:id/orcado-realizado?de=YYYY-MM&ate=YYYY-MM[&snapshotId=]
// Compara o orçamento congelado com o realizado/projetado vivo nas quatro
// faixas da planilha de referência (período, mesmo período 12 meses atrás, e as
// duas comparações temporais).
router.get("/:id/orcado-realizado", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }

  // Baseline default (F2): o APROVADO mais recente. Sem nenhum aprovado, cai no
  // último congelamento — e a resposta AVISA que a comparação é contra rascunho.
  const snapRow = req.query.snapshotId
    ? await prisma.modelSnapshot.findFirst({ where: { id: String(req.query.snapshotId), modelId: model.id } })
    : (await prisma.modelSnapshot.findFirst({ where: { modelId: model.id, status: "aprovado" }, orderBy: { versao: "desc" } }))
      ?? (await prisma.modelSnapshot.findFirst({ where: { modelId: model.id }, orderBy: { versao: "desc" } }));
  if (!snapRow) {
    res.status(409).json({ error: "Este modelo ainda não tem orçamento congelado — congele o orçamento para comparar com o realizado." });
    return;
  }

  const calc = await resultadoVivo(model.id);
  if (!calc) { res.status(409).json({ error: "Não foi possível calcular o modelo." }); return; }

  const meses = calc.resultado.meses ?? [];
  const de = /^\d{4}-\d{2}$/.test(String(req.query.de ?? "")) ? String(req.query.de) : meses[0];
  const ate = /^\d{4}-\d{2}$/.test(String(req.query.ate ?? "")) ? String(req.query.ate) : meses[meses.length - 1];
  if (!de || !ate) { res.status(400).json({ error: "Informe o período (de/ate no formato YYYY-MM)." }); return; }

  const conteudo = (snapRow.conteudo ?? {}) as unknown as { dre?: LinhaDre[]; bp?: LinhaDre[]; fc?: LinhaDre[] };
  const resultado = calcularOrcadoRealizado({
    snapshot: {
      id: snapRow.id, nome: snapRow.nome, criadoEm: snapRow.createdAt.toISOString(), cenario: snapRow.cenario,
      mesInicial: snapRow.mesInicial, horizonteMeses: snapRow.horizonteMeses, dre: conteudo.dre ?? [],
      bp: conteudo.bp, fc: conteudo.fc,
    },
    dreRealizada: calc.resultado.dre ?? [],
    statusMes: calc.resultado.statusMes ?? {},
    // O lado "realizado" vem do balancete gravado no modelo — o motor projeta
    // em todos os meses e guarda o realizado como referência.
    realizado: (model.realizado as RealizadoModelo | null) ?? null,
    janela: { de, ate },
  });

  // Comparar contra rascunho não é comparar contra um compromisso — dizer.
  if (snapRow.status !== "aprovado") {
    resultado.avisos.unshift(`A baseline é um congelamento ${snapRow.status === "final" ? "FINAL ainda não aprovado" : "em RASCUNHO"} — nenhum orçamento aprovado neste modelo.`);
  }

  res.json({
    ...resultado,
    // Proveniência (regra da casa: data + fonte em todo output).
    orcamento: { id: snapRow.id, versao: snapRow.versao, nome: snapRow.nome, cenario: snapRow.cenario, congeladoEm: snapRow.createdAt, contentHash: snapRow.contentHash, status: snapRow.status },
    cenarioAtual: calc.cenario,
    geradoEm: new Date().toISOString(),
  });
});

// PUT /models/:id/metas — METAS TOP-DOWN (F3, 25/07/2026). O CEO declara
// receita/EBITDA/margem por ano; o painel de gap compara com o Σ bottom-up.
// body: { metas: { "2027": { receita?, ebitda?, margemEbitda? } } }
router.put("/:id/metas", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  { const trava = travaEdicao(model); if (trava) { res.status(409).json({ error: trava }); return; } }

  const metasBrutas = (req.body ?? {}).metas;
  if (metasBrutas !== null && (typeof metasBrutas !== "object" || Array.isArray(metasBrutas))) {
    res.status(400).json({ error: "metas deve ser um objeto { ano: { receita?, ebitda?, margemEbitda? } } ou null" });
    return;
  }
  // Sanitiza: só anos AAAA e os três campos numéricos — nada além entra no banco.
  const metas: Record<string, { receita?: number; ebitda?: number; margemEbitda?: number }> = {};
  for (const [ano, m] of Object.entries((metasBrutas ?? {}) as Record<string, Record<string, unknown>>)) {
    if (!/^\d{4}$/.test(ano) || typeof m !== "object" || m === null) continue;
    const alvo: { receita?: number; ebitda?: number; margemEbitda?: number } = {};
    for (const campo of ["receita", "ebitda", "margemEbitda"] as const) {
      const v = (m as Record<string, unknown>)[campo];
      if (typeof v === "number" && Number.isFinite(v)) alvo[campo] = v;
    }
    if (Object.keys(alvo).length) metas[ano] = alvo;
  }

  const before = model.metas ?? null;
  await prisma.financialModel.update({
    where: { id: model.id },
    data: { metas: Object.keys(metas).length ? (metas as object) : Prisma.DbNull },
  });
  await registrarAuditoria({
    userId: req.userId!, entity: "financial_model", entityId: model.id, field: "metas top-down",
    before: { metas: before }, after: { metas: Object.keys(metas).length ? metas : null },
    source: "models",
  });
  res.json({ ok: true, metas: Object.keys(metas).length ? metas : null });
});

// GET /models/:id/recorte?tipo=contabil|safra&mesInicioSafra=7[&janelaDe=YYYY-MM]
// Recorte de período: ano contábil, ano safra, ou janela móvel de 12 meses.
router.get("/:id/recorte", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const calc = await resultadoVivo(model.id);
  if (!calc) { res.status(409).json({ error: "Não foi possível calcular o modelo." }); return; }

  const meses = calc.resultado.meses ?? [];
  const janelaDe = String(req.query.janelaDe ?? "");

  if (/^\d{4}-\d{2}$/.test(janelaDe)) {
    const tamanho = Number(req.query.tamanho) || 12;
    res.json({
      modo: "janela",
      dre: recorteJanelaMovel(calc.resultado.dre ?? [], janelaDe, { tamanhoMeses: tamanho, origem: "dre", mesesDisponiveis: meses }),
      bp: recorteJanelaMovel(calc.resultado.bp ?? [], janelaDe, { tamanhoMeses: tamanho, origem: "bp", mesesDisponiveis: meses }),
      fc: recorteJanelaMovel(calc.resultado.fc ?? [], janelaDe, { tamanhoMeses: tamanho, origem: "fc", mesesDisponiveis: meses }),
      cenario: calc.cenario, geradoEm: new Date().toISOString(),
    });
    return;
  }

  const mesInicioSafra = req.query.tipo === "safra" ? Math.min(12, Math.max(1, Number(req.query.mesInicioSafra) || 7)) : 1;
  res.json({
    modo: req.query.tipo === "safra" ? "safra" : "contabil",
    mesInicioSafra,
    dre: agregarPorPeriodo(calc.resultado.dre ?? [], meses, { mesInicioSafra, origem: "dre" }),
    bp: agregarPorPeriodo(calc.resultado.bp ?? [], meses, { mesInicioSafra, origem: "bp" }),
    fc: agregarPorPeriodo(calc.resultado.fc ?? [], meses, { mesInicioSafra, origem: "fc" }),
    cenario: calc.cenario, geradoEm: new Date().toISOString(),
  });
});

router.post("/:id/atualizar-indices", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  { const trava = travaEdicao(model); if (trava) { res.status(409).json({ error: trava }); return; } }
  const [y0, m0] = model.mesInicial.split("-").map(Number);
  const anos = [...new Set(Array.from({ length: model.horizonteMeses }, (_, i) => String(y0 + Math.floor((m0 - 1 + i) / 12))))];
  try {
    const dados = await buscarIndicesEconomicos(anos, true);
    const snapshot = { ...dados, atualizadoEm: new Date().toISOString() };
    await prisma.financialModel.update({ where: { id: model.id }, data: { indicesMacro: snapshot as object } });
    await registrarAuditoria({
      userId: req.userId!, entity: "financial_model", entityId: model.id, field: "indices-macro",
      before: (model.indicesMacro as object | null) ?? undefined,
      after: snapshot as object,
      source: "models",
    });
    const calc = await calcularEGravar(model.id);
    res.json({ ok: true, indicesMacro: snapshot, resultado: calc?.resultado ?? null });
  } catch (e) {
    console.error("[atualizar-indices]", e instanceof Error ? e.message : e);
    res.status(502).json({ error: "Não foi possível consultar o Banco Central agora — tente novamente em instantes." });
  }
});

// GET /models/:id — modelo completo (blocos + cenários + resultado em cache).
router.get("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  // Backfill preguiçoso: modelos criados antes dos grupos NÃO OPERACIONAIS
  // ganham os blocos vazios na primeira abertura.
  const tiposExistentes = new Set(
    (await prisma.modelBlock.findMany({ where: { modelId: model.id }, select: { tipo: true } })).map((b) => b.tipo)
  );
  for (const [tipo, nome, ordem] of [["receitasNaoOp", "Receitas não operacionais", 3], ["despesasNaoOp", "Despesas não operacionais", 4], ["capex", "Investimentos (Capex)", 5], ["giro", "Capital de giro", 6], ["folha", "Pessoas", 7], ["divida", "Dívida", 8], ["impostos", "Impostos", 9], ["wacc", "WACC", 10], ["valuation", "Valuation", 11], ["reforma", "Reforma tributária", 12], ["dashboard", "Dashboard", 13]] as const) {
    if (!tiposExistentes.has(tipo)) {
      await prisma.modelBlock.create({ data: { modelId: model.id, tipo, nome, ordem, config: {} as object } });
    }
  }

  // CURA DO SHAPE DO WACC (22/07/2026): modelos criados antes da correção
  // gravaram dadosMercado/setorBeta no nível RAIZ do config, onde a tela nunca
  // olha — o WACC parecia "vazio" e a aba refazia a busca a cada abertura.
  // Move para dentro de `wacc` uma única vez, sem sobrescrever o que já existe
  // lá (edição do analista sempre vence o dado legado).
  {
    const bWacc = await prisma.modelBlock.findFirst({ where: { modelId: model.id, tipo: "wacc" } });
    const cfg = (bWacc?.config ?? {}) as Record<string, unknown>;
    const solto = { dadosMercado: cfg.dadosMercado, setorBeta: cfg.setorBeta };
    if (bWacc && (solto.dadosMercado !== undefined || solto.setorBeta !== undefined)) {
      const wacc = { ...(cfg.wacc as Record<string, unknown> | undefined ?? {}) };
      if (solto.dadosMercado !== undefined && wacc.dadosMercado === undefined) wacc.dadosMercado = solto.dadosMercado;
      if (solto.setorBeta !== undefined && wacc.setorBeta === undefined) wacc.setorBeta = solto.setorBeta;
      const { dadosMercado: _d, setorBeta: _s, ...resto } = cfg;
      await prisma.modelBlock.update({ where: { id: bWacc.id }, data: { config: { ...resto, wacc } as object } });
    }
  }

  // Backfill preguiçoso: modelos criados antes do histórico anual ganham as
  // colunas "hist" na primeira abertura (deriva da análise-seed e persiste).
  if (!model.realizado && model.analysisSeedId) {
    const analysis = await prisma.analysis.findUnique({ where: { id: model.analysisSeedId }, select: { dadosEstruturados: true } });
    const historicoAnual = derivarHistoricoAnual(analysis?.dadosEstruturados ?? null);
    if (historicoAnual) {
      await prisma.financialModel.update({ where: { id: model.id }, data: { realizado: { historicoAnual } as object } });
    }
  }
  // Backfill preguiçoso: histórico gravado ANTES das deduções (receita do topo
  // era a LÍQUIDA e destoava da abertura por linha, que é BRUTA) — re-deriva
  // uma vez, preservando o resto do realizado (meses/porGrupo).
  if (model.realizado && model.analysisSeedId) {
    const realizadoAtual = model.realizado as { historicoAnual?: { linhas?: Record<string, unknown> } } & Record<string, unknown>;
    if (realizadoAtual.historicoAnual && !realizadoAtual.historicoAnual.linhas?.impostosFat) {
      const analysis = await prisma.analysis.findUnique({ where: { id: model.analysisSeedId }, select: { dadosEstruturados: true } });
      const novo = derivarHistoricoAnual(analysis?.dadosEstruturados ?? null);
      if (novo) {
        const antigo = realizadoAtual.historicoAnual as { receitaPorLinha?: unknown };
        await prisma.financialModel.update({
          where: { id: model.id },
          data: { realizado: { ...realizadoAtual, historicoAnual: { ...novo, receitaPorLinha: antigo.receitaPorLinha } } as object },
        });
      }
    }
  }
  // Backfill preguiçoso: modelos criados antes dos "outros itens do balanço"
  // ganham TODAS as contas do BP histórico fora do modelo (saldo constante) —
  // roda UMA vez (flag), preservando o que o analista já tiver mexido/excluído.
  if (model.analysisSeedId) {
    const blocoGiro = await prisma.modelBlock.findFirst({ where: { modelId: model.id, tipo: "giro" } });
    const cfgG = (blocoGiro?.config ?? {}) as BlocoModelo["config"];
    if (blocoGiro && !cfgG.itensBalancoSeed) {
      const analysis = await prisma.analysis.findUnique({ where: { id: model.analysisSeedId }, select: { dadosEstruturados: true } });
      const outros = derivarOutrosBalanco(analysis?.dadosEstruturados ?? null);
      const existentes = new Set((cfgG.itensBalanco ?? []).map((i) => i.nome.trim().toLowerCase()));
      const novos = outros.itens
        .filter((h) => !existentes.has(h.conta.trim().toLowerCase()))
        .map((h, k) => ({
          id: `bi${k}_${Date.now().toString(36)}`, nome: h.conta, classificacao: h.classificacao,
          modo: "constante" as const, saldo: h.valor, ordem: Date.now() + k,
        }));
      await prisma.modelBlock.update({
        where: { id: blocoGiro.id },
        data: { config: { ...cfgG, itensBalanco: [...(cfgG.itensBalanco ?? []), ...novos], itensBalancoSeed: true } as object },
      });
    }
  }
  // Backfill preguiçoso: modelos criados antes do caixa da data-base (o seed
  // não gravava caixaInicial) — deriva do BP do IBR uma vez. Só preenche
  // quando o campo NUNCA existiu; 0 digitado pelo analista é respeitado.
  if (model.analysisSeedId) {
    const blocoGiro = await prisma.modelBlock.findFirst({ where: { modelId: model.id, tipo: "giro" } });
    const cfgG = (blocoGiro?.config ?? {}) as BlocoModelo["config"];
    if (blocoGiro && cfgG.caixaInicial === undefined) {
      const analysis = await prisma.analysis.findUnique({ where: { id: model.analysisSeedId }, select: { dadosEstruturados: true } });
      const cx = derivarCaixaHistorico(analysis?.dadosEstruturados ?? null);
      if (cx.valor > 0) {
        await prisma.modelBlock.update({
          where: { id: blocoGiro.id },
          data: { config: { ...cfgG, caixaInicial: cx.valor } as object },
        });
      }
    }
  }

  const completo = await prisma.financialModel.findUnique({
    where: { id: model.id },
    include: { blocks: { orderBy: { ordem: "asc" } }, scenarios: { orderBy: { createdAt: "asc" } } },
  });
  // Nome da EMPRESA no cabeçalho do modelo (o nome do modelo sozinho — ex.:
  // "Valuation 2026" — não diz de quem é).
  const company = await prisma.company.findUnique({
    where: { id: model.companyId },
    select: { razaoSocial: true, nomeFantasia: true },
  });
  // HISTÓRICO DESATUALIZADO — três critérios, todos avisados (nada silencioso):
  // 1. IBR re-extraído DEPOIS do seed (hash de versão divergente).
  // 2. Documento substituído/adicionado e AINDA NÃO reprocessado.
  // 3. Modelo LEGADO sem carimbo de seed: fonte re-extraída depois da CRIAÇÃO
  //    do modelo (extraidoEm > createdAt) — cobre valuations pré-v74.
  let historicoDesatualizado = false;
  let motivoDesatualizado: string | null = null;
  let ibrVinculado: { id: string; nome: string; codigo: string; status: string } | null = null;
  let setorBetaSugerido: string | null = null;
  const seedStamp = (completo?.realizado as { seed?: { versaoExtracao?: string | null } } | null)?.seed;
  if (model.analysisSeedId) {
    const fonte = await prisma.analysis.findUnique({
      where: { id: model.analysisSeedId },
      select: { id: true, nome: true, status: true, createdAt: true, sectorId: true, dadosEstruturados: true, documents: { select: { tipo: true, status: true, createdAt: true } } },
    });
    // Sugestão de SETOR DAMODARAN (auto-cura da aba WACC): modelos criados antes
    // do seed automático (ou com setor confirmado depois) ganham a seleção ao abrir.
    if (fonte?.sectorId) {
      const map = await prisma.damodaranMapping.findFirst({ where: { sectorCode: fonte.sectorId } }).catch(() => null);
      // Mesma cascata da criação: tabela legada primeiro, de-para B3 depois.
      setorBetaSugerido = map?.damodaranIndustry ?? damodaranDoSetorB3(fonte.sectorId).industria;
    }
    if (fonte) {
      const num = fonte.id.replace(/[^0-9]/g, "").slice(-3).padStart(3, "0");
      ibrVinculado = { id: fonte.id, nome: fonte.nome, codigo: `IBR-${new Date(fonte.createdAt).getFullYear()}-${num}`, status: fonte.status };
    }
    const deFonte = fonte?.dadosEstruturados as { versaoExtracao?: string; extraidoEm?: string } | null;
    const hashAtual = deFonte?.versaoExtracao ?? null;
    if (seedStamp?.versaoExtracao && hashAtual && hashAtual !== seedStamp.versaoExtracao) {
      historicoDesatualizado = true;
      motivoDesatualizado = "o IBR foi re-extraído depois que este modelo foi criado. Rode uma nova versão do valuation com o IBR atualizado.";
    } else if (deFonte?.extraidoEm && (fonte?.documents ?? []).some((d) => d.tipo !== "Material complementar" && d.status !== "Substituído" && d.createdAt > new Date(deFonte.extraidoEm!))) {
      historicoDesatualizado = true;
      motivoDesatualizado = "documento substituído/adicionado na Data room ainda não reprocessado. Reprocesse a extração do IBR e depois atualize o valuation.";
    } else if (!seedStamp?.versaoExtracao && deFonte?.extraidoEm && completo?.createdAt && new Date(deFonte.extraidoEm) > completo.createdAt) {
      historicoDesatualizado = true;
      motivoDesatualizado = "o IBR foi re-extraído depois que este modelo foi criado. Rode uma nova versão do valuation com o IBR atualizado.";
    }

    // MODELO LEGADO (pré-carimbo, linhas com nomes do DOCUMENTO) sem grupoDre:
    // enriquece NA LEITURA (sem persistir) casando pelo nome com a abertura da
    // fonte. Modelos novos (com carimbo de seed) usam contas CANÔNICAS como
    // variáveis (2026-07-16) — agrupar 1:1 seria redundância, então ficam fora.
    const seedNovo = !!(completo?.realizado as { historicoAnual?: { custoPorLinhaAssinado?: unknown } } | null)?.historicoAnual?.custoPorLinhaAssinado;
    const precisaGrupo = !seedNovo && (completo?.blocks ?? []).some((b) =>
      (b.tipo === "custos" || b.tipo === "despesas") &&
      ((b.config as { linhasCusto?: Array<{ grupoDre?: string }> })?.linhasCusto ?? []).some((l) => !l.grupoDre)
    );
    if (precisaGrupo && fonte?.dadosEstruturados) {
      const norm = (s: string) => s.replace(/^(\s*\(?[=\-−+]\)?\s*)+/, "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
      const grupoPorNome = new Map<string, string>();
      for (const ab of derivarAberturaCustos(fonte.dadosEstruturados)) {
        if (ab.destino && !grupoPorNome.has(norm(ab.conta))) grupoPorNome.set(norm(ab.conta), ab.destino);
      }
      for (const b of completo?.blocks ?? []) {
        if (b.tipo !== "custos" && b.tipo !== "despesas") continue;
        const cfg = b.config as { linhasCusto?: Array<{ nome: string; grupoDre?: string }> };
        for (const l of cfg?.linhasCusto ?? []) {
          if (!l.grupoDre) { const g = grupoPorNome.get(norm(l.nome)); if (g) l.grupoDre = g; }
        }
      }
    }

    // AUTO-RECUPERAÇÃO de linha do histórico excluída (2026-07-16): se alguma
    // linha semeada (id presente em custoPorLinha) sumiu dos blocos — exclusões
    // feitas antes da trava —, ela volta com a premissa ZERADA e é PERSISTIDA
    // (com trilha). Vale quando o hash do seed bate com o da fonte (mesma
    // derivação ⇒ mesmos ids/nomes); com hash divergente o banner de
    // desatualizado já manda recriar.
    const histLinhas = (completo?.realizado as { historicoAnual?: { custoPorLinha?: Record<string, unknown> } } | null)?.historicoAnual?.custoPorLinha;
    if (histLinhas && seedStamp?.versaoExtracao && seedStamp.versaoExtracao === (fonte?.dadosEstruturados as { versaoExtracao?: string } | null)?.versaoExtracao) {
      const idsPresentes = new Set<string>();
      for (const b of completo?.blocks ?? []) {
        for (const l of (b.config as { linhasCusto?: Array<{ id: string }> })?.linhasCusto ?? []) idsPresentes.add(l.id);
        for (const l of (b.config as { linhasReceita?: Array<{ id: string }> })?.linhasReceita ?? []) idsPresentes.add(l.id);
      }
      const faltando = Object.keys(histLinhas).filter((id) => !idsPresentes.has(id));
      if (faltando.length) {
        const abertura = derivarAberturaCustosCanonica(fonte?.dadosEstruturados ?? null);
        const restauradas: string[] = [];
        for (let idx = 0; idx < abertura.length; idx++) {
          const ab = abertura[idx];
          const ehCusto = ab.bloco === "custo";
          const linhaId = `${ehCusto ? "custo" : "desp"}h${idx + 1}`;
          if (!faltando.includes(linhaId)) continue;
          const blocoAlvo = completo?.blocks.find((b) => b.tipo === (ehCusto ? "custos" : "despesas"));
          if (!blocoAlvo) continue;
          const nome = ab.conta.replace(/^(\s*\(?[=\-−+]\)?\s*)+/, "").trim() || ab.conta;
          const cfg = blocoAlvo.config as { linhasCusto?: Array<{ id: string; nome: string; modo: string; pct: number }> };
          (cfg.linhasCusto ??= []).push({ id: linhaId, nome, modo: "pctReceita", pct: 0 });
          await prisma.modelBlock.update({ where: { id: blocoAlvo.id }, data: { config: cfg as object } });
          restauradas.push(nome);
        }
        if (restauradas.length) {
          void registrarAuditoria({
            userId: req.userId!, analysisId: model.analysisSeedId, entity: "financial_model", entityId: model.id,
            field: "linha(s) do histórico restaurada(s) com premissa zerada", after: { linhas: restauradas }, source: "models",
          });
          await calcularEGravar(model.id).catch(() => null);
        }
      }
    }
  }
  res.json({ ...completo, empresaNome: company?.nomeFantasia || company?.razaoSocial || null, historicoDesatualizado, motivoDesatualizado, ibrVinculado, setorBetaSugerido });
});

// GET /models/:id/dfs-origem — TRANSPARÊNCIA: as demonstrações EXTRAÍDAS
// (BP e DRE canônicos, 100% das contas, todos os períodos) da análise-fonte
// que ancora o modelo. Nada é recalculado aqui — é o retrato fiel da origem.
router.get("/:id/dfs-origem", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  if (!model.analysisSeedId) { res.json({ temOrigem: false }); return; }
  const analysis = await prisma.analysis.findUnique({
    where: { id: model.analysisSeedId },
    select: { id: true, nome: true, status: true, createdAt: true, dadosEstruturados: true },
  });
  const de = analysis?.dadosEstruturados as {
    periodos?: string[];
    bp?: Array<{ classificacao: string; conta: string; valores: Record<string, number>; nivel: number; editado?: boolean }>;
    dre?: Array<{ conta: string; valores: Record<string, number>; subtotal?: boolean; editado?: boolean }>;
    dicionarioVersao?: number;
    versaoExtracao?: string;
    arvoreOriginalDRE?: Record<string, unknown[]>;
    arvoreOriginalBP?: Record<string, unknown>;
    arvoresBalancete?: unknown;
  } | null;
  // IBR alimentado por BALANCETE guarda as árvores em `arvoresBalancete`; sem
  // esta mescla a aba "Documento original da empresa" ficava VAZIA no Valuation
  // (mesma leitura que a auditoria do IBR já fazia — helper único).
  if (de) { try { mesclarArvoresBalancete(de); } catch { /* best-effort */ } }
  if (!de || (!de.bp?.length && !de.dre?.length)) { res.json({ temOrigem: false }); return; }
  res.json({
    temOrigem: true,
    analysisId: analysis!.id,
    analysisNome: analysis!.nome,
    analysisStatus: analysis!.status,
    atualizadaEm: analysis!.createdAt,
    dicionarioVersao: de.dicionarioVersao ?? null,
    versaoExtracao: de.versaoExtracao ?? null,
    periodos: de.periodos ?? [],
    bp: de.bp ?? [],
    dre: de.dre ?? [],
    // DOCUMENTO ORIGINAL da empresa (árvore fiel, nomes/valores como impressos):
    // o histórico da projeção usa as DFs FORMATADAS do IBR; esta aba preserva a
    // visão original para o analista rastrear cada número até o documento.
    arvoreOriginalDRE: de.arvoreOriginalDRE ?? null,
    arvoreOriginalBP: de.arvoreOriginalBP ?? null,
    // SUBTOTAIS DECLARADOS no documento (Receita Líquida/Lucro Bruto/Lucro
    // Líquido como IMPRESSOS): a árvore captura só as contas-insumo — os
    // resultados calculados ficam aqui e fecham o quadro até o Lucro Líquido.
    declarados: (de as { declarados?: Record<string, Record<string, number>> }).declarados ?? null,
  });
});

// GET /models/:id/historico-custos — abertura de CUSTOS/DESPESAS do histórico
// nas CONTAS CANÔNICAS do modelo padrão de DRE (2026-07-16: as variáveis do
// modelo SÃO as contas padrão — a âncora do custo unitário das linhas "Por
// variável" fala a mesma língua, não os nomes do documento original da
// empresa, que ficam na aba DFs de origem). Valores = CONTRIBUIÇÃO assinada
// (gasto positivo, redutora negativa), até 3 últimos períodos.
router.get("/:id/historico-custos", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  if (!model.analysisSeedId) { res.json({ periodos: [], linhas: [] }); return; }
  const analysis = await prisma.analysis.findUnique({ where: { id: model.analysisSeedId }, select: { dadosEstruturados: true } });
  const linhas = derivarAberturaCustosCanonica(analysis?.dadosEstruturados ?? null);
  const de = analysis?.dadosEstruturados as { periodos?: string[] } | null;
  const periodos = (de?.periodos ?? []).slice(-3); // 1 a 3 períodos de histórico
  res.json({
    periodos,
    linhas: linhas.map((l) => ({
      conta: l.conta.replace(/^(\s*\(?[=\-−+]\)?\s*)+/, "").trim() || l.conta,
      valores: Object.fromEntries(periodos.map((p) => [p, -(l.valoresAssinados?.[p] ?? -(l.valores[p] ?? 0))])),
    })),
  });
});

// GET /models/:id/historico-imobilizado — ativos de longo prazo do BP extraído
// (Imobilizado, Intangível, Biológicos): âncora dos "ativos existentes" do capex.
router.get("/:id/historico-imobilizado", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  if (!model.analysisSeedId) { res.json({ periodo: null, itens: [] }); return; }
  const analysis = await prisma.analysis.findUnique({ where: { id: model.analysisSeedId }, select: { dadosEstruturados: true } });
  res.json(derivarImobilizadoHistorico(analysis?.dadosEstruturados ?? null));
});

// GET /models/:id/historico-giro — dias de giro do HISTÓRICO COMPLETO
// (PMR/PME/PMP por período, travados na mesma linha da projeção) + saldos por
// conta do BP extraído (o histórico dos "outros itens do balanço" — inclusive
// itens adicionados depois: o de-para é pelo nome canônico da conta).
router.get("/:id/historico-giro", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  if (!model.analysisSeedId) { res.json({ periodo: null, pmr: null, pme: null, pmp: null, porPeriodo: [], periodos: [], saldosPorConta: {} }); return; }
  const analysis = await prisma.analysis.findUnique({ where: { id: model.analysisSeedId }, select: { dadosEstruturados: true } });
  const giro = derivarGiroHistorico(analysis?.dadosEstruturados ?? null);
  const de = analysis?.dadosEstruturados as { periodos?: string[]; bp?: Array<{ conta: string; valores: Record<string, number>; nivel?: number }> } | null;
  const saldosPorConta: Record<string, Record<string, number>> = {};
  for (const l of de?.bp ?? []) {
    if ((l.nivel ?? 2) < 2) continue; // só contas-folha (subtotais não são itens)
    const vals: Record<string, number> = {};
    for (const p of de?.periodos ?? []) {
      const v = Math.abs(l.valores?.[p] ?? 0);
      if (v > 0) vals[p] = v;
    }
    if (Object.keys(vals).length) saldosPorConta[l.conta.trim()] = vals;
  }
  // BASES HISTÓRICAS anuais das réguas de prazo médio dos "outros itens"
  // (mesmas bases do motor: receita/custos/impostos/folha) — a tela calcula os
  // DIAS IMPLÍCITOS do passado (saldo × 360 ÷ base do ano, a régua do motor:
  // saldo = base do mês × dias ÷ 30) para o item escolhido, em qualquer base.
  const deDre = analysis?.dadosEstruturados as { dre?: Array<{ conta: string; valores: Record<string, number> }> } | null;
  const linhaDre = (conta: string) => deDre?.dre?.find((l) => l.conta.trim().toLowerCase() === conta.toLowerCase());
  const somaAbs = (contas: string[], p: string) => contas.reduce((s, c) => s + Math.abs(linhaDre(c)?.valores?.[p] ?? 0), 0);
  const basesHistoricas: Record<string, Record<string, number>> = { receita: {}, custos: {}, impostos: {}, folha: {} };
  for (const p of de?.periodos ?? []) {
    basesHistoricas.receita[p] = somaAbs(["Receita Líquida"], p) || somaAbs(["Receita Bruta"], p);
    basesHistoricas.custos[p] = somaAbs(["Custo Operacional"], p);
    basesHistoricas.impostos[p] = somaAbs(["Impostos s/ Faturamento", "IR e CSLL"], p);
    basesHistoricas.folha[p] = somaAbs(["Despesas com Pessoas"], p);
  }
  res.json({ ...giro, periodos: de?.periodos ?? [], saldosPorConta, basesHistoricas });
});

// GET /models/:id/historico-balanco — OUTRAS contas do BP extraído (fora de
// caixa/giro/imobilizado/dívida/PL): âncora do bloco "Outros itens do balanço"
// (mútuos, antecipações, impostos/pessoal a pagar…), com classificação sugerida.
router.get("/:id/historico-balanco", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  if (!model.analysisSeedId) { res.json({ periodo: null, itens: [] }); return; }
  const analysis = await prisma.analysis.findUnique({ where: { id: model.analysisSeedId }, select: { dadosEstruturados: true } });
  res.json(derivarOutrosBalanco(analysis?.dadosEstruturados ?? null));
});

// GET /models/:id/historico-dfs — colunas HISTÓRICAS do BP e do Fluxo de Caixa
// para a aba DFs: o BP extraído mapeado nas linhas do BP PROJETADO (ids do
// motor) e o FC histórico CALCULADO pelo método indireto (precisa de 2+ BPs —
// com N balanços saem N−1 colunas de fluxo). Nada é persistido: derivação
// determinística da análise-fonte, travada para edição por construção.
router.get("/:id/historico-dfs", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const vazio = { temHistorico: false, periodosBP: [], periodosFC: [], bp: {}, fc: {}, avisoFC: null };

  // HISTÓRICO GERENCIAL (BP sem IBR): quando o analista importou a planilha da
  // empresa, ela responde por esta rota — mesmos ids `bp-*`, então gráficos e
  // aba DFs funcionam igual. Sem FC indireto: ele exige a DRE completa e a
  // conciliação de caixa que o gerencial nem sempre tem; derivar por cima de
  // uma planilha não auditada seria afirmar o que não se sabe.
  const histGerencial = (model.realizado as { historicoBP?: { periodos?: string[]; linhas?: Record<string, Record<string, number>> } } | null)?.historicoBP;
  if (!model.analysisSeedId) {
    if (histGerencial?.periodos?.length && histGerencial.linhas && Object.keys(histGerencial.linhas).length) {
      res.json({
        temHistorico: true,
        periodosBP: histGerencial.periodos,
        periodosFC: [],
        bp: histGerencial.linhas,
        fc: {},
        avisoFC: "Histórico gerencial importado: o fluxo de caixa indireto não é calculado sobre planilha do cliente (exige a DRE completa e a conciliação de caixa do balanço).",
        origem: "gerencial",
      });
      return;
    }
    res.json(vazio);
    return;
  }
  const analysis = await prisma.analysis.findUnique({ where: { id: model.analysisSeedId }, select: { dadosEstruturados: true } });
  const de = analysis?.dadosEstruturados as {
    periodos?: string[];
    bp?: Array<{ conta: string; valores: Record<string, number>; classificacao?: string; nivel?: number }>;
    dre?: Array<{ conta: string; valores: Record<string, number>; subtotal?: boolean }>;
  } | null;
  if (!de?.bp?.length) { res.json(vazio); return; }
  const bpExt = de.bp;
  const periodos = (de.periodos ?? []).filter((p) => bpExt.some((l) => Math.abs(l.valores?.[p] ?? 0) > 0));
  if (!periodos.length) { res.json(vazio); return; }

  const val = (conta: string, p: string): number => bpExt.find((l) => l.conta === conta)?.valores?.[p] ?? 0;
  const soma = (contas: string[], p: string): number => contas.reduce((s, c) => s + val(c, p), 0);
  // Linha do BP PROJETADO (id do motor) ← conta(s) canônica(s) do BP extraído.
  const MAPA_BP: Record<string, string[]> = {
    "bp-ativo": ["Ativo Total"],
    "bp-ativo-circ": ["Ativo Circulante"],
    "bp-caixa": ["Caixa e Equivalentes de Caixa"],
    "bp-cr": ["Contas a Receber - CP"],
    "bp-estoques": ["Estoques - CP"],
    "bp-ativo-nc": ["Ativo Não Circulante"],
    // Segregação BP v3 (2026-07-16): 1:1 com as linhas projetadas — bruto e
    // redutora por natureza (extração antiga sem redutoras mostra "—" nelas).
    "bp-imobilizado": ["Imobilizado", "Ativos Biológicos - LP"],
    "bp-depreciacao": ["(-) Depreciação"],
    "bp-intangivel": ["Intangível"],
    "bp-amortizacao": ["(-) Amortização"],
    "bp-passivo-pl": ["Passivo Total"],
    "bp-passivo-circ": ["Passivo Circulante"],
    "bp-fornecedores": ["Fornecedores - CP"],
    "bp-divida-cp": ["Empréstimos e Financiamentos - CP"],
    "bp-passivo-nc": ["Passivo Não Circulante"],
    "bp-divida-lp": ["Empréstimos e Financiamentos - LP"],
    "bp-pl": ["Patrimônio Líquido"],
  };
  const bpHist: Record<string, Record<string, number>> = {};
  for (const [linhaId, contas] of Object.entries(MAPA_BP)) {
    const vals: Record<string, number> = {};
    for (const p of periodos) {
      const v = soma(contas, p);
      if (Math.abs(v) > 0) vals[p] = v;
    }
    if (Object.keys(vals).length) bpHist[linhaId] = vals;
  }
  // Itens de balanço do bloco giro (seed veio do próprio BP histórico): casa por NOME.
  const blocoGiro = await prisma.modelBlock.findFirst({ where: { modelId: model.id, tipo: "giro" } });
  const itensBalanco = ((blocoGiro?.config ?? {}) as { itensBalanco?: Array<{ id: string; nome: string }> }).itensBalanco ?? [];
  for (const item of itensBalanco) {
    const linha = bpExt.find((l) => l.conta.trim().toLowerCase() === item.nome.trim().toLowerCase());
    if (!linha) continue;
    const vals: Record<string, number> = {};
    for (const p of periodos) {
      const v = Math.abs(linha.valores?.[p] ?? 0);
      if (v > 0) vals[p] = v;
    }
    if (Object.keys(vals).length) bpHist[`bp-item-${item.id}`] = vals;
  }

  // FC histórico (método indireto, com prova de fechamento vs ΔCaixa do BP).
  let fcHist: Record<string, Record<string, number>> = {};
  let periodosFC: string[] = [];
  let avisoFC: string | null = null;
  if (periodos.length >= 2 && de.dre?.length) {
    const fc = buildIndirectCashFlow(bpExt as never, de.dre as never, periodos);
    if (fc) {
      periodosFC = fc.colunas;
      // Linhas nomeadas do FC indireto do IBR → linhas do FC projetado (mesma
      // estrutura): Lucro Líquido do período e D&A não-caixa acompanham o
      // realizado (antes ficavam "—" na aba DFs).
      const linhaFC = (busca: RegExp): Record<string, number> | null => {
        const l = (fc.fco ?? []).find((x) => busca.test(x.nome));
        return l ? l.valores : null;
      };
      const llHist = linhaFC(/lucro l[ií]quido/i);
      const daHist = linhaFC(/deprecia/i);
      fcHist = {
        ...(llHist ? { "fc-resultado": llHist } : {}),
        ...(daHist ? { "fc-depreciacao": daHist } : {}),
        "fc-fco": fc.totais.fco,
        "fc-fci": fc.totais.fci,
        "fc-fcf": fc.totais.fcf,
        "fc-variacao": fc.totais.geracaoTotal,
        "fc-caixa-inicio": Object.fromEntries(fc.prova.map((pr) => [pr.periodo, pr.caixaInicial])),
        "fc-caixa-fim": Object.fromEntries(fc.prova.map((pr) => [pr.periodo, pr.caixaFinal])),
      };
      const naoFecha = fc.prova.filter((pr) => !pr.fecha);
      if (naoFecha.length) avisoFC = `FC indireto não fecha com o ΔCaixa em: ${naoFecha.map((pr) => pr.periodo).join(", ")} — confira a extração desses períodos.`;
    }
  } else if (periodos.length < 2) {
    avisoFC = "Fluxo de caixa histórico precisa de 2+ balanços consecutivos — este modelo tem 1 período extraído.";
  }

  res.json({ temHistorico: true, periodosBP: periodos, periodosFC, bp: bpHist, fc: fcHist, avisoFC });
});

// GET /models/:id/indicadores?custoCapital=0.18 — INDICADORES DO MODELO NO
// CATÁLOGO DO IBR (pedido do usuário, 24/07/2026: "precisa ser espelho do IBR,
// mesmos cálculos, estrutura, tudo").
//
// A conta não é refeita aqui: a projeção é traduzida para o par (BP, DRE) que o
// IBR consome e passa pelo MESMO `calculateIndicators`. Quem alterar uma fórmula
// do IBR altera as duas pontas de uma vez — é o ponto de espelhar por construção
// em vez de manter duas listas parecidas.
//
// `custoCapital` (decimal) alimenta o EVA e vem do WACC calculado na tela; sem
// ele o EVA fica null em vez de sair com um WACC inventado.
router.get("/:id/indicadores", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const calc = await calcularEGravar(model.id);
  if (!calc) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const anos = [...new Set(calc.resultado.meses.map((m) => m.slice(0, 4)))].sort();
  const bruto = Number(req.query.custoCapital);
  // Sanidade: um WACC fora de (0, 2] é erro de unidade (18 em vez de 0,18) —
  // aceitar levaria a um EVA absurdo com cara de número calculado.
  const custoCapital = Number.isFinite(bruto) && bruto > 0 && bruto <= 2 ? bruto : undefined;
  // Semáforos e visibilidade vêm da MESMA configuração do IBR (tela
  // /indicadores): espelho também nas faixas, não só nas fórmulas. `ativo:false`
  // esconde da tela sem parar o cálculo — a regra que já vale no IBR.
  const catalogo = await catalogoPadraoEfetivo();
  const semaforoOverrides: Record<string, SemaforoDef> = {};
  const ocultos: string[] = [];
  for (const row of catalogo) {
    if (!row.ativo) ocultos.push(row.nome);
    if (row.semDirecao === "menor_ruim" || row.semDirecao === "maior_ruim") {
      if (typeof row.semCritico === "number" && typeof row.semAtencao === "number") {
        semaforoOverrides[row.nome] = { direcao: row.semDirecao, critico: row.semCritico, atencao: row.semAtencao };
      }
    }
  }
  // HISTÓRICO NA MESMA TABELA (pedido do usuário, 24/07/2026): os DFs realizados
  // do IBR-fonte entram como colunas adicionais e passam pelo MESMO
  // calculateIndicators — é o que torna legítima a leitura horizontal
  // "realizado → projetado" de cada indicador.
  let historico: HistoricoDfsIbr | undefined;
  if (model.analysisSeedId) {
    const analysis = await prisma.analysis.findUnique({
      where: { id: model.analysisSeedId }, select: { dadosEstruturados: true },
    });
    const de = analysis?.dadosEstruturados as HistoricoDfsIbr | null;
    if (de?.periodos?.length && de.bp?.length) historico = de;
  }
  const espelho = indicadoresIbrDoModelo(calc.resultado, anos, { custoCapital, semaforoOverrides, historico });
  res.json({
    periodos: espelho.periodos,
    periodosHistoricos: espelho.periodosHistoricos,
    mesesPorPeriodo: espelho.mesesPorPeriodo,
    custoCapital: custoCapital ?? null,
    cenario: calc.cenario,
    ocultos,
    indicadores: espelho.indicadores,
    // Macro REALIZADO (BCB/SGS) nos mesmos anos do histórico da empresa, para o
    // quadro macro contar a mesma história de ponta a ponta.
    macroRealizado: espelho.periodosHistoricos.length
      ? await indicesRealizadosPorAno(espelho.periodosHistoricos).catch(() => null)
      : null,
  });
});

// GET /models/:id/historico-divida — saldo de Empréstimos e Financiamentos
// (CP+LP) do último balanço extraído: âncora do contrato "dívida existente".
router.get("/:id/historico-divida", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  if (!model.analysisSeedId) { res.json({ periodo: null, itens: [], total: 0 }); return; }
  const analysis = await prisma.analysis.findUnique({ where: { id: model.analysisSeedId }, select: { dadosEstruturados: true } });
  res.json(derivarDividaHistorico(analysis?.dadosEstruturados ?? null));
});

// GET /models/:id/por-unidade — DRE POR UNIDADE (F1 do orçamento dimensional).
// Deriva do resultado consolidado + etiquetas das linhas + estrutura da empresa
// (unidades e CCs; CSC rateado). Nunca uma segunda contabilidade: a prova de
// partição (Σ unidades + não atribuído = consolidado) vai junto na resposta.
router.get("/:id/por-unidade", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }

  const [unidades, centros] = await Promise.all([
    prisma.unidadeNegocio.findMany({ where: { companyId: model.companyId }, orderBy: [{ ordem: "asc" }, { createdAt: "asc" }] }),
    prisma.centroCusto.findMany({ where: { companyId: model.companyId }, orderBy: [{ ordem: "asc" }, { createdAt: "asc" }] }),
  ]);
  if (unidades.filter((u) => u.ativo).length === 0) {
    res.json({ semEstrutura: true, unidades: [], centros: [], resultado: null });
    return;
  }

  // Etiquetas: vivem na config das linhas dos blocos (unidadeId/centroCustoId).
  const blocks = await prisma.modelBlock.findMany({ where: { modelId: model.id } });
  const tags: Record<string, { unidadeId?: string | null; centroCustoId?: string | null }> = {};
  const posicoesFolha: Array<{ id: string; nome: string; classificacao: "custo" | "despesa"; unidadeId?: string | null; centroCustoId?: string | null }> = [];
  for (const b of blocks) {
    const cfg = (b.config ?? {}) as { linhasReceita?: Array<Record<string, unknown>>; linhasCusto?: Array<Record<string, unknown>>; posicoes?: Array<Record<string, unknown>> };
    for (const l of [...(cfg.linhasReceita ?? []), ...(cfg.linhasCusto ?? [])]) {
      const id = typeof l.id === "string" ? l.id : null;
      if (!id) continue;
      const unidadeId = typeof l.unidadeId === "string" ? l.unidadeId : null;
      const centroCustoId = typeof l.centroCustoId === "string" ? l.centroCustoId : null;
      if (unidadeId || centroCustoId) tags[id] = { unidadeId, centroCustoId };
    }
    // FOLHA POR UNIDADE (F2): as posições etiquetadas do bloco Pessoas.
    if (b.tipo === "folha") {
      for (const p of cfg.posicoes ?? []) {
        if (typeof p.id !== "string" || typeof p.nome !== "string") continue;
        posicoesFolha.push({
          id: p.id, nome: p.nome,
          classificacao: p.classificacao === "custo" ? "custo" : "despesa",
          unidadeId: typeof p.unidadeId === "string" ? p.unidadeId : null,
          centroCustoId: typeof p.centroCustoId === "string" ? p.centroCustoId : null,
        });
      }
    }
  }

  const cache = model.resultadoCache as (ResultadoModelo & { calculadoEm?: string }) | null;
  const calc = cache?.dre ? { resultado: cache } : await calcularEGravar(model.id);
  if (!calc?.resultado?.dre) { res.status(409).json({ error: "O modelo ainda não tem resultado calculado." }); return; }

  // A folha dobra numa linha agregada — decompõe nas posições etiquetadas
  // (série por posição vem do próprio motor) antes de distribuir.
  const folha = decomporFolha(calc.resultado.dre, posicoesFolha, calc.resultado.series ?? {});

  const resultado = calcularPorUnidade({
    dre: folha.dre,
    tags: { ...tags, ...folha.tagsExtras },
    unidades: unidades.map((u) => ({ id: u.id, nome: u.nome, ehMatriz: u.ehMatriz, ativo: u.ativo })),
    centros: centros.map((c) => ({ id: c.id, nome: c.nome, unidadeId: c.unidadeId, rateio: c.rateio as RateioCC | null, ativo: c.ativo })),
    meses: calc.resultado.meses,
  });

  // Nome do responsável por unidade (F4) — o cabeçalho da coluna mostra quem
  // preenche aquela unidade.
  const idsResp = [...new Set(unidades.map((u) => u.responsavelUserId).filter((v): v is string => !!v))];
  const nomesResp = idsResp.length
    ? new Map((await prisma.user.findMany({ where: { id: { in: idsResp } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
    : new Map<string, string>();

  res.json({
    semEstrutura: false,
    unidades: unidades.map((u) => ({ ...u, responsavelNome: u.responsavelUserId ? nomesResp.get(u.responsavelUserId) ?? null : null })),
    centros,
    meses: calc.resultado.meses,
    resultado,
    // Proveniência (regra da casa): data + fonte em todo output.
    geradoEm: new Date().toISOString(),
    fonte: "derivado do resultado consolidado do modelo + estrutura organizacional da empresa",
  });
});

/** Realizado do modelo com o histórico por linha do seed (referências da grade). */
type RealizadoComHistorico = RealizadoModelo & {
  historicoAnual?: { receitaPorLinha?: Record<string, Record<string, number>>; custoPorLinha?: Record<string, Record<string, number>> };
};

// GET /models/:id/grade — GRADE ORÇAMENTÁRIA (F5): a visão de trabalho do
// orçamento — árvore unidade → CC → contas com os meses resolvidos, o realizado
// de referência (mensal quando o balancete acoplou; anual do seed) e o modo de
// cada linha. Leitura pura: edições seguem pelo PUT de bloco (travas F4 +
// histórico + trilha num caminho só).
/** Linha de receita "simples" = um nó série só (o valor é digitado direto).
 *  Com mais de um nó, há árvore de drivers (qtd × preço, clientes × ticket…) e
 *  o número passa a vir da aba Receitas. */
function receitaTemDetalhe(l: Record<string, unknown>): boolean {
  const nodes = Array.isArray(l.nodes) ? (l.nodes as Array<Record<string, unknown>>) : [];
  if (nodes.length > 1) return true;
  const raiz = nodes[0];
  return !!raiz && raiz.tipo === "formula";
}

/** Série digitada no nó raiz de uma receita simples (params.valores). */
function valoresDoNoRaiz(l: Record<string, unknown>): Record<string, number> {
  const nodes = Array.isArray(l.nodes) ? (l.nodes as Array<Record<string, unknown>>) : [];
  const raiz = nodes.find((n) => n.id === l.nodeRaiz) ?? nodes[0];
  const params = (raiz?.params ?? {}) as Record<string, unknown>;
  const valores = params.valores;
  return valores && typeof valores === "object" ? (valores as Record<string, number>) : {};
}

router.get("/:id/grade", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }

  const [unidades, centros, blocks] = await Promise.all([
    prisma.unidadeNegocio.findMany({ where: { companyId: model.companyId }, orderBy: [{ ordem: "asc" }, { createdAt: "asc" }] }),
    prisma.centroCusto.findMany({ where: { companyId: model.companyId }, orderBy: [{ ordem: "asc" }, { createdAt: "asc" }] }),
    prisma.modelBlock.findMany({ where: { modelId: model.id }, orderBy: { ordem: "asc" } }),
  ]);

  const cache = model.resultadoCache as (ResultadoModelo & { calculadoEm?: string; cenario?: string }) | null;
  const calc = cache?.dre ? { resultado: cache } : await calcularEGravar(model.id);
  if (!calc?.resultado?.dre) { res.status(409).json({ error: "O modelo ainda não tem resultado calculado." }); return; }
  const drePorLinha = new Map(calc.resultado.dre.map((l) => [l.id, l]));

  const folhaAssumida = new Set((calc.resultado.linhasFolhaSubstituidas ?? []).map((l) => l.id));
  const realizado = (model.realizado ?? {}) as unknown as RealizadoComHistorico;
  const refMensalPorLinha = realizado.porLinha ?? {};
  const refAnualReceita = realizado.historicoAnual?.receitaPorLinha ?? {};
  const refAnualCusto = realizado.historicoAnual?.custoPorLinha ?? {};

  const grupos = blocks
    .filter((b) => b.ativo && ["receitas", "custos", "despesas"].includes(b.tipo))
    .map((b) => {
      const cfg = (b.config ?? {}) as { linhasReceita?: Array<Record<string, unknown>>; linhasCusto?: Array<Record<string, unknown>> };
      const linhas = [...(cfg.linhasReceita ?? []), ...(cfg.linhasCusto ?? [])].flatMap((l) => {
        if (typeof l.id !== "string" || typeof l.nome !== "string") return [];
        const refAnual = refAnualDaLinha((b.tipo === "receitas" ? refAnualReceita : refAnualCusto)[l.id]);
        return [{
          id: l.id,
          nome: l.nome,
          modo: typeof l.modo === "string" ? l.modo : b.tipo === "receitas" ? "driver" : null,
          pct: typeof l.pct === "number" ? l.pct : null,
          unidadeId: typeof l.unidadeId === "string" ? l.unidadeId : null,
          centroCustoId: typeof l.centroCustoId === "string" ? l.centroCustoId : null,
          grupoDre: typeof l.grupoDre === "string" ? l.grupoDre : null,
          // Plano de contas do CLIENTE: código próprio + para onde a conta
          // rola no modelo canônico (o "de-para" que a controladoria cobra).
          codigo: typeof l.codigo === "string" ? l.codigo : null,
          destino: l.destino && typeof l.destino === "object" ? (l.destino as { conta: string; sinal: string }) : null,
          /** Receita: nó onde o valor digitado mora (a grade escreve nele). */
          nodeRaiz: typeof l.nodeRaiz === "string" ? l.nodeRaiz : null,
          // O número que o motor gravou — a grade mostra a VERDADE do cálculo.
          // Linha com DE-PARA some da DRE (soma dentro da conta canônica): o
          // valor dela vem de linhasCalculadas, senão a grade mostrava "—" numa
          // conta preenchida (defeito relatado em 27/07/2026).
          // Linha de folha que a aba PESSOAS assumiu: a grade mostra o número
          // DE LÁ (não o zero do cálculo nem o digitado, que fica guardado).
          valores: folhaAssumida.has(l.id)
            ? (calc.resultado.folhaPorCentro?.[String(l.centroCustoId)] ?? {})
            : drePorLinha.get(l.id)?.valores ?? calc.resultado.linhasCalculadas?.[l.id] ?? {},
          /** "pessoas" = vem da aba Pessoas; "receitas" = tem detalhe por driver
           *  na aba Receitas; ausente = vale o que está digitado aqui. */
          origem: folhaAssumida.has(l.id) ? "pessoas" : (b.tipo === "receitas" && receitaTemDetalhe(l)) ? "receitas" : null,
          // Meses digitados (mês-que-manda): a grade marca o que é FATO digitado.
          // Na receita SIMPLES o digitado mora no nó raiz, não em `valores`.
          digitados: b.tipo === "receitas"
            ? (valoresDoNoRaiz(l) as Record<string, number>)
            : ((l.valores && typeof l.valores === "object" ? l.valores : {}) as Record<string, number>),
          refMensal: refMensalPorLinha[l.id] ?? null,
          refAnual,
          // RECEITA (28/07/2026): linha SEM detalhe (um nó série só) se digita
          // aqui mesmo — é o caso da empresa que ainda não projeta por driver.
          // Com árvore de drivers, o número vem da aba Receitas e aqui é leitura.
          editavel: b.tipo !== "receitas" || !receitaTemDetalhe(l),
        }];
      });
      return { blocoId: b.id, tipo: b.tipo, nome: b.nome, linhas };
    });

  res.json({
    anos: [...new Set(calc.resultado.meses.map((m) => m.slice(0, 4)))],
    anoExercicio: model.mesInicial.slice(0, 4),
    mesInicial: model.mesInicial,
    horizonteMeses: model.horizonteMeses,
    unidades: unidades.filter((u) => u.ativo),
    centros: centros.filter((c) => c.ativo),
    grupos,
    // DEDUÇÕES DA RECEITA (descontos, cancelamentos, devoluções): % sobre a
    // receita bruta. Vive no bloco de receitas e agora também se edita aqui —
    // "não achei no orçamento" (28/07/2026).
    deducoes: (() => {
      const bRec = blocks.find((b) => b.ativo && b.tipo === "receitas");
      const cfg = (bRec?.config ?? {}) as { deducoesPct?: number; deducoesPctPorAno?: Record<string, number> };
      return bRec ? { blocoId: bRec.id, pct: cfg.deducoesPct ?? 0, pctPorAno: cfg.deducoesPctPorAno ?? {} } : null;
    })(),
    mesesRealizados: realizado.meses ?? [],
    geradoEm: new Date().toISOString(),
    fonte: `cenário ${cache?.cenario ?? "Base"} · motor Quantua (determinístico)`,
  });
});

// POST /models/:id/grade/regra — calcula a REGRA RÁPIDA de uma linha e devolve
// a série (SEM gravar): "repetir ano anterior", "+X%", "anual com sazonalidade",
// "% da receita". A gravação é do cliente via PUT de bloco — um caminho só para
// travas e trilha. body: { blocoId, linhaId, regra, ano, pct?, valorAnual? }
router.post("/:id/grade/regra", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const { blocoId, linhaId, regra, ano, pct, valorAnual } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof blocoId !== "string" || typeof linhaId !== "string" || typeof ano !== "string" ||
      !["repetir", "mais-pct", "anual-sazonal", "pct-receita"].includes(String(regra))) {
    res.status(400).json({ error: "blocoId, linhaId, ano e regra (repetir | mais-pct | anual-sazonal | pct-receita) são obrigatórios" });
    return;
  }
  const bloco = await prisma.modelBlock.findFirst({ where: { id: blocoId, modelId: model.id } });
  if (!bloco) { res.status(404).json({ error: "Bloco não encontrado" }); return; }

  const mesesAlvo = mesesDoAnoNoHorizonte(model.mesInicial, model.horizonteMeses, ano);
  if (mesesAlvo.length === 0) { res.status(400).json({ error: `O ano ${ano} está fora do horizonte do modelo.` }); return; }

  const realizado = (model.realizado ?? {}) as unknown as RealizadoComHistorico;
  const anualPorLinha = bloco.tipo === "receitas"
    ? realizado.historicoAnual?.receitaPorLinha?.[linhaId]
    : realizado.historicoAnual?.custoPorLinha?.[linhaId];
  const resultado = aplicarRegraGrade({
    regra: regra as RegraGrade,
    mesesAlvo,
    refMensal: realizado.porLinha?.[linhaId] ?? null,
    refAnual: refAnualDaLinha(anualPorLinha)?.valor ?? null,
    pct: typeof pct === "number" ? pct : undefined,
    valorAnual: typeof valorAnual === "number" ? valorAnual : undefined,
  });
  res.json({ ...resultado, mesesAlvo });
});

// POST /models/:id/esqueleto — COMEÇAR DE ALGUM LUGAR (27/07/2026): cria os
// centros de custo das áreas (na empresa, se ainda não existirem) e as contas
// mais comuns de cada uma. Só ACRESCENTA: unidade/CC com o mesmo nome não é
// recriado e conta repetida é ignorada (o mesmo dedupe da importação).
router.post("/:id/esqueleto", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  { const trava = travaEdicao(model); if (trava) { res.status(409).json({ error: trava }); return; } }

  const [unidades, centros] = await Promise.all([
    prisma.unidadeNegocio.findMany({ where: { companyId: model.companyId, ativo: true } }),
    prisma.centroCusto.findMany({ where: { companyId: model.companyId, ativo: true } }),
  ]);

  // 1) Unidade: só cria se a empresa não tiver NENHUMA (não mexe em estrutura feita).
  let unidadeAlvo = unidades.find((u) => u.ehMatriz) ?? unidades[0] ?? null;
  const criouUnidade = !unidadeAlvo;
  if (!unidadeAlvo) {
    unidadeAlvo = await prisma.unidadeNegocio.create({
      data: { companyId: model.companyId, nome: UNIDADE_PADRAO, ehMatriz: true, ordem: 0 },
    });
  }

  // 2) Centros de custo que faltam, na unidade alvo. O que a empresa já tem
  // com OUTRO nome ("RH" para "Recursos Humanos") não é recriado — as contas
  // vão para o CC dela (centroEquivalente).
  const nomesExistentes = centros.map((c) => c.nome);
  const criados: string[] = [];
  for (const [i, cc] of CENTROS_PADRAO.entries()) {
    if (centroEquivalente(cc.nome, nomesExistentes)) continue;
    await prisma.centroCusto.create({
      data: { companyId: model.companyId, unidadeId: unidadeAlvo.id, nome: cc.nome, ordem: centros.length + i },
    });
    criados.push(cc.nome);
    nomesExistentes.push(cc.nome);
  }

  await registrarAuditoria({
    userId: req.userId!, entity: "financial_model", entityId: model.id, field: "esqueleto do orçamento",
    after: { unidadeCriada: criouUnidade ? unidadeAlvo.nome : null, centrosCriados: criados },
    source: "models",
  });

  // As CONTAS entram pelo mesmo caminho da importação — o cliente chama
  // /plano-contas com esta lista, então dedupe, lotação e trilha são um só.
  res.status(201).json({
    unidade: { id: unidadeAlvo.id, nome: unidadeAlvo.nome, criada: criouUnidade },
    centrosCriados: criados,
    centrosReaproveitados: CENTROS_PADRAO
      .map((cc) => ({ padrao: cc.nome, naEmpresa: centroEquivalente(cc.nome, centros.map((c) => c.nome)) }))
      .filter((x) => x.naEmpresa && x.naEmpresa !== x.padrao)
      .map((x) => `${x.padrao} → ${x.naEmpresa}`),
    contas: contasDoEsqueleto(nomesExistentes),
  });
});

// POST /models/:id/plano-contas — IMPORTA O PLANO DE CONTAS DO CLIENTE
// (27/07/2026): a empresa orça na língua dela (código + nome próprios), e cada
// conta declara para onde ROLA no modelo canônico (`destino`) e em qual centro
// de custo mora. Sem isso, "+ conta" só aceitava um nome solto e o de-para
// ficava na cabeça do analista.
//
// body: { contas: [{ codigo?, nome, tipo?: "custo"|"despesa", centroCusto?,
//                    unidade?, destino? }] }
// O cliente lê a planilha (mesma cozinha do importar-skus) e manda a lista.
// Casamento de CC/unidade por CÓDIGO ou NOME normalizado; o que não casar volta
// listado — nada entra em silêncio nem inventa lotação.
router.post("/:id/plano-contas", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  { const trava = travaEdicao(model); if (trava) { res.status(409).json({ error: trava }); return; } }

  // Duas entradas: a MATRIZ da planilha (o cliente só lê o arquivo; a
  // interpretação — cabeçalho, meses, formato do número — mora no serviço
  // testado) ou uma lista de contas já montada.
  let contas = req.body?.contas as Array<Record<string, unknown>> | undefined;
  let leitura: LeituraPlanilha | null = null;
  if (Array.isArray(req.body?.linhas)) {
    leitura = lerPlanilhaDeContas(req.body.linhas as unknown[][], String(req.body?.ano ?? model.mesInicial.slice(0, 4)));
    if (leitura.semColunaConta) {
      res.status(400).json({
        error: "Não achei a coluna com o NOME DA CONTA nesta planilha.",
        cabecalhoLido: leitura.cabecalho,
        linhaCabecalho: leitura.linhaCabecalho,
        mesesLidos: leitura.meses,
      });
      return;
    }
    contas = leitura.contas as unknown as Array<Record<string, unknown>>;
  }
  if (!Array.isArray(contas) || contas.length === 0) { res.status(400).json({ error: "Envie ao menos uma conta" }); return; }
  if (contas.length > 1000) { res.status(400).json({ error: "Máximo de 1.000 contas por importação" }); return; }

  const [unidades, centros, blocks] = await Promise.all([
    prisma.unidadeNegocio.findMany({ where: { companyId: model.companyId, ativo: true } }),
    prisma.centroCusto.findMany({ where: { companyId: model.companyId, ativo: true } }),
    prisma.modelBlock.findMany({ where: { modelId: model.id } }),
  ]);
  const blocoCusto = blocks.find((b) => b.tipo === "custos");
  const blocoDespesa = blocks.find((b) => b.tipo === "despesas");
  if (!blocoCusto || !blocoDespesa) { res.status(409).json({ error: "O modelo precisa dos blocos de custos e despesas." }); return; }

  const cfgCusto = blocoCusto.config as BlocoModelo["config"];
  const cfgDespesa = blocoDespesa.config as BlocoModelo["config"];
  const linhasCusto = [...(cfgCusto.linhasCusto ?? [])];
  const linhasDespesa = [...(cfgDespesa.linhasCusto ?? [])];

  // A DECISÃO (casamento de CC/unidade, dedupe, classificação) é pura e tem
  // testes próprios — ver plano-contas.test.ts. Aqui só persistimos o plano.
  const { criar, ignoradas, semLotacao } = planejarImportacaoPlanoContas({
    contas: contas as unknown as ContaImportada[],
    existentes: [...linhasCusto, ...linhasDespesa].map((l) => {
      const x = l as unknown as { unidadeId?: string; centroCustoId?: string };
      return { nome: l.nome, codigo: l.codigo ?? null, unidadeId: x.unidadeId ?? null, centroCustoId: x.centroCustoId ?? null };
    }),
    unidades, centros,
  });

  // DE-PARA SUGERIDO (28/07/2026): a planilha do cliente raramente traz a
  // coluna "conta canônica". Em vez de deixar a conta órfã (e o Orçado ×
  // Realizado sem par no balancete), o sistema PROPÕE pelo nome — e diz na
  // resposta quantas foram sugeridas, para o analista revisar em vez de digitar
  // 36 vezes. O que não casa fica sem de-para, visível, nunca chutado.
  const dreAtiva = await loadActiveDREModel(model.companyId);
  const canonicas = dreAtiva.lines.filter((l) => !l.subtotal).map((l) => l.conta);
  const sugeridas: string[] = [];

  const stamp = Date.now().toString(36);
  const criadas = criar.map((c, i) => {
    const sugestao = c.destino ? null : sugerirContaCanonica(c.nome, canonicas, { grupo: c.ehCusto ? "custo" : "despesa" });
    const destino = c.destino ?? sugestao?.conta ?? null;
    if (sugestao) sugeridas.push(`${c.nome} → ${sugestao.conta}`);
    const linha = {
      id: `pc${stamp}_${i}`,
      nome: c.nome,
      ...(c.codigo ? { codigo: c.codigo } : {}),
      modo: "serie" as const,
      valores: c.valores,
      ...(c.centroCustoId ? { centroCustoId: c.centroCustoId } : {}),
      ...(c.unidadeId ? { unidadeId: c.unidadeId } : {}),
      ...(destino ? { destino: { conta: destino, sinal: "soma" as const } } : {}),
    };
    (c.ehCusto ? linhasCusto : linhasDespesa).push(linha);
    return {
      codigo: c.codigo, nome: c.nome, tipo: c.ehCusto ? "custo" : "despesa", lotacao: c.lotacao,
      meses: Object.keys(c.valores).length,
      total: Object.values(c.valores).reduce((s, v) => s + v, 0),
      destino, destinoSugerido: !c.destino && !!sugestao,
    };
  });

  if (criadas.length === 0) {
    res.status(409).json({ error: "Nenhuma conta nova — todas já existem no modelo.", ignoradas, semLotacao });
    return;
  }

  await prisma.$transaction([
    prisma.modelBlock.update({ where: { id: blocoCusto.id }, data: { config: { ...cfgCusto, linhasCusto } as object } }),
    prisma.modelBlock.update({ where: { id: blocoDespesa.id }, data: { config: { ...cfgDespesa, linhasCusto: linhasDespesa } as object } }),
  ]);
  await registrarAuditoria({
    userId: req.userId!, entity: "financial_model", entityId: model.id, field: "plano de contas importado",
    after: { criadas: criadas.length, ignoradas: ignoradas.length, semLotacao: semLotacao.length, amostra: criadas.slice(0, 10).map((x) => `${x.codigo ?? "—"} ${x.nome} (${x.lotacao})`) },
    source: "models",
  });
  // MÊS FORA DO HORIZONTE: a planilha pode falar de jan/26 num modelo que começa
  // em jul/26. O valor fica gravado na linha (não se perde), mas não aparece na
  // grade nem no cálculo — sem este aviso o analista importa e acha que falhou.
  const mesesDoModelo = new Set<string>();
  {
    const [y0, m0] = model.mesInicial.split("-").map(Number);
    for (let i = 0; i < model.horizonteMeses; i++) {
      const t = (y0 as number) * 12 + ((m0 as number) - 1) + i;
      mesesDoModelo.add(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`);
    }
  }
  const mesesFora = (leitura?.meses ?? []).filter((m) => !mesesDoModelo.has(m));

  const calc = await calcularEGravar(model.id);
  res.status(201).json({
    criadas, ignoradas, semLotacao,
    /** De-para proposto pelo sistema (nome → conta canônica) e o que ficou sem:
     *  é o que o analista revisa, em vez de escolher conta a conta. */
    deParaSugerido: sugeridas,
    semDePara: criadas.filter((c) => !c.destino).map((c) => c.nome),
    // O que foi entendido da planilha — a UI mostra para o analista conferir.
    leitura: leitura ? {
      linhaCabecalho: leitura.linhaCabecalho, cabecalho: leitura.cabecalho,
      meses: leitura.meses, totaisIgnorados: leitura.totaisIgnorados, mesesFora,
      horizonte: { de: model.mesInicial, meses: model.horizonteMeses },
    } : null,
    resultado: calc?.resultado ?? null,
  });
});

// ── F6: PACOTES DE COLETA (um por unidade + corporativo) ────────────────────
// A área recebe o Excel carimbado, devolve, o sistema valida e consolida.
// Status: rascunho → enviado → validado → consolidado (reabrir = rascunho).

const STATUS_PACOTE = ["rascunho", "enviado", "validado", "consolidado"] as const;

// GET /models/:id/pacotes — um pacote por unidade ativa + o corporativo
// (CSC + não atribuído). Sem registro no banco = rascunho (virtual).
router.get("/:id/pacotes", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const [unidades, registros] = await Promise.all([
    prisma.unidadeNegocio.findMany({ where: { companyId: model.companyId, ativo: true }, orderBy: [{ ordem: "asc" }, { createdAt: "asc" }] }),
    prisma.pacoteOrcamento.findMany({ where: { modelId: model.id } }),
  ]);
  const porUnidade = new Map(registros.map((r) => [r.unidadeId ?? "__corp", r]));
  const idsResp = [...new Set(unidades.map((u) => u.responsavelUserId).filter((v): v is string => !!v))];
  const nomes = idsResp.length
    ? new Map((await prisma.user.findMany({ where: { id: { in: idsResp } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
    : new Map<string, string>();
  const linha = (unidadeId: string | null, nome: string, responsavelNome: string | null) => {
    const r = porUnidade.get(unidadeId ?? "__corp");
    return {
      unidadeId, nome, responsavelNome,
      status: r?.status ?? "rascunho",
      enviadoEm: r?.enviadoEm ?? null,
      validadoEm: r?.validadoEm ?? null,
    };
  };
  res.json({
    pacotes: [
      ...unidades.map((u) => linha(u.id, u.nome, u.responsavelUserId ? nomes.get(u.responsavelUserId) ?? null : null)),
      linha(null, "Corporativo (CSC + não atribuído)", null),
    ],
  });
});

// PUT /models/:id/pacotes/status — transição de status do pacote.
// body: { unidadeId: string | null, status }
router.put("/:id/pacotes/status", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const { unidadeId, status } = (req.body ?? {}) as { unidadeId?: string | null; status?: string };
  if (!STATUS_PACOTE.includes(status as typeof STATUS_PACOTE[number])) {
    res.status(400).json({ error: `status deve ser: ${STATUS_PACOTE.join(" | ")}` });
    return;
  }
  // Validar/consolidar é de quem CONSOLIDA (partner/reviewer). Enviar é da área.
  if (status === "validado" || status === "consolidado") {
    const u = await prisma.user.findUnique({ where: { id: req.userId! }, select: { role: true } });
    if (u?.role !== "partner" && u?.role !== "reviewer") {
      res.status(403).json({ error: "Validar/consolidar pacote é de quem consolida o orçamento (papéis partner/reviewer)." });
      return;
    }
  }
  const chave = { modelId: model.id, unidadeId: unidadeId ?? null };
  const antes = await prisma.pacoteOrcamento.findFirst({ where: chave });
  const agora = new Date();
  const dados = {
    status: status!,
    userId: req.userId!,
    ...(status === "enviado" ? { enviadoEm: agora } : {}),
    ...(status === "validado" ? { validadoEm: agora } : {}),
    ...(status === "rascunho" ? { enviadoEm: null, validadoEm: null } : {}),
  };
  const depois = antes
    ? await prisma.pacoteOrcamento.update({ where: { id: antes.id }, data: dados })
    : await prisma.pacoteOrcamento.create({ data: { ...chave, ...dados } });
  await registrarAuditoria({
    userId: req.userId!, entity: "pacote_orcamento", entityId: depois.id,
    field: "status do pacote de coleta",
    before: { status: antes?.status ?? "rascunho", unidadeId: unidadeId ?? "corporativo" },
    after: { status: depois.status }, source: "models",
  });
  res.json({ ok: true, status: depois.status });
});

// ── F10: MATRIZ GMD (pacotes de conta × unidades — dupla checagem) ──────────
// GET /models/:id/matriz-gmd?ano=2027
router.get("/:id/matriz-gmd", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const ano = /^\d{4}$/.test(String(req.query.ano ?? "")) ? String(req.query.ano) : model.mesInicial.slice(0, 4);
  const meses = mesesDoAnoNoHorizonte(model.mesInicial, model.horizonteMeses, ano);

  const [pacotes, unidades, centros, blocks] = await Promise.all([
    prisma.pacoteGmd.findMany({ where: { companyId: model.companyId, ativo: true }, orderBy: { createdAt: "asc" } }),
    prisma.unidadeNegocio.findMany({ where: { companyId: model.companyId, ativo: true }, orderBy: [{ ordem: "asc" }, { createdAt: "asc" }] }),
    prisma.centroCusto.findMany({ where: { companyId: model.companyId } }),
    prisma.modelBlock.findMany({ where: { modelId: model.id } }),
  ]);

  const cache = model.resultadoCache as (ResultadoModelo & { calculadoEm?: string }) | null;
  const calc = cache?.dre ? { resultado: cache } : await calcularEGravar(model.id);
  if (!calc?.resultado?.dre) { res.status(409).json({ error: "O modelo ainda não tem resultado calculado." }); return; }
  const valoresPorLinha = new Map(calc.resultado.dre.map((l) => [l.id, l.valores]));

  const linhas = blocks
    .filter((b) => b.ativo && (b.tipo === "custos" || b.tipo === "despesas"))
    .flatMap((b) => ((b.config ?? {}) as { linhasCusto?: Array<Record<string, unknown>> }).linhasCusto ?? [])
    .flatMap((l) => (typeof l.id === "string" && typeof l.nome === "string" ? [{
      id: l.id, nome: l.nome,
      valores: valoresPorLinha.get(l.id) ?? {},
      unidadeId: typeof l.unidadeId === "string" ? l.unidadeId : null,
      centroCustoId: typeof l.centroCustoId === "string" ? l.centroCustoId : null,
    }] : []));

  const matriz = calcularMatrizGmd({
    pacotes: pacotes.map((p) => ({ id: p.id, nome: p.nome, donoUserId: p.donoUserId, contas: (p.contas as string[]) ?? [] })),
    linhas,
    unidades,
    centros: centros.map((c) => ({ id: c.id, nome: c.nome, unidadeId: c.unidadeId }) as CentroCustoDim),
    meses,
  });

  const idsDonos = [...new Set(pacotes.map((p) => p.donoUserId).filter((v): v is string => !!v))];
  const idsResp = [...new Set(unidades.map((u) => u.responsavelUserId).filter((v): v is string => !!v))];
  const nomes = new Map((await prisma.user.findMany({ where: { id: { in: [...idsDonos, ...idsResp] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));

  res.json({
    ano, meses,
    pacotes: pacotes.map((p) => ({ id: p.id, nome: p.nome, contas: p.contas, donoNome: p.donoUserId ? nomes.get(p.donoUserId) ?? null : null })),
    unidades: unidades.map((u) => ({ id: u.id, nome: u.nome, responsavelNome: u.responsavelUserId ? nomes.get(u.responsavelUserId) ?? null : null })),
    matriz,
    // Nomes de conta do modelo — o cadastro de pacote escolhe daqui.
    contasDisponiveis: [...new Set(linhas.map((l) => l.nome))].sort((a, b) => a.localeCompare(b, "pt-BR")),
    geradoEm: new Date().toISOString(),
  });
});

// PUT /models/:id — cabeçalho (nome, visão, cenário ativo, status).
router.put("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  { const trava = travaEdicao(model); if (trava) { res.status(409).json({ error: trava }); return; } }
  const { nome, visao, cenarioAtivoId, status, horizonteMeses, mesInicial, tipoOrcamento } = req.body ?? {};
  // F9 (OBZ): o tipo do orçamento é do cabeçalho — "base-zero" liga a exigência
  // de justificativa por linha e a trava na aprovação.
  if (tipoOrcamento !== undefined && tipoOrcamento !== "incremental" && tipoOrcamento !== "base-zero") {
    res.status(400).json({ error: 'tipoOrcamento deve ser "incremental" ou "base-zero"' });
    return;
  }
  const horizonte = horizonteMeses !== undefined ? Number(horizonteMeses) : undefined;
  if (horizonte !== undefined && (!Number.isInteger(horizonte) || horizonte < 12 || horizonte > 180)) {
    res.status(400).json({ error: "horizonteMeses deve ser um inteiro entre 12 e 180" });
    return;
  }
  if (mesInicial !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(mesInicial))) {
    res.status(400).json({ error: "mesInicial deve estar no formato YYYY-MM" });
    return;
  }
  // INÍCIO RECUOU: os meses que entram no começo do horizonte ganham premissa
  // (repete para trás o primeiro mês informado de cada driver/linha) — sem isso
  // os meses novos projetam ZERO e a próxima edição materializa o zero.
  if (mesInicial !== undefined && String(mesInicial) < model.mesInicial) {
    const blocks = await prisma.modelBlock.findMany({ where: { modelId: model.id } });
    const blocos = blocks.map((b) => ({ id: b.id, tipo: b.tipo, nome: b.nome, ativo: b.ativo, config: (b.config ?? {}) as BlocoModelo["config"] })) as BlocoModelo[];
    const preenchidos = backfillPremissasAoRecuar(blocos, String(mesInicial), model.mesInicial);
    const blocosAlterados = [...new Set(preenchidos.map((p) => p.blocoId))];
    for (const blocoId of blocosAlterados) {
      const bloco = blocos.find((b) => b.id === blocoId)!;
      await prisma.modelBlock.update({ where: { id: blocoId }, data: { config: bloco.config as object } });
    }
    if (preenchidos.length) {
      await registrarAuditoria({
        userId: req.userId!, entity: "financial_model", entityId: model.id, field: "premissas-backfill",
        before: { mesInicial: model.mesInicial },
        after: { mesInicial: String(mesInicial), memoria: preenchidos.map((p) => p.memoria) },
        source: "models",
      });
    }
  }

  // status NÃO muda por aqui: o ciclo de vida tem transições e trilha próprias
  // (PUT /models/:id/status) — aceitar status solto pularia as regras.
  void status;
  const before = { nome: model.nome, visao: model.visao, cenarioAtivoId: model.cenarioAtivoId, status: model.status, horizonteMeses: model.horizonteMeses, mesInicial: model.mesInicial };
  const atualizado = await prisma.financialModel.update({
    where: { id: model.id },
    data: {
      ...(nome !== undefined ? { nome } : {}),
      ...(visao !== undefined ? { visao } : {}),
      ...(cenarioAtivoId !== undefined ? { cenarioAtivoId } : {}),
      ...(horizonte !== undefined ? { horizonteMeses: horizonte } : {}),
      ...(mesInicial !== undefined ? { mesInicial: String(mesInicial) } : {}),
      ...(tipoOrcamento !== undefined ? { tipoOrcamento } : {}),
    },
  });
  await registrarAuditoria({
    userId: req.userId!, entity: "financial_model", entityId: model.id, field: "cabeçalho",
    before, after: { nome: atualizado.nome, visao: atualizado.visao, cenarioAtivoId: atualizado.cenarioAtivoId, status: atualizado.status, horizonteMeses: atualizado.horizonteMeses, mesInicial: atualizado.mesInicial },
    source: "models",
  });
  // Trocar cenário ativo, horizonte ou mês inicial muda o resultado — recalcula na hora.
  const calc = cenarioAtivoId !== undefined || horizonte !== undefined || mesInicial !== undefined ? await calcularEGravar(model.id) : null;
  res.json({ ok: true, resultado: calc?.resultado ?? null });
});

// PUT /models/:id/blocks/:blockId — salva a config do bloco (drivers/linhas).
router.put("/:id/blocks/:blockId", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  { const trava = travaEdicao(model); if (trava) { res.status(409).json({ error: trava }); return; } }
  const block = await prisma.modelBlock.findFirst({ where: { id: req.params.blockId as string, modelId: model.id } });
  if (!block) { res.status(404).json({ error: "Bloco não encontrado" }); return; }
  const { config, modo, ativo, nome } = req.body ?? {};

  // F4 — COLABORAÇÃO POR ÁREA (25/07/2026): usuário papel OPERATOR que é
  // RESPONSÁVEL por unidade(s) desta empresa edita SÓ as linhas/posições das
  // suas unidades — linha alheia, corporativa (sem etiqueta/CSC) ou campo do
  // bloco fora das linhas é 403 com a lista do que violou. Partner e reviewer
  // seguem livres (são quem consolida); operator sem responsabilidade atribuída
  // também (compatibilidade — a restrição nasce da atribuição, não do papel).
  if (config !== undefined) {
    const editor = await prisma.user.findUnique({ where: { id: req.userId! }, select: { role: true } });
    if (editor?.role === "operator") {
      const minhasUnidades = await prisma.unidadeNegocio.findMany({
        where: { companyId: model.companyId, responsavelUserId: req.userId!, ativo: true },
        select: { id: true },
      });
      if (minhasUnidades.length > 0) {
        const centrosEmpresa = await prisma.centroCusto.findMany({ where: { companyId: model.companyId } });
        const violacoes = validarEdicaoRestrita(
          (block.config ?? {}) as Parameters<typeof validarEdicaoRestrita>[0],
          config as Parameters<typeof validarEdicaoRestrita>[1],
          new Set(minhasUnidades.map((u) => u.id)),
          centrosEmpresa.map((c) => ({ id: c.id, nome: c.nome, unidadeId: c.unidadeId }) as CentroCustoDim),
        );
        if (violacoes.length > 0) {
          res.status(403).json({
            error: `Você é responsável por unidade(s) específica(s) — esta edição sai do seu escopo: ${violacoes.slice(0, 3).join("; ")}${violacoes.length > 3 ? ` (+${violacoes.length - 3})` : ""}. Alterações corporativas são de quem consolida (partner/reviewer).`,
          });
          return;
        }
      }
    }
  }

  // LINHA DO HISTÓRICO NUNCA É EXCLUÍDA (2026-07-16): as linhas semeadas do IBR
  // carregam o realizado da Demonstração e recebem somas de outras origens
  // (headcount, destino de linhas novas). Se a config recebida REMOVEU uma
  // dessas linhas, ela volta — custo/despesa com a premissa ZERADA (só as somas
  // passam a valer); receita/driver volta como estava. Trilha registra.
  if (config !== undefined && ["custos", "despesas", "receitas"].includes(block.tipo)) {
    const hist = (model.realizado as { historicoAnual?: { custoPorLinha?: Record<string, unknown>; receitaPorLinha?: Record<string, unknown> } } | null)?.historicoAnual;
    const idsHist = new Set([...Object.keys(hist?.custoPorLinha ?? {}), ...Object.keys(hist?.receitaPorLinha ?? {})]);
    if (idsHist.size) {
      type LinhaAny = { id: string; nome: string; [k: string]: unknown };
      const cfgNova = config as { linhasCusto?: LinhaAny[]; linhasReceita?: LinhaAny[] };
      const cfgVelha = block.config as { linhasCusto?: LinhaAny[]; linhasReceita?: LinhaAny[] };
      const existeNaNova = (id: string) =>
        (cfgNova.linhasCusto ?? []).some((l) => l.id === id) || (cfgNova.linhasReceita ?? []).some((l) => l.id === id);
      const restauradas: string[] = [];
      for (const antiga of cfgVelha.linhasCusto ?? []) {
        if (!idsHist.has(antiga.id) || existeNaNova(antiga.id)) continue;
        (cfgNova.linhasCusto ??= []).push({ id: antiga.id, nome: antiga.nome, modo: "pctReceita", pct: 0 });
        restauradas.push(String(antiga.nome));
      }
      for (const antiga of cfgVelha.linhasReceita ?? []) {
        if (!idsHist.has(antiga.id) || existeNaNova(antiga.id)) continue;
        (cfgNova.linhasReceita ??= []).push(antiga);
        restauradas.push(String(antiga.nome));
      }
      if (restauradas.length) {
        void registrarAuditoria({
          userId: req.userId!, analysisId: model.analysisSeedId ?? null, entity: "financial_model_block", entityId: block.id,
          field: "linha do histórico preservada (exclusão vira zerar)", after: { linhas: restauradas }, source: "models",
        });
      }
    }
  }

  const atualizado = await prisma.modelBlock.update({
    where: { id: block.id },
    data: {
      ...(config !== undefined ? { config: config as object } : {}),
      ...(modo !== undefined ? { modo } : {}),
      ...(ativo !== undefined ? { ativo } : {}),
      ...(nome !== undefined ? { nome } : {}),
    },
  });
  await registrarAuditoria({
    userId: req.userId!, entity: "financial_model_block", entityId: block.id, field: `bloco ${block.tipo}`,
    before: { modo: block.modo, ativo: block.ativo, config: block.config },
    after: { modo: atualizado.modo, ativo: atualizado.ativo, config: atualizado.config },
    source: "models",
  });
  const calc = await calcularEGravar(model.id);
  res.json({ ok: true, resultado: calc?.resultado ?? null });
});

// POST /models/:id/blocks/:blockId/linhas — adiciona LINHA DE RECEITA (produto)
// a partir de um template; a empresa pode ter vários produtos somando a receita.
router.post("/:id/blocks/:blockId/linhas", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  { const trava = travaEdicao(model); if (trava) { res.status(409).json({ error: trava }); return; } }
  const block = await prisma.modelBlock.findFirst({ where: { id: req.params.blockId as string, modelId: model.id } });
  if (!block || block.tipo !== "receitas") { res.status(404).json({ error: "Bloco de receitas não encontrado" }); return; }
  const { template, nome } = req.body ?? {};
  const config = block.config as BlocoModelo["config"];
  const linhaId = `lin${Date.now().toString(36)}`;
  const linha = montarLinhaReceita(template || "generico", linhaId, nome || "Nova linha de receita");
  const linhas = [...(config.linhasReceita ?? []), linha];
  await prisma.modelBlock.update({ where: { id: block.id }, data: { config: { ...config, linhasReceita: linhas } as object } });
  await registrarAuditoria({
    userId: req.userId!, entity: "financial_model_block", entityId: block.id, field: "linha de receita adicionada",
    after: { linhaId, nome: linha.nome, template: template || "generico" }, source: "models",
  });
  const calc = await calcularEGravar(model.id);
  res.status(201).json({ linha, resultado: calc?.resultado ?? null });
});

// POST /models/:id/blocks/:blockId/linhas/importar-skus — COMÉRCIO (F7 do
// plano): centenas de produtos × preço médio entram por PLANILHA; o app agrega
// por categoria e manda a série mensal pronta + a memória de SKUs. Cada
// categoria vira UMA linha de receita (série mensal editável na tela), com a
// lista de SKUs guardada como proveniência (skuDetalhe) — o BP consolida na
// conta canônica, o detalhe fica auditável.
router.post("/:id/blocks/:blockId/linhas/importar-skus", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  { const trava = travaEdicao(model); if (trava) { res.status(409).json({ error: trava }); return; } }
  const block = await prisma.modelBlock.findFirst({ where: { id: req.params.blockId as string, modelId: model.id } });
  if (!block || block.tipo !== "receitas") { res.status(404).json({ error: "Bloco de receitas não encontrado" }); return; }

  const categorias = req.body?.categorias as Array<{
    nome?: unknown; valores?: unknown; skus?: unknown;
  }> | undefined;
  if (!Array.isArray(categorias) || categorias.length === 0 || categorias.length > 100) {
    res.status(400).json({ error: "Envie de 1 a 100 categorias" }); return;
  }

  const config = block.config as BlocoModelo["config"];
  const linhas = [...(config.linhasReceita ?? [])];
  const criadas: Array<{ id: string; nome: string; skus: number }> = [];
  const stamp = Date.now().toString(36);
  for (let i = 0; i < categorias.length; i++) {
    const cat = categorias[i]!;
    const nome = String(cat.nome ?? "").trim().slice(0, 120);
    const valoresRaw = (cat.valores ?? {}) as Record<string, unknown>;
    if (!nome) { res.status(400).json({ error: `Categoria ${i + 1} sem nome` }); return; }
    const valores: Record<string, number> = {};
    for (const [mes, v] of Object.entries(valoresRaw)) {
      if (!/^\d{4}-\d{2}$/.test(mes)) continue;
      const n = Number(v);
      if (Number.isFinite(n)) valores[mes] = n;
    }
    if (Object.keys(valores).length === 0) {
      res.status(400).json({ error: `Categoria "${nome}" sem nenhum mês com valor` }); return;
    }
    const skus = Array.isArray(cat.skus)
      ? (cat.skus as Array<Record<string, unknown>>).slice(0, 500).map((s) => ({
          nome: String(s.nome ?? "").slice(0, 120),
          preco: Number(s.preco) || 0,
          qtd: Number(s.qtd) || 0,
        }))
      : undefined;
    const linhaId = `lin${stamp}sku${i}`;
    linhas.push({
      id: linhaId,
      nome,
      template: "generico",
      nodeRaiz: `${linhaId}_receita`,
      skuDetalhe: skus,
      nodes: [{
        id: `${linhaId}_receita`, tipo: "serie", nome: `Memória de Cálculo — ${nome}`, unidade: "R$",
        params: { modoPreenchimento: "mes", valores, valorMensal: 0, crescimentoAnual: 0 },
      }],
    });
    criadas.push({ id: linhaId, nome, skus: skus?.length ?? 0 });
  }

  await prisma.modelBlock.update({ where: { id: block.id }, data: { config: { ...config, linhasReceita: linhas } as object } });
  await registrarAuditoria({
    userId: req.userId!, entity: "financial_model_block", entityId: block.id, field: "importação de SKUs (receita em massa)",
    after: { categorias: criadas.map((c) => `${c.nome} (${c.skus} SKUs)`) }, source: "models",
  });
  const calc = await calcularEGravar(model.id);
  res.status(201).json({ criadas, resultado: calc?.resultado ?? null });
});

// PUT /models/:id/blocks/:blockId/linhas/:linhaId/template — TROCA o jeito de
// faturar da linha: reconstrói a árvore de drivers do template novo, mantendo o
// nome do produto. Os números da linha voltam ao padrão (avisado na UI).
router.put("/:id/blocks/:blockId/linhas/:linhaId/template", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  { const trava = travaEdicao(model); if (trava) { res.status(409).json({ error: trava }); return; } }
  const block = await prisma.modelBlock.findFirst({ where: { id: req.params.blockId as string, modelId: model.id } });
  if (!block || block.tipo !== "receitas") { res.status(404).json({ error: "Bloco de receitas não encontrado" }); return; }
  const config = block.config as BlocoModelo["config"];
  const linhaAtual = (config.linhasReceita ?? []).find((l) => l.id === req.params.linhaId);
  if (!linhaAtual) { res.status(404).json({ error: "Linha não encontrada" }); return; }
  const { template } = req.body ?? {};
  const nova = montarLinhaReceita(template || "generico", linhaAtual.id, linhaAtual.nome);
  const linhas = (config.linhasReceita ?? []).map((l) => (l.id === linhaAtual.id ? nova : l));
  await prisma.modelBlock.update({ where: { id: block.id }, data: { config: { ...config, linhasReceita: linhas } as object } });
  await registrarAuditoria({
    userId: req.userId!, entity: "financial_model_block", entityId: block.id, field: "tipo de projeção da linha",
    before: { linhaId: linhaAtual.id, template: linhaAtual.template }, after: { linhaId: linhaAtual.id, template: template || "generico" },
    source: "models",
  });
  const calc = await calcularEGravar(model.id);
  res.json({ ok: true, resultado: calc?.resultado ?? null });
});

// POST /models/:id/blocks/:blockId/linhas/:linhaId/gerar-formula — o analista
// DESCREVE a conta em linguagem natural e a IA escreve a fórmula (Haiku, barata).
// A fórmula só volta se passar no parser + refs conhecidas (validarFormula) — a
// IA nunca grava nada: o texto vai para o EDITOR e o analista revisa/salva.
// Custo registrado na trilha (regra da casa: toda IA tem custo gravado).
router.post("/:id/blocks/:blockId/linhas/:linhaId/gerar-formula", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  { const trava = travaEdicao(model); if (trava) { res.status(409).json({ error: trava }); return; } }
  const block = await prisma.modelBlock.findFirst({ where: { id: req.params.blockId as string, modelId: model.id } });
  if (!block) { res.status(404).json({ error: "Bloco não encontrado" }); return; }
  const config = block.config as BlocoModelo["config"];
  const linha = (config.linhasReceita ?? []).find((l) => l.id === req.params.linhaId);
  if (!linha) { res.status(404).json({ error: "Linha não encontrada" }); return; }
  const descricao = String(req.body?.descricao ?? "").trim();
  if (!descricao) { res.status(400).json({ error: "Descreva a conta que você quer" }); return; }

  // Variáveis que a fórmula pode usar — a MESMA lista dos chips da tela: as da
  // linha (menos a raiz), as referências de receita (fora do bloco de receitas)
  // e as QUANTIDADES (#) de todas as linhas do modelo (headcount, contratos…).
  const variaveis: Array<{ id: string; nome: string; unidade: string }> = linha.nodes
    .filter((n) => n.id !== linha.nodeRaiz)
    .map((n) => ({ id: n.id, nome: n.nome, unidade: n.unidade }));
  // A PRÓPRIA linha (defasada): permite piso/teto vs. o mês anterior.
  variaveis.push({ id: linha.nodeRaiz, nome: "Esta linha (o próprio resultado — use SOMENTE dentro de anterior())", unidade: "R$" });
  if (block.tipo !== "receitas") {
    variaveis.push({ id: "receita_total", nome: "Receita total (soma de todas as linhas de receita)", unidade: "R$" });
    const blocosTodos = await prisma.modelBlock.findMany({ where: { modelId: model.id, ativo: true } });
    for (const b of blocosTodos) {
      for (const lr of ((b.config as BlocoModelo["config"])?.linhasReceita ?? [])) {
        if (b.tipo === "receitas") {
          variaveis.push({ id: lr.nodeRaiz, nome: `Receita — ${lr.nome}`, unidade: "R$" });
        }
        for (const n of lr.nodes) {
          if (n.unidade === "#" && n.tipo !== "formula" && n.tipo !== "fluxo" && !variaveis.some((v) => v.id === n.id)) {
            variaveis.push({ id: n.id, nome: n.nome, unidade: "#" });
          }
        }
      }
      // Pessoas por PREMISSA (folha): headcount é quantidade do negócio
      // ("custo por pessoa"). Posição por variável fica fora (deriva de outra).
      if (b.tipo === "folha") {
        const posicoesFolha = (b.config as BlocoModelo["config"]).posicoes ?? [];
        for (const pos of posicoesFolha) {
          variaveis.push({ id: `folha_${pos.id}_qtd`, nome: `Pessoas — ${pos.nome} (headcount)`, unidade: "#" });
        }
        if (posicoesFolha.length) variaveis.push({ id: "headcount_total", nome: "Pessoas — total de toda a equipe (headcount)", unidade: "#" });
      }
    }
  }
  // Índices MACRO do snapshot BCB do modelo: IGP-M/IPCA/Selic/câmbio/PIB viram
  // variáveis ("aluguel corrigido pelo IGP-M", "receita em dólar").
  const temMacro = !!(model.indicesMacro as IndicesMacroSnapshot | null)?.indices;
  if (temMacro) {
    for (const m of SERIES_MACRO) {
      variaveis.push({ id: m.id, nome: `${m.nome} — índice oficial (BCB), já em fração mensal`, unidade: "%" });
      if (m.acumId) variaveis.push({ id: m.acumId, nome: `${m.nomeAcum} — índice oficial (BCB)`, unidade: "%" });
    }
    variaveis.push({ id: MACRO_CAMBIO.id, nome: `${MACRO_CAMBIO.nome} — índice oficial (BCB)`, unidade: "R$/un" });
  }

  const prompt = `Você escreve fórmulas para um modelo financeiro que calcula MÊS a MÊS. Responda SOMENTE JSON.

VARIÁVEIS DISPONÍVEIS (na fórmula use os CÓDIGOS, nunca os nomes):
${variaveis.map((v) => `- ${v.id} = "${v.nome}" [${v.unidade}]`).join("\n")}

SINTAXE PERMITIDA: + - * / parênteses, min(a,b) = teto, max(a,b) = piso, anterior(x, n) = valor de x N meses ATRÁS (n opcional, padrão 1), futuro(x, n) = valor de x N meses À FRENTE (n opcional, padrão 1; 12 = um ano; além do horizonte vale zero), media(x, n) = média dos últimos n meses de x (incluindo o atual).
Números com ponto decimal. Variáveis [%] já são frações (10% vale 0.1) — NUNCA divida por 100.

REGRAS:
- O resultado da fórmula deve ser R$ do mês.
- Use APENAS os códigos listados. Se o pedido precisar de uma informação que não está nas variáveis, devolva {"erro": "diga em 1 frase o que falta e como criar (adicionar variável na linha)"}.
- Variação vs mês anterior: (x - anterior(x)); para considerar só crescimento, max(x - anterior(x), 0).
- "daqui a 3 meses" / "3 meses à frente" = futuro(x, 3); "3 meses atrás" = anterior(x, 3); anos: multiplique por 12.
- "no mínimo igual ao do mês anterior" = max(expressão, anterior(${linha.nodeRaiz})). O código da própria linha só pode aparecer DENTRO de anterior().
- Ligue o pedido às variáveis pelo SIGNIFICADO, aceitando sinônimos (headcount = profissionais/equipe/pessoas; variação/incremento de x = x - anterior(x); faturamento = receita). Só devolva {"erro": ...} se NENHUMA variável listada servir nem por sinônimo.
- Se o analista colar uma FÓRMULA DE EXCEL (=SE(...), MÁXIMO(), MÍNIMO(), MÉDIA(), SOMA(...)), TRADUZA para a sintaxe permitida: SE(cond;a;b) com comparação vira min/max quando possível; MÁXIMO→max; MÍNIMO→min; MÉDIA dos últimos meses→media(x, n); referências de célula viram as variáveis correspondentes pelo contexto.${temMacro ? `
- "corrigido pela inflação / IGP-M / IPCA" (aluguel, contrato, mensalidade) = valor base × macro_igpm_acum (ou macro_ipca_acum) — o FATOR ACUMULADO já compõe mês a mês; NÃO use (1+índice) solto, que reajusta um mês só.
- "em dólar" / "atrelado ao câmbio" = quantidade em US$ × macro_cambio (R$/US$ do mês).` : ""}

PEDIDO DO ANALISTA: "${descricao.replace(/"/g, "'")}"

Responda: {"formula": "...", "explicacao": "1 frase em linguagem leiga do que a fórmula faz"} ou {"erro": "..."}.`;

  const idsConhecidos = new Set(variaveis.map((v) => v.id));
  const avaliar = (d: Record<string, unknown>): { formula?: string; erroIA?: string; problema?: string } => {
    if (typeof d.erro === "string" && d.erro) return { erroIA: d.erro };
    const f = typeof d.formula === "string" ? d.formula.trim() : "";
    if (!f) return { problema: "resposta vazia" };
    const problema = validarFormula(f, idsConhecidos);
    return problema ? { formula: f, problema } : { formula: f };
  };

  // Sonnet (não Haiku): mapear "variação de profissionais" → variável certa é
  // semântica — o modelo barato errava e mandava o estagiário criar variável à toa.
  let { data, custo } = await perguntarJson(prompt, 800, "sonnet");
  let custoUsd = custo.usd;
  let r = avaliar(data);
  if (!r.erroIA && r.problema) {
    // UMA segunda chance automática com o problema apontado.
    const retry = await perguntarJson(
      `${prompt}

SUA RESPOSTA ANTERIOR FOI REJEITADA: "${r.formula ?? ""}" — problema: ${r.problema}. Corrija usando SOMENTE os códigos listados.`,
      800,
      "sonnet"
    );
    custoUsd += retry.custo.usd;
    data = retry.data;
    r = avaliar(data);
  }

  await registrarAuditoria({
    userId: req.userId!, entity: "financial_model", entityId: model.id,
    field: `fórmula por IA — linha "${linha.nome}"`,
    after: { descricao, resposta: data, custo: { modelo: custo.modelo, usd: custoUsd } },
    source: "models",
  });

  if (r.erroIA) { res.status(422).json({ error: r.erroIA, custoUsd }); return; }
  if (!r.formula || r.problema) {
    res.status(422).json({ error: `A fórmula gerada não passou na validação (${r.problema}). Tente descrever de outro jeito.`, custoUsd });
    return;
  }
  res.json({ formula: r.formula, explicacao: typeof data.explicacao === "string" ? data.explicacao : undefined, custoUsd });
});

// PUT /models/:id/scenarios/:sid — nome/overrides do cenário ("Salvar premissas").
router.put("/:id/scenarios/:sid", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  { const trava = travaEdicao(model); if (trava) { res.status(409).json({ error: trava }); return; } }
  const cenario = await prisma.modelScenario.findFirst({ where: { id: req.params.sid as string, modelId: model.id } });
  if (!cenario) { res.status(404).json({ error: "Cenário não encontrado" }); return; }
  const { nome, overrides } = req.body ?? {};
  const atualizado = await prisma.modelScenario.update({
    where: { id: cenario.id },
    data: {
      ...(nome !== undefined ? { nome } : {}),
      ...(overrides !== undefined ? { overrides: overrides as object } : {}),
    },
  });
  await registrarAuditoria({
    userId: req.userId!, entity: "financial_model_scenario", entityId: cenario.id, field: `cenário ${cenario.nome}`,
    before: { nome: cenario.nome, overrides: cenario.overrides },
    after: { nome: atualizado.nome, overrides: atualizado.overrides },
    source: "models",
  });
  const calc = cenario.id === model.cenarioAtivoId ? await calcularEGravar(model.id) : null;
  res.json({ ok: true, resultado: calc?.resultado ?? null });
});

// POST /models/:id/incluir-realizado — ANTI-VALE para modelos existentes: traz os
// meses realizados do ano de início (balancete parcial da análise-seed) para dentro
// do horizonte, recuando o início para janeiro. O ano corrente fecha inteiro.
router.post("/:id/incluir-realizado", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  { const trava = travaEdicao(model); if (trava) { res.status(409).json({ error: trava }); return; } }
  if (!model.analysisSeedId) { res.status(400).json({ error: "Modelo sem análise-fonte para buscar o realizado" }); return; }
  const analysis = await prisma.analysis.findUnique({ where: { id: model.analysisSeedId }, select: { dadosEstruturados: true } });
  const anoInicio = model.mesInicial.slice(0, 4);
  const parcial = derivarRealizadoParcial(analysis?.dadosEstruturados ?? null, anoInicio);
  if (!parcial) { res.status(404).json({ error: `A análise-fonte não tem realizado parcial de ${anoInicio}` }); return; }

  const mesAtualNum = Number(model.mesInicial.split("-")[1]);
  const recuo = mesAtualNum > 1 ? mesAtualNum - 1 : 0;
  const historicoAnual = derivarHistoricoAnual(analysis?.dadosEstruturados ?? null, [parcial.periodoFonte]);
  await prisma.financialModel.update({
    where: { id: model.id },
    data: {
      mesInicial: `${anoInicio}-01`,
      horizonteMeses: model.horizonteMeses + recuo,
      realizado: { ...(historicoAnual ? { historicoAnual } : {}), meses: parcial.meses, porGrupo: parcial.porGrupo } as object,
    },
  });
  await registrarAuditoria({
    userId: req.userId!, entity: "financial_model", entityId: model.id, field: "realizado do ano corrente incluído",
    before: { mesInicial: model.mesInicial, horizonteMeses: model.horizonteMeses },
    after: { mesInicial: `${anoInicio}-01`, horizonteMeses: model.horizonteMeses + recuo, fonte: parcial.periodoFonte, memoria: parcial.memoria },
    source: "models",
  });
  const calc = await calcularEGravar(model.id);
  res.json({ ok: true, resultado: calc?.resultado ?? null, memoria: parcial.memoria });
});

// POST /models/:id/calcular — roda o motor com o cenário ativo (ou ?scenarioId=).
router.post("/:id/calcular", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const calc = await calcularEGravar(model.id);
  res.json({ ok: true, cenario: calc?.cenario, resultado: calc?.resultado });
});

// POST /models/:id/simular — calcula com overrides AD HOC (sliders da tela de
// Cenários antes do "Salvar premissas"). Não persiste nada.
router.post("/:id/simular", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const completo = await prisma.financialModel.findUnique({
    where: { id: model.id },
    include: { blocks: { orderBy: { ordem: "asc" } } },
  });
  const resultado = calcularModelo({
    mesInicial: completo!.mesInicial,
    horizonteMeses: completo!.horizonteMeses,
    blocks: completo!.blocks.map((b) => ({ id: b.id, tipo: b.tipo, nome: b.nome, ativo: b.ativo, config: b.config as BlocoModelo["config"] })),
    overrides: (req.body?.overrides ?? {}) as ScenarioOverrides,
    realizado: (completo!.realizado as RealizadoModelo | null) ?? null,
  });
  res.json({ ok: true, resultado });
});

// POST /models/:id/monte-carlo — simulação de Monte Carlo do Valuation
// (réplica da aba Monte_Carlo da planilha padrão): sorteia as variáveis
// escolhidas com distribuição triangular simétrica e recalcula o MODELO
// INTEIRO por cenário, colhendo EV e Equity. Determinístico por seed
// (mesmo seed = mesma simulação — auditável). Não persiste nada.
router.post("/:id/monte-carlo", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const completo = await prisma.financialModel.findUnique({
    where: { id: model.id },
    include: { blocks: { orderBy: { ordem: "asc" } }, scenarios: true },
  });
  const body = req.body ?? {};
  const variaveis = (Array.isArray(body.variaveis) ? body.variaveis : []) as McVariavelSpec[];
  if (!variaveis.length || variaveis.length > 12) {
    res.status(400).json({ error: "Informe de 1 a 12 variáveis para a simulação." }); return;
  }
  const val = body.valuation ?? {};
  const wacc = Number(val.wacc);
  const g = Number(val.g);
  if (!Number.isFinite(wacc) || wacc <= 0 || !Number.isFinite(g)) {
    res.status(400).json({ error: "Envie o WACC e o g do valuation (aba Valuation)." }); return;
  }
  const n = Math.min(2000, Math.max(100, Number(body.n) || 1000));
  const seed = Number.isFinite(Number(body.seed)) && Number(body.seed) > 0 ? Number(body.seed) : (Date.now() % 2147483647);
  const cenario = completo!.scenarios.find((s) => s.id === completo!.cenarioAtivoId) ?? completo!.scenarios.find((s) => s.isBase);
  const resultado = await rodarMonteCarlo({
    base: {
      mesInicial: completo!.mesInicial,
      horizonteMeses: completo!.horizonteMeses,
      blocks: completo!.blocks.map((b) => ({ id: b.id, tipo: b.tipo, nome: b.nome, ativo: b.ativo, config: b.config as BlocoModelo["config"] })),
      realizado: (completo!.realizado as RealizadoModelo | null) ?? null,
      indicesMacro: (completo!.indicesMacro as IndicesMacroSnapshot | null) ?? null,
    },
    cenarioOverrides: (cenario?.overrides ?? {}) as ScenarioOverrides,
    variaveis: variaveis.map((v) => ({
      id: String(v.id ?? v.refId ?? v.alvo),
      nome: v.nome,
      alvo: v.alvo,
      refId: v.refId,
      sensibMin: Math.max(-0.95, Math.min(5, Number(v.sensibMin) || 0)),
      sensibMax: Math.max(-0.95, Math.min(5, Number(v.sensibMax) || 0)),
      dist: (["triangular", "pert", "normal", "lognormal", "uniforme"] as const).includes(v.dist as never) ? v.dist : undefined,
      modaPct: Number.isFinite(Number(v.modaPct)) ? Math.max(-0.95, Math.min(5, Number(v.modaPct))) : undefined,
      persistencia: Number.isFinite(Number(v.persistencia)) ? Math.max(0, Math.min(0.9, Number(v.persistencia))) : undefined,
    })),
    correlacoes: (Array.isArray(body.correlacoes) ? body.correlacoes : [])
      .filter((c: { a?: unknown; b?: unknown; rho?: unknown }) => typeof c?.a === "string" && typeof c?.b === "string" && Number.isFinite(Number(c?.rho)))
      .slice(0, 20)
      .map((c: { a: string; b: string; rho: number }) => ({ a: c.a, b: c.b, rho: Math.max(-0.95, Math.min(0.95, Number(c.rho))) })),
    lhs: body.lhs !== false,
    n, seed,
    valuation: {
      wacc, g,
      taxaImpostos: Math.max(0, Math.min(1, Number(val.taxaImpostos) || 0)),
      caixaDataBase: Math.max(0, Number(val.caixaDataBase) || 0),
      dlom: Math.max(0, Math.min(0.9, Number(val.dlom) || 0)),
      // Ponte editável (2026-07-16): o Monte Carlo usa a MESMA ponte da aba.
      dividaDataBaseManual: Number.isFinite(Number(val.dividaDataBaseManual)) && val.dividaDataBaseManual !== null && val.dividaDataBaseManual !== undefined
        ? Math.max(0, Number(val.dividaDataBaseManual)) : null,
      ajustesLiquidos: Number.isFinite(Number(val.ajustesLiquidos)) ? Number(val.ajustesLiquidos) : 0,
    },
  });
  if (!resultado.ok) { res.status(422).json({ error: resultado.motivo, avisos: resultado.avisos }); return; }
  res.json({ ...resultado, cenario: cenario?.nome ?? "Base" });
});

// POST /models/:id/reforma — comparação "tributação atual × reforma tributária"
// (LC 214/2025 · LC 227/2026 · Decreto 12.955/2026): roda o MODELO INTEIRO nos
// dois mundos sobre o cenário ativo e devolve os dois resultados. Não persiste.
router.post("/:id/reforma", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const completo = await prisma.financialModel.findUnique({
    where: { id: model.id },
    include: { blocks: { orderBy: { ordem: "asc" } }, scenarios: true },
  });
  const blocks = completo!.blocks.map((b) => ({ id: b.id, tipo: b.tipo, nome: b.nome, ativo: b.ativo, config: b.config as BlocoModelo["config"] }));
  const regime = blocks.find((b) => b.tipo === "impostos")?.config.impostos?.regime;
  if (!regime || regime === "nenhum") {
    res.status(422).json({ error: "Configure o regime tributário na aba Impostos antes de comparar com a reforma." });
    return;
  }
  const cfgReforma = (req.body?.cfg ?? blocks.find((b) => b.tipo === "reforma")?.config.reforma ?? {}) as ConfigReforma;
  const cenario = completo!.scenarios.find((s) => s.id === completo!.cenarioAtivoId) ?? completo!.scenarios.find((s) => s.isBase);
  const base = {
    mesInicial: completo!.mesInicial,
    horizonteMeses: completo!.horizonteMeses,
    blocks,
    overrides: (cenario?.overrides ?? {}) as ScenarioOverrides,
    realizado: (completo!.realizado as RealizadoModelo | null) ?? null,
    indicesMacro: (completo!.indicesMacro as IndicesMacroSnapshot | null) ?? null,
  };
  const atual = calcularModelo(base);
  const reforma = calcularModelo({ ...base, reforma: cfgReforma });
  res.json({ ok: true, cenario: cenario?.nome ?? "Base", regime, atual, reforma });
});

// DELETE /models/:id — exclusão (trilha com entityId; cascade apaga blocos/cenários).
// CICLO DE VIDA (2026-07-15): "Em produção" → "Concluído" → "Cancelado".
// Concluir congela o marco (o modelo passa a ser um produto emitido); depois
// disso ele nunca é excluído — só cancelado, com motivo na trilha.
router.put("/:id/status", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const { status, motivo } = (req.body ?? {}) as { status?: string; motivo?: string };
  const atual = model.status === "Rascunho" ? "Em produção" : model.status; // legado
  const TRANSICOES: Record<string, string[]> = {
    "Em produção": ["Concluído", "Cancelado"],
    // Reabrir (Concluído → Em produção) destrava a edição COM REGISTRO — o
    // marco da conclusão e o motivo da reabertura ficam na trilha de auditoria.
    "Concluído": ["Cancelado", "Em produção"],
    "Cancelado": [],
  };
  if (!status || !(TRANSICOES[atual] ?? []).includes(status)) {
    res.status(409).json({ error: `Transição inválida: "${atual}" → "${status ?? "?"}". Fluxo: Em produção → Concluído → Cancelado.` });
    return;
  }
  await prisma.financialModel.update({ where: { id: model.id }, data: { status } });
  void registrarAuditoria({
    userId: req.userId!, analysisId: model.analysisSeedId ?? null, entity: "financial_model", entityId: model.id,
    field: "status do modelo", before: { status: atual }, after: { status }, source: "models",
    reason: motivo?.trim().slice(0, 300) || undefined,
  });
  res.json({ ok: true, status });
});

router.delete("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  // POLÍTICA (2026-07-15): modelo Concluído/Cancelado é produto emitido — nunca
  // some da base. Excluir só enquanto "Em produção" (ou legado "Rascunho").
  if (model.status === "Concluído" || model.status === "Cancelado") {
    res.status(409).json({ error: `Modelo "${model.status}" não pode ser excluído — cancele (com motivo) para tirá-lo de circulação mantendo a evidência.` });
    return;
  }
  await registrarAuditoria({
    userId: req.userId!, entity: "financial_model", entityId: model.id, field: "exclusão",
    before: { nome: model.nome, companyId: model.companyId, status: model.status }, source: "models",
  });
  await prisma.financialModel.delete({ where: { id: model.id } });
  // Era a última versão do produto? O envelope vazio some junto (sem isso ele
  // ficava contando em "Produtos N" sem nada dentro).
  await limparEnvelopeSeVazio(model.produtoId, req.userId!);
  res.json({ ok: true });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * HISTÓRICO GERENCIAL (Business Plan sem IBR) — decisão do usuário, 22/07/2026.
 *
 * O BP não exige IBR, mas a empresa costuma ter passado numa planilha própria.
 * Duas rotas, no mesmo desenho do dicionário de contas: a primeira LÊ e propõe
 * o de-para; a segunda aplica o que o humano confirmou. Nada entra sozinho.
 * ────────────────────────────────────────────────────────────────────────── */

const uploadHist = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// POST /models/:id/historico-gerencial/analisar (multipart: file)
// Lê a planilha COMO ELA É e devolve as linhas com a sugestão de destino.
// Não grava nada — é a etapa de conferência.
router.post("/:id/historico-gerencial/analisar", uploadHist.single("file"), async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  { const trava = travaEdicao(model); if (trava) { res.status(409).json({ error: trava }); return; } }
  if (!req.file) { res.status(400).json({ error: "Envie a planilha (campo 'file')." }); return; }

  try {
    // O parser da casa já lê xlsx/csv e devolve linhas + colunas de período.
    const parsed = await parseDocument(req.file.buffer, req.file.originalname, "Histórico gerencial");
    if (!parsed.linhas.length) {
      res.status(422).json({ error: "Não consegui ler nenhuma linha com valores nesta planilha. Confira se a primeira coluna tem os nomes das contas e as demais os períodos." });
      return;
    }
    const linhas: LinhaCrua[] = parsed.linhas.map((l) => ({ conta: l.conta, valores: l.valores }));
    res.json({
      arquivo: req.file.originalname,
      periodos: parsed.periodos,
      linhas: sugerirMapa(linhas),
      destinos: todosDestinos(),
    });
  } catch (e) {
    console.error("[historico-gerencial/analisar]", e instanceof Error ? e.message : e);
    res.status(422).json({ error: "Não foi possível interpretar o arquivo. Formatos aceitos: .xlsx, .xls e .csv." });
  }
});

// POST /models/:id/historico-gerencial/importar
// body: { periodos, linhas: [{conta, valores}], mapa: {indice: destinoId|null}, semear? }
// Grava o histórico no MESMO formato do que vem do IBR — por isso gráficos,
// Demonstração e seed passam a enxergá-lo sem código novo.
router.post("/:id/historico-gerencial/importar", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  { const trava = travaEdicao(model); if (trava) { res.status(409).json({ error: trava }); return; } }

  const { periodos, linhas, mapa, semear } = (req.body ?? {}) as {
    periodos?: string[]; linhas?: LinhaCrua[]; mapa?: MapaConfirmado; semear?: boolean;
  };
  if (!Array.isArray(periodos) || !periodos.length) { res.status(400).json({ error: "periodos é obrigatório" }); return; }
  if (!Array.isArray(linhas) || !linhas.length) { res.status(400).json({ error: "linhas é obrigatório" }); return; }
  if (!mapa || typeof mapa !== "object") { res.status(400).json({ error: "mapa é obrigatório" }); return; }

  const montado = montarHistorico(linhas, periodos, mapa);
  const historicoAnual = paraHistoricoAnual(montado);
  if (!historicoAnual.periodos.length || !Object.keys(historicoAnual.linhas).length) {
    res.status(422).json({ error: "Nenhuma linha de DRE foi mapeada — o histórico ficaria vazio. Aponte ao menos a receita." });
    return;
  }

  const realizadoAtual = (model.realizado ?? {}) as Record<string, unknown>;
  await prisma.financialModel.update({
    where: { id: model.id },
    data: {
      realizado: {
        ...realizadoAtual,
        historicoAnual,
        // Balanço no mesmo formato que /historico-dfs devolve para o IBR.
        historicoBP: { periodos: montado.periodos, linhas: montado.bp },
        // PROVENIÊNCIA (regra da casa): de onde este histórico veio.
        origemHistorico: {
          tipo: "gerencial",
          importadoEm: new Date().toISOString(),
          importadoPorId: req.userId!,
          linhasMapeadas: Object.values(mapa).filter(Boolean).length,
          linhasIgnoradas: Object.values(mapa).filter((x) => !x).length,
          avisos: montado.avisos,
        },
      } as object,
    },
  });

  await registrarAuditoria({
    userId: req.userId!, entity: "financial_model", entityId: model.id,
    field: "importação de histórico gerencial (planilha do cliente)",
    after: {
      periodos: montado.periodos,
      contasDRE: Object.keys(montado.dre).length,
      contasBP: Object.keys(montado.bp).length,
      semear: semear === true,
      avisos: montado.avisos,
    },
    source: "models",
  });

  // SEMEAR é opcional e explícito (o analista escolhe na importação): sem isso
  // o histórico só aparece como referência nos gráficos, e a projeção continua
  // sendo decisão dele — que é o espírito do BP (estudo do NOVO).
  let recalculado = false;
  if (semear === true) {
    const calc = await calcularEGravar(model.id).catch(() => null);
    recalculado = !!calc;
  }

  res.json({
    ok: true,
    periodos: montado.periodos,
    contasDRE: Object.keys(montado.dre).length,
    contasBP: Object.keys(montado.bp).length,
    avisos: montado.avisos,
    recalculado,
  });
});

export default router;
