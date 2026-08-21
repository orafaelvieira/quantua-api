/**
 * BANCADA BELAGRO — a prova end-to-end que virou teste.
 *
 * Nasceu de um script de auditoria que rodou por ~37 minutos e achou a raiz de
 * quatro defeitos. Como TESTE ela roda em milissegundos e nunca mais deixa
 * nenhum deles voltar — que é a diferença entre auditar e ter bancada.
 *
 * A série é a real do IBR da Belagro (trading de grãos, safra março-julho):
 * exercícios 2024 e 2025 fechados + 2026 em balancete mensal acumulado. É o
 * formato que o acervo de clientes vai ter, então serve de canário para o
 * caminho inteiro: acumulação, fluxo de caixa, prazos, alavancas e a régua de
 * comparação anual.
 *
 * Cada número aqui reconcilia contra um documento. Se um falhar, o relatório
 * publica número errado — não é teste de implementação, é teste de verdade.
 */
import { describe, it, expect } from "vitest";
import type { BPLineItem, DRELineItem } from "../types/financial";
import { buildIndirectCashFlow } from "./cash-flow-indirect";
import { periodosQueAcumulam, periodosDeExercicioFechado } from "./balancete-conversao";
import { medirProporcionalidade } from "./proporcionalidade";
import { calcularValorCanonico } from "./valor-na-mesa";
import { calculateIndicators } from "./indicator-calculator";
import type { PeerComparisonRow } from "./peer-benchmark";
import { agendaParaPrompt, montarAgenda } from "./prioridade-motor";

const P = ["2024", "30/11/2025", "31/12/2025", "31/01/2026", "28/02/2026", "31/03/2026", "30/04/2026", "31/05/2026"];
const v = (...x: number[]) => Object.fromEntries(P.map((p, i) => [p, x[i]]));
const bpL = (conta: string, classificacao: string, nivel: number, ...x: number[]): BPLineItem =>
  ({ conta, classificacao, nivel, editado: false, valores: v(...x) } as BPLineItem);

const BP: BPLineItem[] = [
  bpL("Ativo Total", "AT", 0, 75_810_000, 161_370_000, 121_200_000, 127_630_000, 152_770_000, 257_920_000, 387_800_000, 444_510_000),
  bpL("Ativo Circulante", "AC", 1, 55_740_000, 134_720_000, 94_800_000, 101_300_000, 125_760_000, 227_450_000, 356_690_000, 413_250_000),
  bpL("Caixa e Equivalentes de Caixa", "AF", 2, 2_102_807, 5_336_133, 997_963, 1_580_489, 1_002_489, 13_551_466, 17_188_501, 14_803_975),
  bpL("Contas a Receber - CP", "AO", 2, 37_800_000, 99_550_000, 67_750_000, 71_100_000, 86_240_000, 140_600_000, 254_470_000, 285_010_000),
  bpL("Passivo Total", "PT", 0, 75_810_000, 161_370_000, 121_200_000, 127_630_000, 152_770_000, 257_920_000, 387_800_000, 444_510_000),
  bpL("Passivo Circulante", "PC", 1, 55_470_000, 125_070_000, 100_120_000, 105_230_000, 130_060_000, 243_140_000, 369_580_000, 427_290_000),
  bpL("Fornecedores - CP", "PO", 2, 19_390_000, 75_120_000, 42_880_000, 44_980_000, 60_040_000, 166_340_000, 266_740_000, 322_280_000),
  bpL("Empréstimos e Financiamentos - CP", "PF", 2, 27_920_000, 49_090_000, 56_390_000, 56_750_000, 62_960_000, 63_030_000, 62_780_000, 65_010_000),
  bpL("Empréstimos e Financiamentos - LP", "PF", 2, 3_280_000, 8_200_000, 3_870_000, 3_870_000, 3_870_000, 3_870_000, 3_870_000, 3_870_000),
  bpL("Patrimônio Líquido", "PL", 1, 14_468_543, 24_956_057, 16_101_635, 17_420_548, 17_730_314, 9_810_000, 13_250_000, 12_238_818),
  bpL("Capital Social", "PL", 2, 2_600_000, 2_600_000, 2_600_000, 2_600_000, 2_600_000, 2_600_000, 2_600_000, 2_600_000),
  bpL("Lucros/Prejuízos Acumulados", "PL", 2, 9_060_000, 11_510_000, 5_870_000, 13_500_000, 13_560_000, 13_560_000, 13_560_000, 13_560_000),
  bpL("Resultado do Exercício", "PL", 2, 2_808_543, 10_846_057, 7_631_635, 1_320_548, 1_570_314, -6_350_000, -2_910_000, -3_921_182),
];
// Linhas de fecho DERIVADAS — sem elas o ativo não soma as folhas e a identidade
// do FC não pode valer. Agregado ao lado do próprio componente conta em dobro:
// foi o erro que travou a montagem desta bancada três vezes seguidas.
const g = (c: string) => BP.find((l) => l.conta === c)!.valores;
const resid = (a: string, ...b: string[]) =>
  Object.fromEntries(P.map((p) => [p, g(a)[p] - b.reduce((s, x) => s + g(x)[p], 0)]));
BP.push({ conta: "Ativo Não Circulante", classificacao: "ANC", nivel: 2, editado: false,
  valores: resid("Ativo Total", "Ativo Circulante") } as BPLineItem);
BP.push({ conta: "Outros Ativos Circulantes", classificacao: "AO", nivel: 2, editado: false,
  valores: resid("Ativo Circulante", "Caixa e Equivalentes de Caixa", "Contas a Receber - CP") } as BPLineItem);
BP.push({ conta: "Outras Obrigações - CP", classificacao: "PO", nivel: 2, editado: false,
  valores: resid("Passivo Circulante", "Fornecedores - CP", "Empréstimos e Financiamentos - CP") } as BPLineItem);
BP.push({ conta: "Outras Obrigações - LP", classificacao: "PNC", nivel: 2, editado: false,
  valores: Object.fromEntries(P.map((p) => [p,
    g("Passivo Total")[p] - g("Passivo Circulante")[p] - g("Patrimônio Líquido")[p] - g("Empréstimos e Financiamentos - LP")[p]])) } as BPLineItem);

const dreL = (conta: string, ...x: number[]): DRELineItem => ({ conta, subtotal: false, editado: false, valores: v(...x) });
const DRE: DRELineItem[] = [
  dreL("Receita Líquida", 592_042_364, 732_757_417, 741_125_792, 3_122_111, 22_188_167, 88_866_310, 228_957_693, 328_504_142),
  dreL("Custo Operacional", -547_420_000, -678_140_000, -685_050_000, -2_840_000, -18_370_000, -87_230_000, -212_550_000, -306_710_000),
  dreL("EBITDA", 15_440_000, 14_640_000, 13_800_000, -1_040_000, 315_000, -7_790_000, -1_450_000, -4_120_000),
  dreL("Despesas Financeiras", -3_650_000, -6_600_000, -8_520_000, -4_410_000, -5_150_000, -5_960_000, -6_710_000, -7_250_000),
  dreL("Lucro Líquido", 11_581_723, 9_669_025, 6_454_351, 1_156_428, 1_573_345, -6_349_796, -2_909_696, -3_918_151),
];
// 31/12/2025 é o FECHAMENTO do exercício: janela declarada de 01/01 a 31/12.
const BALS = P.filter((p) => /^\d{2}\//.test(p))
  .map((p) => (p === "31/12/2025" ? { periodo: p, periodoInicio: "01/01/2025" } : { periodo: p }));
const ACUM = periodosQueAcumulam({ dre: DRE, balancetes: BALS });
const FECH = periodosDeExercicioFechado({ periodos: P, balancetes: BALS });
const ULT = "31/05/2026";

describe("bancada Belagro · as duas listas", () => {
  it("31/12 é ACUMULADO e FECHADO ao mesmo tempo — elas se sobrepõem de propósito", () => {
    expect(ACUM).toContain("31/12/2025");
    expect(FECH).toEqual(["2024", "31/12/2025"]);
  });

  it("janeiro acumula — sem ele, fevereiro herda o fantasma", () => {
    expect(ACUM).toContain("31/01/2026");
  });
});

describe("bancada Belagro · fluxo de caixa", () => {
  const fc = buildIndirectCashFlow(BP, DRE, P, ACUM)!;
  const plug = (p: string) => fc.fcf.find((l) => l.nome.startsWith("Dividendos e ajustes"))?.valores[p] ?? 0;

  it("dezembro/2025 é a saída REAL, e bate com ΔLucros Acumulados no balanço", () => {
    expect(plug("31/12/2025")).toBeCloseTo(-5_639_748, 0);
    expect(plug("31/12/2025")).toBeCloseTo(5_870_000 - 11_510_000, -3);
  });

  it("fevereiro/2026 dá −107.151, não −1.263.579", () => {
    expect(plug("28/02/2026")).toBeCloseTo(-107_151, -1);
  });

  it("abril e maio/2026 ficam em ~zero (eram +6,35 mi e +2,91 mi)", () => {
    expect(Math.abs(plug("30/04/2026"))).toBeLessThan(5_000);
    expect(Math.abs(plug("31/05/2026"))).toBeLessThan(5_000);
  });

  it("a prova de fechamento bate em TODAS as colunas", () => {
    expect(fc.prova.filter((x) => x.fecha).length).toBe(fc.prova.length);
  });
});

describe("bancada Belagro · indicadores e alavancas", () => {
  const inds = calculateIndicators(BP, DRE, P, undefined, undefined, ACUM);
  const val = (n: string) => inds.find((i) => i.nome === n)?.valores[ULT];
  const row = (indicador: string, p50: number, higherIsBetter: boolean): PeerComparisonRow =>
    ({ indicador, valor: 0, p25: 0, p50, p75: 0, percentil: 50, level: "setor", segment: "Agropecuária", count: 6, higherIsBetter });
  const vc = calcularValorCanonico(inds as never, P,
    [row("Prazo Médio Contas a Receber", 33, false), row("Margem EBITDA", 0.0696, true)],
    DRE as never, { segmento: null, periodo: null }, ACUM, FECH)!;
  const alav = (t: string) => vc.alavancas.find((a) => a.titulo.startsWith(t))!;

  it("PMR de 130 dias — base de 150, a mesma que dispara a alavanca", () => {
    expect(val("Prazo Médio Contas a Receber")).toBe(130);
  });

  it("Dívida Líquida/EBITDA é N/M com EBITDA negativo, nunca um múltiplo", () => {
    expect(val("Dívida Líquida/EBITDA")).toBe("N/M");
  });

  it("alavanca de recebíveis RECONCILIA com o saldo do balanço", () => {
    const receitaDia = 328_504_142 / 150;
    const peloBalanco = 285_010_000 - 33 * receitaDia;
    expect(Math.abs(alav("Receber").valor - peloBalanco) / peloBalanco).toBeLessThan(0.003);
    expect(alav("Receber").valor).toBeCloseTo(212_432_678, -3); // e não 87,3 mi
  });

  it("A PROSA SEGUE O MOTOR: a leitura cita os números do próprio cálculo", () => {
    // O texto vinha da IA e discordava da manchete na MESMA caixa: título
    // "R$ 284,30 mi", prosa "da ordem de R$ 273 milhões". Agora quem calcula
    // escreve, e o teste trava o que o dono pediu: valor real, e clareza sobre
    // COMO obtê-lo.
    const l = vc.leitura;
    expect(l, "o motor precisa escrever a leitura").toBeTruthy();

    // 1. as DUAS naturezas ficam declaradas — somar liberação única com
    //    resultado anual sem dizer isso é o que fazia o total parecer dinheiro
    //    à vista.
    expect(l).toMatch(/UMA VEZ/);
    expect(l).toMatch(/A CADA ANO/);

    // 2. COMO CHEGAR LÁ: a maior alavanca é nomeada no texto.
    const maior = [...vc.alavancas].sort((a, b) => b.valor - a.valor)[0]!;
    expect(l).toContain(maior.titulo);

    // 3. e a referência é declarada como prática de mercado, não cenário ideal.
    expect(l).toMatch(/mediana das empresas compar/);
    expect(l).toMatch(/ordem de grandeza/);
  });

  it("a leitura NÃO inventa um total diferente do calculado", () => {
    // Régua dura: todo valor em R$ citado na prosa tem de existir entre os
    // números que o motor produziu (totais ou alavancas). Foi exatamente uma
    // cifra órfã — "R$ 273 milhões" — que apareceu no relatório do cliente.
    const conhecidos = new Set<number>([
      Math.round(vc.total / 1e6),
      Math.round(vc.caixaLiberavel / 1e6),
      Math.round(vc.margemRecuperavelAno / 1e6),
      ...vc.alavancas.map((a) => Math.round(a.valor / 1e6)),
    ]);
    const citados = [...vc.leitura.matchAll(/R\$ ([\d.,]+) (milh|mil)/g)].map((m) => {
      const n = Number(m[1]!.replace(/\./g, "").replace(",", "."));
      return m[2] === "milh" ? Math.round(n) : Math.round(n / 1000);
    });
    expect(citados.length, "a leitura precisa citar ao menos um valor").toBeGreaterThan(0);
    for (const c of citados) {
      const bate = [...conhecidos].some((k) => Math.abs(k - c) <= 1); // 1 mi de folga de arredondamento
      expect(bate, `a prosa cita R$ ${c} mi, que não sai de nenhum número do motor`).toBe(true);
    }
  });

  it("alavanca de margem usa o exercício FECHADO de 2025 — nem 2024, nem extrapolação", () => {
    expect(alav("Levar a margem").valor).toBeCloseTo(60_877_332, -3);
    expect(alav("Levar a margem").memoria).toContain("741,1");
  });
});

describe("bancada Belagro · proporcionalidade", () => {
  const pr = medirProporcionalidade(DRE as never, P, ACUM, FECH)!;
  const ritmo = (c: string) => pr.linhas.find((l) => l.conta === c)!.ritmo;

  it("compara contra 31/12/2025, não contra 2024", () => {
    expect(pr.periodoFechado).toBe("31/12/2025");
  });

  it("receita e custo perto do proporcional — a margem negativa não é atraso de safra", () => {
    expect(ritmo("Receita Líquida")).toBeCloseTo(1.06, 2);
    expect(ritmo("Custo Operacional")).toBeCloseTo(1.07, 2);
  });

  it("EBITDA e despesa financeira longe do proporcional — o motor NOMEIA, não julga", () => {
    expect(ritmo("EBITDA")).toBeCloseTo(-0.72, 2);
    expect(ritmo("Despesas Financeiras")).toBeCloseTo(2.04, 2);
  });

  // A leitura tem de entregar FATO, nunca sentença: nenhum limiar foi medido,
  // então nada de "fora da faixa" / "acima do aceitável".
  it("a leitura publica os dois fatos e recusa classificar", () => {
    expect(pr.leitura).toContain("41,7% do calendário");
    expect(pr.leitura).toContain("não classifica desvio como grande ou pequeno");
    expect(pr.leitura).not.toMatch(/FORA do ritmo|fora da faixa/i);
  });
});

// O bloco impresso pelo motor precisa ter TODOS os campos que o PDF desenha —
// se um sumir, o quadro sai vazio no relatório e ninguém percebe até o cliente.
describe("bancada Belagro · o que o PDF imprime", () => {
  const pr = medirProporcionalidade(DRE as never, P, ACUM, FECH)!;

  it("entrega os campos que o quadro do PDF consome", () => {
    expect(pr.meses).toBe(5);
    expect(pr.fracaoCalendario).toBeCloseTo(5 / 12, 4);
    expect(pr.periodoFechado.slice(-4)).toBe("2025");
    expect(pr.linhas.length).toBeGreaterThanOrEqual(4);
    for (const l of pr.linhas) {
      expect(typeof l.conta).toBe("string");
      expect(Number.isFinite(l.ytd)).toBe(true);
      expect(Number.isFinite(l.fechado)).toBe(true);
      expect(Number.isFinite(l.razao)).toBe(true);
      expect(Number.isFinite(l.ritmo)).toBe(true);
    }
  });

  it("a linha que o relatório precisava e não tinha: EBITDA contra o exercício fechado", () => {
    const e = pr.linhas.find((l) => l.conta === "EBITDA")!;
    expect(e.ytd).toBe(-4_120_000);
    expect(e.fechado).toBe(13_800_000);   // o 1,62x de cobertura vem daqui
    expect(e.razao).toBeCloseTo(-0.299, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PRIORIDADE PELO MOTOR — a ordem do plano priorizado, sobre a série real
// ═══════════════════════════════════════════════════════════════════════════
describe("bancada Belagro · a prioridade que o motor manda", () => {
  const inds = calculateIndicators(BP, DRE, P, undefined, undefined, ACUM).map((i) => ({
    nome: i.nome, valores: i.valores as Record<string, number | string | null>, tipoDado: i.tipoDado,
  }));
  const agendaDe = (covenants: Array<{ name: string; metric: string; operator: string; threshold: number }> = []) =>
    montarAgenda({
      indicadores: inds, periodos: P, periodo: ULT, bp: BP, dre: DRE,
      // SEM `diasDoPeriodo`: a agenda deriva pela mesma régua da produção. Passar
      // 150 à mão fazia a bancada provar um número que o código nunca calcula —
      // foi assim que a divergência das duas réguas passou despercebida.
      periodosYTD: ACUM, covenants,
    });

  it("a ordem NÃO é o alfabeto — e é isso que autoriza publicar rótulo", () => {
    // O desenho anterior, medido nesta mesma série, entregava C, E, E, I, L, L,
    // L, L: todos os critérios empatavam e sobrava o desempate por nome. Um plano
    // de credor ordenado de A a Z, com selo de método, é pior que assumir opinião.
    const a = agendaDe();
    const publicada = a.sinais.map((s) => s.nome);
    const alfabetica = [...publicada].sort((x, y) => x.localeCompare(y, "pt-BR"));
    expect(publicada.join(" | ")).not.toEqual(alfabetica.join(" | "));
    expect(a.discriminou).toBe(true);
  });

  it("os preços saem em reais do próprio balanço e são todos distintos", () => {
    const a = agendaDe();
    const precos = a.sinais.map((s) => s.precoBRL);
    expect(precos.every((x) => x !== null)).toBe(true);
    expect(new Set(precos.map((x) => Math.round(x!))).size).toBe(precos.length);
    // Reconciliam contra o balanço de 31/05/2026 vs 30/04/2026:
    const porNome = Object.fromEntries(a.sinais.map((s) => [s.nome, Math.round(s.precoBRL!)]));
    expect(porNome["Capital Terceiros s/ PL"]).toBe(7_316_436);  // CT 68,88 mi → 5,03 × PL 12,24 mi
    expect(porNome["Liquidez Imediata"]).toBe(5_068_514);        // caixa 14,80 mi → 4,65% de PC 427,29 mi
    expect(porNome["Endividamento de Curto Prazo"]).toBe(3_664_405);
    expect(porNome["Endividamento Geral"]).toBe(3_053_114);
  });

  it("o mais caro vem primeiro, dentro do mesmo nível de prova", () => {
    const a = agendaDe();
    for (let i = 1; i < a.sinais.length; i++) {
      expect(a.sinais[i - 1]!.precoBRL!, `${a.sinais[i - 1]!.nome} antes de ${a.sinais[i]!.nome}`)
        .toBeGreaterThan(a.sinais[i]!.precoBRL!);
    }
  });

  it("SEM PARES, nenhuma linha vira 'Alta' — duas fontes é que fazem Alta", () => {
    expect(agendaDe().sinais.filter((s) => s.rotulo === "Alta")).toEqual([]);
  });

  it("o covenant sobre EBITDA NÃO some no distress — ele lidera a agenda", () => {
    // Belagro em 31/05/2026 tem EBITDA de −R$ 4,12 mi, então Dívida
    // Líquida/EBITDA vale a STRING "N/M" e o card de decisão publicava "nenhum
    // covenant pôde ser verificado". Silêncio, sobre o contrato que o credor
    // escreveu, na empresa que ele mais cobra.
    const a = agendaDe([{ name: "Alavancagem", metric: "Dívida Líquida/EBITDA", operator: "<=", threshold: 3 }]);
    expect(a.sinais[0]!.nivelProva).toBe("contratual");
    expect(a.sinais[0]!.veredictoContrato).toBe("nao-atendivel");
    expect(a.sinais[0]!.rotulo).toBe("Alta");
    expect(a.sinais[0]!.memoria).toMatch(/não há geração operacional/);
  });

  it("declara que os indicadores de RESULTADO ficaram fora, e por quê", () => {
    // 31/05/2026 é acumulado de 5 meses e a série não tem 31/05/2025: margens,
    // prazos e cobertura não têm janela comparável. Omitir é certo; omitir CALADO
    // faz o leitor concluir que a margem não é problema.
    const texto = agendaDe().lacunas.join(" ");
    expect(texto).toMatch(/Margem EBITDA/);
    expect(texto).toMatch(/05\/2026 cobre parte do ano/);
    // E NUNCA a data de fechamento crua num texto que o cliente lê (regra do
    // dono, 14/08/2026: mm/aaaa ou o ano).
    expect(texto, "data de fechamento crua vazou para o documento").not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(texto).toMatch(/empresas comparáveis/);
    expect(texto).toMatch(/covenant cadastrado/);
  });

  it("nenhuma linha publica data de fechamento crua na base da prioridade", () => {
    for (const s of agendaDe().sinais) {
      expect(s.referenciaQueOrdena.rotulo, `${s.nome}: data crua na base`).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
      expect(s.referenciaQueOrdena.rotulo).toMatch(/04\/2026/);
    }
  });

  it("a agenda que vai para a IA é lista FECHADA e já ordenada", () => {
    const a = agendaDe();
    const txt = agendaParaPrompt(a);
    expect(txt).toMatch(/NÃO reordene/);
    expect(txt).toMatch(/DESCARTADO/);
    a.sinais.forEach((s) => expect(txt).toContain(`sinalId="${s.id}"`));
  });
});
