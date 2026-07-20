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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { prisma } from "../db/client";
import { env } from "../config/env";
import type { Indicador } from "../types/financial";
import { CVM_URLS, baixarCvmZipParaDisco, checarCvmAtualizacao, coletaLixo, parseCvmZip, persistirCvm, type CvmEmpresa, type CvmPeriodoDados } from "./cvm-ingest";
import { uploadFile, downloadFileComMeta } from "./storage";
import { indicadoresDaEmpresa } from "./cvm-metrics";

const arquivoId = (tipo: "itr" | "dfp", ano: number) => `${tipo}_${ano}`;

/** Reconstrói CvmEmpresa a partir do banco (períodos já persistidos) — base p/ LTM.
 *  dtFimMin/dtFimMax limitam a janela carregada (memória: container de 1GB) — o LTM
 *  olha no máximo 4 trimestres p/ trás e a média de BP 12 meses, então 16 meses
 *  ANTES do dtFim mais antigo bastam; e nada DEPOIS do mais novo é usado. Sem o
 *  TETO, o reprocesso (banco já cheio) carregava a base inteira p/ recalcular
 *  2010 → heap 179MB → crash-loop no dfp_2010. */
export async function carregaEmpresasDoBanco(cnpjs: string[], dtFimMin?: Date, dtFimMax?: Date): Promise<Map<string, CvmEmpresa>> {
  const out = new Map<string, CvmEmpresa>();
  const companies = await prisma.cvmCompany.findMany({ where: { cnpj: { in: cnpjs } } });
  const periods = await prisma.cvmPeriod.findMany({
    where: {
      cnpj: { in: cnpjs },
      ...(dtFimMin || dtFimMax ? { dtFim: { ...(dtFimMin ? { gte: dtFimMin } : {}), ...(dtFimMax ? { lte: dtFimMax } : {}) } } : {}),
    },
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
  opts?: { retomando?: boolean },
): Promise<number> {
  if (dtFims.length === 0 || cnpjs.length === 0) return 0;
  // janela: do dtFim mais antigo recalculado, 16 meses p/ trás (LTM = 4 tri + BP médio
  // 12m) ATÉ o dtFim mais novo — nunca a base inteira.
  const ordenados = [...dtFims].sort();
  const minDt = new Date(`${ordenados[0]}T00:00:00Z`);
  const dtFimMin = new Date(Date.UTC(minDt.getUTCFullYear(), minDt.getUTCMonth() - 16, 1));
  const dtFimMax = new Date(`${ordenados[ordenados.length - 1]}T00:00:00Z`);
  const dts = dtFims.map((d) => new Date(`${d}T00:00:00Z`));

  // O apagão do range é a PRIMEIRA coisa da execução limpa (antes de carregar as
  // empresas, que é lento) — é o que dá sentido ao filtro da retomada abaixo.
  // Regrava em lotes conforme acumula (memória bounded).
  let alvo = cnpjs;
  if (opts?.retomando) {
    // Como a execução original apagou o range inteiro logo de saída, quem TEM
    // indicador aqui só pode ter sido regravado por ela — é seguro pular. E um lote
    // do createMany é atômico e sempre fecha em fronteira de empresa, então ninguém
    // fica gravado pela metade.
    const feitas = await prisma.cvmIndicator.findMany({
      where: { cnpj: { in: cnpjs }, dtFim: { in: dts } },
      distinct: ["cnpj"],
      select: { cnpj: true },
    });
    const prontas = new Set(feitas.map((f) => f.cnpj));
    alvo = cnpjs.filter((c) => !prontas.has(c));
    console.log(`[cvm-sync] retomada do recálculo: ${prontas.size} empresas já prontas · ${alvo.length} restantes`);
    if (alvo.length === 0) return 0;
  } else {
    await prisma.cvmIndicator.deleteMany({ where: { cnpj: { in: cnpjs }, dtFim: { in: dts } } });
  }
  type Registro = { cnpj: string; dtFim: Date; visao: string; nome: string; valor: number | null; texto: string | null };
  let lote: Registro[] = [];
  let gravados = 0;
  const grava = async () => {
    if (lote.length === 0) return;
    await prisma.cvmIndicator.createMany({ data: lote });
    gravados += lote.length;
    lote = [];
  };

  /**
   * EM BLOCOS — antes, TODAS as empresas do arquivo (~683) e seus períodos de 16 meses
   * eram carregadas de uma vez antes do laço: um grafo vivo de centenas de MB que ficava
   * retido do começo ao fim do recálculo. Isso pressiona as duas causas de morte ao mesmo
   * tempo: aproxima o teto de 1GB e, pior, alonga as pausas de GC major — que BLOQUEIAM
   * o event loop e derrubam o /health (timeout de 1s). Com blocos de 40, o conjunto vivo
   * fica ~17× menor e cada pausa de GC é proporcionalmente mais curta.
   */
  const TAMANHO_BLOCO = 40;
  let feitas = 0;
  for (let inicio = 0; inicio < alvo.length; inicio += TAMANHO_BLOCO) {
    const bloco = alvo.slice(inicio, inicio + TAMANHO_BLOCO);
    const empresas = await carregaEmpresasDoBanco(bloco, dtFimMin, dtFimMax);
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
        await onProgresso?.(feitas, alvo.length);
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
    // Fecha o bloco antes de soltá-lo: além de liberar memória, garante que nenhuma
    // empresa fique só no lote em memória — a retomada depende de "tem linha = pronta".
    await grava();
    empresas.clear();
    coletaLixo();
    await new Promise<void>((r) => setTimeout(r, 150));
  }
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

const chaveSpaces = (arquivo: string) => `cvm/${arquivo}.zip`;

/**
 * Obtém o ZIP: da CVM (padrão — fonte de verdade p/ atualizações) ou do nosso
 * ARQUIVO no Spaces (reprocesso/recalibração: mesmos bytes que geraram a base,
 * sem depender da CVM). Todo download da CVM é espelhado no Spaces com o
 * ETag/Last-Modified nos metadados do objeto — o espelho nunca fica para trás.
 */
async function obterZip(
  tipo: "itr" | "dfp",
  ano: number,
  doArquivo: boolean,
): Promise<{ caminho: string; etag: string | null; lastModified: string | null; origem: "cvm" | "spaces" }> {
  const arquivo = arquivoId(tipo, ano);
  if (doArquivo && env.spaces.enabled) {
    try {
      const { buffer, metadata } = await downloadFileComMeta(chaveSpaces(arquivo));
      const caminho = join(tmpdir(), `cvm-spaces-${arquivo}.zip`);
      await fs.writeFile(caminho, buffer);
      coletaLixo();
      console.log(`[cvm-sync] ${arquivo}: usando espelho do Spaces (${(buffer.length / 1e6).toFixed(1)}MB)`);
      return { caminho, etag: metadata["cvm-etag"] ?? null, lastModified: metadata["cvm-last-modified"] ?? null, origem: "spaces" };
    } catch {
      console.log(`[cvm-sync] ${arquivo}: sem espelho no Spaces — baixando da CVM`);
    }
  }
  const baixado = await baixarCvmZipParaDisco(CVM_URLS[tipo](ano));
  // Espelha no Spaces (arquivamento) — falha aqui não derruba o sync.
  if (env.spaces.enabled) {
    try {
      const buf = await fs.readFile(baixado.caminho);
      const meta: Record<string, string> = {};
      if (baixado.etag) meta["cvm-etag"] = baixado.etag;
      if (baixado.lastModified) meta["cvm-last-modified"] = baixado.lastModified;
      await uploadFile(buf, chaveSpaces(arquivo), "application/zip", meta);
      coletaLixo();
    } catch (e) {
      console.warn(`[cvm-sync] ${arquivo}: arquivamento no Spaces falhou (segue sem espelho):`, e instanceof Error ? e.message : e);
    }
  }
  return { caminho: baixado.caminho, etag: baixado.etag, lastModified: baixado.lastModified, origem: "cvm" };
}

/** Pipeline completo de um arquivo da CVM — chamado pela rota/admin (server-side). */
export async function sincronizarCvm(
  tipo: "itr" | "dfp",
  ano: number,
  opts?: { doArquivo?: boolean },
): Promise<ResultadoSync> {
  const arquivo = arquivoId(tipo, ano);
  await marcaFase(`${arquivo}: baixando`);
  // Download em STREAMING para disco (não segura o ZIP em RAM duas vezes).
  const baixado = await obterZip(tipo, ano, opts?.doArquivo === true);
  console.log(`[cvm-sync] ${arquivo}: processando (origem ${baixado.origem})…`);

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

  // CHECKPOINT — daqui pra frente o arquivo já está inteiro no banco (empresas e
  // períodos persistidos); só falta indicador. Se o container morrer no recálculo —
  // a fase longa, onde ele de fato morre —, a retomada parte deste ponto em vez de
  // rebaixar ~100MB e parsear tudo de novo só para morrer na mesma altura.
  if (progHist.emAndamento) {
    progHist.checkpoint = { arquivo, dtFims, etag, lastModified, empresas, periodos };
    await salvaSnapshotHistorico();
  }
  const indicadores = await recalculaIndicadores(cnpjs, dtFims, (i, n) => marcaFase(`${arquivo}: recalculando ${i}/${n} empresas`));
  await marcaFase(`${arquivo}: gravando estado`);

  await prisma.cvmSyncState.upsert({
    where: { arquivo },
    update: { etag, lastModified, processadoEm: new Date(), empresas, periodos },
    create: { arquivo, etag, lastModified, processadoEm: new Date(), empresas, periodos },
  });
  if (progHist.emAndamento) {
    progHist.checkpoint = null; // arquivo fechado: nada pendente para retomar
    await salvaSnapshotHistorico();
  }
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
  /** quantas vezes o BOOT retomou esta execução automaticamente (trava anti-loop). */
  autoRetomadas?: number;
  /**
   * QUAL operação estava rodando. A auto-retomada precisa repetir a MESMA: retomar
   * um arquivo isolado como se fosse o histórico não faz nada, porque o histórico
   * PULA arquivo que já tem CvmSyncState — foi assim que uma ressincronização de
   * DFP 2025 morta no meio ficou eternamente "interrompida" sem nunca refazer.
   * Ausente = snapshot antigo, anterior a este campo → trata como histórico.
   */
  modo?: "historico" | "arquivo" | "recalc" | "pendentes";
  /** Alvo do modo "arquivo" — o único que não é reconstruível a partir do plano. */
  alvo?: { tipo: "itr" | "dfp"; ano: number } | null;
  /** Modo "historico" disparado como reprocessamento (recalibração). */
  reprocessar?: boolean;
  /**
   * Presente quando a morte pegou o arquivo JÁ persistido, faltando só indicadores.
   * A retomada então pula download+parse+persistência e continua empresa a empresa —
   * sem isto, cada restart recomeçava o arquivo do zero e morria sempre na mesma
   * altura do recálculo (caso real: DFP 2024 travado em ~375/683 a cada tentativa).
   */
  checkpoint?: CheckpointRecalculo | null;
}

/** Retrato do que falta para dar um arquivo por sincronizado: os períodos já estão
 *  no banco; guardamos o de-para do CvmSyncState p/ gravá-lo quando o recálculo terminar. */
export interface CheckpointRecalculo {
  arquivo: string;
  dtFims: string[];
  etag: string | null;
  lastModified: string | null;
  empresas: number;
  periodos: number;
}

// Estado em memória do seed (1 por processo — a rota bloqueia disparo duplo).
const progHist: ProgressoHistorico = {
  emAndamento: false, total: 0, feitos: 0, atual: null,
  ok: [], pulados: [], erros: [], iniciadoEm: null, terminadoEm: null, fase: null,
};

/**
 * DIAGNÓSTICO DA MORTE (as execuções longas morrem e nunca soubemos por quê).
 *
 * Duas causas concorrentes explicam igualmente bem o que se via — e a instrumentação
 * antiga não distinguia entre elas:
 *   (a) memória: o container é de 1GB e o OOM killer manda SIGKILL, sem aviso;
 *   (b) health check: o /health do DigitalOcean tem timeout de 1s (default) e 9
 *       falhas seguidas reiniciam o container. Recálculo é CPU síncrona no MESMO
 *       processo — se o event loop trava >1s, o /health não responde.
 *
 * A ausência de "⚡SIGTERM recebido" NÃO decidia: com o loop travado, o próprio
 * handler do sinal não roda, então (a) e (b) deixam o mesmo rastro.
 *
 * Agora cada amostra grava o PICO de RSS (contra o teto de 1GB) e o ATRASO MÁXIMO
 * do event loop na janela. Na próxima queda o snapshot responde sozinho: pico perto
 * de 1000MB ⇒ (a); loop acima de 1000ms ⇒ (b).
 */
const atrasoLoop = monitorEventLoopDelay({ resolution: 20 });
atrasoLoop.enable();
let picoRss = 0;

/** Pico de RSS observado nas operações longas — exposto no /version. */
export function getPicoRssMB(): number {
  return Math.round(picoRss / 1e6);
}

// Heartbeat de fase: grava no snapshot no MÁXIMO a cada 3s (barato, mas suficiente
// p/ apontar onde uma morte abrupta aconteceu). Só atua durante o seed histórico.
let ultimaFaseGravada = 0;
async function marcaFase(fase: string): Promise<void> {
  if (!progHist.emAndamento) return;
  const m = process.memoryUsage();
  if (m.rss > picoRss) picoRss = m.rss;
  // atrasoLoop.max é o pior atraso desde o último reset — e o reset só acontece
  // quando a amostra é PERSISTIDA, então o número medido é sempre "pior caso na
  // janela de ~3s que antecedeu esta gravação".
  const loopMs = Math.round(atrasoLoop.max / 1e6);
  progHist.fase =
    `${fase} · heap ${Math.round(m.heapUsed / 1e6)}MB · ext ${Math.round(m.external / 1e6)}MB` +
    ` · rss ${Math.round(m.rss / 1e6)}MB · pico ${Math.round(picoRss / 1e6)}MB/1024 · loop ${loopMs}ms`;
  const agora = Date.now();
  if (agora - ultimaFaseGravada < 3000) return;
  ultimaFaseGravada = agora;
  atrasoLoop.reset();
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
export async function sincronizarHistoricoCvm(reprocessar = false, autoRetomadas = 0): Promise<void> {
  if (progHist.emAndamento) throw new Error("Sincronização do histórico já em andamento");
  // Num reprocesso TUDO é refeito, então um checkpoint pendente perde o sentido.
  const pendente = reprocessar ? null : await checkpointPendente();
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
    autoRetomadas, modo: "historico", alvo: null, reprocessar, checkpoint: pendente,
  });
  console.log(`[cvm-sync] seed histórico iniciado — ${plano.length} arquivos (${plano[0].tipo}_${plano[0].ano} → ${plano[plano.length - 1].tipo}_${plano[plano.length - 1].ano})`);
  await salvaSnapshotHistorico();
  try {
    // Arquivo morto na fase de recálculo entra ANTES do plano: como ele não chegou a
    // gravar CvmSyncState, o laço abaixo o refaria do zero — download, parse e tudo.
    if (pendente) {
      progHist.atual = pendente.arquivo;
      try {
        await concluiCheckpoint(pendente);
        progHist.ok.push(pendente.arquivo);
      } catch (e) {
        progHist.erros.push({ arquivo: pendente.arquivo, erro: e instanceof Error ? e.message : String(e) });
      }
    }
    for (const { tipo, ano } of plano) {
      const arquivo = arquivoId(tipo, ano);
      progHist.atual = arquivo;
      await salvaSnapshotHistorico();
      const jaFeito = await prisma.cvmSyncState.findUnique({ where: { arquivo } });
      if (jaFeito) {
        progHist.pulados.push(arquivo);
      } else {
        try {
          // Reprocesso (recalibração): prefere o espelho do Spaces — mesmos bytes,
          // sem depender da CVM. Sync normal/retomada: direto da CVM.
          await sincronizarCvm(tipo, ano, { doArquivo: reprocessar });
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

/**
 * Fecha um arquivo que morreu NA FASE DE RECÁLCULO. Os períodos já estão no banco,
 * então aqui não há download nem parse: recalcula só as empresas que faltaram e grava
 * o CvmSyncState. É isto que faz cada retomada ANDAR — antes, toda tentativa repetia o
 * arquivo inteiro e morria na mesma altura (DFP 2024 preso em ~375/683 indefinidamente).
 */
async function concluiCheckpoint(cp: CheckpointRecalculo): Promise<void> {
  await marcaFase(`${cp.arquivo}: retomando recálculo`);
  const dts = cp.dtFims.map((d) => new Date(`${d}T00:00:00Z`));
  // A população vem do BANCO (o parse não existe mais): todo mundo com período nas
  // datas do arquivo. Superconjunto é inofensivo — quem já tem indicador é pulado.
  const linhas = await prisma.cvmPeriod.findMany({
    where: { dtFim: { in: dts } },
    distinct: ["cnpj"],
    select: { cnpj: true },
  });
  const n = await recalculaIndicadores(
    linhas.map((l) => l.cnpj),
    cp.dtFims,
    (i, t) => marcaFase(`${cp.arquivo}: retomando recálculo ${i}/${t} empresas`),
    { retomando: true },
  );
  await prisma.cvmSyncState.upsert({
    where: { arquivo: cp.arquivo },
    update: { etag: cp.etag, lastModified: cp.lastModified, processadoEm: new Date(), empresas: cp.empresas, periodos: cp.periodos },
    create: { arquivo: cp.arquivo, etag: cp.etag, lastModified: cp.lastModified, processadoEm: new Date(), empresas: cp.empresas, periodos: cp.periodos },
  });
  progHist.checkpoint = null;
  await salvaSnapshotHistorico();
  await prisma.systemNotice.updateMany({
    where: { tipo: "cvm_update", chave: { startsWith: `cvm:${cp.arquivo}:` }, lida: false },
    data: { lida: true },
  });
  console.log(`[cvm-sync] ${cp.arquivo}: recálculo retomado e concluído (+${n} indicadores nesta rodada)`);
}

/** Checkpoint pendente de uma execução que morreu, se houver. */
async function checkpointPendente(): Promise<CheckpointRecalculo | null> {
  const estado = await estadoHistorico();
  return estado.interrompido ? estado.checkpoint ?? null : null;
}

/**
 * FILA DE TRABALHO = os avisos não lidos. Não existe estado paralelo a manter: o
 * aviso é marcado como lido quando o arquivo fecha, então um arquivo já sincronizado
 * some da fila sozinho. É isso que torna a fila retomável de graça — depois de um
 * restart, basta reler os avisos para saber o que ainda falta.
 *
 * A ordem é a do PLANO (DFP 2010, ITR 2011, DFP 2011, …), não a de chegada do aviso:
 * o 4T e o LTM de um ano dependem do DFP do ano anterior já estar na base, então
 * processar fora de ordem produziria LTM nulo que ninguém recalcularia depois.
 */
export interface ItemFila { tipo: "itr" | "dfp"; ano: number; arquivo: string }

/** Parte pura: chaves de aviso ("cvm:dfp_2023:<versao>") → fila deduplicada e ordenada. */
export function filaDeAvisos(chaves: Array<string | null>, hoje = new Date()): ItemFila[] {
  const ordem = new Map(planoHistorico(hoje).map((p, i) => [arquivoId(p.tipo, p.ano), i]));
  const vistos = new Set<string>();
  const fila: ItemFila[] = [];
  for (const chave of chaves) {
    const arquivo = (chave ?? "").split(":")[1] ?? "";
    const [tipo, ano] = arquivo.split("_");
    if ((tipo !== "itr" && tipo !== "dfp") || !/^\d{4}$/.test(ano ?? "")) continue;
    if (vistos.has(arquivo)) continue; // várias versões do mesmo arquivo = um trabalho só
    vistos.add(arquivo);
    fila.push({ tipo, ano: Number(ano), arquivo });
  }
  // Fora do plano (ano exótico) vai para o fim, sem quebrar a ordem dos demais.
  fila.sort((a, b) => (ordem.get(a.arquivo) ?? 1e6) - (ordem.get(b.arquivo) ?? 1e6));
  return fila;
}

export async function pendentesCvm(): Promise<ItemFila[]> {
  const avisos = await prisma.systemNotice.findMany({
    where: { tipo: "cvm_update", lida: false },
    orderBy: { createdAt: "asc" },
    select: { chave: true },
  });
  return filaDeAvisos(avisos.map((a) => a.chave));
}

/**
 * Roda TODOS os arquivos pendentes em sequência, sem clique por arquivo.
 *
 * Retomável sem bookkeeping extra: cada arquivo que fecha marca seu aviso como lido,
 * então a auto-retomada no boot simplesmente relê a fila e continua do que sobrou —
 * e se a morte pegou o meio de um arquivo, o checkpoint fecha aquele primeiro.
 */
export async function sincronizarPendentesCvm(autoRetomadas = 0): Promise<void> {
  if (progHist.emAndamento) throw new Error("Já há um processamento em andamento");
  const pendenteCp = await checkpointPendente();
  const fila = await pendentesCvm();
  if (fila.length === 0 && !pendenteCp) {
    console.log("[cvm-sync] fila de pendentes vazia — nada a fazer");
    return;
  }
  Object.assign(progHist, {
    emAndamento: true, total: fila.length, feitos: 0, atual: null,
    ok: [], pulados: [], erros: [], iniciadoEm: new Date().toISOString(), terminadoEm: null,
    autoRetomadas, modo: "pendentes", alvo: null, reprocessar: false, checkpoint: pendenteCp,
  });
  await salvaSnapshotHistorico();
  console.log(`[cvm-sync] fila de pendentes iniciada — ${fila.length} arquivo(s): ${fila.map((f) => f.arquivo).join(", ")}`);
  try {
    // Arquivo morto no recálculo entra primeiro: ele NÃO tem CvmSyncState, então
    // seria refeito do zero se entrasse pelo caminho normal da fila.
    if (pendenteCp) {
      progHist.atual = pendenteCp.arquivo;
      try {
        await concluiCheckpoint(pendenteCp);
        progHist.ok.push(pendenteCp.arquivo);
      } catch (e) {
        progHist.erros.push({ arquivo: pendenteCp.arquivo, erro: e instanceof Error ? e.message : String(e) });
      }
    }
    for (const { tipo, ano, arquivo } of fila) {
      if (pendenteCp?.arquivo === arquivo) { progHist.feitos++; continue; } // já fechado acima
      progHist.atual = arquivo;
      await salvaSnapshotHistorico();
      try {
        await sincronizarCvm(tipo, ano);
        progHist.ok.push(arquivo);
        await prisma.systemNotice.updateMany({
          where: { tipo: "cvm_update", chave: { startsWith: `cvm:${arquivo}:` }, lida: false },
          data: { lida: true },
        });
      } catch (e) {
        const erro = e instanceof Error ? e.message : String(e);
        progHist.erros.push({ arquivo, erro });
        console.warn(`[cvm-sync] fila: ${arquivo} falhou (${erro}) — seguindo para o próximo`);
      }
      progHist.feitos++;
      coletaLixo();
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    progHist.emAndamento = false;
    progHist.atual = null;
    progHist.terminadoEm = new Date().toISOString();
    await salvaSnapshotHistorico();
    console.log(`[cvm-sync] fila terminou: ${progHist.ok.length} sincronizados · ${progHist.erros.length} erros`);
  }
}

/**
 * Sincroniza UM arquivo em SEGUNDO PLANO, reusando o progresso/lock do histórico.
 *
 * Antes o endpoint fazia `await sincronizarCvm(...)` dentro do request: um DFP com
 * ~640 empresas passa do limite do balanceador e o usuário via "A requisição
 * expirou" mesmo com o download seguindo no servidor. Aqui a rota responde 202 na
 * hora e a tela acompanha pelo mesmo progresso do histórico.
 */
export async function sincronizarArquivoCvm(tipo: "itr" | "dfp", ano: number, autoRetomadas = 0): Promise<void> {
  if (progHist.emAndamento) throw new Error("Já há um processamento em andamento");
  const arquivo = arquivoId(tipo, ano);
  // Se a morte anterior foi no recálculo DESTE arquivo, continua de onde parou em vez
  // de rebaixar tudo. Vale tanto para a auto-retomada quanto para o clique no botão.
  const pendente = await checkpointPendente();
  const cp = pendente?.arquivo === arquivo ? pendente : null;
  Object.assign(progHist, {
    emAndamento: true, total: 1, feitos: 0, atual: arquivo,
    ok: [], pulados: [], erros: [], iniciadoEm: new Date().toISOString(), terminadoEm: null,
    autoRetomadas, modo: "arquivo", alvo: { tipo, ano }, reprocessar: false, checkpoint: cp,
  });
  await salvaSnapshotHistorico();
  console.log(`[cvm-sync] ${cp ? `retomada do recálculo de ${arquivo}` : `ressincronização de ${arquivo}`} iniciada em background`);
  try {
    if (cp) await concluiCheckpoint(cp);
    else await sincronizarCvm(tipo, ano);
    progHist.ok.push(arquivo);
    // Sincronizou → o aviso daquela versão deixa de ser pendência.
    await prisma.systemNotice.updateMany({
      where: { tipo: "cvm_update", chave: { startsWith: `cvm:${arquivo}:` }, lida: false },
      data: { lida: true },
    });
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    progHist.erros.push({ arquivo, erro });
    console.error(`[cvm-sync] ressincronização de ${arquivo} falhou:`, erro);
  } finally {
    progHist.feitos = 1;
    progHist.emAndamento = false;
    progHist.atual = null;
    progHist.terminadoEm = new Date().toISOString();
    coletaLixo();
    await salvaSnapshotHistorico();
  }
}

/**
 * RECÁLCULO GERAL de indicadores — para erro de FÓRMULA (não de mapeamento):
 * lê os períodos já persistidos e regrava CvmIndicator, ano a ano, sem download
 * nem parse (~20-30 min). Usa o mesmo progresso/heartbeat do seed histórico.
 */
export async function recalcularIndicadoresTudo(autoRetomadas = 0): Promise<void> {
  if (progHist.emAndamento) throw new Error("Já há um processamento em andamento");
  const periodos = await prisma.cvmPeriod.findMany({ distinct: ["dtFim"], select: { dtFim: true }, orderBy: { dtFim: "asc" } });
  const porAno = new Map<number, string[]>();
  for (const p of periodos) {
    const dt = p.dtFim.toISOString().slice(0, 10);
    const ano = Number(dt.slice(0, 4));
    porAno.set(ano, [...(porAno.get(ano) ?? []), dt]);
  }
  const anos = [...porAno.keys()].sort();
  Object.assign(progHist, {
    emAndamento: true, total: anos.length, feitos: 0, atual: null,
    ok: [], pulados: [], erros: [], iniciadoEm: new Date().toISOString(), terminadoEm: null, fase: null,
    autoRetomadas, modo: "recalc", alvo: null, reprocessar: false,
  });
  console.log(`[cvm-sync] recálculo geral iniciado — ${anos.length} anos (${anos[0]}–${anos[anos.length - 1]})`);
  await salvaSnapshotHistorico();
  try {
    for (const ano of anos) {
      const rotulo = `recalc_${ano}`;
      progHist.atual = rotulo;
      await salvaSnapshotHistorico();
      try {
        const dtFims = porAno.get(ano)!;
        const dts = dtFims.map((d) => new Date(`${d}T00:00:00Z`));
        const cnpjs = await prisma.cvmPeriod.findMany({ where: { dtFim: { in: dts } }, distinct: ["cnpj"], select: { cnpj: true } });
        const n = await recalculaIndicadores(cnpjs.map((c) => c.cnpj), dtFims, (i, t) => marcaFase(`${rotulo}: ${i}/${t} empresas`));
        console.log(`[cvm-sync] ${rotulo}: ${n} indicadores`);
        progHist.ok.push(rotulo);
      } catch (e) {
        progHist.erros.push({ arquivo: rotulo, erro: e instanceof Error ? e.message : String(e) });
      }
      progHist.feitos++;
      coletaLixo();
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    progHist.emAndamento = false;
    progHist.atual = null;
    progHist.terminadoEm = new Date().toISOString();
    await salvaSnapshotHistorico();
    console.log(`[cvm-sync] recálculo geral terminou: ${progHist.ok.length} anos ok · ${progHist.erros.length} erros`);
  }
}

/**
 * AUTO-RETOMADA NO BOOT: os restarts da plataforma DO matam execuções longas no
 * meio; o snapshot no banco sabe (interrompido=true). Ao subir — depois dos seeds —
 * o servidor retoma sozinho, sem depender de clique.
 *
 * Retoma a MESMA operação que morreu (`modo` do snapshot). Antes disparava sempre o
 * histórico: para um arquivo isolado isso era um no-op silencioso, porque o histórico
 * pula quem já tem CvmSyncState — a ressincronização "interrompida" nunca refazia
 * nada e a tela ficava travada pedindo Retomar.
 *
 * Trava anti-loop por modo. Todas as tentativas AVANÇAM: o histórico fecha ≥1 arquivo
 * por rodada e o arquivo único retoma do checkpoint (só as empresas que faltaram), então
 * o limite é backstop contra o caso patológico — uma empresa que derrube o processo
 * sempre no mesmo ponto —, não orçamento de repetição. Disparo manual zera o contador.
 */
const MAX_AUTO_RETOMADAS: Record<"historico" | "arquivo" | "recalc" | "pendentes", number> = {
  historico: 20, arquivo: 8, recalc: 6, pendentes: 20,
};

/**
 * Descobre o modo de um snapshot. Snapshots gravados ANTES do campo `modo` existir
 * (inclusive o que estiver travado no banco no momento do deploy) são inferidos pela
 * forma: só a ressincronização de arquivo único usa total=1 com um id de arquivo em
 * `atual`; o recálculo geral rotula os passos como "recalc_<ano>". Sem esta inferência
 * o snapshot legado cairia em "histórico" e a retomada continuaria sendo um no-op.
 */
export function modoDoSnapshot(estado: ProgressoHistorico): {
  modo: "historico" | "arquivo" | "recalc" | "pendentes";
  alvo: { tipo: "itr" | "dfp"; ano: number } | null;
} {
  if (estado.modo) return { modo: estado.modo, alvo: estado.alvo ?? null };
  const atual = estado.atual ?? "";
  const m = /^(itr|dfp)_(\d{4})$/.exec(atual);
  if (m && estado.total === 1) return { modo: "arquivo", alvo: { tipo: m[1] as "itr" | "dfp", ano: Number(m[2]) } };
  if (/^recalc_\d{4}$/.test(atual)) return { modo: "recalc", alvo: null };
  return { modo: "historico", alvo: null };
}
export async function autoRetomarSeInterrompido(): Promise<void> {
  try {
    const estado = await estadoHistorico();
    if (!estado.interrompido || progHist.emAndamento) return;
    const { modo, alvo } = modoDoSnapshot(estado);
    const tentativas = estado.autoRetomadas ?? 0;
    const limite = MAX_AUTO_RETOMADAS[modo];
    if (tentativas >= limite) {
      console.warn(`[cvm-sync] auto-retomada SUSPENSA (modo ${modo}, ${tentativas}/${limite} tentativas) — retomar manualmente pela tela de pares`);
      return;
    }
    const proxima = tentativas + 1;
    console.log(`[cvm-sync] execução interrompida detectada (modo ${modo}, ${estado.feitos}/${estado.total}, ${estado.atual ?? "?"}) — auto-retomando (tentativa ${proxima}/${limite})`);
    if (modo === "pendentes") {
      await sincronizarPendentesCvm(proxima);
    } else if (modo === "arquivo" && alvo) {
      await sincronizarArquivoCvm(alvo.tipo, alvo.ano, proxima);
    } else if (modo === "recalc") {
      await recalcularIndicadoresTudo(proxima);
    } else {
      await sincronizarHistoricoCvm(estado.reprocessar ?? false, proxima);
    }
  } catch (e) {
    console.error("[cvm-sync] auto-retomada falhou:", e instanceof Error ? e.message : e);
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

/** Checa a CVM (HEAD) e cria SystemNotice quando há versão nova não processada.
 *  Vigia TODOS os arquivos do plano (2010→hoje), não só os recentes: reapresentação
 *  de ano antigo também vira aviso no Inbox. Custo ~zero (só cabeçalhos HTTP). */
export async function checarAtualizacoesCvm(): Promise<Array<{ arquivo: string; novo: boolean }>> {
  const resultados: Array<{ arquivo: string; novo: boolean }> = [];
  for (const { tipo, ano } of planoHistorico()) {
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
