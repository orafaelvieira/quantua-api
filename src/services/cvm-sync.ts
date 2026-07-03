/**
 * SINCRONIZAÇÃO CVM — orquestra o pipeline completo NO SERVIDOR:
 *   baixa da CVM → parse (cvm-ingest) → persiste períodos → recalcula indicadores
 *   nas 3 visões (cvm-metrics) → atualiza CvmSyncState (ETag/Last-Modified).
 *
 * O cron semanal (jobs/check-cvm-updates) compara o ETag publicado com o último
 * processado e cria um SystemNotice no Inbox quando há versão nova — a sincronização
 * em si é disparada pelo botão da tela de pares (ou futuramente automática).
 */
import { promises as fs } from "node:fs";
import { prisma } from "../db/client";
import type { Indicador } from "../types/financial";
import { CVM_URLS, baixarCvmZipParaDisco, checarCvmAtualizacao, coletaLixo, parseCvmZip, persistirCvm, type CvmEmpresa, type CvmPeriodoDados } from "./cvm-ingest";
import { indicadoresDaEmpresa } from "./cvm-metrics";

const arquivoId = (tipo: "itr" | "dfp", ano: number) => `${tipo}_${ano}`;

/** Reconstrói CvmEmpresa a partir do banco (períodos já persistidos) — base p/ LTM.
 *  dtFimMin limita a janela carregada (memória: container de 1GB) — o LTM olha no
 *  máximo 4 trimestres p/ trás e a média de BP 12 meses, então 16 meses bastam. */
async function carregaEmpresasDoBanco(cnpjs: string[], dtFimMin?: Date): Promise<Map<string, CvmEmpresa>> {
  const out = new Map<string, CvmEmpresa>();
  const companies = await prisma.cvmCompany.findMany({ where: { cnpj: { in: cnpjs } } });
  const periods = await prisma.cvmPeriod.findMany({
    where: { cnpj: { in: cnpjs }, ...(dtFimMin ? { dtFim: { gte: dtFimMin } } : {}) },
    orderBy: { dtFim: "asc" },
  });
  for (const c of companies) out.set(c.cnpj, { cnpj: c.cnpj, denom: c.denom, cdCvm: c.cdCvm, periodos: {} });
  for (const p of periods) {
    const emp = out.get(p.cnpj);
    if (!emp) continue;
    const dt = p.dtFim.toISOString().slice(0, 10);
    const dados: CvmPeriodoDados = {
      bp: (p.bp as Record<string, number>) ?? {},
      dreTri: (p.dreTri as Record<string, number>) ?? {},
      dreYtd: (p.dreYtd as Record<string, number>) ?? {},
      dfcYtd: (p.dfcYtd as CvmPeriodoDados["dfcYtd"]) ?? {},
    };
    // DFP e ITR do mesmo dtFim se complementam (mescla campo a campo)
    const ex = emp.periodos[dt];
    emp.periodos[dt] = ex
      ? { bp: { ...ex.bp, ...dados.bp }, dreTri: { ...ex.dreTri, ...dados.dreTri }, dreYtd: { ...ex.dreYtd, ...dados.dreYtd }, dfcYtd: { ...ex.dfcYtd, ...dados.dfcYtd } }
      : dados;
  }
  return out;
}

function numOuNull(v: number | string | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Recalcula e persiste CvmIndicator (3 visões) para os dtFims informados. */
async function recalculaIndicadores(
  cnpjs: string[],
  dtFims: string[],
  onProgresso?: (feitas: number, total: number) => void | Promise<void>,
): Promise<number> {
  if (dtFims.length === 0 || cnpjs.length === 0) return 0;
  // janela: do dtFim mais antigo recalculado, 16 meses p/ trás (LTM = 4 tri + BP médio 12m)
  const minDt = new Date(`${[...dtFims].sort()[0]}T00:00:00Z`);
  const dtFimMin = new Date(Date.UTC(minDt.getUTCFullYear(), minDt.getUTCMonth() - 16, 1));
  const empresas = await carregaEmpresasDoBanco(cnpjs, dtFimMin);

  // apaga o range recalculado antes; regrava em lotes conforme acumula (memória bounded)
  const dts = dtFims.map((d) => new Date(`${d}T00:00:00Z`));
  await prisma.cvmIndicator.deleteMany({ where: { cnpj: { in: cnpjs }, dtFim: { in: dts } } });

  type Registro = { cnpj: string; dtFim: Date; visao: string; nome: string; valor: number | null; texto: string | null };
  let lote: Registro[] = [];
  let gravados = 0;
  const grava = async () => {
    if (lote.length === 0) return;
    await prisma.cvmIndicator.createMany({ data: lote });
    gravados += lote.length;
    lote = [];
  };

  let feitas = 0;
  for (const emp of empresas.values()) {
    // calculateIndicators é CPU-síncrono. Pausa REAL (não só yield) a cada empresa:
    // a vCPU compartilhada do plano básico estrangula sob carga contínua e o health
    // check atrasa → DO reinicia o container (mortes com memória limpa em recalc;
    // perfil local: 0,3ms/empresa — em prod chega a 0,5s = throttling de ~1000×).
    // Ciclo de trabalho ~25%: 75ms/empresa + 1s a cada 25 — janelas generosas p/ o
    // scheduler e o /health, ao custo de ~1 min a mais por arquivo de fechamento.
    await new Promise<void>((r) => setTimeout(r, 75));
    feitas++;
    if (feitas % 25 === 0) {
      await new Promise<void>((r) => setTimeout(r, 1000));
      await onProgresso?.(feitas, empresas.size);
    }
    for (const dtFim of dtFims) {
      if (!emp.periodos[dtFim]) continue;
      // A UI replica indicadores de propósito (ex.: Margem Líquida repetida na cascata
      // DuPont) — na persistência a chave cnpj+dtFim+visão+nome é única, então dedupe.
      const vistos = new Set<string>();
      for (const visao of indicadoresDaEmpresa(emp, dtFim)) {
        const label = Object.keys(visao.indicadores[0]?.valores ?? {})[0];
        for (const ind of visao.indicadores as Indicador[]) {
          const chave = `${visao.visao}|${ind.nome}`;
          if (vistos.has(chave)) continue;
          vistos.add(chave);
          const v = ind.valores[label];
          lote.push({
            cnpj: emp.cnpj,
            dtFim: new Date(`${dtFim}T00:00:00Z`),
            visao: visao.visao,
            nome: ind.nome,
            valor: numOuNull(v),
            texto: typeof v === "string" ? v : null,
          });
        }
      }
    }
    if (lote.length >= 5000) await grava();
  }
  await grava();
  return gravados;
}

export interface ResultadoSync {
  arquivo: string;
  empresas: number;
  periodos: number;
  indicadores: number;
  etag: string | null;
  lastModified: string | null;
}

/** Pipeline completo de um arquivo da CVM — chamado pela rota/admin (server-side). */
export async function sincronizarCvm(tipo: "itr" | "dfp", ano: number): Promise<ResultadoSync> {
  const url = CVM_URLS[tipo](ano);
  const arquivo = arquivoId(tipo, ano);
  console.log(`[cvm-sync] baixando ${url}…`);
  await marcaFase(`${arquivo}: baixando`);
  // Download em STREAMING para disco (não segura o ZIP em RAM duas vezes).
  const baixado = await baixarCvmZipParaDisco(url);
  console.log(`[cvm-sync] ${arquivo}: ${(baixado.tamanho / 1e6).toFixed(1)}MB — processando…`);

  let parsed: Awaited<ReturnType<typeof parseCvmZip>>;
  try {
    parsed = await parseCvmZip(baixado.caminho, {
      onFase: (f) => marcaFase(`${arquivo}: parse ${f}`),
    });
  } finally {
    await fs.unlink(baixado.caminho).catch(() => {});
    coletaLixo(); // devolve os buffers do ZIP/download antes de seguir
  }
  const { etag, lastModified } = baixado;
  const { empresas, periodos } = await persistirCvm(parsed, tipo.toUpperCase() as "ITR" | "DFP", {
    onProgresso: (i, n) => marcaFase(`${arquivo}: persistindo ${i}/${n} empresas`),
  });

  // Recalcula indicadores só para os dtFims presentes no arquivo (LTM puxa histórico do banco).
  const dtFims = [...new Set([...parsed.values()].flatMap((e) => Object.keys(e.periodos)))].sort();
  const cnpjs = [...parsed.keys()];
  parsed = new Map(); // solta o parse antes do recálculo (container de 1GB)
  coletaLixo();
  const indicadores = await recalculaIndicadores(cnpjs, dtFims, (i, n) => marcaFase(`${arquivo}: recalculando ${i}/${n} empresas`));
  await marcaFase(`${arquivo}: gravando estado`);

  await prisma.cvmSyncState.upsert({
    where: { arquivo },
    update: { etag, lastModified, processadoEm: new Date(), empresas, periodos },
    create: { arquivo, etag, lastModified, processadoEm: new Date(), empresas, periodos },
  });
  console.log(`[cvm-sync] ${arquivo}: ${empresas} empresas · ${periodos} períodos · ${indicadores} indicadores`);
  return { arquivo, empresas, periodos, indicadores, etag, lastModified };
}

/* ───────── Histórico completo (seed 2010→hoje) ───────── */

// Dados abertos da CVM começam em DFP 2010 e ITR 2011.
const HISTORICO_INICIO = { dfp: 2010, itr: 2011 } as const;

/**
 * Plano do seed histórico — INTERCALADO por ano (DFP 2010, ITR 2011, DFP 2011,
 * ITR 2012, …). A ordem importa: o 4T de cada ano é derivado por diferença
 * (DFP 12M − ITR 3T) e o LTM cruza a virada de ano, então quando o ITR do ano N
 * é processado o DFP do ano N−1 já precisa estar no banco — senão os LTMs de
 * 1T/2T/3T do ano N sairiam nulos e nunca seriam recalculados.
 */
export function planoHistorico(hoje = new Date()): Array<{ tipo: "itr" | "dfp"; ano: number }> {
  const anoCorrente = hoje.getUTCFullYear();
  const plano: Array<{ tipo: "itr" | "dfp"; ano: number }> = [{ tipo: "dfp", ano: HISTORICO_INICIO.dfp }];
  for (let ano = HISTORICO_INICIO.itr; ano <= anoCorrente; ano++) {
    plano.push({ tipo: "itr", ano });
    if (ano < anoCorrente) plano.push({ tipo: "dfp", ano }); // DFP só existe p/ ano fechado
  }
  return plano;
}

export interface ProgressoHistorico {
  emAndamento: boolean;
  total: number;
  feitos: number;
  atual: string | null;
  ok: string[];
  pulados: string[]; // já sincronizados antes (retomada)
  erros: Array<{ arquivo: string; erro: string }>;
  iniciadoEm: string | null;
  terminadoEm: string | null;
  /** true quando a última execução morreu no meio (restart do container) — retomável. */
  interrompido?: boolean;
  /** heartbeat: última fase executada (com heap) — numa morte abrupta, aponta ONDE. */
  fase?: string | null;
}

// Estado em memória do seed (1 por processo — a rota bloqueia disparo duplo).
const progHist: ProgressoHistorico = {
  emAndamento: false, total: 0, feitos: 0, atual: null,
  ok: [], pulados: [], erros: [], iniciadoEm: null, terminadoEm: null, fase: null,
};

// Heartbeat de fase: grava no snapshot no MÁXIMO a cada 3s (barato, mas suficiente
// p/ apontar onde uma morte abrupta aconteceu). Só atua durante o seed histórico.
let ultimaFaseGravada = 0;
async function marcaFase(fase: string): Promise<void> {
  if (!progHist.emAndamento) return;
  const m = process.memoryUsage();
  progHist.fase = `${fase} · heap ${Math.round(m.heapUsed / 1e6)}MB · ext ${Math.round(m.external / 1e6)}MB · rss ${Math.round(m.rss / 1e6)}MB`;
  const agora = Date.now();
  if (agora - ultimaFaseGravada < 3000) return;
  ultimaFaseGravada = agora;
  await salvaSnapshotHistorico();
}

export function getProgressoHistorico(): ProgressoHistorico {
  return progHist;
}

/** Snapshot do progresso persistido no banco (linha reservada "_historico" do
 *  CvmSyncState, JSON no campo etag) — sobrevive a restart do container. */
const SNAPSHOT_ARQUIVO = "_historico";

async function salvaSnapshotHistorico(): Promise<void> {
  try {
    const json = JSON.stringify(progHist);
    await prisma.cvmSyncState.upsert({
      where: { arquivo: SNAPSHOT_ARQUIVO },
      update: { etag: json, processadoEm: new Date() },
      create: { arquivo: SNAPSHOT_ARQUIVO, etag: json, processadoEm: new Date(), empresas: 0, periodos: 0 },
    });
  } catch (e) {
    console.warn("[cvm-sync] snapshot do histórico não persistiu:", e instanceof Error ? e.message : e);
  }
}

/**
 * Sonda de diagnóstico: o DO manda SIGTERM antes de reiniciar por health check
 * (deploy também), mas um kill por OOM (SIGKILL) não avisa. Anotar o sinal no
 * snapshot diferencia os dois tipos de morte — só relevante com seed em andamento.
 */
export async function anotaSinal(sinal: string): Promise<void> {
  if (!progHist.emAndamento) return;
  progHist.fase = `${progHist.fase ?? ""} ⚡${sinal} recebido`;
  await salvaSnapshotHistorico().catch(() => {});
}

/**
 * Estado do histórico p/ a tela: memória quando este processo tem dados; senão o
 * snapshot do banco. Snapshot com emAndamento=true vindo do banco significa que a
 * execução MORREU no meio (restart) — devolve interrompido=true p/ a UI oferecer retomada.
 */
export async function estadoHistorico(): Promise<ProgressoHistorico> {
  if (progHist.emAndamento || progHist.total > 0) return progHist;
  try {
    const row = await prisma.cvmSyncState.findUnique({ where: { arquivo: SNAPSHOT_ARQUIVO } });
    if (row?.etag) {
      const snap = JSON.parse(row.etag) as ProgressoHistorico;
      if (snap.emAndamento) return { ...snap, emAndamento: false, interrompido: true };
      return snap;
    }
  } catch { /* snapshot ilegível → segue com a memória vazia */ }
  return progHist;
}

/**
 * Seed histórico completo — roda TODO o plano em sequência, no servidor.
 * Fire-and-forget (a rota devolve 202 e o painel acompanha pelo /status).
 * RETOMÁVEL: arquivo com CvmSyncState existente é pulado — se o processo cair
 * no meio (deploy/restart), basta disparar de novo que continua de onde parou.
 */
export async function sincronizarHistoricoCvm(reprocessar = false): Promise<void> {
  if (progHist.emAndamento) throw new Error("Sincronização do histórico já em andamento");
  if (reprocessar) {
    // Recalibração (ex.: mapa de contas novo): apaga só os MARCOS de sincronização —
    // os dados ficam; cada arquivo re-roda e sobrescreve via upsert. Retomável igual.
    await prisma.cvmSyncState.deleteMany({ where: { arquivo: { not: SNAPSHOT_ARQUIVO } } });
    console.log("[cvm-sync] reprocesso: marcos de sincronização limpos — histórico completo será re-executado");
  }
  const plano = planoHistorico();
  Object.assign(progHist, {
    emAndamento: true, total: plano.length, feitos: 0, atual: null,
    ok: [], pulados: [], erros: [], iniciadoEm: new Date().toISOString(), terminadoEm: null,
  });
  console.log(`[cvm-sync] seed histórico iniciado — ${plano.length} arquivos (${plano[0].tipo}_${plano[0].ano} → ${plano[plano.length - 1].tipo}_${plano[plano.length - 1].ano})`);
  await salvaSnapshotHistorico();
  try {
    for (const { tipo, ano } of plano) {
      const arquivo = arquivoId(tipo, ano);
      progHist.atual = arquivo;
      await salvaSnapshotHistorico();
      const jaFeito = await prisma.cvmSyncState.findUnique({ where: { arquivo } });
      if (jaFeito) {
        progHist.pulados.push(arquivo);
      } else {
        try {
          await sincronizarCvm(tipo, ano);
          progHist.ok.push(arquivo);
        } catch (e) {
          const erro = e instanceof Error ? e.message : String(e);
          progHist.erros.push({ arquivo, erro });
          console.warn(`[cvm-sync] histórico: ${arquivo} falhou (${erro}) — seguindo para o próximo`);
        }
        // pausa entre arquivos + coleta explícita: devolve a memória externa (buffers)
        coletaLixo();
        await new Promise((r) => setTimeout(r, 1500));
      }
      progHist.feitos++;
    }
  } finally {
    progHist.emAndamento = false;
    progHist.atual = null;
    progHist.terminadoEm = new Date().toISOString();
    await salvaSnapshotHistorico();
    console.log(`[cvm-sync] seed histórico terminou: ${progHist.ok.length} sincronizados · ${progHist.pulados.length} pulados · ${progHist.erros.length} erros`);
  }
}

/** Arquivos que o cron vigia: ITR do ano corrente e do anterior + DFP do ano anterior
 *  (reapresentações são comuns meses depois da entrega). */
export function arquivosVigiados(hoje = new Date()): Array<{ tipo: "itr" | "dfp"; ano: number }> {
  const ano = hoje.getUTCFullYear();
  return [
    { tipo: "itr", ano },
    { tipo: "itr", ano: ano - 1 },
    { tipo: "dfp", ano: ano - 1 },
  ];
}

/** Checa a CVM (HEAD) e cria SystemNotice quando há versão nova não processada. */
export async function checarAtualizacoesCvm(): Promise<Array<{ arquivo: string; novo: boolean }>> {
  const resultados: Array<{ arquivo: string; novo: boolean }> = [];
  for (const { tipo, ano } of arquivosVigiados()) {
    const arquivo = arquivoId(tipo, ano);
    try {
      const meta = await checarCvmAtualizacao(CVM_URLS[tipo](ano));
      if (!meta) { resultados.push({ arquivo, novo: false }); continue; }
      const estado = await prisma.cvmSyncState.findUnique({ where: { arquivo } });
      const mudou = !estado || (meta.etag ?? meta.lastModified) !== (estado.etag ?? estado.lastModified);
      resultados.push({ arquivo, novo: mudou });
      if (!mudou) continue;
      const chave = `cvm:${arquivo}:${meta.etag ?? meta.lastModified ?? "s/versao"}`;
      await prisma.systemNotice.upsert({
        where: { chave },
        update: {}, // já avisado desta versão — não duplica
        create: {
          tipo: "cvm_update",
          chave,
          titulo: `Base CVM atualizada: ${arquivo.toUpperCase().replace("_", " ")}`,
          corpo: `A CVM publicou uma nova versão (${meta.lastModified ?? meta.etag ?? "data não informada"}). Sincronize a base de pares para atualizar a comparação setorial.`,
          href: "/admin/pares",
        },
      });
    } catch (e) {
      console.warn(`[cvm-sync] checagem ${arquivo} falhou:`, e instanceof Error ? e.message : e);
      resultados.push({ arquivo, novo: false });
    }
  }
  return resultados;
}
