import { describe, it, expect } from "vitest";
import { classificarDeParaOrcamento, opcoesDeParaOrcamento } from "./classificar-de-para-orcamento";

/**
 * Só o caminho DETERMINÍSTICO (comIa: false) — a passada de IA é best-effort e
 * não entra em teste de unidade (sem rede). O contrato aqui: linha de gasto
 * nunca aponta para canônica de receita, e o que a regra não resolve volta
 * como pendência, nunca chutado.
 */

const CANONICAS = [
  "Receita Bruta", "Deduções da Receita Bruta", "Receitas Financeiras",
  "Custo Operacional", "Custos com Pessoas (MOD)",
  "Despesas com Pessoas", "Despesas com Viagens e Estadias", "Despesas Financeiras",
];

describe("classificarDeParaOrcamento (determinístico)", () => {
  it("opções excluem TODA canônica de receita (inclusive Deduções)", () => {
    expect(opcoesDeParaOrcamento(CANONICAS)).toEqual([
      "Custo Operacional", "Custos com Pessoas (MOD)",
      "Despesas com Pessoas", "Despesas com Viagens e Estadias", "Despesas Financeiras",
    ]);
  });

  it("'Custos sobre a receita' NUNCA cai em Receita Bruta — resolve em Custo Operacional", async () => {
    const r = await classificarDeParaOrcamento(
      [{ id: "a", nome: "Custos sobre a receita", grupo: "custo" }],
      CANONICAS,
      { comIa: false },
    );
    expect(r.classificadas.find((c) => c.id === "a")?.conta).toBe("Custo Operacional");
    expect(r.custo).toBeNull();
  });

  it("a regra resolve os óbvios sem gastar IA", async () => {
    const r = await classificarDeParaOrcamento(
      [
        { id: "v", nome: "Despesas com Viagens", grupo: "despesa" },
        { id: "t", nome: "Tarifas bancárias", grupo: "despesa" },
        { id: "z", nome: "Zebra", grupo: "despesa" },
      ],
      CANONICAS,
      { comIa: false },
    );
    expect(r.classificadas.find((c) => c.id === "v")?.conta).toBe("Despesas com Viagens e Estadias");
    expect(r.classificadas.find((c) => c.id === "t")?.conta).toBe("Despesas Financeiras");
    expect(r.classificadas.every((c) => c.via === "regra")).toBe(true);
    expect(r.semSugestao).toEqual(["Zebra"]);
  });
});
