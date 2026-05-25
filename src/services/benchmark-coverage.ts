/**
 * Observability data pro pipeline #6 — agrega cobertura por (setor, source)
 * + último JobRun por jobName. Consumido por:
 *   - GET /admin/benchmarks/coverage (auth via ADMIN_TRIGGER_TOKEN, pra ops)
 *   - GET /sectors/coverage         (auth via JWT + partner role, pra UI)
 */

import { prisma } from "../db/client";
import { TRIGGERABLE_JOBS } from "../jobs";

export interface CoverageSectorRow {
  code: string;
  name: string;
  parentCode: string | null;
  sources: Array<{
    source: string;
    fetchedAt: Date;
    latestYear: number;
    metricCount: number;
    metrics: string[];
  }>;
}

export interface CoverageJobRow {
  jobName: string;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastStatus: string;
  lastMeta: unknown;
}

export interface CoverageReport {
  generatedAt: string;
  sectorCount: number;
  sectors: CoverageSectorRow[];
  jobs: CoverageJobRow[];
}

export async function getBenchmarkCoverage(): Promise<CoverageReport> {
  const sectors = await prisma.sector.findMany({
    where: { active: true },
    orderBy: [{ parentCode: { sort: "asc", nulls: "first" } }, { code: "asc" }],
  });

  const benchmarks = await prisma.sectorBenchmark.findMany({
    select: { sectorCode: true, source: true, metric: true, fetchedAt: true, year: true },
  });

  const coverageBySector = new Map<
    string,
    Map<string, { fetchedAt: Date; metrics: Set<string>; latestYear: number }>
  >();
  for (const b of benchmarks) {
    if (!coverageBySector.has(b.sectorCode)) coverageBySector.set(b.sectorCode, new Map());
    const sectorMap = coverageBySector.get(b.sectorCode)!;
    const existing = sectorMap.get(b.source);
    if (!existing) {
      sectorMap.set(b.source, {
        fetchedAt: b.fetchedAt,
        metrics: new Set([b.metric]),
        latestYear: b.year,
      });
    } else {
      existing.metrics.add(b.metric);
      if (b.fetchedAt > existing.fetchedAt) existing.fetchedAt = b.fetchedAt;
      if (b.year > existing.latestYear) existing.latestYear = b.year;
    }
  }

  const recentRuns = await prisma.jobRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 200,
  });
  const lastRunByJob = new Map<string, typeof recentRuns[number]>();
  for (const run of recentRuns) {
    if (!lastRunByJob.has(run.jobName)) lastRunByJob.set(run.jobName, run);
  }

  const sectorRows: CoverageSectorRow[] = sectors.map((s) => {
    const sources = coverageBySector.get(s.code);
    return {
      code: s.code,
      name: s.name,
      parentCode: s.parentCode,
      sources: sources
        ? Array.from(sources.entries()).map(([source, info]) => ({
            source,
            fetchedAt: info.fetchedAt,
            latestYear: info.latestYear,
            metricCount: info.metrics.size,
            metrics: Array.from(info.metrics).sort(),
          }))
        : [],
    };
  });

  const jobRows: CoverageJobRow[] = Object.keys(TRIGGERABLE_JOBS).map((jobName) => {
    const last = lastRunByJob.get(jobName);
    return {
      jobName,
      lastStartedAt: last?.startedAt ?? null,
      lastFinishedAt: last?.finishedAt ?? null,
      lastStatus: last?.status ?? "never_run",
      lastMeta: last?.meta ?? null,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    sectorCount: sectors.length,
    sectors: sectorRows,
    jobs: jobRows,
  };
}
