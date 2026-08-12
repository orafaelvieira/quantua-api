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
import { converterBalancete, ehNomeDeApuracao } from "../services/balancete-conversao";
import { foldBP, foldDRE, type NaoMapeado, type BPN3Item } from "../services/ai-extraction";
import { sugerirConta, GRUPO_CLASSIF_MAP } from "../services/account-mapper";
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

/**
 * CHAVE DO CACHE COM ESCOPO (11/08/2026 — revisão adversarial).
 *
 * A chave era só o companyId. O payload, porém, é montado com o dicionário
 * resolvido para o ESCOPO DE ACESSO de quem chamou (`req.scopeUserIds`), e
 * escopos diferentes veem cascatas diferentes: o primeiro a abrir a tela
 * gravava a sua versão e o próximo recebia a do outro. Numa plataforma com
 * escritórios distintos isso é vazamento entre tenants, não só cache errado.
 */
const chaveCache = (companyId: string, scopeUserIds: string[]): string =>
  `${companyId}|${[...scopeUserIds].sort().join(",")}`;

/**
 * MONTAGENS EM VOO (single-flight). O fold custa 20s+ de CPU numa instância
 * ÚNICA. Sem isto, N requisições simultâneas da mesma empresa (a tela abre,
 * o analista recarrega, o wizard consulta) viram N folds concorrentes e o
 * cache só é escrito no fim — estampido garantido. Quem chega no meio espera
 * a mesma promessa em vez de começar outra.
 */
const emVoo = new Map<string, Promise<unknown>>();

/** Espera a montagem em curso, com TETO: um bug que impedisse a liberação não
 *  pode virar espera eterna — passado o teto, cada um monta a sua. */
const esperarComTeto = async (p: Promise<unknown>, ms = 60_000): Promise<void> => {
  let t: NodeJS.Timeout | undefined;
  await Promise.race([
    p.catch(() => {}),
    new Promise<void>((r) => { t = setTimeout(r, ms); }),
  ]);
  if (t) clearTimeout(t);
};

/** R$ curto para as mensagens de prova ("R$ -85,9 mi"). */
const fmtBRL = (v: number): string => {
  const abs = Math.abs(v);
  if (abs >= 1e6) return `R$ ${(v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (abs >= 1e3) return `R$ ${(v / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
  return `R$ ${v.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}`;
};

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
  const chave = chaveCache(companyId, req.scopeUserIds!);
  const emCache = cacheHistorico.get(chave);
  if (emCache && emCache.marca === marca) { res.json(emCache.payload); return; }

  // SINGLE-FLIGHT. Cache miss simultâneo (a tela abre, o analista recarrega, o
  // wizard consulta) fazia N montagens completas em paralelo na instância
  // ÚNICA — o cache só é escrito no FIM, então ninguém aproveitava o trabalho
  // do outro. Quem chega no meio espera a montagem em curso e reaproveita o
  // resultado dela se os insumos forem os mesmos (mesma marca).
  const emAndamento = emVoo.get(chave);
  if (emAndamento) {
    await esperarComTeto(emAndamento);
    const pronto = cacheHistorico.get(chave);
    if (pronto && pronto.marca === marca) { res.json(pronto.payload); return; }
  }
  // Registra a NOSSA montagem e garante a liberação em QUALQUER desfecho —
  // sucesso, erro do handler ou cliente que fechou a aba. Sem isso, uma
  // exceção deixaria a chave presa e a tela travaria para sempre.
  let liberar: () => void = () => {};
  const emVooAgora = new Promise<void>((r) => { liberar = r; });
  emVoo.set(chave, emVooAgora);
  const soltar = () => {
    if (emVoo.get(chave) === emVooAgora) emVoo.delete(chave);
    liberar();
  };
  res.once("finish", soltar);
  res.once("close", soltar);
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
    // P0 — PARTIDA DOBRADA (10/08/2026): Σ débitos = Σ créditos nas linhas que
    // o sistema LEU. É a prova cruzada que não depende de total impresso e que
    // pega linha perdida no parse. Ela vale para o selo do documento e o motivo
    // vai junto — no corpus, 9 documentos que passavam verdes reprovaram aqui.
    const pd = c.provas?.partidaDobrada;
    const partidaOk = pd?.verificavel ? pd.ok : true;
    if (pd?.verificavel && !pd.ok) {
      avisos.push(
        `${d.nome}: a leitura não fecha em partida dobrada — débitos ${fmtBRL(pd.debitos)} × créditos ${fmtBRL(pd.creditos)} (diferença ${fmtBRL(pd.delta)}) em ${pd.folhas} conta(s). Alguma linha ficou de fora ou foi lida torta.`,
      );
    }
    relatorio.push({
      documentId: d.id, nome: d.nome, contas: c.totalContas,
      periodo: c.periodoInicio && c.periodoFim ? `${c.periodoInicio} a ${c.periodoFim}` : null,
      lido: true,
      fechamentoOk: c.provas ? !!(c.provas.fechamento.ok && c.provas.linhas.ok && partidaOk) : null,
      erro: pd?.verificavel && !pd.ok
        ? `partida dobrada não fecha: diferença de ${fmtBRL(pd.delta)} entre débitos e créditos lidos`
        : null,
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
  /** Como rotular cada coluna: "mes" → 05/2026 · "exercicio" → 2026. */
  const tipoPorPeriodo: Record<string, "mes" | "exercicio"> = {};
  /** CONSERVAÇÃO DE VALOR por coluna: o que entrou do documento × o que saiu
   *  para as linhas. Quando não bate, a conta onde o dinheiro ficou vem junto. */
  const conservacaoPorPeriodo: Record<string, { entrou: number; saiu: number; diferenca: number; ok: boolean; vazamentos: Array<{ conta: string; grupo: string; valor: number; motivo: string }> }> = {};
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
      // P4 (10/08/2026, caso Belagro 2023): DRE de exercício ENCERRADO só é
      // verde se reconciliar com o resultado que o próprio PL registra. As
      // provas vêm da conversão FRESCA daqui (a leitura gravada é anterior a
      // esta prova e não a carrega).
      const p4 = conv.provas.dreEncerrada;
      if (p4 && !p4.ok) {
        avisos.push(
          `${f.nome}: balancete de ENCERRAMENTO — a DRE derivada do movimento (${fmtBRL(p4.derivado)}) não reconcilia com o resultado que o próprio PL registra no ano (${fmtBRL(p4.declaradoPL)}). Transferência interna entre contas de resultado infla os dois lados: confira contra a demonstração oficial do exercício antes de usar estes números.`,
        );
        const linha = relatorio.find((r) => r.documentId === f.id);
        if (linha) {
          linha.fechamentoOk = false;
          linha.erro = `DRE do encerramento não reconcilia com o PL (${fmtBRL(p4.derivado)} × ${fmtBRL(p4.declaradoPL)})`;
        }
      }
      // Balancete que cobre o exercício INTEIRO (01/01 a 31/12) é exercício; o
      // resto é mês — a tela rotula "2025" × "05/2026" a partir daqui.
      tipoPorPeriodo[periodo] = /^01\/01\//.test(f.conteudo.periodoInicio ?? "") && /^31\/12\//.test(f.conteudo.periodoFim ?? "")
        ? "exercicio" : "mes";
      const rBP = foldBP(conv.arvoreBP, [periodo], dictRows, bpModel);
      for (const k of rBP.conservacao) conservacaoPorPeriodo[k.periodo] = k;
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
    // Demonstrativo anual é EXERCÍCIO; se o mesmo período já veio de balancete
    // mensal, o mensal continua mandando (não vira "2026" o que é maio/26).
    tipoPorPeriodo[p] ??= "exercicio";
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
          for (const k of r2.conservacao) conservacaoPorPeriodo[k.periodo] = k;
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
      // "Verde só com prova": competência declarada FORA dos períodos lidos é
      // ✗ na validação (10/08/2026, caso "BP 2022.pdf → 31/12/2021") — a coluna
      // entra, mas ninguém chama de conferida o que diverge do declarado.
      const anoDeclarado = d.competencia && /^\d{4}$/.test(d.competencia.trim()) ? d.competencia.trim() : null;
      const divergeDoDeclarado = !!anoDeclarado && c.periodos.length > 0
        && !c.periodos.some((p) => p.trim().slice(-4) === anoDeclarado);
      // BALANÇO INCOMPLETO (10/08/2026, caso Move Farma/Dunamys): a leitura do
      // BP anual trouxe o ativo e o PL e NENHUMA conta de passivo — Ativo ≠
      // Passivo. A conferência mora aqui, no documento que originou a coluna.
      let desbalanceado: string | null = null;
      if (ehBP) {
        const grupos = Object.entries(c.arvoreBP ?? {})
          .flatMap(([, capa]) => Object.entries((capa as { grupos?: Record<string, unknown[]> })?.grupos ?? {}));
        const contasDe = (re: RegExp) => grupos.filter(([g]) => re.test(g)).reduce((s, [, itens]) => s + (itens?.length ?? 0), 0);
        const nPassivo = contasDe(/passivo/i);
        const nAtivo = contasDe(/ativo/i);
        if (nAtivo > 0 && nPassivo === 0) {
          desbalanceado = "a leitura não reconheceu NENHUMA conta de passivo (balanço em duas colunas costuma perder o lado direito) — o Ativo não fecha com o Passivo e o Fluxo de Caixa desta coluna não pode fechar";
        }
      }
      // A CASCATA JÁ SE JULGOU (10/08/2026): a leitura carrega o score de
      // integridade do nível vencedor (equação + composição + detalhe + DRE).
      // Não fechou 5/5 mesmo após heurístico → Haiku → visão? Então é ✗ aqui,
      // com o motivo — o analista não descobre isso adiante, na conta errada.
      const integ = c.integridade;
      if (!desbalanceado && integ && !integ.fecha) {
        const faltas = [
          !integ.equacaoPatrimonial ? "Ativo ≠ Passivo + PL" : null,
          !integ.composicaoAtivo ? "composição do ativo não soma" : null,
          !integ.composicaoPassivo ? "composição do passivo não soma" : null,
        ].filter(Boolean).join(" · ");
        desbalanceado = `a extração não fechou a integridade (${integ.score}/5${faltas ? ` — ${faltas}` : ""}) mesmo depois da cascata completa (parser → IA texto → IA visão)`;
      }
      relatorio.push({
        documentId: d.id, nome: d.nome, contas: c.totalContas,
        periodo: aceitos.join(" · ") || null, lido: true,
        fechamentoOk: divergeDoDeclarado || desbalanceado ? false : null,
        erro: divergeDoDeclarado
          ? `competência declarada ${anoDeclarado}, mas a leitura trouxe ${c.periodos.join(" · ")} — confira o arquivo (num balanço comparativo, a coluna do exercício pode ter sido trocada pela do ano anterior)`
          : desbalanceado,
      });
      if (desbalanceado) avisos.push(`${d.nome}: ${desbalanceado}.`);
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

  // ── PROVA PATRIMONIAL DE CADA COLUNA (10/08/2026, "por que o fluxo de caixa
  // não bate com o valor do BP?") ──
  // O FC indireto é DERIVADO do balanço: a identidade FCO+FCI+FCF = ΔCaixa
  // fecha algebricamente sempre que Ativo = Passivo nos dois períodos. Quando
  // não fecha, a causa está no balanço — e ela precisa aparecer NA COLUNA, não
  // só no fim da cadeia. Caso real (Move Farma): o BP anual lido do PDF veio
  // SEM O LADO DO PASSIVO (Passivo Circulante e Não Circulante com zero
  // contas), Ativo 8,3 mi × Passivo 3,6 mi — e o FC "não fechava" sem dizer
  // por quê. O balancete, que tem a própria prova, fecha ao centavo.
  // Contas que o fold marcou como IGNORADAS, por período — a árvore carimba o
  // destino "(ignorada pelo analista)" em cada nó. É a primeira suspeita quando
  // o balanço não fecha: ignorar tira da montagem sem tirar do documento.
  const ignoradasPorPeriodo = new Map<string, Array<{ nome: string; valor: number }>>();
  for (const [per, capa] of Object.entries(arvoreOriginalBP)) {
    const achadas: Array<{ nome: string; valor: number }> = [];
    const anda = (itens: unknown): void => {
      if (!Array.isArray(itens)) return;
      for (const it of itens as Array<{ nome?: string; valor?: number; destino?: string; filhos?: unknown }>) {
        if (typeof it?.destino === "string" && it.destino.includes("ignorada") && typeof it.valor === "number" && it.valor !== 0) {
          achadas.push({ nome: String(it.nome ?? "?"), valor: it.valor });
        }
        if (it?.filhos) anda(it.filhos);
      }
    };
    for (const itens of Object.values((capa as { grupos?: Record<string, unknown> })?.grupos ?? {})) anda(itens);
    if (achadas.length) ignoradasPorPeriodo.set(per, achadas);
  }

  const valorEm = (conta: string, p: string): number =>
    (bp.find((x) => x.conta === conta)?.valores as Record<string, number> | undefined)?.[p] ?? 0;
  /** Mesmo rótulo curto da tela: "2024" (exercício) · "05/2026" (mês). */
  const rotuloDaColuna = (p: string): string => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(p.trim());
    if (!m) return p;
    return tipoPorPeriodo[p] === "mes" ? `${m[2]}/${m[3]}` : m[3]!;
  };
  const provaPatrimonial: Record<string, { ativo: number; passivo: number; gap: number; ok: boolean }> = {};
  for (const p of periodos) {
    const ativo = valorEm("Ativo Total", p);
    const passivo = valorEm("Passivo Total", p);
    if (Math.abs(ativo) < 0.5 && Math.abs(passivo) < 0.5) continue; // coluna só de DRE
    const gap = Math.round((ativo - passivo) * 100) / 100;
    const ok = Math.abs(gap) <= Math.max(1, Math.abs(ativo) * 0.0001);
    provaPatrimonial[p] = { ativo, passivo, gap, ok };
    if (!ok) {
      // A CAUSA ANTES DA CULPA (10/08/2026, caso Dunamys): quando há conta
      // MARCADA COMO IGNORADA na coluna, ela é a primeira suspeita — ignorar
      // tira o valor da montagem sem tirar do documento. Dizer "a extração não
      // fechou" aí é mentira: a leitura estava certa ao centavo.
      const ignoradas = ignoradasPorPeriodo.get(p) ?? [];
      const somaIgnorada = ignoradas.reduce((s2, x) => s2 + Math.abs(x.valor), 0);
      if (ignoradas.length > 0 && Math.abs(Math.abs(gap) - somaIgnorada) <= Math.max(1, Math.abs(gap) * 0.01)) {
        avisos.push(
          `${rotuloDaColuna(p)}: o balanço não fecha por causa de conta MARCADA COMO IGNORADA — ${ignoradas.map((x) => `"${x.nome}" (${fmtBRL(x.valor)})`).join(", ")}. ` +
          `A diferença (${fmtBRL(gap)}) é exatamente esse valor: a leitura do documento está correta; o que tirou a conta da montagem foi a marcação de ignorar. ` +
          `Desfaça o ignorar na auditoria abaixo (ou classifique a conta) e o balanço volta a fechar.`,
        );
        continue;
      }
      avisos.push(
        `${rotuloDaColuna(p)}: o balanço lido não fecha — Ativo ${fmtBRL(ativo)} × Passivo + PL ${fmtBRL(passivo)} (diferença de ${fmtBRL(gap)}). ` +
        `Origem: ${origemPorPeriodo[p] ?? "documento"}. Enquanto isso o Fluxo de Caixa desta coluna não pode fechar — ele é derivado do balanço.`,
      );
    }
  }

  // O dinheiro que entrou do documento saiu todo para as linhas? Quando não,
  // a coluna nomeia a conta — é o diagnóstico do "FC não bate com o BP".
  for (const [p, k] of Object.entries(conservacaoPorPeriodo)) {
    if (k.ok) continue;
    const v = k.vazamentos[0];
    avisos.push(
      `${rotuloDaColuna(p)}: conservação de valor não fecha — entrou ${fmtBRL(k.entrou)} do documento e saiu ${fmtBRL(k.saiu)} nas linhas (diferença ${fmtBRL(k.diferenca)})` +
      (v ? `. O dinheiro ficou em "${v.conta}" (${fmtBRL(v.valor)}): ${v.motivo}.` : ".") +
      ` Enquanto isso o Fluxo de Caixa desta coluna não pode fechar.`,
    );
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
  type Sugestao = { sugestao: string; justificativa: string; confianca: string; verificar?: string };

  /**
   * CANDIDATAS VÁLIDAS PARA ESTA LINHA (10/08/2026 — "isso é fundamental, não
   * pode ter erro"). A dica era calculada contra o modelo INTEIRO e saía
   * inválida: "Perdas em operações NDF" (despesa) recebia "Receitas
   * Financeiras"; "Empréstimos a terceiros" (ativo) recebia "Empréstimos e
   * Financiamentos - CP" (passivo). A tela então SUPRIMIA a dica inválida — e
   * o analista via "umas contas trazem dica, outras não".
   *
   * O servidor passa a usar a MESMA régua do dropdown:
   *  - DRE: natureza pelo SINAL do valor (entrada só oferece receita; saída,
   *    nunca) — igual a `dreGroupsPorNatureza` no OriginalTreeView;
   *  - BP: só contas do MESMO grupo patrimonial da linha (AC/ANC/PC/PNC/PL) —
   *    igual a `gruposDo`.
   * Sem candidata válida, nenhuma dica: melhor silêncio que dica impossível.
   */
  const ehContaDeReceita = (conta: string) => /^(receitas?\b|outras receitas)/i.test(conta.trim());
  const candidatosDREPara = (valor: number): string[] =>
    valor === 0 ? candidatosDRE : candidatosDRE.filter((c) => ehContaDeReceita(c) === valor > 0);
  const CODIGO_DO_GRUPO: Record<string, string> = {
    "ativo circulante": "AC", "ativo nao circulante": "ANC",
    "passivo circulante": "PC", "passivo nao circulante": "PNC", "patrimonio liquido": "PL",
  };
  const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const candidatosBPPara = (grupo: string): string[] => {
    const code = CODIGO_DO_GRUPO[semAcento(raizGrupo(grupo))];
    if (!code) return candidatosBP;
    // O modelo usa SUBclassificações (AF/AO dentro de AC; PO/PF dentro de PC) —
    // é o mesmo mapa que o mapeamento de contas usa. Só linhas de INPUT: a
    // linha-subtotal "Ativo Circulante" não é destino de classificação.
    const aceitas = GRUPO_CLASSIF_MAP[code] ?? new Set([code]);
    const doGrupo = bpModel.lines
      .filter((l) => aceitas.has(l.classificacao) && l.tipo === "input")
      .map((l) => l.conta);
    return doGrupo.length ? doGrupo : candidatosBP;
  };
  // 💡 na ÁRVORE (09/08/2026, "não está vindo a sugestão"): o workspace não
  // paga IA — a sugestão é a DETERMINÍSTICA (similaridade de nome contra o
  // modelo da empresa), no MESMO shape que o OriginalTreeView já lê
  // (chave BP = `BP|grupo|nome`; DRE = `DRE|DRE|nome`). Honesta no rótulo.
  // Para DRE, o VOCABULÁRIO CONTÁBIL vem antes da similaridade de nome
  // (10/08/2026, "porque uns trazem dicas outros não?"): "Uniformes"/"EPI"/
  // "Aviso prévio" não se PARECEM com "Despesas com Pessoas" em texto, mas o
  // classificador do orçamento já SABE que são pessoal — e a similaridade
  // sozinha ainda errava por token ("Ajuda de Custo" → "Custo Operacional").
  const sugerirDre = (nome: string, valor: number): Sugestao | null => {
    // 1º o CONTEXTO do documento (irmã/consenso) — ver visitaDoc; 2º o
    // vocabulário contábil; 3º a similaridade com o modelo. Sempre contra as
    // candidatas VÁLIDAS para a natureza da linha.
    const validas = candidatosDREPara(valor);
    const ctx = contextoDRE.get(`DRE|DRE|${nome}`);
    if (ctx && validas.includes(ctx.sugestao)) return ctx;
    const porRegra = sugerirContaCanonica(nome, validas);
    if (porRegra) {
      return {
        sugestao: porRegra.conta,
        justificativa: `${porRegra.porque} (determinística, sem IA)`,
        confianca: porRegra.base === "similaridade" ? "média" : "alta",
      };
    }
    const porNome = sugerirConta(nome, validas);
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
  // MESMA régua conservadora da conversão (10/08/2026): o regex largo daqui
  // casava "RESULTADO FINANCEIRO LÍQUIDO" — uma linha legítima da DRE — e
  // oferecia "ignorar esta linha" para ela. Sugerir que o analista jogue fora
  // o resultado financeiro é pior do que não sugerir nada.
  const ehNomeResultado = (s: string) => ehNomeDeApuracao(s);
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
  // Tokens do nome, para medir parentesco entre IRMÃS do documento.
  const tokensDe = (s: string) =>
    new Set(s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  const parentesco = (a: string, b: string): number => {
    const ta = tokensDe(a), tb = tokensDe(b);
    if (!ta.size || !tb.size) return 0;
    let comuns = 0;
    for (const t of ta) if (tb.has(t)) comuns++;
    return comuns / new Set([...ta, ...tb]).size;
  };

  type NoDoc = { nome: string; destino?: string; filhos?: NoDoc[] };
  /**
   * CONTEXTO DO DOCUMENTO — vale para BP e DRE (10/08/2026, "contas que não
   * aparecem sugestão"). Ordem, da mais forte para a mais fraca:
   *   1. IRMÃ QUASE IGUAL (≥60% de tokens em comum) já classificada — "Perdas
   *      NDF - Contratos realizados" herda de "Perdas NDF - Contratos em
   *      aberto". É o sinal mais forte: o plano de contas nomeia famílias.
   *   2. CONSENSO das irmãs (≥60% no mesmo destino).
   *   3. NOME DO PAI parecido com uma conta do modelo.
   * O contexto vence o vocabulário genérico de propósito: "Vale transporte"
   * dentro de "CUSTOS COM PESSOAL (MOD)" é CUSTO, não despesa — quem sabe
   * disso é o documento, não a regra.
   */
  const visitaDoc = (
    itens: NoDoc[],
    ctx: { tipo: "BP" | "DRE"; grupoRaiz: string; pai: string | null; candidatos: Set<string>; lista: string[]; pendentes: Set<string>; destino: Map<string, Sugestao> },
  ): void => {
    const destinoReal = (d?: string): string | null => {
      if (!d) return null;
      const m = /^\(absorvido em (.+)\)$/.exec(d);
      const nome = m ? m[1]! : d;
      return !nome.startsWith("(") && ctx.candidatos.has(nome) ? nome : null;
    };
    const classificadas = itens
      .filter((i) => !ctx.pendentes.has(i.nome))
      .map((i) => ({ nome: i.nome, destino: destinoReal(i.destino) }))
      .filter((x): x is { nome: string; destino: string } => x.destino !== null);
    let consenso: Sugestao | null = null;
    if (classificadas.length) {
      const cont = new Map<string, number>();
      for (const c2 of classificadas) cont.set(c2.destino, (cont.get(c2.destino) ?? 0) + 1);
      const [top, n] = [...cont.entries()].sort((a, b) => b[1] - a[1])[0]!;
      if (n / classificadas.length >= 0.6) {
        consenso = {
          sugestao: top,
          justificativa: `as contas irmãs${ctx.pai ? ` de "${ctx.pai}"` : ""} no documento foram para esta conta (determinística, sem IA)`,
          confianca: "alta",
        };
      }
    }
    for (const it of itens) {
      if (ctx.pendentes.has(it.nome)) {
        const chave = `${ctx.tipo}|${ctx.grupoRaiz}|${it.nome}`;
        if (!ctx.destino.has(chave)) {
          const irma = classificadas
            .map((c2) => ({ ...c2, score: parentesco(it.nome, c2.nome) }))
            .sort((a, b) => b.score - a.score)[0];
          const porPai = ctx.pai ? sugerirConta(ctx.pai, ctx.lista) : null;
          const escolha: Sugestao | null = irma && irma.score >= 0.6
            ? { sugestao: irma.destino, justificativa: `a conta irmã "${irma.nome}" do mesmo grupo do documento foi para esta conta (determinística, sem IA)`, confianca: "alta" }
            : consenso ?? (porPai
              ? { sugestao: porPai, justificativa: `o grupo do documento ("${ctx.pai}") se parece com esta conta do modelo (determinística, sem IA)`, confianca: "média" }
              : null);
          if (escolha) ctx.destino.set(chave, escolha);
        }
      }
      if (it.filhos?.length) visitaDoc(it.filhos, { ...ctx, pai: it.nome });
    }
  };
  for (const arv of Object.values(arvoreOriginalBP)) {
    const grupos = (arv as { grupos?: Record<string, BPN3Item[]> })?.grupos ?? {};
    for (const [gn, itens] of Object.entries(grupos)) {
      visitaDoc(itens as NoDoc[], { tipo: "BP", grupoRaiz: gn, pai: null, candidatos: candidatosBPSet, lista: candidatosBP, pendentes: pendentesBP, destino: contextoBP });
    }
  }
  // DRE: as seções do documento são as raízes; a mesma régua de contexto.
  const candidatosDRESet = new Set(candidatosDRE);
  const pendentesDRE = new Set(naoMapeados.filter((n) => n.tipo === "DRE").map((n) => n.nome));
  const contextoDRE = new Map<string, Sugestao>();
  for (const arv of Object.values(arvoreOriginalDRE)) {
    const secoes = (arv as NoDoc[]) ?? [];
    if (!Array.isArray(secoes)) continue;
    visitaDoc(secoes, { tipo: "DRE", grupoRaiz: "DRE", pai: null, candidatos: candidatosDRESet, lista: candidatosDRE, pendentes: pendentesDRE, destino: contextoDRE });
  }

  const sugestaoBP = (grupo: string, nome: string): Sugestao | null => {
    const validas = candidatosBPPara(grupo);
    const ctx = contextoBP.get(`BP|${raizGrupo(grupo)}|${nome}`);
    if (ctx && validas.includes(ctx.sugestao)) return ctx;
    const porNome = sugerirConta(nome, validas);
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
  /**
   * ÚLTIMO DEGRAU (10/08/2026): sem irmã, sem vocabulário e sem similaridade,
   * a dica honesta é o BALDE onde o fold JÁ está jogando a linha — a conta
   * "Outras Despesas/Receitas Operacionais" ou "Outros Ativos/Passivos" que o
   * destino do não-mapeado carrega. Confiança BAIXA e justificativa explícita:
   * o analista confirma (vira regra no dicionário) ou escolhe a conta certa,
   * mas nunca fica sem saber para onde o dinheiro foi.
   */
  const sugestaoBalde = (nm: NaoMapeado, candidatos: Set<string>): Sugestao | null => {
    const destino = (nm.destino ?? "").trim();
    if (!destino || destino.startsWith("(") || !candidatos.has(destino)) return null;
    return {
      sugestao: destino,
      justificativa: `sem conta equivalente no modelo: é onde esta linha já está sendo somada hoje (seção "${raizGrupo(nm.grupo)}" do documento) — confirme ou escolha a conta certa`,
      confianca: "baixa",
    };
  };
  const sugestoesIA: Record<string, Sugestao> = {};
  for (const nm of naoMapeados) {
    // A MESMA conta troca de natureza entre períodos (caso real Belagro:
    // "Perdas NDF - Contratos em aberto" é +124.802 em set/25 e −1.395.434 em
    // jan/26; "Bonificação e Brindes" idem). Uma chave só por nome fazia a dica
    // da primeira ocorrência valer para todas — e ficar INVÁLIDA na de sinal
    // oposto, que a tela então suprimia. A chave da DRE carrega o sinal; a
    // chave sem sinal continua gravada para quem lê no formato antigo.
    const sinal = nm.tipo === "DRE" ? (nm.valor > 0 ? "|+" : "|-") : "";
    const chaveBase = nm.tipo === "BP" ? `BP|${raizGrupo(nm.grupo)}|${nm.nome}` : `DRE|DRE|${nm.nome}`;
    const chave = `${chaveBase}${sinal}`;
    if (sugestoesIA[chave]) continue;
    const esp = nm.tipo === "DRE" ? espelhoDre.get(nm.nome) : undefined;
    const sug = nm.tipo === "DRE"
      ? (esp ? sugestaoIgnorar(esp) : sugerirDre(nm.nome, nm.valor) ?? sugestaoBalde(nm, new Set(candidatosDREPara(nm.valor))))
      : sugestaoBP(nm.grupo, nm.nome) ?? sugestaoBalde(nm, new Set(candidatosBPPara(nm.grupo)));
    if (sug) {
      sugestoesIA[chave] = sug;
      sugestoesIA[chaveBase] ??= sug;
    }
  }
  const pendencias = [...pendMap.values()]
    .sort((x, y) => Math.abs(y.valorUltimo) - Math.abs(x.valorUltimo))
    .map((pd) => ({
      ...pd,
      // MESMA cascata da árvore (inclusive o balde): o quadro não pode dizer
      // "sem sugestão" para uma linha que a árvore ao lado sugere.
      sugestao: pd.tipo === "DRE"
        ? (espelhoDre.has(pd.nome) ? null : (sugestoesIA[`DRE|DRE|${pd.nome}`]?.sugestao ?? null))
        : (sugestoesIA[`BP|${raizGrupo(pd.grupo)}|${pd.nome}`]?.sugestao ?? null),
    }));

  // ── CONCILIAÇÃO POR DOCUMENTO (10/08/2026, garantia 6 do dono: "documento
  // que ainda não foi conciliado 100% não pode ser usado em IBR") ──
  // UM lugar decide, e a mesma resposta serve à tela de Conciliação e ao
  // wizard do IBR. Conciliado = leitura sem erro + TODAS as provas que rodaram
  // passaram + nenhuma conta do documento pendente de classificação.
  const pendPorPeriodo = new Map<string, number>();
  for (const nm of naoMapeados) pendPorPeriodo.set(nm.periodo, (pendPorPeriodo.get(nm.periodo) ?? 0) + 1);
  const fimDoIntervalo = (per: string | null): string[] => {
    if (!per) return [];
    return per.split(" · ").flatMap((t) => {
      const partes = t.split(" a ");
      return [(partes[partes.length - 1] ?? "").trim()].filter(Boolean);
    });
  };
  const conciliacaoPorDocumento: Record<string, { ok: boolean; motivos: string[] }> = {};
  for (const r of relatorio) {
    const motivos: string[] = [];
    if (!r.lido) motivos.push(r.erro ?? "documento ainda não lido");
    else {
      if (r.fechamentoOk === false) motivos.push(r.erro ?? "as provas do documento não fecham");
      const pend = fimDoIntervalo(r.periodo).reduce((s2, p) => s2 + (pendPorPeriodo.get(p) ?? 0), 0);
      if (pend > 0) motivos.push(`${pend} conta(s) sem classificação`);
      const prova = fimDoIntervalo(r.periodo).map((p) => provaPatrimonial[p]).find((x) => x && !x.ok);
      if (prova) motivos.push(`o balanço da coluna não fecha (diferença de ${fmtBRL(prova.gap)})`);
      const cons = fimDoIntervalo(r.periodo).map((p) => conservacaoPorPeriodo[p]).find((x) => x && !x.ok);
      if (cons) motivos.push(`conservação de valor não fecha (diferença de ${fmtBRL(cons.diferenca)})`);
    }
    conciliacaoPorDocumento[r.documentId] = { ok: motivos.length === 0, motivos };
  }

  const payload = {
    periodos,
    conciliacaoPorDocumento,
    fc,
    arvoreOriginalBP,
    arvoreOriginalDRE,
    naoMapeadosDetalhe: naoMapeados,
    origemPorPeriodo,
    tipoPorPeriodo,
    provasPorPeriodo,
    provaPatrimonial,
    conservacaoPorPeriodo,
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
  cacheHistorico.set(chave, { marca, payload });
  res.json(payload);
});

export default router;
