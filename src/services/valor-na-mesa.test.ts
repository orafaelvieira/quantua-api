import { describe, it, expect } from "vitest";
import { calcularValorCanonico } from "./valor-na-mesa";
import type { PeerComparisonRow } from "./peer-benchmark";

const row = (indicador: string, p50: number, higherIsBetter: boolean): PeerComparisonRow =>
  ({ indicador, valor: 0, p25: 0, p50, p75: 0, percentil: 50, level: "setor", segment: "Comércio e Distribuição", count: 9, higherIsBetter });

const ind = (nome: string, v: number) => ({ nome, valores: { "31/12/2025": v } });
const PERIODOS = ["31/12/2024", "31/12/2025"];
const BASE = { segmento: "Comércio e Distribuição", periodo: "1T26 (LTM)" };

// Cenário Move Farma-like: receita 26,25M; custo 18,9M; PMR 57 vs mediana 50;
// PMP 43 vs mediana 69; margem 13,1% vs 7,9% (MELHOR — não dispara).
const INDS = [
  ind("Receita Líquida", 26_250_000),
  ind("Prazo Médio Contas a Receber", 57),
  ind("Prazo Médio Estoque", 28),
  ind("Prazo Médio Fornecedores", 43),
  ind("Margem EBITDA", 0.131),
];
const DRE = [{ conta: "Custo Operacional", valores: { "31/12/2025": -18_900_000 } }];
const ROWS = [
  row("Prazo Médio Contas a Receber", 50, false),
  row("Prazo Médio Estoque", 30, false),
  row("Prazo Médio Fornecedores", 69, true),
  row("Margem EBITDA", 0.079, true),
];

describe("valor-na-mesa — alavancas canônicas (determinísticas)", () => {
  it("dispara SÓ onde a empresa está do lado ruim da mediana, com a conta certa", () => {
    const r = calcularValorCanonico(INDS, PERIODOS, ROWS, DRE, BASE)!;
    const chaves = r.alavancas.map((a) => a.titulo);

    // PMR 57 vs 50 → 7 dias × (26,25M/365)
    const pmr = r.alavancas.find((a) => a.titulo.includes("Receber"))!;
    expect(pmr.valor).toBe(Math.round(7 * (26_250_000 / 365)));
    expect(pmr.tipo).toBe("caixa");
    expect(pmr.memoria).toContain("57 dias");
    expect(pmr.memoria).toContain("50");

    // PMP 43 vs 69 → 26 dias × (18,9M/365)
    const pmp = r.alavancas.find((a) => a.titulo.includes("fornecedores") || a.titulo.includes("Pagar"))!;
    expect(pmp.valor).toBe(Math.round(26 * (18_900_000 / 365)));

    // Estoque 28 vs 30 → MELHOR que a mediana: não dispara.
    expect(chaves.some((t) => t.includes("estoque") || t.includes("Girar"))).toBe(false);
    // Margem 13,1% vs 7,9% → MELHOR: não dispara.
    expect(chaves.some((t) => t.includes("margem"))).toBe(false);

    expect(r.caixaLiberavel).toBe(pmr.valor + pmp.valor);
    expect(r.margemRecuperavelAno).toBe(0);
    expect(r.total).toBe(r.caixaLiberavel);
    // determinístico: mesma entrada, mesma saída
    expect(calcularValorCanonico(INDS, PERIODOS, ROWS, DRE, BASE)).toEqual(r);
  });

  it("margem ABAIXO da mediana → recuperável por ano = gap × receita", () => {
    const inds = [ind("Receita Líquida", 10_000_000), ind("Margem EBITDA", 0.05)];
    const rows = [row("Margem EBITDA", 0.11, true)];
    const r = calcularValorCanonico(inds, PERIODOS, rows, [], BASE)!;
    const mg = r.alavancas[0];
    expect(mg.tipo).toBe("margem");
    expect(mg.valor).toBe(Math.round(0.06 * 10_000_000));
    expect(r.margemRecuperavelAno).toBe(mg.valor);
  });

  it("sem Custo Operacional na DRE → estoque/fornecedores não disparam (sem chute)", () => {
    const inds = [ind("Receita Líquida", 10_000_000), ind("Prazo Médio Fornecedores", 30)];
    const rows = [row("Prazo Médio Fornecedores", 60, true)];
    const r = calcularValorCanonico(inds, PERIODOS, rows, [], BASE)!;
    expect(r.alavancas.length).toBe(0);
    expect(r.total).toBe(0);
  });

  it("gap de poucos dias (< 3) ou valor pequeno é ruído — não vira alavanca", () => {
    const inds = [ind("Receita Líquida", 10_000_000), ind("Prazo Médio Contas a Receber", 52)];
    const rows = [row("Prazo Médio Contas a Receber", 50, false)];
    const r = calcularValorCanonico(inds, PERIODOS, rows, [], BASE)!;
    expect(r.alavancas.length).toBe(0);
  });

  it("sem pares ou sem receita → null (placar volta a ser 100% da IA, declarado)", () => {
    expect(calcularValorCanonico(INDS, PERIODOS, [], DRE, BASE)).toBeNull();
    expect(calcularValorCanonico([ind("Prazo Médio Contas a Receber", 57)], PERIODOS, ROWS, DRE, BASE)).toBeNull();
  });
});
