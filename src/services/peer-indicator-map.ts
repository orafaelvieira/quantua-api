/**
 * Mapa: nome do indicador NOSSO (indicator-calculator) → conta de INDICADOR na base de pares
 * B3 (PeerLine, documento="INDICADOR"). Só entram indicadores SIZE-INDEPENDENT (ratios, %, dias)
 * — absolutos em R$ (Capital de Giro, NCG, Dívida Líquida, Capital de Terceiros) NÃO entram
 * porque são incomparáveis entre portes. Escalas conferidas vs a base (margens decimais,
 * liquidez ~1-2, ciclo/PM em dias, ROE/ROA decimais, ICJ/Dív.Líq÷LucroOp como múltiplos).
 *
 * Ausente do mapa = sem par confiável (a comparação simplesmente não é exibida).
 */
export const PEER_INDICATOR_MAP: Record<string, string> = {
  "Margem Bruta": "MARGEM BRUTA",
  "Margem Operacional": "MARGEM OPERACIONAL",
  "Margem Líquida": "MARGEM LIQUIDA",
  "Liquidez Corrente": "LIQUIDEZ CORRENTE",
  "Liquidez Seca": "LIQUIDEZ SECA",
  "Liquidez Imediata": "LIQUIDEZ IMEDIATA",
  "Liquidez Geral": "LIQUIDEZ GERAL",
  "Ciclo Financeiro": "CICLO FINANCEIRO",
  "Prazo Médio Contas a Receber": "PM - CONTAS A RECEBER",
  "Prazo Médio Estoque": "PM - ESTOQUES",
  "Prazo Médio Fornecedores": "PM - PAGAMENTO",
  "ROA (Retorno sobre Ativos)": "ROA - RETORNO S/ ATIVO",
  "ROE (Retorno sobre Patrimônio Líquido)": "ROE - RETORNO S/ PL",
  "Giro do Ativo": "GIRO DO ATIVO",
  "Índice de Cobertura de Juros": "ÍNDICE DE COBERTURA DE JUROS (ICJ)",
  "Dívida Líquida/Lucro Operacional": "DÍVIDA LÍQUIDA / LUCRO OPERACIONAL",
  "Endividamento Geral": "% PARTIC CAPITAL TERCEIROS",
};

/**
 * Polaridade: true = MAIOR é melhor (margens, liquidez, retornos, cobertura, giro);
 * false = MENOR é melhor (ciclo/prazos longos, alavancagem, endividamento). Usado pelo
 * semáforo dinâmico para traduzir o percentil vs pares em ok/atenção/crítico.
 */
export const PEER_HIGHER_IS_BETTER: Record<string, boolean> = {
  "Margem Bruta": true,
  "Margem Operacional": true,
  "Margem Líquida": true,
  "Liquidez Corrente": true,
  "Liquidez Seca": true,
  "Liquidez Imediata": true,
  "Liquidez Geral": true,
  "Ciclo Financeiro": false,
  "Prazo Médio Contas a Receber": false,
  "Prazo Médio Estoque": false,
  // PM Pagamento: prazo maior = mais financiamento de fornecedor → melhor working
  // capital (reduz o Ciclo Financeiro). Em distress, esticar fornecedor pode ser
  // sinal de stress — a IA nuança no diagnóstico; a polaridade-base segue a convenção.
  "Prazo Médio Fornecedores": true,
  "ROA (Retorno sobre Ativos)": true,
  "ROE (Retorno sobre Patrimônio Líquido)": true,
  "Giro do Ativo": true,
  "Índice de Cobertura de Juros": true,
  "Dívida Líquida/Lucro Operacional": false,
  "Endividamento Geral": false,
};

/** Conta da base B3 para um indicador nosso, ou null se não houver par confiável. */
export function peerContaFor(nomeIndicador: string): string | null {
  return PEER_INDICATOR_MAP[nomeIndicador] ?? null;
}

/** true se maior é melhor; default true quando não mapeado. */
export function higherIsBetter(nomeIndicador: string): boolean {
  return PEER_HIGHER_IS_BETTER[nomeIndicador] ?? true;
}
