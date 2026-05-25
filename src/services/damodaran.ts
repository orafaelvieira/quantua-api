/**
 * Damodaran ingestion — fetcher + parser de XLSs públicos do prof. Aswath
 * Damodaran (NYU Stern). Usado por `src/jobs/fetch-damodaran-benchmarks.ts`.
 *
 * URLs default apontam pra Global dataset (`pages.stern.nyu.edu/~adamodar/...`),
 * que é atualizado anualmente em janeiro. Em testes ou pra fixtures locais,
 * override via env `DAMODARAN_DATA_BASE`.
 *
 * Estratégia defensiva:
 *   - Validar shape de cada linha via Zod — falha em UMA linha não derruba batch
 *   - Layout pode mudar; Zod valida NOMES de coluna, não posições
 *   - Snapshot do XLS bruto vai pra DO Spaces (em `fetch-damodaran-benchmarks`)
 *     pra debug se parsing quebrar
 */

import * as XLSX from "xlsx";
import { z } from "zod";

const DEFAULT_BASE = "https://pages.stern.nyu.edu/~adamodar/pc/datasets";

// Damodaran publica vários XLSs; cada um cobre uma family de métricas.
// Mantemos a lista pequena: só os que mapeiam pras métricas que `getSectorBenchmark`
// consome (margem_bruta, dso_target, ...). margem_operacional e dio_target ficam
// como observability extras.
export const DAMODARAN_SOURCES = [
  { name: "margin", file: "margin.xls", sheet: "Industry Averages" },
  { name: "wcdata", file: "wcdata.xls", sheet: "Industry Averages" },
] as const;

export type DamodaranSourceName = (typeof DAMODARAN_SOURCES)[number]["name"];

// Schema da linha do XLS — Zod valida pela KEY (string flexível) porque colunas
// reais variam. Cada parser específico extrai o que importa.
const RowSchema = z.record(z.union([z.string(), z.number(), z.null()]));
export type DamodaranRow = z.infer<typeof RowSchema>;

export interface DamodaranParsedRow {
  industry: string;
  metrics: Record<string, number>;
}

/**
 * Fetch + parse de um único XLS Damodaran. Retorna rows estruturadas.
 *
 * @throws se fetch falhar OU se Zod não conseguir extrair "Industry Name"
 *         (sinal de que layout mudou — escalar pra ops via JobRun.meta).
 */
export async function fetchDamodaranXls(
  source: (typeof DAMODARAN_SOURCES)[number],
  options: { baseUrl?: string; fetchTimeoutMs?: number } = {},
): Promise<{ rawBuffer: Buffer; rows: DamodaranParsedRow[] }> {
  const baseUrl = options.baseUrl ?? process.env.DAMODARAN_DATA_BASE ?? DEFAULT_BASE;
  const url = `${baseUrl.replace(/\/$/, "")}/${source.file}`;
  const timeoutMs = options.fetchTimeoutMs ?? 60_000;

  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`Damodaran fetch failed: ${url} → HTTP ${response.status}`);
  }
  const rawBuffer = Buffer.from(await response.arrayBuffer());

  const workbook = XLSX.read(rawBuffer, { type: "buffer" });
  const sheetName = workbook.SheetNames.includes(source.sheet)
    ? source.sheet
    : workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error(`Damodaran XLS ${source.name}: nenhuma sheet encontrada`);
  }

  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], {
    defval: null,
  });

  const rows: DamodaranParsedRow[] = [];
  let skipped = 0;
  for (const r of raw) {
    const parsed = RowSchema.safeParse(r);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const industry = pickString(parsed.data, ["Industry Name", "Industry", "Group"]);
    if (!industry) {
      skipped++;
      continue;
    }
    const metrics = extractMetrics(parsed.data, source.name);
    if (Object.keys(metrics).length === 0) {
      skipped++;
      continue;
    }
    rows.push({ industry: industry.trim(), metrics });
  }

  if (rows.length === 0) {
    throw new Error(`Damodaran XLS ${source.name}: 0 rows válidas (skipped ${skipped})`);
  }

  return { rawBuffer, rows };
}

function pickString(row: DamodaranRow, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

function pickNumber(row: DamodaranRow, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      // Damodaran às vezes inclui "%" ou "$" — limpa
      const cleaned = v.replace(/[%$,\s]/g, "");
      const n = Number(cleaned);
      if (Number.isFinite(n) && cleaned.length > 0) return n;
    }
  }
  return null;
}

/**
 * Extrai métricas conhecidas de uma row Damodaran, dependendo do source.
 * Os nomes de coluna observados podem variar — pickNumber tenta vários.
 * Métrica não encontrada simplesmente não entra no resultado.
 */
function extractMetrics(row: DamodaranRow, sourceName: DamodaranSourceName): Record<string, number> {
  const out: Record<string, number> = {};

  if (sourceName === "margin") {
    const grossMargin = pickNumber(row, ["Gross Margin", "Gross margin"]);
    if (grossMargin !== null) {
      // Damodaran publica margens em formato decimal (0.45) ou percentual (45).
      // Normalizar pra decimal — se valor > 1.5, assumir percentual.
      out.margem_bruta = grossMargin > 1.5 ? grossMargin / 100 : grossMargin;
    }
    const opMargin = pickNumber(row, ["Operating Margin", "Pre-tax, Pre-stock based comp Operating Margin"]);
    if (opMargin !== null) {
      out.margem_operacional = opMargin > 1.5 ? opMargin / 100 : opMargin;
    }
  }

  if (sourceName === "wcdata") {
    // Damodaran's wcdata table: Days Sales Outstanding, Days Inventory, etc.
    const dso = pickNumber(row, ["Days of Sales Outstanding", "DSO", "Days Sales Outstanding"]);
    if (dso !== null) out.dso_target = dso;
    const dio = pickNumber(row, ["Days of Inventory", "DIO", "Days Inventory Outstanding"]);
    if (dio !== null) out.dio_target = dio;
  }

  return out;
}

/**
 * Aplica um set de rows parseadas como SectorBenchmark rows no DB.
 * Resolve `industry → sectorCode` via DamodaranMapping. Industries sem
 * mapping são retornadas em `unmapped` (caller decide logar/alertar).
 *
 * Idempotente — usa upsert na chave (sectorCode, year, source, metric, percentile).
 *
 * Retorna estatísticas pro JobRun.meta.
 */
export async function applyDamodaranRows(input: {
  rows: DamodaranParsedRow[];
  sourceName: DamodaranSourceName;
  year: number;
  rawSourceUrl: string;
  prismaClient: typeof import("../db/client").prisma;
}): Promise<{ upserted: number; mapped: number; unmapped: string[] }> {
  const mappings = await input.prismaClient.damodaranMapping.findMany();
  const byIndustry = new Map(mappings.map((m) => [m.damodaranIndustry, m.sectorCode]));
  const now = new Date();

  let upserted = 0;
  let mapped = 0;
  const unmapped: string[] = [];

  for (const row of input.rows) {
    const sectorCode = byIndustry.get(row.industry);
    if (!sectorCode) {
      unmapped.push(row.industry);
      continue;
    }
    mapped++;

    for (const [metric, value] of Object.entries(row.metrics)) {
      const unit = metric.startsWith("dso") || metric.startsWith("dio") ? "dias" : "decimal";
      await input.prismaClient.sectorBenchmark.upsert({
        where: {
          sectorCode_year_source_metric_percentile: {
            sectorCode,
            year: input.year,
            source: "damodaran",
            metric,
            percentile: 50,
          },
        },
        create: {
          sectorCode,
          year: input.year,
          source: "damodaran",
          metric,
          value,
          percentile: 50,
          unit,
          fetchedAt: now,
          rawSourceUrl: input.rawSourceUrl,
          notes: `Auto-fetched from ${input.sourceName}.xls`,
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
