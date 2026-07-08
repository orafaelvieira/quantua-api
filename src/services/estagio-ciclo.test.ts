import { describe, it, expect } from "vitest";
import { classifyEstagio, estagioDickinsonDe, avaliarSolidez, type FluxoCaixaLite } from "./estagio-ciclo";

type Lite = { nome: string; valores: Record<string, number | string | null> };
const ind = (nome: string, valores: Record<string, number | string>): Lite => ({ nome, valores });

/* ─────────── Fixture MOVE FARMA (números reais que motivaram a mudança) ───────────
 * 2024: FCO −2,19M · FCI +56,6 mil · FCF +1,18M (receita 18,8M → FCI é RUÍDO)
 * 2025: FCO +4,0M  · FCI +24,8 mil · FCF −3,41M (receita 26,3M → FCI é RUÍDO)
 * Antes: 2024 = "Declínio" e 2025 = "Platô (shake-out)" numa empresa crescendo 39%. */
const MOVE = [
  ind("Receita Líquida", { "31/12/2023": 775891, "31/12/2024": 18847262, "31/12/2025": 26252581 }),
  ind("Margem EBITDA", { "31/12/2023": 0.10, "31/12/2024": 0.11, "31/12/2025": 0.131 }),
  ind("Liquidez Corrente", { "31/12/2024": 1.6, "31/12/2025": 1.98 }),
  ind("Liquidez Imediata", { "31/12/2024": 0.03, "31/12/2025": 0.21 }),
  ind("Situação de Liquidez (Fleuriet)", { "31/12/2024": "Sólida", "31/12/2025": "Insuficiente" }),
  ind("Termômetro de Kanitz", { "31/12/2024": 3.2, "31/12/2025": 1.9 }),
  ind("Altman Z-Score (EM)", { "31/12/2024": 2.9, "31/12/2025": 1.4 }),
] as never[];
const FC_MOVE: FluxoCaixaLite = {
  colunas: ["31/12/2024", "31/12/2025"],
  totais: {
    fco: { "31/12/2024": -2192832, "31/12/2025": 4005248 },
    fci: { "31/12/2024": 56590, "31/12/2025": 24821 },
    fcf: { "31/12/2024": 1182240, "31/12/2025": -3413365 },
  },
  prova: [{ periodo: "31/12/2024", fecha: true }, { periodo: "31/12/2025", fecha: true }],
};
const PERIODOS = ["31/12/2023", "31/12/2024", "31/12/2025"];

describe("estagio-ciclo — materialidade + persistência + solidez (2 eixos)", () => {
  it("tabela Dickinson com sinais neutros (materialidade)", () => {
    expect(estagioDickinsonDe(1, 0, -1)).toBe("Maturidade"); // gera caixa, não investe, devolve
    expect(estagioDickinsonDe(1, 1, -1)).toBe("Platô");      // desinveste DE VERDADE
    expect(estagioDickinsonDe(-1, 0, 1)).toBe(null);         // queima sem investir, captando: ambíguo
    expect(estagioDickinsonDe(0, -1, 1)).toBe(null);         // operação no zero a zero: ambíguo
  });

  it("MOVE FARMA: FCI de R$ 25 mil (0,09% da receita) NÃO vira 'desinvestimento' — nada de Platô", () => {
    const r = classifyEstagio(MOVE, PERIODOS, FC_MOVE);
    expect(r?.estagio).toBe("Maturidade"); // fco+ · fci≈0 · fcf− (2024 é ambíguo com materialidade)
    expect(r?.estagio).not.toBe("Platô");
    // justificativa em linguagem de gente, sem siglas
    expect(r?.justificativa).toContain("R$ 4,0 milhões");
    expect(r?.justificativa).not.toContain("FCO");
    expect(r?.justificativa).not.toContain("shake-out");
  });

  it("MOVE FARMA: eixo 2 anexado — solidez intermediária e DETERIORANDO", () => {
    const r = classifyEstagio(MOVE, PERIODOS, FC_MOVE);
    expect(r?.solidez?.nivel).toBe("intermediária"); // Fleuriet Insuficiente(1) + Kanitz solvente(2) + Altman cinzenta(1) = 4/6
    expect(r?.solidez?.score).toBe(4);
    expect(r?.solidez?.tendencia).toBe("deteriorando"); // 2024 era 6/6
    expect(r?.solidez?.componentes.join(" ")).toContain("Fleuriet");
  });

  it("persistência: mesmo padrão nas 2 colunas provadas → 'leitura consistente'", () => {
    const fc: FluxoCaixaLite = {
      colunas: ["2023", "2024"],
      totais: { fco: { "2023": 500, "2024": 600 }, fci: { "2023": -200, "2024": -250 }, fcf: { "2023": -150, "2024": -180 } },
      prova: [{ periodo: "2023", fecha: true }, { periodo: "2024", fecha: true }],
    };
    const inds = [
      ind("Receita Líquida", { "2022": 1000, "2023": 1050, "2024": 1080 }),
      ind("Margem EBITDA", { "2024": 0.12 }),
      ind("Liquidez Corrente", { "2024": 1.8 }),
      ind("Liquidez Imediata", { "2024": 0.4 }),
    ] as never[];
    const r = classifyEstagio(inds, ["2022", "2023", "2024"], fc);
    expect(r?.estagio).toBe("Maturidade");
    expect(r?.justificativa).toContain("consistente");
  });

  it("TRANSIÇÃO: colunas provadas com estágios DIFERENTES → tendência multi-ano decide e narra os dois anos", () => {
    const fc: FluxoCaixaLite = {
      colunas: ["2023", "2024"],
      totais: {
        fco: { "2023": 300, "2024": 500 },
        fci: { "2023": -400, "2024": 300 },  // investia; passou a desinvestir (material)
        fcf: { "2023": 350, "2024": -400 },  // captava; passou a devolver
      },
      prova: [{ periodo: "2023", fecha: true }, { periodo: "2024", fecha: true }],
    };
    const inds = [
      ind("Receita Líquida", { "2022": 1000, "2023": 1400, "2024": 1900 }), // +36% no último ano
      ind("Margem EBITDA", { "2024": 0.14 }),
      ind("Liquidez Corrente", { "2024": 1.6 }),
      ind("Liquidez Imediata", { "2024": 0.3 }),
    ] as never[];
    const r = classifyEstagio(inds, ["2022", "2023", "2024"], fc);
    expect(r?.estagio).toBe("Crescimento"); // receita +36% com margem positiva manda
    expect(r?.justificativa).toContain("transição");
    expect(r?.justificativa.toLowerCase()).toContain("crescimento"); // narra os dois padrões
  });

  it("solvência COLAPSADA + caixa mínimo = Crise de caixa mesmo com margem positiva", () => {
    const inds = [
      ind("Receita Líquida", { "2023": 1000, "2024": 1020 }),
      ind("Margem EBITDA", { "2024": 0.05 }), // positiva — a regra antiga NÃO dispararia
      ind("Liquidez Corrente", { "2024": 1.1 }),
      ind("Liquidez Imediata", { "2024": 0.02 }), // caixa no mínimo
      ind("Situação de Liquidez (Fleuriet)", { "2024": "Alto Risco" }),
      ind("Termômetro de Kanitz", { "2024": -4.2 }),
      ind("Altman Z-Score (EM)", { "2024": 0.6 }),
    ] as never[];
    const r = classifyEstagio(inds, ["2023", "2024"], null);
    expect(r?.estagio).toBe("Crise de caixa");
    expect(r?.justificativa).toContain("solvência");
  });

  it("avaliarSolidez: componentes faltando → pontua só o disponível; sem nenhum → null", () => {
    const so = avaliarSolidez([ind("Termômetro de Kanitz", { "2024": 2.0 })] as never[], ["2023", "2024"]);
    expect(so?.max).toBe(2);
    expect(so?.nivel).toBe("sólida"); // 2/2
    expect(avaliarSolidez([ind("Receita Líquida", { "2024": 10 })] as never[], ["2024"])).toBeNull();
  });
});
