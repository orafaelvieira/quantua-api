/**
 * Snapshot de regressão do projection-engine.
 *
 * Roda computeProjections() com fixture sintético pra 5 setores que têm valores
 * explícitos em sector-premises.ts (frigorifico, textil, saude, construcao, default).
 * Setores escolhidos pra ficar VERDE através da Fase 2 — quando o engine migrar
 * pra ler de SectorBenchmark (DB), o seed espelha esses valores e o snapshot
 * deve continuar idêntico.
 *
 * Se uma mudança em projection-engine.ts ou sector-premises.ts alterar números
 * sem ser intencional, este teste falha — protege contra regressão.
 *
 * Para atualizar intencionalmente: `npx vitest run -u`.
 */

import { describe, it, expect } from "vitest";
import { computeProjections } from "../../src/services/projection-engine";

const FIXTURE = {
  dadosEstruturados: {
    periodos: ["2024", "2025"],
    bp: [
      { conta: "Caixa e Equivalentes de Caixa", valores: { "2024": 500_000, "2025": 600_000 } },
      { conta: "Contas a Receber", valores: { "2024": 800_000, "2025": 850_000 } },
      { conta: "Estoques", valores: { "2024": 1_200_000, "2025": 1_300_000 } },
      { conta: "Ativo Total", valores: { "2024": 5_000_000, "2025": 5_500_000 } },
      { conta: "Fornecedores", valores: { "2024": 700_000, "2025": 750_000 } },
      { conta: "Empréstimos - Curto Prazo", valores: { "2024": 400_000, "2025": 350_000 } },
      { conta: "Empréstimos - Longo Prazo", valores: { "2024": 1_200_000, "2025": 1_100_000 } },
      { conta: "Patrimônio Líquido", valores: { "2024": 2_500_000, "2025": 2_900_000 } },
    ],
    dre: [
      { conta: "Receita Líquida", valores: { "2024": 12_000_000, "2025": 13_000_000 } },
      { conta: "Lucro Bruto", valores: { "2024": 3_600_000, "2025": 3_900_000 } },
      { conta: "Despesas Operacionais", valores: { "2024": -2_400_000, "2025": -2_600_000 } },
      { conta: "Depreciação", valores: { "2024": -200_000, "2025": -210_000 } },
    ],
  },
  stcf: {
    weeks: Array.from({ length: 13 }, (_, i) => ({
      closingCash: 600_000 + i * 5_000,
      outflows: [{ category: "serviço da dívida", amount: 30_000 }],
    })),
  },
  scenario: {
    kind: "base",
    assumptions: {
      revenueMultiplier: 1.0,
      cogsMultiplier: 1.0,
      opexMultiplier: 1.0,
      dsoDeltaDays: 0,
      dpoDeltaDays: 0,
      dioDeltaDays: 0,
    },
  },
  // startMonth fixo pra estabilizar labels "Jul/26" etc — não usar `new Date()`,
  // que mudaria a saída a cada execução. Meio do mês ao meio-dia UTC pra evitar
  // dois problemas: (a) timezone shift cruzando dias (b) dt.setMonth(31)
  // pulando meses curtos.
  startMonth: new Date("2026-06-15T12:00:00Z"),
};

// Setores cobertos por sector-premises.ts (valores explícitos, não fallback DEFAULT).
// Adicionamos "default" via setor=null que força a fallback de propósito.
const SECTORS_TO_TEST: Array<{ label: string; setor: string | null }> = [
  { label: "frigorifico", setor: "Frigorífico · Carne Bovina" },
  { label: "textil", setor: "Têxtil · Algodão" },
  { label: "saude", setor: "Saúde · Hospitalar" },
  { label: "construcao", setor: "Construção Civil" },
  { label: "default", setor: null },
];

describe("projection-engine regression snapshot", () => {
  for (const { label, setor } of SECTORS_TO_TEST) {
    it(`computeProjections é estável para setor=${label}`, () => {
      const result = computeProjections({
        ...FIXTURE,
        setor,
      });
      expect(result).toMatchSnapshot();
    });
  }
});
