import { describe, it, expect } from "vitest";
import { CENTROS_PADRAO, centroEquivalente, contasDoEsqueleto } from "./esqueleto-orcamento";

/**
 * O esqueleto tem que POUSAR na estrutura que a empresa já tem (defeito relatado
 * em 27/07/2026: os centros de custo existiam e as contas não apareceram neles).
 */

describe("centroEquivalente", () => {
  it("casa o apelido da casa com o nome do catálogo", () => {
    expect(centroEquivalente("Recursos Humanos", ["Comercial", "RH", "TI"])).toBe("RH");
    expect(centroEquivalente("TI", ["Tecnologia da Informação"])).toBe("Tecnologia da Informação");
    expect(centroEquivalente("Administrativo", ["ADM"])).toBe("ADM");
    expect(centroEquivalente("Operações", ["Produção"])).toBe("Produção");
  });

  it("ignora acento, caixa e pontuação", () => {
    expect(centroEquivalente("Operações", ["OPERACOES"])).toBe("OPERACOES");
    expect(centroEquivalente("Marketing", ["  marketing  "])).toBe("  marketing  ");
  });

  it("devolve null quando a empresa não tem nada parecido", () => {
    expect(centroEquivalente("Financeiro", ["Comercial", "Almoxarifado"])).toBeNull();
    expect(centroEquivalente("TI", [])).toBeNull();
  });
});

describe("contasDoEsqueleto", () => {
  it("aponta as contas para o CC QUE A EMPRESA TEM, não para o nome do catálogo", () => {
    const contas = contasDoEsqueleto(["RH", "Comercial"]);
    const doRh = contas.filter((c) => c.centroCusto === "RH");
    expect(doRh.length).toBeGreaterThan(0);
    // e nenhuma conta sobra apontando para o nome do catálogo
    expect(contas.some((c) => c.centroCusto === "Recursos Humanos")).toBe(false);
  });

  it("sem estrutura na empresa, as contas vêm SEM lotação (orçamento único)", () => {
    // 28/07/2026: antes mandava o nome do catálogo e o importador reclamava de
    // "centro de custo não encontrado" — mas a empresa só não trabalha por CC.
    const contas = contasDoEsqueleto([]);
    expect(new Set(contas.map((c) => c.centroCusto))).toEqual(new Set([""]));
    // E a folha perde o sufixo do CC, que ali não significaria nada.
    expect(contas.some((c) => c.nome === "Salários e encargos")).toBe(true);
    expect(contas.some((c) => /^Salários e encargos \(/.test(c.nome))).toBe(false);
  });

  it("toda conta declara tipo válido e nome não vazio", () => {
    for (const c of contasDoEsqueleto([])) {
      expect(c.nome.trim().length).toBeGreaterThan(0);
      expect(["custo", "despesa"]).toContain(c.tipo);
    }
  });
});
