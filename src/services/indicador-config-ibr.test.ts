import { vi, describe, it, expect } from "vitest";

// Mocks: prisma (setor + catálogo global) e a base de pares CVM — o teste valida a
// LÓGICA determinística (quartis → semáforo; sanitização), não o banco.
vi.mock("../db/client", () => ({
  prisma: {
    indicatorConfig: { findMany: vi.fn().mockResolvedValue([]) },
    sector: {
      findUnique: vi.fn().mockResolvedValue({
        code: "saude", name: "Comércio e Distribuição", parentCode: "consumo",
        parent: { name: "Consumo não Cíclico" },
      }),
    },
  },
}));
vi.mock("./peer-benchmark-cvm", () => ({
  CVM_COMPARAVEIS: { "Margem EBITDA": true, "Liquidez Corrente": true, "Ciclo Financeiro": true },
  comparePeersCvm: vi.fn().mockResolvedValue({
    periodo: "LTM 2025T4", dtFim: "2025-12-31",
    rows: [
      // maior é melhor: atenção < mediana (p50), crítico < p25
      { indicador: "Margem EBITDA", valor: 0.08, p25: 0.05, p50: 0.11, p75: 0.18, percentil: 40, level: "setor", segment: "Comércio e Distribuição", count: 14, higherIsBetter: true },
      // menor é melhor: atenção > mediana, crítico > p75
      { indicador: "Ciclo Financeiro", valor: 95, p25: 30, p50: 55, p75: 80, percentil: 70, level: "setor", segment: "Comércio e Distribuição", count: 14, higherIsBetter: false },
      // nível "mercado" = ruído — deve ser IGNORADO
      { indicador: "Liquidez Corrente", valor: 1.2, p25: 0.9, p50: 1.4, p75: 2.0, percentil: 45, level: "mercado", segment: "Mercado", count: 900, higherIsBetter: true },
    ],
  }),
}));

import { calibrarSemaforoComPares, sanitizeRowsIBR, catalogoPadraoEfetivo, type IBRConfigRow } from "./indicador-config-ibr";

const rowDe = (rows: IBRConfigRow[], nome: string) => rows.find((r) => r.nome === nome)!;

describe("indicador-config-ibr", () => {
  it("calibra o semáforo pelos QUARTIS dos pares respeitando a polaridade", async () => {
    const rows = await catalogoPadraoEfetivo();
    const indicadores = [
      { nome: "Margem EBITDA", valores: { "31/12/2025": 0.08 } },
      { nome: "Ciclo Financeiro", valores: { "31/12/2025": 95 } },
      { nome: "Liquidez Corrente", valores: { "31/12/2025": 1.2 } },
    ];
    const pares = await calibrarSemaforoComPares(rows, "saude", indicadores, ["31/12/2025"]);

    // maior é melhor → menor_ruim: crítico=p25, atenção=p50 (mediana)
    const mg = rowDe(rows, "Margem EBITDA");
    expect(mg.semDirecao).toBe("menor_ruim");
    expect(mg.semCritico).toBeCloseTo(0.05, 4);
    expect(mg.semAtencao).toBeCloseTo(0.11, 4);
    expect(mg.origemSemaforo).toContain("pares");
    expect(mg.origemSemaforo).toContain("n=14");

    // menor é melhor → maior_ruim: crítico=p75, atenção=p50
    const cf = rowDe(rows, "Ciclo Financeiro");
    expect(cf.semDirecao).toBe("maior_ruim");
    expect(cf.semCritico).toBeCloseTo(80, 4);
    expect(cf.semAtencao).toBeCloseTo(55, 4);

    // nível "mercado" descartado → Liquidez Corrente permanece no padrão
    const lc = rowDe(rows, "Liquidez Corrente");
    expect(lc.origemSemaforo).toBe("padrão");
    expect(lc.semCritico).toBe(1.0); // default do motor intacto

    expect(pares?.calibrados).toBe(2);
    expect(pares?.segmento).toBe("Comércio e Distribuição");
  });

  it("sem setor ou sem indicadores → não calibra (best-effort, padrão intacto)", async () => {
    const rows = await catalogoPadraoEfetivo();
    expect(await calibrarSemaforoComPares(rows, null, [{ nome: "Margem EBITDA", valores: {} }], ["2025"])).toBeNull();
    expect(await calibrarSemaforoComPares(rows, "saude", [], ["2025"])).toBeNull();
    expect(rows.every((r) => r.origemSemaforo === "padrão")).toBe(true);
  });

  it("sanitizeRowsIBR: sistema é INDELÉVEL e só aceita semáforo/exibição; personalizado validado", async () => {
    const padrao = await catalogoPadraoEfetivo();
    const rows = sanitizeRowsIBR(
      [
        // tentativa de adulterar um sistema (nome/grupo ficam do template; semáforo entra)
        { nome: "Liquidez Corrente", sistema: true, grupo: "HACK", tipoDado: "R$", ativo: false, semDirecao: "menor_ruim", semCritico: 0.9, semAtencao: 1.3 },
        // personalizado válido
        { nome: "Aluguel / Receita", grupo: "Personalizados", tipoDado: "%", numerador: [{ origem: "DRE", conta: "Despesas Administrativas", sinal: -1 }], denominador: [{ origem: "DRE", conta: "Receita Líquida" }] },
        // personalizado tentando COLIDIR com nome de sistema → descartado
        { nome: "Margem EBITDA", sistema: false, numerador: [] },
      ],
      padrao,
    );
    const lc = rowDe(rows, "Liquidez Corrente");
    expect(lc.grupo).not.toBe("HACK");
    expect(lc.ativo).toBe(false);              // ocultar é permitido
    expect(lc.semCritico).toBe(0.9);           // semáforo editado entra
    expect(rows.filter((r) => r.nome === "Margem EBITDA").length).toBe(1); // sem clone custom
    expect(rowDe(rows, "Aluguel / Receita").sistema).toBe(false);
    // TODOS os sistemas do padrão continuam presentes (payload omitindo não remove)
    expect(padrao.filter((p) => p.sistema).every((p) => rows.some((r) => r.nome === p.nome))).toBe(true);
  });
});
