import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DOIS QUADROS, UM POR EIXO DA MATRIZ (dono, 21/08/2026).
 *
 * A matriz cruza ESTÁGIO (linha) e FÔLEGO FINANCEIRO (coluna). Abaixo dela
 * havia três cartões que não correspondiam aos eixos: dois falavam da coluna e
 * um da linha, e os mesmos números saíam em dois lugares com palavras
 * diferentes. Agora são dois quadros com os nomes dos eixos; o MOTOR escreve o
 * rótulo e "o que define" cada um (os gatilhos, com os números desta empresa)
 * e a IA explica COMO a empresa chegou ali. Regra do dono: "precisamos deixar
 * muito claro ao leitor o que levou a empresa a estar naquela linha e naquela
 * coluna" e "não existe texto fixo".
 *
 * Também vive aqui a herança do "ajustes relatório ibr4": UM relógio de caixa,
 * definições exatas, e a camada de consistência que remove da prosa qualquer
 * segundo relógio.
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
  { nome: "Termômetro de Kanitz", valores: vals(1.2, 0.8, -7.5), tipoDado: "Índice" },
  { nome: "Altman Z-Score (EM)", valores: vals(2.1, 1.9, -0.14), tipoDado: "Índice" },
  { nome: "Situação de Liquidez (Fleuriet)", valores: { [P0]: "Insuficiente", [P1]: "Muito Ruim", [P]: "Muito Ruim" }, tipoDado: "Texto" },
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
    INDICADORES as never, [P0, P1, P],
    { razaoSocial: "Belagro Comercial Agrícola", setor: "Agropecuária", porte: "Média" },
    P, null, null, null, null, DRE as never, FC as never, null, BP as never, [P1, P], [P0, P1],
  );
  const chamada = criar.mock.calls[0]?.[0] as { messages?: Array<{ content: string }> } | undefined;
  const prompt = chamada?.messages?.map((m) => String(m.content)).join("\n") ?? JSON.stringify(chamada ?? {});
  return { ...r, prompt };
}

const QUEBRA = String.fromCharCode(10, 10);

beforeEach(() => criar.mockReset());

// ═══════════════════════════════════════════════════════════════════════════
// O MOTOR DIZ O QUE DEFINE CADA EIXO — com os números desta empresa
// ═══════════════════════════════════════════════════════════════════════════

describe("o quadro ESTÁGIO (linha): o motor escreve o que o define", () => {
  it("declara a janela parcial, a margem e os GATILHOS que dispararam", async () => {
    const { result } = await gerar();
    const j = result.estagioCicloVida?.justificativa ?? "";
    expect(result.estagioCicloVida?.estagio).toBe("Pressão de caixa");
    expect(j).toMatch(/^Na janela de 2026 analisada \(acumulado até 05\/2026\)/);
    expect(j).toMatch(/ainda não cobre integralmente os custos e as despesas/);
    expect(j).toMatch(/O que define o estágio:/);
    // O gatilho REAL desta empresa: margem negativa E liquidez corrente < 1.
    expect(j).toMatch(/a operação fecha no vermelho e, ao mesmo tempo, os compromissos de curto prazo superam os ativos de curto prazo \(liquidez corrente de 0,97\)/);
    // A liquidez aparece aqui só como gatilho (uma linha) — quem a define é o fôlego.
    expect(j).not.toMatch(/ativos circulantes|disponibilidades imediatas/);
    // A ressalva da janela é parágrafo próprio e só cita o que existe na série.
    expect(j.split(QUEBRA).length).toBe(2);
    expect(j.split(QUEBRA)[1]).toMatch(/^Esse resultado é de uma janela parcial/);
    expect(j).toMatch(/lido junto com o exercício fechado anterior e com a sazonalidade, se o negócio a tiver/);
  });

  it("os outros estágios também abrem com 'O que define o estágio'", async () => {
    criar.mockReset(); criar.mockResolvedValueOnce(resposta({}));
    // Receita em queda, margem positiva, sem aperto de caixa → Retração pela trajetória.
    const ind = [
      { nome: "Receita Líquida", valores: { "2023": 100, "2024": 85, "2025": 70 }, tipoDado: "R$" },
      { nome: "Margem EBITDA", valores: { "2023": 0.1, "2024": 0.09, "2025": 0.08 }, tipoDado: "%" },
      { nome: "Liquidez Corrente", valores: { "2023": 1.8, "2024": 1.7, "2025": 1.6 }, tipoDado: "Índice" },
    ];
    const r = await generateAnalysis(ind, ["2023", "2024", "2025"], { razaoSocial: "X", setor: "Y", porte: "Z" }, "2025");
    expect(r.result.estagioCicloVida?.estagio).toBe("Retração");
    expect(r.result.estagioCicloVida?.justificativa).toMatch(/^O que define o estágio: a trajetória do faturamento e o sinal da margem/);
  });

  it("COLUNA FECHADA: abre em maiúscula e não fala de janela", async () => {
    criar.mockReset(); criar.mockResolvedValueOnce(resposta({}));
    const ind = INDICADORES.map((i) => ({ ...i, valores: { "2024": i.valores[P0], "31/12/2025": i.valores[P] } }));
    const r = await generateAnalysis(ind as never, ["2024", "31/12/2025"], { razaoSocial: "X", setor: "Y", porte: "Z" }, "31/12/2025");
    const j = r.result.estagioCicloVida?.justificativa ?? "";
    expect(j).toMatch(/^A operação ainda não cobre/);
    expect(j).not.toMatch(/janela/);
  });

  it("RÓTULO CURTO 'MM/AAAA' também é janela parcial", async () => {
    criar.mockReset(); criar.mockResolvedValueOnce(resposta({}));
    const ind = INDICADORES.map((i) => ({ ...i, valores: { "12/2025": i.valores[P1], "06/2026": i.valores[P] } }));
    const r = await generateAnalysis(ind as never, ["12/2025", "06/2026"], { razaoSocial: "X", setor: "Y", porte: "Z" }, "06/2026");
    const j = r.result.estagioCicloVida?.justificativa ?? "";
    expect(j).toMatch(/^Na janela de 2026 analisada \(acumulado até 06\/2026\)/);
    expect(j).toMatch(/exercício fechado anterior/);
  });

  it("JANELA PARCIAL SEM exercício fechado: não manda comparar com o que não existe", async () => {
    criar.mockReset(); criar.mockResolvedValueOnce(resposta({}));
    const ps = ["31/03/2026", "30/04/2026", "31/05/2026"];
    const ind = INDICADORES.map((i) => ({ ...i, valores: Object.fromEntries(ps.map((p) => [p, i.valores[P]])) }));
    const r = await generateAnalysis(ind as never, ps, { razaoSocial: "X", setor: "Y", porte: "Z" }, "31/05/2026");
    const j = r.result.estagioCicloVida?.justificativa ?? "";
    expect(j).not.toMatch(/exercício fechado anterior/);
    expect(j).toMatch(/sem um exercício fechado para comparar/);
  });

  it("margem negativa menor que 1% não vira 'cerca de R$ 0'", async () => {
    criar.mockReset(); criar.mockResolvedValueOnce(resposta({}));
    const ind = INDICADORES.map((i) => i.nome === "Margem EBITDA" ? { ...i, valores: { ...i.valores, [P]: -0.003 } } : i);
    const r = await generateAnalysis(ind as never, [P0, P1, P], { razaoSocial: "X", setor: "Y", porte: "Z" }, P);
    expect(r.result.estagioCicloVida?.justificativa ?? "").toMatch(/deixam menos de R\$ 1 de resultado operacional negativo/);
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

describe("o quadro FÔLEGO FINANCEIRO (coluna): o motor escreve o que o define", () => {
  it("declara a pontuação nos testes de estrutura e a régua que separa os níveis", async () => {
    const { result } = await gerar();
    const so = result.estagioCicloVida?.solidez;
    expect(so?.nivel).toBe("frágil");
    expect(so?.oQueDefine).toMatch(/^O que define o fôlego financeiro: a estrutura da empresa passa por 3 testes/);
    expect(so?.oQueDefine).toMatch(/somou 0 de 6/);
    expect(so?.oQueDefine).toMatch(/é frágil quando fica abaixo de 40% dos pontos/);
    expect(so?.oQueDefine).toMatch(/piorou em relação ao período anterior/);
  });

  it("o nível do quadro de fôlego É o nível da solidez do motor (título e coluna da mesma fonte)", async () => {
    const { result } = await gerar({ folegoFinanceiro: { leitura: "Explicação da IA." } });
    expect(result.folegoFinanceiro?.nivel).toBe("frágil");
    expect(result.folegoFinanceiro?.leitura).toBe("Explicação da IA.");
    expect(result.folegoFinanceiro?.diasDeCaixa).toBe(7);
  });

  it("sem solidez do motor o quadro fica SEM NÍVEL, mas a leitura da IA não se perde", async () => {
    // A primeira versão descartava o quadro inteiro — e com ele o relógio, a
    // cobertura de juros e "o que precisa acontecer" que a IA tinha escrito.
    // A coluna não foi medida e o título não a inventa; o texto fica.
    criar.mockReset();
    criar.mockResolvedValueOnce(resposta({ folegoFinanceiro: { leitura: "Texto sem nível." } }));
    const ind = INDICADORES.filter((i) => !/Kanitz|Altman|Fleuriet/.test(i.nome));
    const r = await generateAnalysis(ind as never, [P0, P1, P], { razaoSocial: "X", setor: "Y", porte: "Z" }, P);
    expect(r.result.estagioCicloVida?.solidez).toBeUndefined();
    expect(r.result.folegoFinanceiro?.nivel).toBe("");
    expect(r.result.folegoFinanceiro?.leitura).toBe("Texto sem nível.");
  });

  it("1 PERÍODO: o estágio tem rótulo e motivo, e o fôlego tem coluna (a solidez é calculável)", async () => {
    // Regressão pega na revisão: um `else if` pendurado no `if` errado deixava
    // o quadro com título VAZIO e descartava a leitura do fôlego em todo IBR de
    // 1 período. E a solidez era calculável o tempo todo — só não era chamada.
    criar.mockReset();
    criar.mockResolvedValueOnce(resposta({
      estagioCicloVida: { leitura: "Leitura do estágio pela IA." },
      folegoFinanceiro: { leitura: "Leitura do fôlego pela IA." },
    }));
    const ind = INDICADORES.map((i) => ({ ...i, valores: { [P]: i.valores[P] } }));
    const r = await generateAnalysis(ind as never, [P], { razaoSocial: "X", setor: "Y", porte: "Z" }, P, null, null, null, null, DRE as never, null, null, BP as never, [P], []);
    expect(r.result.estagioCicloVida?.estagio).toBe("Indeterminado (período curto)");
    expect(r.result.estagioCicloVida?.justificativa).toMatch(/^O que define o estágio: só há um período na série/);
    expect(r.result.estagioCicloVida?.leitura).toBe("Leitura do estágio pela IA.");
    expect(r.result.estagioCicloVida?.solidez?.nivel).toBe("frágil");
    expect(r.result.folegoFinanceiro?.nivel).toBe("frágil");
    expect(r.result.folegoFinanceiro?.leitura).toBe("Leitura do fôlego pela IA.");
  });

  it("a frase do fôlego nomeia SÓ os testes aplicados, e diz qual faltou", async () => {
    criar.mockReset(); criar.mockResolvedValueOnce(resposta({}));
    const semFleuriet = INDICADORES.filter((i) => !/Fleuriet/.test(i.nome));
    const r = await generateAnalysis(semFleuriet as never, [P0, P1, P], { razaoSocial: "X", setor: "Y", porte: "Z" }, P);
    const f = r.result.estagioCicloVida?.solidez?.oQueDefine ?? "";
    expect(f).toMatch(/passa por 2 testes \(solvência e risco de insolvência\)/);
    expect(f).toMatch(/somou 0 de 4/);
    expect(f).toMatch(/O teste de capital de giro não pôde ser aplicado/);
    expect(f).not.toMatch(/capital de giro, solvência e risco/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// O CONTRATO COM A IA
// ═══════════════════════════════════════════════════════════════════════════

describe("o prompt: dois quadros, um por eixo, e os gatilhos como fato", () => {
  it("o schema pede estagioCicloVida.leitura e folegoFinanceiro.leitura — e NÃO pede situação nem saúde", async () => {
    const { prompt } = await gerar();
    expect(prompt).toMatch(/"estagioCicloVida": \{ "leitura": "<COMO A EMPRESA CHEGOU A ESTE ESTÁGIO/);
    expect(prompt).toMatch(/"folegoFinanceiro": \{ "leitura": "<POR QUE A EMPRESA ESTÁ NESTE FÔLEGO/);
    expect(prompt).not.toMatch(/"situacao": \{/);
    expect(prompt).not.toMatch(/"saudeFinanceira": \{/);
    expect(prompt).not.toMatch(/dificuldade financeira/);
  });

  it("o motor entrega os DOIS gatilhos como verdade, para a IA explicar e não reclassificar", async () => {
    const { prompt } = await gerar();
    expect(prompt).toMatch(/ESTÁGIO DO CICLO \(determinado pelo MOTOR[^\n]*Pressão de caixa\. [^\n]*O que define o estágio:/);
    expect(prompt).toMatch(/FÔLEGO FINANCEIRO \(determinado pelo MOTOR[^\n]*frágil\. O que define o fôlego financeiro:/);
    expect(prompt).toMatch(/DOIS QUADROS, UM POR EIXO DA MATRIZ/);
    expect(prompt).toMatch(/não há texto padrão/);
  });

  it("cada número em um quadro só, pela natureza do dado; solvência vem do sistema", async () => {
    const { prompt } = await gerar();
    expect(prompt).toMatch(/CADA NÚMERO APARECE EM UM QUADRO SÓ, pela natureza do dado/);
    expect(prompt).toMatch(/NÃO cite Kanitz, Altman nem "indicadores de solvência" em folegoFinanceiro\.leitura/);
    expect(prompt).toMatch(/SEM CLASSIFICAÇÃO PRÓPRIA/);
  });

  it("ensina as DEFINIÇÕES EXATAS, não as imprecisas", async () => {
    const { prompt } = await gerar();
    expect(prompt).toMatch(/possui R\$ X em ativos circulantes/);
    expect(prompt).not.toMatch(/tem apenas R\$ 0,01 para pagar/);
    expect(prompt).not.toMatch(/que vence, há R\$ 0,01 para cobrir/);
    expect(prompt).toMatch(/dos ativos são financiados por capital de terceiros/);
    expect(prompt).toMatch(/cobertura de juros é EBITDA sobre despesas financeiras/);
    expect(prompt).toMatch(/sem "termômetros"/);
  });

  it("UM relógio só, em todo o prompt", async () => {
    const { prompt } = await gerar();
    expect(prompt).toMatch(/cobre 7 dias de desembolsos da operação/);
    expect(prompt).toMatch(/O RELÓGIO É UM SÓ/);
    expect(prompt).not.toMatch(/Estime meses de caixa/);
    expect(prompt).not.toMatch(/o caixa acaba\/dobra em N meses/);
    expect(prompt).not.toMatch(/runway/);
    expect(prompt).not.toMatch(/de "saudável" a "crise"/);
    const bloco = prompt.slice(prompt.indexOf("CONTA REGRESSIVA DE CAIXA"), prompt.indexOf("CONTA REGRESSIVA DE CAIXA") + 600);
    expect(bloco).not.toMatch(/se esgota|meses/);
  });

  it("2 ou 3 parágrafos por quadro; dois indicadores por FRASE", async () => {
    const { prompt } = await gerar();
    expect(prompt).toMatch(/2 ou 3 parágrafos curtos separados por uma linha em branco/);
    expect(prompt).toMatch(/no máximo dois indicadores por FRASE/);
    expect(prompt).not.toMatch(/UM parágrafo corrido/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CAMADA DE CONSISTÊNCIA NO PARSE
// ═══════════════════════════════════════════════════════════════════════════

describe("camada de consistência", () => {
  it("a PROSA com segundo relógio é removida dos dois quadros e de todos os campos de texto", async () => {
    const { result } = await gerar({
      estagioCicloVida: { leitura: "A trajetória. O caixa se esgota em 16 meses." },
      folegoFinanceiro: { leitura: "O caixa de hoje cobre 7 dias de desembolsos. No ritmo atual o caixa acaba em cerca de 16 meses. A variável decisiva é a safra." },
      destaques: ["Caixa cobre 7 dias", "Caixa se esgota em 16 meses"],
      revelacoes: [
        { titulo: "O caixa se esgota em 16 meses", dadoEscondido: "x", comoChegou: "y" },
        { titulo: "Revelação legítima", dadoEscondido: "y", comoChegou: "z" },
      ],
      parecerExecutivo: { tese: "Sustentaria a operação por 17,5 meses. Precisa recompor caixa.", numeros: [], decisoes: [], proteger: [] },
      recomendacoes: [{ titulo: "R", sinalId: "x", horizonte: "0–30d", descricao: "Faça isso. A reserva duraria 16 meses." }],
    });
    expect(result.estagioCicloVida?.leitura).toBe("A trajetória.");
    expect(result.folegoFinanceiro?.leitura).toBe("O caixa de hoje cobre 7 dias de desembolsos. A variável decisiva é a safra.");
    expect(result.destaques).toEqual(["Caixa cobre 7 dias"]);
    expect(result.revelacoes?.map((r) => r.titulo)).toEqual(["Revelação legítima"]);
    expect(result.parecerExecutivo?.tese).toBe("Precisa recompor caixa.");
    expect(result.recomendacoes?.[0]?.descricao).toBe("Faça isso.");
  });

  it("PRECISÃO: frases legítimas sobre meses e caixa NÃO são apagadas", async () => {
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
    const { result } = await gerar({ folegoFinanceiro: { leitura: legitimas.join(" ") }, destaques: legitimas });
    expect(result.folegoFinanceiro?.leitura).toBe(legitimas.join(" "));
    expect(result.destaques).toEqual(legitimas);
  });

  it("frase composta NÃO leva o relógio do motor junto", async () => {
    const { result } = await gerar({
      folegoFinanceiro: { leitura: "A reserva cobre 7 dias de desembolsos da operação; no ritmo atual o caixa acaba em cerca de 16 meses. A safra só entra em março." },
    });
    expect(result.folegoFinanceiro?.leitura).toBe("A reserva cobre 7 dias de desembolsos da operação. A safra só entra em março.");
  });

  it("sem relógio do motor, a prosa da IA passa intacta", async () => {
    criar.mockReset();
    criar.mockResolvedValueOnce(resposta({ folegoFinanceiro: { leitura: "A reserva duraria 6 meses." } }));
    const r = await generateAnalysis(INDICADORES as never, [P0, P1, P], { razaoSocial: "X", setor: "Y", porte: "Z" }, P);
    expect(r.result.folegoFinanceiro?.leitura).toBe("A reserva duraria 6 meses.");
  });

  it("a IA NÃO consegue reclassificar o estágio nem o fôlego pelo JSON", async () => {
    const { result } = await gerar({
      estagioCicloVida: { estagio: "Crescimento", justificativa: "inventada", leitura: "ok" },
      folegoFinanceiro: { nivel: "sólida", leitura: "ok" },
    });
    expect(result.estagioCicloVida?.estagio).toBe("Pressão de caixa");
    expect(result.estagioCicloVida?.justificativa).toMatch(/^Na janela de 2026/);
    expect(result.estagioCicloVida?.leitura).toBe("ok");
    expect(result.folegoFinanceiro?.nivel).toBe("frágil");
  });

  it("os campos antigos (situação, saúde) não são mais produzidos", async () => {
    const { result } = await gerar({ situacao: { classificacao: "x", racional: "y" }, saudeFinanceira: { status: "z", leitura: "w" } });
    expect(result.situacao).toBeUndefined();
    expect(result.saudeFinanceira).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ACHADOS DA REVISÃO ADVERSARIAL (21/08/2026) — a bancada era cega para eles
// ═══════════════════════════════════════════════════════════════════════════

describe("o filtro do segundo relógio não apaga história legítima", () => {
  it("#1 caixa NO PASSADO é história, não relógio — a frase fica", async () => {
    const legitimas = [
      "O caixa terminou em 2025 com R$ 3,4 milhões, contra R$ 1,1 milhão no ano anterior.",
      "O caixa zerou em 2023 e foi recomposto com aporte dos sócios no ano seguinte.",
      "A concessão se esgota em 2028 e a renovação depende do órgão regulador.",
      "O contrato de fornecimento se esgota em dezembro, e a renovação ainda não foi assinada.",
      "O prejuízo duraria 2 anos no ritmo atual caso nada mude na precificação.",
      "A reserva acabou em 3 meses de atraso dos clientes.",
      "A disponibilidade do crédito rural termina em 6 meses.",
    ];
    const { result } = await gerar({ estagioCicloVida: { leitura: legitimas.join(" ") }, folegoFinanceiro: { leitura: legitimas.join(" ") } });
    expect(result.estagioCicloVida?.leitura).toBe(legitimas.join(" "));
    expect(result.folegoFinanceiro?.leitura).toBe(legitimas.join(" "));
  });

  it("#1 a trajetória de caixa que o próprio prompt pede sobrevive inteira", async () => {
    const trajetoria = "A empresa saiu de R$ 18,8 milhões de faturamento em 2024 para R$ 26,3 milhões em 2025. O caixa terminou em 2025 com R$ 3,4 milhões, depois de R$ 4,0 milhões gerados pela operação. A margem subiu de 11% para 13,1% no mesmo intervalo.";
    const { result } = await gerar({ estagioCicloVida: { leitura: trajetoria } });
    expect(result.estagioCicloVida?.leitura).toBe(trajetoria);
  });

  it("#1 o relógio de verdade continua saindo", async () => {
    const { result } = await gerar({
      folegoFinanceiro: { leitura: "A estrutura é apertada. No ritmo atual o caixa acaba em cerca de 16 meses. A safra entra em março." },
      estagioCicloVida: { leitura: "A operação piorou. A reserva duraria 6 meses. O ponto de virada foi a safra." },
    });
    expect(result.folegoFinanceiro?.leitura).not.toContain("16 meses");
    expect(result.folegoFinanceiro?.leitura).toContain("A safra entra em março.");
    expect(result.estagioCicloVida?.leitura).not.toContain("duraria 6 meses");
    expect(result.estagioCicloVida?.leitura).toContain("O ponto de virada foi a safra.");
  });
});

describe("o quadro de fôlego é do motor, não da IA", () => {
  it("#17 sem o objeto da IA, o nível e o relógio do motor ainda chegam ao quadro", async () => {
    const { result } = await gerar({});
    expect(result.folegoFinanceiro).toBeTruthy();
    expect(result.folegoFinanceiro?.nivel).toBe(result.estagioCicloVida?.solidez?.nivel ?? "");
    expect(result.folegoFinanceiro?.diasDeCaixa).toBe(result.contaRegressiva?.diasDeCaixa != null ? Math.round(result.contaRegressiva.diasDeCaixa) : undefined);
    expect(result.folegoFinanceiro?.leitura).toBe("");
  });
});

describe("o prompt não guarda referência morta nem manda repetir número", () => {
  it("#18 fala em DOIS quadros — 'três cartões', 'cartão de saúde' e 'racional da situação' saíram", async () => {
    const { prompt } = await gerar();
    expect(prompt).not.toContain("três cartões");
    expect(prompt).not.toContain("cartão de saúde");
    expect(prompt).not.toContain("racional da situação");
    expect(prompt).toContain("dois quadros do diagnóstico");
  });

  it("#16 proíbe repetir no Fôlego a liquidez que o gatilho do Estágio já citou", async () => {
    const { prompt } = await gerar();
    expect(prompt).toContain("ESGOTA aquele número");
    expect(prompt).toContain("QUANDO o gatilho do Estágio ainda não as tiver citado");
  });
});
