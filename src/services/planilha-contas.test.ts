import { describe, it, expect } from "vitest";
import { lerPlanilhaDeContas, lerMes, numeroPlanilha } from "./planilha-contas";

describe("lerMes", () => {
  it("aceita os formatos que aparecem em planilha de orçamento", () => {
    expect(lerMes("jan")).toEqual({ mes: 1 });
    expect(lerMes("Jan/26")).toEqual({ mes: 1, ano: 2026 });
    expect(lerMes("fev-2027")).toEqual({ mes: 2, ano: 2027 });
    expect(lerMes("Março")).toEqual({ mes: 3 });
    expect(lerMes("dezembro de 2026")).toEqual({ mes: 12, ano: 2026 });
    expect(lerMes("2026-04")).toEqual({ mes: 4, ano: 2026 });
    expect(lerMes("05/2026")).toEqual({ mes: 5, ano: 2026 });
    expect(lerMes(new Date(2026, 6, 1))).toEqual({ mes: 7, ano: 2026 });
    expect(lerMes("2026-08-01T00:00:00.000Z")).toEqual({ mes: 8, ano: 2026 });
  });

  it("não confunde texto comum nem número com mês", () => {
    expect(lerMes("Conta")).toBeNull();
    expect(lerMes("Total")).toBeNull();
    expect(lerMes("12")).toBeNull();       // valor, não dezembro
    expect(lerMes("1.234,56")).toBeNull();
    expect(lerMes("2026-13")).toBeNull();
    expect(lerMes("")).toBeNull();
    expect(lerMes("janta")).toBeNull();    // começa com "jan" mas não é mês
  });
});

describe("numeroPlanilha", () => {
  it("lê o número como o brasileiro escreve", () => {
    expect(numeroPlanilha("1.234,56")).toBeCloseTo(1234.56, 6);
    expect(numeroPlanilha("R$ 15.000,00")).toBeCloseTo(15000, 6);
    expect(numeroPlanilha("15000")).toBe(15000);
    expect(numeroPlanilha(15000)).toBe(15000);
    expect(numeroPlanilha("1,5")).toBeCloseTo(1.5, 6);
  });

  it("entende o formato americano e o negativo entre parênteses", () => {
    expect(numeroPlanilha("1,234.56")).toBeCloseTo(1234.56, 6);
    expect(numeroPlanilha("(1.234,00)")).toBeCloseTo(-1234, 6);
    expect(numeroPlanilha("500-")).toBe(-500);
  });

  it("texto que não é número vira zero (célula vazia, traço, N/A)", () => {
    expect(numeroPlanilha("")).toBe(0);
    expect(numeroPlanilha("—")).toBe(0);
    expect(numeroPlanilha("n/a")).toBe(0);
    expect(numeroPlanilha(null)).toBe(0);
  });
});

describe("lerPlanilhaDeContas — plano de contas simples", () => {
  const matriz: unknown[][] = [
    ["Código", "Conta", "Centro de custo", "Tipo", "Conta canônica"],
    ["4.1.01", "Salários", "Comercial", "despesa", "Despesas com Pessoas"],
    ["3.1.01", "Matéria-prima", "Produção", "custo", ""],
  ];

  it("lê as colunas de estrutura e não inventa meses", () => {
    const r = lerPlanilhaDeContas(matriz, "2026");
    expect(r.semColunaConta).toBe(false);
    expect(r.meses).toEqual([]);
    expect(r.contas).toHaveLength(2);
    expect(r.contas[0]).toMatchObject({ codigo: "4.1.01", nome: "Salários", centroCusto: "Comercial", tipo: "despesa", destino: "Despesas com Pessoas" });
    expect(r.contas[0]!.valores).toEqual({});
  });
});

describe("lerPlanilhaDeContas — ORÇAMENTO pronto (o caso que falhava)", () => {
  // Planilha de verdade: título, linha em branco, cabeçalho na 3ª linha,
  // meses em colunas, número em formato BR, subtotal sem nome no fim.
  const matriz: unknown[][] = [
    ["Orçamento 2026 — Móve Farma", null, null, null, null],
    [],
    ["Conta", "Centro de custo", "jan/26", "fev/26", "mar/26"],
    ["Aluguel", "Administrativo", "5.000,00", "5.000,00", "5.200,00"],
    ["Energia elétrica", "Administrativo", "R$ 1.200,00", "1.180,00", ""],
    [null, null, "6.200,00", "6.180,00", "5.200,00"],
  ];

  it("acha o cabeçalho fora da primeira linha e traz os valores", () => {
    const r = lerPlanilhaDeContas(matriz, "2026");
    expect(r.linhaCabecalho).toBe(3);
    expect(r.meses).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(r.contas.map((c) => c.nome)).toEqual(["Aluguel", "Energia elétrica"]); // linha de fechamento sem nome sai
    expect(r.contas[0]!.valores).toEqual({ "2026-01": 5000, "2026-02": 5000, "2026-03": 5200 });
    expect(r.contas[1]!.valores).toEqual({ "2026-01": 1200, "2026-02": 1180 }); // mês vazio não entra
    expect(r.contas[0]!.centroCusto).toBe("Administrativo");
  });

  it("mês sem ano no rótulo assume o exercício do modelo", () => {
    const semAno: unknown[][] = [["Conta", "jan", "fev", "mar"], ["Aluguel", 100, 200, 300]];
    const r = lerPlanilhaDeContas(semAno, "2027");
    expect(r.meses).toEqual(["2027-01", "2027-02", "2027-03"]);
    expect(r.contas[0]!.valores).toEqual({ "2027-01": 100, "2027-02": 200, "2027-03": 300 });
  });

  it("reconhece o cabeçalho só pelos meses quando a coluna chama 'Descrição'", () => {
    const m: unknown[][] = [
      ["Descrição", "jan/26", "fev/26", "mar/26"],
      ["Viagens", 1000, 1000, 1000],
    ];
    const r = lerPlanilhaDeContas(m, "2026");
    expect(r.semColunaConta).toBe(false);
    expect(r.contas[0]!.nome).toBe("Viagens");
  });
});

describe("linhas de TOTAL não viram conta", () => {
  it("descarta Total/Subtotal e devolve a lista do que saiu", () => {
    const m: unknown[][] = [
      ["Conta", "jan/26", "fev/26", "mar/26"],
      ["Aluguel", 1000, 1000, 1000],
      ["Subtotal Administrativo", 1000, 1000, 1000],
      ["Viagens", 500, 500, 500],
      ["TOTAL", 1500, 1500, 1500],
      ["Total geral", 1500, 1500, 1500],
    ];
    const r = lerPlanilhaDeContas(m, "2026");
    expect(r.contas.map((c) => c.nome)).toEqual(["Aluguel", "Viagens"]);
    expect(r.totaisIgnorados).toEqual(["Subtotal Administrativo", "TOTAL", "Total geral"]);
  });

  it("não confunde conta legítima que só CONTÉM a palavra total", () => {
    const m: unknown[][] = [["Conta"], ["Manutenção total da frota"], ["Totalizadores fiscais"]];
    const r = lerPlanilhaDeContas(m, "2026");
    expect(r.contas.map((c) => c.nome)).toEqual(["Manutenção total da frota", "Totalizadores fiscais"]);
    expect(r.totaisIgnorados).toEqual([]);
  });
});

describe("lerPlanilhaDeContas — quando não dá para ler", () => {
  it("sem coluna de conta: devolve o cabeçalho lido em vez de só falhar", () => {
    const m: unknown[][] = [["Produto", "Preço", "Qtd"], ["Adubo", 100, 5]];
    const r = lerPlanilhaDeContas(m, "2026");
    expect(r.semColunaConta).toBe(true);
    expect(r.cabecalho).toEqual(["Produto", "Preço", "Qtd"]);
    expect(r.linhaCabecalho).toBe(1);
    expect(r.contas).toEqual([]);
  });

  it("planilha vazia não quebra", () => {
    const r = lerPlanilhaDeContas([], "2026");
    expect(r.semColunaConta).toBe(true);
    expect(r.contas).toEqual([]);
  });
});
