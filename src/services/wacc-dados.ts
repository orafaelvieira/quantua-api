/**
 * DADOS DE MERCADO do WACC — replica a MATEMÁTICA da planilha padrão
 * (Base_Dados_WACC) com fontes automatizáveis e gratuitas:
 *
 *  - Rf: MEDIANA dos últimos 60 meses do T-Bond 10Y (fechamentos diários).
 *    Planilha usa investing.com; aqui a série OFICIAL do Treasury via FRED
 *    (DGS10) — mesma série, mesmo número.
 *  - Risco-país: a planilha usa o CDS 10Y Brasil (investing.com — sem API
 *    gratuita). Automatizamos com o EMBI+ Risco-Brasil (JPMorgan, via IPEA)
 *    como PROXY declarado, mediana 60 meses em bps ÷ 10.000 — o campo fica
 *    editável na tela para quem preferir colar o CDS.
 *  - Diferencial de volatilidade: σ(log-retornos diários) × √n do Ibovespa ÷
 *    idem do S&P 500, na mesma janela de 60 meses (fórmula EXATA da planilha).
 *    Ibovespa: série oficial diária do BCB (SGS 7); S&P 500: FRED (SP500).
 *  - Inflação EUA (sugestão): breakeven de 10 anos (FRED T10YIE) — a planilha
 *    usa projeção do Santander; campo editável.
 *  - Selic Meta (referência informativa): SGS 432 (BCB).
 *
 * Cache de 24h. Cada número sai com fonte + janela (regra data+fonte).
 */
import { RISCO_PAIS_BRASIL } from "./wacc-referencias";

export interface WaccDadosMercado {
  atualizadoEm: string;
  /** Tamanho da amostra em meses (12/24/36/48/60 — planilha padrão usa 60). */
  janelaMeses: number;
  janela: { de: string; ate: string };
  rf: { valor: number; fonte: string; observacoes: number };
  riscoPais: { valor: number; fonte: string; observacoes: number };
  difVol: { valor: number; volIbov: number; volSpx: number; fonte: string; obsIbov: number; obsSpx: number };
  inflacaoUsSugerida: { valor: number; fonte: string } | null;
  selicMeta: { valor: number; fonte: string } | null;
  memoria: string[];
  /** Só com detalhe=1: as observações diárias usadas (a "aba de dados" da
   *  planilha, para conferência na tela) — NÃO é persistido no modelo. */
  series?: {
    tbond: Array<{ data: string; valor: number }>;
    riscoPais: Array<{ data: string; valor: number }>;
    ibovespa: Array<{ data: string; valor: number }>;
    sp500: Array<{ data: string; valor: number }>;
  };
}

let cache: { chave: string; em: number; dados: WaccDadosMercado } | null = null;
const CACHE_MS = 24 * 3600 * 1000;

async function fetchTexto(url: string): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (Quantua)" } });
    if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function mediana(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function stdevAmostral(v: number[]): number {
  const n = v.length;
  if (n < 2) return 0;
  const m = v.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1));
}

/** CSV do FRED (fredgraph): colunas DATE,VALOR; "." = sem dado. */
async function serieFred(id: string): Promise<Array<{ data: string; valor: number }>> {
  const csv = await fetchTexto(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`);
  const out: Array<{ data: string; valor: number }> = [];
  for (const linha of csv.split("\n").slice(1)) {
    const [data, bruto] = linha.trim().split(",");
    const v = Number(bruto);
    if (data && Number.isFinite(v)) out.push({ data, valor: v });
  }
  return out;
}

/** Ibovespa diário — Yahoo Finance (^BVSP). A série 7 do SGS/BCB foi
 *  descontinuada; Yahoo é a fonte pública estável para o índice diário.
 *  O range acompanha a janela pedida (5y para até 60m; 10y acima). */
async function serieIbovespa(range: "5y" | "10y"): Promise<Array<{ data: string; fechamento: number }>> {
  const json = await fetchTexto(`https://query1.finance.yahoo.com/v8/finance/chart/%5EBVSP?range=${range}&interval=1d`);
  const obj = JSON.parse(json) as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> } };
  const res = obj.chart?.result?.[0];
  const ts = res?.timestamp ?? [];
  const closes = res?.indicators?.quote?.[0]?.close ?? [];
  const out: Array<{ data: string; fechamento: number }> = [];
  for (let i = 0; i < ts.length; i++) {
    const v = closes[i];
    if (typeof v === "number" && v > 0) out.push({ data: new Date(ts[i] * 1000).toISOString().slice(0, 10), fechamento: v });
  }
  return out;
}

/** EMBI+ Risco-Brasil (JPMorgan) diário, via API do IPEA (bps). */
async function serieEmbi(): Promise<Array<{ data: string; valor: number }>> {
  const json = await fetchTexto("http://www.ipeadata.gov.br/api/odata4/ValoresSerie(SERCODIGO='JPM366_EMBI366')?$format=json");
  const obj = JSON.parse(json) as { value?: Array<{ VALDATA?: string; VALVALOR?: number }> };
  return (obj.value ?? [])
    .filter((r) => typeof r.VALVALOR === "number" && r.VALDATA)
    .map((r) => ({ data: String(r.VALDATA).slice(0, 10), valor: r.VALVALOR as number }));
}

/** Último valor da Selic Meta (SGS 432). */
async function selicMetaAtual(): Promise<number | null> {
  try {
    const json = await fetchTexto("https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados/ultimos/1?formato=json");
    const arr = JSON.parse(json) as Array<{ valor?: string }>;
    const v = Number(String(arr[0]?.valor ?? "").replace(",", "."));
    return Number.isFinite(v) ? v / 100 : null;
  } catch {
    return null;
  }
}

/** Log-retornos diários dentro da janela [de, ate] (mesma "Var. Intervalo" da planilha). */
function logRetornosNaJanela(serie: Array<{ data: string; fechamento: number }>, de: string, ate: string): number[] {
  const dentro = serie.filter((p) => p.data >= de && p.data <= ate && p.fechamento > 0).sort((a, b) => (a.data < b.data ? -1 : 1));
  const rets: number[] = [];
  for (let i = 1; i < dentro.length; i++) rets.push(Math.log(dentro[i].fechamento / dentro[i - 1].fechamento));
  return rets;
}

export async function buscarDadosWacc(janelaMeses = 60, forcar = false, detalhe = false): Promise<WaccDadosMercado> {
  const jm = [12, 24, 36, 48, 60, 84, 120].includes(janelaMeses) ? janelaMeses : 60;
  const chave = `${jm}:${detalhe ? 1 : 0}`;
  if (!forcar && cache && cache.chave === chave && Date.now() - cache.em < CACHE_MS) return cache.dados;
  const memoria: string[] = [];

  const dgs10 = await serieFred("DGS10");
  if (!dgs10.length) throw new Error("Série do T-Bond 10Y (FRED DGS10) veio vazia");

  // Janela de N MESES fechados terminando no último dado do T-Bond (a régua da planilha).
  const ate = dgs10[dgs10.length - 1].data;
  const ateD = new Date(`${ate}T00:00:00Z`);
  const deD = new Date(Date.UTC(ateD.getUTCFullYear(), ateD.getUTCMonth() - jm, 1));
  const de = deD.toISOString().slice(0, 10);

  const [ibov, spxFred, embi, t10yie, selic] = await Promise.all([
    serieIbovespa(jm <= 60 ? "5y" : "10y"),
    serieFred("SP500"),
    serieEmbi().catch((e) => { memoria.push(`EMBI indisponível (${e instanceof Error ? e.message : e}) — informe o risco-país manualmente`); return [] as Array<{ data: string; valor: number }>; }),
    serieFred("T10YIE").catch(() => [] as Array<{ data: string; valor: number }>),
    selicMetaAtual(),
  ]);
  const spx = spxFred.map((p) => ({ data: p.data, fechamento: p.valor }));

  const tbondJanela = dgs10.filter((p) => p.data >= de && p.data <= ate);
  const rfJanela = tbondJanela.map((p) => p.valor);
  const rf = mediana(rfJanela) / 100;

  // O JPMorgan DESCONTINUOU o EMBI+ (última observação ~2024): janela sem
  // observações cai no FALLBACK ANUAL — spread de default do Brasil por rating
  // (Damodaran, mesma aba da planilha padrão). O CDS 10Y do dia continua sendo
  // colável manualmente (br.investing.com).
  const embiJanelaObs = embi.filter((p) => p.data >= de && p.data <= ate);
  const embiJanela = embiJanelaObs.map((p) => p.valor);
  const ultimaEmbi = embi.length ? embi[embi.length - 1].data : null;
  let riscoPais: WaccDadosMercado["rf"];
  if (embiJanela.length) {
    riscoPais = {
      valor: mediana(embiJanela) / 10_000,
      fonte: `Mediana da janela de ${jm} meses do EMBI+ Risco-Brasil — IPEA (ipeadata.gov.br) — proxy do CDS 10Y`,
      observacoes: embiJanela.length,
    };
    if (ultimaEmbi && ultimaEmbi < ate.slice(0, 8) + "01") {
      memoria.push(`Risco-país: EMBI+ com última observação em ${ultimaEmbi} (série descontinuada) — a mediana usa só o trecho disponível; se tiver o CDS 10Y do dia (br.investing.com), cole no campo`);
    }
  } else {
    riscoPais = {
      valor: RISCO_PAIS_BRASIL.defaultSpread,
      fonte: `Spread de default do Brasil por rating ${RISCO_PAIS_BRASIL.rating} (Damodaran, ${RISCO_PAIS_BRASIL.data}) — fallback anual: EMBI+ descontinuado${ultimaEmbi ? ` em ${ultimaEmbi}` : ""}; se tiver o CDS 10Y do dia (br.investing.com), cole no campo`,
      observacoes: 0,
    };
    memoria.push(`Risco-país: sem série de mercado na janela (EMBI+ descontinuado) — usando o spread por rating do Brasil (Damodaran, ${RISCO_PAIS_BRASIL.rating}): ${(RISCO_PAIS_BRASIL.defaultSpread * 100).toFixed(2)}%`);
  }

  // Diferencial de volatilidade — fórmula EXATA da planilha: σ amostral dos
  // log-retornos diários × √(nº de observações na janela), razão Ibov ÷ S&P.
  const retsIbov = logRetornosNaJanela(ibov, de, ate);
  const retsSpx = logRetornosNaJanela(spx, de, ate);
  if (retsIbov.length < 100 || retsSpx.length < 100) throw new Error("Séries do Ibovespa/S&P 500 (stooq) vieram curtas");
  const volIbov = stdevAmostral(retsIbov) * Math.sqrt(retsIbov.length);
  const volSpx = stdevAmostral(retsSpx) * Math.sqrt(retsSpx.length);
  const difVol = volSpx > 0 ? volIbov / volSpx : 1;

  const inflUs = t10yie.length ? t10yie[t10yie.length - 1].valor / 100 : null;

  memoria.push(`Janela de ${jm} meses: ${de} a ${ate}`);
  const dados: WaccDadosMercado = {
    atualizadoEm: new Date().toISOString(),
    janelaMeses: jm,
    janela: { de, ate },
    rf: { valor: rf, fonte: `Mediana da janela de ${jm} meses do T-Bond 10Y — Federal Reserve/FRED (fred.stlouisfed.org/series/DGS10)`, observacoes: rfJanela.length },
    riscoPais,
    difVol: { valor: difVol, volIbov, volSpx, obsIbov: retsIbov.length, obsSpx: retsSpx.length, fonte: `σ×√n dos log-retornos diários na janela de ${jm} meses — Ibovespa: finance.yahoo.com (^BVSP) · S&P 500: fred.stlouisfed.org/series/SP500` },
    inflacaoUsSugerida: inflUs !== null ? { valor: inflUs, fonte: "Breakeven de inflação 10 anos EUA (FRED T10YIE) — sugestão; planilha usa projeção Santander" } : null,
    selicMeta: selic !== null ? { valor: selic, fonte: "Meta Selic (Copom) — BCB/SGS 432" } : null,
    memoria,
    ...(detalhe
      ? {
          series: {
            tbond: tbondJanela,
            riscoPais: embiJanelaObs,
            ibovespa: ibov.filter((p) => p.data >= de && p.data <= ate).map((p) => ({ data: p.data, valor: p.fechamento })),
            sp500: spx.filter((p) => p.data >= de && p.data <= ate).map((p) => ({ data: p.data, valor: p.fechamento })),
          },
        }
      : {}),
  };
  cache = { chave, em: Date.now(), dados };
  return dados;
}
