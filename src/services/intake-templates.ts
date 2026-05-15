export type IntakeQuestionType =
  | "text"
  | "textarea"
  | "number"
  | "currency"
  | "date"
  | "select"
  | "multiselect"
  | "boolean";

export interface IntakeQuestion {
  id: string;
  block: "comercial" | "operacional" | "contratos" | "divida";
  label: string;
  type: IntakeQuestionType;
  required: boolean;
  options?: string[];
  helpText?: string;
}

export interface IntakeTemplate {
  sectorId: string;
  version: string;
  questions: IntakeQuestion[];
}

const COMMON_QUESTIONS: IntakeQuestion[] = [
  // ── Bloco Comercial ─────────────────────────────────────────────────
  {
    id: "com_main_clients",
    block: "comercial",
    label: "Liste os 5 maiores clientes e o % de participação no faturamento de cada um.",
    type: "textarea",
    required: true,
    helpText: "Indicar concentração ajuda a calibrar risco de receita.",
  },
  {
    id: "com_pricing_pressure",
    block: "comercial",
    label: "Houve mudança relevante na política de preços nos últimos 12 meses?",
    type: "textarea",
    required: false,
  },
  {
    id: "com_pipeline_12m",
    block: "comercial",
    label: "Pipeline contratado para os próximos 12 meses (R$).",
    type: "currency",
    required: false,
  },
  // ── Bloco Operacional ───────────────────────────────────────────────
  {
    id: "op_capacity_utilization",
    block: "operacional",
    label: "Utilização atual da capacidade produtiva/operacional (%).",
    type: "number",
    required: false,
  },
  {
    id: "op_critical_suppliers",
    block: "operacional",
    label: "Existem fornecedores críticos sem alternativa de substituição?",
    type: "textarea",
    required: true,
  },
  {
    id: "op_pending_capex",
    block: "operacional",
    label: "CAPEX pendente nos próximos 12 meses (R$).",
    type: "currency",
    required: false,
  },
  // ── Bloco Contratos ─────────────────────────────────────────────────
  {
    id: "ct_critical_contracts",
    block: "contratos",
    label: "Liste contratos críticos com cláusulas de change of control, MAC ou rescisão por inadimplência.",
    type: "textarea",
    required: true,
  },
  {
    id: "ct_litigation",
    block: "contratos",
    label: "Litígios materiais em curso (cíveis, trabalhistas, fiscais).",
    type: "textarea",
    required: false,
  },
  // ── Bloco Dívida ────────────────────────────────────────────────────
  {
    id: "dv_top_creditors",
    block: "divida",
    label: "5 maiores credores e saldo devedor por credor.",
    type: "textarea",
    required: true,
  },
  {
    id: "dv_covenants_breached",
    block: "divida",
    label: "Há covenants em quebra ou risco de quebra nos próximos 90 dias?",
    type: "textarea",
    required: true,
  },
  {
    id: "dv_guarantees",
    block: "divida",
    label: "Garantias prestadas (avais, fianças, alienação fiduciária).",
    type: "textarea",
    required: false,
  },
];

const SECTOR_OVERRIDES: Record<string, IntakeQuestion[]> = {
  varejo: [
    {
      id: "varejo_inventory_turnover",
      block: "operacional",
      label: "Giro de estoque atual (dias).",
      type: "number",
      required: true,
    },
    {
      id: "varejo_seasonality",
      block: "comercial",
      label: "Como a sazonalidade afeta o caixa? Indique meses fortes e fracos.",
      type: "textarea",
      required: true,
    },
  ],
  industria: [
    {
      id: "industria_raw_materials",
      block: "operacional",
      label: "Principais matérias-primas e exposição cambial (% importado).",
      type: "textarea",
      required: true,
    },
  ],
  agro: [
    {
      id: "agro_harvest_calendar",
      block: "operacional",
      label: "Calendário de safra e ciclo de caixa típico.",
      type: "textarea",
      required: true,
    },
  ],
  servicos: [],
  saude: [
    {
      id: "saude_revenue_mix",
      block: "comercial",
      label: "Mix de receita: SUS / convênios / particular (%).",
      type: "textarea",
      required: true,
    },
  ],
  educacao: [
    {
      id: "educacao_inadimplencia",
      block: "comercial",
      label: "Inadimplência por curso/segmento (últimos 12 meses).",
      type: "textarea",
      required: true,
    },
  ],
  default: [],
};

export function getIntakeTemplate(sectorId: string | null | undefined): IntakeTemplate {
  const key = (sectorId ?? "default").toLowerCase();
  const overrides = SECTOR_OVERRIDES[key] ?? SECTOR_OVERRIDES.default ?? [];
  return {
    sectorId: key,
    version: "v1.0",
    questions: [...COMMON_QUESTIONS, ...overrides],
  };
}
