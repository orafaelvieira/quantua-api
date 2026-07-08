import { vi, describe, it, expect } from "vitest";

// Base sintética: dois subsetores com "formatos" opostos — distribuição (margem fina,
// giro alto) × software (margem gorda, sem estoque). A empresa-teste tem cara de
// distribuidora; o classificador deve ranquear Comércio na frente com aderência forte.
const { linhas } = vi.hoisted(() => {
  const cia = (setor: string, n: number) => Array.from({ length: n }, (_, i) => `${setor}-${i}`);
  const DIST = cia("dist", 8), SOFT = cia("soft", 8);
  const linhas: Array<{ nome: string; valor: number; company: { setor: string; cnpj: string } }> = [];
  const espalha = (setor: string, cnpjs: string[], nome: string, centro: number, passo: number) => {
    cnpjs.forEach((c, i) => linhas.push({ nome, valor: centro + (i - cnpjs.length / 2) * passo, company: { setor, cnpj: c } }));
  };
  // Comércio e Distribuição: margem 8%±, giro 3±, liquidez 1,5±
  espalha("Comércio e Distribuição", DIST, "Margem EBITDA", 0.08, 0.01);
  espalha("Comércio e Distribuição", DIST, "Giro do Ativo", 3.0, 0.3);
  espalha("Comércio e Distribuição", DIST, "Liquidez Corrente", 1.5, 0.15);
  espalha("Comércio e Distribuição", DIST, "Margem Bruta", 0.28, 0.03);
  espalha("Comércio e Distribuição", DIST, "Ciclo Financeiro", 55, 6);
  // Software: margem 30%±, giro 0,8±, liquidez 2,5±
  espalha("Software", SOFT, "Margem EBITDA", 0.30, 0.03);
  espalha("Software", SOFT, "Giro do Ativo", 0.8, 0.1);
  espalha("Software", SOFT, "Liquidez Corrente", 2.5, 0.3);
  espalha("Software", SOFT, "Margem Bruta", 0.70, 0.05);
  espalha("Software", SOFT, "Ciclo Financeiro", 10, 4);
  return { linhas };
});

vi.mock("../db/client", () => ({
  prisma: {
    cvmIndicator: { findMany: vi.fn().mockResolvedValue(linhas) },
    sector: { findMany: vi.fn().mockResolvedValue([
      { code: "comercio-distribuicao", name: "Comércio e Distribuição" },
      { code: "software", name: "Software" },
    ]) },
  },
}));
vi.mock("./peer-benchmark-cvm", () => ({
  CVM_COMPARAVEIS: { "Margem EBITDA": true, "Giro do Ativo": true, "Liquidez Corrente": true, "Margem Bruta": true, "Ciclo Financeiro": false },
  ultimoPeriodoCvm: vi.fn().mockResolvedValue("2025-12-31"),
}));

import { classificarSetor } from "./setor-classificador";

const IND = (vals: Record<string, number>) =>
  Object.entries(vals).map(([nome, v]) => ({ nome, valores: { "31/12/2025": v } }));

describe("setor-classificador — aderência estatística (zero IA)", () => {
  it("empresa com cara de distribuidora → recomenda Comércio e Distribuição com evidência", async () => {
    const proposta = await classificarSetor(
      IND({ "Margem EBITDA": 0.09, "Giro do Ativo": 3.2, "Liquidez Corrente": 1.6, "Margem Bruta": 0.27, "Ciclo Financeiro": 58 }),
      ["31/12/2024", "31/12/2025"],
    );
    expect(proposta?.recomendado?.setor).toBe("Comércio e Distribuição");
    expect(proposta?.recomendado?.sectorCode).toBe("comercio-distribuicao");
    expect(proposta!.recomendado!.dentro / proposta!.recomendado!.total).toBeGreaterThanOrEqual(0.5);
    // Software fica atrás (números não encaixam na distribuição dele)
    const soft = proposta!.ranking.find((r) => r.setor === "Software")!;
    expect(soft.dentro / soft.total).toBeLessThan(proposta!.recomendado!.dentro / proposta!.recomendado!.total);
    expect(proposta?.periodo).toBe("4T25 (LTM)");
  });

  it("empresa ATÍPICA (não encaixa em nada) → sem recomendação (nunca finge certeza)", async () => {
    const proposta = await classificarSetor(
      IND({ "Margem EBITDA": -0.9, "Giro do Ativo": 40, "Liquidez Corrente": 30, "Margem Bruta": 0.99, "Ciclo Financeiro": 900 }),
      ["31/12/2025", "31/12/2024"],
    );
    expect(proposta?.recomendado ?? null).toBeNull();
    expect((proposta?.ranking.length ?? 0)).toBeGreaterThan(0); // ranking existe, só não é forte
  });

  it("sem indicadores → null (roda só quando há números)", async () => {
    expect(await classificarSetor([], ["2025"])).toBeNull();
  });
});
