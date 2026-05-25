/**
 * Banco Central — Sistema Gerenciador de Séries Temporais (SGS) ingestion.
 *
 * API REST simples: `https://api.bcb.gov.br/dados/serie/bcdata.sgs.{cod}/dados/ultimos/4?formato=json`.
 * Retorna array de pontos `{ data: "DD/MM/YYYY", valor: "12.34" }`.
 *
 * Séries usadas (CNAE-agnósticas — aplicam ao mercado BR como um todo):
 *   - 4189: Taxa CDI anualizada
 *   - 432: Meta SELIC
 *   - 20714: Spread médio das operações de crédito PJ
 *
 * Trimestral (`0 3 1 1,4,7,10 *` America/Sao_Paulo). Tem timeout/retry — BCB
 * API é bem estável mas safety net não machuca.
 */

import { z } from "zod";

const DEFAULT_BASE = "https://api.bcb.gov.br/dados/serie";

const SgsDataPointSchema = z.object({
  data: z.string(),  // "DD/MM/YYYY"
  valor: z.union([z.string(), z.number()]),
});
const SgsResponseSchema = z.array(SgsDataPointSchema).min(1);

export interface SgsSeriesConfig {
  /** Código numérico da série no SGS. */
  seriesCode: number;
  /** Nome da métrica em `SectorBenchmark`. */
  metric: string;
  /** Unidade ("decimal" pra taxas anuais já normalizadas). */
  unit: string;
  /**
   * BCB às vezes retorna em pontos percentuais (12.5 = 12.5%). Set true
   * pra dividir por 100 antes de gravar.
   */
  normalizePct?: boolean;
}

/**
 * Séries SGS consumidas no MVP.
 */
export const SGS_SERIES: SgsSeriesConfig[] = [
  { seriesCode: 4189, metric: "cdi_anual", unit: "decimal", normalizePct: true },
  { seriesCode: 432, metric: "selic_anual", unit: "decimal", normalizePct: true },
  { seriesCode: 20714, metric: "spread_pj_medio_anual", unit: "decimal", normalizePct: true },
];

async function fetchWithRetry(url: string, attempts = 3): Promise<unknown> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        const delay = Math.pow(2, i) * 1000;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

/**
 * Fetch da última observação de uma série SGS. Retorna o valor mais recente
 * dos últimos 4 datapoints (média ou último — usamos o último por simplicidade).
 */
export async function fetchSgsLatestValue(
  config: SgsSeriesConfig,
  options: { baseUrl?: string } = {},
): Promise<{ value: number; date: string }> {
  const baseUrl = options.baseUrl ?? process.env.BCB_SGS_BASE ?? DEFAULT_BASE;
  const url = `${baseUrl}/bcdata.sgs.${config.seriesCode}/dados/ultimos/4?formato=json`;

  const raw = await fetchWithRetry(url);
  const parsed = SgsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`SGS série ${config.seriesCode}: shape inválida (${parsed.error.message})`);
  }

  const last = parsed.data[parsed.data.length - 1];
  const rawValue = typeof last.valor === "number" ? last.valor : Number(String(last.valor).replace(",", "."));
  if (!Number.isFinite(rawValue)) {
    throw new Error(`SGS série ${config.seriesCode}: valor não numérico (${last.valor})`);
  }

  const value = config.normalizePct ? rawValue / 100 : rawValue;
  return { value, date: last.data };
}

/**
 * Upsert idempotente das métricas SGS. Macros raw vão pra sector="default";
 * o `custo_medio_divida` derivado (cdi + spread) vai pra TODOS os setores
 * pra sobrescrever a baseline manual_curation.
 */
export async function applySgsValues(input: {
  values: Map<string, number>;
  year: number;
  prismaClient: typeof import("../db/client").prisma;
}): Promise<{ upserted: number }> {
  const now = new Date();
  const rawSourceUrl = "https://api.bcb.gov.br/dados/serie";
  let upserted = 0;

  for (const config of SGS_SERIES) {
    const value = input.values.get(config.metric);
    if (value === undefined) continue;
    await input.prismaClient.sectorBenchmark.upsert({
      where: {
        sectorCode_year_source_metric_percentile: {
          sectorCode: "default",
          year: input.year,
          source: "bcb_sgs",
          metric: config.metric,
          percentile: -1,
        },
      },
      create: {
        sectorCode: "default",
        year: input.year,
        source: "bcb_sgs",
        metric: config.metric,
        value,
        percentile: -1,
        unit: config.unit,
        fetchedAt: now,
        rawSourceUrl: `${rawSourceUrl}/bcdata.sgs.${config.seriesCode}`,
        notes: `SGS série ${config.seriesCode}`,
      },
      update: { value, fetchedAt: now },
    });
    upserted++;
  }

  // Derivar custo_medio_divida = cdi + spread (se ambos vieram)
  const cdi = input.values.get("cdi_anual");
  const spread = input.values.get("spread_pj_medio_anual");
  if (cdi !== undefined && spread !== undefined) {
    const custo = cdi + spread;
    const allSectors = await input.prismaClient.sector.findMany({ where: { active: true } });
    for (const sector of allSectors) {
      await input.prismaClient.sectorBenchmark.upsert({
        where: {
          sectorCode_year_source_metric_percentile: {
            sectorCode: sector.code,
            year: input.year,
            source: "bcb_sgs",
            metric: "custo_medio_divida",
            percentile: -1,
          },
        },
        create: {
          sectorCode: sector.code,
          year: input.year,
          source: "bcb_sgs",
          metric: "custo_medio_divida",
          value: custo,
          percentile: -1,
          unit: "decimal",
          fetchedAt: now,
          rawSourceUrl,
          notes: `Derivado: cdi_anual (${cdi.toFixed(4)}) + spread_pj_medio_anual (${spread.toFixed(4)})`,
        },
        update: { value: custo, fetchedAt: now },
      });
      upserted++;
    }
  }

  return { upserted };
}
