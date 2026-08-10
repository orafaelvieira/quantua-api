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
import { gravarLeituraPorta, resumoDaLeitura, VERSAO_LEITOR_DEMONSTRATIVO, type LeituraPortaConteudo, type LeituraDemonstrativoConteudo } from "../services/leitura-porta";
import { whereEmpresaVisivel, guardaEscritaSuspensao } from "../services/escopo-empresa";
import { prisma } from "../db/client";
import { registrarAuditoria } from "../services/audit-trail";
import { propagarMetadadosDoPool } from "../services/fixacao-pool";
import { competenciaValida, competenciaDoPeriodoBalancete, rotuloCompetencia } from "../services/curadoria-pool";
import { downloadFile } from "../services/storage";
import { extrairTextoLayoutPDF } from "../services/parser";
import { parseBalanceteTexto } from "../services/balancete-parser";
import { converterBalancete } from "../services/balancete-conversao";
import { foldBP, foldDRE, type NaoMapeado, type BPN3Item } from "../services/ai-extraction";
import { sugerirConta } from "../services/account-mapper";
import { sugerirContaCanonica } from "../services/sugerir-conta-canonica";
import { ordPeriodo } from "../services/account-mapper";
import { getActiveModelVersions, loadActiveBPModel, loadActiveDREModel } from "../services/model-version";
import { resolverCascataDicionario, whereCascataDicionarioAtiva } from "../services/dicionario-escopo";
import { buildIndirectCashFlow } from "../services/cash-flow-indirect";
import type { BPLineItem, DRELineItem } from "../types/financial";
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
    select: { id: true, nome: true, tipo: true, competencia: true, descricao: true, versao: true, status: true, substituidoPorId: true, createdAt: true, moeda: true, hash: true, analysisId: true },
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
  // LEITURA NA PORTA (F1): resumo por documento + backfill preguiçoso dos
  // balancetes que subiram antes da porta existir (best-effort, background).
  const leituras = await prisma.documentoLeitura.findMany({
    where: { documentId: { in: [...poolIds] } },
    select: { documentId: true, hashArquivo: true, conteudo: true },
  });
  const leituraPorDoc = new Map(leituras.map((l) => [l.documentId, l]));
  for (const d of docs) {
    if (!poolIds.has(d.id) || !/balancete/i.test(d.tipo) || d.status === "Substituído") continue;
    const lp = leituraPorDoc.get(d.id);
    if (!lp || lp.hashArquivo !== d.hash) void gravarLeituraPorta(d.id);
  }
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
        // Leitura da porta (F1): o que o documento DIZ, com prova — null
        // enquanto não lido (ou leitura de arquivo já substituído).
        leitura: (() => {
          const lp = leituraPorDoc.get(d.vigente.id);
          const hashVigente = (d.vigente as { hash?: string | null }).hash ?? null;
          if (!lp || (hashVigente && lp.hashArquivo !== hashVigente)) return null;
          return resumoDaLeitura(lp.conteudo as unknown as LeituraPortaConteudo);
        })(),
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
        /** Explicação digitada no upload (material complementar). */
        descricao: (l.vigente as { descricao?: string | null }).descricao ?? null,
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
// body: { companyId, competencia: "YYYY-MM" (mês) | "YYYY" (ano fechado) |
// "YYYY-MM..YYYY-MM" (período ACUMULADO, 30/07/2026 — ex.: balancete de
// 01/01 a 30/09) | "" (limpa) }
router.put("/documentos/:docId/competencia", async (req: AuthRequest, res: Response): Promise<void> => {
  const { companyId, competencia } = (req.body ?? {}) as Record<string, string | undefined>;
  if (!companyId) { res.status(400).json({ error: "companyId é obrigatório" }); return; }
  const limpa = competencia === "" || competencia === null || competencia === undefined;
  if (!limpa && !competenciaValida(competencia!)) {
    res.status(400).json({ error: "competencia deve ser YYYY-MM (mês), YYYY (ano fechado) ou YYYY-MM..YYYY-MM (período acumulado, de ≤ até) — ou vazia, para limpar" });
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

  // O DOCUMENTO MANDA (31/07/2026 — "testei errando a data de propósito e ele
  // tem que continuar dizendo que está errado"): para BALANCETE em PDF, a
  // competência informada é conferida contra o período do CABEÇALHO antes de
  // gravar. Divergiu → 422 com a competência real; o erro persiste a cada
  // tentativa errada, até a correção. Best-effort: PDF ilegível segue sem checar.
  if (!limpa && /balancete/i.test(doc.tipo) && /\.pdf$/i.test(doc.nome) && doc.storagePath) {
    try {
      const texto = await extrairTextoLayoutPDF(await downloadFile(doc.storagePath));
      if (texto && texto.length > 300) {
        const p = parseBalanceteTexto(texto);
        const real = competenciaDoPeriodoBalancete(p.periodoInicio, p.periodoFim);
        if (real && real !== competencia) {
          res.status(422).json({
            error: `O documento diz "${p.periodoInicio ?? "?"} a ${p.periodoFim ?? "?"}" — a competência informada (${rotuloCompetencia(competencia)}) não bate. A correta é ${rotuloCompetencia(real)}.`,
            competenciaCorreta: real,
          });
          return;
        }
      }
    } catch (e) {
      console.warn(`[fechamento] conferência do período falhou para ${doc.nome} (segue sem checar):`, e instanceof Error ? e.message : e);
    }
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
  // Acumulado não fecha: fechamento é da CADÊNCIA (mês/exercício) — o doc
  // acumulado é referência de período composto (31/07/2026).
  if (periodo && /^\d{4}-\d{2}\.\.\d{4}-\d{2}$/.test(periodo)) {
    res.status(400).json({ error: "Período acumulado não entra no fechamento — feche os meses da cadência (ou o exercício)." });
    return;
  }
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


// ── HISTÓRICO FINANCEIRO DA EMPRESA (fatia 2 da base única, 08/08/2026) ─────
// DFs canônicas montadas das LEITURAS da porta (F1), dobradas com o dicionário
// em cascata e os MODELOS VIGENTES desta empresa — as MESMAS funções de fold
// do IBR (foldBP/foldDRE), aplicadas a outra fonte. LEITURA PURA: nada é
// persistido, e o IBR segue com a extração própria até o plug (F3).
// Cada balancete lido vira UMA coluna (o período do documento); as contas que
// o dicionário não resolve voltam como pendências — a validação mora na aba
// Dicionário & Modelos do hub.
/** CACHE do fold por empresa (08/08/2026, "leva alguns segundos"): instância
 *  única do Cloud Run — a MARCA é a impressão digital dos insumos (leituras,
 *  dicionário, versões de modelo). Mudou algo, recalcula; senão a aba abre na
 *  hora. Máx. 50 empresas em memória (o payload é pequeno; o caro é o fold). */
const cacheHistorico = new Map<string, { marca: string; payload: unknown }>();

router.get("/historico-financeiro", async (req: AuthRequest, res: Response): Promise<void> => {
  const companyId = String(req.query.companyId ?? "");
  if (!companyId) { res.status(400).json({ error: "companyId é obrigatório" }); return; }
  const company = await prisma.company.findFirst({ where: { id: companyId, ...whereEmpresaVisivel(req) } });
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  const docs = await prisma.document.findMany({
    where: { companyId, analysisId: null, status: { not: "Substituído" } },
    include: { leituraPorta: { select: { conteudo: true, hashArquivo: true, criadoEm: true } } },
    orderBy: { createdAt: "asc" },
  });
  // Impressão digital dos insumos — barata: ids/hashes já vieram na query
  // acima; dicionário por agregado; modelos por versão ativa.
  const dictAgg = await prisma.accountDictionary.aggregate({
    where: whereCascataDicionarioAtiva(req.scopeUserIds!, companyId),
    _count: { _all: true },
    _max: { updatedAt: true },
  });
  const versoesAtivas = await getActiveModelVersions(companyId);
  const marca = JSON.stringify([
    docs.map((d) => [d.id, d.hash, d.status, d.leituraPorta?.hashArquivo ?? null, d.leituraPorta?.criadoEm ?? null]),
    dictAgg._count._all, dictAgg._max.updatedAt,
    versoesAtivas,
  ]);
  const emCache = cacheHistorico.get(companyId);
  if (emCache && emCache.marca === marca) { res.json(emCache.payload); return; }
  const avisos: string[] = [];
  const fontes: Array<{ id: string; nome: string; conteudo: LeituraPortaConteudo }> = [];
  // RELATÓRIO DE VALIDAÇÃO por documento (09/08/2026, pedido do dono: o
  // quadro do IBR não aparecia no workspace): leitura + provas aritméticas,
  // um check por documento — a tela marca ✓/✗ cruzando com as pendências.
  const relatorio: Array<{ documentId: string; nome: string; contas: number; periodo: string | null; lido: boolean; fechamentoOk: boolean | null; erro: string | null }> = [];
  // DEMONSTRATIVOS ANUAIS (10/08/2026, pedido do dono: "não é apenas balancete
  // — também balanço patrimonial e DRE"): entram pela MESMA linha determinística
  // do IBR (árvore do BP por indentação; árvore da DRE com prova de partição —
  // funções puras, o fluxo do IBR não muda). SEM IA: documento que a linha
  // determinística não lê fica declarado no relatório.
  const docsDemonstrativos = docs.filter((d) => /^(dre|balan[çc]o patrimonial)$/i.test(d.tipo.trim()));
  for (const d of docs) {
    if (!/balancete/i.test(d.tipo)) continue;
    const lp = d.leituraPorta;
    const c = lp?.conteudo as unknown as LeituraPortaConteudo | undefined;
    if (!lp || (d.hash && lp.hashArquivo !== d.hash) || !c) {
      avisos.push(`${d.nome}: ainda sem leitura da porta (abra a Data room — a leitura roda sozinha).`);
      relatorio.push({ documentId: d.id, nome: d.nome, contas: 0, periodo: null, lido: false, fechamentoOk: null, erro: "ainda sem leitura da porta" });
      continue;
    }
    if (c.erro) {
      avisos.push(`${d.nome}: ${c.erro}`);
      relatorio.push({ documentId: d.id, nome: d.nome, contas: 0, periodo: null, lido: false, fechamentoOk: null, erro: c.erro });
      continue;
    }
    relatorio.push({
      documentId: d.id, nome: d.nome, contas: c.totalContas,
      periodo: c.periodoInicio && c.periodoFim ? `${c.periodoInicio} a ${c.periodoFim}` : null,
      lido: true,
      fechamentoOk: c.provas ? !!(c.provas.fechamento.ok && c.provas.linhas.ok) : null,
      erro: null,
    });
    fontes.push({ id: d.id, nome: d.nome, conteudo: c });
  }

  // Dicionário na CASCATA (global → workspace → empresa), resolvido POR TIPO —
  // a mesma régua do /refold do IBR.
  const dictRowsBrutos = await prisma.accountDictionary.findMany({
    where: whereCascataDicionarioAtiva(req.scopeUserIds!, companyId),
    select: { nomeOriginal: true, contaDestino: true, grupoConta: true, userId: true, companyId: true, tipo: true },
  });
  const dictRows = [...resolverCascataDicionario(dictRowsBrutos, "BP"), ...resolverCascataDicionario(dictRowsBrutos, "DRE")];
  const bpModel = await loadActiveBPModel(companyId);
  const dreModel = await loadActiveDREModel(companyId);

  // Os itens carregam TUDO que o fold devolve (nivel, classificacao…) — o
  // Fluxo de Caixa indireto lê nivel/classificacao do BP; só os `valores`
  // são mesclados entre períodos.
  type Item = { conta: string; valores: Record<string, number> } & Record<string, unknown>;
  const bp: Item[] = [];
  const dre: Item[] = [];
  const mergeItens = (alvo: Item[], novos: Item[]) => {
    for (const n of novos) {
      const ex = alvo.find((x) => x.conta === n.conta);
      if (!ex) { alvo.push({ ...n, valores: { ...n.valores } }); continue; }
      for (const [pk, v] of Object.entries(n.valores)) ex.valores[pk] = v;
    }
  };
  const naoMapeados: NaoMapeado[] = [];
  // AUDITORIA (09/08/2026, pedido do dono: "verificar o que foi feito"): o
  // fold carimba `destino` em cada nó da árvore ORIGINAL — devolvemos as
  // árvores no shape que o OriginalTreeView do IBR já lê (mesma tela).
  const arvoreOriginalBP: Record<string, unknown> = {};
  const arvoreOriginalDRE: Record<string, unknown> = {};
  const periodos: string[] = [];
  const origemPorPeriodo: Record<string, string> = {};
  const provasPorPeriodo: Record<string, unknown> = {};
  for (const f of fontes) {
    // A instância do Cloud Run é ÚNICA: 20s+ de fold síncrono travariam todas
    // as requisições — devolve o event loop entre documentos.
    await new Promise((r) => setImmediate(r));
    try {
      const conv = converterBalancete({
        periodoInicio: f.conteudo.periodoInicio,
        periodoFim: f.conteudo.periodoFim,
        ordemColunas: "ant-d-c-atual",
        linhas: f.conteudo.linhas,
        avisos: [],
      });
      const periodo = conv.periodoBP;
      if (periodos.includes(periodo)) {
        avisos.push(`${f.nome}: período ${periodo} já coberto por outro balancete — este ficou de fora (remova a duplicidade na Data room).`);
        continue;
      }
      periodos.push(periodo);
      origemPorPeriodo[periodo] = f.nome;
      provasPorPeriodo[periodo] = conv.provas;
      const rBP = foldBP(conv.arvoreBP, [periodo], dictRows, bpModel);
      mergeItens(bp, rBP.bp as unknown as Item[]);
      naoMapeados.push(...rBP.naoMapeados);
      const rDRE = foldDRE(conv.arvoreDRE, [periodo], dictRows, dreModel);
      mergeItens(dre, rDRE.dre as unknown as Item[]);
      naoMapeados.push(...rDRE.naoMapeados);
      // O fold MUTA as árvores carimbando destino/absorvido — é a auditoria.
      // SÓ a chave do PERÍODO DOBRADO viaja (09/08/2026, coluna em branco na
      // Belagro): a conversão devolve também o período de ABERTURA (saldo
      // anterior — o acumulado de 2024 carrega 31/12/2023 cru), e o assign
      // completo SOBRESCREVIA a árvore dobrada de um documento pela abertura
      // não-dobrada do documento seguinte — destino sumia da auditoria.
      if ((conv.arvoreBP as Record<string, unknown>)[periodo]) arvoreOriginalBP[periodo] = (conv.arvoreBP as Record<string, unknown>)[periodo];
      if ((conv.arvoreDRE as Record<string, unknown>)[periodo]) arvoreOriginalDRE[periodo] = (conv.arvoreDRE as Record<string, unknown>)[periodo];
    } catch (e) {
      avisos.push(`${f.nome}: conversão falhou (${e instanceof Error ? e.message : String(e)}).`);
    }
  }

  // ── DEMONSTRATIVOS (DRE / Balanço Patrimonial) ──
  // Balancete manda: período já coberto por balancete (ou por outro
  // demonstrativo do mesmo lado) fica de fora com aviso — nunca se soma duas
  // fontes na mesma coluna. Cobertura é POR LADO: um BP anual e uma DRE anual
  // do mesmo ano se completam.
  const cobertoBP = new Set(periodos);
  const cobertoDRE = new Set(periodos);
  const canonico = (p: string) => (/^\d{4}$/.test(p.trim()) ? `31/12/${p.trim()}` : p.trim());
  const registraPeriodo = (p: string, nomeDoc: string) => {
    if (!periodos.includes(p)) periodos.push(p);
    origemPorPeriodo[p] = origemPorPeriodo[p] ? `${origemPorPeriodo[p]} · ${nomeDoc}` : nomeDoc;
  };
  for (const d of docsDemonstrativos) {
    await new Promise((r) => setImmediate(r));
    const ehBP = /balan/i.test(d.tipo);
    const lp = d.leituraPorta;
    const c = lp?.conteudo as unknown as (LeituraDemonstrativoConteudo | undefined);
    // Avisos da leitura (ex.: competência declarada ≠ período lido) na tela.
    for (const a of c?.avisos ?? []) avisos.push(`${d.nome}: ${a}`);
    if (!lp || (d.hash && lp.hashArquivo !== d.hash) || !c || c.tipoLeitura !== "demonstrativo" || c.versaoLeitor !== VERSAO_LEITOR_DEMONSTRATIVO) {
      // Sem leitura ainda (documento legado, recém-substituído ou de leitor
      // ANTIGO): dispara em background e declara — a marca recalcula ao chegar.
      void gravarLeituraPorta(d.id);
      avisos.push(`${d.nome}: leitura em andamento (com IA quando a determinística não alcança) — recarregue em instantes.`);
      relatorio.push({ documentId: d.id, nome: d.nome, contas: 0, periodo: null, lido: false, fechamentoOk: null, erro: "leitura em andamento — recarregue em instantes" });
      continue;
    }
    if (c.erro) {
      avisos.push(`${d.nome}: ${c.erro}`);
      relatorio.push({ documentId: d.id, nome: d.nome, contas: c.totalContas, periodo: null, lido: false, fechamentoOk: null, erro: c.erro });
      continue;
    }
    try {
      const arvore = (ehBP ? c.arvoreBP : c.arvoreDRE) as Record<string, unknown> | undefined;
      const coberto = ehBP ? cobertoBP : cobertoDRE;
      const arvCanon: Record<string, unknown> = {};
      for (const [pRaw, dadosP] of Object.entries(arvore ?? {})) {
        const p = canonico(pRaw);
        if (coberto.has(p)) { avisos.push(`${d.nome}: ${p} já coberto por outra fonte de ${ehBP ? "BP" : "DRE"} — esta coluna ficou de fora.`); continue; }
        arvCanon[p] = dadosP;
      }
      const aceitos = Object.keys(arvCanon);
      if (aceitos.length) {
        if (ehBP) {
          const r2 = foldBP(arvCanon as Parameters<typeof foldBP>[0], aceitos, dictRows, bpModel);
          mergeItens(bp, r2.bp as unknown as Item[]);
          naoMapeados.push(...r2.naoMapeados);
          for (const p of aceitos) { cobertoBP.add(p); registraPeriodo(p, d.nome); arvoreOriginalBP[p] = arvCanon[p]; }
        } else {
          const r2 = foldDRE(arvCanon as Parameters<typeof foldDRE>[0], aceitos, dictRows, dreModel);
          mergeItens(dre, r2.dre as unknown as Item[]);
          naoMapeados.push(...r2.naoMapeados);
          for (const p of aceitos) { cobertoDRE.add(p); registraPeriodo(p, d.nome); arvoreOriginalDRE[p] = arvCanon[p]; }
        }
      }
      relatorio.push({
        documentId: d.id, nome: d.nome, contas: c.totalContas,
        periodo: aceitos.join(" · ") || null, lido: true, fechamentoOk: null, erro: null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      avisos.push(`${d.nome}: fold falhou (${msg}).`);
      relatorio.push({ documentId: d.id, nome: d.nome, contas: c.totalContas, periodo: null, lido: false, fechamentoOk: null, erro: `fold falhou (${msg})` });
    }
  }
  periodos.sort((a2, b2) => ordPeriodo(a2) - ordPeriodo(b2));

  // Pendências CONSOLIDADAS por conta (a mesma conta em N períodos é UMA pendência).
  const pendMap = new Map<string, { nome: string; tipo: "BP" | "DRE"; grupo: string; periodos: string[]; valorUltimo: number }>();
  for (const nm of naoMapeados) {
    const k = `${nm.tipo}|${nm.nome.toLowerCase()}`;
    const atual = pendMap.get(k) ?? { nome: nm.nome, tipo: nm.tipo, grupo: nm.grupo, periodos: [], valorUltimo: 0 };
    if (!atual.periodos.includes(nm.periodo)) atual.periodos.push(nm.periodo);
    atual.valorUltimo = nm.valor;
    pendMap.set(k, atual);
  }

  // FLUXO DE CAIXA INDIRETO (pedido do dono, 08/08: "faltou o Fluxo de
  // Caixa"): o MESMO serviço do IBR, sobre o BP/DRE dobrados acima. Null com
  // menos de 2 períodos — sem variação não há método indireto.
  const fc = periodos.length >= 2
    ? buildIndirectCashFlow(bp as unknown as BPLineItem[], dre as unknown as DRELineItem[], periodos)
    : null;
  if (periodos.length === 1) avisos.push("Fluxo de Caixa precisa de pelo menos 2 períodos lidos (método indireto compara balanços).");

  // SUGESTÃO DE CADASTRO por pendência (08/08/2026, pedido do dono): a mesma
  // heurística determinística do IBR (sugerirConta) contra as contas do
  // MODELO DA EMPRESA — pré-preenche o select da tela; o analista confirma e
  // a entrada nasce no escopo da EMPRESA ("pendente" → fila global da Quantua).
  const candidatosDRE = dreModel.lines.filter((l) => !l.subtotal).map((l) => l.conta);
  const candidatosBP = bpModel.names;
  // 💡 na ÁRVORE (09/08/2026, "não está vindo a sugestão"): o workspace não
  // paga IA — a sugestão é a DETERMINÍSTICA (similaridade de nome contra o
  // modelo da empresa), no MESMO shape que o OriginalTreeView já lê
  // (chave BP = `BP|grupo|nome`; DRE = `DRE|DRE|nome`). Honesta no rótulo.
  // Para DRE, o VOCABULÁRIO CONTÁBIL vem antes da similaridade de nome
  // (10/08/2026, "porque uns trazem dicas outros não?"): "Uniformes"/"EPI"/
  // "Aviso prévio" não se PARECEM com "Despesas com Pessoas" em texto, mas o
  // classificador do orçamento já SABE que são pessoal — e a similaridade
  // sozinha ainda errava por token ("Ajuda de Custo" → "Custo Operacional").
  const sugerirDre = (nome: string): { sugestao: string; justificativa: string; confianca: string } | null => {
    const porRegra = sugerirContaCanonica(nome, candidatosDRE);
    if (porRegra) {
      return {
        sugestao: porRegra.conta,
        justificativa: `${porRegra.porque} (determinística, sem IA)`,
        confianca: porRegra.base === "similaridade" ? "média" : "alta",
      };
    }
    const porNome = sugerirConta(nome, candidatosDRE);
    return porNome ? { sugestao: porNome, justificativa: "similaridade de nome com a conta do modelo (determinística, sem IA)", confianca: "média" } : null;
  };
  // A chave da tela usa o grupo-RAIZ (OriginalTreeView: raizG) — conta aninhada
  // carrega "Ativo Circulante > ADIANTAMENTO..." no naoMapeado e a dica nunca
  // era encontrada (10/08/2026, "continua sem as dicas").
  const raizGrupo = (g: string) => g.split(">")[0]!.trim();

  // LINHA DE FECHAMENTO/APURAÇÃO (10/08/2026, "imagem 1, não sugeriu"): a
  // família "RESULTADO LÍQUIDO DO EXERCÍCIO" não é conta de input — classificar
  // a folha em qualquer conta distorce a DRE; a ação certa é IGNORAR. Quando a
  // raiz ≈ ± soma das outras raízes (espelho PROVADO), a dica sai com confiança
  // alta; quando o valor NÃO bate (conta de apuração/zeramento com saldo
  // próprio, caso Belagro 2023: −577,0 mi vs −85,9 mi), a dica ainda sai, mas
  // com ⚠ de conferência — "verde só com prova".
  type NoDre = { nome: string; valor?: number; filhos?: NoDre[] };
  const ehNomeResultado = (s: string) =>
    /\b(resultado|lucro|prejuizo)\b.*\b(liquido|exercicio|periodo)\b|\bresultado liquido\b|\bapuracao\b.*\bresultado\b/.test(
      s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase());
  const espelhoDre = new Map<string, { provado: boolean; valor: number; somaOutras: number }>();
  for (const arv of Object.values(arvoreOriginalDRE)) {
    const roots = arv as NoDre[];
    if (!Array.isArray(roots) || roots.length < 2) continue;
    for (const r of roots) {
      const vr = r.valor ?? 0;
      if (Math.abs(vr) < 0.005 || !ehNomeResultado(r.nome)) continue;
      const somaOutras = roots.filter((o) => o !== r).reduce((s, o) => s + (o.valor ?? 0), 0);
      const tol = Math.max(1, Math.abs(vr) * 0.001);
      const provado = Math.abs(somaOutras - vr) <= tol || Math.abs(somaOutras + vr) <= tol;
      // Marca só os nós da subárvore com o MESMO valor da raiz (a corrente do
      // fechamento) — um filho de valor próprio não ganha a dica de ignorar.
      const marca = (n: NoDre): void => {
        if (Math.abs((n.valor ?? 0) - vr) <= tol || Math.abs((n.valor ?? 0) + vr) <= tol) {
          if (!espelhoDre.get(n.nome)?.provado) espelhoDre.set(n.nome, { provado, valor: vr, somaOutras });
        }
        (n.filhos ?? []).forEach(marca);
      };
      marca(r);
    }
  }
  // SUGESTÃO PELO CONTEXTO DO DOCUMENTO (BP): conta de BP raramente se parece
  // com a do modelo em texto ("G Belusso Transportes") — mas as IRMÃS do mesmo
  // grupo do documento já têm destino carimbado pelo fold. Consenso das irmãs
  // (≥60%) vem antes da similaridade; sem irmãs, o NOME DO PAI desempata.
  const candidatosBPSet = new Set(candidatosBP);
  const pendentesBP = new Set(naoMapeados.filter((n) => n.tipo === "BP").map((n) => n.nome));
  const contextoBP = new Map<string, { sugestao: string; justificativa: string; confianca: string }>();
  const destinoRealDe = (d?: string): string | null => {
    if (!d) return null;
    const m = /^\(absorvido em (.+)\)$/.exec(d);
    const nome = m ? m[1]! : d;
    return !nome.startsWith("(") && candidatosBPSet.has(nome) ? nome : null;
  };
  const visitaBP = (itens: BPN3Item[], grupoRaiz: string, pai: string | null): void => {
    const destinosIrmas = itens
      .filter((i) => !pendentesBP.has(i.nome))
      .map((i) => destinoRealDe(i.destino))
      .filter((d): d is string => d !== null);
    let consenso: { sugestao: string; justificativa: string; confianca: string } | null = null;
    if (destinosIrmas.length) {
      const cont = new Map<string, number>();
      for (const d of destinosIrmas) cont.set(d, (cont.get(d) ?? 0) + 1);
      const [top, n] = [...cont.entries()].sort((a, b) => b[1] - a[1])[0]!;
      if (n / destinosIrmas.length >= 0.6) {
        consenso = {
          sugestao: top,
          justificativa: `as contas irmãs${pai ? ` de "${pai}"` : ""} no documento foram para esta conta (determinística, sem IA)`,
          confianca: "alta",
        };
      }
    }
    for (const it of itens) {
      if (pendentesBP.has(it.nome)) {
        const chave = `BP|${grupoRaiz}|${it.nome}`;
        if (!contextoBP.has(chave)) {
          const porPai = !consenso && pai ? sugerirConta(pai, candidatosBP) : null;
          const escolha = consenso ?? (porPai
            ? { sugestao: porPai, justificativa: `o grupo do documento ("${pai}") se parece com esta conta do modelo (determinística, sem IA)`, confianca: "média" }
            : null);
          if (escolha) contextoBP.set(chave, escolha);
        }
      }
      if (it.filhos?.length) visitaBP(it.filhos, grupoRaiz, it.nome);
    }
  };
  for (const arv of Object.values(arvoreOriginalBP)) {
    const grupos = (arv as { grupos?: Record<string, BPN3Item[]> })?.grupos ?? {};
    for (const [gn, itens] of Object.entries(grupos)) visitaBP(itens, gn, null);
  }

  const sugestaoBP = (grupo: string, nome: string): { sugestao: string; justificativa: string; confianca: string } | null => {
    const ctx = contextoBP.get(`BP|${raizGrupo(grupo)}|${nome}`);
    if (ctx) return ctx;
    const porNome = sugerirConta(nome, candidatosBP);
    return porNome ? { sugestao: porNome, justificativa: "similaridade de nome com a conta do modelo (determinística, sem IA)", confianca: "média" } : null;
  };
  const fmtMi = (v: number) => `${(v / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  const sugestaoIgnorar = (esp: { provado: boolean; valor: number; somaOutras: number }) => ({
    sugestao: "__IGNORAR__",
    justificativa: esp.provado
      ? "linha de fechamento do resultado — o valor é o espelho das demais seções do documento (prova aritmética); classificá-la dobraria a DRE"
      : "linha de apuração/fechamento do resultado — não é conta de movimento; o resultado já está nas demais seções",
    confianca: esp.provado ? "alta" : "média",
    ...(esp.provado ? {} : {
      verificar: `o valor da linha (${fmtMi(esp.valor)}) difere do resultado somado das demais seções (${fmtMi(esp.somaOutras)}) — confirme no documento que é conta de apuração/zeramento antes de ignorar`,
    }),
  });
  const sugestoesIA: Record<string, { sugestao: string; justificativa: string; confianca: string; verificar?: string }> = {};
  for (const nm of naoMapeados) {
    const chave = nm.tipo === "BP" ? `BP|${raizGrupo(nm.grupo)}|${nm.nome}` : `DRE|DRE|${nm.nome}`;
    if (sugestoesIA[chave]) continue;
    const esp = nm.tipo === "DRE" ? espelhoDre.get(nm.nome) : undefined;
    const sug = nm.tipo === "DRE"
      ? (esp ? sugestaoIgnorar(esp) : sugerirDre(nm.nome))
      : sugestaoBP(nm.grupo, nm.nome);
    if (sug) sugestoesIA[chave] = sug;
  }
  const pendencias = [...pendMap.values()]
    .sort((x, y) => Math.abs(y.valorUltimo) - Math.abs(x.valorUltimo))
    .map((pd) => ({
      ...pd,
      // Espelho não ganha conta-sugestão no quadro (o sentinela cru confundiria).
      sugestao: pd.tipo === "DRE"
        ? (espelhoDre.has(pd.nome) ? null : (sugerirDre(pd.nome)?.sugestao ?? null))
        : (sugestaoBP(pd.grupo, pd.nome)?.sugestao ?? null),
    }));

  const payload = {
    periodos,
    fc,
    arvoreOriginalBP,
    arvoreOriginalDRE,
    naoMapeadosDetalhe: naoMapeados,
    origemPorPeriodo,
    provasPorPeriodo,
    bp,
    dre,
    pendencias,
    relatorio,
    sugestoesIA,
    opcoes: { dre: candidatosDRE, bp: candidatosBP },
    avisos,
    // Fontes LIDAS de qualquer tipo (10/08/2026: só balancete zerava o contador
    // numa empresa com BP/DRE e a tela mostrava "nenhum documento lido").
    fontes: relatorio.filter((r) => r.lido).length,
    modelos: versoesAtivas,
  };
  if (cacheHistorico.size >= 50) cacheHistorico.delete(cacheHistorico.keys().next().value!);
  cacheHistorico.set(companyId, { marca, payload });
  res.json(payload);
});

export default router;
