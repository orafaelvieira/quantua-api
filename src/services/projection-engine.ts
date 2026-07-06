/**
 * Projection Engine — computa projeção de 12 meses de DRE/BP a partir de:
 *   - dadosEstruturados (BP + DRE históricos)
 *   - stcf (13 semanas)
 *   - scenario (multiplicadores)
 *   - sectorPremises (benchmarks)
 *
 * Função pura. Sem side-effects, sem I/O. Recebe inputs, retorna 12 ProjectionMonth.
 *
 * Heurísticas (MVP funcional):
 * - Receita projetada = ult_receita_mensal × (1 + growth_anual^(1/12)) × scenario.revenueMultiplier
 * - CMV = receita × (1 − margem_bruta_sustentavel) × scenario.cogsMultiplier
 * - OpEx = média histórica × scenario.opexMultiplier × inflação 4.5%aa
 * - Working Capital: DSO_aplicado = DSO_atual + scenario.dsoDeltaDays
 * - Caixa: parte do closing das 13 semanas do STCF, depois propaga
 * - Dívida: amortização linear pela mediana do "Serviço da dívida" no STCF
 * - PL: PL_anterior + lucro_líquido_mês
 *
 * Confiança: alta (mês 1-3), média (mês 4-6), baixa (mês 7-12).
 */

import { getSectorPremises, SectorPremises } from "./sector-premises";

export interface ProjectionMonth {
  mes: string;             // "Jul/2026"
  dre: {
    receita: number;
    cmv: number;
    lucroBruto: number;
    opex: number;
    ebitda: number;
    depreciacao: number;
    ebit: number;
    resultadoFinanceiro: number;
    lair: number;
    ir: number;
    lucroLiq: number;
  };
  bp: {
    caixa: number;
    recebiveis: number;
    estoques: number;
    ativoTotal: number;
    fornecedores: number;
    dividaCP: number;
    dividaLP: number;
    pl: number;
  };
  premissas: {
    receitaGrowth: number;
    margemBruta: number;
    dsoTarget: number;
    capexPctReceita: number;
    custoMedioDivida: number;
  };
  confianca: "alta" | "media" | "baixa";
}

export interface ProjectionInput {
  dadosEstruturados: any;
  stcf: any;
  scenario: {
    kind: string;
    assumptions: {
      revenueMultiplier: number;
      cogsMultiplier: number;
      opexMultiplier: number;
      dsoDeltaDays: number;
      dpoDeltaDays: number;
      dioDeltaDays: number;
    };
  };
  /**
   * Premissas resolvidas pelo caller (preferido — passa por `resolveSectorPremises`
   * do sector-benchmark service, que faz lookup async no DB).
   * Quando não fornecido, engine cai no path legado abaixo (`setor` substring match).
   */
  premises?: SectorPremises;
  /**
   * @deprecated Path legado: substring match contra sector-premises.ts hardcoded.
   * Mantido pra back-compat e pra fixtures de teste. Em prod o caller deve
   * setar `premises` explicitamente via `resolveSectorPremises`.
   */
  setor?: string | null;
  startMonth: Date;
}

const MONTH_NAMES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

function fmtMes(d: Date): string {
  const yy = String(d.getFullYear()).slice(2);
  return `${MONTH_NAMES[d.getMonth()]}/${yy}`;
}

function lastValueOf(obj: Record<string, number> | undefined, periodos: string[]): number {
  if (!obj) return 0;
  for (let i = periodos.length - 1; i >= 0; i--) {
    const v = obj[periodos[i]];
    if (typeof v === "number") return v;
  }
  return 0;
}

interface LineWithValores {
  conta: string;
  valores?: Record<string, number>;
}

function findLine(lines: LineWithValores[] | undefined, accountSubstr: string): LineWithValores | undefined {
  if (!lines) return undefined;
  const lower = accountSubstr.toLowerCase();
  return lines.find((l) => l.conta?.toLowerCase().includes(lower));
}

/** Match EXATO por nome (case/trim-insensitive) — para subtotais cujo nome é prefixo/
 *  substring de outras linhas ("Lucro Bruto", "EBITDA"), onde o findLine por substring
 *  poderia casar uma linha custom errada. */
function findLineExact(lines: LineWithValores[] | undefined, conta: string): LineWithValores | undefined {
  if (!lines) return undefined;
  const alvo = conta.trim().toLowerCase();
  return lines.find((l) => l.conta?.trim().toLowerCase() === alvo);
}

/** Linhas de despesa operacional do DRE_TEMPLATE (o bloco entre Lucro Bruto e EBITDA) —
 *  usadas no fallback quando a DRE não traz os subtotais. */
const OPEX_LINHAS_MODELO = [
  "Despesas Gerais e Administrativas",
  "Despesas com Vendas",
  "Despesas com Marketing",
  "Despesas com P&D",
  "Outras Receitas Operacionais",
  "Outras Despesas Operacionais",
];

/** OpEx histórico ANUAL (positivo = despesa líquida).
 *
 *  O modelo de DRE NÃO tem linha agregada "Despesas Operacionais" (as despesas são
 *  detalhadas: Gerais e Adm., Vendas, Marketing, P&D, Outras). O findLine antigo, por
 *  substring, achava só "OUTRAS Despesas Operacionais" (a sobra) → a base de OpEx virava
 *  fração do real e a projeção saía com lucro/caixa inflados. Derivação robusta a
 *  QUALQUER estrutura (inclui contas custom que pesam no EBITDA via extrasPorBloco):
 *    OpEx líquido = Lucro Bruto − EBITDA   (o bloco entre os dois subtotais).
 *  Fallbacks, nesta ordem: soma das linhas de despesa do modelo; por último, a linha
 *  agregada "Despesas Operacionais" (DREs legadas), que era o comportamento antigo. */
function opexAnualHistDe(dreLines: LineWithValores[], periodos: string[]): number {
  const lbLinha = findLineExact(dreLines, "Lucro Bruto");
  const ebitdaLinha = findLineExact(dreLines, "EBITDA");
  const lbVal = lastValueOf(lbLinha?.valores, periodos);
  const ebitdaVal = lastValueOf(ebitdaLinha?.valores, periodos);
  if (lbLinha && ebitdaLinha && (lbVal !== 0 || ebitdaVal !== 0)) {
    return Math.max(0, lbVal - ebitdaVal); // net-receita-op > despesas → OpEx 0, nunca negativo
  }
  const linhas = OPEX_LINHAS_MODELO
    .map((c) => findLineExact(dreLines, c))
    .filter((l): l is LineWithValores => !!l);
  if (linhas.length) {
    return Math.max(0, -linhas.reduce((s, l) => s + lastValueOf(l.valores, periodos), 0));
  }
  return Math.abs(lastValueOf(findLine(dreLines, "Despesas Operacionais")?.valores, periodos));
}

export function computeProjections(input: ProjectionInput): ProjectionMonth[] {
  const premises: SectorPremises = input.premises ?? getSectorPremises(input.setor ?? null);
  const { dadosEstruturados, stcf, scenario, startMonth } = input;
  const periodos: string[] = dadosEstruturados?.periodos ?? [];
  const bpLines = dadosEstruturados?.bp ?? [];
  const dreLines = dadosEstruturados?.dre ?? [];

  // ── Bases históricas (último período) ──
  const ultReceitaAnual = Math.abs(lastValueOf(findLine(dreLines, "Receita Líquida")?.valores, periodos));
  const receitaMensalBase = ultReceitaAnual / 12 || 1_000_000; // fallback

  const margemBrutaHist = (lastValueOf(findLine(dreLines, "Lucro Bruto")?.valores, periodos) /
    (ultReceitaAnual || 1)) || premises.margemBruta;
  const margemBrutaAplicada = premises.margemBruta * 0.7 + margemBrutaHist * 0.3; // pondera setor + hist

  const opexMensalHist = opexAnualHistDe(dreLines, periodos) / 12;
  const depMensalHist = Math.abs(lastValueOf(findLine(dreLines, "Depreciação")?.valores, periodos)) / 12;

  const dividaCPInicial = lastValueOf(findLine(bpLines, "Empréstimos e Financiamentos - CP")?.valores, periodos);
  const dividaLPInicial = lastValueOf(findLine(bpLines, "Empréstimos e Financiamentos - LP")?.valores, periodos);
  const fornInicial = lastValueOf(findLine(bpLines, "Fornecedores - CP")?.valores, periodos);
  const estoquesInicial = lastValueOf(findLine(bpLines, "Estoques - CP")?.valores, periodos);
  const ativoTotalInicial = lastValueOf(findLine(bpLines, "Ativo Total")?.valores, periodos);
  const plInicial = lastValueOf(findLine(bpLines, "Patrimônio Líquido")?.valores, periodos);

  // Caixa: usar fechamento da última semana do STCF se disponível, senão BP histórico
  const stcfWeeks = stcf?.weeks ?? [];
  const caixaInicial = stcfWeeks.length > 0
    ? stcfWeeks[stcfWeeks.length - 1].closingCash
    : lastValueOf(findLine(bpLines, "Caixa")?.valores, periodos);

  // Amortização mensal: extrair da mediana do "Serviço da dívida" no STCF (semanais) × 4.3
  const servDividaSemanal = stcfWeeks
    .map((w: any) => (w.outflows ?? []).find((o: any) => o.category?.includes("dívida"))?.amount ?? 0)
    .sort((a: number, b: number) => a - b);
  const medianaSerivDivida = servDividaSemanal.length > 0
    ? servDividaSemanal[Math.floor(servDividaSemanal.length / 2)]
    : 0;
  const amortMensal = medianaSerivDivida * 4.3;

  // Aplicar deltas de WC do cenário
  const dsoBase = premises.dsoTarget;
  const dsoAplicado = dsoBase + scenario.assumptions.dsoDeltaDays;

  // ── Loop dos 12 meses ──
  const months: ProjectionMonth[] = [];
  let caixaAtual = caixaInicial;
  let plAtual = plInicial;
  let dividaCPAtual = dividaCPInicial;
  let dividaLPAtual = dividaLPInicial;

  const growthMonthly = Math.pow(1 + premises.receitaGrowth, 1 / 12) - 1;
  const inflacaoMonthly = Math.pow(1 + 0.045, 1 / 12) - 1;

  for (let i = 0; i < 12; i++) {
    const dt = new Date(startMonth);
    dt.setMonth(dt.getMonth() + i);

    // Receita: cresce mês a mês com growth setorial × scenario.revenueMultiplier
    const receita = receitaMensalBase * Math.pow(1 + growthMonthly, i + 1) * scenario.assumptions.revenueMultiplier;
    const cmv = -receita * (1 - margemBrutaAplicada) * scenario.assumptions.cogsMultiplier;
    const lucroBruto = receita + cmv;
    const opex = -opexMensalHist * scenario.assumptions.opexMultiplier * Math.pow(1 + inflacaoMonthly, i);
    const ebitda = lucroBruto + opex;
    const depreciacao = -depMensalHist;
    const ebit = ebitda + depreciacao;
    const custoDivMensal = (dividaCPAtual + dividaLPAtual) * (premises.custoMedioDivida / 12);
    const resultadoFinanceiro = -custoDivMensal;
    const lair = ebit + resultadoFinanceiro;
    const ir = lair > 0 ? -lair * 0.25 : 0;
    const lucroLiq = lair + ir;

    // BP rolling
    const recebiveis = (receita * dsoAplicado) / 30;
    const estoques = estoquesInicial * Math.pow(1 + growthMonthly * 0.5, i); // estoque acompanha receita parcial
    const fornecedores = fornInicial * (1 + scenario.assumptions.dpoDeltaDays / 30);

    // Amortização da dívida: prioriza CP, depois LP
    let amortRestante = amortMensal;
    if (dividaCPAtual >= amortRestante) {
      dividaCPAtual = Math.max(0, dividaCPAtual - amortRestante);
    } else {
      amortRestante -= dividaCPAtual;
      dividaCPAtual = 0;
      dividaLPAtual = Math.max(0, dividaLPAtual - amortRestante);
    }

    // Caixa: caixa anterior + EBITDA (proxy de geração) − amortização − impostos
    const capex = receita * premises.capexPctReceita;
    const fluxoMes = ebitda + ir - amortMensal - capex;
    caixaAtual = caixaAtual + fluxoMes;

    const ativoTotal = caixaAtual + recebiveis + estoques + Math.max(0, ativoTotalInicial - (recebiveis + estoques + caixaInicial));
    plAtual = plAtual + lucroLiq;

    let confianca: "alta" | "media" | "baixa";
    if (i < 3) confianca = "alta";
    else if (i < 6) confianca = "media";
    else confianca = "baixa";

    months.push({
      mes: fmtMes(dt),
      dre: {
        receita: Math.round(receita),
        cmv: Math.round(cmv),
        lucroBruto: Math.round(lucroBruto),
        opex: Math.round(opex),
        ebitda: Math.round(ebitda),
        depreciacao: Math.round(depreciacao),
        ebit: Math.round(ebit),
        resultadoFinanceiro: Math.round(resultadoFinanceiro),
        lair: Math.round(lair),
        ir: Math.round(ir),
        lucroLiq: Math.round(lucroLiq),
      },
      bp: {
        caixa: Math.round(caixaAtual),
        recebiveis: Math.round(recebiveis),
        estoques: Math.round(estoques),
        ativoTotal: Math.round(ativoTotal),
        fornecedores: Math.round(fornecedores),
        dividaCP: Math.round(dividaCPAtual),
        dividaLP: Math.round(dividaLPAtual),
        pl: Math.round(plAtual),
      },
      premissas: {
        receitaGrowth: premises.receitaGrowth,
        margemBruta: margemBrutaAplicada,
        dsoTarget: dsoAplicado,
        capexPctReceita: premises.capexPctReceita,
        custoMedioDivida: premises.custoMedioDivida,
      },
      confianca,
    });
  }

  return months;
}
