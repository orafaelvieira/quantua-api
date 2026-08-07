import { describe, it, expect } from "vitest";
import { lerBalanceteDeterministico, resumoDaLeitura } from "./leitura-porta";

/** Balancete tabular mínimo e FECHADO (Ativo = Passivo + resultado):
 *  caixa 1.000 devedora · capital 400 credora · receita 1.000 credora ·
 *  despesa 400 devedora → resultado 600; Ativo 1.000 = Passivo 400 + 600. */
const CSV = [
  "Balancete de Verificação;;;;;",
  "Período: 01/01/2026 a 31/01/2026;;;;;",
  "Classificação;Nome da conta contábil;Saldo anterior;Débito;Crédito;Saldo atual",
  "1;ATIVO;0,00;1.400,00;400,00;1.000,00 D",
  "1.1;CIRCULANTE;0,00;1.400,00;400,00;1.000,00 D",
  "1.1.01.001;Caixa Geral;0,00;1.400,00;400,00;1.000,00 D",
  "2;PASSIVO;0,00;0,00;400,00;400,00 C",
  "2.1.01.001;Capital Social;0,00;0,00;400,00;400,00 C",
  "3;RECEITAS;0,00;0,00;1.000,00;1.000,00 C",
  "3.1.01.001;Receita de Vendas;0,00;0,00;1.000,00;1.000,00 C",
  "4;DESPESAS;0,00;400,00;0,00;400,00 D",
  "4.1.01.001;Despesas Gerais;0,00;400,00;0,00;400,00 D",
].join("\n");

describe("leitura na porta (F1 — determinística, sem IA)", () => {
  it("lê balancete tabular: linhas no plano do cliente + período + provas", async () => {
    const r = await lerBalanceteDeterministico(Buffer.from(CSV, "utf-8"), "balancete-jan.csv", "2026-01");
    expect(r.erro).toBeUndefined();
    expect(r.origem).toBe("tabular");
    expect(r.totalContas).toBeGreaterThanOrEqual(4);
    const caixa = r.linhas.find((l) => /caixa/i.test(l.nome));
    expect(caixa).toBeTruthy();
    expect(r.provas?.fechamento.ok).toBe(true);
    const resumo = resumoDaLeitura(r);
    expect(resumo.ok).toBe(true);
    expect(resumo.fechamentoOk).toBe(true);
  });

  it("arquivo que não é balancete devolve ERRO declarado, nunca exceção", async () => {
    const r = await lerBalanceteDeterministico(Buffer.from("relatório qualquer\nsem colunas", "utf-8"), "notas.txt");
    expect(r.erro).toBeTruthy();
    expect(r.linhas).toEqual([]);
    expect(resumoDaLeitura(r).ok).toBe(false);
  });
});
