export interface BPLineItem {
  classificacao: string; // AT, AC, AF, AO, ANC, PT, PC, PO, PF, PNC, PL, "0"
  conta: string;
  valores: Record<string, number>;
  nivel: number; // 0 = root (AT/PT), 1 = group (AC/ANC/PC/PNC/PL), 2 = subgroup, 3 = detail
  editado: boolean;
}

export interface DRELineItem {
  conta: string;
  valores: Record<string, number>;
  subtotal: boolean;
  editado: boolean;
}

export interface Indicador {
  tipo: string;
  nome: string;
  formula: string;
  tipoDado: "R$" | "%" | "Índice" | "Dias" | "Texto";
  valores: Record<string, number | string | null>;
  status: Record<string, "ok" | "atencao" | "critico" | null>;
  overrides: Record<string, number | null>;
}

export interface UnmatchedAccount {
  conta: string;
  valores: Record<string, number>;
  contexto?: string; // Hierarquia de linhas-pai (ex: "ATIVO > CIRCULANTE")
  tipo?: "BP" | "DRE"; // qual dicionário/dropdown usar na tela de classificação
}

export interface DadosEstruturados {
  bp: BPLineItem[];
  dre: DRELineItem[];
  indicadores: Indicador[];
  periodos: string[];
  unmatchedAccounts?: UnmatchedAccount[];
  version: number;
}
