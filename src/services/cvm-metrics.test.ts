import { describe, it, expect } from "vitest";
import { triAnterior, dreTrimestre, dreLtm, indicadoresDaEmpresa, mesclaEmpresas } from "./cvm-metrics";
import type { CvmEmpresa } from "./cvm-ingest";

/* Empresa sintética com 5 trimestres (1T25..1T26) — receitas conhecidas por tri:
 * 1T25=100 · 2T25=110 · 3T25=120 · 4T25=130 (ano 2025 = 460) · 1T26=140
 * LTM @1T26 = 140+130+120+110 = 500 */
const dre = (receita: number, extra: Record<string, number> = {}) => ({
  "Receita Bruta": receita, "Custo Operacional": -receita * 0.6, "IR e CSLL": -receita * 0.05, ...extra,
});
const bp = (pl: number) => ({
  "Ativo Total": pl * 2, "Ativo Circulante": pl, "Caixa e Equivalentes de Caixa": pl * 0.2,
  "Contas a Receber - CP": pl * 0.4, "Estoques - CP": pl * 0.2,
  "Ativo Não Circulante": pl, "Passivo Total": pl * 2, "Passivo Circulante": pl * 0.6,
  "Passivo Não Circulante": pl * 0.4, "Patrimônio Líquido": pl,
});

const EMP: CvmEmpresa = {
  cnpj: "00000000000191", denom: "TESTE S.A.", cdCvm: "1",
  periodos: {
    "2025-03-31": { bp: bp(1000), dreTri: dre(100), dreYtd: dre(100), dfcYtd: {} },
    "2025-06-30": { bp: bp(1020), dreTri: dre(110), dreYtd: dre(210), dfcYtd: {} },
    "2025-09-30": { bp: bp(1040), dreTri: dre(120), dreYtd: dre(330), dfcYtd: {} },
    // fechamento: DFP grava dreTri = ANO (460) — o 4T isolado NÃO existe na fonte
    "2025-12-31": { bp: bp(1060), dreTri: dre(460), dreYtd: dre(460), dfcYtd: {} },
    "2026-03-31": { bp: bp(1100), dreTri: dre(140), dreYtd: dre(140), dfcYtd: {} },
  },
};

describe("cvm-metrics — visões TRI/ANO/LTM", () => {
  it("triAnterior navega trimestres inclusive na virada de ano", () => {
    expect(triAnterior("2026-03-31")).toBe("2025-12-31");
    expect(triAnterior("2025-12-31")).toBe("2025-09-30");
    expect(triAnterior("2025-06-30")).toBe("2025-03-31");
  });

  it("4T é derivado por DIFERENÇA (nunca usa a DRE anual do DFP como trimestre)", () => {
    const q4 = dreTrimestre(EMP, "2025-12-31")!;
    expect(q4["Receita Bruta"]).toBeCloseTo(130, 6); // 460 − 330, não 460
  });

  it("LTM cruza a virada de ano: 1T26 + 4T25 + 3T25 + 2T25", () => {
    const ltm = dreLtm(EMP, "2026-03-31")!;
    expect(ltm["Receita Bruta"]).toBeCloseTo(140 + 130 + 120 + 110, 6);
  });

  it("LTM incompleto → null (nunca estima janela faltando trimestre)", () => {
    const emp2: CvmEmpresa = { ...EMP, periodos: { "2026-03-31": EMP.periodos["2026-03-31"] } };
    expect(dreLtm(emp2, "2026-03-31")).toBeNull();
  });

  it("ROE nas 3 visões = LL LTM / PL MÉDIO (nunca lucro do tri sobre PL do ano)", () => {
    const visoes = indicadoresDaEmpresa(EMP, "2026-03-31");
    const ltm = visoes.find((v) => v.visao === "LTM")!;
    const tri = visoes.find((v) => v.visao === "TRI")!;
    const p = "31/03/2026";
    const roeLtm = ltm.indicadores.find((i) => i.nome === "ROE (Retorno sobre Patrimônio Líquido)")!;
    const roeTri = tri.indicadores.find((i) => i.nome === "ROE (Retorno sobre Patrimônio Líquido)")!;
    // LL LTM = 500×(1−0,6−0,05) = 175 · PL médio = (1100+1000)/2 = 1050 → 16,67%
    expect(roeLtm.valores[p]).toBeCloseTo(175 / 1050, 4);
    expect(roeTri.valores[p]).toBeCloseTo(175 / 1050, 4); // TRI replica a LTM
    expect(roeLtm.formula).toContain("PL médio");
  });

  it("margens são da PRÓPRIA visão (TRI usa a DRE do tri; prazos na base 90)", () => {
    const visoes = indicadoresDaEmpresa(EMP, "2026-03-31");
    const tri = visoes.find((v) => v.visao === "TRI")!;
    const p = "31/03/2026";
    const rl = tri.indicadores.find((i) => i.nome === "Receita Líquida")!;
    expect(rl.valores[p]).toBeCloseTo(140, 6); // trimestre isolado, não LTM
    const pmr = tri.indicadores.find((i) => i.nome === "Prazo Médio Contas a Receber")!;
    expect(pmr.valores[p]).toBe(Math.round((1100 * 0.4 * 90) / 140)); // base 90 dias
  });

  it("visão ANO só existe no fechamento (31/12) e usa a DRE do exercício", () => {
    expect(indicadoresDaEmpresa(EMP, "2026-03-31").some((v) => v.visao === "ANO")).toBe(false);
    const ano = indicadoresDaEmpresa(EMP, "2025-12-31").find((v) => v.visao === "ANO")!;
    expect(ano.indicadores.find((i) => i.nome === "Receita Líquida")!.valores["31/12/2025"]).toBeCloseTo(460, 6);
  });

  it("mesclaEmpresas une períodos de ITR e DFP da mesma empresa", () => {
    const a = new Map([[EMP.cnpj, { ...EMP, periodos: { "2025-03-31": EMP.periodos["2025-03-31"] } }]]);
    const b = new Map([[EMP.cnpj, { ...EMP, periodos: { "2025-12-31": EMP.periodos["2025-12-31"] } }]]);
    const m = mesclaEmpresas([a, b]).get(EMP.cnpj)!;
    expect(Object.keys(m.periodos).sort()).toEqual(["2025-03-31", "2025-12-31"]);
  });
});
