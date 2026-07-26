import { describe, it, expect } from "vitest";
import { montarLinhaReceita, TEMPLATES_RECEITA } from "./model-templates";
import { calcularModelo, BlocoModelo, LinhaReceita } from "./model-engine";

/** Roda uma linha isolada pelo motor (é assim que a tela a cria). */
function rodar(linha: LinhaReceita, meses = 2) {
  const bloco: BlocoModelo = {
    id: "b1", tipo: "receitas", nome: "Receitas", ativo: true,
    config: { linhasReceita: [linha] },
  };
  return calcularModelo({ mesInicial: "2026-01", horizonteMeses: meses, blocks: [bloco] });
}

describe("catálogo de templates", () => {
  it("todo template do catálogo monta uma linha que o motor aceita", () => {
    for (const t of TEMPLATES_RECEITA) {
      const linha = montarLinhaReceita(t.id, `lin_${t.id}`, t.nome, { receitaMensal: 500_000 });
      const r = rodar(linha);
      expect(r.erros, `template "${t.id}" produziu erros`).toEqual([]);
      // O nó raiz precisa existir e fechar em R$ (senão a análise dimensional acusa).
      expect(r.series[linha.nodeRaiz], `template "${t.id}" sem série no nó raiz`).toBeDefined();
    }
  });

  it("os templates do agro estão no catálogo", () => {
    const ids = TEMPLATES_RECEITA.map((t) => t.id);
    expect(ids).toContain("agro_insumo");
    expect(ids).toContain("agro_graos");
    expect(ids).toContain("agro_agrupado");
    expect(ids).toContain("agro_barter");
  });

  it("cada linha usa ids de nó próprios — duas linhas do mesmo template convivem", () => {
    const a = montarLinhaReceita("agro_insumo", "lin_a", "Adubo");
    const b = montarLinhaReceita("agro_insumo", "lin_b", "Defensivo");
    const bloco: BlocoModelo = {
      id: "b1", tipo: "receitas", nome: "Receitas", ativo: true,
      config: { linhasReceita: [a, b] },
    };
    const r = calcularModelo({ mesInicial: "2026-01", horizonteMeses: 1, blocks: [bloco] });
    expect(r.erros).toEqual([]);
  });
});

describe("agro_insumo (linha avulsa)", () => {
  it("deriva o preço do custo pela pilha de percentuais", () => {
    const linha = montarLinhaReceita("agro_insumo", "lin", "Adubo");
    const r = rodar(linha);
    // Defaults: 2% + 0% + 1% + 0% + 0% + 7% = 10% → preço = 100 ÷ 0,9.
    expect(r.series["lin_cv_soma"]!["2026-01"]).toBeCloseTo(0.1, 10);
    expect(r.series["lin_preco"]!["2026-01"]).toBeCloseTo(100 / 0.9, 8);
  });
});

describe("agro_graos (linha avulsa)", () => {
  it("converte kg em sacas de 60 kg", () => {
    const linha = montarLinhaReceita("agro_graos", "lin", "Soja");
    const r = rodar(linha);
    const kg = r.series["lin_volume_kg"]!["2026-01"]!;
    expect(r.series["lin_sacas"]!["2026-01"]).toBeCloseTo(kg / 60, 8);
  });

  it("a receita semeada bate com o histórico informado", () => {
    const linha = montarLinhaReceita("agro_graos", "lin", "Soja", { receitaMensal: 1_300_000 });
    const r = rodar(linha);
    // O seed dimensiona o volume para reproduzir a receita informada.
    expect(r.series["lin_receita"]!["2026-01"]).toBeCloseTo(1_300_000, 0);
  });
});

describe("agro_barter (linha avulsa)", () => {
  it("é autossuficiente: tem a própria base e não referencia outra linha", () => {
    const linha = montarLinhaReceita("agro_barter", "lin", "Barter Soja", { receitaMensal: 1_200_000 });
    const r = rodar(linha);
    expect(r.erros).toEqual([]);
    // 1.200.000 ÷ 120 = 10.000 sacas; × 132 (produtor +10%) = 1.320.000.
    expect(r.series["lin_sacas"]!["2026-01"]).toBeCloseTo(10_000, 6);
    expect(r.series["lin_receita"]!["2026-01"]).toBeCloseTo(1_320_000, 2);
  });

  it("o ganho é o spread entre preço da trading e preço do produtor", () => {
    const linha = montarLinhaReceita("agro_barter", "lin", "Barter", { receitaMensal: 1_000_000 });
    const r = rodar(linha);
    const base = r.series["lin_base"]!["2026-01"]!;
    const receita = r.series["lin_receita"]!["2026-01"]!;
    expect(receita).toBeGreaterThan(base); // trading acima do produtor = ganho
  });
});
