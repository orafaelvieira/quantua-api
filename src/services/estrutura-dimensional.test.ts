import { describe, it, expect } from "vitest";
import {
  calcularPorUnidade, pesosManuais, pesosPorReceita, decomporFolha, validarEdicaoRestrita,
  UnidadeDim, CentroCustoDim, PosicaoDim,
} from "./estrutura-dimensional";
import { LinhaDre, Serie } from "./model-engine";

// ── Cenário de referência ──────────────────────────────────────────────────
// Duas unidades (Matriz, Filial Sul) + um CSC compartilhado (TI).
// Receita: 100 na Matriz, 50 na Sul. Custo direto: 30 na Matriz.
// CSC TI: 20/mês — rateado.

const MESES = ["2027-01", "2027-02"];
const s = (v: number): Serie => ({ "2027-01": v, "2027-02": v });

const UNIDADES: UnidadeDim[] = [
  { id: "u-matriz", nome: "Matriz", ehMatriz: true },
  { id: "u-sul", nome: "Filial Sul" },
];

const CC_TI_MANUAL: CentroCustoDim = {
  id: "cc-ti", nome: "TI (CSC)", unidadeId: null,
  rateio: { driver: "manual", pesos: { "u-matriz": 70, "u-sul": 30 } },
};
const CC_TI_RECEITA: CentroCustoDim = { id: "cc-ti", nome: "TI (CSC)", unidadeId: null, rateio: { driver: "receita" } };
const CC_COMERCIAL_SUL: CentroCustoDim = { id: "cc-com-sul", nome: "Comercial Sul", unidadeId: "u-sul" };

function dreBase(): LinhaDre[] {
  const p = (): Serie => ({});
  return [
    { id: "receita-total", nome: "Receita", grupo: "subtotal", valores: s(150), pctReceita: p() },
    { id: "rec-matriz", nome: "Vendas Matriz", grupo: "receita", valores: s(100), pctReceita: p() },
    { id: "rec-sul", nome: "Vendas Sul", grupo: "receita", valores: s(50), pctReceita: p() },
    { id: "custos-total", nome: "(−) Custos", grupo: "subtotal", valores: s(30), pctReceita: p() },
    { id: "custo-matriz", nome: "CMV Matriz", grupo: "custos", valores: s(30), pctReceita: p() },
    { id: "despesas-total", nome: "(−) Despesas", grupo: "subtotal", valores: s(20), pctReceita: p() },
    { id: "desp-ti", nome: "TI compartilhada", grupo: "despesas", valores: s(20), pctReceita: p() },
    { id: "ebitda", nome: "EBITDA", grupo: "subtotal", valores: s(100), pctReceita: p() },
    // Abaixo do EBITDA — NUNCA entra na visão por unidade:
    { id: "depreciacao-total", nome: "(−) Depreciação", grupo: "despesas", valores: s(10), pctReceita: p() },
    { id: "lucro-liquido", nome: "Lucro líquido", grupo: "subtotal", valores: s(90), pctReceita: p() },
  ];
}

const TAGS = {
  "rec-matriz": { unidadeId: "u-matriz" },
  "rec-sul": { unidadeId: "u-sul" },
  "custo-matriz": { unidadeId: "u-matriz" },
  "desp-ti": { centroCustoId: "cc-ti" },
};

describe("calcularPorUnidade", () => {
  it("distribui linhas diretas e rateia o CSC por pesos manuais", () => {
    const r = calcularPorUnidade({ dre: dreBase(), tags: TAGS, unidades: UNIDADES, centros: [CC_TI_MANUAL], meses: MESES });
    const matriz = r.unidades.find((u) => u.unidadeId === "u-matriz")!;
    const sul = r.unidades.find((u) => u.unidadeId === "u-sul")!;

    expect(matriz.receita["2027-01"]).toBe(100);
    expect(sul.receita["2027-01"]).toBe(50);
    expect(matriz.custos["2027-01"]).toBe(30);
    // CSC 20 → 70/30
    expect(matriz.despesas["2027-01"]).toBeCloseTo(14, 10);
    expect(sul.despesas["2027-01"]).toBeCloseTo(6, 10);
    expect(matriz.rateioRecebido["2027-01"]).toBeCloseTo(14, 10);
    // EBITDA por unidade
    expect(matriz.ebitda["2027-01"]).toBeCloseTo(100 - 30 - 14, 10);
    expect(sul.ebitda["2027-01"]).toBeCloseTo(50 - 6, 10);
  });

  it("rateio por receita usa a proporção da receita direta do mês", () => {
    const r = calcularPorUnidade({ dre: dreBase(), tags: TAGS, unidades: UNIDADES, centros: [CC_TI_RECEITA], meses: MESES });
    const matriz = r.unidades.find((u) => u.unidadeId === "u-matriz")!;
    const sul = r.unidades.find((u) => u.unidadeId === "u-sul")!;
    // 100/150 e 50/150 de 20
    expect(matriz.despesas["2027-01"]).toBeCloseTo(20 * (100 / 150), 10);
    expect(sul.despesas["2027-01"]).toBeCloseTo(20 * (50 / 150), 10);
  });

  it("prova de partição: Σ unidades + não atribuído = EBITDA consolidado, ao centavo", () => {
    for (const cc of [CC_TI_MANUAL, CC_TI_RECEITA]) {
      const r = calcularPorUnidade({ dre: dreBase(), tags: TAGS, unidades: UNIDADES, centros: [cc], meses: MESES });
      expect(r.provaParticao.ok).toBe(true);
      expect(r.provaParticao.maiorDiferenca).toBeLessThan(0.01);
    }
  });

  it("linha sem etiqueta cai em Não atribuído — nunca é distribuída em silêncio", () => {
    const tags = { ...TAGS } as Record<string, { unidadeId?: string }>;
    delete (tags as Record<string, unknown>)["custo-matriz"];
    const r = calcularPorUnidade({ dre: dreBase(), tags, unidades: UNIDADES, centros: [CC_TI_MANUAL], meses: MESES });
    expect(r.naoAtribuido.linhas.map((l) => l.id)).toContain("custo-matriz");
    expect(r.naoAtribuido.custos["2027-01"]).toBe(30);
    expect(r.provaParticao.ok).toBe(true); // a prova continua fechando
    expect(r.avisos.some((a) => a.includes("sem unidade/CC"))).toBe(true);
  });

  it("CC com unidade só refina a leitura — a linha vai para a unidade do CC", () => {
    const tags = { ...TAGS, "custo-matriz": { centroCustoId: "cc-com-sul" } };
    const r = calcularPorUnidade({ dre: dreBase(), tags, unidades: UNIDADES, centros: [CC_TI_MANUAL, CC_COMERCIAL_SUL], meses: MESES });
    const sul = r.unidades.find((u) => u.unidadeId === "u-sul")!;
    expect(sul.custos["2027-01"]).toBe(30);
    expect(sul.linhas.find((l) => l.id === "custo-matriz")?.centroCusto).toBe("Comercial Sul");
  });

  it("linhas abaixo do EBITDA (depreciação etc.) ficam fora da visão por unidade", () => {
    const r = calcularPorUnidade({ dre: dreBase(), tags: TAGS, unidades: UNIDADES, centros: [CC_TI_MANUAL], meses: MESES });
    const todas = [...r.unidades.flatMap((u) => u.linhas), ...r.naoAtribuido.linhas];
    expect(todas.find((l) => l.id.startsWith("depreciacao-total"))).toBeUndefined();
  });

  it("deduções/impostos do motor rateiam proporcional à receita etiquetada", () => {
    const dre = dreBase();
    // injeta a linha do motor entre receita e custos, como na cascata real
    dre.splice(3, 0, { id: "impostos-receita", nome: "(−) Impostos sobre a receita", grupo: "despesas", valores: s(15), pctReceita: {} });
    // ebitda consolidado cai 15
    dre.find((l) => l.id === "ebitda")!.valores = s(85);
    const r = calcularPorUnidade({ dre, tags: TAGS, unidades: UNIDADES, centros: [CC_TI_MANUAL], meses: MESES });
    const matriz = r.unidades.find((u) => u.unidadeId === "u-matriz")!;
    const fatiaImposto = matriz.linhas.find((l) => l.id.startsWith("impostos-receita"));
    expect(fatiaImposto?.valores["2027-01"]).toBeCloseTo(15 * (100 / 150), 10);
    expect(r.provaParticao.ok).toBe(true);
  });

  it("rateio manual sem pesos divide igual e AVISA", () => {
    const cc: CentroCustoDim = { id: "cc-ti", nome: "TI", unidadeId: null, rateio: { driver: "manual" } };
    const r = calcularPorUnidade({ dre: dreBase(), tags: TAGS, unidades: UNIDADES, centros: [cc], meses: MESES });
    const matriz = r.unidades.find((u) => u.unidadeId === "u-matriz")!;
    expect(matriz.despesas["2027-01"]).toBeCloseTo(10, 10);
    expect(r.avisos.some((a) => a.includes("sem pesos"))).toBe(true);
    expect(r.provaParticao.ok).toBe(true);
  });
});

describe("decomporFolha", () => {
  const POSICOES: PosicaoDim[] = [
    { id: "vend", nome: "Vendedor", classificacao: "despesa", unidadeId: "u-sul" },
    { id: "op", nome: "Operador", classificacao: "custo", unidadeId: "u-matriz" },
    { id: "adm", nome: "Analista adm", classificacao: "despesa" }, // sem etiqueta
  ];
  const SERIES: Record<string, Serie> = {
    folha_vend_custo: s(8),
    folha_op_custo: s(12),
    folha_adm_custo: s(5),
  };

  function dreComFolha(): LinhaDre[] {
    const p = (): Serie => ({});
    return [
      { id: "rec", nome: "Vendas", grupo: "receita", valores: s(100), pctReceita: p() },
      // Folha de custo SOMADA na canônica (premissa 20 + operador 12 = 32)
      { id: "c1", nome: "Custo Operacional", grupo: "custos", valores: s(32), pctReceita: p() },
      // Folha de despesa em linha própria (vendedor 8 + adm 5 = 13)
      { id: "folha-despesas", nome: "Folha e encargos (adm/comercial)", grupo: "despesas", valores: s(13), pctReceita: p() },
      { id: "ebitda", nome: "EBITDA", grupo: "subtotal", valores: s(100 - 32 - 13), pctReceita: p() },
    ];
  }

  it("posição etiquetada vira pseudo-linha e sai da agregada — soma preservada", () => {
    const { dre, tagsExtras } = decomporFolha(dreComFolha(), POSICOES, SERIES);
    const canonica = dre.find((l) => l.id === "c1")!;
    const linhaFolha = dre.find((l) => l.id === "folha-despesas")!;
    const psVend = dre.find((l) => l.id === "pos:vend")!;
    const psOp = dre.find((l) => l.id === "pos:op")!;
    expect(canonica.valores["2027-01"]).toBe(20); // 32 − operador 12
    expect(psOp.valores["2027-01"]).toBe(12);
    expect(linhaFolha.valores["2027-01"]).toBe(5); // 13 − vendedor 8 (adm sem etiqueta fica)
    expect(psVend.valores["2027-01"]).toBe(8);
    expect(tagsExtras["pos:vend"]).toEqual({ unidadeId: "u-sul", centroCustoId: null });
    // pseudo-linhas ANTES do ebitda (dentro do corte da visão)
    expect(dre.findIndex((l) => l.id === "pos:vend")).toBeLessThan(dre.findIndex((l) => l.id === "ebitda"));
  });

  it("integra com calcularPorUnidade: partição fecha com folha decomposta", () => {
    const { dre, tagsExtras } = decomporFolha(dreComFolha(), POSICOES, SERIES);
    const r = calcularPorUnidade({
      dre,
      tags: { rec: { unidadeId: "u-matriz" }, ...tagsExtras },
      unidades: UNIDADES, centros: [], meses: MESES,
    });
    const sul = r.unidades.find((u) => u.unidadeId === "u-sul")!;
    expect(sul.despesas["2027-01"]).toBe(8); // só o vendedor
    expect(r.provaParticao.ok).toBe(true);
  });

  it("sem posição etiquetada, devolve a DRE intacta", () => {
    const { dre, tagsExtras } = decomporFolha(dreComFolha(), [{ id: "x", nome: "X", classificacao: "custo" }], SERIES);
    expect(dre.map((l) => l.id)).toEqual(["rec", "c1", "folha-despesas", "ebitda"]);
    expect(Object.keys(tagsExtras)).toHaveLength(0);
  });
});

describe("validarEdicaoRestrita", () => {
  const CENTROS: CentroCustoDim[] = [
    { id: "cc-sul", nome: "Comercial Sul", unidadeId: "u-sul" },
    { id: "cc-csc", nome: "TI", unidadeId: null },
  ];
  const MINHAS = new Set(["u-sul"]);
  const cfg = (linhas: Array<Record<string, unknown>>, extra?: Record<string, unknown>) =>
    ({ linhasCusto: linhas as never, ...extra });

  it("editar linha da própria unidade passa; de outra, não", () => {
    const antes = cfg([{ id: "a", unidadeId: "u-sul", pct: 0.1 }, { id: "b", unidadeId: "u-matriz", pct: 0.2 }]);
    const minhaMudanca = cfg([{ id: "a", unidadeId: "u-sul", pct: 0.15 }, { id: "b", unidadeId: "u-matriz", pct: 0.2 }]);
    expect(validarEdicaoRestrita(antes, minhaMudanca, MINHAS, CENTROS)).toHaveLength(0);
    const alheia = cfg([{ id: "a", unidadeId: "u-sul", pct: 0.1 }, { id: "b", unidadeId: "u-matriz", pct: 0.9 }]);
    expect(validarEdicaoRestrita(antes, alheia, MINHAS, CENTROS).length).toBeGreaterThan(0);
  });

  it("linha via CC da unidade conta como da unidade; CSC é corporativo", () => {
    const antes = cfg([{ id: "a", centroCustoId: "cc-sul", pct: 0.1 }, { id: "t", centroCustoId: "cc-csc", pct: 0.3 }]);
    const ok = cfg([{ id: "a", centroCustoId: "cc-sul", pct: 0.2 }, { id: "t", centroCustoId: "cc-csc", pct: 0.3 }]);
    expect(validarEdicaoRestrita(antes, ok, MINHAS, CENTROS)).toHaveLength(0);
    const csc = cfg([{ id: "a", centroCustoId: "cc-sul", pct: 0.1 }, { id: "t", centroCustoId: "cc-csc", pct: 0.9 }]);
    expect(validarEdicaoRestrita(antes, csc, MINHAS, CENTROS).length).toBeGreaterThan(0);
  });

  it("criar/excluir na própria unidade passa; sem etiqueta ou de outra, não", () => {
    const antes = cfg([{ id: "a", unidadeId: "u-sul" }]);
    expect(validarEdicaoRestrita(antes, cfg([{ id: "a", unidadeId: "u-sul" }, { id: "n", unidadeId: "u-sul" }]), MINHAS, CENTROS)).toHaveLength(0);
    expect(validarEdicaoRestrita(antes, cfg([{ id: "a", unidadeId: "u-sul" }, { id: "n" }]), MINHAS, CENTROS).length).toBeGreaterThan(0);
    expect(validarEdicaoRestrita(antes, cfg([]), MINHAS, CENTROS)).toHaveLength(0); // excluir a própria
    const antesAlheia = cfg([{ id: "b", unidadeId: "u-matriz" }]);
    expect(validarEdicaoRestrita(antesAlheia, cfg([]), MINHAS, CENTROS).length).toBeGreaterThan(0);
  });

  it("re-etiquetar a própria linha e mexer em campo do bloco são bloqueados", () => {
    const antes = cfg([{ id: "a", unidadeId: "u-sul" }]);
    expect(validarEdicaoRestrita(antes, cfg([{ id: "a", unidadeId: "u-matriz" }]), MINHAS, CENTROS).length).toBeGreaterThan(0);
    expect(validarEdicaoRestrita(cfg([], { deducoesPct: 0.01 }), cfg([], { deducoesPct: 0.05 }), MINHAS, CENTROS).length).toBeGreaterThan(0);
  });
});

describe("pesos", () => {
  it("pesos manuais normalizam (70/30 em qualquer escala)", () => {
    expect(pesosManuais(CC_TI_MANUAL, UNIDADES)).toEqual({ "u-matriz": 0.7, "u-sul": 0.3 });
  });
  it("pesos por receita: mês sem receita divide igual (o custo do CSC não some)", () => {
    const rec = new Map<string, Serie>([["u-matriz", {}], ["u-sul", {}]]);
    const p = pesosPorReceita(rec, UNIDADES, "2027-01");
    expect(p["u-matriz"]).toBeCloseTo(0.5, 10);
  });
  it("unidade inativa fica fora do rateio", () => {
    const unidades: UnidadeDim[] = [...UNIDADES, { id: "u-fechada", nome: "Fechada", ativo: false }];
    const p = pesosManuais({ ...CC_TI_MANUAL, rateio: { driver: "manual", pesos: { "u-matriz": 50, "u-sul": 50, "u-fechada": 100 } } }, unidades);
    expect(p["u-fechada"]).toBeUndefined();
    expect(p["u-matriz"]).toBeCloseTo(0.5, 10);
  });
});
