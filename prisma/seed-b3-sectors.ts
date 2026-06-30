/**
 * Seed do catálogo de setores na TAXONOMIA OFICIAL B3 (pivot 2026-06).
 *
 * Substitui (desativando) os 13 setores genéricos por:
 *   - 11 setores B3 (nível 1 / "classificação")
 *   - 44 subsetores B3 (nível 2) como filhos (parentCode = slug do setor)
 *
 * Fonte: prisma/seed-data/b3-sectors-seed.json, gerado da API oficial da B3
 * (GetIndustryClassification) cruzada com a base de pares (base_bovespa.xlsx).
 *
 * NÃO deleta os setores legados (varejo, industria_textil, ...): apenas marca
 * `active=false` pra sumirem do picker, preservando a FK de Analysis.sectorId
 * de IBRs já criados.
 *
 * Projeções: cada subsetor recebe um perfil de premissa COMPLETO (5 métricas)
 * via de-para econômico (SECTOR_PROFILE por setor-pai + SUBSECTOR_OVERRIDE pros
 * granulares). Assim `resolveSectorPremises` nunca cai em fallback pros 44 — e
 * a cascata subsetor→setor-pai→default cobre subsetores futuros / "Outros".
 *
 * Idempotente (upsert por code). Roda no boot via `db:seed:b3`.
 */

import { PrismaClient } from "@prisma/client";
import b3Seed from "./seed-data/b3-sectors-seed.json";

const prisma = new PrismaClient();

const SEED_YEAR = 2026;
const SEED_SOURCE = "manual_curation";

interface B3Sector {
  code: string;
  name: string;
  parentCode: string | null;
  level: number;
}
interface B3Subsector extends B3Sector {
  b3Classificacao: string;
  b3Subsetor: string;
  segments: string[];
  peerCount: number;
  hasPeers: boolean;
}
interface B3SeedFile {
  _meta: Record<string, unknown>;
  sectors: B3Sector[];
  subsectors: B3Subsector[];
}

interface Premise {
  receitaGrowth: number;
  margemBruta: number;
  dsoTarget: number;
  capexPctReceita: number;
  custoMedioDivida: number;
}

// Perfis de premissa reaproveitados dos 13 genéricos (espelham seed-sectors.ts /
// sector-premises.ts). Um perfil por SETOR B3 (nível 1).
const SECTOR_PROFILE: Record<string, Premise> = {
  bens_industriais: { receitaGrowth: 0.048, margemBruta: 0.25, dsoTarget: 55, capexPctReceita: 0.035, custoMedioDivida: 0.165 },
  comunicacoes: { receitaGrowth: 0.05, margemBruta: 0.45, dsoTarget: 40, capexPctReceita: 0.12, custoMedioDivida: 0.155 },
  consumo_ciclico: { receitaGrowth: 0.06, margemBruta: 0.32, dsoTarget: 30, capexPctReceita: 0.02, custoMedioDivida: 0.165 },
  consumo_nao_ciclico: { receitaGrowth: 0.055, margemBruta: 0.26, dsoTarget: 30, capexPctReceita: 0.032, custoMedioDivida: 0.17 },
  // Financeiro: bancos/seguros não projetam com este motor; default neutro.
  financeiro: { receitaGrowth: 0.06, margemBruta: 0.28, dsoTarget: 45, capexPctReceita: 0.01, custoMedioDivida: 0.165 },
  materiais_basicos: { receitaGrowth: 0.045, margemBruta: 0.24, dsoTarget: 50, capexPctReceita: 0.04, custoMedioDivida: 0.165 },
  outros: { receitaGrowth: 0.06, margemBruta: 0.28, dsoTarget: 45, capexPctReceita: 0.025, custoMedioDivida: 0.165 },
  petroleo_gas_e_biocombustiveis: { receitaGrowth: 0.05, margemBruta: 0.22, dsoTarget: 35, capexPctReceita: 0.08, custoMedioDivida: 0.16 },
  saude: { receitaGrowth: 0.085, margemBruta: 0.42, dsoTarget: 50, capexPctReceita: 0.045, custoMedioDivida: 0.155 },
  tecnologia_da_informacao: { receitaGrowth: 0.15, margemBruta: 0.65, dsoTarget: 60, capexPctReceita: 0.005, custoMedioDivida: 0.14 },
  utilidade_publica: { receitaGrowth: 0.05, margemBruta: 0.4, dsoTarget: 45, capexPctReceita: 0.09, custoMedioDivida: 0.155 },
};

// Overrides em subsetores granulares que têm perfil curado próprio (espelham
// os 7 setores de sector-premises.ts). Chave = code do subsetor B3.
const SUBSECTOR_OVERRIDE: Record<string, Premise> = {
  consumo_nao_ciclico__alimentos_processados: { receitaGrowth: 0.055, margemBruta: 0.26, dsoTarget: 30, capexPctReceita: 0.032, custoMedioDivida: 0.17 },
  consumo_nao_ciclico__agropecuaria: { receitaGrowth: 0.062, margemBruta: 0.28, dsoTarget: 75, capexPctReceita: 0.055, custoMedioDivida: 0.15 },
  consumo_ciclico__tecidos_vestuario_e_calcados: { receitaGrowth: 0.038, margemBruta: 0.23, dsoTarget: 60, capexPctReceita: 0.02, custoMedioDivida: 0.155 },
  consumo_ciclico__construcao_civil: { receitaGrowth: 0.08, margemBruta: 0.21, dsoTarget: 75, capexPctReceita: 0.018, custoMedioDivida: 0.18 },
  bens_industriais__transporte: { receitaGrowth: 0.055, margemBruta: 0.22, dsoTarget: 40, capexPctReceita: 0.06, custoMedioDivida: 0.16 },
};

const METRIC_MAP: Array<{ metric: string; key: keyof Premise; unit: string }> = [
  { metric: "receita_growth", key: "receitaGrowth", unit: "decimal" },
  { metric: "margem_bruta", key: "margemBruta", unit: "decimal" },
  { metric: "dso_target", key: "dsoTarget", unit: "dias" },
  { metric: "capex_pct_receita", key: "capexPctReceita", unit: "decimal" },
  { metric: "custo_medio_divida", key: "custoMedioDivida", unit: "decimal" },
];

function premiseFor(sub: B3Subsector): Premise {
  return SUBSECTOR_OVERRIDE[sub.code] ?? SECTOR_PROFILE[sub.parentCode!] ?? SECTOR_PROFILE.outros;
}

async function main() {
  const seed = b3Seed as unknown as B3SeedFile;
  const now = new Date();
  console.log(`Seeding B3 sector taxonomy (${seed.sectors.length} setores + ${seed.subsectors.length} subsetores)...`);

  // 1. Desativar genéricos legados que NÃO fazem parte da taxonomia B3.
  const b3Codes = new Set<string>([
    ...seed.sectors.map((s) => s.code),
    ...seed.subsectors.map((s) => s.code),
    "default", // mantém o default ativo (usado como fallback final)
  ]);
  const legacy = await prisma.sector.findMany({ where: { active: true } });
  let deactivated = 0;
  for (const s of legacy) {
    if (!b3Codes.has(s.code)) {
      await prisma.sector.update({ where: { code: s.code }, data: { active: false } });
      deactivated++;
    }
  }
  console.log(`  Legados desativados: ${deactivated}`);

  // 2. Upsert setores nível 1 + subsetores nível 2.
  let upserted = 0;
  for (const s of [...seed.sectors, ...seed.subsectors]) {
    await prisma.sector.upsert({
      where: { code: s.code },
      create: { code: s.code, name: s.name, parentCode: s.parentCode ?? null, active: true },
      update: { name: s.name, parentCode: s.parentCode ?? null, active: true },
    });
    upserted++;
  }
  console.log(`  Setores/subsetores B3 upsertados: ${upserted}`);

  // 3. Premissas (benchmark manual_curation) — perfil completo por subsetor +
  //    por setor-pai (pra cascata subsetor→pai→default cobrir tudo).
  let benchUpserts = 0;
  const profileTargets: Array<{ code: string; premise: Premise }> = [
    ...seed.sectors.map((s) => ({ code: s.code, premise: SECTOR_PROFILE[s.code] ?? SECTOR_PROFILE.outros })),
    ...seed.subsectors.map((s) => ({ code: s.code, premise: premiseFor(s) })),
  ];
  for (const { code, premise } of profileTargets) {
    for (const { metric, key, unit } of METRIC_MAP) {
      await prisma.sectorBenchmark.upsert({
        where: {
          sectorCode_year_source_metric_percentile: {
            sectorCode: code, year: SEED_YEAR, source: SEED_SOURCE, metric, percentile: -1,
          },
        },
        create: {
          sectorCode: code, year: SEED_YEAR, source: SEED_SOURCE, metric,
          value: premise[key], percentile: -1, unit, fetchedAt: now,
          notes: `Seed B3 taxonomy — de-para de premissa (${code})`,
        },
        update: { value: premise[key], unit, fetchedAt: now },
      });
      benchUpserts++;
    }
  }
  console.log(`  Benchmarks (premissa) upsertados: ${benchUpserts}`);
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
