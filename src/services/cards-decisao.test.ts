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
    // Subtotal do modelo padrão (Receita Líquida − Custo − despesas operacionais):
    // é daqui que o card de headroom tira o EBITDA, como o próprio motor faz.
    dreL("EBITDA", true, { [P0]: 3_200_000, [P1]: 3_400_000 }),
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
  // Os indicadores são a FONTE ÚNICA dos cards — os valores abaixo são os que o
  // motor calcularia deste BP/DRE (dívida líquida = 900k de dívida − 1,5 mi de
  // caixa; ROE = 1,2 mi / 2,3 mi; YoY = 9 mi / 8 mi − 1).
  // Tipo explícito: com séries de períodos diferentes por indicador, o inferido
  // vira união de literais com chaves opcionais e não casa mais com o motor.
  const indicadores: Array<{ nome: string; valores: Record<string, number> }> = [
    { nome: "Liquidez Corrente", valores: { [P1]: 2.8 } },
    { nome: "Dívida Líquida", valores: { [P0]: -40_000, [P1]: -600_000 } },
    { nome: "Dívida Líquida/EBITDA", valores: { [P1]: -0.18 } },
    { nome: "Margem EBITDA", valores: { [P1]: 0.29 } },
    { nome: "ROE (Retorno sobre Patrimônio Líquido)", valores: { [P0]: 0.5, [P1]: 0.52 } },
    { nome: "Crescimento da Receita (YoY)", valores: { [P1]: 0.125 } },
  ];
  return { bp, dre, periodos: [P0, P1], fluxoCaixa: fluxoCaixa as never, indicadores };
}

/** Referência do Banco Central para crédito PJ (CDI + spread médio), em decimal. */
const REF_CREDITO_PJ = 0.183;

/** Substitui um indicador da fixture — acrescentar outro com o mesmo nome não faz
 *  efeito: o motor resolve pelo PRIMEIRO que casa. */
const trocarIndicador = (
  d: ReturnType<typeof cenario>,
  nome: string,
  valores: Record<string, number>,
): void => {
  d.indicadores = d.indicadores.map((i) => (i.nome === nome ? ({ ...i, valores } as never) : i));
};

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

  it("dívida alta e retirada do período entram na resposta, mesmo sem vencer no exercício", () => {
    // O caso real que o dono trouxe: passivo circulante 100% operacional (dívida
    // de curto prazo = 0), R$ 9,98 mi de dívida em LONGO prazo (+123% no ano) e
    // ~R$ 10 mi saindo do PL. A conta do caixa sozinha prometia "volta a caber em
    // 9 meses". Distribuir nesse quadro não é decisão de 9 meses.
    const d = cenario();
    d.bp = [
      ...d.bp.filter((l) => !/Empréstimos|Partes Relacionadas/.test(l.conta)),
      bpL("PNC", "Empréstimos e Financiamentos - LP", 2, { [P0]: 4_473_684, [P1]: 9_979_329 }),
    ];
    // SUBSTITUI o indicador da fixture — acrescentar um segundo com o mesmo nome
    // não faz efeito: o motor (e a tela) resolvem pelo primeiro que casa.
    d.indicadores = d.indicadores.map((i) =>
      i.nome === "Dívida Líquida/EBITDA" ? ({ ...i, valores: { [P1]: 4.2 }, status: { [P1]: "critico" } } as never) : i,
    );
    (d.fluxoCaixa as never as { fcf: Array<{ nome: string; valores: Record<string, number> }> }).fcf = [
      { nome: "Dividendos e ajustes do PL (ΔPL − lucro − Δ capital)", valores: { [P1]: -10_040_000 } },
    ];
    const card = montarCardsDecisao(d)!.cards.find((c) => c.id === "distribuicao")!;

    expect(card.status).toBe("critico");
    expect(card.resposta).not.toMatch(/volta a caber/i);       // sem promessa
    expect(card.resposta).toMatch(/dívida total é R\$ 9,98 mi/i);
    expect(card.resposta).toMatch(/4,2x EBITDA/);
    expect(card.resposta).toMatch(/já saíram R\$ 10,04 mi do patrimônio/i);
    expect(card.premissas.join(" ")).toMatch(/variação do patrimônio líquido menos o lucro/i);
  });

  it("alavancagem acesa rebaixa o card mesmo com caixa sobrando", () => {
    const d = cenario();
    d.bp = d.bp.map((l) => (/Caixa/.test(l.conta) ? { ...l, valores: { [P0]: 9_000_000, [P1]: 9_000_000 } } : l));
    d.indicadores = d.indicadores.map((i) =>
      i.nome === "Dívida Líquida/EBITDA" ? ({ ...i, valores: { [P1]: 3.8 }, status: { [P1]: "atencao" } } as never) : i,
    );
    const card = montarCardsDecisao(d)!.cards.find((c) => c.id === "distribuicao")!;
    expect(card.linhas.find((l) => l.destaque)!.bruto!).toBeGreaterThan(0); // há folga de caixa
    expect(card.status).toBe("atencao");                                    // mas não é "ok"
    expect(card.resposta).toMatch(/aumenta a alavancagem/i);
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

  // ── Headroom de captação ────────────────────────────────────────────────────

  it("headroom: teto de 3x EBITDA menos a dívida líquida, com o limite declarado como premissa", () => {
    const card = montarCardsDecisao(cenario())!.cards.find((c) => c.id === "headroom-captacao")!;
    // EBITDA 3,4 mi × 3,0 = teto de 10,2 mi; dívida líquida −0,6 mi (mais caixa que
    // dívida) → espaço de 10,8 mi.
    expect(card.linhas.find((l) => /Teto de dívida líquida/.test(l.rotulo))!.bruto).toBe(10_200_000);
    const espaco = card.linhas.find((l) => l.destaque)!;
    expect(espaco.rotulo).toBe("Espaço para dívida nova");
    expect(espaco.bruto).toBe(10_800_000);
    expect(card.status).toBe("ok");
    // Caixa líquido não pode sair como "-−R$ 600 mil" na coluna de subtração.
    expect(card.linhas.find((l) => /Caixa líquido hoje/.test(l.rotulo))!.valor).toBe("+R$ 600 mil");
    expect(card.resposta).toMatch(/caixa líquido de R\$ 600 mil/);
    // O 3,0x é PREMISSA da casa — não pode sair da tela como regra de banco.
    expect(card.premissas.join(" ")).toMatch(/premissa desta análise, não uma exigência do banco/i);
    expect(card.premissas.join(" ")).toMatch(/cronograma de amortização/i);
    expect(card.premissas.join(" ")).toMatch(/Capacidade de tomar não é conveniência de tomar/i);
  });

  it("headroom: o covenant do IBR manda no limite; covenant de piso não é teto", () => {
    const card = montarCardsDecisao(cenario(), {
      covenants: [
        { name: "Alavancagem máxima", metric: "Dívida Líquida/EBITDA", operator: "<=", threshold: 2.5 },
        // Piso não responde "até quanto dá para tomar" — tem que ser ignorado.
        { name: "Piso de alavancagem", metric: "dívida líquida/ebitda", operator: ">=", threshold: 0.5 },
      ],
    })!.cards.find((c) => c.id === "headroom-captacao")!;
    expect(card.linhas.find((l) => /Limite de alavancagem/.test(l.rotulo))!.bruto).toBe(2.5);
    expect(card.linhas.find((l) => l.destaque)!.bruto).toBe(2.5 * 3_400_000 + 600_000);
    expect(card.premissas.join(" ")).toContain("Alavancagem máxima");
    expect(card.premissas.join(" ")).not.toMatch(/premissa desta análise/i);
  });

  it("headroom negativo é crítico: a conversa vira amortização, não captação", () => {
    const d = cenario();
    trocarIndicador(d, "Dívida Líquida", { [P0]: 12_000_000, [P1]: 15_000_000 });
    trocarIndicador(d, "Dívida Líquida/EBITDA", { [P1]: 4.4 });
    const card = montarCardsDecisao(d)!.cards.find((c) => c.id === "headroom-captacao")!;
    expect(card.linhas.find((l) => l.destaque)!.bruto).toBe(-4_800_000);
    expect(card.status).toBe("critico");
    expect(card.resposta).toMatch(/R\$ 4,80 mi acima do teto/);
    expect(card.resposta).toMatch(/amortizar ou renegociar/i);
    expect(card.resposta).toMatch(/alavancagem atual é 4,4x EBITDA/);
  });

  it("caixa líquido não vira 'alavancagem de -0,18x' na resposta", () => {
    // Múltiplo negativo é aritmética de quem tem mais caixa que dívida, não leitura
    // de alavancagem: na tela só confunde quem decide captar.
    const card = montarCardsDecisao(cenario())!.cards.find((c) => c.id === "headroom-captacao")!;
    expect(card.resposta).not.toMatch(/alavancagem atual/i);
    expect(card.resposta).not.toMatch(/-0,18x/);
  });

  it("headroom apertado perto da própria dívida acende atenção", () => {
    const d = cenario();
    // Teto de 10,2 mi contra dívida líquida de 9 mi: sobra 1,2 mi, ~13% da dívida.
    trocarIndicador(d, "Dívida Líquida", { [P0]: 8_000_000, [P1]: 9_000_000 });
    const card = montarCardsDecisao(d)!.cards.find((c) => c.id === "headroom-captacao")!;
    expect(card.status).toBe("atencao");
    expect(card.resposta).toMatch(/trimestre fraco de EBITDA consome esse espaço/i);
    // O espaço não é saldo: encolhe com o EBITDA, e o card mostra quanto.
    expect(card.linhas.find((l) => /10% a menos de EBITDA/.test(l.rotulo))!.bruto).toBe(1_020_000);
  });

  it("sem EBITDA no período o card de headroom não aparece", () => {
    const d = cenario();
    d.dre = d.dre.filter((l) => l.conta !== "EBITDA");
    d.indicadores = d.indicadores.filter((i) => i.nome !== "Margem EBITDA");
    expect(montarCardsDecisao(d)!.cards.find((c) => c.id === "headroom-captacao")).toBeUndefined();
  });

  // ── Custo da dívida ─────────────────────────────────────────────────────────

  it("custo da dívida: despesa financeira sobre a dívida MÉDIA, contra a referência de crédito PJ", () => {
    const d = cenario();
    d.dre = d.dre.map((l) => (l.conta === "Despesas Financeiras" ? { ...l, valores: { [P0]: -230_000, [P1]: -260_000 } } : l));
    const card = montarCardsDecisao(d, { benchmarks: { custoMedioDivida: REF_CREDITO_PJ } })!
      .cards.find((c) => c.id === "custo-divida")!;
    // Dívida das QUATRO contas: 1,16 mi (2023) e 0,9 mi (2024) → média 1,03 mi.
    expect(card.linhas.find((l) => /Dívida média/.test(l.rotulo))!.bruto).toBe(1_030_000);
    // 260 mil / 1,03 mi = 25,2% a.a. — acima de 1,3× a referência de 18,3%.
    expect(card.linhas.find((l) => l.destaque)!.bruto!).toBeCloseTo(0.2524, 4);
    // A fixture não traz semáforo de alavancagem nem de cobertura: sem perfil de
    // risco, o desvio NÃO vira veredicto (correção do dono, 16/08) — o card
    // informa e manda conferir composição e data de contratação.
    expect(card.status).toBe("informativo");
    expect(card.resposta).toMatch(/acima da referência de mercado para crédito PJ/i);
    // Efeito em R$: 6,94 p.p. sobre 1,03 mi ≈ R$ 71,5 mil por ano.
    expect(card.linhas.find((l) => /custa por ano/.test(l.rotulo))!.bruto!).toBeCloseTo(71_510, 0);
    expect(card.premissas.join(" ")).toMatch(/IOF, tarifas/i);
    expect(card.premissas.join(" ")).toMatch(/aproximação POR CIMA/i);
  });

  it("custo da dívida NÃO fala em ramo de atividade: a referência é nacional", () => {
    // A série é CDI + spread PJ do Banco Central — vale para o país inteiro. Dizer
    // "acima da média do seu setor" seria inventar uma comparação que não existe.
    const d = cenario();
    d.dre = d.dre.map((l) => (l.conta === "Despesas Financeiras" ? { ...l, valores: { [P0]: -230_000, [P1]: -260_000 } } : l));
    const card = montarCardsDecisao(d, { benchmarks: { custoMedioDivida: REF_CREDITO_PJ } })!
      .cards.find((c) => c.id === "custo-divida")!;
    expect(JSON.stringify(card)).not.toMatch(/setor/i);
    expect(card.premissas.join(" ")).toMatch(/NACIONAL para crédito PJ/);
    expect(card.premissas.join(" ")).toMatch(/não é a média do ramo de atividade desta empresa/i);
  });

  it("dívida mais barata que o mercado é 'ok' e mostra a economia", () => {
    const d = cenario();
    d.dre = d.dre.map((l) => (l.conta === "Despesas Financeiras" ? { ...l, valores: { [P0]: -140_000, [P1]: -150_000 } } : l));
    const card = montarCardsDecisao(d, { benchmarks: { custoMedioDivida: REF_CREDITO_PJ } })!
      .cards.find((c) => c.id === "custo-divida")!;
    expect(card.status).toBe("ok"); // 14,6% a.a. contra 18,3%
    expect(card.resposta).toMatch(/abaixo da referência de mercado para crédito PJ/i);
    expect(card.linhas.find((l) => /economiza por ano/.test(l.rotulo))!.bruto!).toBeLessThan(0);
  });

  it("sem referência de mercado, ou sem despesa financeira, o card de custo não aparece", () => {
    // Sem o benchmark não há com o que comparar — e não se inventa uma taxa.
    expect(montarCardsDecisao(cenario())!.cards.find((c) => c.id === "custo-divida")).toBeUndefined();
    const semJuro = cenario();
    semJuro.dre = semJuro.dre.filter((l) => l.conta !== "Despesas Financeiras");
    expect(
      montarCardsDecisao(semJuro, { benchmarks: { custoMedioDivida: REF_CREDITO_PJ } })!
        .cards.find((c) => c.id === "custo-divida"),
    ).toBeUndefined();
    // Sem dívida também não: dividir despesa por zero não vira taxa.
    const semDivida = cenario();
    semDivida.bp = semDivida.bp.filter((l) => !/Empréstimos|Partes Relacionadas/.test(l.conta));
    expect(
      montarCardsDecisao(semDivida, { benchmarks: { custoMedioDivida: REF_CREDITO_PJ } })!
        .cards.find((c) => c.id === "custo-divida"),
    ).toBeUndefined();
  });

  it("balancete de meio de ano: anualiza a despesa e diz que a média de dívida não se formou", () => {
    // Comparar 5 meses de juro com uma taxa ANUAL diria "sua dívida está barata"
    // para quem paga caro — o card anualiza e declara o fator.
    const P = "31/05/2026";
    const d = {
      ...cenario(),
      periodos: [P],
      arvoresBalancete: [{ periodo: P }],
      dre: [
        { conta: "Receita Líquida", subtotal: true, editado: false, valores: { [P]: 3_000_000 } },
        { conta: "Despesas Financeiras", subtotal: false, editado: false, valores: { [P]: -100_000 } },
      ] as never,
      bp: [
        { classificacao: "AF", conta: "Caixa e Equivalentes de Caixa", nivel: 2, editado: false, valores: { [P]: 500_000 } },
        { classificacao: "PF", conta: "Empréstimos e Financiamentos - CP", nivel: 2, editado: false, valores: { [P]: 1_200_000 } },
      ] as never,
      indicadores: [] as never,
    };
    const card = montarCardsDecisao(d, { benchmarks: { custoMedioDivida: REF_CREDITO_PJ } })!
      .cards.find((c) => c.id === "custo-divida")!;
    // 100 mil em 150 dias → 243 mil/ano sobre 1,2 mi de dívida = 20,3% a.a.
    expect(card.linhas.find((l) => l.destaque)!.bruto!).toBeCloseTo(0.2028, 4);
    expect(card.status).toBe("informativo"); // sem indicadores, sem perfil de risco
    expect(card.linhas[0]!.rotulo).toBe("Despesa financeira (05/2026, anualizada)");
    expect(card.premissas.join(" ")).toMatch(/anualizada \(×2,43\)/);
    expect(card.premissas.join(" ")).toMatch(/Não há saldo de dívida no período anterior/i);
    expect(JSON.stringify(card)).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  // ── Crescer sem captar ──────────────────────────────────────────────────────

  it("crescimento sustentável: sem retirada registrada, assume retenção total e DECLARA", () => {
    const card = montarCardsDecisao(cenario())!.cards.find((c) => c.id === "crescer-sem-captar")!;
    // ROE 52% × retenção 100% = 52% ao ano; a receita cresceu 12,5% — cabe.
    expect(card.linhas.find((l) => l.destaque)!.bruto!).toBeCloseTo(0.52, 4);
    expect(card.status).toBe("ok");
    expect(card.resposta).toMatch(/dentro do que o próprio resultado sustenta/i);
    expect(card.premissas.join(" ")).toMatch(/ASSUME retenção total/i);
    expect(card.premissas.join(" ")).toMatch(/margem, giro do ativo e alavancagem CONSTANTES/i);
    expect(card.premissas.join(" ")).toMatch(/payout usado é o DESTE período/i);
  });

  it("empresa que distribui quase tudo cresce ~0% sozinha, e o card diz que o resto foi financiado", () => {
    // O caso real que motivou o card: R$ 1,15 mi saem de R$ 1,2 mi de lucro
    // (payout de 96%), a receita cresce 12,5% — e a diferença veio de terceiros.
    const d = cenario();
    trocarIndicador(d, "ROE (Retorno sobre Patrimônio Líquido)", { [P0]: 0.19, [P1]: 0.2 });
    (d.fluxoCaixa as never as { fcf: Array<{ nome: string; valores: Record<string, number> }> }).fcf = [
      { nome: "Dividendos e ajustes do PL (ΔPL − lucro − Δ capital)", valores: { [P1]: -1_150_000 } },
    ];
    const card = montarCardsDecisao(d)!.cards.find((c) => c.id === "crescer-sem-captar")!;

    const sgr = card.linhas.find((l) => l.destaque)!.bruto!;
    expect(sgr).toBeCloseTo(0.00833, 4);     // 0,8% ao ano: perto de zero
    expect(sgr).toBeGreaterThan(0);
    expect(card.status).toBe("atencao");
    // Número seco não conta a história — o texto tem que contar.
    expect(card.resposta).toMatch(/distribui praticamente tudo que ganha/i);
    expect(card.resposta).toMatch(/A receita cresceu 12,5% no período — acima disso/);
    expect(card.resposta).toMatch(/não veio do lucro retido: veio de dívida/i);
    expect(card.linhas.find((l) => /payout/.test(l.rotulo))!.bruto!).toBeCloseTo(0.9583, 4);
    expect(card.premissas.join(" ")).toMatch(/variação do patrimônio líquido menos o lucro/i);
  });

  it("com prejuízo não há o que reter — o card diz isso em vez de calcular taxa", () => {
    const d = cenario();
    d.dre = d.dre.map((l) => (l.conta === "Lucro Líquido" ? { ...l, valores: { [P0]: -800_000, [P1]: -2_000_000 } } : l));
    trocarIndicador(d, "ROE (Retorno sobre Patrimônio Líquido)", { [P0]: -0.4, [P1]: -0.87 });
    const card = montarCardsDecisao(d)!.cards.find((c) => c.id === "crescer-sem-captar")!;
    expect(card.status).toBe("critico");
    expect(card.resposta).toMatch(/Sem lucro no período \(2024\) não há o que reter/i);
    expect(card.resposta).not.toMatch(/cresce até/i);
    expect(card.linhas.find((l) => l.destaque)).toBeUndefined(); // não existe taxa a destacar
  });

  it("sem ROE o card de crescimento sustentável não aparece", () => {
    const d = cenario();
    d.indicadores = d.indicadores.filter((i) => !/^ROE/.test(i.nome));
    expect(montarCardsDecisao(d)!.cards.find((c) => c.id === "crescer-sem-captar")).toBeUndefined();
  });

  it("os três cards novos entram entre covenants e reinvestimento, sem data crua", () => {
    const d = cenario();
    d.dre = d.dre.map((l) => (l.conta === "Despesas Financeiras" ? { ...l, valores: { [P0]: -230_000, [P1]: -260_000 } } : l));
    const r = montarCardsDecisao(d, {
      benchmarks: { custoMedioDivida: REF_CREDITO_PJ },
      covenants: [{ name: "Alavancagem máxima", metric: "Dívida Líquida/EBITDA", operator: "<=", threshold: 3 }],
    })!;
    const ids = r.cards.map((c) => c.id);
    expect(ids).toEqual([
      "distribuicao", "covenants", "headroom-captacao", "custo-divida",
      "crescer-sem-captar", "reinvestimento", "qualidade-lucro", "sensibilidade",
    ]);
    // Regra do dono: "31/12/2024" é chave do dado, não linguagem de relatório.
    const novos = r.cards.filter((c) => ["headroom-captacao", "custo-divida", "crescer-sem-captar"].includes(c.id));
    expect(JSON.stringify(novos)).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(JSON.stringify(novos)).toContain("2024");
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

  describe("custo da dívida: o desvio depende do perfil de risco", () => {
    /** Empresa pagando 30% a.a. contra referência de 18,3%. */
    const caro = (perfil: { alav?: string; cob?: string }) => {
      const d = cenario();
      d.dre = d.dre.map((l) => (l.conta === "Despesas Financeiras" ? { ...l, valores: { [P0]: -40_000, [P1]: -300_000 } } : l));
      d.indicadores = d.indicadores.map((i) =>
        i.nome === "Dívida Líquida/EBITDA"
          ? ({ ...i, valores: { [P1]: 1.2 }, status: { [P1]: perfil.alav ?? null } } as never)
          : i,
      );
      if (perfil.cob) {
        d.indicadores = [...d.indicadores, { nome: "Índice de Cobertura de Juros", valores: { [P1]: 8 }, status: { [P1]: perfil.cob } } as never];
      }
      return montarCardsDecisao(d, { benchmarks: { custoMedioDivida: REF_CREDITO_PJ } })!
        .cards.find((c) => c.id === "custo-divida")!;
    };

    it("risco baixo pagando prêmio: há barganha a exercer", () => {
      const card = caro({ alav: "ok", cob: "ok" });
      expect(card.status).toBe("atencao");
      expect(card.resposta).toMatch(/risco desta empresa não explica o prêmio/i);
      expect(card.linhas.some((l) => /Cobertura de juros/.test(l.rotulo))).toBe(true);
    });

    it("risco elevado: o prêmio é preço de risco, não erro de negociação", () => {
      const card = caro({ alav: "critico" });
      expect(card.status).toBe("informativo");
      expect(card.resposta).toMatch(/perfil de risco da empresa ajuda a explicar/i);
      expect(card.resposta).toMatch(/depois da alavancagem, não antes/i);
    });

    it("sem sinal de perfil, o card não julga — manda conferir", () => {
      const card = caro({});
      expect(card.status).toBe("informativo");
      expect(card.resposta).toMatch(/Antes de concluir que está cara/i);
    });

    it("nunca marca crítico pelo desvio, por maior que ele seja", () => {
      const d = cenario();
      d.dre = d.dre.map((l) => (l.conta === "Despesas Financeiras" ? { ...l, valores: { [P0]: -40_000, [P1]: -900_000 } } : l));
      const card = montarCardsDecisao(d, { benchmarks: { custoMedioDivida: REF_CREDITO_PJ } })!
        .cards.find((c) => c.id === "custo-divida")!;
      expect(card.status).not.toBe("critico");
    });

    it("declara o descasamento de tempo e a composição da dívida", () => {
      const prem = caro({ alav: "ok", cob: "ok" }).premissas.join(" ");
      expect(prem).toMatch(/taxa de HOJE/);
      expect(prem).toMatch(/CDI de cada época/i);
      expect(prem).toMatch(/BNDES/);
      expect(prem).toMatch(/NÃO é um rating de crédito/i);
    });
  });

  it("ROE inflado por patrimônio residual não vira taxa de crescimento", () => {
    // Caso real: empresa que distribui tudo fica com PL minúsculo, o ROE explode
    // (626,5% numa tela de produção) e qualquer coisa multiplicada por ele vira
    // ficção com cara de conta. Mesma régua da base-do-retorno: PL < 15% da receita.
    const d = cenario();
    d.bp = d.bp.map((l) => (l.conta === "Patrimônio Líquido" ? { ...l, valores: { [P0]: 300_000, [P1]: 200_000 } } : l));
    trocarIndicador(d, "ROE (Retorno sobre Patrimônio Líquido)", { [P0]: 3.3, [P1]: 6.0 });
    (d.fluxoCaixa as never as { fcf: Array<{ nome: string; valores: Record<string, number> }> }).fcf = [
      { nome: "Dividendos e ajustes do PL (ΔPL − lucro − Δ capital)", valores: { [P1]: -900_000 } },
    ];
    const card = montarCardsDecisao(d)!.cards.find((c) => c.id === "crescer-sem-captar")!;
    const roe = card.linhas.find((l) => /^ROE/.test(l.rotulo))!;
    expect(roe.valor).toMatch(/não comparável/i);
    expect(roe.bruto).toBeNull();
    expect(JSON.stringify(card)).not.toMatch(/600,0%|626/); // nenhuma taxa absurda na tela
    expect(card.premissas.join(" ")).toMatch(/abaixo de 15% da receita líquida/i);
  });

  it("distribuindo mais do que ganhou, a taxa sustentável não vira previsão", () => {
    // Payout acima de 100%: a fórmula devolve um número negativo que se lê como
    // "vai encolher X% ao ano". Não é previsão — é o patrimônio diminuindo.
    const d = cenario();
    (d.fluxoCaixa as never as { fcf: Array<{ nome: string; valores: Record<string, number> }> }).fcf = [
      { nome: "Dividendos e ajustes do PL (ΔPL − lucro − Δ capital)", valores: { [P1]: -1_850_000 } },
    ];
    const card = montarCardsDecisao(d)!.cards.find((c) => c.id === "crescer-sem-captar")!;
    const linha = card.linhas.find((l) => /Crescimento sustentável/.test(l.rotulo))!;
    expect(linha.valor).toMatch(/não se aplica/i);
    expect(linha.valor).not.toMatch(/-\d/);   // nenhuma taxa negativa exibida
    expect(linha.bruto).toBeNull();           // e nada de taxa negativa no Excel
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
