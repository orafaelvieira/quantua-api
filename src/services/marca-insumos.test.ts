import { describe, it, expect } from "vitest";
import { diferencasDaMarca } from "./base-contabil";

// Caso REAL reportado em 19/08/2026: o IBR acusou "Extração desatualizada —
// algum insumo da base mudou depois desta extração" com a base intacta.
// A marca é uma impressão digital e mudava sozinha; o alarme tocava sem causa.
const marca = (docs: Array<[string, string, string, string | null, string | null]>, versao = 2, dictCount = 10, dictMax: string | null = "2026-08-01T00:00:00.000Z") =>
  JSON.stringify([versao, null, docs, dictCount, dictMax, { bp: 3, dre: 4 }]);

const D1: [string, string, string, string | null, string | null] = ["aaa", "h1", "Aprovado", "lh1", "2026-08-01T10:00:00.000Z"];
const D2: [string, string, string, string | null, string | null] = ["bbb", "h2", "Aprovado", "lh2", "2026-08-01T10:00:00.000Z"];
const nomes = { aaa: "Balancete 05/2026", bbb: "Balanço 2025" };

describe("diferencasDaMarca · nada mudou é uma resposta", () => {
  it("marcas diferentes SÓ na ordem dos documentos: nenhuma causa, logo não está desatualizada", () => {
    // documentos do mesmo lote compartilham createdAt; a ordem do heap decide o
    // empate e muda a cada UPDATE de linha
    expect(diferencasDaMarca(marca([D1, D2]), marca([D2, D1]), nomes)).toEqual([]);
  });

  it("marcas idênticas: lista vazia", () => {
    expect(diferencasDaMarca(marca([D1, D2]), marca([D1, D2]), nomes)).toEqual([]);
  });

  it("versão do motor mudou: motivo NOMEADO, não o genérico", () => {
    const r = diferencasDaMarca(marca([D1], 2), marca([D1], 3), nomes);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/motor da base contábil mudou de versão/);
  });
});

describe("diferencasDaMarca · mudança de verdade continua sendo apontada", () => {
  it("documento novo na base", () => {
    expect(diferencasDaMarca(marca([D1]), marca([D1, D2]), nomes)[0]).toMatch(/"Balanço 2025" entrou na base/);
  });

  it("arquivo trocado (hash diferente)", () => {
    const alt: typeof D1 = ["aaa", "h9", "Aprovado", "lh1", "2026-08-01T10:00:00.000Z"];
    expect(diferencasDaMarca(marca([D1]), marca([alt]), nomes)[0]).toMatch(/teve o ARQUIVO trocado/);
  });

  it("documento relido na Data room", () => {
    const alt: typeof D1 = ["aaa", "h1", "Aprovado", "lh9", "2026-08-02T10:00:00.000Z"];
    expect(diferencasDaMarca(marca([D1]), marca([alt]), nomes)[0]).toMatch(/foi LIDO de novo/);
  });

  it("dicionário ganhou classificações", () => {
    expect(diferencasDaMarca(marca([D1], 2, 10), marca([D1], 2, 14), nomes)[0]).toMatch(/ganhou 4 classificação/);
  });

  it("formato ilegível continua pedindo reprocesso", () => {
    expect(diferencasDaMarca("nao-e-json", marca([D1]), nomes)[0]).toMatch(/mudou de formato/);
  });
});
