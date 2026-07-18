import { describe, it, expect } from "vitest";
import { alertasCronologia } from "./validation";
import { pareceBalancete } from "./balancete-parser";
import { diasYTD, calculateIndicators } from "./indicator-calculator";

describe("alertasCronologia", () => {
  it("série anual contínua não gera alerta", () => {
    expect(alertasCronologia(["31/12/2023", "31/12/2024", "31/12/2025"])).toEqual([]);
  });

  it("detecta exercício faltando no meio da série anual (2023, 2024, [2025], jan/26)", () => {
    const a = alertasCronologia(["31/12/2023", "31/12/2024", "31/01/2026"]);
    const msgs = a.map((x) => x.mensagem).join(" | ");
    expect(msgs).toContain("sem o fechamento anual de 2025");
    expect(a.every((x) => x.tipo === "aviso")).toBe(true);
  });

  it("detecta ano ausente entre dois exercícios anuais", () => {
    const a = alertasCronologia(["31/12/2022", "31/12/2024"]);
    expect(a.map((x) => x.mensagem).join(" ")).toContain("Exercício de 2023 ausente");
  });

  it("detecta mês pulado na série de balancetes (jan, [fev], mar)", () => {
    const a = alertasCronologia(["31/12/2025", "31/01/2026", "31/03/2026"]);
    const msgs = a.map((x) => x.mensagem).join(" | ");
    expect(msgs).toContain("falta 02/2026");
  });

  it("balancetes contíguos com fechamento anterior não geram alerta", () => {
    expect(alertasCronologia(["31/12/2025", "31/01/2026", "28/02/2026", "31/03/2026"])).toEqual([]);
  });

  it("períodos só-ano ('2023') contam como fechamento anual; LTM é ignorado", () => {
    expect(alertasCronologia(["2023", "2024", "2026-LTM"])).toEqual([]);
    const a = alertasCronologia(["2022", "2024"]);
    expect(a.length).toBe(1);
  });
});

describe("pareceBalancete (identificação pelo conteúdo)", () => {
  const linha4 = "1.1.01.001  CAIXA GERAL   1.234,56   100,00   50,00   1.284,56";
  it("reconhece pelo título no cabeçalho", () => {
    const r = pareceBalancete("Balancete de Verificação\nPeríodo: 01/2026 a 05/2026\n" + linha4.repeat(1));
    expect(r.balancete).toBe(true);
  });

  it("reconhece pela estrutura (colunas + 10 linhas de 4 valores) sem título", () => {
    const header = "Conta  Descrição  Saldo Anterior  Débito  Crédito  Saldo Atual\n";
    const corpo = Array.from({ length: 12 }, (_, i) => `1.1.${i}  CONTA ${i}  1.000,00  10,00  5,00  1.005,00`).join("\n");
    const r = pareceBalancete(header + corpo);
    expect(r.balancete).toBe(true);
  });

  it("NÃO marca um BP comum (1-2 colunas por linha) como balancete", () => {
    const bp = "BALANÇO PATRIMONIAL\nATIVO\nAtivo Circulante  100.000,00\nCaixa  10.000,00\nPASSIVO\nFornecedores  30.000,00";
    expect(pareceBalancete(bp).balancete).toBe(false);
  });
});

describe("diasYTD (prazos médios com balancete acumulado)", () => {
  it("maio → 150 dias; dezembro → ano cheio", () => {
    expect(diasYTD("31/05/2026")).toBe(150);
    expect(diasYTD("31/01/2026")).toBe(30);
    expect(diasYTD("31/12/2025")).toBe(365);
  });

  it("período de balancete numa série mista anual+mensal usa a base YTD (não a mediana)", () => {
    const bp = [
      { conta: "Contas a Receber - CP", classificacao: "AO", valores: { "31/12/2025": 1200, "31/05/2026": 1250 } },
    ] as any;
    const dre = [
      { conta: "Receita Bruta", classificacao: "REC", valores: { "31/12/2025": 7300, "31/05/2026": 3000 } },
    ] as any;
    const periodos = ["31/12/2025", "31/05/2026"];
    const semYTD = calculateIndicators(bp, dre, periodos);
    const comYTD = calculateIndicators(bp, dre, periodos, undefined, undefined, ["31/05/2026"]);
    const pmr = (inds: any[]): number | null => {
      const i = inds.find((x) => /Prazo Médio de Recebimento/i.test(x.nome));
      const v = i?.valores?.["31/05/2026"];
      return typeof v === "number" ? v : null;
    };
    const a = pmr(semYTD), b = pmr(comYTD);
    // com YTD a base é 150 dias — o prazo tem de ser MENOR que com 365
    if (a !== null && b !== null) expect(b).toBeLessThan(a);
    // e o valor absoluto: 1250/3000 × 150 ≈ 62,5 dias
    if (b !== null) expect(b).toBeGreaterThan(50);
    if (b !== null) expect(b).toBeLessThan(75);
  });
});
