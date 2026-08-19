/**
 * BANCADA INSTITUTO AOCP — o balancete de ENCERRAMENTO que publicou a receita
 * negativa (19/08/2026, PRODUÇÃO).
 *
 * O documento: balancete consolidado 01/01 a 31/12/2023 de uma entidade do
 * TERCEIRO SETOR, 1.474 contas, exercício encerrado — todas as contas de
 * resultado com saldo anterior 0,00, saldo atual 0,00 e débito == crédito.
 *
 * O estrago, medido: a DRE saiu INTEIRA negativa (receita −44.233.132,32, soma
 * −84.234.066,99, que é exatamente a coluna de débito da raiz) e ainda assim o
 * documento recebeu selo verde. Dois defeitos independentes no mesmo arquivo:
 *
 *  1. SINAL — nenhum degrau da resolução de natureza enxerga uma conta zerada
 *     com D == C, então valia a semente da RAIZ; a raiz chama-se "SUPERÁVIT /
 *     DÉFICIT DO EXERCÍCIO", não casava o vocabulário de receita e semeava "D"
 *     para as 105 folhas do grupo. `paraDREItem` no ramo do encerramento faz
 *     `natureza === "C" ? crédito : −débito`, e a receita virou despesa.
 *  2. SELO — o P4, a ÚNICA prova apontada para a DRE de encerramento, procura a
 *     âncora do resultado no PL e não conhecia "Superávit (Deficit) Acumulado".
 *     Lista vazia → `ok = true` por curto-circuito: gap de R$ 84.234.066,99
 *     contra limite de R$ 5.000 foi APROVADO, e a trava que existe desde o caso
 *     Belagro 2023 nunca disparou.
 *
 * A matriz abaixo é FIEL ao documento: os saldos e movimentos são os reais, e
 * as folhas foram escolhidas de modo que Σ débitos = Σ créditos = R$
 * 465.655.263,57 — a mesma partida dobrada que o arquivo inteiro produz. Cada
 * número aqui reconcilia contra o PDF; se um falhar, o produto volta a publicar
 * demonstração invertida com selo de conferida.
 */
import { describe, it, expect } from "vitest";
import { parseBalanceteMatriz } from "./balancete-tabular";
import { converterBalancete, naturezaPeloNome } from "./balancete-conversao";

const CAB = ["Classificação", "Nome da conta contábil", "Saldo anterior", "Débito", "Crédito", "Saldo atual"];
type L = [string, string, string, string, string, string];

/** Série real do Instituto AOCP, 2023 (BALANCETE 2023 - IAOCP.PDF). */
const IAOCP: L[] = [
  ["1", "ATIVO", "9790384.91D", "290900710.54", "286182557.01", "14508538.44D"],
  ["1.1", "ATIVO CIRCULANTE", "5706552.71D", "290758255.06", "283176014.91", "13288792.86D"],
  ["1.2", "ATIVO NAO CIRCULANTE", "4083832.20D", "142455.48", "3006542.10", "1219745.58D"],
  ["2", "PASSIVO", "9790384.91C", "44733373.52", "49451527.05", "14508538.44C"],
  ["2.1", "PASSIVO CIRCULANTE", "5702543.42C", "43300488.30", "40644371.06", "3046426.18C"],
  ["2.2", "PASSIVO NAO CIRCULANTE", "1460795.27C", "1141153.23", "945734.13", "1265376.17C"],
  ["2.4", "PATRIMÔNIO SOCIAL LÍQUIDO", "2627046.22C", "291731.99", "7861421.86", "10196736.09C"],
  ["2.4.3.01.001", "Superávit (Deficit) Acumulado", "2627046.22C", "291731.99", "7861421.86", "10196736.09C"],
  // Raiz de RESULTADO cujo nome não fala de receita — a origem da semente "D".
  ["3", "SUPERÁVIT / DÉFICIT DO EXERCÍCIO", "0.00", "84234066.99", "84234066.99", "0.00"],
  ["3.1", "RECEITAS", "0.00", "44233132.32", "44233132.32", "0.00"],
  ["3.1.1.01.002", "Receitas com Concursos Prestados", "0.00", "44233132.32", "44233132.32", "0.00"],
  ["3.2", "DEDUÇÕES DA RECEITA BRUTA", "0.00", "1326898.10", "1326898.10", "0.00"],
  ["3.2.1.01.001", "Issqn", "0.00", "1326898.10", "1326898.10", "0.00"],
  ["3.3", "CUSTOS OPERACIONAIS", "0.00", "14889847.28", "14889847.28", "0.00"],
  ["3.3.6.01.001", "Ajuda de Custos - Concursos", "0.00", "14889847.28", "14889847.28", "0.00"],
  ["3.4", "DESPESAS C/ ATIVIDADE FIM", "0.00", "22897847.18", "22897847.18", "0.00"],
  ["3.4.1", "DESPESAS OPERACIONAIS / ADMINISTRATIVAS", "0.00", "21969648.84", "21969648.84", "0.00"],
  ["3.4.2", "INCENTIVO A PROJETOS SOCIAS", "0.00", "17258.61", "17258.61", "0.00"],
  ["3.4.4", "RESULTADOS FINANCEIROS LIQUIDOS", "0.00", "910939.73", "910939.73", "0.00"],
  ["3.4.4.01", "DESPESAS FINANCEIRAS", "0.00", "551398.83", "551398.83", "0.00"],
  // A conta que prova por que a regra tem de ser POR NÓ: receita pendurada
  // dentro de um grupo devedor, dois níveis abaixo de "DESPESAS".
  ["3.4.4.02", "RECEITAS FINANCEIRAS", "0.00", "359540.90", "359540.90", "0.00"],
  ["3.5", "OUTRAS RECEITAS OPERACIONAIS", "0.00", "3975.99", "3975.99", "0.00"],
  ["3.5.1.01.001", "Sobras de Gastos com Concursos", "0.00", "3975.99", "3975.99", "0.00"],
  ["3.6", "OUTRAS RECEITAS NÃO OPERACIOANAIS", "0.00", "881824.07", "881824.07", "0.00"],
  ["3.6.1.01.001", "Recuperação de Despesas", "0.00", "881824.07", "881824.07", "0.00"],
  ["3.7", "DESPESAS INDEDUTIVEIS", "0.00", "542.05", "542.05", "0.00"],
  ["4", "RESULTADO DO EXERCÍCIO", "0.00", "45787112.52", "45787112.52", "0.00"],
  ["4.1", "Resultado Líquido do Exercício", "0.00", "45787112.52", "45787112.52", "0.00"],
];

const ler = (linhas: L[], janela = "01/01/2023 a 31/12/2023") =>
  converterBalancete(parseBalanceteMatriz([[janela], CAB, ...linhas] as never));

type Item = { nome: string; valor: number; filhos?: Item[] };
const secoes = (c: ReturnType<typeof converterBalancete>): Item[] =>
  ((c.arvoreDRE as Record<string, Item[]>)[c.periodoBP] ?? []);
const sec = (c: ReturnType<typeof converterBalancete>, nome: string): Item | undefined =>
  secoes(c).find((s) => s.nome === nome);
const achar = (itens: Item[], nome: string): Item | undefined => {
  for (const i of itens) {
    if (i.nome === nome) return i;
    const f = i.filhos ? achar(i.filhos, nome) : undefined;
    if (f) return f;
  }
  return undefined;
};
const soma = (c: ReturnType<typeof converterBalancete>) => secoes(c).reduce((s, x) => s + x.valor, 0);

const CONV = ler(IAOCP);

describe("bancada IAOCP — a leitura do documento", () => {
  it("é reconhecido como exercício encerrado", () => {
    expect(CONV.provas.exercicioEncerrado).toBe(true);
  });

  it("P0 — partida dobrada fecha nas folhas lidas (R$ 465.655.263,57 dos dois lados)", () => {
    const pd = CONV.provas.partidaDobrada;
    expect(pd.verificavel).toBe(true);
    expect(pd.debitos).toBeCloseTo(465_655_263.57, 2);
    expect(pd.creditos).toBeCloseTo(465_655_263.57, 2);
    expect(pd.ok).toBe(true);
  });

  it("P2 — fechamento patrimonial: Ativo = Passivo = R$ 14.508.538,44", () => {
    expect(CONV.provas.fechamento.ativo).toBeCloseTo(14_508_538.44, 2);
    expect(CONV.provas.fechamento.passivo).toBeCloseTo(14_508_538.44, 2);
    expect(CONV.provas.fechamento.ok).toBe(true);
  });

  it("P3 — todas as linhas coerentes nas quatro colunas", () => {
    expect(CONV.provas.linhas.incoerentes).toHaveLength(0);
    expect(CONV.provas.linhas.ok).toBe(true);
  });
});

describe("bancada IAOCP — o SINAL (defeito 1)", () => {
  it("RECEITAS entra POSITIVA (era −44.233.132,32: a receita publicada como despesa)", () => {
    expect(sec(CONV, "RECEITAS")?.valor).toBeCloseTo(44_233_132.32, 2);
  });

  it('a folha "Receitas com Concursos Prestados" carrega a receita inteira, positiva', () => {
    expect(achar(secoes(CONV), "Receitas com Concursos Prestados")?.valor).toBeCloseTo(44_233_132.32, 2);
  });

  it("NENHUMA seção da DRE ficou com o sinal contrário ao que o nome declara", () => {
    for (const s of secoes(CONV)) {
      const porNome = naturezaPeloNome(s.nome);
      if (porNome === "C") expect(s.valor).toBeGreaterThan(0);
      if (porNome === "D") expect(s.valor).toBeLessThan(0);
    }
  });

  it("receita financeira pendurada em grupo devedor entra credora — a regra é por NÓ, não por seção", () => {
    // R$ 359.540,90 três níveis abaixo de "DESPESAS C/ ATIVIDADE FIM". Com a
    // convenção do avô valia −359.540,90 e a seção inteira saía −22.897.847,18.
    expect(achar(secoes(CONV), "RECEITAS FINANCEIRAS")?.valor).toBeCloseTo(359_540.90, 2);
    expect(achar(secoes(CONV), "DESPESAS FINANCEIRAS")?.valor).toBeCloseTo(-551_398.83, 2);
    expect(sec(CONV, "DESPESAS C/ ATIVIDADE FIM")?.valor).toBeCloseTo(-22_178_765.38, 2);
  });

  it('"DEDUÇÕES DA RECEITA BRUTA" é redutora apesar da palavra RECEITA no nome', () => {
    // Sem a precedência da família REDUTORA o ISSQN entrava somando: erro
    // medido de R$ 2.653.796,20 (duas vezes 1.326.898,10) no resultado.
    expect(sec(CONV, "DEDUÇÕES DA RECEITA BRUTA")?.valor).toBeCloseTo(-1_326_898.10, 2);
    expect(achar(secoes(CONV), "Issqn")?.valor).toBeCloseTo(-1_326_898.10, 2);
  });

  it("conta de nome CONTRADITÓRIO defere ao pai em vez de chutar", () => {
    // "Sobras de Gastos com Concursos" e "Recuperação de Despesas" falam as
    // duas línguas; quem acerta é o pai, que se declara receita.
    expect(achar(secoes(CONV), "Sobras de Gastos com Concursos")?.valor).toBeCloseTo(3_975.99, 2);
    expect(achar(secoes(CONV), "Recuperação de Despesas")?.valor).toBeCloseTo(881_824.07, 2);
  });

  it("a DRE soma +6.722.879,57 (era −84.234.066,99 = a coluna de débito da raiz)", () => {
    expect(soma(CONV)).toBeCloseTo(6_722_879.57, 2);
  });

  it("a apuração continua fora da DRE (R$ 45.787.112,52 de contra-lançamento)", () => {
    expect(secoes(CONV).some((s) => /RESULTADO LÍQUIDO/i.test(s.nome))).toBe(false);
  });
});

describe("bancada IAOCP — o SELO (defeito 2)", () => {
  it("P4 encontra a âncora do terceiro setor no PL", () => {
    const p4 = CONV.provas.dreEncerrada;
    expect(p4?.verificavel).toBe(true);
    expect(p4?.ancora).toBe("Superávit (Deficit) Acumulado");
    // 10.196.736,09C − 2.627.046,22C = a variação do superávit no ano.
    expect(p4?.declaradoPL).toBeCloseTo(7_569_689.87, 2);
  });

  it("com o sinal certo o arame de tropeço NÃO dispara", () => {
    expect(CONV.provas.dreEncerrada?.sinalUnico).toBe(false);
  });

  it("o gap contra o PL fica dentro da faixa e o documento publica", () => {
    const p4 = CONV.provas.dreEncerrada!;
    // R$ 846.810,30 = 1,9% da receita — dentro da faixa de 10% que existe
    // porque uso do superávit mexe no PL sem passar pela DRE. É o número que
    // o analista tem de conferir contra a demonstração oficial.
    expect(p4.gap).toBeCloseTo(846_810.30, 2);
    expect(p4.gap).toBeLessThanOrEqual(p4.limite);
    expect(p4.ok).toBe(true);
  });

  it("SEM âncora no PL a prova é NÃO-VERIFICÁVEL e reprova — nunca aprova por lista vazia", () => {
    // Era exatamente este o estado do documento antes do conserto: gap de
    // R$ 84.234.066,99 contra limite de R$ 5.000, com ok = true.
    const semAncora = ler(IAOCP.map((l) =>
      (l[1] === "Superávit (Deficit) Acumulado" ? [l[0], "Conta Patrimonial", l[2], l[3], l[4], l[5]] as L : l)));
    const p4 = semAncora.provas.dreEncerrada;
    expect(p4).toBeDefined();
    expect(p4?.verificavel).toBe(false);
    expect(p4?.ancora).toBeNull();
    expect(p4?.ok).toBe(false);
    expect(semAncora.avisos.some((a) => /não oferece âncora/i.test(a))).toBe(true);
  });

  it("SEM coluna de saldo anterior o P4 existe e reprova (antes nem era criado)", () => {
    const semAnterior = ler(IAOCP.map((l) => [l[0], l[1], "0.00", l[3], l[4], l[5]] as L));
    expect(semAnterior.provas.exercicioEncerrado).toBe(true);
    expect(semAnterior.provas.dreEncerrada?.verificavel).toBe(false);
    expect(semAnterior.provas.dreEncerrada?.ok).toBe(false);
  });
});

describe("arame de tropeço — DRE de sinal único no encerramento", () => {
  // COM saldo anterior de verdade: sem ele `temSaldosAnteriores` é falso, a
  // lista de âncoras nasce vazia e o teste passaria por não-verificável em vez
  // de pelo arame — exatamente o defeito de assert que a revisão apontou.
  const base: L[] = [
    ["1", "ATIVO", "100.00D", "300.00", "100.00", "300.00D"],
    ["2", "PASSIVO", "100.00C", "100.00", "300.00", "300.00C"],
    ["2.4", "PATRIMONIO LIQUIDO", "100.00C", "100.00", "300.00", "300.00C"],
    ["2.4.1", "Lucros Acumulados", "100.00C", "100.00", "300.00", "300.00C"],
  ];

  it("dispara quando uma seção que se diz RECEITA sai com o mesmo sinal das demais", () => {
    const c = ler([...base,
      ["3", "RESULTADO GERAL", "0.00", "300.00", "300.00", "0.00"],
      ["3.1", "RECEITAS OPERACIONAIS", "0.00", "100.00", "100.00", "0.00"],
      ["3.1.01", "Despesa com Pessoal", "0.00", "100.00", "100.00", "0.00"],
      ["3.2", "CUSTOS", "0.00", "200.00", "200.00", "0.00"],
      ["3.2.01", "Custo Direto", "0.00", "200.00", "200.00", "0.00"],
    ]);
    const p4 = c.provas.dreEncerrada!;
    // O arame tem de ser o ÚNICO motivo da reprovação — senão o assert passa
    // pelo motivo errado e o dia em que alguém tirar a trava a suíte fica verde
    // (foi o que a revisão adversarial cobrou desta bancada).
    expect(p4.verificavel).toBe(true);
    expect(p4.gap).toBeLessThanOrEqual(p4.limite);
    expect(p4.sinalUnico).toBe(true);
    expect(p4.ok).toBe(false);
    expect(c.avisos.some((a) => /mesmo sinal/i.test(a))).toBe(true);
  });

  it("NÃO dispara na entidade que só tem despesa (nenhuma seção se diz receita)", () => {
    const c = ler([...base,
      ["3", "RESULTADO GERAL", "0.00", "300.00", "300.00", "0.00"],
      ["3.1", "DESPESAS ADMINISTRATIVAS", "0.00", "100.00", "100.00", "0.00"],
      ["3.1.01", "Aluguel", "0.00", "100.00", "100.00", "0.00"],
      ["3.2", "DESPESAS FINANCEIRAS", "0.00", "200.00", "200.00", "0.00"],
      ["3.2.01", "Juros Pagos", "0.00", "200.00", "200.00", "0.00"],
    ]);
    expect(c.provas.dreEncerrada?.sinalUnico).toBe(false);
  });
});

describe("as travas do degrau do nome", () => {
  it("nó zerado com D == C mas FILHOS COM SALDO não reseta a subárvore", () => {
    // Documento CORRENTE (não encerrado) com um nó de trânsito: "RECEITAS DE
    // REPASSE" fecha em zero no período e o léxico o leria como credor, mas os
    // filhos têm saldo e a convenção deles não pode ser virada por um pai que
    // não tem lado. Sem a trava `subarvoreEncerrada`, "Custo de Repasse" saía
    // positivo.
    const c = ler([
      ["1", "ATIVO", "0.00", "1000.00", "0.00", "1000.00D"],
      ["2", "PASSIVO", "0.00", "0.00", "1000.00", "1000.00C"],
      ["3", "RESULTADO", "0.00", "800.00", "800.00", "0.00"],
      ["3.1", "RECEITAS DE REPASSE", "0.00", "800.00", "800.00", "0.00"],
      ["3.1.01", "Custo de Repasse", "0.00", "800.00", "0.00", "800.00D"],
    ], "01/05/2026 a 31/05/2026");
    expect(c.provas.exercicioEncerrado).toBe(false);
    expect(achar(secoes(c), "Custo de Repasse")?.valor).toBeCloseTo(-800, 2);
  });

  it("a faixa do P4 é amarrada também na ÂNCORA, não só na receita derivada", () => {
    // Transferência interna infla a receita derivada e, com ela, o teto: sem a
    // amarra em 25% do que o PL declara, a tolerância cresce junto com o erro
    // que a prova existe para pegar.
    const c = ler([
      ["1", "ATIVO", "1000.00D", "1000.00", "0.00", "2000.00D"],
      ["2", "PASSIVO", "1000.00C", "0.00", "1000.00", "2000.00C"],
      ["2.4", "PATRIMONIO LIQUIDO", "1000.00C", "0.00", "1000.00", "2000.00C"],
      ["2.4.1", "Lucros Acumulados", "1000.00C", "0.00", "1000.00", "2000.00C"],
      ["3", "RESULTADO", "0.00", "10000000.00", "10000000.00", "0.00"],
      ["3.1", "RECEITAS", "0.00", "6000000.00", "6000000.00", "0.00"],
      ["3.2", "CUSTOS", "0.00", "4000000.00", "4000000.00", "0.00"],
    ]);
    const p4 = c.provas.dreEncerrada!;
    expect(p4.verificavel).toBe(true);
    expect(p4.declaradoPL).toBeCloseTo(1_000, 2);
    // 10% da receita derivada daria 600.000,00; 25% da âncora dá 250,00 — vence
    // o piso de 5.000, não os 600 mil que a própria inflação criaria.
    expect(p4.limite).toBeCloseTo(5_000, 2);
    expect(p4.ok).toBe(false);
  });

  it("âncora CONGELADA não verifica nada — existir a conta não é ter medido", () => {
    // O PL traz "Lucros Acumulados" parada em 300,00C nos dois retratos (o
    // resultado do ano foi para outra conta, ou foi distribuído). A conta CASA
    // o filtro, mas `declaradoPL` sai 0,00 e o P4 degeneraria em "a DRE cabe em
    // 10% da receita?": derivado +400,00 contra ZERO, gap 400,00 ≤ 5.000 →
    // selo verde comparado contra nada. Este é o único assert que trava a
    // diferença entre "medi e passou" e "não tinha o que medir".
    const c = ler([
      ["1", "ATIVO", "1000.00D", "500.00", "0.00", "1500.00D"],
      ["2", "PASSIVO", "1000.00C", "100.00", "600.00", "1500.00C"],
      ["2.1", "FORNECEDORES", "700.00C", "0.00", "500.00", "1200.00C"],
      ["2.4", "PATRIMONIO LIQUIDO", "300.00C", "100.00", "100.00", "300.00C"],
      ["2.4.1", "Lucros Acumulados", "300.00C", "100.00", "100.00", "300.00C"],
      ["3", "RESULTADO", "0.00", "2000.00", "2000.00", "0.00"],
      ["3.1", "RECEITAS", "0.00", "1200.00", "1200.00", "0.00"],
      ["3.2", "CUSTOS", "0.00", "800.00", "800.00", "0.00"],
    ]);
    const p4 = c.provas.dreEncerrada!;
    expect(p4.declaradoPL).toBeCloseTo(0, 2);
    expect(p4.sinalUnico).toBe(false);        // o arame não é quem reprova aqui
    expect(p4.gap).toBeLessThanOrEqual(5_000); // nem o gap
    expect(p4.verificavel).toBe(false);        // ← é isto
    expect(p4.ok).toBe(false);
    expect(c.avisos.some((a) => /não oferece âncora/i.test(a))).toBe(true);
  });

  it("verde NÃO é mudo: passar dentro da faixa com diferença material vira aviso", () => {
    expect(CONV.provas.dreEncerrada?.ok).toBe(true);
    expect(CONV.avisos.some((a) => /conferido/i.test(a) && /846\.810,30/.test(a))).toBe(true);
  });
});

describe("naturezaPeloNome — o léxico das três famílias", () => {
  /**
   * A FAMÍLIA QUE DERRUBOU A PRIMEIRA VERSÃO (revisão adversarial, 19/08/2026).
   * "<tributo> sobre receita/vendas/faturamento" é a base de cálculo no nome, e
   * o léxico lia como receita: no SABRINA 2020 a seção "DEDUÇÕES DA RECEITA
   * BRUTA" ia de −16.242,87 para −2.575,97, erro MENOR que o limite do P4 do
   * próprio documento. Fica MUDO (o pai decide), nunca marcado como gasto —
   * numa corretora "Comissões sobre vendas" é receita de verdade.
   */
  it.each([
    "ICMS sobre vendas",
    "PIS SOBRE RECEITA",
    "COFINS S/ FATURAMENTO",
    "PIS sobre vendas e serviços",
    "ISSQN sobre serviços",
    "Simples Nacional sobre faturamento",
    "Comissões sobre vendas",
    "Royalties sobre vendas",
  ])("%s fica MUDO — o nome traz a BASE DE CÁLCULO, não a natureza", (n) =>
    expect(naturezaPeloNome(n)).toBeNull());

  it.each([
    ["TRIBUTOS S/ FATURAMENTO", "D"],
    ["VENDAS CANCELADAS", "D"],
    ["Premios Cancelados", "D"],
  ])("%s continua sendo saída", (n, e) => expect(naturezaPeloNome(n)).toBe(e));

  it("apagar a base de cálculo não apaga a receita de verdade", () => {
    expect(naturezaPeloNome("Receita de Vendas")).toBe("C");
    expect(naturezaPeloNome("Vendas de Produtos")).toBe("C");
    expect(naturezaPeloNome("RECEITAS FINANCEIRAS")).toBe("C");
  });

  it.each([
    ["Receitas com Concursos Prestados", "C"],
    ["RECEITAS FINANCEIRAS", "C"],
    ["Rendto. Aplic. Financeira", "C"],
    ["Descontos Obtidos", "C"],
    ["Venda de Sucatas", "C"],
    ["Subvenção Governamental", "C"],
    ["Reversões de Exercícios Anteriores", "C"],
  ])("%s → receita", (n, esperado) => expect(naturezaPeloNome(n)).toBe(esperado));

  it.each([
    ["DESPESAS C/ ATIVIDADE FIM", "D"],
    ["CUSTOS OPERACIONAIS", "D"],
    ["Ajuda de Custos - Concursos", "D"],
    ["Perdas com Créditos Incobráveis", "D"],
    ["DESPESAS TRIBUTARIAS", "D"],
    ["Encargos Sociais", "D"],
  ])("%s → gasto", (n, esperado) => expect(naturezaPeloNome(n)).toBe(esperado));

  it.each([
    ["DEDUÇÃO DA RECEITA BRUTA", "D"],
    ["DEDUÇÕES DA RECEITA BRUTA", "D"],
    ["IMPOSTOS S/VENDAS E SERVIÇOS", "D"],
    ["(-) Devolução de Vendas", "D"],
    ["Descontos Concedidos", "D"],
    ["Cancelamento de Vendas", "D"],
  ])("%s → redutora vence a palavra RECEITA/VENDAS", (n, esperado) => expect(naturezaPeloNome(n)).toBe(esperado));

  it.each([
    "Recuperação de Despesas",           // receita + gasto
    "Sobras de Gastos com Concursos",    // receita + gasto
    "Reversão de Provisão para Devedores", // reversão (receita) + provisão (gasto)
    "SUPERÁVIT / DÉFICIT DO EXERCÍCIO",  // receita + gasto
    "Contribuição Social sobre o Lucro Líquido", // LUCRO é palavra proibida
    "Resultado de Equivalência Patrimonial",     // RESULTADO é palavra proibida
    "Doações a APAE",                    // DOAÇÃO é palavra proibida
    "Issqn",                             // não fala
    "Transferencia de gestão",           // não fala
  ])("%s fica MUDO — o pai decide", (n) => expect(naturezaPeloNome(n)).toBeNull());
});
