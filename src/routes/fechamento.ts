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
import { gravarLeituraPorta, resumoDaLeitura, type LeituraPortaConteudo } from "../services/leitura-porta";
import { whereEmpresaVisivel, guardaEscritaSuspensao } from "../services/escopo-empresa";
import { prisma } from "../db/client";
import { registrarAuditoria } from "../services/audit-trail";
import { propagarMetadadosDoPool } from "../services/fixacao-pool";
import { competenciaValida, competenciaDoPeriodoBalancete, rotuloCompetencia } from "../services/curadoria-pool";
import { downloadFile } from "../services/storage";
import { extrairTextoLayoutPDF } from "../services/parser";
import { parseBalanceteTexto } from "../services/balancete-parser";
import { converterBalancete } from "../services/balancete-conversao";
import { foldBP, foldDRE, type NaoMapeado } from "../services/ai-extraction";
import { sugerirConta } from "../services/account-mapper";
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
  for (const d of docs) {
    if (!/balancete/i.test(d.tipo)) continue;
    const lp = d.leituraPorta;
    const c = lp?.conteudo as unknown as LeituraPortaConteudo | undefined;
    if (!lp || (d.hash && lp.hashArquivo !== d.hash) || !c) { avisos.push(`${d.nome}: ainda sem leitura da porta (abra a Data room — a leitura roda sozinha).`); continue; }
    if (c.erro) { avisos.push(`${d.nome}: ${c.erro}`); continue; }
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
      Object.assign(arvoreOriginalBP, conv.arvoreBP as unknown as Record<string, unknown>);
      Object.assign(arvoreOriginalDRE, conv.arvoreDRE as unknown as Record<string, unknown>);
    } catch (e) {
      avisos.push(`${f.nome}: conversão falhou (${e instanceof Error ? e.message : String(e)}).`);
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
  const pendencias = [...pendMap.values()]
    .sort((x, y) => Math.abs(y.valorUltimo) - Math.abs(x.valorUltimo))
    .map((pd) => ({ ...pd, sugestao: sugerirConta(pd.nome, pd.tipo === "DRE" ? candidatosDRE : candidatosBP) }));

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
    opcoes: { dre: candidatosDRE, bp: candidatosBP },
    avisos,
    fontes: fontes.length,
    modelos: versoesAtivas,
  };
  if (cacheHistorico.size >= 50) cacheHistorico.delete(cacheHistorico.keys().next().value!);
  cacheHistorico.set(companyId, { marca, payload });
  res.json(payload);
});

export default router;
