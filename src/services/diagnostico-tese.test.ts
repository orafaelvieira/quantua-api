import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O DIAGNÓSTICO É UMA TESE, NÃO UM PAINEL (dono, 21/08/2026, "ajustes relatório ibr4").
 *
 * O documento apontou uma contradição que "destrói a credibilidade": o card de
 * saúde dizia "o caixa paga 7 dias de operação" no título e "sustentaria a
 * operação por cerca de 17,5 meses" no corpo. Os DOIS números saíam do motor —
 * a conta regressiva publicava dois relógios e a IA repetia ambos. E o prompt
 * ENSINAVA a frase imprecisa que o documento corrige ("para cada R$ 1,00 que
 * vence a empresa tem R$ 0,97 para cobrir", que não é o que a liquidez
 * corrente mede).
 *
 * Esta bancada garante, no nível onde dá para garantir (motor + prompt + parse):
 *   1. o prompt leva UM relógio, com a definição;
 *   2. o prompt ensina as definições exatas, não as imprecisas;
 *   3. a estimativa de fôlego da IA é descartada quando o motor mediu;
 *   4. a classe da situação segue o estágio do motor.
 */

const criar = vi.fn();
vi.mock("./ai-extraction", async (original) => {
  const real = await original<typeof import("./ai-extraction")>();
  return { ...real, createWithRetry: (...args: unknown[]) => criar(...args) };
});

import { generateAnalysis } from "./claude";

// Série real da Belagro (recorte): 2024 fechado + acumulado até 05/2026.
const P0 = "2024", P1 = "31/12/2025", P = "31/05/2026";
const vals = (a: number, b: number, c: number) => ({ [P0]: a, [P1]: b, [P]: c });
const INDICADORES = [
  { nome: "Receita Líquida", valores: vals(592_042_364, 741_125_792, 328_504_142), tipoDado: "R$" },
  { nome: "Margem EBITDA", valores: vals(0.026, 0.019, -0.0125), tipoDado: "%" },
  { nome: "Liquidez Corrente", valores: vals(1.005, 0.947, 0.967), tipoDado: "Índice" },
  { nome: "Liquidez Imediata", valores: vals(0.038, 0.01, 0.035), tipoDado: "Índice" },
  { nome: "Endividamento Geral", valores: vals(0.809, 0.867, 0.972), tipoDado: "%" },
  { nome: "Índice de Cobertura de Juros", valores: vals(4.23, 1.62, -0.57), tipoDado: "Índice" },
];
const BP = [
  { conta: "Caixa e Equivalentes de Caixa", valores: vals(2_102_807, 997_963, 14_803_975) },
  { conta: "Ativo Circulante", valores: vals(55_740_000, 94_800_000, 413_250_000) },
  { conta: "Passivo Circulante", valores: vals(55_470_000, 100_120_000, 427_290_000) },
];
const DRE = [
  { conta: "Receita Líquida", valores: vals(592_042_364, 741_125_792, 328_504_142) },
  { conta: "Custo Operacional", valores: vals(-547_420_000, -685_050_000, -306_710_000) },
  { conta: "Despesas Financeiras", valores: vals(-3_650_000, -8_520_000, -7_250_000) },
  { conta: "EBITDA", valores: vals(15_440_000, 13_800_000, -4_120_000) },
];
const FC = {
  colunas: [P1, P],
  fco: [], fci: [], fcf: [],
  totais: {
    fco: { [P1]: 2_000_000, [P]: -4_611_799 },
    fci: { [P1]: 0, [P]: 0 },
    fcf: { [P1]: -3_104_844, [P]: 18_417_811 },
  },
  prova: [{ periodo: P1, fecha: true }, { periodo: P, fecha: true }],
};

function resposta(extra: Record<string, unknown>) {
  const corpo = {
    semaforo: [{ area: "Liquidez", status: "critico", descricao: "x" }],
    opcoesEstrategicas: [{ pillar: "financial_restructuring", title: "x", description: "y", priority: "p0" }],
    swot: { forcas: ["f"], fraquezas: [], oportunidades: [], riscos: [] },
    confianca: 70,
    ...extra,
  };
  return { content: [{ type: "text", text: JSON.stringify(corpo) }], usage: { input_tokens: 100, output_tokens: 200 } };
}

async function gerar(extra: Record<string, unknown> = {}) {
  criar.mockResolvedValueOnce(resposta(extra));
  const r = await generateAnalysis(
    INDICADORES, [P0, P1, P],
    { razaoSocial: "Belagro Comercial Agrícola", setor: "Agropecuária", porte: "Média" },
    P, null, null, null, null, DRE as never, FC as never, null, BP as never, [P1, P], [P0, P1],
  );
  const chamada = criar.mock.calls[0]?.[0] as { messages?: Array<{ content: string }> } | undefined;
  const prompt = chamada?.messages?.map((m) => String(m.content)).join("\n") ?? JSON.stringify(chamada ?? {});
  return { ...r, prompt };
}

beforeEach(() => criar.mockReset());

describe("o prompt leva UM relógio de caixa, com a definição", () => {
  it("a conta regressiva entra com os dias e com o que o número É", async () => {
    const { prompt } = await gerar();
    expect(prompt).toMatch(/CONTA REGRESSIVA DE CAIXA/);
    expect(prompt).toMatch(/cobre 7 dias de desembolsos da operação/);
    expect(prompt).toMatch(/caixa disponível dividido pelo gasto diário/);
  });

  it("e NÃO leva o segundo relógio (meses até zerar), que era a contradição", async () => {
    const { prompt } = await gerar();
    const bloco = prompt.slice(prompt.indexOf("CONTA REGRESSIVA DE CAIXA"), prompt.indexOf("CONTA REGRESSIVA DE CAIXA") + 600);
    expect(bloco).not.toMatch(/se esgota|meses/);
  });

  it("manda a IA não inventar uma segunda medida de fôlego", async () => {
    const { prompt } = await gerar();
    expect(prompt).toMatch(/O RELÓGIO É UM SÓ/);
    expect(prompt).toMatch(/NÃO converta dias em meses/);
  });

  it("e NENHUMA outra parte do prompt pede o segundo relógio (o método e as revelações pediam)", async () => {
    // A regra nova dizia "um relógio só" e, cem linhas acima, o MÉTODO ainda
    // mandava "Estime meses de caixa" e a classe (e) das Revelações pedia "o
    // caixa acaba em N meses" — a contradição do dono reaberta em outra seção.
    const { prompt } = await gerar();
    expect(prompt).not.toMatch(/Estime meses de caixa/);
    expect(prompt).not.toMatch(/sinalize se caixa < 3 meses/);
    expect(prompt).not.toMatch(/o caixa acaba\/dobra em N meses/);
    expect(prompt).not.toMatch(/runway/);
    expect(prompt).not.toMatch(/de "saudável" a "crise"/);
  });
});

describe("o prompt ensina as DEFINIÇÕES EXATAS, não as imprecisas", () => {
  it("liquidez corrente é ativo circulante sobre passivo circulante", async () => {
    const { prompt } = await gerar();
    expect(prompt).toMatch(/possui R\$ X em ativos circulantes/);
    // A frase imprecisa que o prompt ENSINAVA não pode voltar como exemplo.
    expect(prompt).not.toMatch(/tem apenas R\$ 0,01 para pagar/);
    expect(prompt).not.toMatch(/que vence, há R\$ 0,01 para cobrir/);
  });

  it("liquidez imediata, endividamento, cobertura de juros e solvência têm a forma exigida", async () => {
    const { prompt } = await gerar();
    expect(prompt).toMatch(/em disponibilidades imediatas/);
    expect(prompt).toMatch(/dos ativos são financiados por capital de terceiros/);
    expect(prompt).toMatch(/cobertura de juros é EBITDA sobre despesas financeiras/);
    expect(prompt).toMatch(/Kanitz e Altman NÃO são citados em nenhum dos três cartões do diagnóstico/);
    expect(prompt).toMatch(/sem "termômetros"/);
    // A solvência é emendada ao cartão de saúde pelo sistema, com o texto do
    // motor: a IA citando Kanitz/Altman ali publicava os dois duas vezes.
    expect(prompt).toMatch(/NÃO cite Kanitz, Altman nem "indicadores de solvência" em saudeFinanceira\.leitura/);
  });

  it("tese antes do painel: cada número em um cartão só, e a janela parcial declarada", async () => {
    const { prompt } = await gerar();
    expect(prompt).toMatch(/O DIAGNÓSTICO É UMA TESE, NÃO UM PAINEL/);
    expect(prompt).toMatch(/CADA NÚMERO APARECE EM UM CARTÃO SÓ/);
    expect(prompt).toMatch(/O QUE MUDA A LEITURA/);
  });

  it("o schema da saúde NÃO lista solvência entre os números (o sistema a emenda)", async () => {
    const { prompt } = await gerar();
    const schema = prompt.slice(prompt.indexOf('"saudeFinanceira": {'), prompt.indexOf('"saudeFinanceira": {') + 700);
    expect(schema).toMatch(/a solvência entra pelo sistema, não a cite/);
    expect(schema).not.toMatch(/geração operacional, solvência/);
    expect(prompt).toMatch(/Kanitz e Altman NÃO são citados em nenhum dos três cartões/);
  });

  it("uma contagem só: 4 ou 5 números na situação, dois por FRASE, 2 ou 3 parágrafos", async () => {
    const { prompt } = await gerar();
    expect(prompt).not.toMatch(/3 a 5 números/);
    expect(prompt).toMatch(/provada por 4 ou 5 números/);
    expect(prompt).toMatch(/no máximo dois indicadores por FRASE/);
    // 2 ou 3 parágrafos por cartão (dono, 21/08/2026: "colocar parágrafos nos
    // textos para não ficar tudo corrido") — a tela e o PDF respeitam a linha
    // em branco via `paragrafosDe`.
    expect(prompt).toMatch(/2 ou 3 parágrafos curtos separados por uma linha em branco/);
    expect(prompt).not.toMatch(/UM parágrafo corrido/);
    expect(prompt).not.toMatch(/no máximo dois indicadores por parágrafo/);
  });

  it("a classe antiga 'dificuldade financeira' saiu do schema; 'pressão de caixa' entrou", async () => {
    const { prompt } = await gerar();
    expect(prompt).toMatch(/pressão financeira\|pressão de caixa/);
    expect(prompt).not.toMatch(/dificuldade financeira"/);
  });
});

describe("camada de consistência no parse", () => {
  it("a estimativa de fôlego da IA é DESCARTADA quando o motor mediu o relógio", async () => {
    const { result } = await gerar({
      saudeFinanceira: { status: "frágil", mesesDeCaixa: 17.5, leitura: "O caixa sustentaria a operação por 17,5 meses." },
    });
    expect(result.saudeFinanceira?.diasDeCaixa).toBe(7);
    expect(result.saudeFinanceira?.mesesDeCaixa, "17,5 meses da IA não sobrevive ao lado dos 7 dias do motor").toBeNull();
  });

  it("a PROSA com segundo relógio é removida: leitura, situação, tese, destaques e revelações", async () => {
    const { result } = await gerar({
      saudeFinanceira: { status: "frágil", leitura: "O caixa de hoje cobre 7 dias de desembolsos. No ritmo atual o caixa acaba em cerca de 16 meses. A variável decisiva é a safra." },
      situacao: { classificacao: "pressão de caixa", racional: "A tese. A reserva duraria 16 meses no ritmo atual." },
      destaques: ["Caixa cobre 7 dias", "Caixa se esgota em 16 meses"],
      revelacoes: [
        { titulo: "O caixa se esgota em 16 meses", dadoEscondido: "x", comoChegou: "14,8 mi / 0,92 mi por mês" },
        { titulo: "Revelação legítima", dadoEscondido: "y", comoChegou: "z" },
      ],
      parecerExecutivo: { tese: "Sustentaria a operação por 17,5 meses. Precisa recompor caixa.", numeros: [], decisoes: [], proteger: [] },
    });
    expect(result.saudeFinanceira?.leitura).toBe("O caixa de hoje cobre 7 dias de desembolsos. A variável decisiva é a safra.");
    expect(result.situacao?.racional).toBe("A tese.");
    expect(result.destaques).toEqual(["Caixa cobre 7 dias"]);
    expect(result.revelacoes?.map((r) => r.titulo)).toEqual(["Revelação legítima"]);
    expect(result.parecerExecutivo?.tese).toBe("Precisa recompor caixa.");
  });

  it("PRECISÃO: frases legítimas sobre meses e caixa NÃO são apagadas (medido: a 1ª versão apagava 9 de 30)", async () => {
    const legitimas = [
      "Os últimos 6 meses de caixa mostram saldo crescente.",
      "O caixa disponível cobre 2 meses de folha de pagamento.",
      "A reserva acabou em 3 meses de atraso dos clientes.",
      "O caixa zerou há 3 meses e foi recomposto com aporte dos sócios.",
      "A disponibilidade do crédito rural termina em 6 meses.",
      "A empresa resistiu a 6 meses de queda de preço sem tocar a reserva.",
      "O prazo médio de recebimento subiu para 2 meses.",
      "O contrato de 12 meses vence em dezembro.",
      "A dívida equivale a 3 meses de faturamento.",
      "A meta é manter um caixa mínimo de 2 meses de despesas.",
      "O caixa caiu 30% em 6 meses.",
      "A dívida líquida dobra em 12 meses nesse ritmo.",
      "Nos próximos 3 meses de caixa apertado, a safra entra.",
    ];
    const { result } = await gerar({
      saudeFinanceira: { status: "frágil", leitura: legitimas.join(" ") },
      destaques: legitimas,
    });
    expect(result.saudeFinanceira?.leitura).toBe(legitimas.join(" "));
    expect(result.destaques).toEqual(legitimas);
  });

  it("e as formas inequívocas do segundo relógio caem, em TODOS os campos de texto", async () => {
    const relogios = [
      "No ritmo atual o caixa acaba em cerca de 16 meses.",
      "A reserva duraria 16 meses.",
      "Esse dinheiro sustentaria a operação por cerca de 17,5 meses.",
      "O caixa se esgota em 16 meses.",
      "Há 18 meses de fôlego antes de o caixa zerar.",
      "Restam 16 meses de caixa.",
      "O runway é de 16 meses.",
      "São 16 meses até zerar.",
    ];
    const { result } = await gerar({
      saudeFinanceira: { status: "frágil", leitura: `O caixa cobre 7 dias de desembolsos. ${relogios[0]} Fim.` },
      situacao: { classificacao: "pressão de caixa", racional: `A tese. ${relogios[1]}` },
      destaques: ["Caixa cobre 7 dias", ...relogios],
      revelacoes: relogios.map((r) => ({ titulo: r, dadoEscondido: "x", comoChegou: "y" })).concat([{ titulo: "Legítima", dadoEscondido: "y", comoChegou: "z" }]),
      parecerExecutivo: { tese: `${relogios[2]} Precisa recompor caixa.`, numeros: [{ indicador: "Margem EBITDA", leitura: relogios[3] }], decisoes: [{ decisao: "Renegociar", prazo: "0–30d", valor: null, porque: relogios[4] }], proteger: [] },
      semaforo: [{ area: "Liquidez", status: "critico", descricao: relogios[5] }],
      fatoresChave: [{ fator: "F", natureza: "interna", confianca: "alta", hipotese: relogios[6], evidencia: relogios[7], verificar: "v" }],
      recomendacoes: [{ titulo: "R", sinalId: "x", horizonte: "0–30d", descricao: `Faça isso. ${relogios[0]}` }],
      opcoesEstrategicas: [{ pillar: "financial_restructuring", title: "x", description: `Opção. ${relogios[1]}`, priority: "p0" }],
    });
    const tudo = JSON.stringify(result);
    for (const r of relogios) expect(tudo, `sobreviveu: ${r}`).not.toContain(r.replace(/\.$/, ""));
    expect(result.saudeFinanceira?.leitura).toBe("O caixa cobre 7 dias de desembolsos. Fim.");
    expect(result.revelacoes?.map((r) => r.titulo)).toEqual(["Legítima"]);
    expect(result.destaques).toEqual(["Caixa cobre 7 dias"]);
  });

  it("frase composta NÃO leva o relógio do motor junto", async () => {
    // "cobre 7 dias de desembolsos; no ritmo atual o caixa acaba em 16 meses"
    // era removida INTEIRA, e o cartão ficava sem tempo nenhum.
    const { result } = await gerar({
      saudeFinanceira: { status: "frágil", leitura: "A reserva cobre 7 dias de desembolsos da operação; no ritmo atual o caixa acaba em cerca de 16 meses. A safra só entra em março." },
    });
    expect(result.saudeFinanceira?.leitura).toBe("A reserva cobre 7 dias de desembolsos da operação. A safra só entra em março.");
  });

  it("trajetória que NÃO é fôlego de caixa passa intacta", async () => {
    const { result } = await gerar({
      saudeFinanceira: { status: "frágil", leitura: "O caixa cobre 7 dias de desembolsos. O caixa caiu 30% em 6 meses. A dívida líquida dobra em 12 meses nesse ritmo." },
      revelacoes: [{ titulo: "A margem chega a zero em 3 períodos", dadoEscondido: "x", comoChegou: "y" }],
    });
    expect(result.saudeFinanceira?.leitura).toBe("O caixa cobre 7 dias de desembolsos. O caixa caiu 30% em 6 meses. A dívida líquida dobra em 12 meses nesse ritmo.");
    expect(result.revelacoes?.length).toBe(1);
  });

  it("sem relógio do motor, a prosa da IA passa intacta (não há contradição a evitar)", async () => {
    criar.mockReset();
    criar.mockResolvedValueOnce(resposta({ saudeFinanceira: { status: "apertada", leitura: "A reserva duraria 6 meses." } }));
    const r = await generateAnalysis(INDICADORES, [P0, P1, P], { razaoSocial: "X", setor: "Y", porte: "Z" }, P);
    expect(r.result.saudeFinanceira?.leitura).toBe("A reserva duraria 6 meses.");
  });

  it("a classe da situação segue o estágio do motor (Pressão de caixa → 'pressão de caixa')", async () => {
    const { result } = await gerar({
      situacao: { classificacao: "dificuldade financeira", racional: "x" },
    });
    expect(result.estagioCicloVida?.estagio).toBe("Pressão de caixa");
    expect(result.situacao?.classificacao).toBe("pressão de caixa");
  });
});

describe("a justificativa do estágio (escrita pelo MOTOR) segue o documento", () => {
  it("é CURTA, declara a janela parcial e NÃO cita liquidez (a situação é dona dela)", async () => {
    const { result } = await gerar();
    const j = result.estagioCicloVida?.justificativa ?? "";
    expect(j).toMatch(/^Na janela de 2026 analisada \(acumulado até 05\/2026\)/);
    expect(j).toMatch(/ainda não cobre integralmente os custos e as despesas/);
    expect(j).not.toMatch(/gastando mais do que fatura/);
    // Liquidez corrente/imediata têm UM dono (situacao.racional). Quando o motor
    // as citava aqui e o prompt mandava a IA prová-las ali, o mesmo número saía
    // nos dois cartões com a mesma frase.
    expect(j).not.toMatch(/liquidez|ativos circulantes|disponibilidades imediatas/i);
    expect(j).not.toMatch(/sai apenas .*% desse valor/);
    // A ressalva só cita o que EXISTE na série (há exercício fechado antes).
    expect(j).toMatch(/lido junto com o exercício fechado anterior e com a sazonalidade, se o negócio a tiver/);
    expect(j.length, "estágio é uma frase curta, não um painel").toBeLessThan(420);
    // A ressalva é parágrafo próprio: o fato num bloco, como lê-lo no outro.
    const QUEBRA = String.fromCharCode(10, 10);
    expect(j.split(QUEBRA).length).toBe(2);
    expect(j.split(QUEBRA)[1]).toMatch(/^Esse resultado é de uma janela parcial/);
  });

  it("COLUNA FECHADA: abre em maiúscula e não fala de janela", async () => {
    // Regressão pega na revisão: sem janela, a abertura saía "a operação ainda
    // não cobre…" em minúscula — em todo IBR cujo último período é exercício
    // fechado, a maioria do acervo.
    criar.mockReset();
    criar.mockResolvedValueOnce(resposta({}));
    const ind = INDICADORES.map((i) => ({ ...i, valores: { "2024": i.valores[P0], "31/12/2025": i.valores[P] } }));
    const r = await generateAnalysis(ind, ["2024", "31/12/2025"], { razaoSocial: "X", setor: "Y", porte: "Z" }, "31/12/2025");
    const j = r.result.estagioCicloVida?.justificativa ?? "";
    expect(r.result.estagioCicloVida?.estagio).toBe("Pressão de caixa");
    expect(j).toMatch(/^A operação ainda não cobre/);
    expect(j).not.toMatch(/janela/);
    expect(j).toMatch(/Enquanto a operação não voltar a cobrir/);
  });

  it("RÓTULO CURTO 'MM/AAAA' também é janela parcial (existe no acervo de balancete)", async () => {
    criar.mockReset();
    criar.mockResolvedValueOnce(resposta({}));
    const ps = ["12/2025", "06/2026"];
    const ind = INDICADORES.map((i) => ({ ...i, valores: { "12/2025": i.valores[P1], "06/2026": i.valores[P] } }));
    const r = await generateAnalysis(ind, ps, { razaoSocial: "X", setor: "Y", porte: "Z" }, "06/2026");
    const j = r.result.estagioCicloVida?.justificativa ?? "";
    expect(j).toMatch(/^Na janela de 2026 analisada \(acumulado até 06\/2026\)/);
    expect(j, "12/2025 é exercício fechado").toMatch(/exercício fechado anterior/);
  });

  it("margem negativa menor que 1% não vira 'cerca de R$ 0'", async () => {
    criar.mockReset();
    criar.mockResolvedValueOnce(resposta({}));
    const ind = INDICADORES.map((i) => i.nome === "Margem EBITDA" ? { ...i, valores: { ...i.valores, [P]: -0.003 } } : i);
    const r = await generateAnalysis(ind, [P0, P1, P], { razaoSocial: "X", setor: "Y", porte: "Z" }, P);
    const j = r.result.estagioCicloVida?.justificativa ?? "";
    expect(j).toMatch(/deixam menos de R\$ 1 de resultado operacional negativo/);
    expect(j).not.toMatch(/cerca de R\$ 0 /);
  });

  it("JANELA PARCIAL SEM exercício fechado na série: não manda comparar com o que não existe", async () => {
    criar.mockReset();
    criar.mockResolvedValueOnce(resposta({}));
    const ps = ["31/03/2026", "30/04/2026", "31/05/2026"];
    const ind = INDICADORES.map((i) => ({ ...i, valores: Object.fromEntries(ps.map((p) => [p, i.valores[P]])) }));
    const r = await generateAnalysis(ind, ps, { razaoSocial: "X", setor: "Y", porte: "Z" }, "31/05/2026");
    const j = r.result.estagioCicloVida?.justificativa ?? "";
    expect(j).toMatch(/^Na janela de 2026 analisada/);
    expect(j).not.toMatch(/exercício fechado anterior/);
    expect(j).toMatch(/sem um exercício fechado para comparar/);
  });

  it("NADA INTERNO e nenhuma data de fechamento crua", async () => {
    const { result } = await gerar();
    const j = result.estagioCicloVida?.justificativa ?? "";
    expect(j).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    for (const palavra of ["motor", "seletor", "prompt", "YTD", "balancete"]) {
      expect(j.toLowerCase()).not.toContain(palavra.toLowerCase());
    }
  });
});
