/**
 * MODELOS FINANCEIROS — rotas do produto Projeções/Orçamento/Valuation (F1).
 *
 * Determinístico de ponta a ponta (zero IA nesta fase → zero custo a registrar).
 * Toda mutação emite trilha via registrarAuditoria (regra da casa).
 */
import { Router, Response } from "express";
import { Prisma } from "@prisma/client";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { prisma } from "../db/client";
import { registrarAuditoria } from "../services/audit-trail";
import { calcularModelo, validarFormula, backfillPremissasAoRecuar, BlocoModelo, ScenarioOverrides, RealizadoModelo, IndicesMacroSnapshot, SERIES_MACRO, MACRO_CAMBIO } from "../services/model-engine";
import { buscarIndicesEconomicos } from "../services/indices-economicos";
import { buscarDadosWacc } from "../services/wacc-dados";
import { ERP_REFERENCIA, BETAS_EMERGING, BETAS_DATA, KROLL_DECIS, KROLL_FONTE, CSRP_FATORES } from "../services/wacc-referencias";
import { perguntarJson } from "../services/ai-extraction";
import { montarLinhaReceita, TEMPLATES_RECEITA } from "../services/model-templates";
import { derivarSeed, derivarHistoricoAnual, derivarRealizadoParcial, derivarAberturaReceita, derivarAberturaCustos, derivarAberturaCustosCanonica, derivarImobilizadoHistorico, derivarGiroHistorico, derivarDividaHistorico, derivarOutrosBalanco } from "../services/model-seed";
import { rodarMonteCarlo, McVariavelSpec } from "../services/monte-carlo";
import { ConfigReforma } from "../services/reforma-tributaria";
import { avaliarProntidaoGeracao } from "../services/prontidao-geracao";
import { buildIndirectCashFlow } from "../services/cash-flow-indirect";

const router = Router();
router.use(requireAuth);

/** Empresa dentro do escopo do caller (visibilidade de firma). */
async function companyNoEscopo(companyId: string, scopeUserIds: string[]) {
  return prisma.company.findFirst({ where: { id: companyId, userId: { in: scopeUserIds } } });
}

async function modelNoEscopo(id: string, scopeUserIds: string[]) {
  const model = await prisma.financialModel.findUnique({ where: { id } });
  if (!model) return null;
  const company = await companyNoEscopo(model.companyId, scopeUserIds);
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
  res.json({ erp: ERP_REFERENCIA, betas: BETAS_EMERGING, betasData: BETAS_DATA, kroll: KROLL_DECIS, krollFonte: KROLL_FONTE, csrpFatores: CSRP_FATORES });
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
  const company = await companyNoEscopo(companyId, req.scopeUserIds!);
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
  const company = await companyNoEscopo(companyId, req.scopeUserIds!);
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

// GET /models?companyId= — lista modelos do escopo (opcionalmente por empresa).
router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const companyId = req.query.companyId as string | undefined;
  const companies = await prisma.company.findMany({
    where: { userId: { in: req.scopeUserIds! }, ...(companyId ? { id: companyId } : {}) },
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
        mesInicial: m.mesInicial, horizonteMeses: m.horizonteMeses, visao: m.visao,
        companyId: m.companyId, empresa: porId.get(m.companyId)?.nomeFantasia || porId.get(m.companyId)?.razaoSocial || "—",
        cenarioAtivo: m.scenarios.find((s) => s.id === m.cenarioAtivoId)?.nome ?? "Base",
        checksOk: cache?.checks ? cache.checks.every((c) => c.ok) : null,
        updatedAt: m.updatedAt,
      };
    }),
  });
});

// POST /models — cria modelo + blocos default + cenários (wizard).
// body: { companyId, nome?, objetivo?, mesInicial?, horizonteMeses?, templateReceita?, analysisSeedId? }
router.post("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const { companyId, nome, objetivo, mesInicial, horizonteMeses, templateReceita, analysisSeedId } = req.body ?? {};
  if (!companyId) { res.status(400).json({ error: "companyId é obrigatório" }); return; }
  const company = await companyNoEscopo(companyId, req.scopeUserIds!);
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
  const analysis = analysisSeedId
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
  if (usarAbertura) {
    abertura.forEach((ab, idx) => {
      const linhaId = `lin${idx + 1}`;
      const periodosCom = Object.entries(ab.valores).filter(([, v]) => v > 0).map(([k]) => k);
      const ultimoP = periodosCom[periodosCom.length - 1];
      const anteriorP = periodosCom[periodosCom.length - 2];
      const vUlt = ultimoP ? ab.valores[ultimoP] : 0;
      const vAnt = anteriorP ? ab.valores[anteriorP] : 0;
      const cresc = vAnt > 0 ? Math.max(-0.5, Math.min(1, vUlt / vAnt - 1)) : 0.1;
      linhasReceita.push(montarLinhaReceita("generico", linhaId, ab.conta, { receitaMensal: vUlt / 12, crescimentoAnual: cresc }));
      receitaPorLinha[linhaId] = ab.valores;
      memoriaAbertura.push(`"${ab.conta}": base ${vUlt.toFixed(2)} (${ultimoP ?? "—"}), crescimento ${(cresc * 100).toFixed(1)}%`);
    });
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
  const linhasCustoSeed: Array<{ id: string; nome: string; modo: string; pct: number; grupoDre?: string }> = [];
  const linhasDespesaSeed: Array<{ id: string; nome: string; modo: string; pct: number; grupoDre?: string }> = [];
  const custoPorLinha: Record<string, Record<string, number>> = {};
  const custoPorLinhaAssinado: Record<string, Record<string, number>> = {};
  const memoriaCustos: string[] = [];
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
      // A linha JÁ É a conta canônica do modelo padrão (2026-07-16) — sem
      // grupoDre: cabeçalho de grupo 1:1 com a própria linha seria redundância.
      alvo.push({ id: linhaId, nome, modo: "pctReceita", pct });
      custoPorLinha[linhaId] = ab.valores;
      // Histórico ASSINADO (contribuição p/ o bloco): a Demonstração exibe a
      // linha e o subtotal do grupo com o MESMO sinal que fecha com o total.
      custoPorLinhaAssinado[linhaId] = Object.fromEntries(
        Object.entries(ab.valoresAssinados ?? {}).map(([p, v]) => [p, -v])
      );
      memoriaCustos.push(`"${nome}" (${ehCusto ? "custo" : "despesa"}${pct < 0 ? ", redutora" : ""}): ${contribuicaoUlt.toFixed(2)} em ${ultimoP ?? "—"} = ${(pct * 100).toFixed(2)}% da receita bruta`);
    });
  }

  // CARIMBO DE PROVENIÊNCIA do seed (política 2026-07-15): o modelo nasce
  // apontando o HASH da versão da extração que o semeou. Se a análise-fonte for
  // reprocessada depois (documento substituído, dicionário novo), o hash atual
  // diverge e o GET do modelo acende "histórico desatualizado".
  const deSeed = analysis?.dadosEstruturados as { versaoExtracao?: string; extraidoEm?: string } | null;
  const seed_ = analysis
    ? { analysisId: analysis.id, versaoExtracao: deSeed?.versaoExtracao ?? null, extraidoEm: deSeed?.extraidoEm ?? null, seedEm: new Date().toISOString() }
    : null;
  const realizado = historicoAnual || parcial || seed_
    ? {
        ...(historicoAnual ? { historicoAnual: { ...historicoAnual, ...(usarAbertura ? { receitaPorLinha } : {}), ...(usarAberturaCustos ? { custoPorLinha, custoPorLinhaAssinado } : {}) } } : {}),
        ...(parcial ? { meses: parcial.meses, porGrupo: parcial.porGrupo } : {}),
        ...(seed_ ? { seed: seed_ } : {}),
      }
    : null;

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
          {
            tipo: "custos", nome: "Custos", ordem: 1,
            config: {
              linhasCusto: usarAberturaCustos
                ? linhasCustoSeed
                : [{ id: "custos1", nome: "Custos sobre a receita", modo: "pctReceita", pct: seed.pctCustos }],
            } as object,
          },
          {
            tipo: "despesas", nome: "Despesas", ordem: 2,
            config: {
              linhasCusto: usarAberturaCustos
                ? linhasDespesaSeed
                : [{ id: "desp1", nome: "Despesas operacionais", modo: "pctReceita", pct: seed.pctDespesas }],
            } as object,
          },
          // NÃO OPERACIONAIS (abaixo do EBITDA): nascem vazios — só aparecem na
          // Demonstração quando o analista adicionar linhas.
          { tipo: "receitasNaoOp", nome: "Receitas não operacionais", ordem: 3, config: {} as object },
          { tipo: "despesasNaoOp", nome: "Despesas não operacionais", ordem: 4, config: {} as object },
          // CAPEX nasce com os ATIVOS EXISTENTES do BP do IBR (Imobilizado/
          // Intangível líquidos) — depreciação padrão 10% a.a. DECLARADA (o
          // analista ajusta por classe). Sem isso a DRE nascia sem D&A e o BP
          // sem Imobilizado (F2 do roadmap, entregue 2026-07-16).
          {
            tipo: "capex", nome: "Investimentos (Capex)", ordem: 5,
            config: {
              ativosExistentes: derivarImobilizadoHistorico(analysis?.dadosEstruturados ?? null).itens.map((it, k) => ({
                id: `ativo_hist_${k}`, nome: `${it.conta} (histórico)`, valor: it.valor, taxaAnual: 0.10, tipoAtivo: "seed-historico",
              })),
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
              itensBalancoSeed: true,
              itensBalanco: derivarOutrosBalanco(analysis?.dadosEstruturados ?? null).itens.map((h, k) => ({
                id: `bi${k}_${Date.now().toString(36)}`, nome: h.conta, classificacao: h.classificacao,
                modo: "constante", saldo: h.valor, ordem: k,
              })),
            } as object,
          },
          { tipo: "folha", nome: "Pessoas", ordem: 7, config: {} as object },
          { tipo: "divida", nome: "Dívida", ordem: 8, config: {} as object },
          { tipo: "impostos", nome: "Impostos", ordem: 9, config: {} as object },
          { tipo: "wacc", nome: "WACC", ordem: 10, config: {} as object },
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

  await registrarAuditoria({
    userId: req.userId!,
    entity: "financial_model",
    entityId: model.id,
    field: "criação",
    after: { nome: model.nome, objetivo: model.objetivo, templateReceita: templateReceita || "generico", seedDe: analysis?.id ?? null, memoriaSeed: [...seed.memoria, ...(parcial?.memoria ?? []), ...(memoriaAbertura.length ? [`Abertura de receita do histórico (${memoriaAbertura.length} linha(s)):`, ...memoriaAbertura] : []), ...(memoriaCustos.length ? [`Abertura de custos/despesas do histórico (${memoriaCustos.length} linha(s), % da receita bruta do último ano):`, ...memoriaCustos] : [])] },
    source: "models",
  });

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
  res.status(201).json({ id: model.id, seedMemoria: seed.memoria, checks: calc?.resultado.checks ?? [] });
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

router.post("/:id/atualizar-indices", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
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
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
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
  const seedStamp = (completo?.realizado as { seed?: { versaoExtracao?: string | null } } | null)?.seed;
  if (model.analysisSeedId) {
    const fonte = await prisma.analysis.findUnique({
      where: { id: model.analysisSeedId },
      select: { id: true, nome: true, status: true, createdAt: true, dadosEstruturados: true, documents: { select: { tipo: true, status: true, createdAt: true } } },
    });
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
  }
  res.json({ ...completo, empresaNome: company?.nomeFantasia || company?.razaoSocial || null, historicoDesatualizado, motivoDesatualizado, ibrVinculado });
});

// GET /models/:id/dfs-origem — TRANSPARÊNCIA: as demonstrações EXTRAÍDAS
// (BP e DRE canônicos, 100% das contas, todos os períodos) da análise-fonte
// que ancora o modelo. Nada é recalculado aqui — é o retrato fiel da origem.
router.get("/:id/dfs-origem", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
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
  } | null;
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
  });
});

// GET /models/:id/historico-custos — abertura de CUSTOS/DESPESAS do histórico
// (nomes exatos do documento, até 3 últimos períodos): âncora do custo unitário
// nas linhas "Por variável" — o analista usa o valor do último ano ÷ quantidade.
router.get("/:id/historico-custos", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  if (!model.analysisSeedId) { res.json({ periodos: [], linhas: [] }); return; }
  const analysis = await prisma.analysis.findUnique({ where: { id: model.analysisSeedId }, select: { dadosEstruturados: true } });
  const linhas = derivarAberturaCustos(analysis?.dadosEstruturados ?? null);
  const de = analysis?.dadosEstruturados as { periodos?: string[] } | null;
  const periodos = (de?.periodos ?? []).slice(-3); // 1 a 3 períodos de histórico
  res.json({
    periodos,
    linhas: linhas.map((l) => ({ conta: l.conta, valores: Object.fromEntries(periodos.map((p) => [p, l.valores[p] ?? 0])) })),
  });
});

// GET /models/:id/historico-imobilizado — ativos de longo prazo do BP extraído
// (Imobilizado, Intangível, Biológicos): âncora dos "ativos existentes" do capex.
router.get("/:id/historico-imobilizado", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  if (!model.analysisSeedId) { res.json({ periodo: null, itens: [] }); return; }
  const analysis = await prisma.analysis.findUnique({ where: { id: model.analysisSeedId }, select: { dadosEstruturados: true } });
  res.json(derivarImobilizadoHistorico(analysis?.dadosEstruturados ?? null));
});

// GET /models/:id/historico-giro — dias de giro do último período extraído
// (PMR/PME/PMP): âncora das premissas do Capital de giro.
router.get("/:id/historico-giro", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  if (!model.analysisSeedId) { res.json({ periodo: null, pmr: null, pme: null, pmp: null }); return; }
  const analysis = await prisma.analysis.findUnique({ where: { id: model.analysisSeedId }, select: { dadosEstruturados: true } });
  res.json(derivarGiroHistorico(analysis?.dadosEstruturados ?? null));
});

// GET /models/:id/historico-balanco — OUTRAS contas do BP extraído (fora de
// caixa/giro/imobilizado/dívida/PL): âncora do bloco "Outros itens do balanço"
// (mútuos, antecipações, impostos/pessoal a pagar…), com classificação sugerida.
router.get("/:id/historico-balanco", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
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
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const vazio = { temHistorico: false, periodosBP: [], periodosFC: [], bp: {}, fc: {}, avisoFC: null };
  if (!model.analysisSeedId) { res.json(vazio); return; }
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
    "bp-imobilizado": ["Imobilizado", "Intangível", "Ativos Biológicos - LP"],
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

// GET /models/:id/historico-divida — saldo de Empréstimos e Financiamentos
// (CP+LP) do último balanço extraído: âncora do contrato "dívida existente".
router.get("/:id/historico-divida", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  if (!model.analysisSeedId) { res.json({ periodo: null, itens: [], total: 0 }); return; }
  const analysis = await prisma.analysis.findUnique({ where: { id: model.analysisSeedId }, select: { dadosEstruturados: true } });
  res.json(derivarDividaHistorico(analysis?.dadosEstruturados ?? null));
});

// PUT /models/:id — cabeçalho (nome, visão, cenário ativo, status).
router.put("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  { const trava = travaEdicao(model); if (trava) { res.status(409).json({ error: trava }); return; } }
  const { nome, visao, cenarioAtivoId, status, horizonteMeses, mesInicial } = req.body ?? {};
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
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  { const trava = travaEdicao(model); if (trava) { res.status(409).json({ error: trava }); return; } }
  const block = await prisma.modelBlock.findFirst({ where: { id: req.params.blockId as string, modelId: model.id } });
  if (!block) { res.status(404).json({ error: "Bloco não encontrado" }); return; }
  const { config, modo, ativo, nome } = req.body ?? {};
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
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
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

// PUT /models/:id/blocks/:blockId/linhas/:linhaId/template — TROCA o jeito de
// faturar da linha: reconstrói a árvore de drivers do template novo, mantendo o
// nome do produto. Os números da linha voltam ao padrão (avisado na UI).
router.put("/:id/blocks/:blockId/linhas/:linhaId/template", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
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
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
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
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
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
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
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
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
  if (!model) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  const calc = await calcularEGravar(model.id);
  res.json({ ok: true, cenario: calc?.cenario, resultado: calc?.resultado });
});

// POST /models/:id/simular — calcula com overrides AD HOC (sliders da tela de
// Cenários antes do "Salvar premissas"). Não persiste nada.
router.post("/:id/simular", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
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
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
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
  const resultado = rodarMonteCarlo({
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
    },
  });
  if (!resultado.ok) { res.status(422).json({ error: resultado.motivo, avisos: resultado.avisos }); return; }
  res.json({ ...resultado, cenario: cenario?.nome ?? "Base" });
});

// POST /models/:id/reforma — comparação "tributação atual × reforma tributária"
// (LC 214/2025 · LC 227/2026 · Decreto 12.955/2026): roda o MODELO INTEIRO nos
// dois mundos sobre o cenário ativo e devolve os dois resultados. Não persiste.
router.post("/:id/reforma", async (req: AuthRequest, res: Response): Promise<void> => {
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
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
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
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
  const model = await modelNoEscopo(req.params.id as string, req.scopeUserIds!);
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
  res.json({ ok: true });
});

export default router;
