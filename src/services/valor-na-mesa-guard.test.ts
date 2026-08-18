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
  // FALSOS POSITIVOS apontados na revisão adversarial: `(patrim|pl)` sem fronteira
  // casava du-PL-icatas, a-PL-icado, re-PL-anejamento; e o padrão de custo financeiro
  // rodava sobre a MEMÓRIA, que é prosa diagnóstica e cita juros por construção.
  it.each([
    ["Redução do saldo de duplicatas a receber", "carteira vencida de R$ 3,1 mi sem cobrança ativa"],
    ["Redução do desconto comercial aplicado ao canal atacado", "desconto médio de 4,2% sobre tabela"],
    ["Redução de custo com replanejamento das rotas de frete", "frete subiu de 4,15% para 5,05% da receita"],
    ["Renegociar o contrato de frete rodoviário", "hoje é bancado por capital de giro, com despesa financeira de 3% a.m."],
    ["Recuperar créditos tributários de ICMS", "R$ 3,05 mi em tributos a recuperar parados há 3 exercícios"],
    ["Capitalizar a empresa com aporte dos sócios", "reduz a dependência de dívida curta"],
  ])("DEIXA PASSAR alavanca legítima: %s", (titulo, memoria) => {
    expect(alavancaDeIAPassa({ titulo, memoria })).toBe(true);
  });

  it("continua vetando quando o gatilho está no lugar certo", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(alavancaDeIAPassa({ titulo: "Reduzir o custo financeiro migrando para custeio agrícola", memoria: "" })).toBe(false);
    expect(alavancaDeIAPassa({ titulo: "Recompor capital", memoria: "a variação do patrimônio líquido no semestre" })).toBe(false);
  });
});
