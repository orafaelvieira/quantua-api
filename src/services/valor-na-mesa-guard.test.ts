import { describe, it, expect, vi } from "vitest";
import { alavancaDeIAPassa } from "./claude";

// Alavancas REAIS que a IA emitiu no IBR Belagro de 18/08/2026 e que o apêndice
// do próprio relatório desmente. O filtro antigo era só de magnitude e as aceitou.
describe("trava de natureza das alavancas de IA", () => {
  it("veta a que deriva do plug do fluxo de caixa (variação de PL passada)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(alavancaDeIAPassa({
      titulo: "Preservação de caixa pela suspensão de distribuição de lucro durante o aperto",
      memoria: "O fluxo de caixa registrou saída de aproximadamente R$ 15,3 milhões em ajustes do patrimônio em dezembro de 2025",
    })).toBe(false);
  });

  it("veta a de custo financeiro — o motor já publica o card determinístico", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(alavancaDeIAPassa({
      titulo: "Redução do custo financeiro pela migração de dívida curta para custeio agrícola de prazo casado",
      memoria: "As despesas financeiras rodam perto de R$ 7 milhões por período recente sobre uma dívida de R$ 68,9 milhões",
    })).toBe(false);
  });

  it("veta 'ajuste do patrimônio líquido' mesmo com outro título", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(alavancaDeIAPassa({ titulo: "Recompor a base de capital", memoria: "a queda do patrimônio líquido de R$ 12,7 mi" })).toBe(false);
  });

  it("DEIXA PASSAR alavanca legítima de fluxo futuro", () => {
    expect(alavancaDeIAPassa({
      titulo: "Desmobilizar o galpão ocioso da filial de Tailândia",
      memoria: "Ativo não operacional de R$ 4,2 milhões parado desde jun/2024, sem receita associada",
    })).toBe(true);
    expect(alavancaDeIAPassa({
      titulo: "Renegociar o contrato de frete rodoviário",
      memoria: "Frete subiu de 4,15% para 5,05% da receita líquida entre 2025 e 05/2026",
    })).toBe(true);
  });
});
