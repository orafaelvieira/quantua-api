/**
 * Demo financial data builders — Frigorífico Pampa e Têxtil Sul Mineiro.
 *
 * Helpers que retornam JSON tipado pros campos da Analysis:
 * dadosEstruturados (BP/DRE/Indicadores), stcf (13 sem), scenarios (3),
 * options (4 pilares), executiveSummary.
 *
 * Cenário "frigorifico" = distress severo (PL negativo, EBITDA negativo, todos
 * os covenants em breach). "textil" = recovery pós-reperfilamento.
 */

export type Scenario = "frigorifico" | "textil";

// ─────────────────────────────────────────────────────────────────
// Períodos
// ─────────────────────────────────────────────────────────────────

const PERIODOS_FRIGORIFICO = ["31/12/2024", "31/12/2025", "30/06/2026"];
const PERIODOS_TEXTIL = ["31/12/2023", "31/12/2024", "31/12/2025"];

export function periodosFor(s: Scenario): string[] {
  return s === "frigorifico" ? [...PERIODOS_FRIGORIFICO] : [...PERIODOS_TEXTIL];
}

// ─────────────────────────────────────────────────────────────────
// BP — Balanço Patrimonial
// ─────────────────────────────────────────────────────────────────

interface BPLine {
  classificacao: string;
  conta: string;
  valores: Record<string, number>;
  nivel: number;
  editado: boolean;
}

function bpFrigorifico(): BPLine[] {
  const p = PERIODOS_FRIGORIFICO;
  const v = (a: number, b: number, c: number) => ({ [p[0]]: a * 1000, [p[1]]: b * 1000, [p[2]]: c * 1000 });
  return [
    { classificacao: "AT",  conta: "Ativo Total",                              valores: v(50400, 50900, 50750), nivel: 0, editado: false },
    { classificacao: "AC",  conta: "Ativo Circulante",                         valores: v(19700, 21800, 23250), nivel: 1, editado: false },
    { classificacao: "AC",  conta: "Caixa e Equivalentes de Caixa",            valores: v(3500, 2100, 850),     nivel: 2, editado: false },
    { classificacao: "AC",  conta: "Contas a Receber",                         valores: v(8200, 9800, 11200),   nivel: 2, editado: false },
    { classificacao: "AC",  conta: "Estoques",                                 valores: v(6800, 8500, 9700),    nivel: 2, editado: false },
    { classificacao: "AC",  conta: "Tributos a Recuperar",                     valores: v(700, 850, 950),       nivel: 2, editado: false },
    { classificacao: "AC",  conta: "Outros Ativos Circulantes",                valores: v(500, 550, 550),       nivel: 2, editado: false },
    { classificacao: "ANC", conta: "Ativo Não Circulante",                     valores: v(30700, 29100, 27500), nivel: 1, editado: false },
    { classificacao: "ANC", conta: "Realizável a Longo Prazo",                 valores: v(0, 0, 0),             nivel: 2, editado: false },
    { classificacao: "ANC", conta: "Imobilizado",                              valores: v(28500, 27000, 25500), nivel: 2, editado: false },
    { classificacao: "ANC", conta: "Intangível",                               valores: v(2200, 2100, 2000),    nivel: 2, editado: false },
    { classificacao: "PT",  conta: "Passivo Total",                            valores: v(50400, 50900, 50750), nivel: 0, editado: false },
    { classificacao: "PC",  conta: "Passivo Circulante",                       valores: v(18800, 26000, 31600), nivel: 1, editado: false },
    { classificacao: "PC",  conta: "Fornecedores",                             valores: v(6500, 8200, 9800),    nivel: 2, editado: false },
    { classificacao: "PC",  conta: "Obrigações Trabalhistas",                  valores: v(1800, 2200, 2600),    nivel: 2, editado: false },
    { classificacao: "PC",  conta: "Obrigações Tributárias",                   valores: v(1000, 1300, 1500),    nivel: 2, editado: false },
    { classificacao: "PC",  conta: "Empréstimos e Financiamentos - Curto Prazo", valores: v(8000, 12500, 15800), nivel: 2, editado: false },
    { classificacao: "PC",  conta: "Outros Passivos Circulantes",              valores: v(1500, 1800, 1900),    nivel: 2, editado: false },
    { classificacao: "PNC", conta: "Passivo Não Circulante",                   valores: v(24000, 28500, 31200), nivel: 1, editado: false },
    { classificacao: "PNC", conta: "Empréstimos e Financiamentos - Longo Prazo", valores: v(24000, 28500, 31200), nivel: 2, editado: false },
    { classificacao: "PL",  conta: "Patrimônio Líquido",                       valores: v(7600, -3600, -12050), nivel: 1, editado: false },
    { classificacao: "PL",  conta: "Capital Social",                           valores: v(5000, 5000, 5000),    nivel: 2, editado: false },
    { classificacao: "PL",  conta: "Reservas de Lucros",                       valores: v(2200, 0, 0),          nivel: 2, editado: false },
    { classificacao: "PL",  conta: "Lucros/Prejuízos Acumulados",              valores: v(400, -8600, -17050),  nivel: 2, editado: false },
  ];
}

function bpTextil(): BPLine[] {
  const p = PERIODOS_TEXTIL;
  const v = (a: number, b: number, c: number) => ({ [p[0]]: a * 1000, [p[1]]: b * 1000, [p[2]]: c * 1000 });
  return [
    { classificacao: "AT",  conta: "Ativo Total",                              valores: v(38500, 39200, 40100), nivel: 0, editado: false },
    { classificacao: "AC",  conta: "Ativo Circulante",                         valores: v(16800, 17500, 18900), nivel: 1, editado: false },
    { classificacao: "AC",  conta: "Caixa e Equivalentes de Caixa",            valores: v(2400, 3100, 4200),    nivel: 2, editado: false },
    { classificacao: "AC",  conta: "Contas a Receber",                         valores: v(7200, 7400, 7600),    nivel: 2, editado: false },
    { classificacao: "AC",  conta: "Estoques",                                 valores: v(5900, 5800, 5900),    nivel: 2, editado: false },
    { classificacao: "AC",  conta: "Tributos a Recuperar",                     valores: v(900, 850, 870),       nivel: 2, editado: false },
    { classificacao: "AC",  conta: "Outros Ativos Circulantes",                valores: v(400, 350, 330),       nivel: 2, editado: false },
    { classificacao: "ANC", conta: "Ativo Não Circulante",                     valores: v(21700, 21700, 21200), nivel: 1, editado: false },
    { classificacao: "ANC", conta: "Imobilizado",                              valores: v(19200, 19000, 18400), nivel: 2, editado: false },
    { classificacao: "ANC", conta: "Intangível",                               valores: v(2500, 2700, 2800),    nivel: 2, editado: false },
    { classificacao: "PT",  conta: "Passivo Total",                            valores: v(38500, 39200, 40100), nivel: 0, editado: false },
    { classificacao: "PC",  conta: "Passivo Circulante",                       valores: v(15200, 16800, 16000), nivel: 1, editado: false },
    { classificacao: "PC",  conta: "Fornecedores",                             valores: v(4200, 4500, 4800),    nivel: 2, editado: false },
    { classificacao: "PC",  conta: "Obrigações Trabalhistas",                  valores: v(1800, 1900, 2100),    nivel: 2, editado: false },
    { classificacao: "PC",  conta: "Obrigações Tributárias",                   valores: v(1200, 1300, 1400),    nivel: 2, editado: false },
    { classificacao: "PC",  conta: "Empréstimos e Financiamentos - Curto Prazo", valores: v(7000, 8100, 6800),   nivel: 2, editado: false },
    { classificacao: "PC",  conta: "Outros Passivos Circulantes",              valores: v(1000, 1000, 900),     nivel: 2, editado: false },
    { classificacao: "PNC", conta: "Passivo Não Circulante",                   valores: v(14500, 13800, 15200), nivel: 1, editado: false },
    { classificacao: "PNC", conta: "Empréstimos e Financiamentos - Longo Prazo", valores: v(14500, 13800, 15200), nivel: 2, editado: false },
    { classificacao: "PL",  conta: "Patrimônio Líquido",                       valores: v(8800, 8600, 8900),    nivel: 1, editado: false },
    { classificacao: "PL",  conta: "Capital Social",                           valores: v(5500, 5500, 5500),    nivel: 2, editado: false },
    { classificacao: "PL",  conta: "Reservas de Lucros",                       valores: v(2800, 2600, 2800),    nivel: 2, editado: false },
    { classificacao: "PL",  conta: "Lucros/Prejuízos Acumulados",              valores: v(500, 500, 600),       nivel: 2, editado: false },
  ];
}

export function bpFor(s: Scenario): BPLine[] {
  return s === "frigorifico" ? bpFrigorifico() : bpTextil();
}

// ─────────────────────────────────────────────────────────────────
// DRE — Demonstração de Resultados
// ─────────────────────────────────────────────────────────────────

interface DRELine {
  conta: string;
  valores: Record<string, number>;
  subtotal: boolean;
  editado: boolean;
}

function dreFrigorifico(): DRELine[] {
  const p = PERIODOS_FRIGORIFICO;
  const v = (a: number, b: number, c: number) => ({ [p[0]]: a * 1000, [p[1]]: b * 1000, [p[2]]: c * 1000 });
  return [
    { conta: "Receita Bruta",         valores: v(105000, 87000, 69500), subtotal: false, editado: false },
    { conta: "(-) Deduções",          valores: v(-10000, -9000, -7500), subtotal: false, editado: false },
    { conta: "Receita Líquida",       valores: v(95000, 78000, 62000),  subtotal: true,  editado: false },
    { conta: "(-) CMV",               valores: v(-76000, -67500, -56300), subtotal: false, editado: false },
    { conta: "Lucro Bruto",           valores: v(19000, 10500, 5700),   subtotal: true,  editado: false },
    { conta: "(-) Despesas Operacionais", valores: v(-12500, -11800, -10500), subtotal: false, editado: false },
    { conta: "EBITDA",                valores: v(6500, -1300, -4800),   subtotal: true,  editado: false },
    { conta: "(-) Depreciação e Amortização", valores: v(-2800, -2700, -2500), subtotal: false, editado: false },
    { conta: "EBIT",                  valores: v(3700, -4000, -7300),   subtotal: true,  editado: false },
    { conta: "Resultado Financeiro Líquido", valores: v(-3200, -5800, -7600), subtotal: false, editado: false },
    { conta: "LAIR",                  valores: v(500, -9800, -14900),   subtotal: true,  editado: false },
    { conta: "(-) IR e CSLL",         valores: v(0, 0, 0),              subtotal: false, editado: false },
    { conta: "Resultado Líquido",     valores: v(500, -9800, -14900),   subtotal: true,  editado: false },
  ];
}

function dreTextil(): DRELine[] {
  const p = PERIODOS_TEXTIL;
  const v = (a: number, b: number, c: number) => ({ [p[0]]: a * 1000, [p[1]]: b * 1000, [p[2]]: c * 1000 });
  return [
    { conta: "Receita Bruta",         valores: v(54000, 51500, 53000),  subtotal: false, editado: false },
    { conta: "(-) Deduções",          valores: v(-8000, -7300, -7800),  subtotal: false, editado: false },
    { conta: "Receita Líquida",       valores: v(46000, 44200, 45200),  subtotal: true,  editado: false },
    { conta: "(-) CMV",               valores: v(-35700, -34200, -35100), subtotal: false, editado: false },
    { conta: "Lucro Bruto",           valores: v(10300, 10000, 10100),  subtotal: true,  editado: false },
    { conta: "(-) Despesas Operacionais", valores: v(-6400, -5900, -5200), subtotal: false, editado: false },
    { conta: "EBITDA",                valores: v(3900, 4100, 4900),     subtotal: true,  editado: false },
    { conta: "(-) Depreciação e Amortização", valores: v(-1100, -1100, -1100), subtotal: false, editado: false },
    { conta: "EBIT",                  valores: v(2800, 3000, 3800),     subtotal: true,  editado: false },
    { conta: "Resultado Financeiro Líquido", valores: v(-1900, -2200, -1800), subtotal: false, editado: false },
    { conta: "LAIR",                  valores: v(900, 800, 2000),       subtotal: true,  editado: false },
    { conta: "(-) IR e CSLL",         valores: v(-200, -200, -500),     subtotal: false, editado: false },
    { conta: "Resultado Líquido",     valores: v(700, 600, 1500),       subtotal: true,  editado: false },
  ];
}

export function dreFor(s: Scenario): DRELine[] {
  return s === "frigorifico" ? dreFrigorifico() : dreTextil();
}

// ─────────────────────────────────────────────────────────────────
// Indicadores
// ─────────────────────────────────────────────────────────────────

type Status = "ok" | "atencao" | "critico" | null;

interface IndicadorRow {
  tipo: string;
  nome: string;
  formula: string;
  tipoDado: "R$" | "%" | "Índice" | "Dias" | "Texto";
  valores: Record<string, number | string | null>;
  status: Record<string, Status>;
  overrides: Record<string, number | null>;
}

function indicadoresFrigorifico(): IndicadorRow[] {
  const p = PERIODOS_FRIGORIFICO;
  const row = (
    tipo: string,
    nome: string,
    formula: string,
    tipoDado: IndicadorRow["tipoDado"],
    vs: [number | null, number | null, number | null],
    sts: [Status, Status, Status],
  ): IndicadorRow => ({
    tipo,
    nome,
    formula,
    tipoDado,
    valores: { [p[0]]: vs[0], [p[1]]: vs[1], [p[2]]: vs[2] },
    status:  { [p[0]]: sts[0], [p[1]]: sts[1], [p[2]]: sts[2] },
    overrides: {},
  });
  return [
    row("Rentabilidade", "Margem Bruta",     "Lucro Bruto / Receita Líquida",        "%", [0.2,   0.135, 0.092], ["ok", "atencao", "critico"]),
    row("Rentabilidade", "Margem EBITDA",    "EBITDA / Receita Líquida",             "%", [0.068, -0.017, -0.077], ["ok", "critico", "critico"]),
    row("Rentabilidade", "ROE",              "Resultado Líquido / Patrimônio Líquido", "%", [0.066, null, null], ["ok", "critico", "critico"]),
    row("Rentabilidade", "ROA",              "Resultado Líquido / Ativo Total",      "%", [0.010, -0.193, -0.294], ["ok", "critico", "critico"]),
    row("Liquidez",      "Liquidez Corrente", "Ativo Circulante / Passivo Circulante", "Índice", [1.05, 0.84, 0.74], ["ok", "atencao", "critico"]),
    row("Endividamento", "Endividamento Total", "Passivo Total / Ativo Total",        "%", [0.849, 1.07, 1.24],  ["atencao", "critico", "critico"]),
    row("Working Capital", "DSO",            "Contas a Receber / Receita × 30",      "Dias", [28, 41, 59], ["ok", "atencao", "critico"]),
    row("Working Capital", "DPO",            "Fornecedores / CMV × 30",              "Dias", [31, 44, 64], ["atencao", "atencao", "atencao"]),
    row("Working Capital", "DIO",            "Estoques / CMV × 30",                  "Dias", [33, 46, 63], ["ok", "atencao", "critico"]),
    row("Working Capital", "Ciclo de Caixa", "DSO + DIO − DPO",                      "Dias", [30, 43, 58], ["ok", "atencao", "critico"]),
  ];
}

function indicadoresTextil(): IndicadorRow[] {
  const p = PERIODOS_TEXTIL;
  const row = (
    tipo: string,
    nome: string,
    formula: string,
    tipoDado: IndicadorRow["tipoDado"],
    vs: [number | null, number | null, number | null],
    sts: [Status, Status, Status],
  ): IndicadorRow => ({
    tipo, nome, formula, tipoDado,
    valores: { [p[0]]: vs[0], [p[1]]: vs[1], [p[2]]: vs[2] },
    status:  { [p[0]]: sts[0], [p[1]]: sts[1], [p[2]]: sts[2] },
    overrides: {},
  });
  return [
    row("Rentabilidade", "Margem Bruta",     "Lucro Bruto / Receita Líquida",        "%", [0.224, 0.226, 0.224], ["ok", "ok", "ok"]),
    row("Rentabilidade", "Margem EBITDA",    "EBITDA / Receita Líquida",             "%", [0.084, 0.093, 0.108], ["ok", "ok", "ok"]),
    row("Rentabilidade", "ROE",              "Resultado Líquido / Patrimônio Líquido", "%", [0.080, 0.070, 0.169], ["ok", "atencao", "ok"]),
    row("Rentabilidade", "ROA",              "Resultado Líquido / Ativo Total",      "%", [0.018, 0.015, 0.037], ["ok", "ok", "ok"]),
    row("Liquidez",      "Liquidez Corrente", "Ativo Circulante / Passivo Circulante", "Índice", [1.10, 1.04, 1.18], ["ok", "atencao", "ok"]),
    row("Endividamento", "Endividamento Total", "Passivo Total / Ativo Total",        "%", [0.771, 0.781, 0.778], ["atencao", "atencao", "atencao"]),
    row("Working Capital", "DSO",            "Contas a Receber / Receita × 30",      "Dias", [56, 60, 60], ["ok", "ok", "ok"]),
    row("Working Capital", "DPO",            "Fornecedores / CMV × 30",              "Dias", [42, 47, 49], ["ok", "ok", "ok"]),
    row("Working Capital", "DIO",            "Estoques / CMV × 30",                  "Dias", [60, 61, 60], ["ok", "ok", "ok"]),
    row("Working Capital", "Ciclo de Caixa", "DSO + DIO − DPO",                      "Dias", [74, 74, 71], ["atencao", "atencao", "atencao"]),
  ];
}

export function indicadoresFor(s: Scenario): IndicadorRow[] {
  return s === "frigorifico" ? indicadoresFrigorifico() : indicadoresTextil();
}

// ─────────────────────────────────────────────────────────────────
// dadosEstruturados — concatena BP + DRE + Indicadores
// ─────────────────────────────────────────────────────────────────

export function dadosEstruturadosFor(s: Scenario) {
  return {
    periodos: periodosFor(s),
    bp: bpFor(s),
    dre: dreFor(s),
    indicadores: indicadoresFor(s),
    unmatchedAccounts: [],
    version: 1,
  };
}

// ─────────────────────────────────────────────────────────────────
// STCF — 13 semanas
// ─────────────────────────────────────────────────────────────────

interface STCFLine {
  id: string;
  category: string;
  direction: "inflow" | "outflow";
  amount: number;
  source: "historical" | "contract" | "forecast";
  confidence: "high" | "medium" | "low";
  notes?: string;
}

interface STCFWeek {
  weekIndex: number;
  weekLabel: string;
  weekStartDate: string;
  openingCash: number;
  inflows: STCFLine[];
  outflows: STCFLine[];
  closingCash: number;
}

interface STCFForecast {
  id: string;
  analysisId: string;
  scenarioId: string;
  startWeek: string;
  weeks: STCFWeek[];
  initialCash: number;
  version: number;
  createdAt: string;
  createdBy: string;
}

function buildSTCFFrigorifico(analysisId: string, createdBy: string, createdAt: string): STCFForecast {
  // Frigorífico: caixa inicial R$ 850k, breach por volta da sem 8, runway negativo
  // Recebimentos clientes baseado em receita média mensal R$ 5.2M / 4.3 = R$ 1.2M/sem (com volatilidade)
  // Folha R$ 600k/sem, Fornecedores R$ 900k/sem (atrasados), Tributos R$ 200k/sem,
  // Serviço dívida R$ 350k/sem
  const baseDate = new Date("2026-06-23"); // segunda-feira
  let cash = 850000;
  const weeks: STCFWeek[] = [];
  // Recebimentos: caem nas primeiras semanas, recuperam no final (sazonalidade)
  const inflowsByWeek = [1180, 1100, 980, 920, 1050, 1180, 1200, 1100, 980, 1020, 1080, 1150, 1180];
  const folhaByWeek    = [600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600];
  const fornByWeek     = [900, 950, 1000, 1050, 1100, 1000, 950, 900, 850, 880, 920, 950, 980];
  const tribByWeek     = [200, 250, 200, 220, 200, 240, 200, 220, 240, 210, 220, 200, 230];
  const divByWeek      = [350, 0,   0,   0,   350, 0,   0,   0,   350, 0,   0,   0,   350];

  for (let i = 0; i < 13; i++) {
    const start = new Date(baseDate);
    start.setDate(start.getDate() + i * 7);
    const opening = cash;
    const inflows: STCFLine[] = [
      { id: `f-in-${i}-1`, category: "Recebimentos clientes", direction: "inflow", amount: inflowsByWeek[i] * 1000, source: "forecast", confidence: i < 4 ? "high" : "medium" },
      { id: `f-in-${i}-2`, category: "Outros recebimentos",    direction: "inflow", amount: 30000, source: "forecast", confidence: "low" },
    ];
    const outflows: STCFLine[] = [
      { id: `f-out-${i}-1`, category: "Folha de pagamento",      direction: "outflow", amount: folhaByWeek[i] * 1000, source: "historical", confidence: "high" },
      { id: `f-out-${i}-2`, category: "Fornecedores",            direction: "outflow", amount: fornByWeek[i] * 1000,  source: "contract",   confidence: "high" },
      { id: `f-out-${i}-3`, category: "Tributos",                direction: "outflow", amount: tribByWeek[i] * 1000,  source: "historical", confidence: "high" },
      { id: `f-out-${i}-4`, category: "Serviço da dívida",       direction: "outflow", amount: divByWeek[i] * 1000,   source: "contract",   confidence: "high" },
    ];
    const totalIn  = inflows.reduce((s, l) => s + l.amount, 0);
    const totalOut = outflows.reduce((s, l) => s + l.amount, 0);
    const closing = opening + totalIn - totalOut;
    weeks.push({
      weekIndex: i + 1,
      weekLabel: `S${i + 1}`,
      weekStartDate: start.toISOString().slice(0, 10),
      openingCash: opening,
      inflows,
      outflows,
      closingCash: closing,
    });
    cash = closing;
  }

  return {
    id: `stcf-frigorifico-${Date.now()}`,
    analysisId,
    scenarioId: "base",
    startWeek: baseDate.toISOString().slice(0, 10),
    weeks,
    initialCash: 850000,
    version: 1,
    createdAt,
    createdBy,
  };
}

function buildSTCFTextil(analysisId: string, createdBy: string, createdAt: string): STCFForecast {
  // Têxtil pós-reperfilamento: caixa inicial R$ 4.2M, saldo estável crescente
  const baseDate = new Date("2026-04-21");
  let cash = 4200000;
  const weeks: STCFWeek[] = [];
  for (let i = 0; i < 13; i++) {
    const start = new Date(baseDate);
    start.setDate(start.getDate() + i * 7);
    const opening = cash;
    const recebimentos = (920 + (i % 4) * 30) * 1000;
    const inflows: STCFLine[] = [
      { id: `t-in-${i}-1`, category: "Recebimentos clientes", direction: "inflow", amount: recebimentos, source: "forecast", confidence: "high" },
      { id: `t-in-${i}-2`, category: "Outros recebimentos",    direction: "inflow", amount: 20000, source: "forecast", confidence: "medium" },
    ];
    const outflows: STCFLine[] = [
      { id: `t-out-${i}-1`, category: "Folha de pagamento",   direction: "outflow", amount: 450000, source: "historical", confidence: "high" },
      { id: `t-out-${i}-2`, category: "Fornecedores",         direction: "outflow", amount: 410000, source: "contract",   confidence: "high" },
      { id: `t-out-${i}-3`, category: "Tributos",             direction: "outflow", amount: 130000, source: "historical", confidence: "high" },
      { id: `t-out-${i}-4`, category: "Serviço da dívida",    direction: "outflow", amount: i % 4 === 0 ? 280000 : 0, source: "contract", confidence: "high" },
    ];
    const totalIn  = inflows.reduce((s, l) => s + l.amount, 0);
    const totalOut = outflows.reduce((s, l) => s + l.amount, 0);
    const closing = opening + totalIn - totalOut;
    weeks.push({
      weekIndex: i + 1,
      weekLabel: `S${i + 1}`,
      weekStartDate: start.toISOString().slice(0, 10),
      openingCash: opening,
      inflows,
      outflows,
      closingCash: closing,
    });
    cash = closing;
  }
  return {
    id: `stcf-textil-${Date.now()}`,
    analysisId,
    scenarioId: "base",
    startWeek: baseDate.toISOString().slice(0, 10),
    weeks,
    initialCash: 4200000,
    version: 1,
    createdAt,
    createdBy,
  };
}

export function stcfFor(s: Scenario, analysisId: string, createdBy: string, createdAt: string): STCFForecast {
  return s === "frigorifico"
    ? buildSTCFFrigorifico(analysisId, createdBy, createdAt)
    : buildSTCFTextil(analysisId, createdBy, createdAt);
}

// ─────────────────────────────────────────────────────────────────
// Cenários — 3 (Base/Downside/Severo)
// ─────────────────────────────────────────────────────────────────

interface ScenarioRow {
  id: string;
  analysisId: string;
  kind: "base" | "downside" | "severe" | "custom";
  name: string;
  assumptions: {
    revenueMultiplier: number;
    cogsMultiplier: number;
    opexMultiplier: number;
    dsoDeltaDays: number;
    dpoDeltaDays: number;
    dioDeltaDays: number;
    fxShock?: number;
    interestRateDelta?: number;
  };
  notes?: string;
}

export function scenariosFor(analysisId: string): ScenarioRow[] {
  return [
    {
      id: `sc-base-${analysisId.slice(0, 8)}`,
      analysisId,
      kind: "base",
      name: "Base",
      assumptions: { revenueMultiplier: 1.0, cogsMultiplier: 1.0, opexMultiplier: 1.0, dsoDeltaDays: 0, dpoDeltaDays: 0, dioDeltaDays: 0 },
      notes: "Continuidade da operação sob estado atual, sem intervenção.",
    },
    {
      id: `sc-down-${analysisId.slice(0, 8)}`,
      analysisId,
      kind: "downside",
      name: "Downside",
      assumptions: { revenueMultiplier: 0.9, cogsMultiplier: 1.05, opexMultiplier: 1.0, dsoDeltaDays: 10, dpoDeltaDays: -5, dioDeltaDays: 5 },
      notes: "Receita −10%, custos pressionados, fornecedores apertando prazo (−5d DPO).",
    },
    {
      id: `sc-sev-${analysisId.slice(0, 8)}`,
      analysisId,
      kind: "severe",
      name: "Severo",
      assumptions: { revenueMultiplier: 0.75, cogsMultiplier: 1.10, opexMultiplier: 1.05, dsoDeltaDays: 25, dpoDeltaDays: -15, dioDeltaDays: 15 },
      notes: "Cenário stress: perda de cliente top-3, fornecedores cortando crédito, RJ provável.",
    },
  ];
}

// ─────────────────────────────────────────────────────────────────
// Opções estratégicas — 4 pilares Oliver Wyman
// ─────────────────────────────────────────────────────────────────

interface StrategicOption {
  id: string;
  pillar: "strategic_repositioning" | "value_focused_business_model" | "operational_excellence" | "financial_restructuring";
  title: string;
  description: string;
  estimatedImpactBRL?: number;
  horizonMonths?: number;
  effort: "low" | "medium" | "high";
  owner?: string;
  priority: "p0" | "p1" | "p2";
}

function optionsFrigorifico(): StrategicOption[] {
  return [
    {
      id: "opt-fr-1",
      pillar: "financial_restructuring",
      title: "Reperfilamento de dívida + waiver dos covenants",
      description:
        "Negociar com sindicato bancário (4 credores, Banco Beta líder): converter ~R$ 22M de CP em LP, prazo 5 anos a 6% am. Solicitar waiver formal dos covenants até dez/2027 condicional à execução do plano operacional.",
      estimatedImpactBRL: 7_200_000,
      horizonMonths: 3,
      effort: "high",
      owner: "Rafael Vieira (RT)",
      priority: "p0",
    },
    {
      id: "opt-fr-2",
      pillar: "operational_excellence",
      title: "Redução de custos fixos R$ 4M/ano",
      description:
        "Fechamento da unidade de Bagé (35% capacidade, EBITDA −R$ 1.8M/ano). Renegociação com 3 frigoríficos terceirizados eliminando cláusulas take-or-pay. Corte de 18 posições administrativas em duplicidade.",
      estimatedImpactBRL: 4_000_000,
      horizonMonths: 6,
      effort: "medium",
      owner: "Diretor de Operações",
      priority: "p0",
    },
    {
      id: "opt-fr-3",
      pillar: "strategic_repositioning",
      title: "Venda da unidade não-core de Curitiba",
      description:
        "Unidade secundária a 35% capacidade, fora da estratégia core (carne bovina sul). Sondagem inicial via Suzano Advisors indica interesse de 2 players regionais. Estimativa R$ 8-12M líquido.",
      estimatedImpactBRL: 10_000_000,
      horizonMonths: 12,
      effort: "high",
      owner: "Sócios + Banker",
      priority: "p1",
    },
    {
      id: "opt-fr-4",
      pillar: "value_focused_business_model",
      title: "Aporte de equity Hércules Capital",
      description:
        "Discussões iniciais com Hércules Capital indicam apetite por aporte de R$ 15M em troca de 30% do equity + 2 assentos no board. Founders concordam com diluição contra recapitalização.",
      estimatedImpactBRL: 15_000_000,
      horizonMonths: 9,
      effort: "high",
      owner: "Founders",
      priority: "p1",
    },
  ];
}

function optionsTextil(): StrategicOption[] {
  return [
    {
      id: "opt-tx-1",
      pillar: "operational_excellence",
      title: "Monitoramento trimestral dos covenants",
      description:
        "Manter relatório mensal de aderência (Dívida/EBITDA <= 3.5x, Liquidez >= 1.0, DSCR >= 1.2). Triagem precoce de deterioração.",
      horizonMonths: 36,
      effort: "low",
      owner: "Controladoria",
      priority: "p0",
    },
    {
      id: "opt-tx-2",
      pillar: "strategic_repositioning",
      title: "Diversificação de clientes (Nordeste)",
      description:
        "Prospecção de varejo regional em PE e BA para reduzir top-5 abaixo de 40%. Programa de 18 meses.",
      estimatedImpactBRL: 6_000_000,
      horizonMonths: 18,
      effort: "medium",
      owner: "Comercial",
      priority: "p1",
    },
    {
      id: "opt-tx-3",
      pillar: "value_focused_business_model",
      title: "Linha premium algodão orgânico",
      description:
        "Aproveitar capacidade ociosa para linha premium com margem 18%. Investimento de R$ 1.2M em maquinário específico.",
      estimatedImpactBRL: 3_500_000,
      horizonMonths: 12,
      effort: "medium",
      owner: "P&D",
      priority: "p1",
    },
    {
      id: "opt-tx-4",
      pillar: "financial_restructuring",
      title: "Antecipação parcial da dívida LP",
      description:
        "Com geração de caixa acima do projetado, antecipar R$ 3M de tranche LP em condições negociadas, reduzindo serviço de dívida.",
      estimatedImpactBRL: 800_000,
      horizonMonths: 6,
      effort: "low",
      owner: "CFO",
      priority: "p2",
    },
  ];
}

export function optionsFor(s: Scenario): StrategicOption[] {
  return s === "frigorifico" ? optionsFrigorifico() : optionsTextil();
}

// ─────────────────────────────────────────────────────────────────
// Executive Summary
// ─────────────────────────────────────────────────────────────────

interface ExecSummary {
  recommendationToLender: "continue_support" | "restructure" | "accelerated_ma" | "wind_down" | "undecided";
  rationale: string;
  keyRisks: string[];
  keyMitigations: string[];
  liquidityRunwayWeeks?: number;
  covenantHeadroom?: number;
}

export function execSummaryFor(s: Scenario): ExecSummary {
  if (s === "frigorifico") {
    return {
      recommendationToLender: "restructure",
      rationale:
        "Operação em distress severo (PL negativo, EBITDA negativo nos últimos 12 meses, 4/4 covenants em BREACH). Análise indica viabilidade condicional a: (i) reperfilamento de R$ 22M de CP para LP em 5 anos, (ii) execução do plano de redução de custos fixos de R$ 4M/ano (fechamento de Bagé, renegociação de terceirizados), e (iii) eventual venda da unidade não-core de Curitiba (R$ 8-12M). Sem reperfilamento, runway operacional ~6 semanas e RJ é cenário-base.",
      keyRisks: [
        "Concentração de clientes elevada (top-3 = 62% do faturamento)",
        "Inflação contínua de bovinos (+18% em 12 meses) pressiona CMV",
        "RJ de fornecedor estratégico (3 produtores rurais = 28% das compras)",
        "Pressão ESG crescente sobre o setor",
        "Ações trabalhistas em curso (R$ 4.2M)",
      ],
      keyMitigations: [
        "Reperfilamento de dívida CP→LP libera ~12 meses de runway",
        "Plano operacional de redução de custos com payback de 6 meses",
        "Sondagem de aporte de equity (Hércules Capital, R$ 15M)",
        "Hedge cambial parcial em curso para insumos importados",
        "Contratos LP com 2 redes de varejo asseguram baseline de receita",
      ],
      liquidityRunwayWeeks: 6,
      covenantHeadroom: -0.85,
    };
  }
  return {
    recommendationToLender: "continue_support",
    rationale:
      "Operação core viável após reperfilamento de Mar/2026 (sindicato bancário de 4 credores converteu R$ 22M de CP em LP, prazo 5 anos). Margem EBITDA recuperada para 10.8%, headroom de covenants em 18%, runway operacional > 38 semanas. Recomendação: manutenção do acordo atual com monitoramento trimestral.",
    keyRisks: [
      "Exposição cambial em insumos importados (~22% do CMV)",
      "Concentração de clientes top-5 = 47% da receita",
      "Pressão regulatória ambiental no setor têxtil",
    ],
    keyMitigations: [
      "Hedge cambial via NDF cobre 60% da exposição",
      "Programa de prospecção de varejo regional em curso",
      "Investimento de R$ 1.8M em ETE provisionado para conclusão até dez/2026",
    ],
    liquidityRunwayWeeks: 38,
    covenantHeadroom: 0.18,
  };
}
