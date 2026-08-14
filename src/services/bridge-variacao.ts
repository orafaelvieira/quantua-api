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
  /** false quando o resíduo passa de 20% do Δ ou o PL não sustenta a leitura. */
  conclusiva: boolean;
  nota: string | null;
}

export interface PontesVariacao {
  calculadoEm: string;
  /** Par decomposto (anterior → atual). null + bloqueio quando não comparável. */
  par: { de: string; ate: string } | null;
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
  regimeCadastro: string | null
): HierarquiaCaixa | null {
  const provaCol = fc.prova?.find((p) => p.periodo === col);
  if (!provaCol?.fecha) return null;
  const fco = fc.totais?.fco?.[col];
  const fci = fc.totais?.fci?.[col];
  const fcf = fc.totais?.fcf?.[col];
  if (typeof fco !== "number" || typeof fci !== "number" || typeof fcf !== "number") return null;

  const ebitda = dreVal(dre, "EBITDA", col);
  const ir = dreVal(dre, "IR e CSLL", col); // negativo por convenção
  const rf = dreVal(dre, "Resultado Financeiro", col);
  const rno = dreVal(dre, "Resultado Não Operacional", col);
  // DEGRAU DO GIRO = TODA a variação operacional do FCO, não só o sub-bloco
  // `capitalGiro`: o FC joga em `fco` também os Δ de tributos a recuperar,
  // obrigações trabalhistas/tributárias etc. Deriva-se da identidade do próprio
  // FC (FCO = LL − D&A − EqPat + Δgiro), então a prova abaixo verifica a
  // CASCATA DA DRE (LL = EBITDA + D&A + EqPat + RF + RNO + IR) — e falha de
  // verdade quando um subtotal extraído não bate com seus componentes.
  const lucro = dreVal(dre, "Lucro Líquido", col);
  const da = dreVal(dre, "Depreciação e Amortização", col);
  const eqP = dreVal(dre, "Equivalência Patrimonial", col);
  const giro = fco - lucro + da + eqP;
  const giroCapitalDeGiro = fc.capitalGiro?.total?.[col] ?? null; // sub-bloco, quando existe
  const fcoRecomposto = ebitda + ir + rf + rno + giro;

  const fcle = fco + fci;
  const deltaCaixa = provaCol.deltaObservado;

  const degraus: DegrauCaixa[] = [
    { nome: "EBITDA (DRE)", tipo: "nivel", valor: round2(ebitda) },
    { nome: "IR e CSLL (DRE, competência)", tipo: "delta", valor: round2(ir) },
    ...(Math.abs(rf) > 0.005 ? [{ nome: "Resultado financeiro (juros líquidos)", tipo: "delta" as const, valor: round2(rf) }] : []),
    ...(Math.abs(rno) > 0.005 ? [{ nome: "Resultado não operacional", tipo: "delta" as const, valor: round2(rno) }] : []),
    { nome: "Δ capital de giro e demais itens operacionais", tipo: "delta", valor: round2(giro) },
    ...(giroCapitalDeGiro !== null && Math.abs(giroCapitalDeGiro) > 0.005
      ? [{ nome: "dentro dele, capital de giro (clientes, estoques, fornecedores)", tipo: "delta" as const, valor: round2(giroCapitalDeGiro), informativo: true }]
      : []),
    { nome: "Caixa das operações (FCO)", tipo: "nivel", valor: round2(fco) },
    { nome: "Investimentos (capex e participações — FCI)", tipo: "delta", valor: round2(fci) },
    { nome: "Caixa livre após juros e IR (FCLE)", tipo: "nivel", valor: round2(fcle) },
    { nome: "Captações, amortizações e dividendos (FCF)", tipo: "delta", valor: round2(fcf) },
    { nome: "Variação do caixa no período", tipo: "nivel", valor: round2(deltaCaixa) },
  ];

  // Alíquota efetiva (contexto): |IR| / LAIR quando o LAIR é positivo.
  const lair = dreVal(dre, "Resultado Antes do IR e CSLL", col);
  const aliquotaEfetiva = lair > 0 && ir !== 0 ? round2((Math.abs(ir) / lair) * 100) / 100 : null;

  // Taxa de conversão de caixa por coluna PROVADA do FC (série completa).
  const taxaConversao = fc.colunas
    .filter((c) => fc.prova?.find((p) => p.periodo === c)?.fecha)
    .map((c) => {
      const e = dreVal(dre, "EBITDA", c);
      const f = fc.totais?.fco?.[c] ?? 0;
      return { periodo: c, ebitda: round2(e), fco: round2(f), taxa: e > 0 ? round2((f / e) * 100) / 100 : null };
    });

  return {
    periodo: col,
    degraus,
    provaFco: prova(round2(fcoRecomposto), round2(fco)),
    provaDeltaCaixa: prova(round2(fco + fci + fcf), round2(deltaCaixa)),
    taxaConversao,
    premissas: {
      aliquotaEfetiva,
      regimeCadastro,
      nota: "IR pela DRE (competência, não o efetivamente pago); capex estimado por ΔImobilizado/Intangível + D&A; alíquota efetiva = IR ÷ LAIR do período.",
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

function dupontDe(bp: BPLineItem[], dre: DRELineItem[], de: string, ate: string): DupontRoe | null {
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

  const r4 = (v: number): number => Math.round(v * 10000) / 10000;
  return {
    roeInicial: r4(roe0),
    roeFinal: r4(roe1),
    efeitos: { margem: r4(efMargem), giro: r4(efGiro), alavancagem: r4(efAlav), residuo: r4(residuo) },
    componentes: { margem: [r4(c0.m), r4(c1.m)], giro: [r4(c0.g), r4(c1.g)], alavancagem: [r4(c0.a), r4(c1.a)] },
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
}

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
  const serie = dados.serie ?? null;
  const out: ParComparacao[] = [];

  for (let i = 1; i < periodos.length; i++) {
    const de = periodos[i - 1]!;
    const ate = periodos[i]!;
    if (!parComparavelSrv(de, ate, serie).ok) continue;
    const a = mesAno(de), b = mesAno(ate);
    if (!a || !b) continue;
    const ehMes = ytd.has(de) && ytd.has(ate);
    if (ehMes) {
      // Meses consecutivos do MESMO exercício: MoM pela DRE do mês.
      const consecutivo = a.ano === b.ano && b.mes === a.mes + 1;
      if (consecutivo) out.push({ de, ate, regua: "mes", mesesJanela: 1 });
    } else if (!ytd.has(de) && !ytd.has(ate)) {
      // Dois exercícios (ou dois períodos anuais) consecutivos.
      out.push({ de, ate, regua: "exercicio", mesesJanela: 12 });
    }
  }

  // ANO A ANO no mensal: mesmo mês do ano anterior, YTD contra YTD (janela igual
  // em meses). Não precisa ser consecutivo na série — precisa existir.
  for (const ate of periodos) {
    if (!ytd.has(ate)) continue;
    const b = mesAno(ate);
    if (!b) continue;
    const de = periodos.find((p) => {
      if (!ytd.has(p)) return false;
      const a = mesAno(p);
      return a && a.mes === b.mes && a.ano === b.ano - 1;
    });
    if (de) out.push({ de, ate, regua: "ano-a-ano", mesesJanela: b.mes });
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
    // ano-a-ano vence MoM no mensal (neutraliza sazonalidade); no anual, exercício.
    const porRegua = (r: ReguaComparacao) => disponiveis.filter((p) => p.regua === r)[0] ?? null;
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
  // O aviso só existe quando o analista NÃO pediu o par e o escolhido não chega
  // ao fim da série — pedido explícito não precisa se justificar.
  const avisoPar = !opts?.par && ate !== ultimo
    ? `Decomposição do par ${de} → ${ate}: o período mais recente (${ultimo}) não entra nesta comparação — só se compara janela igual com janela igual.`
    : null;

  const fc = dados.fluxoCaixa ?? null;
  return {
    ...base,
    par: { de, ate },
    regua: escolhido.regua,
    avisoPar,
    ponteEbitda: ponteResultadoDe(dre, "EBITDA", de, ate),
    ponteLucro: ponteResultadoDe(dre, "Lucro Líquido", de, ate),
    hierarquiaCaixa: fc ? hierarquiaCaixaDe(dre, fc, ate, opts?.regimeCadastro ?? null) : null,
    ponteNcg: ponteNcgDe(bp, dre, de, ate, diasPorPeriodo),
    dupont: dupontDe(bp, dre, de, ate),
  };
}
