import { describe, it, expect } from "vitest";
import { mensagemDuplicado, avisoProdutosVinculados, type DocDuplicado, type ProdutoVinculado } from "./duplicidade-docs";

// Trava de duplicidade + substituição informada (pedido do usuário, 27/07/2026).

describe("mensagemDuplicado", () => {
  const base: DocDuplicado = { id: "x", nome: "Balancete Jun-26.pdf", tipo: "Balancete", competencia: "2026-06", versao: 1, analysisId: null };

  it("aponta a linha do pool com competência e orienta a Substituição", () => {
    const msg = mensagemDuplicado(base);
    expect(msg).toContain("na Data room da empresa");
    expect(msg).toContain("Balancete Jun-26.pdf");
    expect(msg).toContain("competência 2026-06");
    expect(msg).toContain("Substituição");
  });

  it("diferencia documento que vive em um IBR e mostra a versão quando > 1", () => {
    const msg = mensagemDuplicado({ ...base, analysisId: "ibr-1", versao: 3, competencia: null });
    expect(msg).toContain("em um IBR desta empresa");
    expect(msg).toContain("v3");
    expect(msg).not.toContain("competência");
  });
});

describe("avisoProdutosVinculados", () => {
  it("null sem vínculo (substituição livre, sem alarme falso)", () => {
    expect(avisoProdutosVinculados([])).toBeNull();
  });

  it("lista os produtos e dá o caminho: reprocessar aberto, nova versão para concluído", () => {
    const produtos: ProdutoVinculado[] = [
      { id: "a", nome: "IBR Belagro 2025", status: "Concluída", produto: "IBR" },
      { id: "m", nome: "Valuation Belagro", status: "—", produto: "Modelo financeiro" },
    ];
    const msg = avisoProdutosVinculados(produtos)!;
    expect(msg).toContain("2 produto(s)");
    expect(msg).toContain('IBR "IBR Belagro 2025" (Concluída)');
    expect(msg).toContain('Modelo financeiro "Valuation Belagro"');
    expect(msg).toContain("NOVA VERSÃO");
    expect(msg).toContain("REPROCESSADO");
  });
});
