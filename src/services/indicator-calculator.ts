import type { BPLineItem, DRELineItem, Indicador } from "../types/financial";
import { INDICADORES_TEMPLATE } from "./financial-templates";

// Helper to find a BP value by conta name
function bpVal(bp: BPLineItem[], conta: string, periodo: string): number {
  const item = bp.find(b => b.conta === conta);
  return item?.valores[periodo] ?? 0;
}

// Helper to sum BP values by classificacao
function bpByClass(bp: BPLineItem[], classificacao: string, periodo: string): number {
  return bp
    .filter(b => b.classificacao === classificacao)
    .reduce((sum, b) => sum + (b.valores[periodo] ?? 0), 0);
}

// Helper to find a DRE value by conta name
function dreVal(dre: DRELineItem[], conta: string, periodo: string): number {
  const item = dre.find(d => d.conta === conta);
  return item?.valores[periodo] ?? 0;
}

// Safe division — returns null on divide by zero
function div(a: number, b: number): number | null {
  if (b === 0) return null;
  return a / b;
}

type StatusLevel = "ok" | "atencao" | "critico" | null;

/** Semáforo DECLARATIVO (editável na tela "Indicadores" — a tabela IndicatorConfig
 *  sobrepõe estes defaults). direcao "menor_ruim": crítico se v < critico, atenção se
 *  v < atencao. "maior_ruim": crítico se v > critico, atenção se v > atencao. */
export interface SemaforoDef { direcao: "menor_ruim" | "maior_ruim"; critico: number; atencao: number }

export const SEMAFORO_DEFAULTS: Record<string, SemaforoDef> = {
  "Liquidez Imediata": { direcao: "menor_ruim", critico: 0.2, atencao: 0.5 },
  "Liquidez Seca": { direcao: "menor_ruim", critico: 0.7, atencao: 1.0 },
  "Liquidez Corrente": { direcao: "menor_ruim", critico: 1.0, atencao: 1.5 },
  "Liquidez Geral": { direcao: "menor_ruim", critico: 0.8, atencao: 1.2 },
  "Margem Bruta": { direcao: "menor_ruim", critico: 0.10, atencao: 0.30 },
  "Margem Operacional": { direcao: "menor_ruim", critico: 0, atencao: 0.05 },
  "Margem Líquida": { direcao: "menor_ruim", critico: 0, atencao: 0.05 },
  "Endividamento Geral": { direcao: "maior_ruim", critico: 0.80, atencao: 0.50 },
  "Endividamento de Curto Prazo": { direcao: "maior_ruim", critico: 0.70, atencao: 0.50 },
  "ROA (Retorno sobre Ativos)": { direcao: "menor_ruim", critico: 0, atencao: 0.05 },
  "ROIC (Retorno sobre Capital Investido)": { direcao: "menor_ruim", critico: 0, atencao: 0.08 },
  "ROE (Retorno sobre Patrimônio Líquido)": { direcao: "menor_ruim", critico: 0, atencao: 0.10 },
  "Índice de Cobertura de Juros": { direcao: "menor_ruim", critico: 1.5, atencao: 3.0 },
  "Capital Terceiros s/ PL": { direcao: "maior_ruim", critico: 2.0, atencao: 1.0 },
  "Despesa Financeira / Rec. Líquida": { direcao: "maior_ruim", critico: 0.10, atencao: 0.05 },
  // Kanitz: FI < −3 = risco de insolvência; −3 a 0 = penumbra; > 0 = solvente
  "Termômetro de Kanitz": { direcao: "menor_ruim", critico: -3, atencao: 0 },
};

export function statusPorSemaforo(def: SemaforoDef | undefined, value: number | null): StatusLevel {
  if (value === null || !def) return null;
  if (def.direcao === "maior_ruim") {
    if (value > def.critico) return "critico";
    if (value > def.atencao) return "atencao";
    return "ok";
  }
  if (value < def.critico) return "critico";
  if (value < def.atencao) return "atencao";
  return "ok";
}

function getStatus(nome: string, value: number | null, overrides?: Record<string, SemaforoDef>): StatusLevel {
  return statusPorSemaforo(overrides?.[nome] ?? SEMAFORO_DEFAULTS[nome], value);
}

function computeIndicator(
  nome: string,
  bp: BPLineItem[],
  dre: DRELineItem[],
  periodo: string,
  computed: Record<string, number | null>
): number | string | null {
  // BP values — Ativo (always positive)
  const ativoTotal = bpVal(bp, "Ativo Total", periodo);
  const ativoCirculante = bpVal(bp, "Ativo Circulante", periodo);
  const caixa = bpVal(bp, "Caixa e Equivalentes de Caixa", periodo);
  const contasReceber = bpVal(bp, "Contas a Receber - CP", periodo);
  const estoques = bpVal(bp, "Estoques - CP", periodo);
  const realizavelLP = bpVal(bp, "Realizável a Longo Prazo", periodo);

  // BP values — Passivo e PL: normalize signs (some accounting systems store these as negative)
  const passivoTotal = Math.abs(bpVal(bp, "Passivo Total", periodo));
  const passivoCirculante = Math.abs(bpVal(bp, "Passivo Circulante", periodo));
  const passivoNaoCirculante = Math.abs(bpVal(bp, "Passivo Não Circulante", periodo));
  const fornecedores = Math.abs(bpVal(bp, "Fornecedores - CP", periodo));
  const empFinCP = Math.abs(bpVal(bp, "Empréstimos e Financiamentos - CP", periodo));
  const passPartRelCP = Math.abs(bpVal(bp, "Passivos com Partes Relacionadas - CP", periodo));
  const empFinLP = Math.abs(bpVal(bp, "Empréstimos e Financiamentos - LP", periodo));
  const passPartRelLP = Math.abs(bpVal(bp, "Passivos com Partes Relacionadas - LP", periodo));
  const patrimonioLiquido = Math.abs(bpVal(bp, "Patrimônio Líquido", periodo));

  // Aggregated by classification (abs for Passivo side)
  const ativoOperacional = bpByClass(bp, "AO", periodo);
  const passivoOperacional = Math.abs(bpByClass(bp, "PO", periodo));

  // DRE raw values (modelo gerencial — Modelo_DRE.xlsx)
  const recBruta = dreVal(dre, "Receita Bruta", periodo);
  const deducoes = dreVal(dre, "Deduções da Receita Bruta", periodo);
  const impostosFat = dreVal(dre, "Impostos s/ Faturamento", periodo);
  const custoOp = dreVal(dre, "Custo Operacional", periodo);
  const despGerais = dreVal(dre, "Despesas Gerais e Administrativas", periodo);
  const despVendas = dreVal(dre, "Despesas com Vendas", periodo);
  const despMkt = dreVal(dre, "Despesas com Marketing", periodo);
  const despPD = dreVal(dre, "Despesas com P&D", periodo);
  const outrasRecOp = dreVal(dre, "Outras Receitas Operacionais", periodo);
  const outrasDespOp = dreVal(dre, "Outras Despesas Operacionais", periodo);
  const deprecAmort = dreVal(dre, "Depreciação e Amortização", periodo);
  const equivPat = dreVal(dre, "Equivalência Patrimonial", periodo);
  const receitasFinanceiras = dreVal(dre, "Receitas Financeiras", periodo);
  const despesasFinanceiras = dreVal(dre, "Despesas Financeiras", periodo);
  const outrasRecNaoOp = dreVal(dre, "Outras Receitas Não Operacionais", periodo);
  const outrasDespNaoOp = dreVal(dre, "Outras Despesas Não Operacionais", periodo);
  const irCsll = dreVal(dre, "IR e CSLL", periodo);

  // DRE computed subtotals (use o subtotal já presente no DRE; se ausente, calcula em cascata)
  const receitaLiquida = dreVal(dre, "Receita Líquida", periodo) || (recBruta + deducoes + impostosFat);
  const lucroBruto = dreVal(dre, "Lucro Bruto", periodo) || (receitaLiquida + custoOp);
  const ebitda = dreVal(dre, "EBITDA", periodo) ||
    (lucroBruto + despGerais + despVendas + despMkt + despPD + outrasRecOp + outrasDespOp);
  const ebit = dreVal(dre, "EBIT", periodo) || (ebitda + deprecAmort + equivPat);
  const resultadoFinanceiro = dreVal(dre, "Resultado Financeiro", periodo) || (receitasFinanceiras + despesasFinanceiras);
  const resultadoNaoOp = dreVal(dre, "Resultado Não Operacional", periodo) || (outrasRecNaoOp + outrasDespNaoOp);
  const resultadoAntesIR = dreVal(dre, "Resultado Antes do IR e CSLL", periodo) ||
    (ebit + resultadoFinanceiro + resultadoNaoOp);
  const lucroLiquido = dreVal(dre, "Lucro Líquido", periodo) || (resultadoAntesIR + irCsll);
  const custoOperacional = Math.abs(custoOp);

  // Computed intermediate values
  const capitalTerceiros = empFinCP + passPartRelCP + empFinLP + passPartRelLP;
  const caixaEquivalentes = caixa;
  const dividaLiquida = capitalTerceiros - caixaEquivalentes;
  const nopat = ebit * (1 - 0.34);
  const cdg = ativoCirculante - passivoCirculante;
  const ncg = ativoOperacional - passivoOperacional;

  // Store computed values for cross-reference
  computed["Receita Líquida"] = receitaLiquida;
  computed["Lucro Bruto"] = lucroBruto;
  computed["EBITDA"] = ebitda;
  computed["EBIT"] = ebit;
  computed["Lucro Operacional"] = ebit;
  computed["Lucro Líquido"] = lucroLiquido;
  computed["NOPAT"] = nopat;
  computed["Caixa e Equivalentes"] = caixaEquivalentes;
  computed["Capital de Terceiros"] = capitalTerceiros;
  computed["Dívida Líquida"] = dividaLiquida;
  computed["Capital de Giro (CDG)"] = cdg;
  computed["Necessidade de Capital de Giro (NCG)"] = ncg;

  switch (nome) {
    // Operacionais
    case "Receita Líquida": return receitaLiquida;
    case "Lucro Bruto": return lucroBruto;
    case "Lucro Operacional": return ebit;
    case "Lucro Líquido": return lucroLiquido;
    case "NOPAT": return nopat;

    // Margens
    case "Margem Bruta": return div(lucroBruto, receitaLiquida);
    case "Margem Operacional": return div(ebitda, receitaLiquida);
    case "Margem Líquida": return div(lucroLiquido, receitaLiquida);

    // Liquidez
    case "Liquidez Imediata": return div(caixa, passivoCirculante);
    case "Liquidez Seca": return div(ativoCirculante - estoques, passivoCirculante);
    case "Liquidez Corrente": return div(ativoCirculante, passivoCirculante);
    case "Liquidez Geral":
      return div(ativoCirculante + realizavelLP, passivoCirculante + passivoNaoCirculante);

    // Capital de Giro
    case "Capital de Giro (CDG)": return cdg;
    case "Necessidade de Capital de Giro (NCG)": return ncg;
    case "Saldo em Tesouraria (ST)": return cdg - ncg;
    case "Situação da empresa": {
      if (cdg > 0 && ncg > 0 && cdg > ncg) return "Sólida";
      if (cdg > 0 && ncg > 0 && cdg < ncg) return "Insuficiente";
      if (cdg < 0 && ncg < 0) return "Alto Risco";
      if (cdg > 0 && ncg < 0) return "Excelente";
      if (cdg < 0 && ncg > 0) return "Muito Ruim";
      return "Indefinida";
    }
    case "Prazo Médio Contas a Receber":
      return receitaLiquida ? Math.round((contasReceber * 365) / receitaLiquida) : null;
    case "Prazo Médio Estoque":
      return custoOperacional ? Math.round((estoques * 365) / custoOperacional) : null;
    case "Prazo Médio Fornecedores":
      return custoOperacional ? Math.round((fornecedores * 365) / custoOperacional) : null;
    case "Ciclo Financeiro": {
      const pmr = receitaLiquida ? Math.round((contasReceber * 365) / receitaLiquida) : null;
      const pme = custoOperacional ? Math.round((estoques * 365) / custoOperacional) : null;
      const pmf = custoOperacional ? Math.round((fornecedores * 365) / custoOperacional) : null;
      if (pmr !== null && pme !== null && pmf !== null) return pmr + pme - pmf;
      return null;
    }

    // Endividamento
    case "Caixa e Equivalentes": return caixaEquivalentes;
    case "Capital de Terceiros": return capitalTerceiros;
    case "Dívida Líquida": return dividaLiquida;
    case "Endividamento Geral": return div(passivoTotal - patrimonioLiquido, passivoTotal);
    case "Endividamento de Curto Prazo": return div(passivoCirculante, passivoTotal);
    case "Patrimônio Líquido": return patrimonioLiquido;
    case "Capital Terceiros s/ PL": return div(capitalTerceiros, patrimonioLiquido);
    case "Dívida Líquida/Lucro Operacional": return div(dividaLiquida, ebitda);
    case "Índice de Cobertura de Juros":
      return despesasFinanceiras !== 0 ? div(ebitda, Math.abs(despesasFinanceiras)) : null;
    case "Despesa Financeira / Rec. Líquida":
      return div(Math.abs(despesasFinanceiras), receitaLiquida);

    // Rentabilidade
    case "ROA (Retorno sobre Ativos)": return div(lucroLiquido, ativoTotal);
    case "ROIC (Retorno sobre Capital Investido)":
      return div(nopat, patrimonioLiquido + capitalTerceiros);

    // DuPont
    case "ROE (Retorno sobre Patrimônio Líquido)": return div(lucroLiquido, patrimonioLiquido);
    case "Giro do Ativo": return div(receitaLiquida, ativoTotal);
    case "Alavancagem": return div(passivoTotal, patrimonioLiquido);

    // Solvência — Termômetro de Kanitz (1978):
    //   FI = 0,05·(LL/PL) + 1,65·LG + 3,55·LS − 1,06·LC − 0,33·(Exigível/PL)
    //   FI > 0 solvente · 0 a −3 penumbra · < −3 risco de insolvência
    case "Termômetro de Kanitz": {
      const exigivelTotal = passivoCirculante + passivoNaoCirculante;
      const x1 = div(lucroLiquido, patrimonioLiquido);
      const x2 = div(ativoCirculante + realizavelLP, exigivelTotal);
      const x3 = div(ativoCirculante - estoques, passivoCirculante);
      const x4 = div(ativoCirculante, passivoCirculante);
      const x5 = div(exigivelTotal, patrimonioLiquido);
      if (x1 === null || x2 === null || x3 === null || x4 === null || x5 === null) return null;
      return 0.05 * x1 + 1.65 * x2 + 3.55 * x3 - 1.06 * x4 - 0.33 * x5;
    }

    default: return null;
  }
}

export function calculateIndicators(
  bp: BPLineItem[],
  dre: DRELineItem[],
  periodos: string[],
  semaforoOverrides?: Record<string, SemaforoDef>
): Indicador[] {
  return INDICADORES_TEMPLATE.map(template => {
    const valores: Record<string, number | string | null> = {};
    const status: Record<string, StatusLevel> = {};
    const computed: Record<string, number | null> = {};

    for (const periodo of periodos) {
      const val = computeIndicator(template.nome, bp, dre, periodo, computed);
      valores[periodo] = val;

      // Status only for numeric values
      if (typeof val === "number") {
        status[periodo] = getStatus(template.nome, val, semaforoOverrides);
      } else {
        status[periodo] = null;
      }
    }

    return {
      tipo: template.tipo,
      nome: template.nome,
      formula: template.formula,
      tipoDado: template.tipoDado,
      valores,
      status,
      overrides: {},
    };
  });
}
