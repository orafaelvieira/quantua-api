import { describe, it, expect } from "vitest";
import { resolverCascataDicionario, prioridadeEscopo, whereCascataDicionario } from "./dicionario-escopo";

const global_ = (nome: string, destino: string, grupo = "Ativo Circulante") =>
  ({ nomeOriginal: nome, contaDestino: destino, grupoConta: grupo, tipo: "BP", userId: null, companyId: null });
const workspace = (nome: string, destino: string, grupo = "Ativo Circulante") =>
  ({ nomeOriginal: nome, contaDestino: destino, grupoConta: grupo, tipo: "BP", userId: "u1", companyId: null });
const empresa = (nome: string, destino: string, grupo = "Ativo Circulante", companyId = "c1") =>
  ({ nomeOriginal: nome, contaDestino: destino, grupoConta: grupo, tipo: "BP", userId: "u1", companyId });

describe("prioridadeEscopo", () => {
  it("global < workspace < empresa", () => {
    expect(prioridadeEscopo(global_("x", "y"))).toBe(0);
    expect(prioridadeEscopo(workspace("x", "y"))).toBe(1);
    expect(prioridadeEscopo(empresa("x", "y"))).toBe(2);
  });
});

describe("resolverCascataDicionario", () => {
  it("entrada de EMPRESA vence workspace e global para a mesma conta", () => {
    const r = resolverCascataDicionario([
      global_("Bancos", "Caixa e Equivalentes de Caixa"),
      workspace("Bancos", "Aplicações Financeiras - LP"),
      empresa("Bancos", "Contas a Receber - CP"),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].contaDestino).toBe("Contas a Receber - CP");
  });

  it("workspace vence global; ordem de chegada não importa", () => {
    const r = resolverCascataDicionario([
      workspace("Bancos", "B"),
      global_("Bancos", "A"),
    ]);
    expect(r[0].contaDestino).toBe("B");
  });

  it("contas de grupos diferentes NÃO colidem (chave inclui grupoConta)", () => {
    const r = resolverCascataDicionario([
      global_("Empréstimos", "Empréstimos e Financiamentos - CP", "Passivo Circulante"),
      global_("Empréstimos", "Empréstimos e Financiamentos - LP", "Passivo Não Circulante"),
    ]);
    expect(r).toHaveLength(2);
  });

  it("match de nome é case-insensitive", () => {
    const r = resolverCascataDicionario([
      global_("BANCOS", "A"),
      empresa("bancos", "B"),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].contaDestino).toBe("B");
  });

  it("filtra por tipo quando pedido (BP não vaza para DRE)", () => {
    const r = resolverCascataDicionario([
      global_("Receita de Vendas", "Receita Bruta"),
      { ...global_("Receita de Vendas", "Receita Bruta"), tipo: "DRE" },
    ], "DRE");
    expect(r).toHaveLength(1);
    expect(r[0].tipo).toBe("DRE");
  });
});

describe("whereCascataDicionario", () => {
  it("sem empresa: só global + workspace", () => {
    const w = whereCascataDicionario(["u1", "u2"]);
    expect(w.OR).toHaveLength(2);
    expect(w.OR[0]).toEqual({ userId: null, companyId: null });
    expect(w.OR[1]).toEqual({ userId: { in: ["u1", "u2"] }, companyId: null });
  });

  it("com empresa: inclui as entradas DAQUELA empresa (e só dela)", () => {
    const w = whereCascataDicionario(["u1"], "c1");
    expect(w.OR).toHaveLength(3);
    expect(w.OR[2]).toEqual({ companyId: "c1" });
  });
});
