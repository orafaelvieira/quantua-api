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

/** Denominador NULO na prática: resíduo de arredondamento (|v| < meio centavo)
 *  não é base de nada. Dividir por 2,1e-9 devolvia indicadores astronômicos
 *  (produção: Crescimento da Receita = 4,2e17%) — a régua de centavos do motor
 *  vale aqui também. */
const EPS_DENOMINADOR = 0.005;
export function ehDenominadorValido(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) >= EPS_DENOMINADOR;
}

// Safe division — null quando o denominador é zero ou resíduo, ou o resultado não é finito
function div(a: number, b: number): number | null {
  if (!ehDenominadorValido(b)) return null;
  const r = a / b;
  return Number.isFinite(r) ? r : null;
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
  "Margem EBITDA": { direcao: "menor_ruim", critico: 0, atencao: 0.05 },
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
  // Altman Z''-score (mercados emergentes): < 1,1 perigo; 1,1–2,6 zona cinzenta; > 2,6 seguro
  "Altman Z-Score (EM)": { direcao: "menor_ruim", critico: 1.1, atencao: 2.6 },
  // Imobilização do PL: > 100% = PL não cobre o ativo fixo (capital de giro próprio negativo)
  "Imobilização do Patrimônio Líquido": { direcao: "maior_ruim", critico: 1.0, atencao: 0.8 },
};

/** Dias-base dos PRAZOS MÉDIOS conforme a periodicidade dos documentos: anual = 365,
 *  trimestral = 90, mensal = 30 etc. Com ≥2 períodos usa o espaçamento (mediana) entre
 *  eles; com 1 período intermediário (balancete até 31/03), assume acumulado no ano
 *  (mês × 30). Determinístico. */
export function diasDoPeriodo(periodo: string, periodos: string[]): number {
  const chaveMes = (p: string): number => {
    const m = p.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    const y = p.match(/20\d{2}/);
    const ano = y ? parseInt(y[0]) : 0;
    return ano * 12 + (m ? parseInt(m[2]) : 12);
  };
  const unicos = [...new Set(periodos)].sort((a, b) => chaveMes(a) - chaveMes(b));
  if (unicos.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < unicos.length; i++) gaps.push(chaveMes(unicos[i]) - chaveMes(unicos[i - 1]));
    const gap = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]; // mediana
    if (gap >= 1 && gap < 12) return gap * 30;
    return 365;
  }
  const m = periodo.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  const mes = m ? parseInt(m[2]) : 12;
  return mes === 12 ? 365 : mes * 30;
}

/** Chave cronológica de um período ("31/12/2022" → 20221231; "2022" → 20220000). */
function diasKey(p: string): number {
  const m = p.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return Number(`${m[3]}${m[2]}${m[1]}`);
  const y = p.match(/20\d{2}/);
  return y ? Number(`${y[0]}0000`) : 0;
}

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
  computed: Record<string, number | null>,
  diasPeriodo = 365,
  /** Custo de capital do período (decimal). undefined = EVA não calculável. */
  custoCapital?: number
): number | string | null {
  // BP values — Ativo (always positive)
  const ativoTotal = bpVal(bp, "Ativo Total", periodo);
  const ativoCirculante = bpVal(bp, "Ativo Circulante", periodo);
  const ativoNaoCirculante = bpVal(bp, "Ativo Não Circulante", periodo);
  // Segregação 2026-07-16: com "(-) Depreciação"/"(-) Amortização" em linha
  // própria (negativas), Imobilizado/Intangível vêm BRUTOS — os indicadores
  // usam o LÍQUIDO (bruto + redutora; extração antiga sem as linhas → +0).
  const imobilizado = bpVal(bp, "Imobilizado", periodo) + bpVal(bp, "(-) Depreciação", periodo);
  const investimentosBP = bpVal(bp, "Investimentos", periodo);
  const intangivel = bpVal(bp, "Intangível", periodo) + bpVal(bp, "(-) Amortização", periodo);
  const lucrosAcumulados = bpVal(bp, "Lucros/Prejuízos Acumulados", periodo) + bpVal(bp, "Reservas de Lucros", periodo);
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
  const capitalTerceirosEmprestimos = empFinCP + empFinLP; // só onerosos bancários
  const capitalTerceiros = empFinCP + passPartRelCP + empFinLP + passPartRelLP; // + partes relacionadas
  const caixaEquivalentes = caixa;
  const dividaLiquida = capitalTerceiros - caixaEquivalentes;
  const nopat = ebit * (1 - 0.34);
  // CDG pela ótica do FINANCIAMENTO (= AC − PC quando o balanço fecha)
  const cdg = patrimonioLiquido + passivoNaoCirculante - ativoNaoCirculante;
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
    case "Margem EBITDA": return div(ebitda, receitaLiquida);
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
    case "Situação de Liquidez (Fleuriet)": {
      if (cdg > 0 && ncg > 0 && cdg > ncg) return "Sólida";
      if (cdg > 0 && ncg > 0 && cdg < ncg) return "Insuficiente";
      if (cdg < 0 && ncg < 0) return "Alto Risco";
      if (cdg > 0 && ncg < 0) return "Excelente";
      if (cdg < 0 && ncg > 0) return "Muito Ruim";
      return "Indefinida";
    }
    // Prazos: o denominador precisa ser base DE VERDADE — `receitaLiquida ?` era
    // truthy para resíduo ~1e-9 e devolvia prazo astronômico (mesma família do
    // YoY de 4e17%).
    case "Prazo Médio Contas a Receber":
      return ehDenominadorValido(receitaLiquida) ? Math.round((contasReceber * diasPeriodo) / receitaLiquida) : null;
    case "Prazo Médio Estoque":
      return ehDenominadorValido(custoOperacional) ? Math.round((estoques * diasPeriodo) / custoOperacional) : null;
    case "Prazo Médio Fornecedores":
      return ehDenominadorValido(custoOperacional) ? Math.round((fornecedores * diasPeriodo) / custoOperacional) : null;
    case "Ciclo Financeiro": {
      const pmr = ehDenominadorValido(receitaLiquida) ? Math.round((contasReceber * diasPeriodo) / receitaLiquida) : null;
      const pme = ehDenominadorValido(custoOperacional) ? Math.round((estoques * diasPeriodo) / custoOperacional) : null;
      const pmf = ehDenominadorValido(custoOperacional) ? Math.round((fornecedores * diasPeriodo) / custoOperacional) : null;
      if (pmr !== null && pme !== null && pmf !== null) return pmr + pme - pmf;
      return null;
    }

    // Endividamento
    case "Caixa e Equivalentes": return caixaEquivalentes;
    case "Capital de Terceiros": return capitalTerceirosEmprestimos;
    case "Capital de Terceiros + Partes Relacionadas": return capitalTerceiros;
    case "Dívida Líquida": return dividaLiquida;
    case "Endividamento Geral": return div(passivoTotal - patrimonioLiquido, passivoTotal);
    case "Endividamento de Curto Prazo": return div(passivoCirculante, passivoTotal);
    case "Patrimônio Líquido": return patrimonioLiquido;
    case "Capital Terceiros s/ PL": return div(capitalTerceiros, patrimonioLiquido);
    case "Dívida Líquida/EBITDA":
      // N/M COM EBITDA <= 0. O múltiplo responde "quantos anos de geração pagam a
      // dívida", e a pergunta não existe quando não há geração. Pior que ilegível,
      // o sinal INVERTIA a leitura: a Belagro publicava −13,12 e o cartão de pares
      // a classificava em P0 na régua "menor = melhor" — ou seja, a MENOS
      // alavancada do grupo, com dívida líquida de R$ 54,1 mi e EBITDA negativo.
      // String tira do percentil (Number.isFinite falha), do semáforo e dos cards
      // (num() devolve null), e o formatador a imprime como está. EBITDA ausente
      // continua null: "não medido" e "não mensurável" são coisas diferentes.
      return !Number.isFinite(ebitda) ? null : ebitda > 0 ? div(dividaLiquida, ebitda) : "N/M";
    case "Índice de Cobertura de Juros":
      return div(ebitda, Math.abs(despesasFinanceiras));
    case "Despesa Financeira / Rec. Líquida":
      return div(Math.abs(despesasFinanceiras), receitaLiquida);

    // Rentabilidade
    case "ROA (Retorno sobre Ativos)": return div(lucroLiquido, ativoTotal);
    case "ROIC (Retorno sobre Capital Investido)":
      return div(nopat, patrimonioLiquido + capitalTerceiros);
    // EVA — lucro econômico: o que sobra DEPOIS de remunerar todo o capital
    // empregado, próprio inclusive. Positivo = a empresa criou valor no período;
    // negativo = deu lucro contábil mas não pagou o custo do capital.
    // Mesmo Capital Investido do ROIC, então EVA = (ROIC − custo capital) × CI.
    case "EVA (Valor Econômico Agregado)": {
      if (custoCapital === undefined) return null; // sem WACC não se inventa
      const capitalInvestido = patrimonioLiquido + capitalTerceiros;
      if (!Number.isFinite(capitalInvestido) || capitalInvestido === 0) return null;
      return nopat - capitalInvestido * custoCapital;
    }

    // DuPont
    case "ROE (Retorno sobre Patrimônio Líquido)": return div(lucroLiquido, patrimonioLiquido);
    case "Giro do Ativo": return div(receitaLiquida, ativoTotal);
    case "Alavancagem": return div(passivoTotal, patrimonioLiquido);
    // Estrutura
    case "Imobilização do Patrimônio Líquido":
      return div(imobilizado + investimentosBP + intangivel, patrimonioLiquido);

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

    // Solvência — Altman Z''-score p/ mercados emergentes (Altman, Hartzell & Peck 1995,
    // sem a constante 3,25): > 2,6 seguro · 1,1–2,6 zona cinzenta · < 1,1 perigo
    case "Altman Z-Score (EM)": {
      const exigivelTotal = passivoCirculante + passivoNaoCirculante;
      const x1 = div(ativoCirculante - passivoCirculante, ativoTotal);
      const x2 = div(lucrosAcumulados, ativoTotal);
      const x3 = div(ebit, ativoTotal);
      const x4 = div(patrimonioLiquido, exigivelTotal);
      if (x1 === null || x2 === null || x3 === null || x4 === null) return null;
      return 6.56 * x1 + 3.26 * x2 + 6.72 * x3 + 1.05 * x4;
    }

    default: return null;
  }
}

/** Dias-base de um período YTD (balancete: DRE ACUMULADA jan→mês): mês × 30; dezembro = ano cheio.
 *  Aceita "DD/MM/AAAA" e "MM/AAAA" — o rótulo curto existe nas colunas de balancete e,
 *  sem este caso, caía no default de dezembro (365) devolvendo ano cheio para um mês
 *  de maio: prazos e alavancas saíam 2,4× errados sem nenhum sinal. */
export function diasYTD(periodo: string): number {
  const dmy = periodo.match(/\d{2}\/(\d{2})\/\d{4}/);
  const my = dmy ? null : periodo.match(/^\s*(\d{2})\/\d{4}\s*$/);
  const mes = dmy ? parseInt(dmy[1]) : my ? parseInt(my[1]) : 12;
  return mes === 12 ? 365 : mes * 30;
}

/**
 * A RÉGUA DE DIAS DE UM PERÍODO — uma só, para todo o produto.
 *
 * Estava inline dentro do laço de `calculateIndicators` e foi RECOPIADA em cada
 * consumidor. Uma das cópias (claude.ts) usava `ytd.has(p) ? diasYTD(p) : 365`,
 * que só coincide quando a série é anual: num IBR com um único fechamento em
 * 31/05/2026 que NÃO está registrado como balancete, o motor de indicadores
 * publica o prazo sobre 150 dias e a cópia calculava sobre 365. O mesmo
 * relatório trazia dois preços para o mesmo movimento — R$ 6,5 mi de um lado e
 * R$ 17,4 mi do outro.
 *
 * Quem precisar da base de dias chama ISTO. Cópia nova é divergência futura.
 */
export function diasBaseDe(periodo: string, periodos: string[], periodosYTD?: string[]): number {
  const ytd = new Set(periodosYTD ?? []);
  return ytd.has(periodo)
    ? diasYTD(periodo)
    : diasDoPeriodo(periodo, periodos.filter((x) => !ytd.has(x) || x === periodo));
}

export function calculateIndicators(
  bp: BPLineItem[],
  dre: DRELineItem[],
  periodos: string[],
  semaforoOverrides?: Record<string, SemaforoDef>,
  diasOverride?: number, // força a base dos prazos (ex.: pares CVM — TRI=90, LTM=365)
  periodosYTD?: string[], // períodos de BALANCETE (DRE acumulada no ano): dias = mês × 30
  extras?: {
    /** Dias-base POR período, quando quem chama sabe melhor que a heurística.
     *  O espelho do Valuation/BP usa isto: um ano parcial do horizonte (jul–dez)
     *  tem 6 meses de DRE, e assumir 365 dobraria os prazos médios. */
    diasPorPeriodo?: Record<string, number>;
    /** Custo de capital (decimal, ex.: 0.1842) usado no EVA. Sem ele o EVA fica
     *  null — estimar um WACC por conta seria inventar o número mais sensível
     *  do indicador. No Valuation/BP vem do WACC do próprio modelo. */
    custoCapital?: number;
  }
): Indicador[] {
  // Ordem cronológica p/ os indicadores MULTI-PERÍODO (YoY) e dias-base dos prazos.
  const periodosOrd = [...periodos].sort((a, b) => diasKey(a) - diasKey(b));
  const diasPorPeriodo: Record<string, number> = {};
  const ytd = new Set(periodosYTD ?? []);
  // Períodos de balancete têm dias-base PRÓPRIOS (YTD): a mediana do espaçamento
  // da série mista anual+mensal daria 365 para um mês de maio (prazos médios ~2,4×
  // inflados). Cada período usa a base da SUA periodicidade.
  for (const p of periodos) diasPorPeriodo[p] = extras?.diasPorPeriodo?.[p] ?? diasOverride ?? diasBaseDe(p, periodos, periodosYTD);
  // Receita Líquida por período (base do Crescimento YoY)
  const rlPor: Record<string, number | null> = {};
  for (const p of periodos) {
    const v = computeIndicator("Receita Líquida", bp, dre, p, {});
    rlPor[p] = typeof v === "number" ? v : null;
  }

  /**
   * RETORNOS ANUALIZADOS, SOBRE BASE MÉDIA (18/08/2026, decisão do dono).
   *
   * ROE e ROA eram `lucro ÷ denominador` crus. Num balancete de maio isso é
   * CINCO MESES de lucro sobre o patrimônio — um número que não compara com
   * nada: nem com o ano anterior, nem com os pares da B3, que entram em LTM.
   *
   * Duas correções, e as duas seguem convenção de mercado:
   *   1. ANUALIZA o numerador (× 365 ÷ dias do período). Exercício completo tem
   *      fator 1, então TODO indicador anual continua idêntico — só período
   *      parcial muda, que é exatamente onde estava errado.
   *   2. Denominador MÉDIO entre o período anterior e o atual. Patrimônio é
   *      estoque: quando ele muda muito dentro do período, o saldo final mente.
   *      Caso real: a Belagro distribuiu R$ 6 mi de lucros em dez/25 e o PL caiu
   *      de ~14,5 mi para ~8,5 mi — dividir o lucro do ano pelo PL do fim infla
   *      o retorno porque o denominador encolheu DEPOIS de o lucro ser gerado.
   *      Sem período anterior na série, usa o próprio (não há o que mediar).
   */
  const lucroPor: Record<string, number | null> = {};
  const plPor: Record<string, number | null> = {};
  const ativoPor: Record<string, number | null> = {};
  for (const p of periodos) {
    const n = (x: number | string | null): number | null => (typeof x === "number" ? x : null);
    lucroPor[p] = n(computeIndicator("Lucro Líquido", bp, dre, p, {}));
    plPor[p] = n(computeIndicator("Patrimônio Líquido", bp, dre, p, {}));
    // "Ativo Total" NÃO é um indicador do template — é linha do BP. Buscá-lo
    // por computeIndicator devolvia null e MATAVA o ROA (a identidade DuPont
    // "Margem Líquida × Giro do Ativo = ROA" quebrou na suíte e denunciou).
    ativoPor[p] = bpVal(bp, "Ativo Total", p);
  }
  const RETORNOS: Record<string, Record<string, number | null>> = {
    "ROE (Retorno sobre Patrimônio Líquido)": plPor,
    "ROA (Retorno sobre Ativos)": ativoPor,
  };
  // BASE MÉDIA compartilhada por TODA a cascata DuPont: média com o período
  // imediatamente anterior da série; primeiro período fica pontual.
  const mediaDe = (base: Record<string, number | null>, periodo: string): number | null => {
    const idx = periodosOrd.indexOf(periodo);
    const antP = idx > 0 ? periodosOrd[idx - 1] : null;
    const atual = base[periodo], ant = antP ? base[antP] : null;
    return atual != null && ant != null ? (atual + ant) / 2 : atual;
  };
  // ANO FECHADO NÃO ANUALIZA (regra do dono, 21/08/2026: "quando o ano for
  // fechado é o lucro do ano pelo PL"). Na régua mês×30 o YTD de dezembro vale
  // 360 dias — sem este piso, o ano cheio ainda ganharia ×365/360 = +1,4% de
  // fator, e "lucro do ano" viraria "lucro do ano inflado".
  const fatorAno = (periodo: string): number => {
    const d = diasPorPeriodo[periodo] || 365;
    return d >= 360 ? 1 : 365 / d;
  };

  const retornoDe = (nome: string, periodo: string): number | null => {
    const base = RETORNOS[nome];
    if (!base) return null;
    const den = mediaDe(base, periodo);
    const lucro = lucroPor[periodo];
    if (lucro == null || !ehDenominadorValido(den) || den <= 0) return null;
    return (lucro * fatorAno(periodo)) / den;
  };

  /**
   * GIRO E ALAVANCAGEM NA MESMA RÉGUA DO ROE (decisão do dono, 21/08/2026:
   * "DuPont e método direto têm que fechar o mesmo valor").
   *
   * Eram pontuais e não anualizados enquanto ROE/ROA saíam anualizados sobre
   * base média — e a cascata impressa na aba ("Margem × Giro = ROA; ROA ×
   * Alavancagem = ROE") NÃO multiplicava: na Belagro em 31/12/2025 o produto
   * dava 40,09% e a linha ROE publicava 34,78%. O teste de identidade da suíte
   * não via porque a fixture tem UM período — ali média=pontual e fator=1, e
   * as duas réguas coincidem por construção.
   *
   *   Margem = LL ÷ RL                       (o fator de anualização cancela)
   *   Giro   = RL anualizada ÷ Ativo MÉDIO
   *   Alav   = Ativo MÉDIO ÷ PL MÉDIO
   *   Margem × Giro × Alav = LL anualizado ÷ PL médio = o ROE da linha de cima.
   *
   * Ano fechado: fator = 1 (365/365) — o lucro do ano sobre o PL médio, como o
   * dono definiu. Ano parcial (ex.: YTD 2026): anualiza.
   */
  const giroDe = (periodo: string): number | null => {
    const rl = rlPor[periodo];
    const den = mediaDe(ativoPor, periodo);
    if (rl == null || !ehDenominadorValido(den) || den <= 0) return null;
    return (rl * fatorAno(periodo)) / den;
  };
  const alavDe = (periodo: string): number | null => {
    const at = mediaDe(ativoPor, periodo);
    const pl = mediaDe(plPor, periodo);
    if (at == null || !ehDenominadorValido(pl) || pl <= 0) return null;
    return at / pl;
  };

  return INDICADORES_TEMPLATE.map(template => {
    const valores: Record<string, number | string | null> = {};
    const status: Record<string, StatusLevel> = {};
    const computed: Record<string, number | null> = {};

    for (const periodo of periodos) {
      let val: number | string | null;
      if (template.nome === "Crescimento da Receita (YoY)") {
        // multi-período: compara com o período IMEDIATAMENTE anterior (cronológico)
        const idx = periodosOrd.indexOf(periodo);
        const antP = idx > 0 ? periodosOrd[idx - 1] : null;
        const cur = rlPor[periodo], antV = antP ? rlPor[antP] : null;
        // Base do YoY precisa ser receita DE VERDADE: coluna sem movimento
        // (resíduo ~1e-9) não pode virar "crescimento de 4e17%".
        val = cur != null && ehDenominadorValido(antV) ? (cur - antV) / Math.abs(antV) : null;
      } else if (template.nome in RETORNOS) {
        val = retornoDe(template.nome, periodo);
      } else if (template.nome === "Giro do Ativo") {
        val = giroDe(periodo);
      } else if (template.nome === "Alavancagem") {
        val = alavDe(periodo);
      } else {
        val = computeIndicator(template.nome, bp, dre, periodo, computed, diasPorPeriodo[periodo], extras?.custoCapital);
      }
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
