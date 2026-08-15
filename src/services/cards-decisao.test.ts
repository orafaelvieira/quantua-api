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
    // Empréstimo de sócio/empresa ligada: dívida de curto prazo como qualquer outra.
    bpL("PF", "Passivos com Partes Relacionadas - CP", 2, { [P0]: 60_000, [P1]: 50_000 }),
    bpL("PNC", "Empréstimos e Financiamentos - LP", 2, { [P0]: 900_000, [P1]: 700_000 }),
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
    // Sem folga HOJE, mas a operação gera caixa e recompõe a diferença rápido:
    // isso é atenção, não crítico. Marcar crítico numa empresa sem dívida que
    // gera caixa foi o primeiro defeito que o dono viu na tela real.
    expect(card.status).toBe("atencao");
    expect(card.resposta).toMatch(/Nada a distribuir hoje/i);
    expect(card.resposta).toMatch(/recompõe.*em cerca de \d+ (mês|meses)/i);
    // A conta PARA na linha de destaque — a geração recorrente não é parcela dela.
    expect(card.linhas[card.linhas.length - 1]!.rotulo).toBe("Distribuição segura");
    // A premissa do prazo aparece SEMPRE — o número sozinho não decide nada.
    expect(card.edicao).toMatchObject({ chave: "mesesCaixaMinimo", valor: MESES_CAIXA_MINIMO_PADRAO });
    expect(card.edicao!.depois).toMatch(/desembolso operacional/i);
    expect(card.premissas.join(" ")).toMatch(/cronograma de vencimentos/i);
    // A frase editável NÃO se repete na lista fixa: a tela desenha uma só vez.
    expect(card.premissas.join(" ")).not.toMatch(/Reserva mínima/i);
  });

  it("dívida de curto prazo soma empréstimo de sócio, não só o bancário", () => {
    const card = montarCardsDecisao(cenario())!.cards.find((c) => c.id === "distribuicao")!;
    const linha = card.linhas.find((l) => /Dívida de curto prazo/.test(l.rotulo))!;
    expect(linha.bruto).toBe(-200_000); // 150k bancário + 50k partes relacionadas
    // A dívida de longo prazo não entra na subtração, mas é declarada.
    expect(card.premissas.join(" ")).toContain("Dívida total");
    expect(card.premissas.join(" ")).toMatch(/vencem depois do exercício/);
  });

  it("dívida só no longo prazo não vira 'R$ 0' mudo", () => {
    const d = cenario();
    d.bp = d.bp.filter((l) => !/- CP$/.test(l.conta) || !/Empréstimos|Partes Relacionadas/.test(l.conta));
    const card = montarCardsDecisao(d)!.cards.find((c) => c.id === "distribuicao")!;
    const linha = card.linhas.find((l) => /Dívida de curto prazo/.test(l.rotulo))!;
    expect(linha.rotulo).toContain("toda no longo prazo");
    expect(card.premissas.join(" ")).toContain("Dívida total");
  });

  it("empresa sem dívida nenhuma diz isso, em vez de calar", () => {
    const d = cenario();
    d.bp = d.bp.filter((l) => !/Empréstimos|Partes Relacionadas/.test(l.conta));
    const card = montarCardsDecisao(d)!.cards.find((c) => c.id === "distribuicao")!;
    expect(card.premissas.join(" ")).toMatch(/não tem dívida financeira registrada/i);
  });

  it("crítico é quando a operação NÃO repõe a reserva", () => {
    const d = cenario();
    // Mesma falta de caixa, mas a operação queima em vez de gerar.
    (d.fluxoCaixa as never as { totais: { fco: Record<string, number> } }).totais.fco[P1] = -400_000;
    const card = montarCardsDecisao(d)!.cards.find((c) => c.id === "distribuicao")!;
    expect(card.status).toBe("critico");
    expect(card.resposta).toMatch(/não está gerando caixa para repor/i);
  });

  it("geração que levaria mais de um ano para repor não vira promessa", () => {
    const d = cenario();
    (d.fluxoCaixa as never as { totais: { fco: Record<string, number> } }).totais.fco[P1] = 160_000;
    const card = montarCardsDecisao(d)!.cards.find((c) => c.id === "distribuicao")!;
    expect(card.status).toBe("critico");
    expect(card.resposta).toMatch(/mais de um ano/i);
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

  it("balancete que fecha em dezembro é o EXERCÍCIO, não o mês 12", () => {
    // O acumulado do balancete termina em 31/12: cobre o ano inteiro. Rotular
    // "12/2024" fazia um exercício cheio parecer um mês na tela do cliente.
    const r = montarCardsDecisao({ ...cenario(), arvoresBalancete: [{ periodo: P1 }] })!;
    expect(r.periodo).toBe(P1); // a CHAVE do dado não muda
    expect(r.periodoRotulo).toBe("2024");
    expect(JSON.stringify(r.cards)).not.toMatch(/12\/2024/);
  });

  it("balancete que para no meio do ano se lê como mês", () => {
    const P = "31/05/2026";
    const d = {
      ...cenario(),
      periodos: [P],
      arvoresBalancete: [{ periodo: P }],
      dre: [{ conta: "Receita Líquida", subtotal: true, editado: false, valores: { [P]: 3_000_000 } }] as never,
      bp: [{ classificacao: "AF", conta: "Caixa e Equivalentes de Caixa", nivel: 2, editado: false, valores: { [P]: 500_000 } }] as never,
    };
    expect(montarCardsDecisao(d)!.periodoRotulo).toBe("05/2026");
  });

  it("sem dados não inventa card", () => {
    expect(montarCardsDecisao({ periodos: [] })).toBeNull();
  });
});
