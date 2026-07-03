/**
 * MAPA CVM → MODELO QUANTUA — o coração da ingestão de pares.
 *
 * Os dados abertos da CVM (DFP/ITR) usam um plano de contas PADRONIZADO (CD_CONTA):
 * o mapeamento para o nosso modelo é uma TABELA FIXA — determinístico, sem IA, sem
 * dicionário. Com os statements montados, os pares passam pelo MESMO
 * `calculateIndicators` da empresa do IBR: comparabilidade perfeita.
 *
 * Referência (estrutura fixa da CVM):
 *   1        Ativo Total                     2        Passivo Total
 *   1.01     Ativo Circulante                2.01     Passivo Circulante
 *   1.01.01  Caixa e Equivalentes            2.01.02  Fornecedores
 *   1.01.02  Aplicações Financeiras          2.01.04  Empréstimos e Financiamentos
 *   1.01.03  Contas a Receber                2.02     Passivo Não Circulante
 *   1.01.04  Estoques                        2.02.01  Empréstimos e Financiamentos
 *   1.01.06  Tributos a Recuperar            2.03     Patrimônio Líquido (consolidado)
 *   1.02     Ativo Não Circulante            2.03.01  Capital Social
 *   1.02.01  Realizável a Longo Prazo        2.03.04  Reservas de Lucros
 *   1.02.02  Investimentos                   2.03.05  Lucros/Prejuízos Acumulados
 *   1.02.03  Imobilizado
 *   1.02.04  Intangível
 *   3.01  Receita (JÁ LÍQUIDA na CVM)        3.06     Resultado Financeiro
 *   3.02  Custo dos Bens/Serviços            3.06.01  Receitas Financeiras
 *   3.04.01  Despesas com Vendas             3.06.02  Despesas Financeiras
 *   3.04.02  Despesas Gerais/Administrativas 3.08     IR/CSLL
 *   3.04.04  Outras Receitas Operacionais    3.11     Lucro/Prejuízo Consolidado
 *   3.04.05  Outras Despesas Operacionais    6.01/6.02/6.03  FCO/FCI/FCF (DFC)
 *   3.04.06  Equivalência Patrimonial
 */

/** BP: CD_CONTA da CVM → conta do modelo padrão Quantua (inputs de nível 2). */
export const CVM_BP_MAP: Record<string, string> = {
  "1": "Ativo Total",
  "1.01": "Ativo Circulante",
  "1.01.01": "Caixa e Equivalentes de Caixa",
  "1.01.02": "Aplicações Financeiras - CP", // não existe no modelo → cai em Outros via caller
  "1.01.03": "Contas a Receber - CP",
  "1.01.04": "Estoques - CP",
  "1.01.06": "Tributos a Recuperar - CP",
  "1.02": "Ativo Não Circulante",
  "1.02.01": "Realizável a Longo Prazo",
  "1.02.02": "Investimentos",
  "1.02.03": "Imobilizado",
  "1.02.04": "Intangível",
  "2": "Passivo Total",
  "2.01": "Passivo Circulante",
  "2.01.02": "Fornecedores - CP",
  "2.01.04": "Empréstimos e Financiamentos - CP",
  "2.02": "Passivo Não Circulante",
  "2.02.01": "Empréstimos e Financiamentos - LP",
  "2.03": "Patrimônio Líquido",
  "2.03.01": "Capital Social",
  "2.03.04": "Reservas de Lucros",
  "2.03.05": "Lucros/Prejuízos Acumulados",
};

/** Classificação (código de grupo) de cada conta do modelo — necessário porque o
 *  calculateIndicators soma AO/PO por classificação (NCG) e monta o BPLineItem. */
export const CVM_BP_CLASSIF: Record<string, string> = {
  "Ativo Total": "AT",
  "Ativo Circulante": "AC",
  "Caixa e Equivalentes de Caixa": "AF",
  "Aplicações Financeiras - CP": "AF",
  "Contas a Receber - CP": "AO",
  "Estoques - CP": "AO",
  "Tributos a Recuperar - CP": "AO",
  "Ativo Não Circulante": "ANC",
  "Realizável a Longo Prazo": "ANC",
  "Investimentos": "ANC",
  "Imobilizado": "ANC",
  "Intangível": "ANC",
  "Passivo Total": "PT",
  "Passivo Circulante": "PC",
  "Fornecedores - CP": "PO",
  "Empréstimos e Financiamentos - CP": "PF",
  "Passivo Não Circulante": "PNC",
  "Empréstimos e Financiamentos - LP": "PNC",
  "Patrimônio Líquido": "PL",
  "Capital Social": "PL",
  "Reservas de Lucros": "PL",
  "Lucros/Prejuízos Acumulados": "PL",
};

/** Nível da conta no modelo (0 total · 1 grupo · 2 input) — para o BPLineItem. */
export const CVM_BP_NIVEL: Record<string, number> = {
  "Ativo Total": 0, "Passivo Total": 0,
  "Ativo Circulante": 1, "Ativo Não Circulante": 1,
  "Passivo Circulante": 1, "Passivo Não Circulante": 1, "Patrimônio Líquido": 1,
};

/** DRE: CD_CONTA da CVM → conta do modelo. ATENÇÃO: 3.01 da CVM já é receita LÍQUIDA —
 *  entra como "Receita Bruta" com deduções zero (a cascata resolve RL = RB).
 *
 *  SUBTOTAIS OFICIAIS (3.03/3.05/3.09/3.11) são mapeados de propósito: o motor
 *  PREFERE subtotal explícito e só cai na cascata quando ausente. Sem eles, a
 *  cascata subtraía a D&A (injetada do DFC p/ EBITDA) de um custo que JÁ a embute
 *  — dupla contagem que subestimava o LL exatamente pela D&A (pego na validação
 *  cruzada vs planilha independente: Petrobras 2025 LL 26bi vs 110,6bi oficial).
 *  Com os subtotais oficiais, LL/EBIT/Lucro Bruto = CVM, e o EBITDA verdadeiro é
 *  derivado na ingestão (EBIT + |D&A|). 3.09 e 3.11 apontam ambos p/ Lucro Líquido:
 *  o arquivo lista 3.09 antes de 3.11, então 3.11 (consolidado, incl. operações
 *  descontinuadas) sobrescreve; se 3.11 faltar, fica o 3.09 — fallback natural. */
export const CVM_DRE_MAP: Record<string, string> = {
  "3.01": "Receita Bruta",
  "3.02": "Custo Operacional",
  "3.03": "Lucro Bruto",
  "3.04.01": "Despesas com Vendas",
  "3.04.02": "Despesas Gerais e Administrativas",
  "3.04.04": "Outras Receitas Operacionais",
  "3.04.05": "Outras Despesas Operacionais",
  "3.04.06": "Equivalência Patrimonial",
  "3.05": "EBIT",
  "3.06.01": "Receitas Financeiras",
  "3.06.02": "Despesas Financeiras",
  "3.08": "IR e CSLL",
  "3.09": "Lucro Líquido",
  "3.11": "Lucro Líquido",
};

/** DFC (método indireto): totais dos três fluxos — alimentam Dickinson dos pares. */
export const CVM_DFC_MAP: Record<string, "fco" | "fci" | "fcf"> = {
  "6.01": "fco",
  "6.02": "fci",
  "6.03": "fcf",
};

/** Setores CVM/B3 fora do escopo v1 (plano de contas próprio distorce percentis). */
export const CVM_EXCLUIR_DENOM = /\b(BANCO|BCO|SEGURADORA|SEGUROS|FINANCEIRA|CR[ÉE]DITO|CAPITALIZA[ÇC][ÃA]O|PREVID[ÊE]NCIA)\b/i;
