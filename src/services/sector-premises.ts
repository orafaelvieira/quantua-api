/**
 * Premissas setoriais — versão hardcoded legada.
 *
 * @deprecated Em v3 (pivot B2B-3, 2026-05-25), foi adicionado o pipeline
 * DB-driven em `sector-benchmark.ts`. Novos callers devem usar
 * `resolveSectorPremises({ sectorCode, setorText })` daquele módulo.
 *
 * Este arquivo continua existindo como FALLBACK pra:
 *   1. Análises legadas sem `Analysis.sectorId` (substring match em `Company.setor`)
 *   2. Bootstrap de testes que não querem montar fixture do DB
 *
 * Quando os warnings `[sector-benchmark] fallbackFromText` ficarem zerados em
 * prod (sinal de que todas as Analysis têm sectorId), este arquivo pode ser
 * deletado. Os números aqui DEVEM espelhar `prisma/seed-sectors.ts` pros 7
 * setores que existem em ambos — se divergir, snapshot test pega.
 */

export interface SectorPremises {
  receitaGrowth: number;     // anual, decimal (0.062 = 6.2%)
  margemBruta: number;       // sustentável, decimal
  dsoTarget: number;         // dias
  capexPctReceita: number;   // decimal (0.021 = 2.1%)
  custoMedioDivida: number;  // anual, decimal (CDI + spread médio)
}

const DEFAULT_PREMISES: SectorPremises = {
  receitaGrowth: 0.060,
  margemBruta: 0.28,
  dsoTarget: 45,
  capexPctReceita: 0.025,
  custoMedioDivida: 0.165, // CDI ~12% + 4-5% spread
};

const SECTOR_PREMISES: Record<string, SectorPremises> = {
  // Frigorífico · carne bovina — margens baixas, capex alto, ciclo curto
  "frigorifico": {
    receitaGrowth: 0.045,
    margemBruta: 0.18,
    dsoTarget: 35,
    capexPctReceita: 0.035,
    custoMedioDivida: 0.175,
  },
  // Têxtil · indústria de algodão — margens médias, capex moderado
  "textil": {
    receitaGrowth: 0.038,
    margemBruta: 0.23,
    dsoTarget: 60,
    capexPctReceita: 0.020,
    custoMedioDivida: 0.155,
  },
  // Transporte de carga — margens baixas, capex MUITO alto (frota)
  "transporte": {
    receitaGrowth: 0.055,
    margemBruta: 0.22,
    dsoTarget: 40,
    capexPctReceita: 0.060,
    custoMedioDivida: 0.160,
  },
  // Calçados — margens médias
  "calcados": {
    receitaGrowth: 0.040,
    margemBruta: 0.32,
    dsoTarget: 55,
    capexPctReceita: 0.022,
    custoMedioDivida: 0.150,
  },
  // Construção civil — margens variáveis, capex baixo no operacional, alto no estoque
  "construcao": {
    receitaGrowth: 0.080,
    margemBruta: 0.21,
    dsoTarget: 75,
    capexPctReceita: 0.018,
    custoMedioDivida: 0.180,
  },
  // Saúde · serviços hospitalares — margens médias, capex alto (equipamentos)
  "saude": {
    receitaGrowth: 0.085,
    margemBruta: 0.42,
    dsoTarget: 50,
    capexPctReceita: 0.045,
    custoMedioDivida: 0.155,
  },
  // Alimentos · processamento — margens médias
  "alimentos": {
    receitaGrowth: 0.055,
    margemBruta: 0.26,
    dsoTarget: 30,
    capexPctReceita: 0.032,
    custoMedioDivida: 0.170,
  },
};

/**
 * Resolve premissas dado um setor textual.
 * Faz lookup case-insensitive e por substring (ex.: "Frigorífico · Carne Bovina"
 * bate com "frigorifico"). Retorna DEFAULT_PREMISES se nada bate.
 */
export function getSectorPremises(setor: string | null | undefined): SectorPremises {
  if (!setor) return DEFAULT_PREMISES;
  const normalized = setor
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // remove acentos
  for (const key of Object.keys(SECTOR_PREMISES)) {
    if (normalized.includes(key)) {
      return SECTOR_PREMISES[key];
    }
  }
  return DEFAULT_PREMISES;
}

/** Lista todos os setores configurados (útil pra debug/listing). */
export function listConfiguredSectors(): string[] {
  return Object.keys(SECTOR_PREMISES);
}
