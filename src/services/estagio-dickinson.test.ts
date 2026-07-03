import { vi, describe, it, expect } from "vitest";

vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: vi.fn() } } }));
vi.mock("../config/env", () => ({ env: { anthropicApiKey: "test-key" } }));

import { classifyEstagio, type FluxoCaixaLite } from "./claude";

type Lite = { nome: string; valores: Record<string, number | string | null>; status?: Record<string, "ok" | "atencao" | "critico" | null> };
const ind = (nome: string, valores: Record<string, number>): Lite => ({ nome, valores });

// Empresa saudável nos indicadores (para a regra de crise de caixa NÃO disparar)
const INDS = [
  ind("Receita Líquida", { "2022": 1000, "2023": 1100 }),
  ind("Margem EBITDA", { "2022": 0.12, "2023": 0.15 }),
  ind("Liquidez Corrente", { "2022": 1.8, "2023": 1.9 }),
  ind("Liquidez Imediata", { "2022": 0.4, "2023": 0.5 }),
] as never[];

const fc = (fco: number, fci: number, fcf: number, fecha = true): FluxoCaixaLite => ({
  colunas: ["2023"],
  totais: { fco: { "2023": fco }, fci: { "2023": fci }, fcf: { "2023": fcf } },
  prova: [{ periodo: "2023", fecha }],
});

describe("classifyEstagio — Dickinson pelos sinais do FC", () => {
  it("FCO+ FCI− FCF− → Maturidade", () => {
    const r = classifyEstagio(INDS, ["2022", "2023"], fc(500, -200, -150));
    expect(r?.estagio).toBe("Maturidade");
    expect(r?.justificativa).toContain("Dickinson");
  });

  it("FCO+ FCI− FCF+ → Crescimento", () => {
    expect(classifyEstagio(INDS, ["2022", "2023"], fc(300, -500, 400))?.estagio).toBe("Crescimento");
  });

  it("FCO− FCI+ → Declínio (venda de ativos cobrindo queima operacional)", () => {
    expect(classifyEstagio(INDS, ["2022", "2023"], fc(-300, 250, 100))?.estagio).toBe("Declínio");
  });

  it("FCO+ FCI+ FCF− → Platô (shake-out)", () => {
    expect(classifyEstagio(INDS, ["2022", "2023"], fc(200, 150, -300))?.estagio).toBe("Platô");
  });

  it("prova NÃO fecha → ignora o FC e cai na heurística de receita (verde só com prova)", () => {
    const r = classifyEstagio(INDS, ["2022", "2023"], fc(-300, 250, 100, false));
    expect(r?.estagio).not.toBe("Declínio"); // receita cresce 10% c/ margem ok → não é declínio
    expect(r?.justificativa).not.toContain("Dickinson");
  });

  it("CRISE DE CAIXA tem prioridade sobre Dickinson (aperto agudo manda)", () => {
    const emCrise = [
      ind("Receita Líquida", { "2022": 1000, "2023": 900 }),
      ind("Margem EBITDA", { "2022": -0.05, "2023": -0.1 }),
      ind("Liquidez Corrente", { "2022": 0.9, "2023": 0.8 }),
      ind("Liquidez Imediata", { "2022": 0.03, "2023": 0.02 }),
    ] as never[];
    expect(classifyEstagio(emCrise, ["2022", "2023"], fc(500, -200, -150))?.estagio).toBe("Crise de caixa");
  });

  it("sem FC → heurística de receita/margem continua funcionando (fallback)", () => {
    const r = classifyEstagio(INDS, ["2022", "2023"], null);
    expect(r).not.toBeNull();
    expect(r?.justificativa).not.toContain("Dickinson");
  });
});
