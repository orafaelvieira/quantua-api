import { describe, expect, it } from "vitest";
import type { BPLineItem, DRELineItem } from "../types/financial";
import { montarCardsDecisao, MESES_CAIXA_MINIMO_PADRAO } from "./cards-decisao";

const P0 = "31/12/2023";
const P1 = "31/12/2024";

const bpL = (classificacao: string, conta: string, nivel: number, v: Record<string, number>): BPLineItem =>
  ({ classificacao, conta, nivel, editado: false, valores: v });
const dreL = (conta: string, subtotal: boolean, v: Record<string, number>): DRELineItem =>
  ({ conta, subtotal, editado: false, valores: v });

/** Empresa de serviços: caixa razoável, sem dívida bancária, lucro que vira caixa. */
function cenario() {
  const bp: BPLineItem[] = [
    bpL("AF", "Caixa e Equivalentes de Caixa", 2, { [P0]: 1_200_000, [P1]: 1_500_000 }),
    bpL("AO", "Contas a Receber - CP", 2, { [P0]: 800_000, [P1]: 900_000 }),
    bpL("PF", "Empréstimos e Financiamentos - CP", 2, { [P0]: 200_000, [P1]: 150_000 }),
    bpL("PL", "Patrimônio Líquido", 1, { [P0]: 2_000_000, [P1]: 2_300_000 }),
  ];
  const dre: DRELineItem[] = [
    dreL("Receita Líquida", true, { [P0]: 8_000_000, [P1]: 9_000_000 }),
    dreL("Custo Operacional", false, { [P0]: -3_000_000, [P1]: -3_600_000 }),
    dreL("Despesas com Pessoas", false, { [P0]: -1_800_000, [P1]: -2_000_000 }),
    dreL("Impostos s/ Faturamento", false, { [P0]: -600_000, [P1]: -700_000 }),
    dreL("Despesas Financeiras", false, { [P0]: -40_000, [P1]: -30_000 }),
    dreL("Depreciação e Amortização", false, { [P0]: -200_000, [P1]: -220_000 }),
    dreL("Lucro Líquido", true, { [P0]: 1_000_000, [P1]: 1_200_000 }),
  ];
  const fluxoCaixa = {
    colunas: [P1],
    fco: [{ nome: "Lucro Líquido do período", valores: { [P1]: 1_200_000 } }],
    fci: [{ nome: "Aquisições de Imobilizado/Intangível (capex bruto estimado)", valores: { [P1]: -150_000 } }],
    fcf: [],
    totais: { fco: { [P1]: 1_100_000 }, fci: { [P1]: -150_000 }, fcf: { [P1]: -650_000 }, geracaoTotal: { [P1]: 300_000 } },
    prova: [{ periodo: P1, caixaInicial: 1_200_000, caixaFinal: 1_500_000, deltaObservado: 300_000, deltaCalculado: 300_000, fecha: true }],
    avisos: [],
  };
  const indicadores = [
    { nome: "Liquidez Corrente", valores: { [P1]: 2.8 } },
    { nome: "Dívida Líquida/EBITDA", valores: { [P1]: -0.5 } },
    { nome: "Margem EBITDA", valores: { [P1]: 0.29 } },
  ];
  return { bp, dre, periodos: [P0, P1], fluxoCaixa: fluxoCaixa as never, indicadores };
}

describe("cards de decisão", () => {
  it("distribuição segura: caixa − reserva de 3 meses − dívida de curto prazo", () => {
    const r = montarCardsDecisao(cenario())!;
    const card = r.cards.find((c) => c.id === "distribuicao")!;
    expect(card.pergunta).toContain("dividendos");
    // Desembolso: 3,6M + 2,0M + 0,7M + 0,03M − 0,22M(D&A) = 6,11M/ano ≈ 16.740/dia
    // Reserva 3 meses ≈ 1,507 mi > caixa de 1,5 mi → sobra negativa com dívida CP.
    const linhaSobra = card.linhas.find((l) => l.destaque)!;
    expect(linhaSobra.rotulo).toBe("Distribuição segura");
    expect(linhaSobra.bruto!).toBeLessThan(0);
    expect(card.status).toBe("critico");
    expect(card.resposta).toMatch(/Não há folga/i);
    // A premissa do prazo aparece SEMPRE — o número sozinho não decide nada.
    expect(card.edicao).toMatchObject({ chave: "mesesCaixaMinimo", valor: MESES_CAIXA_MINIMO_PADRAO });
    expect(card.edicao!.depois).toMatch(/desembolso operacional/i);
    expect(card.premissas.join(" ")).toMatch(/cronograma de vencimentos/i);
    // A frase editável NÃO se repete na lista fixa: a tela desenha uma só vez.
    expect(card.premissas.join(" ")).not.toMatch(/Reserva mínima/i);
  });

  it("premissa de caixa mínimo é editável e muda a conta", () => {
    const r = montarCardsDecisao(cenario(), { premissas: { mesesCaixaMinimo: 1 } })!;
    const card = r.cards.find((c) => c.id === "distribuicao")!;
    expect(card.linhas.find((l) => l.destaque)!.bruto!).toBeGreaterThan(0); // com 1 mês, há folga
    // O card devolve a premissa vigente: a tela não precisa consultar o cadastro
    // para saber o que desenhar no campo (e não corre risco de mostrar outro valor).
    expect(card.edicao!.valor).toBe(1);
    // "1 meses" num documento que vai ao cliente denuncia texto de máquina.
    expect(`${card.edicao!.antes} 1 ${card.edicao!.depois}`).toContain("1 mês de desembolso");
    expect(JSON.stringify(card)).not.toMatch(/\b1 meses\b/);
  });

  it("covenants: casa pelo NOME do indicador, como o analista digita na aba Covenants", () => {
    // A entrada REAL de produção: `metric` é texto livre com o nome do indicador
    // (a aba Covenants resolve assim). Testar com chave camelCase deixava a suíte
    // verde e a produção dizendo "nenhum covenant verificável".
    const r = montarCardsDecisao(cenario(), {
      covenants: [
        { name: "Liquidez mínima", metric: "Liquidez Corrente", operator: ">=", threshold: 1.2 },
        { name: "Alavancagem", metric: "  dívida líquida/ebitda ", operator: "<=", threshold: 3 },
        { name: "Serviço da dívida", metric: "DSCR", operator: ">=", threshold: 1.3 },
      ],
    })!;
    const card = r.cards.find((c) => c.id === "covenants")!;
    expect(card.linhas).toHaveLength(2); // dscr não é verificável
    expect(card.linhas.every((l) => /cumprido/.test(l.valor))).toBe(true);
    expect(card.status).toBe("ok");
    expect(card.premissas.join(" ")).toContain("Serviço da dívida");
    expect(card.premissas.join(" ")).toMatch(/DSCR/);
  });

  it("covenant descumprido vira crítico e destaca a linha", () => {
    const r = montarCardsDecisao(cenario(), {
      covenants: [{ name: "Liquidez mínima", metric: "Liquidez Corrente", operator: ">=", threshold: 3.5 }],
    })!;
    const card = r.cards.find((c) => c.id === "covenants")!;
    expect(card.status).toBe("critico");
    expect(card.linhas[0]!.destaque).toBe(true);
    expect(card.linhas[0]!.valor).toMatch(/descumprido/);
  });

  it("chave camelCase legada continua resolvendo", () => {
    const r = montarCardsDecisao(cenario(), {
      covenants: [{ name: "Alavancagem", metric: "netDebtEbitda", operator: "<=", threshold: 3 }],
    })!;
    expect(r.cards.find((c) => c.id === "covenants")!.linhas).toHaveLength(1);
  });

  it("covenant na borda do limite é 'no limite', com a mesma régua da aba Covenants", () => {
    // Liquidez corrente 2,8 contra mínimo 2,6: dentro dos 10% → amber lá e aqui.
    const r = montarCardsDecisao(cenario(), {
      covenants: [{ name: "Liquidez mínima", metric: "Liquidez Corrente", operator: ">=", threshold: 2.6 }],
    })!;
    const card = r.cards.find((c) => c.id === "covenants")!;
    expect(card.status).toBe("atencao");
    expect(card.linhas[0]!.valor).toMatch(/no limite/);
  });

  it("prejuízo não vira taxa de conversão", () => {
    // Prejuízo com operação gerando caixa (D&A alta) — o caso distressed típico.
    // Dividir daria -0,5 e o card gritaria "crítico" numa operação que gera caixa.
    const d = cenario();
    d.dre = d.dre.map((l) => (l.conta === "Lucro Líquido" ? { ...l, valores: { [P0]: -800_000, [P1]: -2_000_000 } } : l));
    const card = montarCardsDecisao(d)!.cards.find((c) => c.id === "qualidade-lucro")!;
    expect(card.status).toBe("atencao"); // gera caixa apesar do prejuízo
    expect(card.resposta).toMatch(/prejuízo/i);
    expect(card.resposta).not.toMatch(/-0,5|-0\.5/);
    expect(card.premissas.join(" ")).toMatch(/não existe taxa de conversão/i);
  });

  it("prejuízo com caixa negativo é crítico", () => {
    const d = cenario();
    d.dre = d.dre.map((l) => (l.conta === "Lucro Líquido" ? { ...l, valores: { [P0]: -800_000, [P1]: -2_000_000 } } : l));
    (d.fluxoCaixa as never as { totais: { fco: Record<string, number> } }).totais.fco[P1] = -900_000;
    const card = montarCardsDecisao(d)!.cards.find((c) => c.id === "qualidade-lucro")!;
    expect(card.status).toBe("critico");
    expect(card.resposta).toMatch(/saindo do bolso/i);
  });

  it("período parcial anualiza o efeito da margem e declara o fator", () => {
    // Balancete YTD de 5 meses: "por ano" sobre a receita de 5 meses subestima 2,4x.
    const P = "31/05/2026";
    const d = {
      ...cenario(),
      periodos: [P],
      arvoresBalancete: [{ periodo: P }],
      dre: [
        { conta: "Receita Líquida", subtotal: true, editado: false, valores: { [P]: 3_000_000 } },
        { conta: "Custo Operacional", subtotal: false, editado: false, valores: { [P]: -1_200_000 } },
      ] as never,
      bp: [{ classificacao: "AF", conta: "Caixa e Equivalentes de Caixa", nivel: 2, editado: false, valores: { [P]: 500_000 } }] as never,
    };
    const card = montarCardsDecisao(d)!.cards.find((c) => c.id === "sensibilidade")!;
    const margem = card.linhas.find((l) => /ponto percentual/.test(l.rotulo))!;
    // 1% de 3 mi = 30 mil no período; anualizado por 150 dias ≈ 73 mil.
    expect(margem.bruto!).toBeGreaterThan(70_000);
    expect(card.premissas.join(" ")).toMatch(/anualizado/i);
  });

  it("reinvestimento: capex abaixo da depreciação acende atenção", () => {
    const d = cenario();
    const r = montarCardsDecisao(d)!;
    const card = r.cards.find((c) => c.id === "reinvestimento")!;
    // capex 150k ÷ D&A 220k = 0,68x — abaixo de 1
    expect(card.linhas[0]!.bruto!).toBeCloseTo(0.68, 2);
    expect(card.resposta).toMatch(/investe menos/i);
  });

  it("qualidade do lucro: mede quanto do lucro virou caixa", () => {
    const r = montarCardsDecisao(cenario())!;
    const card = r.cards.find((c) => c.id === "qualidade-lucro")!;
    // FCO 1,1 mi ÷ lucro 1,2 mi = 0,92x
    expect(card.status).toBe("ok");
    expect(card.resposta).toMatch(/vira caixa/i);
  });

  it("sensibilidade declara o que NÃO é calculável sem fixo × variável", () => {
    const r = montarCardsDecisao(cenario())!;
    const card = r.cards.find((c) => c.id === "sensibilidade")!;
    expect(card.linhas[0]!.rotulo).toMatch(/1 dia a menos para receber/);
    expect(card.linhas[0]!.bruto!).toBeCloseTo(9_000_000 / 365, 0);
    expect(card.premissas.join(" ")).toMatch(/fixo × variável/i);
  });

  it("nenhum card mostra data de fechamento crua ao leitor", () => {
    // Regra do dono: exercício se lê "2024", mês se lê "05/2026". "31/12/2024" é
    // chave do dado, não linguagem de relatório — e vazava nas linhas dos cards.
    const r = montarCardsDecisao(cenario(), {
      covenants: [{ name: "Liquidez mínima", metric: "currentRatio", operator: ">=", threshold: 1.2 }],
    })!;
    const texto = JSON.stringify(r.cards);
    expect(texto).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(r.cards.find((c) => c.id === "qualidade-lucro")!.linhas.map((l) => l.rotulo)).toEqual(["2024"]);
  });

  it("período de balancete se lê como mês, mesmo fechando em dezembro", () => {
    const d = cenario();
    // Balancete acumulado até 31/12/2024: é YTD, então o rótulo é 12/2024.
    const r = montarCardsDecisao({ ...d, arvoresBalancete: [{ periodo: P1 }] })!;
    expect(r.periodo).toBe(P1); // a CHAVE do dado não muda
    expect(JSON.stringify(r.cards)).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it("sem dados não inventa card", () => {
    expect(montarCardsDecisao({ periodos: [] })).toBeNull();
  });
});
