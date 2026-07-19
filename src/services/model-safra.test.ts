import { describe, it, expect } from "vitest";
import {
  rotuloSafra,
  inicioSafraDe,
  periodosDoHorizonte,
  janelaMovel,
  agregarSerie,
  agregarPorPeriodo,
  recorteJanelaMovel,
  naturezaDaLinha,
} from "./model-safra";
import { LinhaDre, Serie, mesAdd } from "./model-engine";

function meses(de: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => mesAdd(de, i));
}

function serie(ms: string[], valor: number | ((m: string, i: number) => number)): Serie {
  return Object.fromEntries(ms.map((m, i) => [m, typeof valor === "function" ? valor(m, i) : valor]));
}

function linha(id: string, nome: string, grupo: LinhaDre["grupo"], valores: Serie, pctReceita: Serie = {}): LinhaDre {
  return { id, nome, grupo, valores, pctReceita };
}

// ── Rótulos de safra ───────────────────────────────────────────────────────

describe("rótulo de safra", () => {
  it("safra de julho: jul/2025 a jun/2026 é 2025/26", () => {
    expect(rotuloSafra("2025-07", 7)).toBe("2025/26");
    expect(rotuloSafra("2025-12", 7)).toBe("2025/26");
    expect(rotuloSafra("2026-01", 7)).toBe("2025/26");
    expect(rotuloSafra("2026-06", 7)).toBe("2025/26");
  });

  it("o mês seguinte ao fim da safra abre a safra nova", () => {
    expect(rotuloSafra("2026-07", 7)).toBe("2026/27");
  });

  it("meses antes da virada pertencem à safra anterior", () => {
    expect(rotuloSafra("2025-06", 7)).toBe("2024/25");
  });

  it("início em janeiro degenera no ano contábil", () => {
    expect(rotuloSafra("2026-03", 1)).toBe("2026");
    expect(rotuloSafra("2026-12", 1)).toBe("2026");
  });

  it("primeiro mês da safra que contém o mês", () => {
    expect(inicioSafraDe("2026-01", 7)).toBe("2025-07");
    expect(inicioSafraDe("2025-08", 7)).toBe("2025-07");
    expect(inicioSafraDe("2026-03", 1)).toBe("2026-01");
  });
});

// ── Partição do horizonte ──────────────────────────────────────────────────

describe("períodos do horizonte", () => {
  it("parte o horizonte em safras completas", () => {
    const ps = periodosDoHorizonte(meses("2025-07", 24), { mesInicioSafra: 7 });
    expect(ps.map((p) => p.rotulo)).toEqual(["2025/26", "2026/27"]);
    expect(ps.every((p) => !p.parcial)).toBe(true);
    expect(ps[0]!.janela).toEqual({ de: "2025-07", ate: "2026-06" });
  });

  it("marca como parcial o período que o horizonte não cobre inteiro", () => {
    // Começa em outubro: a safra 2025/26 só tem 9 dos 12 meses.
    const ps = periodosDoHorizonte(meses("2025-10", 9), { mesInicioSafra: 7 });
    expect(ps[0]!.rotulo).toBe("2025/26");
    expect(ps[0]!.parcial).toBe(true);
    expect(ps[0]!.meses).toHaveLength(9);
  });

  it("ano contábil parte em anos-calendário", () => {
    const ps = periodosDoHorizonte(meses("2026-01", 24), { mesInicioSafra: 1 });
    expect(ps.map((p) => p.rotulo)).toEqual(["2026", "2027"]);
  });

  it("horizonte vazio devolve nenhum período", () => {
    expect(periodosDoHorizonte([], { mesInicioSafra: 7 })).toEqual([]);
  });
});

// ── Regra de agregação ─────────────────────────────────────────────────────

describe("agregação por natureza", () => {
  const ms = meses("2026-01", 12);

  it("fluxo soma os meses", () => {
    const l = linha("r", "(+) Receita Bruta", "receita", serie(ms, 100));
    expect(agregarSerie(l, ms, "fluxo")).toBe(1_200);
  });

  it("saldo pega o ÚLTIMO mês, não a soma", () => {
    // Estoque crescente: 100, 200, … 1200. O saldo do ano é 1200, não 7800.
    const l = linha("caixa", "Caixa e equivalentes", "subtotal", serie(ms, (_m, i) => (i + 1) * 100));
    expect(agregarSerie(l, ms, "saldo")).toBe(1_200);
  });

  it("saldo ignora meses ausentes e usa o último presente", () => {
    const l = linha("caixa", "Caixa", "subtotal", { "2026-01": 50, "2026-02": 80 });
    expect(agregarSerie(l, ms, "saldo")).toBe(80);
  });

  it("taxa recalcula sobre os agregados, não é média das margens", () => {
    // Mês 1: margem 10 sobre 100 (10%). Mês 2: margem 90 sobre 300 (30%).
    // Média simples das margens = 20%. Correto = 100 ÷ 400 = 25%.
    const l = linha(
      "mb",
      "Margem Bruta (%)",
      "subtotal",
      { "2026-01": 10, "2026-02": 90 },
      { "2026-01": 0.1, "2026-02": 0.3 }
    );
    expect(agregarSerie(l, ["2026-01", "2026-02"], "taxa")).toBeCloseTo(0.25, 10);
  });

  it("período vazio devolve zero em qualquer natureza", () => {
    const l = linha("r", "Receita", "receita", serie(ms, 100));
    expect(agregarSerie(l, [], "fluxo")).toBe(0);
    expect(agregarSerie(l, [], "saldo")).toBe(0);
    expect(agregarSerie(l, [], "taxa")).toBe(0);
  });
});

describe("naturezaDaLinha", () => {
  it("margem é taxa", () => {
    expect(naturezaDaLinha(linha("m", "Margem Ebitda (%)", "subtotal", {}))).toBe("taxa");
  });
  it("linha de balanço é saldo", () => {
    expect(naturezaDaLinha(linha("c", "Caixa e equivalentes", "subtotal", {}), "bp")).toBe("saldo");
  });
  it("linha de DRE é fluxo", () => {
    expect(naturezaDaLinha(linha("r", "(+) Receita Bruta", "receita", {}), "dre")).toBe("fluxo");
  });
  it("margem dentro do BP continua sendo taxa", () => {
    expect(naturezaDaLinha(linha("m", "Margem (%)", "subtotal", {}), "bp")).toBe("taxa");
  });
});

// ── Recortes completos ─────────────────────────────────────────────────────

describe("agregarPorPeriodo", () => {
  it("agrega DRE por safra", () => {
    const ms = meses("2025-07", 24);
    const r = agregarPorPeriodo([linha("r", "(+) Receita Bruta", "receita", serie(ms, 100))], ms, {
      mesInicioSafra: 7,
      origem: "dre",
    });
    expect(r.periodos.map((p) => p.rotulo)).toEqual(["2025/26", "2026/27"]);
    expect(r.linhas[0]!.porPeriodo["2025/26"]).toBe(1_200);
    expect(r.avisos).toEqual([]);
  });

  it("avisa quando o período fica incompleto", () => {
    const ms = meses("2025-10", 9);
    const r = agregarPorPeriodo([linha("r", "Receita", "receita", serie(ms, 100))], ms, { mesInicioSafra: 7 });
    expect(r.avisos.join(" ")).toMatch(/incompleto/i);
  });

  it("BP agrega por saldo do último mês da safra", () => {
    const ms = meses("2025-07", 12);
    const r = agregarPorPeriodo(
      [linha("caixa", "Caixa e equivalentes", "subtotal", serie(ms, (_m, i) => (i + 1) * 10))],
      ms,
      { mesInicioSafra: 7, origem: "bp" }
    );
    expect(r.linhas[0]!.natureza).toBe("saldo");
    expect(r.linhas[0]!.porPeriodo["2025/26"]).toBe(120);
  });
});

describe("janela móvel", () => {
  it("12 meses a partir do mês escolhido", () => {
    expect(janelaMovel("2025-06")).toEqual({ de: "2025-06", ate: "2026-05" });
  });

  it("tamanho configurável", () => {
    expect(janelaMovel("2026-01", 3)).toEqual({ de: "2026-01", ate: "2026-03" });
  });

  it("recorte devolve os meses e o total do período", () => {
    const ms = meses("2025-01", 24);
    const r = recorteJanelaMovel([linha("r", "(+) Receita Bruta", "receita", serie(ms, 100))], "2025-06", {
      mesesDisponiveis: ms,
    });
    expect(r.meses).toHaveLength(12);
    expect(r.meses[0]).toBe("2025-06");
    expect(r.linhas[0]!.total).toBe(1_200);
    expect(r.avisos).toEqual([]);
  });

  it("avisa quando a janela sai do horizonte em vez de somar zeros mudos", () => {
    const ms = meses("2025-01", 12);
    const r = recorteJanelaMovel([linha("r", "Receita", "receita", serie(ms, 100))], "2025-06", {
      mesesDisponiveis: ms,
    });
    expect(r.avisos.join(" ")).toMatch(/fora do horizonte/i);
    // Os meses ausentes entram como zero, e o total reflete só o que existe.
    expect(r.linhas[0]!.total).toBe(700);
  });
});
