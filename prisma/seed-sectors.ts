/**
 * Seed do catálogo de setores Quantua (#6 Fase 1).
 *
 * Popula:
 *  - Sector — 13 entries (12 setores canônicos + "default")
 *  - SectorBenchmark — 65 rows (13 setores × 5 métricas), source="manual_curation"
 *  - DamodaranMapping — ~13 mapeamentos curados manualmente
 *
 * Idempotente: usa upsert por chave única. Pode rodar várias vezes sem duplicar.
 *
 * Os números pros 7 setores do backend (frigorifico, textil, transporte, calcados,
 * construcao, saude, alimentos + default) vêm direto de src/services/sector-premises.ts
 * — Fase 1 NÃO regride comportamento; apenas duplica fonte pra DB.
 *
 * Os 5 setores frontend-only (varejo, industria, servicos, agro, tech) ganham
 * valores plausíveis baseados em conhecimento setorial. Refinamento via fases
 * 3 e 4 (Damodaran + IBGE PIA + BCB SGS).
 */

import { PrismaClient } from "@prisma/client";
import damodaranBootstrap from "./seed-data/damodaran-bootstrap-2026.json";
import ibgePiaBootstrap from "./seed-data/ibge-pia-bootstrap-2024.json";
import bcbSgsBootstrap from "./seed-data/bcb-sgs-bootstrap-2026.json";
import cnaeMappings from "./seed-data/cnae-mappings.json";

const prisma = new PrismaClient();

interface BootstrapMetric {
  metric: string;
  value: number;
  unit: string;
}

interface DamodaranIndustry {
  damodaranIndustry: string;
  metrics: BootstrapMetric[];
}

interface DamodaranFile {
  _meta: {
    year: number;
    source: string;
    vintage: string;
    rawSourceUrl: string;
    notes: string;
  };
  industries: DamodaranIndustry[];
}

interface CnaeIndustry {
  cnae: string;
  name: string;
  metrics: BootstrapMetric[];
}

interface IbgePiaFile {
  _meta: { year: number; source: string; vintage: string; rawSourceUrl: string; notes: string };
  cnae_industries: CnaeIndustry[];
}

interface BcbSeries {
  series_code: number;
  metric: string;
  value: number;
  unit: string;
  notes?: string;
}

interface BcbSgsFile {
  _meta: { year: number; source: string; vintage: string; rawSourceUrl: string; notes: string };
  series: BcbSeries[];
  derived: {
    custo_medio_divida: { value: number; unit: string; formula: string; notes: string };
  };
}

interface CnaeMapping {
  cnae: string;
  sectorCode: string;
  description?: string;
}

interface CnaeMappingFile {
  _meta: { vintage: string; notes: string };
  mappings: CnaeMapping[];
}

interface SeedSector {
  code: string;
  name: string;
  parentCode?: string;
}

interface SeedBenchmark {
  receitaGrowth: number;
  margemBruta: number;
  dsoTarget: number;
  capexPctReceita: number;
  custoMedioDivida: number;
}

interface SeedDamodaranMapping {
  damodaranIndustry: string;
  sectorCode: string;
  notes?: string;
}

const SECTORS: SeedSector[] = [
  { code: "varejo", name: "Varejo" },
  { code: "industria", name: "Indústria" },
  { code: "industria_frigorifico", name: "Frigorífico", parentCode: "industria" },
  { code: "industria_textil", name: "Têxtil", parentCode: "industria" },
  { code: "industria_calcados", name: "Calçados", parentCode: "industria" },
  { code: "industria_alimentos", name: "Alimentos", parentCode: "industria" },
  { code: "servicos", name: "Serviços" },
  { code: "servicos_transporte", name: "Transporte", parentCode: "servicos" },
  { code: "agro", name: "Agronegócio" },
  { code: "construcao", name: "Construção" },
  { code: "saude", name: "Saúde" },
  { code: "tech", name: "Tecnologia" },
  { code: "default", name: "Default (genérico)" },
];

// Valores espelhados de src/services/sector-premises.ts para os 7 setores existentes,
// + curadoria pros 5 novos (varejo, industria, servicos, agro, tech).
const BENCHMARKS: Record<string, SeedBenchmark> = {
  varejo: {
    receitaGrowth: 0.060,
    margemBruta: 0.32,
    dsoTarget: 12,
    capexPctReceita: 0.015,
    custoMedioDivida: 0.165,
  },
  industria: {
    receitaGrowth: 0.048,
    margemBruta: 0.25,
    dsoTarget: 55,
    capexPctReceita: 0.035,
    custoMedioDivida: 0.165,
  },
  industria_frigorifico: {
    receitaGrowth: 0.045,
    margemBruta: 0.18,
    dsoTarget: 35,
    capexPctReceita: 0.035,
    custoMedioDivida: 0.175,
  },
  industria_textil: {
    receitaGrowth: 0.038,
    margemBruta: 0.23,
    dsoTarget: 60,
    capexPctReceita: 0.020,
    custoMedioDivida: 0.155,
  },
  industria_calcados: {
    receitaGrowth: 0.040,
    margemBruta: 0.32,
    dsoTarget: 55,
    capexPctReceita: 0.022,
    custoMedioDivida: 0.150,
  },
  industria_alimentos: {
    receitaGrowth: 0.055,
    margemBruta: 0.26,
    dsoTarget: 30,
    capexPctReceita: 0.032,
    custoMedioDivida: 0.170,
  },
  servicos: {
    receitaGrowth: 0.075,
    margemBruta: 0.55,
    dsoTarget: 45,
    capexPctReceita: 0.010,
    custoMedioDivida: 0.155,
  },
  servicos_transporte: {
    receitaGrowth: 0.055,
    margemBruta: 0.22,
    dsoTarget: 40,
    capexPctReceita: 0.060,
    custoMedioDivida: 0.160,
  },
  agro: {
    receitaGrowth: 0.062,
    margemBruta: 0.28,
    dsoTarget: 75,
    capexPctReceita: 0.055,
    custoMedioDivida: 0.150,
  },
  construcao: {
    receitaGrowth: 0.080,
    margemBruta: 0.21,
    dsoTarget: 75,
    capexPctReceita: 0.018,
    custoMedioDivida: 0.180,
  },
  saude: {
    receitaGrowth: 0.085,
    margemBruta: 0.42,
    dsoTarget: 50,
    capexPctReceita: 0.045,
    custoMedioDivida: 0.155,
  },
  tech: {
    receitaGrowth: 0.150,
    margemBruta: 0.65,
    dsoTarget: 60,
    capexPctReceita: 0.005,
    custoMedioDivida: 0.140,
  },
  default: {
    receitaGrowth: 0.060,
    margemBruta: 0.28,
    dsoTarget: 45,
    capexPctReceita: 0.025,
    custoMedioDivida: 0.165,
  },
};

// Métrica EAV → (atributo em SeedBenchmark, unit). Percentile=null pra todos
// porque "manual_curation" não tem distribuição; é valor único de referência.
const METRIC_MAP: Array<{ metric: string; key: keyof SeedBenchmark; unit: string }> = [
  { metric: "receita_growth", key: "receitaGrowth", unit: "decimal" },
  { metric: "margem_bruta", key: "margemBruta", unit: "decimal" },
  { metric: "dso_target", key: "dsoTarget", unit: "dias" },
  { metric: "capex_pct_receita", key: "capexPctReceita", unit: "decimal" },
  { metric: "custo_medio_divida", key: "custoMedioDivida", unit: "decimal" },
];

const DAMODARAN_MAPPINGS: SeedDamodaranMapping[] = [
  { damodaranIndustry: "Apparel", sectorCode: "industria_textil" },
  { damodaranIndustry: "Food Processing", sectorCode: "industria_alimentos" },
  { damodaranIndustry: "Food Wholesalers", sectorCode: "industria_alimentos" },
  { damodaranIndustry: "Healthcare Products", sectorCode: "saude" },
  { damodaranIndustry: "Healthcare Facilities", sectorCode: "saude" },
  { damodaranIndustry: "Retail (General)", sectorCode: "varejo" },
  { damodaranIndustry: "Retail (Online)", sectorCode: "varejo" },
  { damodaranIndustry: "Construction Supplies", sectorCode: "construcao" },
  { damodaranIndustry: "Engineering/Construction", sectorCode: "construcao" },
  { damodaranIndustry: "Trucking", sectorCode: "servicos_transporte" },
  { damodaranIndustry: "Software (System & Application)", sectorCode: "tech" },
  { damodaranIndustry: "Farming/Agriculture", sectorCode: "agro" },
  { damodaranIndustry: "Business & Consumer Services", sectorCode: "servicos" },
  { damodaranIndustry: "Total Market", sectorCode: "default" },
];

const SEED_YEAR = 2026;
const SEED_SOURCE = "manual_curation";

async function seedSectors() {
  console.log("Seeding Sector catalog...");
  let created = 0;
  let updated = 0;

  for (const s of SECTORS) {
    const result = await prisma.sector.upsert({
      where: { code: s.code },
      create: {
        code: s.code,
        name: s.name,
        parentCode: s.parentCode ?? null,
        active: true,
      },
      update: {
        name: s.name,
        parentCode: s.parentCode ?? null,
        active: true,
      },
    });
    if (result.createdAt.getTime() > Date.now() - 5000) {
      created++;
    } else {
      updated++;
    }
  }

  console.log(`  Sectors: ${created} created, ${updated} updated`);
}

async function seedBenchmarks() {
  console.log("Seeding SectorBenchmark rows...");
  const now = new Date();
  let upserted = 0;

  for (const sectorCode of Object.keys(BENCHMARKS)) {
    const values = BENCHMARKS[sectorCode];
    for (const { metric, key, unit } of METRIC_MAP) {
      await prisma.sectorBenchmark.upsert({
        where: {
          sectorCode_year_source_metric_percentile: {
            sectorCode,
            year: SEED_YEAR,
            source: SEED_SOURCE,
            metric,
            percentile: -1,
          },
        },
        create: {
          sectorCode,
          year: SEED_YEAR,
          source: SEED_SOURCE,
          metric,
          value: values[key],
          // Postgres trata `null` em @@unique como "sempre diferente", o que quebra
          // idempotência. Sentinela -1 mantém upsert idempotente. Reservar
          // percentile real (25/50/75) pras fases 3/4 (Damodaran/IBGE).
          percentile: -1,
          unit,
          fetchedAt: now,
          notes: `Seed manual a partir de src/services/sector-premises.ts (${sectorCode})`,
        },
        update: {
          value: values[key],
          fetchedAt: now,
          unit,
        },
      });
      upserted++;
    }
  }

  console.log(`  Benchmarks: ${upserted} upserted`);
}

async function seedDamodaranMappings() {
  console.log("Seeding DamodaranMapping entries...");
  let upserted = 0;

  for (const m of DAMODARAN_MAPPINGS) {
    await prisma.damodaranMapping.upsert({
      where: { damodaranIndustry: m.damodaranIndustry },
      create: {
        damodaranIndustry: m.damodaranIndustry,
        sectorCode: m.sectorCode,
        notes: m.notes ?? null,
      },
      update: {
        sectorCode: m.sectorCode,
        notes: m.notes ?? null,
      },
    });
    upserted++;
  }

  console.log(`  Damodaran mappings: ${upserted} upserted`);
}

/**
 * Bootstrap de benchmarks Damodaran (Fase 3 do pipeline #6).
 *
 * Idempotente: usa upsert por (sectorCode, year, source, metric, percentile).
 * Quando o job mensal `fetch-damodaran-benchmarks` rodar com sucesso, vai
 * sobrescrever esses valores com o fetch real do XLS. Antes disso, esse
 * seed garante que `getSectorBenchmark()` já retorna dados Damodaran
 * plausíveis em prod desde a primeira deploy.
 *
 * Resolve `damodaranIndustry → sectorCode` via DamodaranMapping seedado acima.
 * Industries sem mapping são logadas e puladas.
 */
async function seedDamodaranBootstrap() {
  console.log("Seeding Damodaran bootstrap benchmarks...");
  const bootstrap = damodaranBootstrap as unknown as DamodaranFile;
  const { year, source, vintage, rawSourceUrl } = bootstrap._meta;
  const now = new Date();

  const mappings = await prisma.damodaranMapping.findMany();
  const mappingByIndustry = new Map(mappings.map((m) => [m.damodaranIndustry, m.sectorCode]));

  let upserted = 0;
  let unmapped: string[] = [];

  for (const industry of bootstrap.industries) {
    const sectorCode = mappingByIndustry.get(industry.damodaranIndustry);
    if (!sectorCode) {
      unmapped.push(industry.damodaranIndustry);
      continue;
    }

    for (const m of industry.metrics) {
      await prisma.sectorBenchmark.upsert({
        where: {
          sectorCode_year_source_metric_percentile: {
            sectorCode,
            year,
            source,
            metric: m.metric,
            percentile: 50, // Damodaran agrega mediana setorial
          },
        },
        create: {
          sectorCode,
          year,
          source,
          metric: m.metric,
          value: m.value,
          percentile: 50,
          unit: m.unit,
          fetchedAt: now,
          rawSourceUrl,
          notes: `Bootstrap ${vintage} (substituído pelo cron fetch-damodaran-benchmarks no próximo run)`,
        },
        update: {
          value: m.value,
          unit: m.unit,
          fetchedAt: now,
          // notes ficam imutáveis: bootstrap sempre é "bootstrap", refresh
          // do cron escreve outras linhas (mesmo @@unique key porém update path)
        },
      });
      upserted++;
    }
  }

  console.log(`  Damodaran bootstrap: ${upserted} upserted across ${bootstrap.industries.length - unmapped.length} mapped industries`);
  if (unmapped.length > 0) {
    console.warn(`  ⚠ Damodaran industries sem mapping: ${unmapped.join(", ")}`);
  }
}

/**
 * Bootstrap de mapeamentos CNAE → setor (Fase 4 do pipeline #6).
 *
 * Usado pelo job `fetch-ibge-pia` pra resolver CNAE 2-dig do SIDRA pro
 * setor canônico Quantua. Idempotente.
 */
async function seedCnaeMappings() {
  console.log("Seeding CNAE mappings...");
  const file = cnaeMappings as unknown as CnaeMappingFile;
  const now = new Date();

  let upserted = 0;
  for (const m of file.mappings) {
    await prisma.cnaeMapping.upsert({
      where: { cnae: m.cnae },
      create: {
        cnae: m.cnae,
        sectorCode: m.sectorCode,
        description: m.description ?? null,
        confidence: "high",
        reviewedAt: now,
      },
      update: {
        sectorCode: m.sectorCode,
        description: m.description ?? null,
        reviewedAt: now,
      },
    });
    upserted++;
  }

  console.log(`  CNAE mappings: ${upserted} upserted`);
}

/**
 * Bootstrap de benchmarks IBGE PIA 2024 (Fase 4 do pipeline #6).
 *
 * Resolve CNAE 2-dig → sectorCode via CnaeMapping seedada acima. Industries
 * sem mapping são logadas (CNAEs adicionais podem ser curados depois).
 *
 * Idempotente. Quando o job anual `fetch-ibge-pia` rodar com sucesso,
 * sobrescreve esses valores com fetch real da SIDRA.
 */
async function seedIbgeBootstrap() {
  console.log("Seeding IBGE PIA bootstrap benchmarks...");
  const bootstrap = ibgePiaBootstrap as unknown as IbgePiaFile;
  const { year, source, vintage, rawSourceUrl } = bootstrap._meta;
  const now = new Date();

  const cnaes = await prisma.cnaeMapping.findMany();
  const sectorByCnae = new Map(cnaes.map((c) => [c.cnae, c.sectorCode]));

  // Múltiplos CNAEs podem mapear pro mesmo setor — agregamos por setor
  // tomando a média ponderada simples (sem peso de receita, MVP).
  const aggregated = new Map<string, Map<string, { sum: number; count: number; unit: string }>>();
  let unmapped: string[] = [];

  for (const industry of bootstrap.cnae_industries) {
    const sectorCode = sectorByCnae.get(industry.cnae);
    if (!sectorCode) {
      unmapped.push(industry.cnae);
      continue;
    }
    if (!aggregated.has(sectorCode)) {
      aggregated.set(sectorCode, new Map());
    }
    const sectorMetrics = aggregated.get(sectorCode)!;
    for (const m of industry.metrics) {
      const prev = sectorMetrics.get(m.metric);
      if (prev) {
        prev.sum += m.value;
        prev.count += 1;
      } else {
        sectorMetrics.set(m.metric, { sum: m.value, count: 1, unit: m.unit });
      }
    }
  }

  let upserted = 0;
  for (const [sectorCode, metrics] of aggregated.entries()) {
    for (const [metric, agg] of metrics.entries()) {
      const value = agg.sum / agg.count;
      await prisma.sectorBenchmark.upsert({
        where: {
          sectorCode_year_source_metric_percentile: {
            sectorCode,
            year,
            source,
            metric,
            percentile: 50,
          },
        },
        create: {
          sectorCode,
          year,
          source,
          metric,
          value,
          percentile: 50,
          unit: agg.unit,
          fetchedAt: now,
          rawSourceUrl,
          notes: `Bootstrap ${vintage} (média de ${agg.count} CNAE${agg.count > 1 ? "s" : ""} mapeado${agg.count > 1 ? "s" : ""})`,
        },
        update: {
          value,
          unit: agg.unit,
          fetchedAt: now,
        },
      });
      upserted++;
    }
  }

  console.log(`  IBGE PIA bootstrap: ${upserted} upserted across ${aggregated.size} setor(es)`);
  if (unmapped.length > 0) {
    console.warn(`  ⚠ CNAEs sem mapping: ${unmapped.join(", ")}`);
  }
}

/**
 * Bootstrap de macros BCB SGS (Fase 4 do pipeline #6).
 *
 * Aplica:
 *   1. Macros raw (cdi_anual, selic_anual, spread_pj_medio_anual) a
 *      sectorCode="default" — observability + futuro consumo direto.
 *   2. `custo_medio_divida` derivado (cdi + spread) a TODOS os setores —
 *      sobrescreve o valor de manual_curation da Fase 1 porque BCB
 *      ordena alfabético antes (bcb_sgs < manual_curation).
 *
 * Idempotente. Quando o job trimestral `fetch-bcb-sgs` rodar com sucesso,
 * sobrescreve esses valores com fetch real da API.
 */
async function seedBcbBootstrap() {
  console.log("Seeding BCB SGS bootstrap benchmarks...");
  const bootstrap = bcbSgsBootstrap as unknown as BcbSgsFile;
  const { year, source, vintage, rawSourceUrl } = bootstrap._meta;
  const now = new Date();

  let upserted = 0;

  // 1. Macros raw → sector "default"
  for (const series of bootstrap.series) {
    await prisma.sectorBenchmark.upsert({
      where: {
        sectorCode_year_source_metric_percentile: {
          sectorCode: "default",
          year,
          source,
          metric: series.metric,
          percentile: -1, // sentinela; séries macro não têm distribuição
        },
      },
      create: {
        sectorCode: "default",
        year,
        source,
        metric: series.metric,
        value: series.value,
        percentile: -1,
        unit: series.unit,
        fetchedAt: now,
        rawSourceUrl: `${rawSourceUrl}.${series.series_code}/dados/ultimos/4?formato=json`,
        notes: `Bootstrap ${vintage} — SGS série ${series.series_code} (${series.notes ?? ""})`,
      },
      update: {
        value: series.value,
        unit: series.unit,
        fetchedAt: now,
      },
    });
    upserted++;
  }

  // 2. custo_medio_divida derivado → todos os setores ativos
  const allSectors = await prisma.sector.findMany({ where: { active: true } });
  const custoDivida = bootstrap.derived.custo_medio_divida;
  for (const sector of allSectors) {
    await prisma.sectorBenchmark.upsert({
      where: {
        sectorCode_year_source_metric_percentile: {
          sectorCode: sector.code,
          year,
          source,
          metric: "custo_medio_divida",
          percentile: -1,
        },
      },
      create: {
        sectorCode: sector.code,
        year,
        source,
        metric: "custo_medio_divida",
        value: custoDivida.value,
        percentile: -1,
        unit: custoDivida.unit,
        fetchedAt: now,
        rawSourceUrl,
        notes: `Bootstrap ${vintage} — derivado: ${custoDivida.formula}`,
      },
      update: {
        value: custoDivida.value,
        unit: custoDivida.unit,
        fetchedAt: now,
      },
    });
    upserted++;
  }

  console.log(`  BCB SGS bootstrap: ${upserted} upserted (${bootstrap.series.length} macros + custo_medio_divida em ${allSectors.length} setores)`);
}

async function main() {
  console.log(`Seeding Quantua sector catalog (year=${SEED_YEAR}, source=${SEED_SOURCE})...`);
  await seedSectors();
  await seedBenchmarks();
  await seedDamodaranMappings();
  await seedDamodaranBootstrap();
  await seedCnaeMappings();
  await seedIbgeBootstrap();
  await seedBcbBootstrap();
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
