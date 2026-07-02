import { vi, describe, it, expect } from "vitest";

// foldBP não chama a IA, mas o módulo instancia o client no load — mock do SDK e da env.
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: vi.fn() } } }));
vi.mock("../config/env", () => ({ env: { anthropicApiKey: "test-key" } }));

import { foldBP } from "./ai-extraction";

const valorDe = (bp: any[], conta: string, p: string) => bp.find((l) => l.conta === conta)?.valores?.[p] ?? 0;

describe("foldBP — descarte de subtotal POR VALOR (caso Maniacs)", () => {
  it("descarta o pai quando os filhos capturados somam o valor dele (2021)", () => {
    const arvore = {
      "2021": {
        grupos: {
          "Passivo Não Circulante": [
            { nome: "OBRIGAÇÕES A LONGO PRAZO", valor: 2012221.4 }, // pai (soma dos 2 abaixo)
            { nome: "EMPRÉSTIMOS INSTITUIÇÕES FINANCEIRAS", valor: 1158515.97 },
            { nome: "OBRIGAÇÕES TRIBUTÁRIAS", valor: 853705.43 },
          ],
        },
      },
    } as any;
    const { bp } = foldBP(arvore, ["2021"]);
    // Subtotal do grupo NÃO duplica: PNC = 2.012.221,40 (não 4.024.442,80)
    const pnc = bp.find((l) => l.classificacao === "PNC" && l.nivel === 1);
    expect(pnc?.valores["2021"]).toBeCloseTo(2012221.4, 1);
    // Pai anotado como subtotal na trilha de auditoria
    const pai = arvore["2021"].grupos["Passivo Não Circulante"][0];
    expect(pai.destino).toContain("subtotal");
    // Filho tributário mapeado no destino certo (keyword + grupo LP)
    expect(valorDe(bp, "Obrigações Tributárias - LP", "2021")).toBeCloseTo(853705.43, 1);
    // Filho de empréstimos preservado no grupo (destino específico OU balde "Outros" —
    // o balde vira âmbar na auditoria e o analista classifica uma vez, alimentando o dicionário)
    const filhoEmprestimos =
      valorDe(bp, "Empréstimos e Financiamentos - LP", "2021") +
      valorDe(bp, "Outros Passivos não Circulantes", "2021");
    expect(filhoEmprestimos).toBeCloseTo(1158515.97, 1);
  });

  it("NÃO descarta quando não há filhos capturados (2020 — pai é o único portador)", () => {
    const arvore = {
      "2020": {
        grupos: {
          "Passivo Não Circulante": [
            { nome: "OBRIGAÇÕES A LONGO PRAZO", valor: 701005.6 },
            { nome: "OUTRAS OBRIGAÇÕES A LONGO PRAZO", valor: 1163843.0 },
          ],
        },
      },
    } as any;
    const { bp } = foldBP(arvore, ["2020"]);
    const pnc = bp.find((l) => l.classificacao === "PNC" && l.nivel === 1);
    // Nada some: os dois valores permanecem no grupo
    expect(pnc?.valores["2020"]).toBeCloseTo(701005.6 + 1163843.0, 1);
  });

  it("pareamento 1-para-1 só descarta com nomes contidos; valores iguais de contas distintas ficam", () => {
    const arvore = {
      "2021": {
        grupos: {
          "Passivo Não Circulante": [
            // duplicata pai/filho (nomes contidos) → descarta um
            { nome: "OUTRAS OBRIGAÇÕES A LONGO PRAZO", valor: 1157553.33 },
            { nome: "OUTRAS OBRIGAÇÕES", valor: 1157553.33 },
          ],
          "Ativo Circulante": [
            // mesmos valores, contas DISTINTAS → mantém as duas
            { nome: "Clientes", valor: 10000 },
            { nome: "Estoques", valor: 10000 },
          ],
        },
      },
    } as any;
    const { bp } = foldBP(arvore, ["2021"]);
    const pnc = bp.find((l) => l.classificacao === "PNC" && l.nivel === 1);
    expect(pnc?.valores["2021"]).toBeCloseTo(1157553.33, 1); // uma vez, não duas
    const ac = bp.find((l) => l.classificacao === "AC" && l.nivel === 1);
    expect(ac?.valores["2021"]).toBeCloseTo(20000, 1); // nada descartado
  });
});
