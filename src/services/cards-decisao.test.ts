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
    // SEM SOBRA a linha não diz "distribuição segura: -R$ X" — ninguém distribui
    // valor negativo. Diz capacidade ZERO, e o que falta vira déficit em linha
    // própria (pedido do dono, 19/08/2026).
    const linhaSobra = card.linhas.find((l) => l.destaque)!;
    expect(linhaSobra.rotulo).toBe("Capacidade de distribuição");
    expect(linhaSobra.bruto).toBe(0);
    const deficit = card.linhas.find((l) => l.rotulo.startsWith("Déficit"))!;
    expect(deficit.bruto!).toBeLessThan(0);
    expect(deficit.valor).not.toContain("-");
    // Sem folga HOJE, mas a operação gera caixa e recompõe a diferença rápido:
    // isso é atenção, não crítico. Marcar crítico numa empresa sem dívida que
    // gera caixa foi o primeiro defeito que o dono viu na tela real.
    expect(card.status).toBe("atencao");
    expect(card.resposta).toMatch(/Nada a distribuir hoje/i);
    expect(card.resposta).toMatch(/recompõe.*em cerca de \d+ (mês|meses)/i);
    // A conta PARA no destaque — a geração recorrente não é parcela dela. Depois
    // do destaque só cabe RESTATEMENT do próprio total, nunca outra parcela: o
    // déficit é o mesmo número lido pelo outro lado, e o rótulo impede que passe
    // por parcela de uma soma que termina em R$ 0.
    const iDestaque = card.linhas.findIndex((l) => l.destaque);
    expect(card.linhas.slice(iDestaque + 1).map((l) => l.rotulo)).toEqual(["Déficit até a linha de segurança"]);
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

  it("custo-divida e qualidade-lucro NÃO entram — removidos a pedido do dono (19/08)", () => {
    const d = cenario();
    d.dre = d.dre.map((l) => (l.conta === "Despesas Financeiras" ? { ...l, valores: { [P0]: -230_000, [P1]: -260_000 } } : l));
    const r = montarCardsDecisao(d, {
      benchmarks: { custoMedioDivida: REF_CREDITO_PJ },
      covenants: [{ name: "Alavancagem máxima", metric: "Dívida Líquida/EBITDA", operator: "<=", threshold: 3 }],
    })!;
    const ids = r.cards.map((c) => c.id);
    expect(ids).toEqual([
      "distribuicao", "covenants", "headroom-captacao",
      "crescer-sem-captar", "reinvestimento", "sensibilidade",
    ]);
    // Mesmo com a referência de crédito PJ disponível, o card de custo da dívida
    // não nasce: a média NACIONAL do BC não conhece porte, garantia nem
    // relacionamento desta empresa, e chamar a taxa dela de "acima do mercado"
    // afirma mais do que o dado sustenta.
    expect(ids).not.toContain("custo-divida");
    // A pergunta "o lucro virou caixa?" é respondida pela ponte do EBITDA ao
    // caixa, com decomposição auditável. Dois lugares com réguas diferentes é
    // onde nasce contradição dentro do relatório.
    expect(ids).not.toContain("qualidade-lucro");
    // Regra do dono: "31/12/2024" é chave do dado, não linguagem de relatório.
    const novos = r.cards.filter((c) => ["headroom-captacao", "crescer-sem-captar"].includes(c.id));
    expect(JSON.stringify(novos)).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(JSON.stringify(novos)).toContain("2024");
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
    // capex 150k ÷ D&A 220k = 0,68x — abaixo de 1, e a RESPOSTA diz isso em
    // linguagem de dono. A lista período a período saiu (pedido do dono): o
    // múltiplo isolado é ruidoso porque capex é lumpy — um caminhão comprado
    // num mês desloca o índice sem mudar a política de investimento.
    expect(card.linhas).toEqual([]);
    expect(card.resposta).toMatch(/investindo MENOS/);
    expect(card.resposta).toMatch(/abaixo da deprecia/i);
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

// ── Ajustes pedidos pelo dono em 19/08/2026 ──
describe("cards de decisão · ajustes de 19/08", () => {
  it("o teto de alavancagem é PREMISSA editável quando não há covenant", () => {
    const r = montarCardsDecisao(cenario(), { premissas: { limiteAlavancagem: 2.5 } })!;
    const card = r.cards.find((c) => c.id === "headroom-captacao")!;
    expect(card.edicao).toMatchObject({ chave: "limiteAlavancagem", valor: 2.5 });
    expect(JSON.stringify(card)).toContain("2,5x");
    // o 3,0x de fábrica é número de mercado, não desta empresa — não pode sobrar
    expect(JSON.stringify(card.premissas)).not.toContain("3,0x");
  });

  it("covenant cadastrado MANDA — e aí não há premissa para o dono editar", () => {
    const r = montarCardsDecisao(cenario(), {
      premissas: { limiteAlavancagem: 2.5 },
      covenants: [{ name: "Alavancagem máxima", metric: "Dívida Líquida/EBITDA", operator: "<=", threshold: 4 }],
    })!;
    const card = r.cards.find((c) => c.id === "headroom-captacao")!;
    expect(JSON.stringify(card)).toContain("4,0x");
    expect(card.edicao).toBeUndefined();
  });

  it("alavancagem PATRIMONIAL entra no card de dívida nova, como fato", () => {
    const d = cenario();
    d.indicadores = [...(d.indicadores ?? []), { nome: "Capital Terceiros s/ PL", valores: { [P1]: 5.63 } } as never];
    const card = montarCardsDecisao(d)!.cards.find((c) => c.id === "headroom-captacao")!;
    expect(card.linhas.some((l) => l.rotulo.startsWith("Capital de terceiros"))).toBe(true);
    // o teto por EBITDA diz se o resultado paga; isto diz quem absorve a perda
    expect(card.resposta).toMatch(/absorve a perda/);
  });

  it("reposição de ativos explica em linguagem de dono, sem a lista por período", () => {
    const card = montarCardsDecisao(cenario())!.cards.find((c) => c.id === "reinvestimento")!;
    expect(card.linhas).toEqual([]);
    expect(card.resposta).toMatch(/máquinas, veículos e instalações/);
  });
});
