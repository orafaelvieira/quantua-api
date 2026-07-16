/**
 * GUIA "o que entra / o que NÃO entra" por conta do modelo padrão.
 * Exibido nos dropdowns de classificação (auditoria) e editável no editor de modelos —
 * o seed só PREENCHE onde está vazio (nunca sobrescreve texto editado pelo usuário).
 * Linguagem para analista júnior: direta, com exemplos brasileiros.
 */
export const GUIA_LINHAS: Record<string, string> = {
  // ── DRE ──
  "Receita Bruta": "Entra: faturamento total de vendas/serviços ANTES de impostos e devoluções (vendas de produtos, mercadorias, serviços). NÃO entra: receitas financeiras, venda de imobilizado, receitas não ligadas à operação.",
  "Deduções da Receita Bruta": "Entra: devoluções, abatimentos, descontos incondicionais e impostos INCIDENTES SOBRE VENDAS quando vierem agregados. NÃO entra: despesas operacionais, inadimplência.",
  "Impostos s/ Faturamento": "Entra: ICMS, ISS, PIS/COFINS sobre vendas, Simples Nacional — tributos PROPORCIONAIS à receita. NÃO entra: IRPJ/CSLL (vão em IR e CSLL), IPTU/IPVA/taxas (vão em Despesas Gerais e Adm.), multas e juros de tributos (Despesas Financeiras).",
  "Custo Operacional": "Entra: CMV/CPV/CSP — matéria-prima, mercadoria revendida, mão de obra e gastos DA PRODUÇÃO/serviço prestado (inclui energia e aluguel da fábrica). NÃO entra: despesas administrativas/comerciais, depreciação destacada.",
  "Despesas Gerais e Administrativas": "Entra: salários administrativos, pró-labore, aluguel do escritório, contabilidade, energia/água/telefone administrativos, taxas, IPTU/IPVA, materiais de escritório. NÃO entra: gastos da produção (Custo), comissões de venda (Despesas com Vendas), juros (Despesas Financeiras).",
  "Despesas com Vendas": "Entra: comissões, fretes sobre vendas, marketing de vendas, embalagens de entrega, inadimplência (PDD). NÃO entra: fretes sobre COMPRAS (Custo), salários administrativos.",
  "Despesas com Marketing": "Entra: publicidade, mídia, agências, eventos promocionais, patrocínios. NÃO entra: comissões de vendedores (Despesas com Vendas).",
  "Despesas com P&D": "Entra: pesquisa e desenvolvimento de produtos — pessoal técnico dedicado, protótipos, testes. NÃO entra: manutenção corriqueira de sistemas.",
  "Despesas com Pessoas": "Entra: folha e encargos quando a empresa destaca pessoal como bloco próprio (salários, FGTS, INSS, benefícios, provisões trabalhistas). NÃO entra: pró-labore destacado como administrativo, mão de obra DA PRODUÇÃO (Custo).",
  "Outras Receitas Operacionais": "Entra: receitas ligadas à operação que não são faturamento — recuperação de despesas, créditos tributários operacionais, bonificações recebidas. NÃO entra: receitas financeiras (juros/rendimentos), venda de imobilizado.",
  "Outras Despesas Operacionais": "Entra: despesas operacionais que não se encaixam nas linhas específicas — use com PARCIMÔNIA (o ideal é classificar na linha certa). NÃO entra: juros/multas (Financeiras), IR/CSLL, perdas não operacionais.",
  "Depreciação e Amortização": "Entra: depreciação de imobilizado e amortização de intangível DESTACADAS na DRE. NÃO entra: depreciação embutida no custo de produção (fica no Custo).",
  "Equivalência Patrimonial": "Entra: resultado de participações em controladas/coligadas (positivo ou negativo). NÃO entra: dividendos recebidos de aplicações.",
  "Receitas Financeiras": "Entra: rendimentos de aplicações, juros ativos recebidos, descontos obtidos, variações cambiais ativas. NÃO entra: receita de vendas.",
  "Despesas Financeiras": "Entra: juros de empréstimos, tarifas bancárias, IOF, juros/multas de mora e de parcelamentos tributários, descontos concedidos, variações cambiais passivas. NÃO entra: amortização do PRINCIPAL da dívida (não passa pela DRE).",
  "Outras Receitas Não Operacionais": "Entra: ganhos fora da operação — venda de imobilizado com lucro, indenizações recebidas. NÃO entra: receitas recorrentes da operação.",
  "Outras Despesas Não Operacionais": "Entra: perdas fora da operação — baixa/venda de imobilizado com prejuízo, sinistros. NÃO entra: despesas recorrentes da operação.",
  "IR e CSLL": "Entra: Imposto de Renda e Contribuição Social SOBRE O LUCRO (inclusive parcela do Simples quando destacada como IRPJ/CSLL). NÃO entra: impostos sobre vendas, IRRF retido de terceiros.",

  // ── BP · Ativo ──
  "Caixa e Equivalentes de Caixa": "Entra: caixa, bancos conta movimento, aplicações de liquidez imediata (resgate em até 90 dias). NÃO entra: aplicações de longo prazo, bloqueios judiciais.",
  "Contas a Receber - CP": "Entra: duplicatas/clientes a receber no curto prazo, cartões a receber. NÃO entra: adiantamentos a fornecedores, créditos com sócios.",
  "Estoques - CP": "Entra: matéria-prima, produtos em elaboração, produtos acabados, mercadorias para revenda, embalagens. NÃO entra: imobilizado, material de escritório relevante.",
  "Tributos a Recuperar - CP": "Entra: ICMS/PIS/COFINS/IR a recuperar ou compensar no curto prazo. NÃO entra: tributos A PAGAR (passivo).",
  "Despesas Ant. / Adiantamentos - Ativo": "Entra: despesas pagas antecipadamente (seguros, aluguéis), adiantamentos a fornecedores e a funcionários (férias, viagens). NÃO entra: empréstimos a sócios (Partes Relacionadas).",
  "Outros Créditos a Receber - CP": "Entra: créditos diversos de curto prazo que não são clientes — depósitos a resgatar, valores a receber diversos. Use quando não houver linha específica.",
  "Ativos com Partes Relacionadas - CP": "Entra: empréstimos/mútuos a sócios, controladas ou coligadas a receber no curto prazo. NÃO entra: clientes normais.",
  "Realizável a Longo Prazo": "Entra: créditos com vencimento após 12 meses sem linha específica — depósitos compulsórios, créditos diversos LP. NÃO entra: imobilizado, investimentos.",
  "Investimentos": "Entra: participações societárias em outras empresas, imóveis para renda. NÃO entra: aplicações financeiras (Caixa/Aplicações), imobilizado de uso.",
  "Imobilizado": "Entra: máquinas, veículos, móveis, imóveis de uso, benfeitorias, obras em andamento — valor BRUTO (a depreciação acumulada vai na linha (-) Depreciação). NÃO entra: bens para revenda (Estoque).",
  "(-) Depreciação": "Entra: depreciação/exaustão ACUMULADA do imobilizado — valor NEGATIVO (redutora). O líquido do imobilizado = Imobilizado + esta linha. NÃO entra: a despesa de depreciação do ano (essa é da DRE).",
  "Intangível": "Entra: marcas, patentes, softwares, fundo de comércio, ágio — valor BRUTO (a amortização acumulada vai na linha (-) Amortização). NÃO entra: bens físicos.",
  "(-) Amortização": "Entra: amortização ACUMULADA do intangível — valor NEGATIVO (redutora). O líquido do intangível = Intangível + esta linha. NÃO entra: a despesa de amortização do ano (essa é da DRE).",

  // ── BP · Passivo ──
  "Fornecedores - CP": "Entra: duplicatas a pagar a fornecedores de mercadorias/insumos/serviços no curto prazo. NÃO entra: empréstimos bancários, parcelamentos de tributos.",
  "Obrigações Trabalhistas - CP": "Entra: salários a pagar, pró-labore a pagar, FGTS/INSS a recolher, provisões de férias e 13º, rescisões. NÃO entra: tributos sobre vendas ou lucro.",
  "Obrigações Tributárias - CP": "Entra: impostos e contribuições a recolher (ICMS, ISS, PIS/COFINS, IRPJ), tributos retidos a recolher e PARCELAMENTOS com parcelas no curto prazo. NÃO entra: FGTS/INSS da folha (Trabalhistas).",
  "Empréstimos e Financiamentos - CP": "Entra: parcelas de empréstimos/financiamentos bancários vencíveis em 12 meses, conta garantida, desconto de duplicatas/títulos descontados. NÃO entra: fornecedores, parcelamentos de tributos (Obrigações Tributárias).",
  "Passivos com Partes Relacionadas - CP": "Entra: mútuos/empréstimos DE sócios ou empresas do grupo a pagar no curto prazo. NÃO entra: empréstimos bancários.",
  "Despesas Ant. / Adiantamentos - Passivo": "Entra: adiantamentos DE CLIENTES (valores recebidos por entregas futuras), receitas antecipadas. NÃO entra: adiantamentos A fornecedores (é ativo).",
  "Outros Passivos Circulantes": "Entra: obrigações diversas de curto prazo sem linha específica. Use com parcimônia — prefira a linha certa.",
  "Obrigações Tributárias - LP": "Entra: parcelamentos tributários (REFIS, PERT, ICMS parcelado) com vencimento após 12 meses. NÃO entra: tributos correntes do mês.",
  "Empréstimos e Financiamentos - LP": "Entra: parcelas de dívida bancária vencíveis após 12 meses (capital de giro LP, FINAME, BNDES, debêntures). NÃO entra: parcelamentos de tributos, contas a pagar comerciais.",
  "Adiantamento para Futuro Aumento Capital - LP": "Entra: AFAC — aportes de sócios aguardando capitalização. NÃO entra: mútuos comuns de sócios (Partes Relacionadas).",
  "Outros Passivos não Circulantes": "Entra: obrigações diversas de longo prazo sem linha específica (ex.: outras obrigações LP genéricas).",
  "Capital Social": "Entra: capital subscrito/integralizado pelos sócios. NÃO entra: lucros acumulados, reservas.",
  "Lucros/Prejuízos Acumulados": "Entra: resultados acumulados de exercícios anteriores e do exercício, quando não destinados. Prejuízo entra NEGATIVO.",
};
