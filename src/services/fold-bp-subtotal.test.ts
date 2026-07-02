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

describe("foldBP v2 — árvore completa (hierarquia real da Maniacs)", () => {
  it("2020 PC: classifica no nó mais alto que mapeia — composição EXATA, Outros = 0", () => {
    // Estrutura fiel do balanço 2020 (pais com subtotal declarado + filhos aninhados)
    const arvore = {
      "2020": {
        grupos: {
          "Passivo Circulante": [
            { nome: "INSTITUIÇÕES FINANCEIRAS", valor: 784747.13, filhos: [{ nome: "EMPRÉSTIMOS", valor: 784747.13 }] },
            { nome: "FORNECEDORES", valor: 3810318.43, filhos: [{ nome: "FORNECEDORES NACIONAIS", valor: 3810318.43 }] },
            { nome: "OBRIGAÇÕES TRIBUTÁRIAS", valor: 2143932.09, filhos: [
              { nome: "IMPOSTOS E CONTRIBUIÇÕES A RECOLHER", valor: 1234394.88 },
              { nome: "TRIBUTOS RETIDOS A RECOLHER", valor: 19124.08 },
              { nome: "PARCELAMENTO DE IMPOSTOS", valor: 890413.13 },
            ]},
            { nome: "OBRIGAÇÕES TRABALHISTAS E PRIVIDENCIÁRIAS", valor: 480539.43, filhos: [
              { nome: "OBRIGAÇÕES COM O PESSOAL", valor: 72390.40 },
              { nome: "OBRIGAÇÕES PREVIDENCIÁRIAS", valor: 344982.49 },
              { nome: "PROVISÕES", valor: 63166.54 },
            ]},
            { nome: "OUTRAS OBRIGAÇÕES", valor: 2348859.91, filhos: [{ nome: "ADIANTAMENTOS DE CLIENTES", valor: 2348859.91 }] },
          ],
        },
      },
    } as any;
    // Espelha a produção: o dicionário global tem "Adiantamentos de Clientes" (plural).
    const dict = [{ nomeOriginal: "Adiantamentos de Clientes", contaDestino: "Despesas Ant. / Adiantamentos - Passivo", grupoConta: "Passivo Circulante" }];
    const { bp, naoMapeados, alertasComposicao } = foldBP(arvore, ["2020"], dict);
    // Composição EXATA no nível semântico (o bug real: OT vinha 1.234.394,88)
    expect(valorDe(bp, "Obrigações Tributárias - CP", "2020")).toBeCloseTo(2143932.09, 1);
    expect(valorDe(bp, "Obrigações Trabalhistas - CP", "2020")).toBeCloseTo(480539.43, 1);
    expect(valorDe(bp, "Fornecedores - CP", "2020")).toBeCloseTo(3810318.43, 1);
    // NADA no balde e nada órfão
    expect(valorDe(bp, "Outros Passivos Circulantes", "2020")).toBeCloseTo(0, 1);
    expect(naoMapeados.filter((n) => n.periodo === "2020").length).toBe(0);
    // Total do grupo = declarado no documento
    const pc = bp.find((l) => l.classificacao === "PC" && l.nivel === 1);
    expect(pc?.valores["2020"]).toBeCloseTo(9568396.99, 1);
    // Documento internamente consistente → sem alertas de composição
    expect(alertasComposicao.length).toBe(0);
  });

  it("2020 PNC: pai estrutural desce para os filhos; tributos LP no destino certo", () => {
    const arvore = {
      "2020": {
        grupos: {
          "Passivo Não Circulante": [
            { nome: "OBRIGAÇÕES A LONGO PRAZO", valor: 701005.60, filhos: [
              { nome: "OBRIGAÇÕES TRIBUTÁRIAS", valor: 701005.60 },
            ]},
            { nome: "OUTRAS OBRIGAÇÕES A LONGO PRAZO", valor: 1163842.99, filhos: [
              { nome: "OUTRAS OBRIGAÇÕES", valor: 1163842.99 },
            ]},
          ],
        },
      },
    } as any;
    const { bp } = foldBP(arvore, ["2020"]);
    // O agrupador não mapeia (removido do dicionário) → estrutural → filho classifica
    expect(valorDe(bp, "Obrigações Tributárias - LP", "2020")).toBeCloseTo(701005.60, 1);
    const pnc = bp.find((l) => l.classificacao === "PNC" && l.nivel === 1);
    expect(pnc?.valores["2020"]).toBeCloseTo(1864848.59, 1);
  });

  it("folha ambígua herda contexto do pai (Provisões sob Obrigações Trabalhistas)", () => {
    const arvore = {
      "2021": {
        grupos: {
          "Passivo Circulante": [
            { nome: "OBRIGAÇÕES TRABALHISTAS E PREV XYZ ATÍPICO", valor: 100, filhos: [
              { nome: "PROVISÕES", valor: 100 },
            ]},
          ],
        },
      },
    } as any;
    const { bp } = foldBP(arvore, ["2021"]);
    // Pai atípico não mapeia → estrutural; "PROVISÕES" sozinho é ambíguo, mas com o
    // contexto "…TRABALHISTAS… PROVISÕES" o keyword resolve para Obrigações Trabalhistas - CP.
    expect(valorDe(bp, "Obrigações Trabalhistas - CP", "2021")).toBeCloseTo(100, 1);
  });

  it("prova de composição: filho faltando na captura → delta preservado em Outros + alerta", () => {
    const arvore = {
      "2021": {
        grupos: {
          "Passivo Não Circulante": [
            { nome: "AGRUPADOR QUALQUER XPTO", valor: 1000, filhos: [
              { nome: "SUBCONTA QUALQUER ZWK", valor: 600 }, // faltam 400 (não capturados)
            ]},
          ],
        },
      },
    } as any;
    const { bp, alertasComposicao } = foldBP(arvore, ["2021"]);
    const pnc = bp.find((l) => l.classificacao === "PNC" && l.nivel === 1);
    expect(pnc?.valores["2021"]).toBeCloseTo(1000, 1); // total do documento NUNCA se perde
    expect(alertasComposicao.length).toBe(1);
    expect(alertasComposicao[0].delta).toBeCloseTo(400, 1);
    expect(alertasComposicao[0].caminho).toContain("AGRUPADOR QUALQUER XPTO");
  });

  it("nó mapeado absorve a subárvore (filhos não duplicam) e audita a absorção", () => {
    const arvore = {
      "2021": {
        grupos: {
          "Passivo Circulante": [
            { nome: "OBRIGAÇÕES TRIBUTÁRIAS", valor: 500, filhos: [
              { nome: "ICMS A RECOLHER", valor: 300 },
              { nome: "PIS A RECOLHER", valor: 200 },
            ]},
          ],
        },
      },
    } as any;
    const { bp } = foldBP(arvore, ["2021"]);
    expect(valorDe(bp, "Obrigações Tributárias - CP", "2021")).toBeCloseTo(500, 1); // uma vez só
    const pc = bp.find((l) => l.classificacao === "PC" && l.nivel === 1);
    expect(pc?.valores["2021"]).toBeCloseTo(500, 1);
    const filhos = arvore["2021"].grupos["Passivo Circulante"][0].filhos;
    expect(filhos[0].destino).toContain("absorvido");
  });
});
