import { describe, expect, it } from "vitest";
import type { BPLineItem, DRELineItem } from "../types/financial";
import { calculateIndicators, diasBaseDe } from "./indicator-calculator";
import type { PeerComparisonRow } from "./peer-benchmark";
import {
  MIN_PARES_PARA_ORDENAR, PRECO_DO_SINAL, agendaParaPrompt, montarAgenda, precoDeVoltar, referenciaPropria,
} from "./prioridade-motor";

/**
 * BANCADA DA PRIORIDADE PELO MOTOR.
 *
 * Cada teste aqui nasceu de uma MEDIÇÃO que derrubou um desenho anterior, não de
 * uma hipótese. Os dois piores estão em "a ordem não pode nascer do alfabeto" e
 * em "empresa saudável não publica Alta": os dois desenhos que testamos antes
 * passavam em qualquer teste de implementação e publicavam, na empresa real,
 * um plano de credor ordenado de A a Z com selo de método.
 */

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURE COMPLETA — todas as contas presentes, para a prova de ida e volta
// ═══════════════════════════════════════════════════════════════════════════

const Q = ["2024", "2025"];
const vv = (a: number, b: number) => ({ "2024": a, "2025": b });
const bpL = (conta: string, classificacao: string, nivel: number, a: number, b: number): BPLineItem =>
  ({ conta, classificacao, nivel, editado: false, valores: vv(a, b) } as BPLineItem);
const dreL = (conta: string, a: number, b: number): DRELineItem =>
  ({ conta, subtotal: false, editado: false, valores: vv(a, b) });

function fixtura() {
  const bp: BPLineItem[] = [
    bpL("Ativo Total", "AT", 0, 60_000_000, 64_000_000),
    bpL("Ativo Circulante", "AC", 1, 30_000_000, 25_100_000),
    bpL("Caixa e Equivalentes de Caixa", "AF", 2, 1_850_000, 780_000),
    bpL("Contas a Receber - CP", "AO", 2, 16_000_000, 14_320_000),
    bpL("Estoques - CP", "AO", 2, 9_000_000, 8_000_000),
    bpL("Outros Ativos Circulantes", "AO", 2, 3_150_000, 2_000_000),
    bpL("Ativo Não Circulante", "ANC", 1, 30_000_000, 38_900_000),
    bpL("Realizável a Longo Prazo", "ARLP", 2, 4_000_000, 4_000_000),
    bpL("Imobilizado", "AI", 2, 26_000_000, 34_900_000),
    bpL("Passivo Total", "PT", 0, 60_000_000, 64_000_000),
    bpL("Passivo Circulante", "PC", 1, 24_000_000, 27_300_000),
    bpL("Fornecedores - CP", "PO", 2, 9_000_000, 9_600_000),
    bpL("Empréstimos e Financiamentos - CP", "PF", 2, 11_000_000, 13_700_000),
    bpL("Outras Obrigações - CP", "PO", 2, 4_000_000, 4_000_000),
    bpL("Passivo Não Circulante", "PNC", 1, 21_600_000, 24_800_000),
    bpL("Empréstimos e Financiamentos - LP", "PF", 2, 21_600_000, 24_800_000),
    bpL("Patrimônio Líquido", "PL", 1, 14_400_000, 11_900_000),
  ];
  const dre: DRELineItem[] = [
    dreL("Receita Líquida", 64_200_000, 61_300_000),
    dreL("Custo Operacional", -47_000_000, -46_600_000),
    dreL("EBITDA", 6_100_000, 3_900_000),
    dreL("Depreciação e Amortização", -1_400_000, -1_500_000),
    dreL("Despesas Financeiras", -3_200_000, -4_050_000),
    dreL("Lucro Líquido", 1_200_000, -1_300_000),
  ];
  return { bp, dre };
}

/** Indicadores como o produto os entrega (nome, valores por período, tipoDado). */
function indicadoresDe(bp: BPLineItem[], dre: DRELineItem[], periodos: string[]) {
  return calculateIndicators(bp, dre, periodos).map((i) => ({
    nome: i.nome, valores: i.valores as Record<string, number | string | null>, tipoDado: i.tipoDado,
  }));
}

const valorDe = (bp: BPLineItem[], dre: DRELineItem[], periodos: string[], nome: string, p: string): number | null => {
  const v = calculateIndicators(bp, dre, periodos).find((i) => i.nome === nome)?.valores[p];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

// ═══════════════════════════════════════════════════════════════════════════
// 1) A PROVA QUE IMPORTA: aplicar o preço à conta e recalcular o indicador
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Como o movimento de R$ entra no balanço, por indicador. O que se prova é que
 * DEPOIS de mover essa conta o MOTOR DE INDICADORES (não esta bancada) devolve
 * exatamente o alvo. Se as duas contas fossem escritas pela mesma cabeça e
 * conferidas entre si, o teste passaria verde no dobro dos dois lados — aqui o
 * conferente é `calculateIndicators`, que já existia.
 */
const APLICAR: Record<string, (bp: BPLineItem[], dre: DRELineItem[], p: string, x: number) => void> = {
  "Liquidez Imediata": (bp, _d, p, x) => somaBP(bp, "Caixa e Equivalentes de Caixa", p, x),
  "Liquidez Seca": (bp, _d, p, x) => somaBP(bp, "Ativo Circulante", p, x),
  "Liquidez Corrente": (bp, _d, p, x) => somaBP(bp, "Ativo Circulante", p, x),
  "Liquidez Geral": (bp, _d, p, x) => somaBP(bp, "Ativo Circulante", p, x),
  // Aporte de capital: PL e Passivo Total sobem juntos (é a identidade do balanço).
  "Endividamento Geral": (bp, _d, p, x) => { somaBP(bp, "Patrimônio Líquido", p, x); somaBP(bp, "Passivo Total", p, x); },
  // Alongamento: sai do circulante, entra no não circulante. Passivo Total parado.
  "Endividamento de Curto Prazo": (bp, _d, p, x) => { somaBP(bp, "Passivo Circulante", p, x); somaBP(bp, "Passivo Não Circulante", p, -x); },
  "Capital Terceiros s/ PL": (bp, _d, p, x) => somaBP(bp, "Empréstimos e Financiamentos - CP", p, x),
  "Imobilização do Patrimônio Líquido": (bp, _d, p, x) => somaBP(bp, "Imobilizado", p, x),
  "Dívida Líquida/EBITDA": (bp, _d, p, x) => somaBP(bp, "Empréstimos e Financiamentos - CP", p, x),
  "Índice de Cobertura de Juros": (_b, dre, p, x) => somaDRE(dre, "EBITDA", p, x),
  // A DRE guarda a despesa NEGATIVA e o indicador usa o módulo: crescer o módulo
  // em x é somar −x na linha.
  "Despesa Financeira / Rec. Líquida": (_b, dre, p, x) => somaDRE(dre, "Despesas Financeiras", p, -x),
  "Margem Bruta": (_b, dre, p, x) => somaDRE(dre, "Custo Operacional", p, x),
  "Margem EBITDA": (_b, dre, p, x) => somaDRE(dre, "EBITDA", p, x),
  "Margem Líquida": (_b, dre, p, x) => somaDRE(dre, "Lucro Líquido", p, x),
  "Prazo Médio Contas a Receber": (bp, _d, p, x) => somaBP(bp, "Contas a Receber - CP", p, x),
  "Prazo Médio Estoque": (bp, _d, p, x) => somaBP(bp, "Estoques - CP", p, x),
  "Prazo Médio Fornecedores": (bp, _d, p, x) => somaBP(bp, "Fornecedores - CP", p, x),
};

function somaBP(bp: BPLineItem[], conta: string, p: string, x: number): void {
  const l = bp.find((b) => b.conta === conta);
  if (!l) throw new Error(`conta ausente na fixture: ${conta}`);
  l.valores[p] = (l.valores[p] ?? 0) + x;
}
function somaDRE(dre: DRELineItem[], conta: string, p: string, x: number): void {
  const l = dre.find((d) => d.conta === conta);
  if (!l) throw new Error(`linha ausente na fixture: ${conta}`);
  l.valores[p] = (l.valores[p] ?? 0) + x;
}

describe("o preço reconcilia contra o balanço", () => {
  it("mover a alavanca pelo preço leva o indicador EXATAMENTE ao alvo, em todos os sinais", () => {
    const P = "2025";
    let conferidos = 0;
    for (const nome of Object.keys(PRECO_DO_SINAL)) {
      const { bp, dre } = fixtura();
      const atual = valorDe(bp, dre, Q, nome, P);
      if (atual === null) continue; // indicador não calculável nesta fixture
      // Alvo arbitrário mas do lado bom: 20% melhor que o valor de hoje.
      const def = PRECO_DO_SINAL[nome]!;
      const alvo = def.maiorEhPior ? atual * 0.8 : atual * 1.2;
      const preco = precoDeVoltar(nome, bp, dre, P, alvo, 365);
      expect(preco, `preço de ${nome}`).not.toBeNull();
      expect(preco!.alavanca, `${nome} sem conta nomeada`).toBeTruthy();
      APLICAR[nome]!(bp, dre, P, preco!.brl);
      const depois = valorDe(bp, dre, Q, nome, P);
      // O preço é EXATO em reais; os PRAZOS o motor publica arredondados ao dia
      // inteiro (indicator-calculator.ts:251-255). A tolerância é a do publicado,
      // não a do cálculo — exigir 1e-6 num número que sai inteiro reprovaria uma
      // conta certa.
      const tipo = calculateIndicators(bp, dre, Q).find((i) => i.nome === nome)?.tipoDado;
      const folga = tipo === "Dias" ? 0.5 : Math.max(Math.abs(alvo) * 1e-9, 1e-9);
      expect(Math.abs(depois! - alvo), `${nome}: depois de mover ${preco!.alavanca}`).toBeLessThanOrEqual(folga);
      conferidos++;
    }
    // GUARDA DA GUARDA: laço que não roda passa verde sem provar nada.
    expect(conferidos, "nenhum sinal conferido — o teste não testou nada").toBe(Object.keys(PRECO_DO_SINAL).length);
  });

  it("cada sinal tem uma regra de aplicação na bancada (nada entra sem prova)", () => {
    for (const nome of Object.keys(PRECO_DO_SINAL)) {
      expect(APLICAR[nome], `${nome} entrou no motor sem prova de reconciliação`).toBeTypeOf("function");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2) A ORDEM NÃO PODE NASCER DO ALFABETO
// ═══════════════════════════════════════════════════════════════════════════

describe("dois exercícios fechados, sem pares e sem covenant", () => {
  const { bp, dre } = fixtura();
  const inds = indicadoresDe(bp, dre, Q);
  const agenda = montarAgenda({ indicadores: inds, periodos: Q, periodo: "2025", bp, dre, diasDoPeriodo: 365 });

  it("mede sinais em vez de emudecer", () => {
    expect(agenda.sinais.length, "nenhum sinal medido numa empresa que piorou em tudo").toBeGreaterThan(3);
  });

  it("a ordem publicada NÃO é a ordem alfabética", () => {
    // MEDIDO no desenho anterior: C, E, E, I, L, L, L, L — o plano do credor saía
    // de A a Z porque todos os critérios empatavam e sobrava o desempate por nome.
    const publicada = agenda.sinais.map((s) => s.nome);
    const alfabetica = [...publicada].sort((a, b) => a.localeCompare(b, "pt-BR"));
    expect(publicada.join(" | ")).not.toEqual(alfabetica.join(" | "));
  });

  it("os preços do topo são DISTINTOS — é o que autoriza publicar rótulo", () => {
    expect(agenda.discriminou).toBe(true);
    const precos = agenda.sinais.map((s) => s.precoBRL);
    expect(precos[0]).not.toBeNull();
    expect(precos[0]).not.toEqual(precos[1]);
  });

  it("toda linha carrega a conta que se move e a memória de cálculo", () => {
    for (const s of agenda.sinais) {
      expect(s.alavanca, `${s.nome} sem alavanca nomeada`).toBeTruthy();
      expect(s.memoria.length, `${s.nome} sem memória`).toBeGreaterThan(40);
      expect(s.referenciaQueOrdena.rotulo, `${s.nome} sem referência declarada`).toBeTruthy();
    }
  });

  it("EXERCÍCIO FECHADO não é chamado de 'parcial' na lacuna", () => {
    // O texto afirmava sempre "acumulado parcial". Num IBR de um único exercício
    // fechado — o caso mais comum de todos — o relatório dizia ao credor que 2025
    // era um ano incompleto. A causa agora é medida, não presumida.
    const { bp, dre } = fixtura();
    const a1 = montarAgenda({ indicadores: indicadoresDe(bp, dre, ["2025"]), periodos: ["2025"], periodo: "2025", bp, dre });
    const txt = a1.lacunas.join(" ");
    expect(txt).not.toMatch(/parte do ano/);
    expect(txt).toMatch(/não há na série um período anterior de mesma duração/);
    expect(txt).toMatch(/2025/);
  });

  it("declara as lacunas em vez de escondê-las", () => {
    expect(agenda.lacunas.join(" ")).toMatch(/covenant/i);
    expect(agenda.lacunas.join(" ")).toMatch(/comparáveis/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2b) A BASE DE DIAS É A DO MOTOR — o ramo que a bancada não exercitava
// ═══════════════════════════════════════════════════════════════════════════

describe("série sub-anual FORA de periodosYTD", () => {
  // O defeito: a régua de dias era recopiada como `ytd.has(p) ? diasYTD(p) : 365`,
  // que só coincide com o motor quando a série é anual. Num IBR com um único
  // fechamento em 31/05/2026 que NÃO está registrado como balancete, o motor
  // publica o prazo sobre 150 dias e o preço saía sobre 365 — o MESMO relatório
  // trazia R$ 6,5 mi de um lado e R$ 17,4 mi do outro para o mesmo movimento.
  // As duas bancadas anteriores passavam `diasDoPeriodo` À MÃO e eram cegas a isto.
  const par = (indicador: string, p50: number): PeerComparisonRow => ({
    indicador, valor: 0, p25: p50, p50, p75: p50, percentil: 5,
    level: "subsetor", segment: "Agropecuária", count: 7, higherIsBetter: false,
  });
  // A mediana dos pares é definida A PARTIR do valor da empresa (metade dele), e
  // não um número fixo: com base sub-anual o prazo publicado encolhe junto com a
  // janela, e um alvo cravado deixaria a empresa "melhor que os pares" — o sinal
  // sumiria e o teste passaria verde sem exercitar nada.
  const metadeDe = (v: number) => Math.round(v / 2);

  function comSerie(periodos: string[], periodoAlvo: string) {
    const { bp, dre } = fixtura();
    // Reetiqueta a fixture para os períodos pedidos (2025 vira o período-alvo).
    for (const l of [...bp, ...dre]) {
      l.valores = Object.fromEntries(periodos.map((p, i) => [p, l.valores[i === periodos.length - 1 ? "2025" : "2024"]!]));
    }
    // MONTA COMO A PRODUÇÃO MONTA: a base de dias vem da régua do motor, não de
    // um número escrito à mão no teste.
    const dias = diasBaseDe(periodoAlvo, periodos, []);
    const inds = calculateIndicators(bp, dre, periodos).map((i) => ({
      nome: i.nome, valores: i.valores as Record<string, number | string | null>, tipoDado: i.tipoDado,
    }));
    return { bp, dre, periodos, dias, inds };
  }

  for (const [rotulo, periodos, alvo, diasEsperado] of [
    ["fechamento único de maio", ["31/05/2026"], "31/05/2026", 150],
    ["série trimestral", ["31/03/2026", "30/06/2026"], "30/06/2026", 90],
  ] as const) {
    it(`${rotulo}: o preço do prazo reconcilia contra o motor (base ${diasEsperado} dias)`, () => {
      const { bp, dre, dias, inds } = comSerie([...periodos], alvo);
      expect(dias, "a régua de dias precisa ser a do motor").toBe(diasEsperado);

      const pmrAtual = inds.find((i) => i.nome === "Prazo Médio Contas a Receber")!.valores[alvo] as number;
      const mediana = metadeDe(pmrAtual);
      const agenda = montarAgenda({
        indicadores: inds, periodos: [...periodos], periodo: alvo, bp, dre,
        periodosYTD: [], diasDoPeriodo: dias,
        pares: [par("Prazo Médio Contas a Receber", mediana)], paresSegmento: "Agropecuária", paresPeriodo: "1T26",
      });
      const s = agenda.sinais.find((x) => x.nome === "Prazo Médio Contas a Receber");
      expect(s, `PMR de ${pmrAtual} dias está acima da mediana de ${mediana} e tem de entrar`).toBeDefined();

      // IDA E VOLTA: aplicar o preço publicado tem de devolver a mediana EXATA.
      const preco = precoDeVoltar("Prazo Médio Contas a Receber", bp, dre, alvo, mediana, dias)!;
      expect(Math.round(s!.precoBRL!), "o preço da agenda é o mesmo do cálculo direto").toBe(Math.round(Math.abs(preco.brl)));
      somaBP(bp, "Contas a Receber - CP", alvo, preco.brl);
      const depois = calculateIndicators(bp, dre, [...periodos]).find((i) => i.nome === "Prazo Médio Contas a Receber")!.valores[alvo];
      expect(Math.abs((depois as number) - mediana), "o preço publicado não leva ao alvo").toBeLessThanOrEqual(0.5);
    });
  }

  it("com 365 cravado (o defeito antigo) a ida e volta NÃO fecha — a bancada precisa disso", () => {
    const { bp, dre, periodos, dias } = comSerie(["31/05/2026"], "31/05/2026");
    expect(dias).not.toBe(365);
    const publicado = calculateIndicators(bp, dre, periodos).find((i) => i.nome === "Prazo Médio Contas a Receber")!.valores["31/05/2026"] as number;
    const mediana = Math.round(publicado / 2);
    const errado = precoDeVoltar("Prazo Médio Contas a Receber", bp, dre, "31/05/2026", mediana, 365)!;
    somaBP(bp, "Contas a Receber - CP", "31/05/2026", errado.brl);
    const depois = calculateIndicators(bp, dre, periodos).find((i) => i.nome === "Prazo Médio Contas a Receber")!.valores["31/05/2026"];
    expect(Math.abs((depois as number) - mediana), "com a base errada a ida e volta tem de FALHAR").toBeGreaterThan(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3) EMPRESA SAUDÁVEL NÃO PUBLICA "ALTA"
// ═══════════════════════════════════════════════════════════════════════════

describe("empresa que melhorou em tudo", () => {
  function saudavel() {
    const { bp, dre } = fixtura();
    // Inverte a série: 2025 é o ano BOM (e 2024 o ruim).
    for (const l of bp) { const a = l.valores["2024"]!, b = l.valores["2025"]!; l.valores["2024"] = b; l.valores["2025"] = a; }
    for (const l of dre) { const a = l.valores["2024"]!, b = l.valores["2025"]!; l.valores["2024"] = b; l.valores["2025"] = a; }
    return { bp, dre };
  }

  it("nenhuma linha 'Alta' fabricada por posição na lista", () => {
    const { bp, dre } = saudavel();
    const agenda = montarAgenda({ indicadores: indicadoresDe(bp, dre, Q), periodos: Q, periodo: "2025", bp, dre });
    // O desenho por POSIÇÃO garantia um badge vermelho em toda empresa, moribunda
    // ou próspera — o inverso de "cada empresa é diferente da outra".
    expect(agenda.sinais.filter((s) => s.rotulo === "Alta").map((s) => s.nome)).toEqual([]);
  });

  it("sem sinal medido, a agenda diz isso ao prompt em vez de mandar inventar", () => {
    const { bp, dre } = saudavel();
    const agenda = montarAgenda({ indicadores: indicadoresDe(bp, dre, Q), periodos: Q, periodo: "2025", bp, dre });
    if (agenda.sinais.length === 0) {
      expect(agendaParaPrompt(agenda)).toMatch(/NÃO invente prioridade/);
      expect(agenda.discriminou).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4) O COVENANT NÃO PODE SUMIR EXATAMENTE NO DISTRESS
// ═══════════════════════════════════════════════════════════════════════════

describe("covenant sobre métrica que depende de EBITDA", () => {
  function comEbitdaNegativo() {
    const { bp, dre } = fixtura();
    somaDRE(dre, "EBITDA", "2025", -8_000_000); // EBITDA vai a −4,1 mi
    return { bp, dre };
  }

  it("EBITDA ≤ 0 vira 'não atendível no período', nunca silêncio", () => {
    // MEDIDO: com EBITDA ≤ 0 o motor grava a STRING "N/M" em Dívida
    // Líquida/EBITDA, o card jogava o covenant em "não verificáveis" e a página
    // publicava "nenhum covenant pôde ser verificado" — na empresa que o credor
    // mais cobra, e sobre o covenant que ele mesmo escreveu.
    const { bp, dre } = comEbitdaNegativo();
    const inds = indicadoresDe(bp, dre, Q);
    const bruto = inds.find((i) => i.nome === "Dívida Líquida/EBITDA")!.valores["2025"];
    expect(typeof bruto, "a fixture precisa reproduzir o N/M").toBe("string");

    const agenda = montarAgenda({
      indicadores: inds, periodos: Q, periodo: "2025", bp, dre,
      covenants: [{ name: "Alavancagem", metric: "Dívida Líquida/EBITDA", operator: "<=", threshold: 3 }],
    });
    const contratual = agenda.sinais.find((s) => s.nivelProva === "contratual");
    expect(contratual, "o covenant sumiu da agenda").toBeDefined();
    expect(contratual!.veredictoContrato).toBe("nao-atendivel");
    expect(contratual!.rotulo).toBe("Alta");
    expect(contratual!.memoria).toMatch(/não é mensurável/);
  });

  it("o contrato tem PRECEDÊNCIA: vem antes de qualquer sinal de trajetória", () => {
    const { bp, dre } = comEbitdaNegativo();
    const agenda = montarAgenda({
      indicadores: indicadoresDe(bp, dre, Q), periodos: Q, periodo: "2025", bp, dre,
      covenants: [{ name: "Alavancagem", metric: "Dívida Líquida/EBITDA", operator: "<=", threshold: 3 }],
    });
    expect(agenda.sinais[0]!.nivelProva).toBe("contratual");
    expect(agenda.discriminou, "com contrato no topo, a ordem é do credor").toBe(true);
    expect(agenda.eixo).toMatch(/contratual/);
  });

  it("covenant sobre indicador de TEXTO não vira quebra com causa inventada", () => {
    // O ramo "não atendível" aceitava QUALQUER string. "Situação de Liquidez
    // (Fleuriet)" devolve "Sólida"/"Muito Ruim"/"Alto Risco" — que são MEDIDAS.
    // Medido, o relatório do credor imprimia: "o indicador não é mensurável
    // (Muito Ruim), porque não há geração operacional para servir de base", em
    // primeiro lugar na agenda, com uma causa que não tem relação com o Fleuriet.
    const { bp, dre } = fixtura();
    const inds = indicadoresDe(bp, dre, Q);
    const fleuriet = inds.find((i) => i.nome === "Situação de Liquidez (Fleuriet)")!;
    expect(typeof fleuriet.valores["2025"], "a fixture precisa produzir texto").toBe("string");
    const agenda = montarAgenda({
      indicadores: inds, periodos: Q, periodo: "2025", bp, dre,
      covenants: [{ name: "Estrutura de liquidez", metric: "Situação de Liquidez (Fleuriet)", operator: ">=", threshold: 1 }],
    });
    expect(agenda.sinais.some((s) => s.nivelProva === "contratual")).toBe(false);
    expect(agenda.lacunas.join(" ")).toMatch(/uma classificação, não um número/);
    expect(agenda.lacunas.join(" ")).not.toMatch(/geração operacional/);
  });

  it("dois covenants com o MESMO nome recebem ids distintos", () => {
    // `name` é texto livre do analista: "Alavancagem" do Banco A (≤ 3,0) e do
    // Banco B (≤ 2,5). Com id colidido a IA não consegue amarrar uma ação a cada
    // um e o parse descarta o segundo — perdendo a camada de MAIOR precedência.
    const { bp, dre } = fixtura();
    somaDRE(dre, "EBITDA", "2025", -8_000_000);
    const agenda = montarAgenda({
      indicadores: indicadoresDe(bp, dre, Q), periodos: Q, periodo: "2025", bp, dre,
      covenants: [
        { name: "Alavancagem", metric: "Dívida Líquida/EBITDA", operator: "<=", threshold: 3 },
        { name: "Alavancagem", metric: "Dívida Líquida/EBITDA", operator: "<=", threshold: 2.5 },
      ],
    });
    const ids = agenda.sinais.filter((s) => s.nivelProva === "contratual").map((s) => s.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size, "ids colidiram — um dos contratos perde o vínculo").toBe(2);
    // E o texto da agenda enviada à IA precisa distinguir os dois.
    const txt = agendaParaPrompt(agenda);
    ids.forEach((id) => expect(txt).toContain(`sinalId="${id}"`));
  });

  it("nome que JÁ TERMINA EM NÚMERO não colide com o sufixo de desempate", () => {
    // Regressão medida na primeira versão do desempate: "Alavancagem 2" gera a
    // raiz covenant:alavancagem-2, que era exatamente o sufixo que o
    // "Alavancagem" seguinte recebia — um par que funcionava antes quebrou.
    const { bp, dre } = fixtura();
    somaDRE(dre, "EBITDA", "2025", -8_000_000);
    const nomes = ["Alavancagem 2", "Alavancagem", "DSCR 2", "DSCR", "DSCR"];
    const agenda = montarAgenda({
      indicadores: indicadoresDe(bp, dre, Q), periodos: Q, periodo: "2025", bp, dre,
      covenants: nomes.map((name) => ({ name, metric: "Dívida Líquida/EBITDA", operator: "<=", threshold: 3 })),
    });
    const ids = agenda.sinais.filter((s) => s.nivelProva === "contratual").map((s) => s.id);
    expect(ids).toHaveLength(nomes.length);
    expect(new Set(ids).size, `ids repetidos: ${ids.join(", ")}`).toBe(nomes.length);
  });

  it("covenant CUMPRIDO não entra na agenda (não se prioriza o que está em ordem)", () => {
    const { bp, dre } = fixtura();
    const agenda = montarAgenda({
      indicadores: indicadoresDe(bp, dre, Q), periodos: Q, periodo: "2025", bp, dre,
      covenants: [{ name: "Alavancagem", metric: "Dívida Líquida/EBITDA", operator: "<=", threshold: 99 }],
    });
    expect(agenda.sinais.some((s) => s.nivelProva === "contratual")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5) JANELA COMPARÁVEL — fluxo não se compara com exercício fechado
// ═══════════════════════════════════════════════════════════════════════════

describe("referência da própria série, segregada por natureza", () => {
  const serie = ["2024", "31/12/2025", "31/05/2026"];
  const ytd = ["31/12/2025", "31/05/2026"];

  it("SALDO compara com a coluna anterior, qualquer que seja", () => {
    expect(referenciaPropria("saldo", "31/05/2026", serie, ytd)).toBe("31/12/2025");
  });

  it("FLUXO num acumulado de 5 meses NÃO aceita um exercício fechado como referência", () => {
    // /365 num período de 150 dias erra a base em 2,43× — é a mesma armadilha que
    // já inventou retirada de sócio neste produto.
    expect(referenciaPropria("fluxo", "31/05/2026", serie, ytd)).toBeNull();
  });

  it("FLUXO aceita o MESMO MÊS de um ano anterior", () => {
    const s = ["31/05/2025", "31/12/2025", "31/05/2026"];
    expect(referenciaPropria("fluxo", "31/05/2026", s, ["31/05/2025", "31/12/2025", "31/05/2026"])).toBe("31/05/2025");
  });

  it("no PRIMEIRO período da série não há referência própria", () => {
    expect(referenciaPropria("saldo", "2024", serie, ytd)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6) DIREÇÃO, DUPLICATA E A TRAVA DE DISCRIMINAÇÃO
// ═══════════════════════════════════════════════════════════════════════════

describe("armadilhas que um score somado erraria", () => {
  it("prazo de FORNECEDORES maior é MELHOR — direção invertida", () => {
    expect(PRECO_DO_SINAL["Prazo Médio Fornecedores"]!.maiorEhPior).toBe(false);
    expect(PRECO_DO_SINAL["Prazo Médio Contas a Receber"]!.maiorEhPior).toBe(true);
    expect(PRECO_DO_SINAL["Prazo Médio Estoque"]!.maiorEhPior).toBe(true);
  });

  it("'Margem Líquida' aparece duas vezes no template e NÃO pesa em dobro", () => {
    const { bp, dre } = fixtura();
    const inds = indicadoresDe(bp, dre, Q);
    expect(inds.filter((i) => i.nome === "Margem Líquida").length, "a duplicata precisa existir na entrada").toBeGreaterThan(1);
    const agenda = montarAgenda({ indicadores: inds, periodos: Q, periodo: "2025", bp, dre });
    expect(agenda.sinais.filter((s) => s.nome === "Margem Líquida").length).toBeLessThanOrEqual(1);
  });

  it("pares abaixo do mínimo NÃO ordenam, e a lacuna é declarada", () => {
    const { bp, dre } = fixtura();
    const par = (indicador: string, p50: number, count: number): PeerComparisonRow => ({
      indicador, valor: 0, p25: p50, p50, p75: p50, percentil: 50,
      level: "subsetor", segment: "Teste", count, higherIsBetter: true,
    });
    const agenda = montarAgenda({
      indicadores: indicadoresDe(bp, dre, Q), periodos: Q, periodo: "2025", bp, dre,
      pares: [par("Liquidez Corrente", 5, MIN_PARES_PARA_ORDENAR - 1)], paresSegmento: "Teste",
    });
    expect(agenda.sinais.every((s) => s.referencias.every((r) => r.tipo !== "pares"))).toBe(true);
    expect(agenda.lacunas.join(" ")).toMatch(/menos de 3 empresas comparáveis/);
  });

  it("pares suficientes viram DUAS FONTES quando concordam com a trajetória", () => {
    const { bp, dre } = fixtura();
    const lc = valorDe(bp, dre, Q, "Liquidez Corrente", "2025")!;
    const par: PeerComparisonRow = {
      indicador: "Liquidez Corrente", valor: lc, p25: lc, p50: lc + 1, p75: lc + 2, percentil: 10,
      level: "subsetor", segment: "Teste", count: MIN_PARES_PARA_ORDENAR, higherIsBetter: true,
    };
    const agenda = montarAgenda({
      indicadores: indicadoresDe(bp, dre, Q), periodos: Q, periodo: "2025", bp, dre,
      pares: [par], paresSegmento: "Teste", paresPeriodo: "1T26",
    });
    const s = agenda.sinais.find((x) => x.nome === "Liquidez Corrente");
    expect(s, "Liquidez Corrente caiu abaixo dos pares E do próprio nível").toBeDefined();
    expect(s!.nivelProva).toBe("duas-fontes");
    expect(s!.rotulo).toBe("Alta");
    expect(s!.referenciaQueOrdena.tipo, "pares têm precedência sobre a própria série").toBe("pares");
    expect(s!.referenciaQueOrdena.rotulo).toMatch(/3 pares de Teste @ 1T26/);
  });

  it("a agenda para o prompt é lista FECHADA, com id estável e proibição de default", () => {
    const { bp, dre } = fixtura();
    const agenda = montarAgenda({ indicadores: indicadoresDe(bp, dre, Q), periodos: Q, periodo: "2025", bp, dre });
    const txt = agendaParaPrompt(agenda);
    expect(txt).toMatch(/NÃO reordene/);
    expect(txt).toMatch(/DESCARTADO/);
    for (const s of agenda.sinais) expect(txt).toContain(`sinalId="${s.id}"`);
    // ID estável: sem acento, sem espaço — é chave, não rótulo.
    for (const s of agenda.sinais) expect(s.id).toMatch(/^[a-z]+:[a-z0-9-]+$/);
  });

  it("NADA INTERNO no que sai do motor: a memória fala com o dono, não com a cozinha", () => {
    const { bp, dre } = fixtura();
    const agenda = montarAgenda({ indicadores: indicadoresDe(bp, dre, Q), periodos: Q, periodo: "2025", bp, dre });
    const prosa = agenda.sinais.map((s) => s.memoria).join(" ");
    for (const palavra of ["seletor", "motor determinístico", "fold", "endpoint", "prompt", "camada 1", "PRECO_DO_SINAL"]) {
      expect(prosa.toLowerCase(), `vocabulário interno vazou: ${palavra}`).not.toContain(palavra.toLowerCase());
    }
  });
});
