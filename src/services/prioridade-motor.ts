import type { BPLineItem, DRELineItem } from "../types/financial";
import { diasBaseDe } from "./indicator-calculator";
import type { PeerComparisonRow } from "./peer-benchmark";

/**
 * PRIORIDADE DECIDIDA PELO MOTOR — "o motor manda e a IA acompanha"
 * (dono, 21/08/2026: "cada empresa vai ser diferente da outra, então não podemos
 * padronizar, então motor deve mandar e a IA acompanhar, sempre").
 *
 * ═══ POR QUE NÃO É UM SEMÁFORO NEM UM SCORE ═══
 *
 * Medimos as alternativas antes de escrever isto, sobre a série real da Belagro:
 *
 *  · LIMIAR FIXO NÃO ORDENA. Em 31/05/2026, 15 de 18 indicadores com semáforo
 *    saíram "critico". Qualquer conversão status→prioridade devolve um Top-3 que
 *    é só a ordem do array INDICADORES_TEMPLATE — determinístico, reprodutível e
 *    sem significado nenhum.
 *  · TRAJETÓRIA POR AMPLITUDE (min-max da própria série) INVERTE O DIAGNÓSTICO.
 *    A Margem EBITDA da Belagro ficou em ÚLTIMO lugar de urgência ("quase o
 *    melhor da própria história") numa empresa com EBITDA negativo, porque um
 *    balancete de janeiro sobre 30 dias marcou −33% e dominou o mínimo.
 *  · TEMPO (dias de caixa) MEDE O MODELO DE NEGÓCIO, NÃO O RISCO. Em 2024, ano
 *    de LUCRO de R$ 11,6 mi, a Belagro tinha 1,4 dias de caixa. Toda trading com
 *    custo ≈ 93% da receita marcaria urgência máxima em toda geração.
 *  · ORDENAR ENTRE UNIDADES DIFERENTES COLAPSA. Numa empresa sem pares e sem
 *    covenant — o caso comum — os sinais empatam em todos os critérios e o plano
 *    do credor sai em ORDEM ALFABÉTICA com selo de método. Medido: C, E, E, I,
 *    L, L, L, L.
 *
 * ═══ A RÉGUA QUE SOBREVIVEU: O PREÇO DE VOLTAR À REFERÊNCIA ═══
 *
 * Toda severidade sai em R$ do balanço da PRÓPRIA empresa: quanto teria de se
 * mover, numa conta nomeada, para o indicador voltar a uma referência MEDIDA.
 * A referência muda de camada; a unidade nunca muda — por isso não há comparação
 * entre grandezas incomparáveis, e não há um único limiar inventado.
 *
 *   CAMADA 1 · CONTRATO — o limite do covenant cadastrado. É a única referência
 *              que não é nossa: quem a escreveu foi o credor.
 *   CAMADA 2 · PARES — a mediana do subsetor (base CVM).
 *   CAMADA 3 · PRÓPRIA SÉRIE — o nível do período de referência comparável.
 *
 * O RÓTULO SEGUE A FORÇA DA PROVA, não a posição numa lista:
 *   Alta  = covenant descumprido/não atendível, OU pior que os pares E pior que
 *           a própria referência (duas fontes independentes concordando).
 *   Média = covenant no limite, OU pior em uma das duas referências.
 *   (sem) = nenhuma referência disponível → "sem prioridade medida". NUNCA
 *           "Baixa": Baixa é um veredicto, ausência de medida não é.
 *
 * TRAVA DE DISCRIMINAÇÃO: se a ordem do topo tiver sido decidida pelo desempate
 * por nome — e não por um preço medido —, a agenda NÃO publica rótulo. Publica
 * "Sequência sugerida (sem prioridade medida)". Cobertura e discriminação são
 * coisas diferentes: dizer "uma fonte" em todas as linhas é verdadeiro e inútil
 * quando nenhuma delas separou nada.
 */

// ───────────────────────────────────────────────────────────────────────────
// Contratos
// ───────────────────────────────────────────────────────────────────────────

export type NaturezaSinal = "saldo" | "fluxo";
export type NivelProva = "contratual" | "duas-fontes" | "uma-fonte" | "sem-medida";
export type RotuloPrioridade = "Alta" | "Média" | null;

export interface ReferenciaMedida {
  tipo: "contrato" | "pares" | "propria";
  /** O valor-alvo do indicador nessa referência. */
  alvo: number;
  /** Como a referência se declara no relatório (vai impressa). */
  rotulo: string;
}

export interface SinalPriorizado {
  /** ID ESTÁVEL — é por ele que a IA amarra o texto ao fato. Nunca nome livre. */
  id: string;
  nome: string;
  natureza: NaturezaSinal;
  /** Valor do indicador no período em análise (NaN quando não mensurável). */
  valor: number;
  tipoDado: string;
  referencias: ReferenciaMedida[];
  /** A referência que ordenou (a de maior precedência entre as disponíveis). */
  referenciaQueOrdena: ReferenciaMedida;
  /** R$ que precisam se mover para o indicador voltar à referência que ordena. */
  precoBRL: number | null;
  /** A conta que se move — nomeada, para a memória de cálculo. */
  alavanca: string;
  /** A conta explicada em prosa, auditável linha a linha contra o balanço. */
  memoria: string;
  nivelProva: NivelProva;
  rotulo: RotuloPrioridade;
  /** Só na camada contratual. */
  veredictoContrato?: "breach" | "amber" | "nao-atendivel";
}

export interface AgendaPrioridade {
  periodo: string;
  /** Já ORDENADOS: é esta a ordem que o relatório publica. */
  sinais: SinalPriorizado[];
  /** false = a ordem não foi decidida por medida; não publique rótulo. */
  discriminou: boolean;
  /** O eixo que ordenou, para ir impresso ao lado da coluna. */
  eixo: string;
  /** O que faltou — declarado, nunca silencioso. */
  lacunas: string[];
  cobertura: { medidos: number; avaliados: number };
}

/** Premissa DECLARADA: abaixo disso a "mediana dos pares" é a própria amostra, e
 *  uma prioridade apoiada nela é precisão falsa. Não muda a exibição do cartão de
 *  pares (que segue em n=1 por decisão de 18/08/2026) — vale só para ORDENAR. */
export const MIN_PARES_PARA_ORDENAR = 3;

// ───────────────────────────────────────────────────────────────────────────
// Leitura das contas (mesmos nomes e mesmas normalizações de sinal do motor de
// indicadores — se divergirem, o preço não reconcilia contra o balanço).
// ───────────────────────────────────────────────────────────────────────────

const bpVal = (bp: BPLineItem[], conta: string, p: string): number =>
  bp.find((b) => b.conta === conta)?.valores[p] ?? 0;
const dreVal = (dre: DRELineItem[], conta: string, p: string): number =>
  dre.find((d) => d.conta === conta)?.valores[p] ?? 0;

interface Contas {
  ativoCirculante: number; estoques: number; contasReceber: number; caixa: number;
  realizavelLP: number; imobilizadoLiq: number;
  passivoTotal: number; passivoCirculante: number; passivoNaoCirculante: number;
  fornecedores: number; capitalTerceiros: number; dividaLiquida: number;
  patrimonioLiquido: number;
  receitaLiquida: number; custoOperacional: number; lucroBruto: number;
  ebitda: number; lucroLiquido: number; despesasFinanceiras: number;
  dias: number;
}

function lerContas(bp: BPLineItem[], dre: DRELineItem[], p: string, dias: number): Contas {
  const abs = (c: string): number => Math.abs(bpVal(bp, c, p));
  const receitaLiquida = dreVal(dre, "Receita Líquida", p)
    || (dreVal(dre, "Receita Bruta", p) + dreVal(dre, "Deduções da Receita Bruta", p) + dreVal(dre, "Impostos s/ Faturamento", p));
  const custoOp = dreVal(dre, "Custo Operacional", p);
  const capitalTerceiros = abs("Empréstimos e Financiamentos - CP") + abs("Passivos com Partes Relacionadas - CP")
    + abs("Empréstimos e Financiamentos - LP") + abs("Passivos com Partes Relacionadas - LP");
  const caixa = bpVal(bp, "Caixa e Equivalentes de Caixa", p);
  return {
    ativoCirculante: bpVal(bp, "Ativo Circulante", p),
    estoques: bpVal(bp, "Estoques - CP", p),
    contasReceber: bpVal(bp, "Contas a Receber - CP", p),
    caixa,
    realizavelLP: bpVal(bp, "Realizável a Longo Prazo", p),
    imobilizadoLiq: bpVal(bp, "Imobilizado", p) + bpVal(bp, "(-) Depreciação", p)
      + bpVal(bp, "Investimentos", p) + bpVal(bp, "Intangível", p) + bpVal(bp, "(-) Amortização", p),
    passivoTotal: abs("Passivo Total"),
    passivoCirculante: abs("Passivo Circulante"),
    passivoNaoCirculante: abs("Passivo Não Circulante"),
    fornecedores: abs("Fornecedores - CP"),
    capitalTerceiros,
    dividaLiquida: capitalTerceiros - caixa,
    patrimonioLiquido: abs("Patrimônio Líquido"),
    receitaLiquida,
    custoOperacional: Math.abs(custoOp),
    lucroBruto: dreVal(dre, "Lucro Bruto", p) || (receitaLiquida + custoOp),
    ebitda: dreVal(dre, "EBITDA", p),
    lucroLiquido: dreVal(dre, "Lucro Líquido", p),
    despesasFinanceiras: Math.abs(dreVal(dre, "Despesas Financeiras", p)),
    dias,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// A TABELA DO PREÇO — para cada indicador, QUAL conta se move e QUANTO.
// Cada linha é uma identidade algébrica sobre o próprio balanço: o número
// reconcilia, não é estimativa.
// ───────────────────────────────────────────────────────────────────────────

interface DefSinal {
  natureza: NaturezaSinal;
  /** true = valor MAIOR é pior (endividamento, prazo de recebimento, alavancagem). */
  maiorEhPior: boolean;
  alavanca: string;
  /** Movimento em R$ na alavanca para o indicador chegar em `alvo`. Positivo = a
   *  conta precisa AUMENTAR; negativo = precisa DIMINUIR. null = não calculável. */
  preco: (c: Contas, alvo: number) => number | null;
}

/** Guarda de denominador: resíduo de arredondamento não é base de nada. */
const base = (v: number): number | null => (Number.isFinite(v) && Math.abs(v) >= 1 ? v : null);

export const PRECO_DO_SINAL: Record<string, DefSinal> = {
  "Liquidez Imediata": {
    natureza: "saldo", maiorEhPior: false, alavanca: "Caixa e Equivalentes de Caixa",
    preco: (c, alvo) => (base(c.passivoCirculante) === null ? null : alvo * c.passivoCirculante - c.caixa),
  },
  "Liquidez Seca": {
    natureza: "saldo", maiorEhPior: false, alavanca: "Ativo Circulante (fora estoques)",
    preco: (c, alvo) => (base(c.passivoCirculante) === null ? null : alvo * c.passivoCirculante - (c.ativoCirculante - c.estoques)),
  },
  "Liquidez Corrente": {
    natureza: "saldo", maiorEhPior: false, alavanca: "Ativo Circulante",
    preco: (c, alvo) => (base(c.passivoCirculante) === null ? null : alvo * c.passivoCirculante - c.ativoCirculante),
  },
  "Liquidez Geral": {
    natureza: "saldo", maiorEhPior: false, alavanca: "Ativo Circulante + Realizável a Longo Prazo",
    preco: (c, alvo) => {
      const den = c.passivoCirculante + c.passivoNaoCirculante;
      return base(den) === null ? null : alvo * den - (c.ativoCirculante + c.realizavelLP);
    },
  },
  // (PT − PL)/PT = alvo, movendo o PL (aporte ou lucro retido) — o PT sobe junto:
  // (PT+X−PL−X)/(PT+X) = alvo → PT−PL = alvo·PT + alvo·X → X = ((PT−PL) − alvo·PT)/alvo
  "Endividamento Geral": {
    natureza: "saldo", maiorEhPior: true, alavanca: "Patrimônio Líquido (aporte ou lucro retido)",
    // O divisor aqui é o ALVO (uma razão, ~0,65), não um saldo em reais: a guarda
    // de meio-real de `base()` reprovaria todo alvo válido — foi o que a bancada
    // pegou. Ratio só precisa não ser zero.
    preco: (c, alvo) => (Math.abs(alvo) < 1e-9 ? null : ((c.passivoTotal - c.patrimonioLiquido) - alvo * c.passivoTotal) / alvo),
  },
  // ALONGAR, não quitar: o que o indicador mede é a FATIA do passivo que vence
  // em 12 meses, e a alavanca real é reperfilar dívida de curto para longo prazo
  // — o Passivo Total não muda. X = alvo·PT − PC.
  //
  // A alternativa (quitar, derrubando PC e PT juntos) resolve para
  // X = (alvo·PT − PC)/(alvo−1), e MEDIMOS o que ela faz numa empresa muito
  // alavancada: com PC/PT em 96,1% o denominador (alvo−1) vira ~0,047 e o preço
  // de andar 0,8 ponto explode para R$ 78,0 milhões. O número está certo e a
  // leitura está errada: perto da assíntota, qualquer empresa apertada teria
  // este sinal no topo da agenda por artefato algébrico, não por urgência.
  "Endividamento de Curto Prazo": {
    natureza: "saldo", maiorEhPior: true, alavanca: "Passivo Circulante (alongar para o longo prazo)",
    preco: (c, alvo) => (base(c.passivoTotal) === null ? null : alvo * c.passivoTotal - c.passivoCirculante),
  },
  "Capital Terceiros s/ PL": {
    natureza: "saldo", maiorEhPior: true, alavanca: "Capital de Terceiros",
    preco: (c, alvo) => (base(c.patrimonioLiquido) === null ? null : alvo * c.patrimonioLiquido - c.capitalTerceiros),
  },
  "Imobilização do Patrimônio Líquido": {
    natureza: "saldo", maiorEhPior: true, alavanca: "Ativo fixo (imobilizado, investimentos, intangível)",
    preco: (c, alvo) => (base(c.patrimonioLiquido) === null ? null : alvo * c.patrimonioLiquido - c.imobilizadoLiq),
  },
  "Dívida Líquida/EBITDA": {
    natureza: "fluxo", maiorEhPior: true, alavanca: "Dívida Líquida",
    preco: (c, alvo) => (base(c.ebitda) === null || c.ebitda <= 0 ? null : alvo * c.ebitda - c.dividaLiquida),
  },
  "Índice de Cobertura de Juros": {
    natureza: "fluxo", maiorEhPior: false, alavanca: "EBITDA",
    preco: (c, alvo) => (base(c.despesasFinanceiras) === null ? null : alvo * c.despesasFinanceiras - c.ebitda),
  },
  "Despesa Financeira / Rec. Líquida": {
    natureza: "fluxo", maiorEhPior: true, alavanca: "Despesas Financeiras",
    preco: (c, alvo) => (base(c.receitaLiquida) === null ? null : alvo * c.receitaLiquida - c.despesasFinanceiras),
  },
  "Margem Bruta": {
    natureza: "fluxo", maiorEhPior: false, alavanca: "Lucro Bruto (preço ou custo)",
    preco: (c, alvo) => (base(c.receitaLiquida) === null ? null : alvo * c.receitaLiquida - c.lucroBruto),
  },
  "Margem EBITDA": {
    natureza: "fluxo", maiorEhPior: false, alavanca: "EBITDA (margem ou despesa operacional)",
    preco: (c, alvo) => (base(c.receitaLiquida) === null ? null : alvo * c.receitaLiquida - c.ebitda),
  },
  "Margem Líquida": {
    natureza: "fluxo", maiorEhPior: false, alavanca: "Lucro Líquido",
    preco: (c, alvo) => (base(c.receitaLiquida) === null ? null : alvo * c.receitaLiquida - c.lucroLiquido),
  },
  "Prazo Médio Contas a Receber": {
    natureza: "fluxo", maiorEhPior: true, alavanca: "Contas a Receber",
    preco: (c, alvo) => (base(c.dias) === null || base(c.receitaLiquida) === null ? null : (alvo * c.receitaLiquida) / c.dias - c.contasReceber),
  },
  "Prazo Médio Estoque": {
    natureza: "fluxo", maiorEhPior: true, alavanca: "Estoques",
    preco: (c, alvo) => (base(c.dias) === null || base(c.custoOperacional) === null ? null : (alvo * c.custoOperacional) / c.dias - c.estoques),
  },
  "Prazo Médio Fornecedores": {
    // Prazo MAIOR é melhor (o fornecedor financia o giro) — direção invertida em
    // relação aos outros dois prazos, e é onde um score somado erraria o sinal.
    natureza: "fluxo", maiorEhPior: false, alavanca: "Fornecedores",
    preco: (c, alvo) => (base(c.dias) === null || base(c.custoOperacional) === null ? null : (alvo * c.custoOperacional) / c.dias - c.fornecedores),
  },
};

/**
 * O PREÇO DE UM SINAL, pela via pública — quanto teria de se mover, e em que
 * conta, para o indicador chegar em `alvo`.
 *
 * Sinal positivo = a conta precisa AUMENTAR; negativo = precisa DIMINUIR.
 * É uma identidade sobre o próprio balanço: mover a conta pelo valor devolvido
 * e recalcular o indicador tem de dar exatamente o alvo — e é isso que a
 * bancada prova, conferindo contra `calculateIndicators`, não contra si mesma.
 */
export function precoDeVoltar(
  nome: string, bp: BPLineItem[], dre: DRELineItem[], periodo: string, alvo: number, dias = 365,
): { brl: number; alavanca: string } | null {
  const def = PRECO_DO_SINAL[nome];
  if (!def) return null;
  const x = def.preco(lerContas(bp, dre, periodo, dias), alvo);
  return x === null ? null : { brl: x, alavanca: def.alavanca };
}

// ───────────────────────────────────────────────────────────────────────────
// Períodos
// ───────────────────────────────────────────────────────────────────────────

function ordPeriodo(p: string): number {
  const m = p.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return Number(`${m[3]}${m[2]}${m[1]}`);
  const y = p.match(/20\d{2}/);
  return y ? Number(`${y[0]}0000`) : 0;
}

function mesAnoDe(p: string): { mes: number; ano: number } | null {
  const m = p.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return { mes: Number(m[2]), ano: Number(m[3]) };
  const y = p.match(/^\s*(20\d{2})\s*$/);
  return y ? { mes: 12, ano: Number(y[1]) } : null;
}

/**
 * A REFERÊNCIA COMPARÁVEL DA PRÓPRIA SÉRIE, segregada por natureza.
 *
 * Saldo×saldo (liquidez, endividamento, imobilização) compara com QUALQUER coluna
 * anterior — são fotos da mesma data-base. Fluxo (margens, prazos, cobertura) só
 * compara com uma coluna da MESMA JANELA: um acumulado de 5 meses contra um
 * exercício fechado erra a base em 2,4×, e foi assim que "/365 num período de 150
 * dias" já inventou número neste produto. Sem par comparável, o sinal de fluxo
 * não é elegível na camada própria — e não vira "Baixa".
 */
export function referenciaPropria(
  natureza: NaturezaSinal, periodo: string, periodos: string[], periodosYTD: string[],
): string | null {
  const ord = [...new Set(periodos)].sort((a, b) => ordPeriodo(a) - ordPeriodo(b));
  const i = ord.indexOf(periodo);
  if (i <= 0) return null;
  if (natureza === "saldo") return ord[i - 1] ?? null;

  const ytd = new Set(periodosYTD);
  const meuMes = mesAnoDe(periodo);
  const ehParcial = (c: string): boolean => {
    const mm = mesAnoDe(c);
    return ytd.has(c) && mm !== null && mm.mes < 12;
  };
  if (!ehParcial(periodo)) {
    for (let k = i - 1; k >= 0; k--) {
      const cand = ord[k]!;
      if (!ehParcial(cand)) return cand;
    }
    return null;
  }
  // Coluna parcial: só o MESMO MÊS de um ano anterior tem a mesma janela.
  for (let k = i - 1; k >= 0; k--) {
    const cand = ord[k]!;
    const mm = mesAnoDe(cand);
    if (mm && meuMes && mm.mes === meuMes.mes && mm.ano < meuMes.ano) return cand;
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Formatação da memória (prosa auditável)
// ───────────────────────────────────────────────────────────────────────────

const brl = (v: number): string => {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `R$ ${(a / 1_000_000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${a >= 2_000_000 ? "milhões" : "milhão"}`;
  if (a >= 1_000) return `R$ ${Math.round(a / 1_000).toLocaleString("pt-BR")} mil`;
  return `R$ ${Math.round(a).toLocaleString("pt-BR")}`;
};

/**
 * PERÍODO COMO O DONO PEDIU (14/08/2026): mm/aaaa, ou só o ano quando fecha em
 * dezembro. "31/05/2026" é data de fechamento contábil e não aparece em texto
 * que o cliente lê — a mesma régua que o app aplica na capa (services/periodo.ts).
 * Aqui, na origem: quem escreve a frase é o motor, então é o motor que formata.
 */
export function rotuloPeriodo(p: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(p.trim());
  if (!m) return p.trim();
  const [, , mes, ano] = m;
  return mes === "12" ? ano! : `${mes}/${ano}`;
}

export function fmtPorTipoDado(v: number, tipoDado: string | undefined): string {
  switch (tipoDado) {
    case "%": return `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
    case "Dias": return `${Math.round(v).toLocaleString("pt-BR")} dias`;
    case "R$": return brl(v);
    default: return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Covenant — o contrato, e o silêncio que ele produzia no distress
// ───────────────────────────────────────────────────────────────────────────

export interface CovenantParaPrioridade { name: string; metric: string; operator: string; threshold: number }

/** MESMA régua da aba Covenants e do card de decisão (breach / amber a 10%). */
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

// ───────────────────────────────────────────────────────────────────────────
// A AGENDA
// ───────────────────────────────────────────────────────────────────────────

export interface IndicadorParaPrioridade {
  nome: string;
  valores: Record<string, number | string | null>;
  tipoDado?: string;
}

export interface EntradaAgenda {
  indicadores: IndicadorParaPrioridade[];
  periodos: string[];
  periodo: string;
  bp: BPLineItem[];
  dre: DRELineItem[];
  /** Colunas de balancete (DRE acumulada no ano). */
  periodosYTD?: string[];
  /** Dias-base do período. OMITA em produção: a agenda deriva pela mesma régua do
   *  motor de indicadores (`diasBaseDe`). O parâmetro existe para a bancada poder
   *  provar um valor específico — passar um número à mão em produção foi
   *  exatamente como as duas réguas divergiram. */
  diasDoPeriodo?: number;
  pares?: PeerComparisonRow[] | null;
  paresSegmento?: string | null;
  paresPeriodo?: string | null;
  covenants?: CovenantParaPrioridade[] | null;
  /** Nome do indicador que cada covenant mede, já resolvido pelo chamador (mesmo
   *  alias do card de covenants — duas telas não podem discordar do contrato). */
  resolverMetricaCovenant?: (metric: string) => string;
}

/** O motor grava esta STRING quando o múltiplo não tem base de cálculo (EBITDA
 *  ≤ 0). É a única marca de "não mensurável" — qualquer outro texto é medida. */
const NAO_MENSURAVEL = "N/M";

/**
 * O `name` do covenant é texto livre do analista: dois contratos podem se chamar
 * "Alavancagem" (Banco A ≤ 3,0 e Banco B ≤ 2,5). Com id colidido a IA não tem
 * como amarrar uma ação a cada um, e o parse descarta a segunda — perdendo a
 * camada de MAIOR precedência do desenho.
 *
 * O sufixo é escolhido contra o CONJUNTO DE IDS JÁ USADOS, não por contagem de
 * prefixo. A versão por contagem quebrava um caso que antes funcionava: um
 * covenant chamado "Alavancagem 2" gera a raiz `covenant:alavancagem-2`, que é
 * exatamente o sufixo que o "Alavancagem" seguinte receberia — os dois saíam com
 * o mesmo id, regressão medida.
 */
function idCovenant(nome: string, usados: Set<string>): string {
  const raiz = idDe("covenant", nome);
  let id = raiz;
  let n = 1;
  while (usados.has(id)) { n++; id = `${raiz}-${n}`; }
  usados.add(id);
  return id;
}

const idDe = (prefixo: string, nome: string): string =>
  `${prefixo}:${nome.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function montarAgenda(e: EntradaAgenda): AgendaPrioridade {
  const { indicadores, periodos, periodo, bp, dre } = e;
  const periodosYTD = e.periodosYTD ?? [];
  const dias = e.diasDoPeriodo ?? diasBaseDe(periodo, periodos, periodosYTD);
  const contas = lerContas(bp, dre, periodo, dias);
  const lacunas: string[] = [];

  // Um indicador por NOME: "Margem Líquida" aparece duas vezes no template (em
  // Margens e em Rentabilidade) e um placar por nome pesaria o sinal em dobro.
  const porNome = new Map<string, IndicadorParaPrioridade>();
  for (const ind of indicadores) if (!porNome.has(ind.nome)) porNome.set(ind.nome, ind);

  // ─── CAMADA 1 · CONTRATO ───────────────────────────────────────────────
  const contratuais: SinalPriorizado[] = [];
  const idsUsados = new Set<string>();
  const covenants = e.covenants ?? [];
  const resolver = e.resolverMetricaCovenant ?? ((m: string) => (m ?? "").toLowerCase().trim());
  for (const c of covenants) {
    const nomeAlvo = resolver(c.metric);
    const ind = [...porNome.values()].find((i) => i.nome.toLowerCase().trim() === nomeAlvo);
    if (!ind) { lacunas.push(`O covenant "${c.name}" não pôde ser verificado: o indicador que ele mede não é calculado a partir dos documentos desta análise.`); continue; }
    const bruto = ind.valores[periodo];
    const atual = numOf(bruto);
    const rotuloLimite = `limite contratual ${c.operator} ${fmtPorTipoDado(c.threshold, ind.tipoDado)}`;

    // O COVENANT SUMIA EXATAMENTE NO DISTRESS. Com EBITDA ≤ 0 o motor grava a
    // STRING "N/M" em Dívida Líquida/EBITDA — a pergunta "quantos anos de geração
    // pagam a dívida" não existe sem geração. O card jogava o covenant em "não
    // verificáveis" e a página publicava "nenhum covenant pôde ser verificado":
    // silêncio, na empresa que o credor mais cobra. Não mensurável POR AUSÊNCIA
    // DE GERAÇÃO é afirmação equivalente à quebra, e é assim que entra aqui.
    //
    // SÓ "N/M", e nenhuma outra string. Nem todo texto no lugar do número é
    // ausência de geração: "Situação de Liquidez (Fleuriet)" devolve "Sólida",
    // "Muito Ruim", "Alto Risco" — que são MEDIDAS, não lacunas. Testado, o ramo
    // aberto a qualquer string publicava para o credor "o indicador não é
    // mensurável (Muito Ruim), porque não há geração operacional", liderando a
    // agenda com uma causa inventada. Covenant sobre indicador de texto é
    // legítimo, mas não é verificável por esta régua: vira lacuna declarada.
    if (atual === null) {
      const txt = typeof bruto === "string" ? bruto.trim() : "";
      if (txt === NAO_MENSURAVEL) {
        const ref: ReferenciaMedida = { tipo: "contrato", alvo: c.threshold, rotulo: rotuloLimite };
        contratuais.push({
          id: idCovenant(c.name, idsUsados), nome: c.name, natureza: "fluxo", valor: NaN,
          tipoDado: ind.tipoDado ?? "Índice",
          referencias: [ref], referenciaQueOrdena: ref,
          precoBRL: null, alavanca: ind.nome,
          memoria: `O covenant "${c.name}" exige ${ind.nome} ${c.operator} ${fmtPorTipoDado(c.threshold, ind.tipoDado)}. No período o indicador não é mensurável, porque não há geração operacional para servir de base de cálculo — o limite não pode ser atendido no período.`,
          nivelProva: "contratual", rotulo: "Alta", veredictoContrato: "nao-atendivel",
        });
      } else if (txt) {
        lacunas.push(`O covenant "${c.name}" é medido por ${ind.nome}, que no período vale "${txt}" — uma classificação, não um número. A verificação desse limite fica fora da ordem.`);
      } else {
        lacunas.push(`O covenant "${c.name}" não pôde ser verificado: o indicador que ele mede não tem valor no período.`);
      }
      continue;
    }
    const veredicto = avaliarCovenant(atual, c.operator, c.threshold);
    if (veredicto === "ok") continue;
    const def = PRECO_DO_SINAL[ind.nome];
    const preco = def ? def.preco(contas, c.threshold) : null;
    const ref: ReferenciaMedida = { tipo: "contrato", alvo: c.threshold, rotulo: rotuloLimite };
    contratuais.push({
      id: idCovenant(c.name, idsUsados), nome: c.name, natureza: def?.natureza ?? "fluxo", valor: atual,
      tipoDado: ind.tipoDado ?? "Índice",
      referencias: [ref], referenciaQueOrdena: ref,
      precoBRL: preco === null ? null : Math.abs(preco), alavanca: def?.alavanca ?? ind.nome,
      memoria: `O covenant "${c.name}" exige ${ind.nome} ${c.operator} ${fmtPorTipoDado(c.threshold, ind.tipoDado)} e o período fechou em ${fmtPorTipoDado(atual, ind.tipoDado)}`
        + (preco === null || def === undefined
          ? "."
          : `. Para voltar ao limite seria preciso ${preco > 0 ? "aumentar" : "reduzir"} ${brl(preco)} em ${def.alavanca}.`),
      nivelProva: "contratual", rotulo: veredicto === "breach" ? "Alta" : "Média",
      veredictoContrato: veredicto,
    });
  }
  if (covenants.length === 0) lacunas.push("Não há covenant cadastrado nesta análise, então nenhuma exigência contratual do credor entra na ordem.");

  // ─── CAMADAS 2 e 3 · PARES E PRÓPRIA SÉRIE ─────────────────────────────
  const pares = e.pares ?? [];
  const paresPorNome = new Map(pares.map((r) => [r.indicador, r]));
  const paresUsaveis = pares.filter((r) => r.count >= MIN_PARES_PARA_ORDENAR);
  if (pares.length === 0) {
    lacunas.push("Não há empresas comparáveis disponíveis para este segmento, então a comparação setorial não entra na ordem.");
  } else if (paresUsaveis.length === 0) {
    lacunas.push(`Há menos de ${MIN_PARES_PARA_ORDENAR} empresas comparáveis para este segmento, e com essa amostra a mediana do setor não sustenta uma ordem: a comparação setorial fica de fora.`);
  }

  const medidos: SinalPriorizado[] = [];
  const fluxoSemJanela: string[] = [];
  let avaliados = 0;

  for (const [nome, ind] of porNome) {
    const def = PRECO_DO_SINAL[nome];
    if (!def) continue;
    avaliados++;
    const atual = numOf(ind.valores[periodo]);
    if (atual === null) continue;

    const refs: ReferenciaMedida[] = [];

    // Camada 2 — pares
    const linha = paresPorNome.get(nome);
    if (linha && linha.count >= MIN_PARES_PARA_ORDENAR) {
      const pior = def.maiorEhPior ? atual > linha.p50 : atual < linha.p50;
      if (pior) {
        const seg = e.paresSegmento ? ` de ${e.paresSegmento}` : "";
        const quando = e.paresPeriodo ? ` @ ${e.paresPeriodo}` : "";
        refs.push({
          tipo: "pares", alvo: linha.p50,
          rotulo: `mediana de ${linha.count} pares${seg}${quando} (${fmtPorTipoDado(linha.p50, ind.tipoDado)})`,
        });
      }
    }

    // Camada 3 — própria série, com janela comparável
    const anterior = referenciaPropria(def.natureza, periodo, periodos, periodosYTD);
    const vAnt = anterior ? numOf(ind.valores[anterior]) : null;
    if (anterior && vAnt !== null) {
      const pior = def.maiorEhPior ? atual > vAnt : atual < vAnt;
      if (pior) refs.push({ tipo: "propria", alvo: vAnt, rotulo: `nível de ${rotuloPeriodo(anterior)} (${fmtPorTipoDado(vAnt, ind.tipoDado)})` });
    } else if (def.natureza === "fluxo" && anterior === null && refs.length === 0) {
      // MEDIDO na Belagro: com o período em balancete acumulado de 5 meses e sem
      // a mesma janela de um ano anterior na série, TODOS os sinais de resultado
      // (margens, prazos, cobertura) ficam sem referência comparável — e a agenda
      // sai só com endividamento e liquidez. A omissão é correta (comparar 5 meses
      // com um exercício fechado erra a base em 2,4×), mas silenciosa ela faz o
      // leitor concluir que a margem não é problema. Vai declarada.
      fluxoSemJanela.push(nome);
    }

    if (refs.length === 0) continue;

    // Ordena pela referência de MAIOR PRECEDÊNCIA disponível (pares antes da própria).
    const ordena = refs.find((r) => r.tipo === "pares") ?? refs[0]!;
    const preco = def.preco(contas, ordena.alvo);
    const nivel: NivelProva = refs.length >= 2 ? "duas-fontes" : "uma-fonte";
    medidos.push({
      id: idDe(refs.length >= 2 ? "sinal" : ordena.tipo === "pares" ? "pares" : "traj", nome),
      nome, natureza: def.natureza, valor: atual, tipoDado: ind.tipoDado ?? "Índice",
      referencias: refs, referenciaQueOrdena: ordena,
      precoBRL: preco === null ? null : Math.abs(preco),
      alavanca: def.alavanca,
      memoria: `${nome} está em ${fmtPorTipoDado(atual, ind.tipoDado)} contra ${ordena.rotulo}`
        + (preco === null
          ? ". O preço de voltar não é calculável nesta base."
          : `. Para voltar a esse nível seria preciso ${preco > 0 ? "aumentar" : "reduzir"} ${brl(preco)} em ${def.alavanca}, mantendo o outro lado da conta parado.`)
        + (refs.length >= 2 ? " Duas referências independentes apontam o mesmo sinal." : ""),
      nivelProva: nivel,
      rotulo: nivel === "duas-fontes" ? "Alta" : "Média",
    });
  }

  // ─── ORDEM ─────────────────────────────────────────────────────────────
  // Dentro de cada bloco, o PREÇO EM R$ ordena. O desempate por nome existe só
  // para a ordem ser estável entre regerações — nunca para eleger o primeiro.
  const pesoBloco: Record<NivelProva, number> = { contratual: 0, "duas-fontes": 1, "uma-fonte": 2, "sem-medida": 3 };
  const pesoVeredicto = (s: SinalPriorizado): number =>
    s.veredictoContrato === "breach" || s.veredictoContrato === "nao-atendivel" ? 0 : 1;
  const ordenar = (a: SinalPriorizado, b: SinalPriorizado): number => {
    const bl = pesoBloco[a.nivelProva] - pesoBloco[b.nivelProva];
    if (bl !== 0) return bl;
    if (a.nivelProva === "contratual") {
      const vv = pesoVeredicto(a) - pesoVeredicto(b);
      if (vv !== 0) return vv;
    }
    const pa = a.precoBRL, pb = b.precoBRL;
    if (pa !== null && pb !== null && pa !== pb) return pb - pa;
    if (pa !== null && pb === null) return -1;
    if (pa === null && pb !== null) return 1;
    return a.nome.localeCompare(b.nome, "pt-BR");
  };
  const sinais = [...contratuais, ...medidos].sort(ordenar);

  // ─── TRAVA DE DISCRIMINAÇÃO ────────────────────────────────────────────
  // Cobertura e discriminação são coisas diferentes. "uma fonte" em todas as
  // linhas é verdadeiro e inútil se o preço empatou em todas: aí o topo do plano
  // do credor teria sido eleito pelo alfabeto, com selo de método.
  const primeiro = sinais[0];
  const doBloco = primeiro ? sinais.filter((s) => s.nivelProva === primeiro.nivelProva) : [];
  const discriminou = !primeiro
    ? false
    : primeiro.nivelProva === "contratual"
    ? true
    : doBloco.length === 1
    ? primeiro.precoBRL !== null
    : primeiro.precoBRL !== null && primeiro.precoBRL !== doBloco[1]!.precoBRL;

  const eixo = !primeiro
    ? "nenhum sinal medido"
    : primeiro.nivelProva === "contratual"
    ? "limite contratual do credor, depois o preço em R$ de voltar ao limite"
    : "preço em R$ de voltar à referência medida, dentro de cada nível de prova";

  if (fluxoSemJanela.length > 0) {
    // A CAUSA É MEDIDA, NÃO PRESUMIDA. A primeira versão afirmava "acumulado
    // parcial" sempre — e num IBR de um único exercício fechado o relatório dizia
    // ao credor que 2025 era um ano incompleto. Duas causas diferentes, e a que
    // vale depende do próprio período.
    const mm = mesAnoDe(periodo);
    const ehParcial = periodosYTD.includes(periodo) && mm !== null && mm.mes < 12;
    const causa = ehParcial
      ? `${rotuloPeriodo(periodo)} cobre parte do ano e a série não traz o mesmo intervalo de um ano anterior`
      : `não há na série um período anterior de mesma duração para comparar com ${rotuloPeriodo(periodo)}`;
    lacunas.push(
      `Os indicadores de resultado (${fluxoSemJanela.slice(0, 4).join(", ")}${fluxoSemJanela.length > 4 ? " e outros" : ""}) `
      + `ficaram fora da ordem porque ${causa}. Estão diagnosticados no relatório, mas não entram na prioridade.`,
    );
  }
  if (!discriminou && sinais.length > 0) {
    lacunas.push("Nenhuma referência separou os sinais entre si: a ordem é sequência sugerida, não prioridade medida.");
  }

  return { periodo, sinais, discriminou, eixo, lacunas, cobertura: { medidos: sinais.length, avaliados } };
}

/**
 * A AGENDA COMO O MOTOR MANDA PARA A IA — lista FECHADA e já ordenada.
 *
 * A IA não escolhe a prioridade nem o vínculo: recebe a ordem pronta e REDIGE
 * cada item. É o que sobrevive a um credor perguntando "por que isto está em
 * primeiro?" — a resposta é uma conta, não uma opinião.
 */
export function agendaParaPrompt(a: AgendaPrioridade): string {
  if (a.sinais.length === 0) {
    return `\nAGENDA DO MOTOR — VAZIA: nenhum sinal desta empresa tem referência medida no período. ${a.lacunas.join(" ")}\nNÃO invente prioridade: escreva as recomendações sem ordenação declarada e OMITA o campo sinalId.`;
  }
  const linhas = a.sinais.map((s, i) =>
    `${i + 1}. sinalId="${s.id}"${a.discriminou && s.rotulo ? ` · prioridade ${s.rotulo}` : ""} · ${s.memoria}`,
  );
  return `
AGENDA DO MOTOR — ORDEM JÁ DEFINIDA (fatos calculados; NÃO reordene, NÃO reclassifique, NÃO invente prioridade):
${linhas.join("\n")}
Eixo que ordenou: ${a.eixo}.${a.lacunas.length ? `\nLacunas declaradas: ${a.lacunas.join(" ")}` : ""}
Cada recomendação do plano ataca UM item desta lista e declara o sinalId EXATO, copiado caractere a caractere. sinalId fora da lista é DESCARTADO — não existe valor padrão. No máximo uma recomendação por sinalId, na ordem acima.`;
}
