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

const prisma = new PrismaClient();

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

async function main() {
  console.log(`Seeding Quantua sector catalog (year=${SEED_YEAR}, source=${SEED_SOURCE})...`);
  await seedSectors();
  await seedBenchmarks();
  await seedDamodaranMappings();
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
