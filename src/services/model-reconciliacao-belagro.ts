/**
 * RECONCILIAÇÃO vs. a planilha de referência (Business Plan Belagro).
 *
 * Decisão de 19/07/2026: ao replicar a planilha no Quantua, CORRIGIR os
 * defeitos em vez de reproduzi-los — mas com PROVA. Este catálogo é a prova:
 * cada item diz onde a planilha erra, o que ela devolve, o que o motor devolve
 * e por quê. A tela lista tudo para o analista auditar item a item.
 *
 * "Verde só com prova" aplicado à migração: o número do Quantua vai divergir da
 * planilha em pontos conhecidos, e cada divergência tem nome, causa e efeito.
 *
 * Fonte: PLANO_BUSINESS_PLAN_BELAGRO.md, Parte 4 (engenharia reversa completa
 * das 18 abas de `Business Plan - Belagro_mai.26.xlsm`).
 *
 * Determinístico: catálogo estático, sem I/O.
 */

/** Quanto o defeito distorce o resultado. */
export type Severidade = "alta" | "media" | "baixa";

/** O que a correção muda no número final. */
export type EfeitoNoNumero = "altera-resultado" | "altera-apresentacao" | "evita-quebra-futura";

export interface DivergenciaPlanilha {
  id: string;
  /** Aba e célula/linha na planilha. */
  onde: string;
  titulo: string;
  severidade: Severidade;
  efeito: EfeitoNoNumero;
  /** O comportamento da planilha. */
  planilha: string;
  /** O comportamento do Quantua. */
  motor: string;
  /** Por que a correção é a leitura certa. */
  porque: string;
}

/**
 * Os 16 defeitos encontrados na engenharia reversa, do mais material ao menos.
 * A ordem é a de revisão sugerida na tela.
 */
export const DIVERGENCIAS_BELAGRO: DivergenciaPlanilha[] = [
  {
    id: "depreciacao-duplicada",
    onde: "DF_Histórico — conta 04.2.1.99.013 nas linhas C98 e C147",
    titulo: "Depreciação contada duas vezes",
    severidade: "alta",
    efeito: "altera-resultado",
    planilha:
      "A mesma conta entra nas Despesas Gerais Administrativas (que compõem o EBITDA) e de novo na linha de Depreciação/Amortização abaixo do EBITDA. O Lucro Líquido é remendado com um −X147 nas colunas mensais, mas o remendo NÃO existe nas colunas anuais F/G.",
    motor:
      "A conta alimenta exclusivamente a linha de Depreciação/Amortização. O EBITDA fica limpo de D&A por construção, e o anual é sempre a soma dos meses já corrigidos.",
    porque:
      "EBITDA é resultado ANTES de depreciação. Contá-la dentro das despesas operacionais subestima o EBITDA e, sem o remendo, o Lucro Líquido anual também.",
  },
  {
    id: "conta-nao-mapeada",
    onde: "DF_Histórico C37 → Realizado coluna D (conta 04.1.1.01.015, Combustíveis)",
    titulo: "Conta existe na origem e não chega ao Realizado",
    severidade: "alta",
    efeito: "altera-resultado",
    planilha:
      "A conta tem −R$ 363.155,78 em mai/26 no DF_Histórico e não está mapeada na coluna D do Realizado. O VLOOKUP simplesmente não a alcança e o check de Lucro Líquido (AK471) não fecha. O próprio Claude Log da planilha registra o caso em aberto.",
    motor:
      "O carregamento exige IGUALDADE DE CONJUNTOS entre as contas da origem e as contas mapeadas. Conta sem destino bloqueia o fechamento e aparece na fila de classificação, com o valor que está deixando de entrar.",
    porque:
      "O modo de falha é silencioso: a conta some do resultado sem erro visível. Exigir o conjunto fechado é o que transforma um vazamento mudo num aviso.",
  },
  {
    id: "balanco-projetado-nao-fecha",
    onde: "Forecast linha 432 (Check = Ativo − Passivo+PL)",
    titulo: "Balanço projetado fecha em −0,35",
    severidade: "alta",
    efeito: "altera-resultado",
    planilha:
      "O check dá exatamente 0 nos meses realizados e −0,35 em TODOS os meses projetados — um desequilíbrio permanente, provavelmente herdado do ajuste de dívida de out/2025.",
    motor:
      "Ativo = Passivo + PL é asserção dura do motor, não célula de conferência. Balanço que não fecha é erro que interrompe, com a memória de qual linha desequilibrou.",
    porque:
      "Um balanço que não fecha invalida o fluxo de caixa indireto inteiro, que é derivado das variações dele.",
  },
  {
    id: "divida-orfa",
    onde: "Forecast linhas 332–337 vs. linhas 413/421 e 262",
    titulo: "Cronograma de dívida calculado e não utilizado",
    severidade: "alta",
    efeito: "altera-resultado",
    planilha:
      "O saldo devedor (linha 336) é calculado corretamente, mas as linhas de dívida do balanço (413 curto prazo e 421 longo prazo) fazem carry-forward do mês anterior em vez de consumi-lo. Os juros (linha 337) nunca chegam à despesa financeira (linha 262).",
    motor:
      "O bloco de dívida alimenta o balanço e a DRE: saldo devedor vai para o passivo (com split circulante/não circulante pelo vencimento) e os juros vão para a despesa financeira.",
    porque:
      "Sem a ligação, a projeção mostra dívida congelada e resultado sem custo financeiro — os dois erros a favor da empresa.",
  },
  {
    id: "anual-soma-em-vez-de-subtrair",
    onde: "Orçamento colunas CD/CE — linhas 192, 209, 214, 376, 462, 469",
    titulo: "Totais anuais de 2024/2025 somam o que deveriam subtrair",
    severidade: "alta",
    efeito: "altera-resultado",
    planilha:
      "O mensal faz I192 = I154 − I167 − I179, mas o anual faz CD192 = CD154 + CD167 + CD179. Como as deduções são digitadas positivas, o total anual erra por 2× as deduções. As colunas CF..CI já usam a forma correta (SUMIF sobre a linha mensal).",
    motor:
      "Todo total anual é a soma dos meses da linha JÁ CALCULADA. Não existe fórmula anual paralela que possa divergir da mensal.",
    porque:
      "Duas fórmulas para o mesmo número é a origem clássica da divergência. Uma só, derivada, não tem como discordar de si mesma.",
  },
  {
    id: "ncg-duas-definicoes",
    onde: "Dashboard linha 27 vs. Resumo linha 164",
    titulo: "NCG/CDG definidos de dois jeitos incompatíveis",
    severidade: "media",
    efeito: "altera-resultado",
    planilha:
      "O Dashboard usa as contas {479,480,481,484} contra {513,515,516,517}; o Resumo usa {67,68,69,71,72} contra {88,89,90,91,92}, incluindo Adiantamentos de clientes no passivo. As duas telas mostram NCG diferente para o mesmo mês.",
    motor:
      "Uma única definição de Necessidade de Capital de Giro, calculada no motor e consumida por todas as telas.",
    porque:
      "Indicador com duas definições não é indicador — é duas opiniões. Qual das telas está certa não é decidível olhando a planilha.",
  },
  {
    id: "ncg-casca-ref",
    onde: "NCG_Fluxo de Caixa linha 5",
    titulo: "A aba de NCG não calcula NCG",
    severidade: "media",
    efeito: "altera-apresentacao",
    planilha:
      "A linha 5 é COLUMN()-COLUMN(#REF!) nas 72 colunas — referência quebrada. A aba inteira é um espelho de pass-through do Forecast e não contém nenhum cálculo de NCG, apesar do nome.",
    motor: "NCG, CDG e Saldo de Tesouraria são calculados e exibidos na tela que leva o nome deles.",
    porque: "Uma aba cujo nome promete um cálculo que ela não faz induz o leitor ao erro.",
  },
  {
    id: "ancora-fiscal-2029",
    onde: "DF_Histórico coluna BP (jan/2029) e BQ (fev/2029)",
    titulo: "A âncora de descumulação quebra em 2029",
    severidade: "media",
    efeito: "evita-quebra-futura",
    planilha:
      "As contas de resultado zeram em janeiro, então o mensal é o acumulado menos a soma do ano. As âncoras são jan/2025, jan/2026, jan/2027, jan/2028 — mas jan/2029 (BP) continua ancorado em jan/2025, e fev/2029 (BQ) não subtrai nada.",
    motor: "A âncora é derivada do exercício de cada mês, não de uma referência escrita coluna a coluna.",
    porque: "O padrão está certo em quatro anos e errado no quinto — o tipo de defeito que só aparece quando o ano chega.",
  },
  {
    id: "subtotais-mudam-de-faixa",
    onde: "DF_Histórico linhas 44, 78, 213, 227, 235 (colunas F vs. G em diante)",
    titulo: "Subtotais mudam de faixa entre as colunas",
    severidade: "media",
    efeito: "altera-resultado",
    planilha:
      "F44 = SUM(F45:F64) mas G44 = SUM(G45:G62): as linhas 63–64 (Ajuda de Custo, Outros Benefícios) somem do subtotal a partir de 2024. O mesmo em R78, onde Comissões sobre vendas (linha 84) cai fora.",
    motor: "O subtotal de um grupo é a soma das linhas do grupo, igual em todos os períodos.",
    porque: "Contas que existem e não entram em nenhum subtotal desaparecem do resultado sem deixar rastro.",
  },
  {
    id: "amortizacao-nao-reconcilia",
    onde: "Endividamento — faixa de Amortização (T:CA) vs. faixa de Saldo Devedor (CC:EJ)",
    titulo: "Amortização não reconcilia com o saldo devedor",
    severidade: "media",
    efeito: "altera-resultado",
    planilha:
      "A amortização dispara em toda a janela do contrato, inclusive nos meses ANTERIORES à data-base, mas a parcela é dimensionada só para os meses posteriores (saldo ÷ parcelas restantes). No contrato da linha 8, a faixa soma R$ 362.500 contra um saldo real de R$ 237.500.",
    motor:
      "A amortização começa na data-base e o somatório fecha exatamente com o saldo devedor. Meses anteriores são histórico, não projeção.",
    porque: "As duas faixas descrevem o mesmo contrato e precisam contar a mesma história.",
  },
  {
    id: "taxa-mensal-simples",
    onde: "Endividamento coluna J (Taxa a.m = Taxa a.a ÷ 12)",
    titulo: "Taxa mensal simples em vez de composta",
    severidade: "media",
    efeito: "altera-resultado",
    planilha:
      "A taxa mensal é a anual dividida por 12. Para 14,40% a.a., usa 1,200% a.m. quando o equivalente composto é 1,128% a.m.",
    motor: "Taxa mensal equivalente composta: (1 + taxa anual)^(1/12) − 1 — doze meses fecham exatamente o ano.",
    porque: "A diferença parece pequena no mês e é material num contrato de três anos, sempre superestimando o juro.",
  },
  {
    id: "sem-indexador",
    onde: "Endividamento coluna L (Indexador)",
    titulo: "Indexador registrado e nunca usado",
    severidade: "media",
    efeito: "altera-resultado",
    planilha:
      'A coluna registra "CDI+Taxa", "Pré Fixado TLP", "DI Over CETIP", "CDI+Taxa(Câmbio)" — e NENHUMA fórmula da planilha lê essa coluna. Todo contrato é achatado numa taxa fixa congelada na data-base.',
    motor:
      "O contrato guarda índice de referência e spread, e projeta pela curva do índice (snapshot Focus/BCB do modelo, versionado).",
    porque: "Um contrato CDI+spread projetado com o CDI congelado não é uma projeção do contrato — é uma foto dele.",
  },
  {
    id: "vlookup-primeira-ocorrencia",
    onde: "Realizado — VLOOKUP sobre DF_Histórico!$C:$CA",
    titulo: "Conta duplicada só é alcançada na primeira ocorrência",
    severidade: "baixa",
    efeito: "altera-resultado",
    planilha:
      "VLOOKUP devolve a primeira linha que casa. Como 04.2.1.99.013 aparece em C98 e C147, a segunda ocorrência é inalcançável — o que mascara a duplicidade em vez de denunciá-la.",
    motor: "Código de conta é chave única. Duplicidade é erro de carga e aparece como tal.",
    porque: "O comportamento de primeira-ocorrência esconde exatamente o defeito que deveria expor.",
  },
  {
    id: "setembro-duplicado",
    onde: "Livro Fiscal — coluna N repete 2025-09",
    titulo: "Setembro/2025 aparece duas vezes no cabeçalho",
    severidade: "baixa",
    efeito: "evita-quebra-futura",
    planilha: "O cabeçalho tem 61 colunas para 60 meses: setembro/2025 está em M e de novo em N (sempre vazia).",
    motor: "O período é chave; um mês existe uma vez só.",
    porque: "Qualquer mapeamento posicional coluna→mês erra de um mês inteiro a partir de outubro.",
  },
  {
    id: "relatorio-anos-fixos",
    onde: "Relatório — colunas I:T (2024) e U:AF (2025)",
    titulo: "Relatório com anos fixos no código",
    severidade: "baixa",
    efeito: "evita-quebra-futura",
    planilha:
      "As faixas de meses de cada ano estão escritas na fórmula. O relatório continua dizendo 2024 vs 2025 depois da virada do ano, sem nenhum aviso.",
    motor: "O período do relatório é parâmetro, e a data de geração sai no cabeçalho junto com o cenário e a fonte.",
    porque: "Relatório que envelhece em silêncio é pior que relatório que se recusa a rodar.",
  },
  {
    id: "indicadores-errados-resumo",
    onde: "Resumo — U175 e rótulo da linha 180",
    titulo: "Indicador aponta para célula errada e rótulo trocado",
    severidade: "baixa",
    efeito: "altera-apresentacao",
    planilha:
      "U175 (Cobertura de Juros do total) calcula U100/U64 — Capital Social dividido por uma linha vazia. E a linha 180, rotulada 'Retorno sobre PL (ROA)', calcula corretamente o ROA mas leva o nome do ROE.",
    motor: "Cada indicador tem uma definição única no catálogo, com nome, fórmula e memória de cálculo.",
    porque: "Indicador com rótulo errado é lido errado por quem confia no rótulo.",
  },
];

/** Contagem por severidade — cabeçalho do painel. */
export function resumoDivergencias(): { alta: number; media: number; baixa: number; total: number } {
  const c = { alta: 0, media: 0, baixa: 0, total: DIVERGENCIAS_BELAGRO.length };
  for (const d of DIVERGENCIAS_BELAGRO) c[d.severidade]++;
  return c;
}
