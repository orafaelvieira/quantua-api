/**
 * PONTES DE VARIAÇÃO (onda 2) — "de onde estava → onde está", com prova.
 *
 * Quatro decomposições 100% determinísticas sobre o que o motor já persiste
 * (dre/bp canônicos, FC indireto, série de períodos). A IA NÃO participa —
 * quando participar (onda 3), receberá estas pontes prontas e apenas narrará.
 *
 * Regras da casa aplicadas:
 * - "Verde só com prova": toda ponte carrega prova de fechamento (Σ efeitos =
 *   Δ observado, tolerância R$ 1). Ponte que não fecha é persistida com
 *   fecha=false e as telas NÃO a renderizam como número executivo.
 * - Par de períodos = último vs imediatamente anterior, e SÓ quando o par é
 *   comparável: lacuna da série (avaliarSerie persistida) bloqueia tudo com
 *   `bloqueio` explícito — variação sobre buraco não é tendência.
 * - Convenção de sinais da DRE canônica: receitas positivas, deduções/custos/
 *   despesas/IR NEGATIVOS; subtotais fecham por SOMA (financial-templates.ts).
 * - Ciclo de vida = o mesmo do fluxoCaixa: calculado no /process e recalculado
 *   a cada /refold — nunca fica dessincronizado dos números que descreve.
 *
 * A ponte de resultado é POR CONTA CONTÁBIL (as linhas canônicas da DRE) —
 * nunca por driver físico (preço/volume não existem no realizado); os rótulos
 * dizem exatamente isso.
 */
import type { BPLineItem, DRELineItem } from "../types/financial";
import type { FluxoCaixaIndireto } from "./cash-flow-indirect";
import { diasDoPeriodo, diasYTD } from "./indicator-calculator";
import { derivarDREMensal } from "./balancete-conversao";

// ── Tipos persistidos em dadosEstruturados.pontes ──────────────────────────────

export interface BarraPonte {
  nome: string;
  /** Contribuição ASSINADA para o Δ do agregado (soma das barras = Δ, provado). */
  valor: number;
}

export interface ProvaPonte {
  somaEfeitos: number;
  deltaObservado: number;
  fecha: boolean; // |soma − delta| ≤ TOLERANCIA
}

export interface PonteResultado {
  agregado: "EBITDA" | "Lucro Líquido";
  inicial: number;
  final: number;
  barras: BarraPonte[];
  prova: ProvaPonte;
}

export interface DegrauCaixa {
  nome: string;
  /** "nivel" = patamar (EBITDA, FCO, Δ Caixa); "delta" = degrau que soma/subtrai. */
  tipo: "nivel" | "delta";
  valor: number;
  /** Abertura DENTRO de outro degrau — não entra na soma da cadeia. */
  informativo?: boolean;
}

export interface HierarquiaCaixa {
  /** Coluna do FC (período final da variação). */
  periodo: string;
  /** Coluna anterior quando o intervalo foi desacumulado; null quando a coluna vale como esta'. */
  intervaloDe?: string | null;
  degraus: DegrauCaixa[];
  /** Conciliação com o FCO do método indireto (mesma identidade, arrumação nova). */
  provaFco: ProvaPonte;
  /** Conciliação do fim da cadeia com o ΔCaixa observado no BP. */
  provaDeltaCaixa: ProvaPonte;
  /** FCO/EBITDA por coluna provada do FC — "de cada R$ 1 de EBITDA, quanto virou caixa". */
  taxaConversao: Array<{ periodo: string; ebitda: number; fco: number; taxa: number | null }>;
  premissas: {
    /** |IR e CSLL| ÷ Resultado Antes do IR (DRE, competência) — contexto, não re-taxação. */
    aliquotaEfetiva: number | null;
    /** Mesma razão com a equivalência patrimonial FORA da base — a carga que
     *  sobra quando se tira do denominador o que não é tributável. */
    aliquotaExEquiv?: number | null;
    irPeriodo?: number;
    lairPeriodo?: number;
    equivPatrimonial?: number;
    /** Alíquota nominal do regime (0,34 no Lucro Real); null quando não há
     *  nominal comparável ao LAIR (ex.: Presumido tem base própria). */
    nominalRegime?: number | null;
    regimeCadastro: string | null;
    nota: string;
  };
}

export interface EfeitoNcg {
  nome: string;
  valor: number;
}

export interface PonteNcg {
  ncgInicial: number;
  ncgFinal: number;
  efeitos: EfeitoNcg[];
  prova: ProvaPonte;
  /** Prazos SEM arredondar, para o rótulo ("PMR 56 → 60 dias"). */
  prazos: { pmr: [number | null, number | null]; pme: [number | null, number | null]; pmf: [number | null, number | null] };
  /** false quando o bucket residual domina (>50% do ΔNCG) — a soma fecha por
   *  construção, mas a decomposição não EXPLICA o movimento. */
  conclusiva: boolean;
  nota: string | null;
}

export interface DupontRoe {
  roeInicial: number;
  roeFinal: number;
  /** Efeitos em pontos de ROE (razão, não %): margem, giro, alavancagem — decomposição sequencial exata. */
  efeitos: { margem: number; giro: number; alavancagem: number; residuo: number };
  componentes: {
    margem: [number, number];
    giro: [number, number];
    alavancagem: [number, number];
  };
  /** Meses cobertos pelo NUMERADOR (lucro/receita). Menor que 12 = ROE e giro do
   *  período, não do exercício — quem exibe precisa dizer isso. */
  janelaMeses?: number;
  /** false quando o resíduo passa de 20% do Δ ou o PL não sustenta a leitura. */
  conclusiva: boolean;
  nota: string | null;
}

export interface PontesVariacao {
  calculadoEm: string;
  /** Par decomposto (anterior → atual). null + bloqueio quando não comparável.
   *  `rotuloDe`/`rotuloAte` viajam JUNTO do par: o cabeçalho do relatório dizia
   *  "2024 → 12/2025" enquanto o aviso, na MESMA frase, dizia "12/2024 → 12/2025".
   *  Dois rotuladores para um par só sempre divergem — agora há um. Opcionais
   *  porque análises gravadas antes deste campo não os têm (a tela cai no seu). */
  par: { de: string; ate: string; rotuloDe?: string; rotuloAte?: string; mesesJanela?: number } | null;
  /** Régua do par exibido — o que está sendo comparado com o quê. */
  regua: ReguaComparacao | null;
  /** Todos os pares que o analista pode escolher (o seletor da tela). */
  disponiveis: ParComparacao[];
  bloqueio: string | null;
  /** Preenchido quando o par NÃO é o último da série (ex.: o último é YTD parcial
   *  e não há janela igual para comparar) — a tela precisa declarar o recuo. */
  avisoPar: string | null;
  ponteEbitda: PonteResultado | null;
  ponteLucro: PonteResultado | null;
  hierarquiaCaixa: HierarquiaCaixa | null;
  ponteNcg: PonteNcg | null;
  dupont: DupontRoe | null;
}

const TOLERANCIA = 1; // R$ — mesma régua do FC indireto

// ── Período: ordenação e comparabilidade (espelha variacao-periodos do front) ──

const ordPeriodo = (p: string): number => {
  const m = p.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return Number(`${m[3]}${m[2]}${m[1]}`);
  const y = p.match(/\d{4}/);
  return y ? Number(`${y[0]}0000`) : 0;
};

const dataDoPeriodo = (p: string): Date | null => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(p.trim());
  if (m) {
    const d = new Date(Date.UTC(+m[3]!, +m[2]! - 1, +m[1]!));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const y = /^(\d{4})$/.exec(p.trim());
  return y ? new Date(Date.UTC(+y[1]!, 11, 31)) : null;
};

const ehFimDeAno = (d: Date): boolean => d.getUTCMonth() === 11 && d.getUTCDate() === 31;

/** Heurística de rótulos para IBR antigo sem `serie` — idêntica à do front. */
function parContiguoPorRotulo(anterior: Date, atual: Date): boolean {
  const meses = (atual.getUTCFullYear() - anterior.getUTCFullYear()) * 12 + (atual.getUTCMonth() - anterior.getUTCMonth());
  if (ehFimDeAno(anterior) && ehFimDeAno(atual)) return meses <= 12;
  if (ehFimDeAno(anterior)) return atual.getUTCFullYear() === anterior.getUTCFullYear() + 1;
  if (ehFimDeAno(atual)) return atual.getUTCFullYear() === anterior.getUTCFullYear();
  if (atual.getUTCFullYear() === anterior.getUTCFullYear()) return true; // YTDs do mesmo exercício
  return meses <= 1;
}

export interface SerieLacunasSrv {
  ok: boolean;
  lacunas: Array<{ de: string; ate: string; rotulo: string }>;
}

/**
 * O par atravessa LACUNA DE DADOS (período que não existe na base)?
 *
 * Diferente de `parComparavelSrv`: aquela valida pares CONSECUTIVOS (e rejeita
 * distância, por desenho); esta responde só "há buraco de dados entre os dois?",
 * que é o que importa quando o analista escolhe 2024 contra 2022 de propósito.
 * Sem a série declarada (IBR legado) não há como afirmar buraco — não bloqueia.
 */
export function atravessaLacuna(
  anterior: string,
  atual: string,
  serie?: SerieLacunasSrv | null
): { lacuna: boolean; motivo?: string } {
  if (!serie?.lacunas?.length) return { lacuna: false };
  const a = dataDoPeriodo(anterior);
  const b = dataDoPeriodo(atual);
  if (!a || !b) return { lacuna: false };
  const [ini, fim] = a <= b ? [a, b] : [b, a];
  for (const l of serie.lacunas) {
    const de = dataDoPeriodo(l.de);
    if (de && de > ini && de < fim) return { lacuna: true, motivo: `lacuna na série (${l.rotulo})` };
  }
  return { lacuna: false };
}

/** O par (anterior → atual) é comparável? Lacuna do motor > heurística de rótulo. */
export function parComparavelSrv(
  anterior: string,
  atual: string,
  serie?: SerieLacunasSrv | null
): { ok: boolean; motivo?: string } {
  const a = dataDoPeriodo(anterior);
  const b = dataDoPeriodo(atual);
  if (!a || !b) return { ok: true };
  const [ini, fim] = a <= b ? [a, b] : [b, a];
  if (serie?.lacunas?.length) {
    for (const l of serie.lacunas) {
      const de = dataDoPeriodo(l.de);
      if (de && de > ini && de < fim) return { ok: false, motivo: `lacuna na série (${l.rotulo})` };
    }
    return { ok: true };
  }
  if (serie) return { ok: true };
  return parContiguoPorRotulo(ini, fim) ? { ok: true } : { ok: false, motivo: "períodos não consecutivos" };
}

// ── Helpers de leitura (mesma semântica do indicator-calculator) ───────────────

const dreVal = (dre: DRELineItem[], conta: string, p: string): number =>
  dre.find((d) => d.conta === conta)?.valores[p] ?? 0;
const bpVal = (bp: BPLineItem[], conta: string, p: string): number =>
  bp.find((l) => l.conta === conta)?.valores[p] ?? 0;
const bpByClass = (bp: BPLineItem[], cls: string, p: string): number =>
  bp.filter((l) => l.classificacao === cls).reduce((s, l) => s + (l.valores[p] ?? 0), 0);

const prova = (somaEfeitos: number, deltaObservado: number): ProvaPonte => ({
  somaEfeitos,
  deltaObservado,
  fecha: Math.abs(somaEfeitos - deltaObservado) <= TOLERANCIA,
});

const round2 = (v: number): number => Math.round(v * 100) / 100;

// ── Ponte de resultado por linha da DRE ────────────────────────────────────────

/**
 * Barras = Δ de cada linha NÃO-subtotal entre `deIdx` (exclusivo) e `ateIdx`
 * (exclusivo) na ORDEM do array — cobre modelos por empresa com linhas extras.
 * A prova compara Σ barras com o Δ do SUBTOTAL ARMAZENADO (o que as telas
 * mostram): se o documento só trouxe o subtotal (componentes zerados, caso
 * `resolve` preserva o extraído), a ponte NÃO fecha e não vira número.
 */
function ponteResultadoDe(
  dre: DRELineItem[],
  agregado: "EBITDA" | "Lucro Líquido",
  de: string,
  ate: string
): PonteResultado | null {
  const idxAgregado = dre.findIndex((d) => d.conta === agregado && d.subtotal);
  if (idxAgregado < 0) return null;

  const inicial = dreVal(dre, agregado, de);
  const final = dreVal(dre, agregado, ate);
  const delta = final - inicial;

  const barras: BarraPonte[] = [];
  if (agregado === "EBITDA") {
    // Tudo que vem ANTES do EBITDA no modelo (Receita Bruta → Outras Desp. Op.).
    for (const l of dre.slice(0, idxAgregado)) {
      if (l.subtotal) continue;
      const v = (l.valores[ate] ?? 0) - (l.valores[de] ?? 0);
      if (Math.abs(v) > 0.005) barras.push({ nome: `Δ ${l.conta}`, valor: round2(v) });
    }
  } else {
    // Lucro Líquido = EBITDA + linhas abaixo dele: a 1ª barra é o Δ EBITDA
    // (decomposto na própria ponte de EBITDA), depois cada linha não-subtotal.
    const idxEbitda = dre.findIndex((d) => d.conta === "EBITDA" && d.subtotal);
    if (idxEbitda < 0 || idxEbitda > idxAgregado) return null;
    const dEbitda = dreVal(dre, "EBITDA", ate) - dreVal(dre, "EBITDA", de);
    if (Math.abs(dEbitda) > 0.005) barras.push({ nome: "Δ EBITDA", valor: round2(dEbitda) });
    for (const l of dre.slice(idxEbitda + 1, idxAgregado)) {
      if (l.subtotal) continue;
      const v = (l.valores[ate] ?? 0) - (l.valores[de] ?? 0);
      if (Math.abs(v) > 0.005) barras.push({ nome: `Δ ${l.conta}`, valor: round2(v) });
    }
  }

  const soma = barras.reduce((s, b) => s + b.valor, 0);
  return {
    agregado,
    inicial: round2(inicial),
    final: round2(final),
    barras,
    prova: prova(round2(soma), round2(delta)),
  };
}

// ── Hierarquia do caixa (dentro do período): EBITDA → FCO → FCLE → Δ Caixa ────

/**
 * Rearranjo PROVADO do FC indireto: FCO(indireto) = EBITDA + IR + Resultado
 * Financeiro + Resultado Não Operacional + Δ capital de giro (identidade da
 * DRE canônica — D&A e Equivalência cancelam entre lucro e estornos). Cada
 * degrau é uma linha da DRE ou um total do FC já provado; nada é inventado.
 */
function hierarquiaCaixaDe(
  dre: DRELineItem[],
  fc: FluxoCaixaIndireto,
  col: string,
  regimeCadastro: string | null,
  ytd: Set<string>,
  /** true quando a regua e' "mes": `dreDaRegua` JA' substituiu os valores desta
   *  coluna pelo mes isolado, e desacumular de novo subtrairia duas vezes. */
  dreJaMensal: boolean
): HierarquiaCaixa | null {
  // JANELA IGUAL A' DAS PONTES (dono, 20/08/2026: "colocar no mesmo periodo das
  // variacoes de EBITDA e Lucro Liquido"). Cada COLUNA do FC e' o movimento
  // entre ela e a anterior; num balancete mensal, a coluna 31/12 vale UM MES.
  // Lida contra a DRE da coluna — que e' o ACUMULADO DO ANO — isso publicava
  // EBITDA de doze meses ao lado de FCO de um mes, e o degrau do giro (derivado
  // por diferenca) virava o PLUG que engolia os outros onze. A prova fechava
  // assim mesmo: ela testa a cascata da DRE, nunca a janela.
  // Agora somam-se TODAS as colunas do exercicio de `col`, o que reconstroi
  // exatamente o mesmo intervalo que a DRE acumulada ja' cobre — e a DRE volta a
  // ser lida CRUA, sem subtracao nenhuma.
  const iCol = fc.colunas.indexOf(col);
  if (iCol < 0) return null;
  const anoCol = mesAno(col)?.ano ?? null;
  const agregaExercicio = !dreJaMensal && ytd.has(col) && anoCol !== null;
  const colunasJanela = agregaExercicio
    ? fc.colunas.filter((c, i) => i <= iCol && mesAno(c)?.ano === anoCol)
    : [col];
  if (colunasJanela.length === 0) return null;

  // VERDE SO' COM PROVA: se QUALQUER coluna somada nao fecha, a soma nao vale.
  const provas = colunasJanela.map((c) => fc.prova?.find((x) => x.periodo === c));
  if (provas.some((pv) => !pv?.fecha)) return null;

  const somaCol = (m: Record<string, number> | undefined): number | null => {
    if (!m) return null;
    let t = 0;
    for (const c of colunasJanela) {
      const v = m[c];
      if (typeof v !== "number") return null;
      t += v;
    }
    return t;
  };
  const fco = somaCol(fc.totais?.fco);
  const fci = somaCol(fc.totais?.fci);
  const fcf = somaCol(fc.totais?.fcf);
  if (fco === null || fci === null || fcf === null) return null;

  // A coluna ANTERIOR a' primeira somada e' o marco inicial do intervalo.
  const iPrimeira = fc.colunas.indexOf(colunasJanela[0]!);
  const intervaloDe = iPrimeira > 0 ? fc.colunas[iPrimeira - 1]! : null;

  // A DRE ja' cobre a janela: acumulada no ano quando ha' agregacao, mes isolado
  // quando a regua e' "mes", exercicio cheio quando a coluna e' anual.
  const dreJanela = (conta: string): number => dreVal(dre, conta, col);

  const ebitda = dreJanela("EBITDA");
  const ir = dreJanela("IR e CSLL"); // negativo por convenção
  const rf = dreJanela("Resultado Financeiro");
  const rno = dreJanela("Resultado Não Operacional");
  // DEGRAU DO GIRO = TODA a variação operacional do FCO, não só o sub-bloco
  // `capitalGiro`: o FC joga em `fco` também os Δ de tributos a recuperar,
  // obrigações trabalhistas/tributárias etc. Deriva-se da identidade do próprio
  // FC (FCO = LL − D&A − EqPat + Δgiro), então a prova abaixo verifica a
  // CASCATA DA DRE (LL = EBITDA + D&A + EqPat + RF + RNO + IR) — e falha de
  // verdade quando um subtotal extraído não bate com seus componentes.
  const lucro = dreJanela("Lucro Líquido");
  const da = dreJanela("Depreciação e Amortização");
  const eqP = dreJanela("Equivalência Patrimonial");
  const giro = fco - lucro + da + eqP;
  // AS TRES LINHAS, NAO A SOMA (dono, 20/08/2026). O leitor via "-R$ 627 mil"
  // de capital de giro sem saber se foi cliente atrasando, estoque parado ou
  // fornecedor apertando — que sao decisoes DIFERENTES.
  const linhasGiro = (fc.capitalGiro?.linhas ?? [])
    .map((l) => ({ nome: l.nome, valor: round2(colunasJanela.reduce((t, c) => t + (l.valores?.[c] ?? 0), 0)) }))
    .filter((l) => Math.abs(l.valor) > 0.005);
  const giroCapitalDeGiro = somaCol(fc.capitalGiro?.total); // sub-bloco, quando existe
  const fcoRecomposto = ebitda + ir + rf + rno + giro;

  const fcle = fco + fci;
  const deltaCaixa = provas.reduce((t, pv) => t + (pv!.deltaObservado ?? 0), 0);

  const degraus: DegrauCaixa[] = [
    { nome: "EBITDA (DRE)", tipo: "nivel", valor: round2(ebitda) },
    { nome: "IR e CSLL (DRE, competência)", tipo: "delta", valor: round2(ir) },
    ...(Math.abs(rf) > 0.005 ? [{ nome: "Resultado financeiro (juros líquidos)", tipo: "delta" as const, valor: round2(rf) }] : []),
    ...(Math.abs(rno) > 0.005 ? [{ nome: "Resultado não operacional", tipo: "delta" as const, valor: round2(rno) }] : []),
    { nome: "Δ capital de giro e demais itens operacionais", tipo: "delta", valor: round2(giro) },
    ...linhasGiro.map((l) => ({ nome: l.nome, tipo: "delta" as const, valor: l.valor, informativo: true })),
    ...(giroCapitalDeGiro !== null && Math.abs(giroCapitalDeGiro) > 0.005 && linhasGiro.length > 1
      ? [{ nome: "subtotal do capital de giro", tipo: "delta" as const, valor: round2(giroCapitalDeGiro), informativo: true }]
      : []),
    { nome: "Caixa das operações (FCO)", tipo: "nivel", valor: round2(fco) },
    { nome: "Investimentos (capex e participações — FCI)", tipo: "delta", valor: round2(fci) },
    { nome: "Caixa livre após juros e IR (FCLE)", tipo: "nivel", valor: round2(fcle) },
    { nome: "Captações, amortizações e dividendos (FCF)", tipo: "delta", valor: round2(fcf) },
    { nome: "Variação do caixa no período", tipo: "nivel", valor: round2(deltaCaixa) },
  ];

  // CARGA TRIBUTÁRIA CONTÁBIL = despesa de IR ÷ LAIR (a ETR do CPC 32/IAS 12).
  // Dois cuidados que faltavam:
  // 1. SINAL. `ir` é negativo por convenção (despesa). Com `Math.abs`, um CRÉDITO
  //    de imposto (reversão, IR diferido ativo — `ir > 0`) virava alíquota
  //    POSITIVA: a empresa GANHOU imposto e o relatório afirmava que pagou 15%.
  // 2. BASE. A equivalência patrimonial entra no LAIR pela cascata da DRE
  //    (account-mapper: EBIT = EBITDA + D&A + EqPat) e NÃO é base tributável
  //    (DL 1.598/77 art. 23, red. Lei 12.973/2014 — RIR/2018 art. 426). Dentro do denominador ela infla ou desinfla a
  //    razão sem que nada de tributário tenha mudado — e é o que separa os 43%
  //    publicados dos 34% nominais do Lucro Real. A norma exige a RECONCILIAÇÃO
  //    com o nominal ao lado; publicar só a razão é dizer meia verdade.
  const lair = dreJanela("Resultado Antes do IR e CSLL");
  const aliquotaEfetiva = lair > 0 && ir < 0 ? round2((-ir / lair) * 100) / 100 : null;
  const baseExEquiv = lair - eqP;
  const aliquotaExEquiv = baseExEquiv > 0 && ir < 0 ? round2((-ir / baseExEquiv) * 100) / 100 : null;
  // Nominal só do que dá para afirmar: Lucro Real é 25% IRPJ + 9% CSLL. Presumido
  // tem base própria (não é sobre o LAIR), então não há nominal comparável aqui.
  const nominalRegime = /real/i.test(regimeCadastro ?? "") ? 0.34 : null;

  // CONVERSAO DE CAIXA SO' DO PERIODO DA ANALISE (dono, 20/08/2026). A serie
  // inteira saia' na linha — sete colunas, quatro sem valor e uma com "-1871%" —
  // e cada coluna tinha uma janela diferente da outra (a de novembro cobre onze
  // meses, a de dezembro cobre um): numeros lado a lado que nao se comparam.
  // Agora e' um numero so', da MESMA janela da hierarquia acima dele.
  const taxaConversao = [{
    periodo: col,
    ebitda: round2(ebitda),
    fco: round2(fco),
    taxa: ebitda > 0 ? round2((fco / ebitda) * 100) / 100 : null,
  }];

  return {
    periodo: col,
    /** Marco inicial do intervalo somado (null quando nao ha' coluna anterior).
     *  O relatorio declara o intervalo em vez de deixar subentendido. */
    intervaloDe,
    degraus,
    provaFco: prova(round2(fcoRecomposto), round2(fco)),
    provaDeltaCaixa: prova(round2(fco + fci + fcf), round2(deltaCaixa)),
    taxaConversao,
    premissas: {
      aliquotaEfetiva,
      aliquotaExEquiv,
      irPeriodo: round2(ir),
      lairPeriodo: round2(lair),
      equivPatrimonial: round2(eqP),
      nominalRegime,
      regimeCadastro,
      // A fórmula saiu daqui: ela já aparece ao lado do próprio número na tela e
      // no PDF. Sobrou o que é premissa de verdade.
      nota: "IR pela DRE (competência, não o efetivamente pago); capex estimado por ΔImobilizado/Intangível + D&A.",
    },
  };
}

// ── Ponte da NCG em dias: efeito prazo × efeito crescimento ────────────────────

/**
 * Para cada componente com prazo (CR, Estoques, Fornecedores):
 *   saldo = prazoExato × baseDiária  (prazo SEM arredondar: saldo·dias ÷ base)
 *   Δ saldo = Δprazo × baseDiária(final)  [efeito PRAZO]
 *           + prazo(inicial) × ΔbaseDiária [efeito CRESCIMENTO]  — exato, sem resíduo.
 * Os demais itens do giro (outros AO/PO) entram como barra própria; a prova
 * fecha contra o ΔNCG observado (AO − |PO|) por construção + tolerância.
 */
function ponteNcgDe(
  bp: BPLineItem[],
  dre: DRELineItem[],
  de: string,
  ate: string,
  diasPorPeriodo: Record<string, number>
): PonteNcg | null {
  const ncg = (p: string): number => bpByClass(bp, "AO", p) - Math.abs(bpByClass(bp, "PO", p));
  const ncg0 = ncg(de);
  const ncg1 = ncg(ate);
  const delta = ncg1 - ncg0;

  const rl0 = dreVal(dre, "Receita Líquida", de);
  const rl1 = dreVal(dre, "Receita Líquida", ate);
  const custo0 = Math.abs(dreVal(dre, "Custo Operacional", de));
  const custo1 = Math.abs(dreVal(dre, "Custo Operacional", ate));
  const d0 = diasPorPeriodo[de] ?? 365;
  const d1 = diasPorPeriodo[ate] ?? 365;
  if (rl0 <= 0 || rl1 <= 0 || custo0 <= 0 || custo1 <= 0) return null; // sem base diária não há prazo

  const rd0 = rl0 / d0;
  const rd1 = rl1 / d1;
  const cd0 = custo0 / d0;
  const cd1 = custo1 / d1;

  const efeitos: EfeitoNcg[] = [];
  let explicado = 0;
  const prazoDe = (saldo: number, base: number): number => (base > 0 ? saldo / base : 0);

  const componente = (
    nomePrazo: string,
    nomeVolume: string,
    saldo0: number,
    saldo1: number,
    base0: number,
    base1: number,
    sinal: 1 | -1
  ): [number | null, number | null] => {
    const p0 = prazoDe(saldo0, base0);
    const p1 = prazoDe(saldo1, base1);
    const efPrazo = (p1 - p0) * base1 * sinal;
    const efVolume = p0 * (base1 - base0) * sinal;
    if (Math.abs(efPrazo) > 0.005) efeitos.push({ nome: nomePrazo, valor: round2(efPrazo) });
    if (Math.abs(efVolume) > 0.005) efeitos.push({ nome: nomeVolume, valor: round2(efVolume) });
    explicado += efPrazo + efVolume;
    return [round2(p0 * 100) / 100, round2(p1 * 100) / 100];
  };

  const pmr = componente(
    "Prazo de recebimento (PMR)", "Crescimento da receita sobre clientes",
    bpVal(bp, "Contas a Receber - CP", de), bpVal(bp, "Contas a Receber - CP", ate), rd0, rd1, 1
  );
  const pme = componente(
    "Prazo de estoque (PME)", "Crescimento do custo sobre estoques",
    bpVal(bp, "Estoques - CP", de), bpVal(bp, "Estoques - CP", ate), cd0, cd1, 1
  );
  const pmf = componente(
    "Prazo de fornecedores (PMF)", "Crescimento do custo sobre fornecedores",
    Math.abs(bpVal(bp, "Fornecedores - CP", de)), Math.abs(bpVal(bp, "Fornecedores - CP", ate)), cd0, cd1, -1
  );

  const outros = delta - explicado;
  if (Math.abs(outros) > 0.005) efeitos.push({ nome: "Demais itens do giro (tributos, adiantamentos, obrigações…)", valor: round2(outros) });

  const soma = efeitos.reduce((s, e) => s + e.valor, 0);
  // O bucket residual faz a soma fechar SEMPRE — se ele domina, a ponte não
  // explica nada e não pode se anunciar como leitura ("prova" ≠ explicação).
  const conclusiva = Math.abs(delta) < 0.005 ? true : Math.abs(outros) <= Math.abs(delta) * 0.5;
  return {
    ncgInicial: round2(ncg0),
    ncgFinal: round2(ncg1),
    efeitos,
    prova: prova(round2(soma), round2(delta)),
    prazos: { pmr, pme, pmf },
    conclusiva,
    nota: conclusiva ? null : "Mais da metade da variação está em itens fora de clientes/estoques/fornecedores — decomposição por prazos não é conclusiva aqui.",
  };
}

// ── DuPont do ROE: margem × giro × alavancagem (sequencial exata) ─────────────

function dupontDe(bp: BPLineItem[], dre: DRELineItem[], de: string, ate: string, mesesJanela: number): DupontRoe | null {
  const comp = (p: string): { m: number; g: number; a: number } | null => {
    const ll = dreVal(dre, "Lucro Líquido", p);
    const rl = dreVal(dre, "Receita Líquida", p);
    const at = bpVal(bp, "Ativo Total", p);
    const pl = Math.abs(bpVal(bp, "Patrimônio Líquido", p));
    if (rl === 0 || at === 0 || pl === 0) return null;
    return { m: ll / rl, g: rl / at, a: at / pl };
  };
  const c0 = comp(de);
  const c1 = comp(ate);
  if (!c0 || !c1) return null;

  // PL ECONOMICAMENTE negativo ≠ convenção crédito-negativo do sistema: quando o
  // Passivo Total inteiro vem negativo, o sinal do PL é convenção; quando o PT é
  // positivo e o PL negativo, é prejuízo acumulado de verdade (caso distressed).
  const plEconomico = (p: string): number => {
    const plRaw = bpVal(bp, "Patrimônio Líquido", p);
    const pt = bpVal(bp, "Passivo Total", p);
    return pt < 0 ? -plRaw : plRaw;
  };
  const pl0 = plEconomico(de);
  const pl1 = plEconomico(ate);
  if (pl0 <= 0 || pl1 <= 0) {
    // PL negativo: ROE perde sentido econômico — não decompor (regra de honestidade).
    return {
      roeInicial: round2(c0.m * c0.g * c0.a * 10000) / 10000,
      roeFinal: round2(c1.m * c1.g * c1.a * 10000) / 10000,
      efeitos: { margem: 0, giro: 0, alavancagem: 0, residuo: 0 },
      componentes: { margem: [c0.m, c1.m], giro: [c0.g, c1.g], alavancagem: [c0.a, c1.a] },
      conclusiva: false,
      nota: "Patrimônio líquido não positivo em um dos períodos — a decomposição do ROE não tem leitura econômica.",
    };
  }

  const roe0 = c0.m * c0.g * c0.a;
  const roe1 = c1.m * c1.g * c1.a;
  // ROE nulo nos dois períodos = sem resultado na DRE (extração parcial): a
  // decomposição diria "0% → 0%, efeitos 0" — ruído que ainda contradiz o KPI
  // ao lado. Sem leitura, não há seção.
  if (Math.abs(roe0) < 1e-6 && Math.abs(roe1) < 1e-6) return null;
  // Sequencial telescópica: Δ(m·g·a) = Δm·g0·a0 + m1·Δg·a0 + m1·g1·Δa — exata.
  const efMargem = (c1.m - c0.m) * c0.g * c0.a;
  const efGiro = c1.m * (c1.g - c0.g) * c0.a;
  const efAlav = c1.m * c1.g * (c1.a - c0.a);
  const residuo = roe1 - roe0 - (efMargem + efGiro + efAlav);
  const deltaRoe = roe1 - roe0;
  const conclusiva = deltaRoe === 0 ? true : Math.abs(residuo) <= Math.abs(deltaRoe) * 0.2;

  // PRECISÃO: com 4 casas na RAZÃO, um ROE de 80,0476% virava 0,8005 e a tela
  // imprimia "80,1%" — meio ponto inventado no arredondamento. Pior na margem:
  // 0,0196 tem 2 dígitos significativos, e quem multiplicasse os fatores da
  // tabela não voltava ao ROE publicado (80,20% contra 80,05%). 6 casas na razão
  // = 4 casas no percentual, que é o que a tela mostra.
  const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
  return {
    roeInicial: r6(roe0),
    roeFinal: r6(roe1),
    efeitos: { margem: r6(efMargem), giro: r6(efGiro), alavancagem: r6(efAlav), residuo: r6(residuo) },
    componentes: { margem: [r6(c0.m), r6(c1.m)], giro: [r6(c0.g), r6(c1.g)], alavancagem: [r6(c0.a), r6(c1.a)] },
    // JANELA DO NUMERADOR. ROE e giro sao RAZAO DE FLUXO SOBRE ESTOQUE: num par
    // mes a mes o lucro e a receita sao de UM mes e o PL/Ativo sao saldo de data.
    // O motor publicava "ROE 26%" para abril com o mesmo rotulo do ROE anual da
    // pagina anterior — para um credor isso le como ~312% ao ano. Nao se
    // anualiza aqui (anualizar mes de empresa sazonal inventa outra mentira):
    // declara-se a janela e quem exibe avisa.
    janelaMeses: mesesJanela,
    conclusiva,
    nota: conclusiva ? null : "Resíduo de interação acima de 20% do Δ — decomposição não conclusiva.",
  };
}

// ── Montagem ───────────────────────────────────────────────────────────────────

export interface DadosParaPontes {
  bp?: BPLineItem[];
  dre?: DRELineItem[];
  periodos?: string[];
  fluxoCaixa?: FluxoCaixaIndireto | null;
  serie?: SerieLacunasSrv | null;
  arvoresBalancete?: Array<{ periodo?: string }>;
  balancetes?: unknown;
}

/**
 * RÉGUAS DE COMPARAÇÃO (14/08/2026, pergunta do dono: "quando começarmos a
 * receber balancetes mensais, como será feito estas pontes?").
 *
 * A DRE é FLUXO: só se compara janela igual com janela igual. Com balancete
 * mensal existem três réguas legítimas, e cada uma responde a uma pergunta
 * diferente:
 *
 * - `exercicio`  — ano cheio × ano cheio anterior. "Como foi o ano."
 * - `mes`        — mês × mês anterior (MoM). Usa a DRE DO MÊS (YTD N − YTD N−1);
 *                  é a régua do acompanhamento recorrente. Sazonalidade pesa:
 *                  dezembro contra novembro engana em negócio sazonal.
 * - `ano-a-ano`  — acumulado no ano × mesmo acumulado do ano anterior
 *                  (mai/26 YTD vs mai/25 YTD). Neutraliza sazonalidade — é a
 *                  régua que o analista quer no recorrente quando há histórico.
 *
 * O que NUNCA se compara: ano cheio com YTD parcial (12 meses vs 5). É o
 * bloqueio que já existia e continua.
 */
export type ReguaComparacao = "exercicio" | "mes" | "ano-a-ano";

export interface ParComparacao {
  de: string;
  ate: string;
  regua: ReguaComparacao;
  /** Meses cobertos por cada lado (iguais por construção) — a prova da janela. */
  mesesJanela: number;
  /** Há períodos ENTRE os dois: comparação ponto a ponto, não tendência. */
  saltaPeriodos: boolean;
}

/**
 * RÓTULO DE PERÍODO nas mensagens do motor (regra do dono): exercício vira
 * "2024", mês vira "05/2026" — a data de fechamento é chave do dado, não
 * linguagem de relatório. Sem isto, o aviso na tela dizia "entre 31/12/2022 e
 * 31/12/2024" ao lado de um seletor que já mostrava "2022 → 2024".
 */
export const rotuloPeriodoSrv = (p: string, ehMes = false): string => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((p ?? "").trim());
  if (!m) return (p ?? "").trim();
  return ehMes || m[2] !== "12" ? `${m[2]}/${m[3]}` : m[3]!;
};

const mesAno = (p: string): { mes: number; ano: number } | null => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(p.trim());
  if (m) return { mes: Number(m[2]), ano: Number(m[3]) };
  const y = /^(\d{4})$/.exec(p.trim());
  return y ? { mes: 12, ano: Number(y[1]) } : null;
};

/**
 * Todos os pares comparáveis da série, do mais recente para o mais antigo.
 * Leve (só rótulos) — vai persistido para a tela montar o seletor sem recalcular.
 */
export function paresComparaveis(dados: DadosParaPontes): ParComparacao[] {
  const periodos = [...(dados.periodos ?? [])].sort((a, b) => ordPeriodo(a) - ordPeriodo(b));
  const ytd = new Set((dados.arvoresBalancete ?? []).map((a) => a?.periodo).filter(Boolean) as string[]);
  const out: ParComparacao[] = [];

  // QUALQUER PAR DE JANELA IGUAL, não só o consecutivo (14/08/2026, pedido do
  // dono: "preciso escolher períodos não sequenciais, por exemplo 2024 contra
  // 2022"). Comparar dois exercícios distantes é leitura legítima — são dois
  // RETRATOS completos, e pular um ano no meio não falsifica nenhum dos dois.
  // O que continua proibido é misturar janelas (ano cheio × acumulado parcial).
  // `saltaPeriodos` marca quando há períodos entre os dois: a variação é ponto a
  // ponto, não tendência, e a tela precisa poder dizer isso.
  const serie = dados.serie ?? null;
  for (let i = 0; i < periodos.length; i++) {
    for (let j = i + 1; j < periodos.length; j++) {
      const de = periodos[i]!;
      const ate = periodos[j]!;
      const a = mesAno(de), b = mesAno(ate);
      if (!a || !b) continue;
      // LACUNA DE DADOS ≠ PERÍODO PULADO. Pular 2023 que EXISTE é escolha do
      // analista (vira `saltaPeriodos`); atravessar um ano que NÃO existe é
      // variação sobre vazio e segue bloqueada.
      if (atravessaLacuna(de, ate, serie).lacuna) continue;
      const salto = j - i - 1;
      const anuais = !ytd.has(de) && !ytd.has(ate);
      const mensais = ytd.has(de) && ytd.has(ate);

      if (anuais) {
        out.push({ de, ate, regua: "exercicio", mesesJanela: 12, saltaPeriodos: salto > 0 });
        continue;
      }
      if (!mensais) continue; // ano cheio × YTD parcial: nunca

      if (a.ano === b.ano && b.mes === a.mes + 1) {
        // MoM: mês contra o mês anterior, pela DRE do mês.
        out.push({ de, ate, regua: "mes", mesesJanela: 1, saltaPeriodos: false });
      } else if (a.mes === b.mes && a.ano < b.ano) {
        // Mesmo mês de anos diferentes: YTD × YTD (janela igual em meses).
        out.push({ de, ate, regua: "ano-a-ano", mesesJanela: b.mes, saltaPeriodos: b.ano - a.ano > 1 });
      }
      // Meses de meses diferentes que não são o mesmo mês (ex.: mar × ago) ficam
      // de fora: acumulados de janelas diferentes (3 meses × 8) não se comparam.
    }
  }

  return out.sort((x, y) => ordPeriodo(y.ate) - ordPeriodo(x.ate) || ordPeriodo(y.de) - ordPeriodo(x.de));
}

/**
 * DRE ajustada à régua: no MoM os dois lados precisam do valor DO MÊS (a DRE de
 * balancete é acumulada no exercício — comparar YTD de maio com YTD de abril
 * daria "variação" que é só o mês de maio somado ao resto do ano).
 */
function dreDaRegua(dre: DRELineItem[], dados: DadosParaPontes, par: ParComparacao): DRELineItem[] | null {
  if (par.regua !== "mes") return dre;
  const mensal = derivarDREMensal({ dre, balancetes: dados.balancetes, arvoresBalancete: dados.arvoresBalancete });
  const infoDe = mensal?.periodos?.[par.de];
  const infoAte = mensal?.periodos?.[par.ate];
  // Sem o mês isolado dos DOIS lados não há MoM honesto.
  if (!mensal || !infoDe?.mesIsolado || !infoAte?.mesIsolado) return null;
  return dre.map((l) => ({
    ...l,
    valores: {
      ...l.valores,
      [par.de]: mensal.valores?.[l.conta]?.[par.de] ?? 0,
      [par.ate]: mensal.valores?.[l.conta]?.[par.ate] ?? 0,
    },
  }));
}

/**
 * Calcula todas as pontes do IBR. null quando há menos de 2 períodos.
 * Par bloqueado por lacuna → objeto com `bloqueio` e pontes nulas (as telas
 * mostram o motivo em vez de inventar variação).
 */
export function buildPontesVariacao(
  dados: DadosParaPontes,
  opts?: { regimeCadastro?: string | null; par?: { de: string; ate: string } | null }
): PontesVariacao | null {
  const periodos = [...(dados.periodos ?? [])].sort((a, b) => ordPeriodo(a) - ordPeriodo(b));
  if (periodos.length < 2) return null;
  const bp = dados.bp ?? [];
  const dreOriginal = dados.dre ?? [];
  let dre = dreOriginal;

  // Dias-base por período (mesma precedência do buildIndicators: YTD de
  // balancete = mês×30; demais pela cadência da série).
  const ytd = new Set((dados.arvoresBalancete ?? []).map((a) => a?.periodo).filter(Boolean) as string[]);
  const diasPorPeriodo: Record<string, number> = {};
  for (const p of periodos) {
    diasPorPeriodo[p] = ytd.has(p) ? diasYTD(p) : diasDoPeriodo(p, periodos.filter((x) => !ytd.has(x) || x === p));
  }

  const disponiveis = paresComparaveis(dados);
  const base: PontesVariacao = {
    calculadoEm: new Date().toISOString(),
    par: null,
    regua: null,
    disponiveis,
    bloqueio: null,
    avisoPar: null,
    ponteEbitda: null,
    ponteLucro: null,
    hierarquiaCaixa: null,
    ponteNcg: null,
    dupont: null,
  };

  // ESCOLHA DO PAR: a DRE é FLUXO — comparar 12 meses com um YTD de 5 seria
  // variação inventada (o mesmo erro que o gráfico da onda 1 evita). Exige-se
  // JANELA IGUAL além da continuidade. O analista pode PEDIR um par (opts.par);
  // sem pedido, vale o mais recente comparável — e o recuo é declarado.
  const ultimo = periodos[periodos.length - 1]!;
  let escolhido: ParComparacao | null = null;
  let motivoBloqueio: string | null = null;

  if (opts?.par) {
    escolhido = disponiveis.find((p) => p.de === opts.par!.de && p.ate === opts.par!.ate) ?? null;
    if (!escolhido) {
      return { ...base, bloqueio: "O par pedido não é comparável (janela diferente ou lacuna na série)." };
    }
  } else {
    // Preferência: o par mais recente da régua mais informativa disponível —
    // ano-a-ano vence MoM no mensal (neutraliza sazonalidade); no anual,
    // exercício. Par que SALTA períodos nunca é o padrão: é escolha do analista.
    const porRegua = (r: ReguaComparacao) => disponiveis.filter((p) => p.regua === r && !p.saltaPeriodos)[0] ?? null;
    escolhido = porRegua("ano-a-ano") ?? porRegua("exercicio") ?? porRegua("mes") ?? null;
    if (!escolhido) {
      for (let i = periodos.length - 1; i >= 1; i--) {
        const cmp = parComparavelSrv(periodos[i - 1]!, periodos[i]!, dados.serie ?? null);
        if (!cmp.ok) { motivoBloqueio ??= cmp.motivo ?? null; continue; }
        if (diasPorPeriodo[periodos[i - 1]!] !== diasPorPeriodo[periodos[i]!]) {
          motivoBloqueio ??= "os dois períodos cobrem janelas diferentes (ex.: ano cheio vs acumulado parcial)";
        }
      }
      return { ...base, bloqueio: `Variação não decomposta: ${motivoBloqueio ?? "sem par de períodos comparável"}.` };
    }
  }

  const { de, ate } = escolhido;
  // MoM precisa da DRE DO MÊS nos dois lados; sem ela, o par não vira ponte.
  const dreAjustada = dreDaRegua(dre, dados, escolhido);
  if (!dreAjustada) {
    return { ...base, bloqueio: "Mês a mês indisponível: falta o mês anterior na série para isolar o resultado do mês (a DRE do balancete é acumulada no exercício)." };
  }
  dre = dreAjustada;
  if (escolhido.regua === "mes") {
    diasPorPeriodo[de] = 30;
    diasPorPeriodo[ate] = 30;
  }
  // Dois avisos possíveis, nesta ordem de importância:
  // 1. par SALTA períodos (escolha do analista: 2024 contra 2022) — a variação é
  //    ponto a ponto e não descreve o caminho entre eles;
  // 2. o par não alcança o fim da série (só quando o analista NÃO pediu o par —
  //    pedido explícito não precisa se justificar).
  // SO' A REGUA "mes" TEM VALOR DE MES. A regua "ano-a-ano" compara YTD x YTD com
  // janela igual (`mesesJanela`); quando ela fecha em dezembro, os dois lados sao
  // o EXERCICIO INTEIRO — e o rotulo tem de dizer "2024 → 2025". Com o teste
  // anterior (`!== "exercicio"`) o par ano-a-ano caia no formato de mes e o
  // relatorio publicava "12/2024 → 12/2025", que o leitor entende como dezembro
  // contra dezembro: parecia comparar o ano cheio com um mes. O NUMERO sempre
  // esteve certo (janela de 12 meses dos dois lados); mentia o rotulo.
  // Em YTD parcial (ex.: maio) `rotuloPeriodoSrv` ja' devolve "05/2025" sozinho.
  const ehMes = escolhido.regua === "mes";
  const rDe = rotuloPeriodoSrv(de, ehMes);
  const rAte = rotuloPeriodoSrv(ate, ehMes);
  const avisoPar = escolhido.saltaPeriodos
    ? `Comparação ponto a ponto entre ${rDe} e ${rAte}: há período(s) entre os dois que não entram nesta conta — a variação mostra a diferença entre os dois retratos, não o caminho percorrido.`
    : !opts?.par && ate !== ultimo
      ? (disponiveis.some((x) => x.ate === ultimo)
          ? `O período mais recente (${rotuloPeriodoSrv(ultimo)}) fica de fora DESTE par: não há na série um período de mesma janela do ano anterior para compará-lo, e a comparação de 12 meses contra 12 meses é mais informativa que a de um mês. Há pares terminando em ${rotuloPeriodoSrv(ultimo)} no seletor.`
          : `O período mais recente (${rotuloPeriodoSrv(ultimo)}) fica de fora: não há na série outro período de janela igual para compará-lo.`)
      : null;

  const fc = dados.fluxoCaixa ?? null;
  return {
    ...base,
    par: { de, ate, rotuloDe: rDe, rotuloAte: rAte, mesesJanela: escolhido.mesesJanela },
    regua: escolhido.regua,
    avisoPar,
    ponteEbitda: ponteResultadoDe(dre, "EBITDA", de, ate),
    ponteLucro: ponteResultadoDe(dre, "Lucro Líquido", de, ate),
    hierarquiaCaixa: fc ? hierarquiaCaixaDe(dre, fc, ate, opts?.regimeCadastro ?? null, ytd, escolhido.regua === "mes") : null,
    ponteNcg: ponteNcgDe(bp, dre, de, ate, diasPorPeriodo),
    dupont: dupontDe(bp, dre, de, ate, escolhido.mesesJanela),
  };
}
