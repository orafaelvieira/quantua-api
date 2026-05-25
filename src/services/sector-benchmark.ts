/**
 * sector-benchmark — leitura DB do catálogo de setores Quantua (#6 Fase 1).
 *
 * Convive com sector-premises.ts (legado, hardcoded). Em Fase 2, projection-engine
 * passa a usar este service via `getSectorBenchmark(sectorCode)`. Por ora, é leitura-
 * só usada pelas routes em /api/sectors.
 *
 * Modelo de dados: SectorBenchmark é EAV — uma linha por (setor, ano, source, métrica).
 * `getSectorBenchmark` faz pivot disso pro struct flat compatível com SectorPremises.
 *
 * Cache: in-memory Map com TTL de 1h. Reset no boot da instância. Suficiente até
 * multi-instance (futuro); aí migrar pra Redis ou stateless.
 */

import { prisma } from "../db/client";
import { getSectorPremises, SectorPremises } from "./sector-premises";

export interface SectorBenchmarkResult {
  sectorCode: string;
  year: number;
  source: string;
  metrics: {
    receitaGrowth: number | null;
    margemBruta: number | null;
    dsoTarget: number | null;
    capexPctReceita: number | null;
    custoMedioDivida: number | null;
  };
  fetchedAt: Date | null;
}

export interface SectorSummary {
  code: string;
  name: string;
  parentCode: string | null;
  active: boolean;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const cache = new Map<string, { value: SectorBenchmarkResult; expiresAt: number }>();

// Métrica EAV → campo no struct flat. Espelha METRIC_MAP do seed-sectors.ts.
const METRIC_KEYS: Record<string, keyof SectorBenchmarkResult["metrics"]> = {
  receita_growth: "receitaGrowth",
  margem_bruta: "margemBruta",
  dso_target: "dsoTarget",
  capex_pct_receita: "capexPctReceita",
  custo_medio_divida: "custoMedioDivida",
};

function cacheKey(sectorCode: string, year: number): string {
  return `${sectorCode}::${year}`;
}

/**
 * Lê o catálogo de setores. Sem cache — listagem é leve.
 */
export async function listSectors(): Promise<SectorSummary[]> {
  const sectors = await prisma.sector.findMany({
    where: { active: true },
    orderBy: [{ parentCode: { sort: "asc", nulls: "first" } }, { code: "asc" }],
  });
  return sectors.map((s) => ({
    code: s.code,
    name: s.name,
    parentCode: s.parentCode,
    active: s.active,
  }));
}

/**
 * Retorna benchmark de um setor para um ano (default: ano mais recente disponível).
 *
 * Estratégia de fontes:
 *   1. Se múltiplas sources cobrem a mesma métrica no ano, prioriza:
 *      damodaran > ibge_pia > bcb_sgs > manual_curation (mais "objetivo" primeiro).
 *      (Por ora só "manual_curation" existe; ordem fica reservada pras fases 3/4.)
 *   2. Se métrica não tem nenhuma linha no ano, fallback pra DEFAULT sector.
 *   3. Se "default" também não tem, retorna `null` no campo correspondente.
 */
export async function getSectorBenchmark(
  sectorCode: string,
  year?: number,
): Promise<SectorBenchmarkResult | null> {
  // Resolver ano: se não passado, pega o mais recente disponível pra esse setor.
  const targetYear = year ?? (await resolveLatestYear(sectorCode));
  if (!targetYear) return null;

  const cacheK = cacheKey(sectorCode, targetYear);
  const hit = cache.get(cacheK);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value;
  }

  const rows = await prisma.sectorBenchmark.findMany({
    where: { sectorCode, year: targetYear },
    orderBy: [{ source: "asc" }, { fetchedAt: "desc" }],
  });

  // Pivot EAV → flat. Source de maior prioridade que tem a métrica vence.
  // Por ora todas as linhas são manual_curation, ordem só estabiliza o resultado.
  const metrics: SectorBenchmarkResult["metrics"] = {
    receitaGrowth: null,
    margemBruta: null,
    dsoTarget: null,
    capexPctReceita: null,
    custoMedioDivida: null,
  };
  const sourcesUsed = new Set<string>();
  let latestFetchedAt: Date | null = null;

  for (const row of rows) {
    const key = METRIC_KEYS[row.metric];
    if (!key) continue;
    if (metrics[key] === null) {
      metrics[key] = row.value;
      sourcesUsed.add(row.source);
      if (!latestFetchedAt || row.fetchedAt > latestFetchedAt) {
        latestFetchedAt = row.fetchedAt;
      }
    }
  }

  // Fallback default pra métricas que não vieram do setor pedido.
  const missing = (Object.keys(metrics) as Array<keyof typeof metrics>).filter((k) => metrics[k] === null);
  if (missing.length > 0 && sectorCode !== "default") {
    const defaultRows = await prisma.sectorBenchmark.findMany({
      where: { sectorCode: "default", year: targetYear },
    });
    for (const row of defaultRows) {
      const key = METRIC_KEYS[row.metric];
      if (key && metrics[key] === null) {
        metrics[key] = row.value;
      }
    }
  }

  const result: SectorBenchmarkResult = {
    sectorCode,
    year: targetYear,
    source: sourcesUsed.size === 1 ? Array.from(sourcesUsed)[0] : Array.from(sourcesUsed).sort().join("+"),
    metrics,
    fetchedAt: latestFetchedAt,
  };

  cache.set(cacheK, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

async function resolveLatestYear(sectorCode: string): Promise<number | null> {
  const latest = await prisma.sectorBenchmark.findFirst({
    where: { sectorCode },
    orderBy: { year: "desc" },
    select: { year: true },
  });
  if (latest) return latest.year;
  // Fallback: ano mais recente do default.
  const fallback = await prisma.sectorBenchmark.findFirst({
    where: { sectorCode: "default" },
    orderBy: { year: "desc" },
    select: { year: true },
  });
  return fallback?.year ?? null;
}

/**
 * Limpa cache. Útil em testes e após seeds manuais via endpoint admin.
 */
export function clearSectorBenchmarkCache(): void {
  cache.clear();
}

/**
 * Resolve as premissas setoriais usadas pelo projection-engine.
 *
 * Estratégia (em ordem de prioridade):
 *   1. Se `sectorCode` está setado, lê benchmark do DB. Se todos os 5 campos
 *      vierem populados, retorna direto.
 *   2. Caso contrário, cai pro path legado: substring match em
 *      sector-premises.ts via `setorText`. Loga warning pra observabilidade —
 *      a ideia é remover esse fallback quando warnings ficarem zerados.
 *   3. Última opção: DEFAULT_PREMISES de sector-premises.ts.
 */
export async function resolveSectorPremises(input: {
  sectorCode: string | null | undefined;
  setorText: string | null | undefined;
}): Promise<SectorPremises> {
  if (input.sectorCode) {
    const result = await getSectorBenchmark(input.sectorCode);
    if (result && allMetricsPresent(result.metrics)) {
      return {
        receitaGrowth: result.metrics.receitaGrowth!,
        margemBruta: result.metrics.margemBruta!,
        dsoTarget: result.metrics.dsoTarget!,
        capexPctReceita: result.metrics.capexPctReceita!,
        custoMedioDivida: result.metrics.custoMedioDivida!,
      };
    }
    console.warn(
      `[sector-benchmark] DB lookup incomplete for sectorCode="${input.sectorCode}"; falling back to legacy sector-premises`,
    );
  }
  if (input.setorText) {
    console.warn(
      `[sector-benchmark] fallbackFromText dispatched for setor="${input.setorText}" (no sectorCode set)`,
    );
  }
  return getSectorPremises(input.setorText ?? null);
}

function allMetricsPresent(m: SectorBenchmarkResult["metrics"]): boolean {
  return (
    m.receitaGrowth !== null &&
    m.margemBruta !== null &&
    m.dsoTarget !== null &&
    m.capexPctReceita !== null &&
    m.custoMedioDivida !== null
  );
}
