import { describe, it, expect } from "vitest";
import { derivarRealizadoMensal, type LeituraParaRealizado } from "./realizado-balancete";
import type { LinhaBalancete } from "./balancete-parser";

const linha = (p: Partial<LinhaBalancete>): LinhaBalancete => ({
  classificacao: "", nivel: 1, nome: "", saldoAnterior: 0, debito: 0, credito: 0, saldoAtual: 0, ...p,
});

/** Balancete de MAIO da Belagro em miniatura: saldo de conta de resultado é
 *  YTD — o mensal sai do próprio doc (atual − anterior, assinados). */
const doc = (id: string, ini: string, fim: string, linhas: LinhaBalancete[]): LeituraParaRealizado =>
  ({ documentId: id, nome: id, periodoInicio: ini, periodoFim: fim, linhas });

describe("realizado do balancete (F2 — mensal por conta, critério YTD)", () => {
  it("mensal = YTD atual − YTD anterior, dentro do próprio documento", () => {
    const fev = doc("fev", "01/02/2026", "28/02/2026", [
      linha({ classificacao: "3", nome: "RECEITAS", saldoAnterior: 1_000, naturezaAnterior: "C", saldoAtual: 2_500, naturezaAtual: "C" }),
      linha({ classificacao: "3.1.01.001", nome: "Receita de Vendas", saldoAnterior: 1_000, naturezaAnterior: "C", saldoAtual: 2_500, naturezaAtual: "C" }),
      linha({ classificacao: "4.1.01.001", nome: "Despesas Gerais", saldoAnterior: 400, naturezaAnterior: "D", saldoAtual: 900, naturezaAtual: "D" }),
    ]);
    const r = derivarRealizadoMensal([fev]);
    expect(r.meses).toEqual(["2026-02"]);
    const rec = r.contas.find((c) => c.codigo === "3.1.01.001")!;
    expect(rec.natureza).toBe("receita");
    expect(rec.meses["2026-02"]).toBe(1_500);
    const desp = r.contas.find((c) => c.codigo === "4.1.01.001")!;
    expect(desp.natureza).toBe("gasto");
    expect(desp.meses["2026-02"]).toBe(500);
    // O grupo "3" (sintético por ter filho) NÃO vira conta — sem dupla contagem.
    expect(r.contas.some((c) => c.codigo === "3")).toBe(false);
  });

  it("conta REDUTORA na família (devolução devedora em receita) sai negativa", () => {
    const jan = doc("jan", "01/01/2026", "31/01/2026", [
      linha({ classificacao: "03.1.2.01.001", nome: "(-) Devoluções ME", saldoAnterior: 0, saldoAtual: 200, naturezaAtual: "D" }),
    ]);
    const r = derivarRealizadoMensal([jan]);
    expect(r.contas[0]!.meses["2026-01"]).toBe(-200);
  });

  it("acumulado multi-mês NÃO vira mensal — ignorado com motivo declarado", () => {
    const acum = doc("acum-2025", "01/01/2025", "30/09/2025", [
      linha({ classificacao: "3.1.01.001", nome: "Receita", saldoAtual: 9_000, naturezaAtual: "C" }),
    ]);
    const r = derivarRealizadoMensal([acum]);
    expect(r.contas).toEqual([]);
    expect(r.ignorados[0]!.motivo).toMatch(/acumulado|mais de um mês/);
  });

  it("patrimoniais (raízes 1 e 2) ficam fora — realizado da DRE é só resultado", () => {
    const jan = doc("jan", "01/01/2026", "31/01/2026", [
      linha({ classificacao: "1.1.01.001", nome: "Caixa", saldoAnterior: 0, saldoAtual: 5_000, naturezaAtual: "D" }),
      linha({ classificacao: "3.1.01.001", nome: "Receita", saldoAnterior: 0, saldoAtual: 1_000, naturezaAtual: "C" }),
    ]);
    const r = derivarRealizadoMensal([jan]);
    expect(r.contas.map((c) => c.codigo)).toEqual(["3.1.01.001"]);
  });
});
