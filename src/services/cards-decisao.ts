/**
 * CARDS DE DECISÃO (onda 3) — cada card responde UMA pergunta que o dono faz.
 *
 * Tudo determinístico, do que o motor já tem. Onde o dado não existe, o card
 * DECLARA a premissa em vez de inventar: o que separa este produto de uma
 * planilha bonita é dizer de onde veio cada número — e admitir o que não sabe.
 *
 * Limites reais da base (medidos, não supostos):
 * - NÃO existe cronograma de vencimento de dívida no histórico contábil, só o
 *   SALDO de curto prazo. A distribuição segura usa esse saldo como proxy e diz
 *   isso na cara do leitor.
 * - NÃO existe DSCR calculável (serviço da dívida exige amortização, que a base
 *   não tem). O card de covenants avalia o que dá para provar e marca o resto
 *   como "não verificável com os documentos deste IBR".
 * - Sem marcação fixo × variável, o efeito de ±5% de receita no RESULTADO não é
 *   calculável — a mesa mostra o efeito na receita e diz o que falta.
 */
import type { BPLineItem, DRELineItem } from "../types/financial";
import type { FluxoCaixaIndireto } from "./cash-flow-indirect";
import { calcularContaRegressiva } from "./conta-regressiva";
import { diasDoPeriodo, diasYTD } from "./indicator-calculator";
import { rotuloPeriodoSrv } from "./bridge-variacao";

export type StatusCard = "ok" | "atencao" | "critico" | "informativo";

export interface LinhaCard {
  rotulo: string;
  valor: string;
  /** Número cru para o Excel (mesma unidade do texto). */
  bruto?: number | null;
  destaque?: boolean;
}

export interface CardDecisao {
  id: "distribuicao" | "covenants" | "reinvestimento" | "qualidade-lucro" | "sensibilidade";
  titulo: string;
  /** A pergunta que o card responde — o dono se reconhece nela. */
  pergunta: string;
  status: StatusCard;
  /** Manchete: a resposta em uma frase, com o número. */
  resposta: string;
  linhas: LinhaCard[];
  /** Premissas e limites — sempre visíveis, nunca em nota de rodapé escondida. */
  premissas: string[];
  /**
   * A premissa que o leitor EDITA na tela. Sai daqui estruturada (e não como mais
   * uma frase em `premissas`) para o controle não repetir o texto ao lado dele:
   * a tela desenha `antes [campo] depois`. Fora da tela — no PDF, no Excel — vira
   * frase normal, porque premissa escondida transforma número em chute.
   */
  edicao?: { chave: "mesesCaixaMinimo"; valor: number; antes: string; depois: string };
}

export interface PremissasDecisao {
  /** Meses de desembolso operacional que a empresa quer manter em caixa. */
  mesesCaixaMinimo?: number;
}

export const MESES_CAIXA_MINIMO_PADRAO = 3;

export interface DadosParaCards {
  bp?: BPLineItem[];
  dre?: DRELineItem[];
  periodos?: string[];
  fluxoCaixa?: FluxoCaixaIndireto | null;
  arvoresBalancete?: Array<{ periodo?: string }>;
  indicadores?: Array<{ nome: string; valores: Record<string, number | string | null> }>;
}

export interface CovenantParaCard {
  name: string;
  metric: string;
  operator: string;
  threshold: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const val = (linhas: Array<{ conta: string; valores: Record<string, number> }> | undefined, conta: string, p: string): number =>
  linhas?.find((l) => l.conta === conta)?.valores?.[p] ?? 0;

const brl = (v: number): string => {
  const abs = Math.abs(v);
  const s = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${s}R$ ${(abs / 1_000_000).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mi`;
  // Uma casa decimal abaixo de R$ 10 mil: sem ela, R$ 1.500 sai como "R$ 2 mil" —
  // arredondamento de 33% num card que responde "quanto posso tirar".
  if (abs >= 1_000) return `${s}R$ ${(abs / 1_000).toLocaleString("pt-BR", { maximumFractionDigits: abs < 10_000 ? 1 : 0 })} mil`;
  return `${s}R$ ${abs.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}`;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Indicador do motor no período (a fonte única — nunca recalcular aqui). */
const ind = (dados: DadosParaCards, nome: string, p: string): number | null =>
  num(dados.indicadores?.find((i) => i.nome === nome)?.valores?.[p]);

// ── Card 1: quanto dá para distribuir ─────────────────────────────────────────

function cardDistribuicao(
  dados: DadosParaCards,
  p: string,
  dias: number,
  premissas: PremissasDecisao,
): CardDecisao | null {
  const bp = dados.bp ?? [];
  const dre = dados.dre ?? [];
  const caixa = val(bp, "Caixa e Equivalentes de Caixa", p);
  const fco = dados.fluxoCaixa?.totais?.fco?.[p] ?? null;
  const regressiva = calcularContaRegressiva(bp, dre, p, fco, dias);
  if (!regressiva?.desembolsoDiario) return null;

  const meses = premissas.mesesCaixaMinimo ?? MESES_CAIXA_MINIMO_PADRAO;
  const caixaMinimo = regressiva.desembolsoDiario * meses * 30;
  const dividaCP = Math.abs(val(bp, "Empréstimos e Financiamentos - CP", p));
  const sobra = caixa - caixaMinimo - dividaCP;

  // Capacidade RECORRENTE: o que a operação gera depois de investir e pagar juros
  // (a hierarquia do caixa da onda 2 chama isso de FCLE→FCLA). Sem FC provado, só
  // o retrato do caixa vale — e o card diz isso.
  const capex = Math.abs(dados.fluxoCaixa?.fci?.find((l) => /capex/i.test(l.nome))?.valores?.[p] ?? 0);
  const fcRecorrente = fco !== null ? fco - capex : null;

  const status: StatusCard = sobra <= 0 ? "critico" : sobra < caixaMinimo * 0.5 ? "atencao" : "ok";
  // "1 meses" num relatório que vai ao cliente denuncia texto montado por máquina.
  const mesesTxt = `${meses.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${meses === 1 ? "mês" : "meses"}`;
  const resposta = sobra <= 0
    ? `Não há folga para distribuir: o caixa de hoje (${brl(caixa)}) não cobre a reserva mínima e os compromissos de curto prazo.`
    : `Distribuição segura hoje: até ${brl(sobra)} — o que sobra depois de manter ${mesesTxt} de reserva e cobrir a dívida de curto prazo.`;

  return {
    id: "distribuicao",
    titulo: "Quanto dá para distribuir",
    pergunta: "Quanto posso tirar de dividendos sem comprometer o caixa?",
    status,
    resposta,
    linhas: [
      { rotulo: "Caixa disponível", valor: brl(caixa), bruto: caixa },
      { rotulo: `Reserva mínima (${mesesTxt} de operação)`, valor: `-${brl(caixaMinimo)}`, bruto: -caixaMinimo },
      { rotulo: "Dívida de curto prazo", valor: dividaCP > 0 ? `-${brl(dividaCP)}` : brl(0), bruto: -dividaCP },
      { rotulo: "Distribuição segura", valor: brl(sobra), bruto: sobra, destaque: true },
      ...(fcRecorrente !== null
        ? [{ rotulo: "Geração recorrente no período (depois de investir)", valor: brl(fcRecorrente), bruto: fcRecorrente }]
        : []),
    ],
    edicao: {
      chave: "mesesCaixaMinimo",
      valor: meses,
      antes: "Reserva mínima =",
      depois: `${meses === 1 ? "mês" : "meses"} de desembolso operacional (${brl(regressiva.desembolsoDiario * 30)}/mês), premissa desta empresa.`,
    },
    premissas: [
      "Compromissos de curto prazo = SALDO de empréstimos e financiamentos CP: a base contábil não traz cronograma de vencimentos.",
      ...(fcRecorrente !== null ? ["Geração recorrente = caixa da operação menos o investimento do período (capex estimado do fluxo indireto)."] : []),
      "Não considera obrigações fiscais parceladas nem sazonalidade do recebimento — confira antes de deliberar.",
    ],
  };
}

// ── Card 2: covenants ─────────────────────────────────────────────────────────

/**
 * ALIASES de métrica antiga → nome do indicador.
 *
 * O campo `metric` do covenant é TEXTO LIVRE preenchido pelo analista, e a aba
 * Covenants resolve casando com o NOME do indicador (comparação minúscula, sem
 * espaços nas pontas). O comentário do schema fala em chaves camelCase; nada em
 * produção grava assim. Este mapa cobre só o caso legado — a resolução de
 * verdade é por nome, igual à aba, senão o card diria "nenhum covenant
 * verificável" ao lado de uma aba mostrando descumprimento no mesmo IBR.
 */
const ALIAS_METRICA: Record<string, string> = {
  netdebtebitda: "dívida líquida/ebitda",
  currentratio: "liquidez corrente",
  ebitdamargin: "margem ebitda",
  mincash: "caixa e equivalentes",
  interestcoverage: "índice de cobertura de juros",
};

/** Formata pela unidade do indicador (o motor carrega tipoDado junto). */
function fmtPorTipo(v: number, tipoDado: string | undefined): string {
  switch (tipoDado) {
    case "%": return `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
    case "Dias": return `${Math.round(v).toLocaleString("pt-BR")} dias`;
    case "R$": return brl(v);
    default: return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}

/**
 * Veredicto do covenant — MESMAS faixas da aba Covenants (breach / amber a 10%
 * do limite). Duas telas do mesmo produto não podem discordar sobre o mesmo
 * contrato: se a régua mudar lá, muda aqui.
 */
function avaliarCovenant(valor: number, operador: string, limite: number): "ok" | "amber" | "breach" {
  const safeT = limite === 0 ? 1 : Math.abs(limite);
  switch (operador) {
    case "<=": return valor > limite ? "breach" : valor > limite * 0.9 ? "amber" : "ok";
    case "<": return valor >= limite ? "breach" : valor >= limite * 0.9 ? "amber" : "ok";
    case ">=": return valor < limite ? "breach" : valor < limite * 1.1 ? "amber" : "ok";
    case ">": return valor <= limite ? "breach" : valor <= limite * 1.1 ? "amber" : "ok";
    case "==": {
      const d = Math.abs(valor - limite) / safeT;
      return d > 0.1 ? "breach" : d > 0.05 ? "amber" : "ok";
    }
    default: return "ok";
  }
}

function cardCovenants(dados: DadosParaCards, p: string, covenants: CovenantParaCard[]): CardDecisao | null {
  if (!covenants.length) return null;
  const linhas: LinhaCard[] = [];
  const naoVerificaveis: string[] = [];
  let quebrados = 0;
  let apertados = 0;

  for (const c of covenants) {
    const alvo = (c.metric ?? "").toLowerCase().trim();
    const chaveAlias = alvo.replace(/[^a-z]/g, "");
    const nomeBuscado = ALIAS_METRICA[chaveAlias] ?? alvo;
    const indicador = dados.indicadores?.find((i) => i.nome.toLowerCase().trim() === nomeBuscado);
    const atual = indicador ? num(indicador.valores?.[p]) : null;
    if (!indicador || atual === null) {
      naoVerificaveis.push(c.name);
      continue;
    }
    const tipoDado = (indicador as { tipoDado?: string }).tipoDado;
    const veredicto = avaliarCovenant(atual, c.operator, c.threshold);
    if (veredicto === "breach") quebrados++;
    else if (veredicto === "amber") apertados++;
    linhas.push({
      rotulo: `${c.name} (limite ${c.operator} ${fmtPorTipo(c.threshold, tipoDado)})`,
      valor: `${fmtPorTipo(atual, tipoDado)} — ${veredicto === "breach" ? "descumprido" : veredicto === "amber" ? "no limite" : "cumprido"}`,
      bruto: atual,
      destaque: veredicto === "breach",
    });
  }
  if (linhas.length === 0 && naoVerificaveis.length === 0) return null;

  const status: StatusCard = quebrados > 0 ? "critico" : apertados > 0 ? "atencao" : linhas.length ? "ok" : "informativo";
  const resposta = quebrados > 0
    ? `${quebrados} covenant(s) descumprido(s) no período — risco de vencimento antecipado.`
    : apertados > 0
      ? `Todos cumpridos, mas ${apertados} a menos de 10% do limite: um trimestre ruim encosta.`
      : linhas.length
        ? "Todos os covenants verificáveis estão cumpridos, com folga."
        : "Nenhum covenant pôde ser verificado com os documentos deste IBR.";

  return {
    id: "covenants",
    titulo: "Covenants",
    pergunta: "Estou perto de furar algum compromisso com o banco?",
    status,
    resposta,
    linhas,
    premissas: [
      "Verificação contra o indicador do período de referência — covenant é apurado na data pactuada, que pode diferir.",
      ...(naoVerificaveis.length
        ? [`Não verificável com esta base: ${naoVerificaveis.join(", ")}. A métrica precisa ter o nome exato de um indicador da aba Indicadores; índices de serviço da dívida (DSCR) exigem cronograma de amortização, que a contabilidade não traz.`]
        : []),
    ],
  };
}

// ── Card 3: reinvestimento (capex ÷ D&A) ──────────────────────────────────────

function cardReinvestimento(dados: DadosParaCards, rot: (p: string) => string): CardDecisao | null {
  const fc = dados.fluxoCaixa;
  if (!fc?.colunas?.length) return null;
  const linhaCapex = fc.fci?.find((l) => /capex/i.test(l.nome));
  if (!linhaCapex) return null;

  const linhas: LinhaCard[] = [];
  let abaixoDeUm = 0;
  let comparaveis = 0;
  for (const col of fc.colunas) {
    const capex = Math.abs(linhaCapex.valores?.[col] ?? 0);
    const da = Math.abs(val(dados.dre ?? [], "Depreciação e Amortização", col));
    if (da <= 0.005) continue;
    const razao = capex / da;
    comparaveis++;
    if (razao < 1) abaixoDeUm++;
    linhas.push({
      rotulo: rot(col),
      valor: `${razao.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}x  (investiu ${brl(capex)} · depreciou ${brl(da)})`,
      bruto: razao,
    });
  }
  if (comparaveis === 0) return null;

  const todosAbaixo = abaixoDeUm === comparaveis;
  const status: StatusCard = todosAbaixo && comparaveis >= 2 ? "atencao" : "ok";
  const resposta = todosAbaixo
    ? `A empresa investe menos do que consome os próprios ativos em ${comparaveis === 1 ? "o período" : `todos os ${comparaveis} períodos`} — a capacidade produtiva está encolhendo no papel.`
    : `Reinvestimento acima da depreciação em ${comparaveis - abaixoDeUm} de ${comparaveis} período(s) — a base de ativos se mantém.`;

  return {
    id: "reinvestimento",
    titulo: "Reinvestimento",
    pergunta: "Estou repondo o que gasto dos meus ativos?",
    status,
    resposta,
    linhas,
    premissas: [
      "Capex estimado pelo fluxo de caixa indireto (variação do imobilizado/intangível + depreciação do período).",
      "Abaixo de 1,0x por vários anos indica sucateamento — a menos que a operação esteja migrando para ativos de terceiros (aluguel, serviços).",
    ],
  };
}

// ── Card 4: qualidade do lucro ────────────────────────────────────────────────

function cardQualidadeLucro(dados: DadosParaCards, rot: (p: string) => string): CardDecisao | null {
  const fc = dados.fluxoCaixa;
  if (!fc?.colunas?.length) return null;
  const linhas: LinhaCard[] = [];
  let somaLucro = 0;
  let somaFco = 0;
  let comparaveis = 0;

  for (const col of fc.colunas) {
    const provaOk = fc.prova?.find((x) => x.periodo === col)?.fecha;
    if (!provaOk) continue;
    const lucro = val(dados.dre ?? [], "Lucro Líquido", col);
    const fco = fc.totais?.fco?.[col];
    if (typeof fco !== "number" || Math.abs(lucro) < 0.005) continue;
    comparaveis++;
    somaLucro += lucro;
    somaFco += fco;
    linhas.push({
      rotulo: rot(col),
      valor: `lucro ${brl(lucro)} · caixa da operação ${brl(fco)} (${(fco / lucro).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}x)`,
      bruto: lucro !== 0 ? fco / lucro : null,
    });
  }
  if (comparaveis === 0 || Math.abs(somaLucro) < 0.005) return null;

  // PREJUÍZO NÃO TEM TAXA DE CONVERSÃO. Dividir caixa por lucro negativo produz
  // número sem significado: prejuízo de 2 mi com FCO de +1 mi daria -0,5 e o card
  // gritaria "crítico" numa operação que gera caixa; com os dois negativos daria
  // razão POSITIVA e o card diria "o lucro vira caixa" para quem perdeu dinheiro.
  // Com prejuízo o que importa é outra pergunta: a operação sustenta o caixa?
  if (somaLucro < 0) {
    const sustenta = somaFco > 0;
    return {
      id: "qualidade-lucro",
      titulo: "Qualidade do lucro",
      pergunta: "O resultado da DRE virou dinheiro no banco?",
      status: sustenta ? "atencao" : "critico",
      resposta: sustenta
        ? `A empresa deu prejuízo de ${brl(Math.abs(somaLucro))} no acumulado, mas a operação ainda gerou ${brl(somaFco)} de caixa — o prejuízo está concentrado em despesas que não consomem caixa hoje.`
        : `Prejuízo de ${brl(Math.abs(somaLucro))} no acumulado e a operação também consumiu ${brl(Math.abs(somaFco))} de caixa: o resultado negativo está saindo do bolso.`,
      linhas,
      premissas: [
        "Com prejuízo não existe taxa de conversão de lucro em caixa — o card compara os dois valores em vez de dividir um pelo outro.",
        "Considera os períodos em que a prova do fluxo de caixa fecha.",
      ],
    };
  }

  const conversao = somaFco / somaLucro;
  const status: StatusCard = conversao < 0.5 ? "critico" : conversao < 0.8 ? "atencao" : "ok";
  const resposta = conversao < 0.8
    ? `De cada R$ 1,00 de lucro, apenas ${(conversao).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} viraram caixa no acumulado — o resultado está preso em giro ou em receita que não entrou.`
    : `O lucro vira caixa: ${(conversao).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} de caixa operacional para cada R$ 1,00 de lucro no acumulado.`;

  return {
    id: "qualidade-lucro",
    titulo: "Qualidade do lucro",
    pergunta: "O lucro que aparece na DRE virou dinheiro no banco?",
    status,
    resposta,
    linhas,
    premissas: [
      "Compara o lucro líquido com o caixa gerado pela operação, nos períodos em que a prova do fluxo de caixa fecha.",
      "Abaixo de 0,8x de forma persistente: o resultado depende de prazo (cliente que não pagou) ou de receita não-caixa.",
    ],
  };
}

// ── Card 5: mesa de sensibilidade ─────────────────────────────────────────────

function cardSensibilidade(dados: DadosParaCards, p: string, dias: number): CardDecisao | null {
  const receita = val(dados.dre ?? [], "Receita Líquida", p);
  const custo = Math.abs(val(dados.dre ?? [], "Custo Operacional", p));
  if (receita <= 0) return null;

  const receitaDia = receita / dias;
  const custoDia = custo > 0 ? custo / dias : null;
  // ANUALIZA quando o período é parcial (balancete YTD de 5 meses, por exemplo):
  // dizer "por ano" sobre a receita de 5 meses subestima o efeito em 2,4x. O
  // período cheio passa direto (fator 1), e a premissa declara o que foi feito.
  const parcial = dias < 360;
  const fatorAno = 365 / dias;
  const umPontoMargem = receita * 0.01 * fatorAno;
  const cincoPorCentoReceita = receita * 0.05;

  const linhas: LinhaCard[] = [
    { rotulo: "1 dia a menos para receber do cliente", valor: `${brl(receitaDia)} de caixa liberado`, bruto: receitaDia, destaque: true },
    ...(custoDia !== null
      ? [{ rotulo: "1 dia a mais para pagar fornecedor", valor: `${brl(custoDia)} de caixa liberado`, bruto: custoDia },
         { rotulo: "1 dia a menos de estoque", valor: `${brl(custoDia)} de caixa liberado`, bruto: custoDia }]
      : []),
    { rotulo: "1 ponto percentual de margem", valor: `${brl(umPontoMargem)} por ano no resultado`, bruto: umPontoMargem },
    { rotulo: "5% de receita", valor: `${brl(cincoPorCentoReceita)} de faturamento no período`, bruto: cincoPorCentoReceita },
  ];

  return {
    id: "sensibilidade",
    titulo: "O que cada movimento vale",
    pergunta: "Onde colocar energia primeiro — prazo, margem ou volume?",
    status: "informativo",
    resposta: `Cada dia a menos no prazo de recebimento libera ${brl(receitaDia)}; cada ponto de margem vale ${brl(umPontoMargem)} por ano.`,
    linhas,
    premissas: [
      `Base: receita e custo do período de referência, divididos por ${dias} dias.`,
      ...(parcial
        ? [`O período de referência cobre ${dias} dias, não um ano: o efeito da margem foi anualizado (×${fatorAno.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}) e supõe o mesmo ritmo nos meses restantes.`]
        : []),
      "O efeito de 5% de receita no RESULTADO depende da estrutura de custos (fixo × variável), que a base contábil não marca — por isso aqui só o efeito no faturamento.",
    ],
  };
}

// ── Montagem ──────────────────────────────────────────────────────────────────

export function montarCardsDecisao(
  dados: DadosParaCards,
  opts?: { covenants?: CovenantParaCard[]; premissas?: PremissasDecisao; periodo?: string },
): { periodo: string; periodoRotulo: string; cards: CardDecisao[] } | null {
  const periodos = [...(dados.periodos ?? [])];
  if (periodos.length === 0) return null;
  const ytd = new Set((dados.arvoresBalancete ?? []).map((a) => a?.periodo).filter(Boolean) as string[]);
  const ordenar = (a: string, b: string): number => {
    const key = (p: string): number => {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(p);
      if (m) return Number(`${m[3]}${m[2]}${m[1]}`);
      const y = /^(\d{4})$/.exec(p);
      return y ? Number(`${y[1]}0000`) : 0;
    };
    return key(a) - key(b);
  };
  const p = opts?.periodo && periodos.includes(opts.periodo) ? opts.periodo : [...periodos].sort(ordenar).pop()!;
  // Dias-base correto por período: balancete YTD usa mês×30 — assumir 365 num
  // acumulado de 5 meses infla prazos e desembolso em ~2,4x.
  const dias = ytd.has(p) ? diasYTD(p) : diasDoPeriodo(p, periodos.filter((x) => !ytd.has(x) || x === p));
  const premissas = opts?.premissas ?? {};
  // RÓTULO, não chave: "2024" e "05/2026" — nunca "31/12/2024" na cara do leitor
  // (regra do dono). Período de balancete é acumulado do exercício, então mesmo
  // fechando em dezembro ele se lê como mês.
  const rot = (x: string): string => rotuloPeriodoSrv(x, ytd.has(x));

  const cards = [
    cardDistribuicao(dados, p, dias, premissas),
    cardCovenants(dados, p, opts?.covenants ?? []),
    cardReinvestimento(dados, rot),
    cardQualidadeLucro(dados, rot),
    cardSensibilidade(dados, p, dias),
  ].filter((c): c is CardDecisao => c !== null);

  // O RÓTULO vai junto: a tela sabe que 31/12 é fim de exercício, mas não sabe
  // que ESTE período veio de um balancete acumulado. Sem isto o cabeçalho dizia
  // "2026" e as linhas do mesmo card diziam "12/2026".
  return cards.length ? { periodo: p, periodoRotulo: rot(p), cards } : null;
}
