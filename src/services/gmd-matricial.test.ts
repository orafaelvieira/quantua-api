import { describe, it, expect } from "vitest";
import { calcularMatrizGmd, normContaGmd, COLUNA_CORPORATIVO, PacoteGmdDim, LinhaGmd } from "./gmd-matricial";
import { UnidadeDim, CentroCustoDim } from "./estrutura-dimensional";

const UNIDADES: UnidadeDim[] = [{ id: "u1", nome: "Matriz" }, { id: "u2", nome: "Filial" }];
const CENTROS: CentroCustoDim[] = [
  { id: "cc1", nome: "Comercial", unidadeId: "u1" },
  { id: "csc", nome: "TI", unidadeId: null },
];
const MESES = ["2027-01", "2027-02"];
const s = (v: number) => ({ "2027-01": v, "2027-02": v });

const PACOTES: PacoteGmdDim[] = [
  { id: "p-viagens", nome: "Viagens", contas: ["Despesas com Viagens e Estadias", "Despesas com Viagens"] },
  { id: "p-pessoal", nome: "Pessoal", contas: ["Despesas com Pessoas"] },
];

const LINHAS: LinhaGmd[] = [
  { id: "a", nome: "Despesas com Viagens", valores: s(100), centroCustoId: "cc1" },      // → Matriz via CC
  { id: "b", nome: "Despesas com VIAGENS e estadias", valores: s(50), unidadeId: "u2" }, // caixa/acentos ≠ problema
  { id: "c", nome: "Despesas com Pessoas", valores: s(200), centroCustoId: "csc" },      // CSC → corporativo
  { id: "d", nome: "Despesas com Marketing", valores: s(30) },                            // sem pacote, sem etiqueta
  { id: "e", nome: "Linha zerada", valores: {}, unidadeId: "u1" },                        // some da matriz
];

describe("calcularMatrizGmd", () => {
  const m = calcularMatrizGmd({ pacotes: PACOTES, linhas: LINHAS, unidades: UNIDADES, centros: CENTROS, meses: MESES });

  it("cruza pacote × unidade com nome normalizado e coluna via etiqueta", () => {
    expect(m.celulas["p-viagens"]["u1"]).toBe(200); // 100×2 meses via CC Comercial
    expect(m.celulas["p-viagens"]["u2"]).toBe(100);
    expect(m.celulas["p-pessoal"][COLUNA_CORPORATIVO]).toBe(400); // CSC é corporativo
  });

  it("totais por pacote e por coluna fecham", () => {
    expect(m.totalPorPacote["p-viagens"]).toBe(300);
    expect(m.totalPorColuna["u1"]).toBe(200);
    expect(m.totalPorColuna[COLUNA_CORPORATIVO]).toBe(400 + 60); // pessoal CSC + marketing sem etiqueta
  });

  it("linha sem pacote fica VISÍVEL e a cobertura reflete", () => {
    expect(m.linhasSemPacote.map((l) => l.id)).toEqual(["d"]);
    expect(m.cobertura).toBeCloseTo((300 + 400) / (300 + 400 + 60), 10);
  });

  it("conta em dois pacotes vale o primeiro — sem dupla contagem", () => {
    const dupl = calcularMatrizGmd({
      pacotes: [
        { id: "p1", nome: "A", contas: ["Despesas com Viagens"] },
        { id: "p2", nome: "B", contas: ["despesas com viagens"] },
      ],
      linhas: [{ id: "x", nome: "Despesas com Viagens", valores: s(10), unidadeId: "u1" }],
      unidades: UNIDADES, centros: CENTROS, meses: MESES,
    });
    expect(dupl.totalPorPacote["p1"]).toBe(20);
    expect(dupl.totalPorPacote["p2"]).toBeUndefined();
  });
});

describe("normContaGmd", () => {
  it("acentos, caixa e pontuação não separam contas", () => {
    expect(normContaGmd("Despesas c/ Viagens")).toBe(normContaGmd("despesas c  viagens"));
    expect(normContaGmd("Água & Luz")).toBe(normContaGmd("agua   luz"));
  });
});
