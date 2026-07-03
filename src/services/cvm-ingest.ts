/**
 * INGESTÃO CVM (DFP/ITR) — pipeline automático de pares.
 *
 * Lê os ZIPs de dados abertos da CVM, monta BP/DRE/DFC por empresa/período no plano
 * de contas do MODELO QUANTUA (cvm-map) e persiste em CvmCompany/CvmPeriod. Os
 * indicadores saem do MESMO `calculateIndicators` do motor (cvm-metrics), nas três
 * visões: TRI (trimestre isolado) · ANO (exercício) · LTM (últimos 12 meses).
 *
 * Regras (validadas com dados reais — estudo Automatizacao_ITRs_Bovespa + PoC 1T26):
 * - Consolidado preferido; individual como fallback por empresa/demonstrativo.
 * - ORDEM_EXERC = ÚLTIMO (pega reapresentações automaticamente).
 * - ESCALA_MOEDA MIL → valores em R$ (mesma unidade do motor).
 * - DRE do ITR vem em DUAS visões (a CVM publica ambas): acumulada no ano
 *   (DT_INI = 01/01) e TRIMESTRE ISOLADO (DT_INI = início do tri) — capturamos as duas.
 * - D&A não existe na DRE da CVM (embutida no custo) — extraída do DFC_MI (adição
 *   não-caixa sob 6.01 com descrição de depreciação/amortização), visão acumulada.
 * - Em PRODUÇÃO o download é feito PELO SERVIDOR direto da CVM (baixarCvmZip) —
 *   nenhuma máquina pessoal no circuito; o ZIP é descartado após o processamento.
 */
import AdmZip from "adm-zip";
import { createInflateRaw } from "node:zlib";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../db/client";
import { CVM_BP_MAP, CVM_DRE_MAP, CVM_DFC_MAP, CVM_EXCLUIR_DENOM } from "./cvm-map";

export const CVM_URLS = {
  itr: (ano: number) => `https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/ITR/DADOS/itr_cia_aberta_${ano}.zip`,
  dfp: (ano: number) => `https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/DFP/DADOS/dfp_cia_aberta_${ano}.zip`,
};

export interface CvmPeriodoDados {
  bp: Record<string, number>;
  dreTri: Record<string, number>; // DRE DISCRETA do trimestre (no DFP = ano inteiro)
  dreYtd: Record<string, number>; // DRE acumulada no ano até dtFim
  dfcYtd: { fco?: number; fci?: number; fcf?: number };
}
export interface CvmEmpresa {
  cnpj: string;
  denom: string;
  cdCvm: string;
  periodos: Record<string, CvmPeriodoDados>; // DT_FIM (AAAA-MM-DD) → dados
}

const normCnpj = (s: string) => s.replace(/[^\d]/g, "");

interface LinhaCvm {
  cnpj: string; denom: string; cdCvm: string;
  dtIni: string; dtFim: string; cd: string; ds: string; valor: number;
}

/**
 * Extrai as linhas de UM CSV do ZIP, filtrando CEDO pelo CD_CONTA (aceitaConta).
 * MEMÓRIA (o teto efetivo do container de produção é ~500MB): os CSVs da CVM têm
 * até 80-160MB DESCOMPRIMIDOS — materializar o texto inteiro (getData().toString())
 * matava o container (evidência do heartbeat: morte em "parse BPA con", heap 34MB,
 * rss 394MB). Aqui inflamos o DEFLATE em STREAMING: só o comprimido (1-4MB) fica em
 * memória e o texto passa em pedaços de ~64KB, linha a linha; só as ~5% de linhas
 * aprovadas viram objeto. O event loop respira entre chunks (o /health responde).
 */
async function extraiLinhas(zip: AdmZip, nomeArquivo: string, aceitaConta: (cd: string) => boolean): Promise<LinhaCvm[]> {
  const entry = zip.getEntry(nomeArquivo);
  if (!entry) return [];

  const out: LinhaCvm[] = [];
  let idx: Record<string, number> | null = null;
  let n = 0;

  const processaLinha = (linha: string): void => {
    if (!linha.trim()) return;
    if (!idx) { // 1ª linha = cabeçalho
      idx = {};
      linha.split(";").forEach((c, i) => { idx![c.trim()] = i; });
      return;
    }
    const partes = linha.split(";");
    const get = (col: string) => (partes[idx![col]] ?? "").trim();
    const cd = get("CD_CONTA");
    if (!cd || !aceitaConta(cd)) return; // filtro cedo — descarta ~95% das linhas
    const ordem = get("ORDEM_EXERC").toUpperCase();
    if (!ordem.includes("LTIMO") || ordem.includes("PEN")) return; // só ÚLTIMO
    const vl = parseFloat(get("VL_CONTA").replace(",", "."));
    if (!Number.isFinite(vl)) return;
    const escala = get("ESCALA_MOEDA").toUpperCase().includes("MIL") ? 1000 : 1;
    out.push({
      cnpj: normCnpj(get("CNPJ_CIA")),
      denom: get("DENOM_CIA"),
      cdCvm: get("CD_CVM"),
      dtIni: get("DT_INI_EXERC"),
      dtFim: get("DT_FIM_EXERC"),
      cd,
      ds: get("DS_CONTA"),
      valor: vl * escala,
    });
  };

  // latin1 = 1 byte/char — chunk nunca corta um caractere; só a linha, tratada via `resto`.
  let resto = "";
  const processaChunk = async (chunk: Buffer): Promise<void> => {
    const linhas = (resto + chunk.toString("latin1")).split("\n");
    resto = linhas.pop() ?? "";
    for (const linha of linhas) {
      if ((++n & 8191) === 0) await new Promise<void>((r) => setImmediate(r));
      processaLinha(linha);
    }
  };

  if (entry.header.method === 8) {
    // DEFLATE (padrão dos ZIPs da CVM): infla em streaming a partir do comprimido.
    const inflate = createInflateRaw();
    inflate.end(entry.getCompressedData());
    for await (const chunk of inflate) await processaChunk(chunk as Buffer);
  } else {
    // STORED (ou outro): sem streaming possível — processa o buffer em fatias.
    const dados = entry.getData();
    for (let p = 0; p < dados.length; p += 1 << 16) {
      await processaChunk(dados.subarray(p, Math.min(p + (1 << 16), dados.length)));
    }
  }
  if (resto) processaLinha(resto); // última linha sem \n final

  return out;
}

/** Contas que interessam por demonstrativo — o resto é descartado no parse. */
const ACEITA_CONTA: Record<string, (cd: string) => boolean> = {
  BPA: (cd) => !!CVM_BP_MAP[cd],
  BPP: (cd) => !!CVM_BP_MAP[cd],
  DRE: (cd) => !!CVM_DRE_MAP[cd],
  DFC_MI: (cd) => !!CVM_DFC_MAP[cd] || cd.startsWith("6.01"), // 6.01.* p/ D&A (por descrição)
};

/** DT_INI 01/01 do mesmo ano do DT_FIM = visão ACUMULADA (YTD). */
const ehYtd = (l: LinhaCvm) => l.dtIni.endsWith("-01-01") && l.dtIni.slice(0, 4) === l.dtFim.slice(0, 4);
/** 1º trimestre: acumulado E discreto são a mesma janela. */
const ehPrimeiroTri = (l: LinhaCvm) => ehYtd(l) && l.dtFim.slice(5, 7) === "03";

export interface ParseCvmOpts {
  incluirFinanceiras?: boolean;
  /** Heartbeat por demonstrativo (diagnóstico de morte abrupta em produção). */
  onFase?: (fase: string) => void | Promise<void>;
}

/** Lê um ZIP da CVM (ITR ou DFP) e monta empresa → períodos nas contas do modelo. */
export async function parseCvmZip(zipSource: string | Buffer, opts?: ParseCvmOpts): Promise<Map<string, CvmEmpresa>> {
  const zip = new AdmZip(zipSource as never);
  const nomes = zip.getEntries().map((e) => e.entryName);
  const ehDfp = nomes.some((n) => n.startsWith("dfp_"));
  const prefixo = ehDfp ? "dfp_cia_aberta" : "itr_cia_aberta";
  const ano = (nomes.find((n) => /_\d{4}\.csv$/.test(n))?.match(/(\d{4})\.csv$/) ?? [])[1] ?? "";

  const empresas = new Map<string, CvmEmpresa>();
  const garante = (l: LinhaCvm): CvmPeriodoDados => {
    let e = empresas.get(l.cnpj);
    if (!e) { e = { cnpj: l.cnpj, denom: l.denom, cdCvm: l.cdCvm, periodos: {} }; empresas.set(l.cnpj, e); }
    if (!e.periodos[l.dtFim]) e.periodos[l.dtFim] = { bp: {}, dreTri: {}, dreYtd: {}, dfcYtd: {} };
    return e.periodos[l.dtFim];
  };

  for (const dem of ["BPA", "BPP", "DRE", "DFC_MI"]) {
    await opts?.onFase?.(`${dem} con`);
    const con = await extraiLinhas(zip, `${prefixo}_${dem}_con_${ano}.csv`, ACEITA_CONTA[dem]);
    await opts?.onFase?.(`${dem} ind`);
    const ind = await extraiLinhas(zip, `${prefixo}_${dem}_ind_${ano}.csv`, ACEITA_CONTA[dem]);
    const temCon = new Set(con.map((l) => l.cnpj));
    const linhas = [...con, ...ind.filter((l) => !temCon.has(l.cnpj))];

    for (const l of linhas) {
      if (!opts?.incluirFinanceiras && CVM_EXCLUIR_DENOM.test(l.denom)) continue;
      const per = garante(l);
      if (dem === "BPA" || dem === "BPP") {
        const conta = CVM_BP_MAP[l.cd];
        if (conta) per.bp[conta] = l.valor;
      } else if (dem === "DRE") {
        const conta = CVM_DRE_MAP[l.cd];
        if (!conta) continue;
        // DFP: a DRE do ano entra nas DUAS visões (tri = ano no fechamento).
        if (ehDfp) { per.dreTri[conta] = l.valor; per.dreYtd[conta] = l.valor; continue; }
        if (ehYtd(l)) { per.dreYtd[conta] = l.valor; if (ehPrimeiroTri(l)) per.dreTri[conta] = l.valor; }
        else per.dreTri[conta] = l.valor; // DT_INI = início do tri → trimestre isolado
      } else if (dem === "DFC_MI") {
        if (!ehDfp && !ehYtd(l)) continue; // DFC: usamos a visão acumulada
        const fluxo = CVM_DFC_MAP[l.cd];
        if (fluxo) per.dfcYtd[fluxo] = l.valor;
        // D&A (p/ EBITDA): adição não-caixa sob 6.01.* — pela DESCRIÇÃO (CD varia).
        if (l.cd.startsWith("6.01") && /deprecia|amortiza/i.test(l.ds) && per.dreYtd["Depreciação e Amortização"] === undefined) {
          per.dreYtd["Depreciação e Amortização"] = -Math.abs(l.valor); // convenção do motor
          if (ehDfp) per.dreTri["Depreciação e Amortização"] = -Math.abs(l.valor);
        }
      }
    }
  }
  return empresas;
}

/** Download server-side direto da CVM (produção: roda no backend, ZIP descartável). */
export async function baixarCvmZip(url: string): Promise<{ buffer: Buffer; etag: string | null; lastModified: string | null }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CVM ${url}: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") };
}

/** Download em STREAMING para arquivo temporário — não segura o ZIP em RAM
 *  (container de produção tem 1GB; fetch+arrayBuffer duplicava o ZIP na memória). */
export async function baixarCvmZipParaDisco(url: string): Promise<{ caminho: string; tamanho: number; etag: string | null; lastModified: string | null }> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`CVM ${url}: HTTP ${res.status}`);
  const caminho = join(tmpdir(), `cvm-${Date.now()}-${url.split("/").pop()}`);
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(caminho));
  const { size } = await import("node:fs/promises").then((fs) => fs.stat(caminho));
  return { caminho, tamanho: size, etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") };
}

/** HEAD na CVM — o cron compara ETag/Last-Modified com o CvmSyncState para avisar. */
export async function checarCvmAtualizacao(url: string): Promise<{ etag: string | null; lastModified: string | null } | null> {
  const res = await fetch(url, { method: "HEAD" });
  if (!res.ok) return null;
  return { etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") };
}

/** Persiste o resultado do parse em CvmCompany/CvmPeriod (upsert idempotente). */
export async function persistirCvm(
  empresas: Map<string, CvmEmpresa>,
  origem: "ITR" | "DFP",
  opts?: { onProgresso?: (feitas: number, total: number) => void | Promise<void> },
): Promise<{ empresas: number; periodos: number }> {
  let nPeriodos = 0;
  let feitas = 0;
  for (const emp of empresas.values()) {
    feitas++;
    if (feitas % 100 === 0) await opts?.onProgresso?.(feitas, empresas.size);
    if (!emp.cnpj) continue;
    await prisma.cvmCompany.upsert({
      where: { cnpj: emp.cnpj },
      update: { denom: emp.denom, cdCvm: emp.cdCvm },
      create: { cnpj: emp.cnpj, denom: emp.denom, cdCvm: emp.cdCvm },
    });
    for (const [dtFim, dados] of Object.entries(emp.periodos)) {
      // Só persiste período com o mínimo utilizável (BP ou DRE com conteúdo).
      if (Object.keys(dados.bp).length < 4 && Object.keys(dados.dreYtd).length < 3) continue;
      const dt = new Date(`${dtFim}T00:00:00Z`);
      if (Number.isNaN(dt.getTime())) continue;
      await prisma.cvmPeriod.upsert({
        where: { cnpj_dtFim_origem: { cnpj: emp.cnpj, dtFim: dt, origem } },
        update: { bp: dados.bp, dreTri: dados.dreTri, dreYtd: dados.dreYtd, dfcYtd: dados.dfcYtd },
        create: { cnpj: emp.cnpj, dtFim: dt, origem, bp: dados.bp, dreTri: dados.dreTri, dreYtd: dados.dreYtd, dfcYtd: dados.dfcYtd },
      });
      nPeriodos++;
    }
  }
  return { empresas: empresas.size, periodos: nPeriodos };
}
