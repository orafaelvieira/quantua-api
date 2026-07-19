import { describe, it, expect } from "vitest";
import { calcularModelo, BlocoModelo } from "./model-engine";
import {
  montarBlocoAgro,
  montarLinhaInsumoDetalhado,
  montarLinhaGraos,
  montarLinhasBarter,
  montarCustosVariaveis,
  splitBarterFecha,
  KG_POR_SACA,
  SKUS_INSUMOS_PADRAO,
  FAMILIAS_AGRUPADO_PADRAO,
} from "./model-templates-agro";
import { LinhaReceita } from "./model-engine";

/** Roda o motor com um bloco de receitas e devolve o resultado. */
function rodar(linhas: LinhaReceita[], meses = 3) {
  const bloco: BlocoModelo = {
    id: "b1",
    tipo: "receitas",
    nome: "Receitas",
    ativo: true,
    config: { linhasReceita: linhas },
  };
  return calcularModelo({ mesInicial: "2026-01", horizonteMeses: meses, blocks: [bloco] });
}

// ── Modo detalhado: preço derivado do custo ────────────────────────────────

describe("modo detalhado — preço derivado do custo", () => {
  it("sobe o custo pela pilha de custos variáveis e margem", () => {
    // Custo 100; pilha = 2% imposto + 1% armazenagem + 7% margem = 10%.
    // Preço = 100 ÷ (1 − 0,10) = 111,111…
    const linha = montarLinhaInsumoDetalhado(
      { id: "teste", nome: "Adubo", um: "TON", volumeMensal: 10, custoUnitario: 100 },
      { nosCompartilhados: montarCustosVariaveis("cv") }
    );
    const r = rodar([linha]);

    expect(r.erros).toEqual([]);
    const preco = r.series["sku_teste_preco"]!["2026-01"]!;
    expect(preco).toBeCloseTo(100 / 0.9, 8);

    // Receita = volume × preço.
    const receita = r.series["sku_teste_receita"]!["2026-01"]!;
    expect(receita).toBeCloseTo(10 * (100 / 0.9), 6);
  });

  it("a margem de contribuição alvo é efetivamente realizada no preço", () => {
    // Com apenas a margem na pilha (demais zerados), a margem sobre o PREÇO
    // deve ser exatamente a margem alvo — é essa a definição da planilha.
    const linha = montarLinhaInsumoDetalhado(
      { id: "m", nome: "Insumo", um: "KG", volumeMensal: 1, custoUnitario: 80 },
      {
        nosCompartilhados: montarCustosVariaveis("cv", {
          imposto_venda: 0,
          armazenagem: 0,
          margem_contribuicao: 0.2,
        }),
      }
    );
    const r = rodar([linha]);
    const preco = r.series["sku_m_preco"]!["2026-01"]!;

    expect(preco).toBeCloseTo(100, 8); // 80 ÷ 0,8
    expect((preco - 80) / preco).toBeCloseTo(0.2, 8);
  });

  it("os percentuais são globais: um único ajuste move todos os SKUs", () => {
    const linhas = montarBlocoAgro({
      modo: "detalhado",
      skus: [
        { id: "a", nome: "A", um: "KG", volumeMensal: 1, custoUnitario: 100 },
        { id: "b", nome: "B", um: "LT", volumeMensal: 1, custoUnitario: 200 },
      ],
      custosVariaveis: { imposto_venda: 0, armazenagem: 0, margem_contribuicao: 0.5 },
    });
    const r = rodar(linhas);

    // Ambos sobem pelo mesmo divisor (1 − 0,5).
    expect(r.series["sku_a_preco"]!["2026-01"]).toBeCloseTo(200, 8);
    expect(r.series["sku_b_preco"]!["2026-01"]).toBeCloseTo(400, 8);
  });

  it("os nós compartilhados só existem uma vez (sem nó duplicado)", () => {
    const linhas = montarBlocoAgro({ modo: "detalhado" });
    const r = rodar(linhas);
    expect(r.erros).toEqual([]);
    expect(linhas).toHaveLength(SKUS_INSUMOS_PADRAO.length);
  });
});

// ── Grãos: conversão kg → saca ─────────────────────────────────────────────

describe("grãos", () => {
  it("converte kg em sacas de 60 kg e precifica por saca", () => {
    const linha = montarLinhaGraos({ id: "soja", nome: "Soja", volumeKgMensal: 60_000, precoSaca: 130 });
    const r = rodar([linha]);

    expect(r.erros).toEqual([]);
    expect(r.series["grao_soja_sacas"]!["2026-01"]).toBeCloseTo(1_000, 8);
    expect(r.series["grao_soja_receita"]!["2026-01"]).toBeCloseTo(130_000, 6);
  });

  it("KG_POR_SACA é 60", () => {
    expect(KG_POR_SACA).toBe(60);
  });
});

// ── Barter ─────────────────────────────────────────────────────────────────

describe("barter", () => {
  it("converte receita em sacas pelo preço do produtor e revaloriza na trading", () => {
    // Base de receita 1.000.000; 100% em barter; 100% soja.
    // Produtor 100/saca → 10.000 sacas. Trading 120/saca → 1.200.000.
    const base = montarLinhaGraos({ id: "base", nome: "Base", volumeKgMensal: 60_000, precoSaca: 1_000 });
    // receita base = (60000/60) × 1000 = 1.000.000
    const barter = montarLinhasBarter({
      receitaBaseRef: "grao_base_receita",
      pctBarter: 1,
      culturas: [{ id: "soja", nome: "Soja", split: 1, precoProdutor: 100, precoTrading: 120 }],
    });

    const r = rodar([base, ...barter]);

    expect(r.erros).toEqual([]);
    expect(r.series["grao_base_receita"]!["2026-01"]).toBeCloseTo(1_000_000, 6);
    expect(r.series["barter_soja_sacas"]!["2026-01"]).toBeCloseTo(10_000, 6);
    expect(r.series["barter_soja_receita"]!["2026-01"]).toBeCloseTo(1_200_000, 4);
  });

  it("o ganho da operação é o spread trading − produtor", () => {
    const base = montarLinhaGraos({ id: "base", nome: "Base", volumeKgMensal: 60_000, precoSaca: 1_000 });
    const barter = montarLinhasBarter({
      receitaBaseRef: "grao_base_receita",
      pctBarter: 1,
      culturas: [{ id: "soja", nome: "Soja", split: 1, precoProdutor: 100, precoTrading: 100 }],
    });
    const r = rodar([base, ...barter]);

    // Sem spread, o barter devolve exatamente a receita base — ganho zero.
    expect(r.series["barter_soja_receita"]!["2026-01"]).toBeCloseTo(1_000_000, 4);
  });

  it("divide o barter entre culturas pelo split", () => {
    const base = montarLinhaGraos({ id: "base", nome: "Base", volumeKgMensal: 60_000, precoSaca: 1_000 });
    const barter = montarLinhasBarter({
      receitaBaseRef: "grao_base_receita",
      pctBarter: 1,
      culturas: [
        { id: "soja", nome: "Soja", split: 0.7, precoProdutor: 100, precoTrading: 100 },
        { id: "milho", nome: "Milho", split: 0.3, precoProdutor: 50, precoTrading: 50 },
      ],
    });
    const r = rodar([base, ...barter]);

    expect(r.series["barter_soja_sacas"]!["2026-01"]).toBeCloseTo(7_000, 6); // 700k ÷ 100
    expect(r.series["barter_milho_sacas"]!["2026-01"]).toBeCloseTo(6_000, 6); // 300k ÷ 50
  });

  it("splitBarterFecha valida que as culturas somam 100%", () => {
    expect(splitBarterFecha({ culturas: [{ id: "a", nome: "A", split: 0.7 }, { id: "b", nome: "B", split: 0.3 }] })).toBe(true);
    expect(splitBarterFecha({ culturas: [{ id: "a", nome: "A", split: 0.7 }, { id: "b", nome: "B", split: 0.2 }] })).toBe(false);
  });

  it("preço do produtor zerado não estoura o motor", () => {
    const base = montarLinhaGraos({ id: "base", nome: "Base", volumeKgMensal: 60_000, precoSaca: 1_000 });
    const barter = montarLinhasBarter({
      receitaBaseRef: "grao_base_receita",
      pctBarter: 1,
      culturas: [{ id: "soja", nome: "Soja", split: 1, precoProdutor: 0, precoTrading: 120 }],
    });
    const r = rodar([base, ...barter]);
    expect(Number.isFinite(r.series["barter_soja_sacas"]!["2026-01"]!)).toBe(true);
  });
});

// ── Modo agrupado ──────────────────────────────────────────────────────────

describe("modo agrupado", () => {
  it("usa a receita digitada direto, sem volume nem preço unitário", () => {
    const linhas = montarBlocoAgro({
      modo: "agrupado",
      familias: [{ id: "adubos", nome: "Adubos", receitaMensal: 150_000, margem: 0.2 }],
    });
    const r = rodar(linhas);

    expect(r.erros).toEqual([]);
    expect(r.series["fam_adubos_receita"]!["2026-01"]).toBeCloseTo(150_000, 6);
    expect(r.series["fam_adubos_margem"]!["2026-01"]).toBeCloseTo(0.2, 8);
  });

  it("traz as 7 famílias padrão da planilha", () => {
    const linhas = montarBlocoAgro({ modo: "agrupado" });
    expect(linhas).toHaveLength(FAMILIAS_AGRUPADO_PADRAO.length);
    expect(linhas.map((l) => l.nome)).toContain("Fertilizantes - Nutrição");
  });
});

// ── Integração: receita total do bloco ─────────────────────────────────────

describe("bloco agro completo", () => {
  it("soma insumos e grãos na receita da DRE", () => {
    const linhas = montarBlocoAgro({
      modo: "detalhado",
      skus: [{ id: "a", nome: "Adubo", um: "TON", volumeMensal: 10, custoUnitario: 90 }],
      custosVariaveis: { imposto_venda: 0, armazenagem: 0, margem_contribuicao: 0.1 },
      graos: [{ id: "soja", nome: "Soja", volumeKgMensal: 60_000, precoSaca: 130 }],
    });
    const r = rodar(linhas);

    expect(r.erros).toEqual([]);
    // Insumo: 10 × (90 ÷ 0,9) = 1.000. Grão: 1.000 sacas × 130 = 130.000.
    const receitaTotal = r.dre.find((l) => l.grupo === "subtotal" && /receita/i.test(l.nome));
    expect(receitaTotal).toBeDefined();
    expect(receitaTotal!.valores["2026-01"]).toBeCloseTo(131_000, 4);
  });

  it("a análise dimensional aprova todas as fórmulas do template", () => {
    const linhas = montarBlocoAgro({
      modo: "detalhado",
      graos: [{ id: "soja", nome: "Soja", volumeKgMensal: 1_000, precoSaca: 100 }],
      barter: {
        pctBarter: 0.25,
        culturas: [{ id: "soja", nome: "Soja", split: 1, precoProdutor: 100, precoTrading: 120 }],
      },
    });
    const r = rodar(linhas);

    // Erro dimensional apareceria em erros[] ou num check vermelho.
    expect(r.erros).toEqual([]);
    const dimensional = r.checks.find((c) => /dimension/i.test(c.nome) || /unidade/i.test(c.nome));
    if (dimensional) expect(dimensional.ok).toBe(true);
  });
});
