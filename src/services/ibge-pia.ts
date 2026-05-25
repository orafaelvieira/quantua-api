/**
 * IBGE PIA (Pesquisa Industrial Anual) ingestion via SIDRA API.
 *
 * Tabela 1849 — variáveis financeiras por CNAE 2-dig. URL pattern:
 *   `https://apisidra.ibge.gov.br/values/t/1849/n1/all/v/{var}/p/last`
 *
 * PIA tem defasagem de ~18 meses (PIA 2024 publica em mid-2026). Cron anual
 * roda 15 jun pra pegar valores frescos. Fallback: mantém ano anterior.
 *
 * Retry com exponential backoff (3x), timeout 120s — SIDRA é notoriamente flaky.
 */

import { z } from "zod";

const DEFAULT_BASE = "https://apisidra.ibge.gov.br/values";

/**
 * SIDRA retorna array de objetos onde primeira linha é header (metadata) e
 * demais são dados. Schema valida shape mínima.
 */
const SidraRowSchema = z.record(z.union([z.string(), z.number(), z.null()]));
const SidraResponseSchema = z.array(SidraRowSchema).min(2);

export interface PiaVariableConfig {
  /** Variável da Tabela 1849 do SIDRA. */
  variableCode: string;
  /** Nome interno da métrica em `SectorBenchmark`. */
  metric: string;
  /** Unidade: "decimal", "dias", "reais". */
  unit: string;
  /**
   * Transformação opcional aplicada ao valor cru do SIDRA antes de gravar.
   * Ex.: SIDRA retorna "Receita Líquida" em R$ 1000; podemos manter ou normalizar.
   */
  transform?: (value: number) => number;
}

/**
 * Variáveis IBGE PIA mapeadas pras métricas Quantua.
 *
 * Como PIA é estatística econômica anual (não tem DSO/giro direto), derivamos
 * indicadores via combinação de variáveis. Pra MVP, focamos em margem bruta
 * que pode ser calculada de Receita + CMV.
 */
export const PIA_VARIABLES: PiaVariableConfig[] = [
  // SIDRA Tabela 1849, variável 4 — "Receita líquida de vendas e/ou serviços (R$ mil)"
  { variableCode: "4", metric: "receita_liquida_anual", unit: "reais_mil" },
  // SIDRA Tabela 1849, variável 13 — "Custos diretos da produção (R$ mil)"
  // Margem bruta derivada: 1 - (custos / receita).
  { variableCode: "13", metric: "custos_diretos_anual", unit: "reais_mil" },
];

/**
 * Fetch com retry exponential backoff (3 tentativas) + timeout 120s.
 */
async function fetchWithRetry(url: string, attempts = 3): Promise<unknown> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

export interface PiaParsedRow {
  cnae: string;
  variable: string;
  value: number;
}

/**
 * Fetch + parse de uma variável PIA do SIDRA. Retorna rows estruturadas.
 *
 * SIDRA response shape (após `values/t/1849/n1/all/v/{var}/p/last`):
 *   [
 *     { "NC": "Nível Territorial (Código)", ... metadata },
 *     { "NC": "1", "Variável": "Receita Líquida...", "D2C": "10", "V": "350000" },
 *     ...
 *   ]
 *
 * Primeira linha é dicionário, descartada. Coluna "D2C" geralmente carrega
 * o código CNAE de classificação (segunda dimensão). "V" é o valor (string).
 */
export async function fetchPiaVariable(
  config: PiaVariableConfig,
  options: { baseUrl?: string } = {},
): Promise<PiaParsedRow[]> {
  const baseUrl = options.baseUrl ?? process.env.SIDRA_API_BASE ?? DEFAULT_BASE;
  const url = `${baseUrl}/t/1849/n1/all/v/${config.variableCode}/p/last`;

  const raw = await fetchWithRetry(url);
  const parsed = SidraResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`PIA variable ${config.variableCode}: shape inválida (${parsed.error.message})`);
  }

  const rows: PiaParsedRow[] = [];
  // Pula primeira linha (dicionário de headers SIDRA).
  for (let i = 1; i < parsed.data.length; i++) {
    const row = parsed.data[i];
    const cnae = pickString(row, ["D2C", "Classificação Nacional de Atividades Econômicas (Versão 2.0)"]);
    const valueRaw = row["V"];
    if (!cnae || valueRaw === null || valueRaw === undefined) continue;
    const value = typeof valueRaw === "number" ? valueRaw : Number(String(valueRaw).replace(/[.,]/g, ""));
    if (!Number.isFinite(value)) continue;
    const transformed = config.transform ? config.transform(value) : value;
    rows.push({ cnae: String(cnae).trim(), variable: config.variableCode, value: transformed });
  }

  return rows;
}

function pickString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

/**
 * Combina receita_liquida_anual + custos_diretos_anual em margem_bruta por CNAE.
 * Retorna por CNAE: { metric: "margem_bruta", value: 0.27 } quando ambas presentes.
 */
export function deriveMargemBruta(
  receitaRows: PiaParsedRow[],
  custosRows: PiaParsedRow[],
): Array<{ cnae: string; metric: string; value: number; unit: string }> {
  const receitaByCnae = new Map(receitaRows.map((r) => [r.cnae, r.value]));
  const custosByCnae = new Map(custosRows.map((r) => [r.cnae, r.value]));

  const out: Array<{ cnae: string; metric: string; value: number; unit: string }> = [];
  for (const [cnae, receita] of receitaByCnae.entries()) {
    const custos = custosByCnae.get(cnae);
    if (!custos || receita <= 0) continue;
    const margemBruta = 1 - custos / receita;
    if (!Number.isFinite(margemBruta) || margemBruta < 0 || margemBruta > 1) continue;
    out.push({ cnae, metric: "margem_bruta", value: margemBruta, unit: "decimal" });
  }
  return out;
}

/**
 * Upsert idempotente de rows agregadas por setor (via CnaeMapping) em SectorBenchmark.
 */
export async function applyPiaRows(input: {
  rows: Array<{ cnae: string; metric: string; value: number; unit: string }>;
  year: number;
  rawSourceUrl: string;
  prismaClient: typeof import("../db/client").prisma;
}): Promise<{ upserted: number; mapped: number; unmapped: string[] }> {
  const cnaes = await input.prismaClient.cnaeMapping.findMany();
  const sectorByCnae = new Map(cnaes.map((c) => [c.cnae, c.sectorCode]));
  const now = new Date();

  // Agrega por (sector, metric): média de CNAEs mapeados pro mesmo setor.
  const aggregated = new Map<string, Map<string, { sum: number; count: number; unit: string }>>();
  const unmapped: string[] = [];

  for (const row of input.rows) {
    const sectorCode = sectorByCnae.get(row.cnae);
    if (!sectorCode) {
      unmapped.push(row.cnae);
      continue;
    }
    if (!aggregated.has(sectorCode)) aggregated.set(sectorCode, new Map());
    const sectorMetrics = aggregated.get(sectorCode)!;
    const prev = sectorMetrics.get(row.metric);
    if (prev) {
      prev.sum += row.value;
      prev.count += 1;
    } else {
      sectorMetrics.set(row.metric, { sum: row.value, count: 1, unit: row.unit });
    }
  }

  let upserted = 0;
  let mapped = 0;
  for (const [sectorCode, metrics] of aggregated.entries()) {
    mapped++;
    for (const [metric, agg] of metrics.entries()) {
      const value = agg.sum / agg.count;
      await input.prismaClient.sectorBenchmark.upsert({
        where: {
          sectorCode_year_source_metric_percentile: {
            sectorCode,
            year: input.year,
            source: "ibge_pia",
            metric,
            percentile: 50,
          },
        },
        create: {
          sectorCode,
          year: input.year,
          source: "ibge_pia",
          metric,
          value,
          percentile: 50,
          unit: agg.unit,
          fetchedAt: now,
          rawSourceUrl: input.rawSourceUrl,
          notes: `IBGE PIA — média de ${agg.count} CNAE${agg.count > 1 ? "s" : ""} mapeado${agg.count > 1 ? "s" : ""}`,
        },
        update: {
          value,
          fetchedAt: now,
          rawSourceUrl: input.rawSourceUrl,
        },
      });
      upserted++;
    }
  }

  return { upserted, mapped, unmapped };
}
