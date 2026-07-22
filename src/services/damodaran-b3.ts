/**
 * DE-PARA B3 → DAMODARAN (beta desalavancado) + nomes em PORTUGUÊS.
 *
 * Por que este arquivo existe (correção de 22/07/2026): o beta desalavancado
 * nunca carregava sozinho. A tabela `damodaran_mappings` só tinha os códigos de
 * setor LEGADOS (`saude`, `varejo`, `agro`…), e o pivot para a taxonomia B3
 * DESATIVOU todos eles. Como os IBRs passaram a gravar códigos B3
 * (`saude__medicamentos_e_outros_produtos`), o lookup voltava vazio, o modelo
 * nascia sem `setorBeta` e o WACC caía no beta genérico 1,00 — silenciosamente.
 *
 * Três decisões de desenho:
 *  1. O de-para vive em CÓDIGO, não em tabela semeada. A lista de betas
 *     (wacc-referencias.ts) também é código; manter os dois lados juntos torna
 *     impossível mapear para uma indústria que não existe na tabela de betas —
 *     era exatamente o defeito de "Healthcare Facilities" e "Retail (Online)",
 *     que apontavam para nomes inexistentes e davam beta 1,00 do mesmo jeito.
 *     O teste desta suíte prova que todo destino existe.
 *  2. CASCATA subsetor → setor-pai → mercado, igual à cascata de premissas
 *     setoriais. Subsetor novo na B3 nunca deixa o modelo sem beta.
 *  3. O mapeamento é PONTO DE PARTIDA, não veredito: a aba WACC segue com o
 *     seletor aberto para o analista trocar a indústria quando conhecer melhor
 *     o negócio (uma "Máquinas e Equipamentos" pode ser Electrical Equipment).
 */

/** Indústria Damodaran por SUBSETOR B3 (44). */
export const B3_SUBSETOR_PARA_DAMODARAN: Record<string, string> = {
  // ── Bens Industriais ──
  bens_industriais__comercio: "Retail (Distributors)",
  bens_industriais__construcao_e_engenharia: "Engineering/Construction",
  bens_industriais__maquinas_e_equipamentos: "Machinery",
  bens_industriais__material_de_transporte: "Auto & Truck",
  bens_industriais__servicos: "Business & Consumer Services",
  bens_industriais__transporte: "Transportation",

  // ── Comunicações ──
  comunicacoes__telecomunicacoes: "Telecom. Services",

  // ── Consumo Cíclico ──
  consumo_ciclico__automoveis_e_motocicletas: "Auto & Truck",
  consumo_ciclico__comercio: "Retail (General)",
  consumo_ciclico__construcao_civil: "Homebuilding",
  consumo_ciclico__diversos: "Business & Consumer Services",
  consumo_ciclico__hoteis_e_restaurantes: "Restaurant/Dining",
  consumo_ciclico__tecidos_vestuario_e_calcados: "Apparel",
  consumo_ciclico__utilidades_domesticas: "Household Products",
  consumo_ciclico__viagens_e_lazer: "Recreation",

  // ── Consumo não Cíclico ──
  consumo_nao_ciclico__agropecuaria: "Farming/Agriculture",
  consumo_nao_ciclico__alimentos_processados: "Food Processing",
  consumo_nao_ciclico__bebidas: "Beverage (Soft)",
  consumo_nao_ciclico__comercio_e_distribuicao: "Retail (Grocery and Food)",
  consumo_nao_ciclico__produtos_de_uso_pessoal_e_de_limpeza: "Household Products",

  // ── Financeiro ──
  financeiro__exploracao_de_imoveis: "Real Estate (Operations & Services)",
  financeiro__holdings_diversificadas: "Diversified",
  financeiro__intermediarios_financeiros: "Banks (Regional)",
  financeiro__previdencia_e_seguros: "Insurance (General)",
  financeiro__securitizadoras_de_recebiveis: "Financial Svcs. (Non-bank & Insurance)",
  financeiro__servicos_diversos: "Financial Svcs. (Non-bank & Insurance)",
  financeiro__servicos_financeiros_diversos: "Financial Svcs. (Non-bank & Insurance)",

  // ── Materiais Básicos ──
  materiais_basicos__embalagens: "Packaging & Container",
  materiais_basicos__madeira_e_papel: "Paper/Forest Products",
  materiais_basicos__materiais_diversos: "Chemical (Diversified)",
  materiais_basicos__mineracao: "Metals & Mining",
  materiais_basicos__quimicos: "Chemical (Basic)",
  materiais_basicos__siderurgia_e_metalurgia: "Steel",

  // ── Outros ──
  outros__outros: "Total Market",

  // ── Petróleo, Gás e Biocombustíveis ──
  petroleo_gas_e_biocombustiveis__petroleo_gas_e_biocombustiveis: "Oil/Gas (Integrated)",

  // ── Saúde ──
  saude__comercio_e_distribuicao: "Retail (Distributors)",
  saude__equipamentos: "Healthcare Products",
  saude__medicamentos_e_outros_produtos: "Drugs (Pharmaceutical)",
  saude__serv_med_hospit_analises_e_diagnosticos: "Hospitals/Healthcare Facilities",

  // ── Tecnologia da Informação ──
  tecnologia_da_informacao__computadores_e_equipamentos: "Computers/Peripherals",
  tecnologia_da_informacao__programas_e_servicos: "Software (System & Application)",

  // ── Utilidade Pública ──
  utilidade_publica__agua_e_saneamento: "Utility (Water)",
  utilidade_publica__energia_eletrica: "Power",
  utilidade_publica__gas: "Oil/Gas Distribution",
};

/** Degrau 2 da cascata: indústria por SETOR-PAI B3 (11). */
export const B3_SETOR_PARA_DAMODARAN: Record<string, string> = {
  bens_industriais: "Machinery",
  comunicacoes: "Telecom. Services",
  consumo_ciclico: "Retail (General)",
  consumo_nao_ciclico: "Food Processing",
  financeiro: "Financial Svcs. (Non-bank & Insurance)",
  materiais_basicos: "Chemical (Basic)",
  outros: "Total Market",
  petroleo_gas_e_biocombustiveis: "Oil/Gas (Integrated)",
  saude: "Healthcare Products",
  tecnologia_da_informacao: "Software (System & Application)",
  utilidade_publica: "Power",
};

/** Degrau 3: o mercado inteiro — nunca deixa o modelo sem beta. */
export const DAMODARAN_PADRAO = "Total Market";

/**
 * Resolve a indústria Damodaran de um código de setor B3, com cascata
 * subsetor → setor-pai → mercado. Determinístico, sem I/O.
 * Devolve também COMO chegou lá, para a tela poder declarar a premissa.
 */
export function damodaranDoSetorB3(sectorId: string | null | undefined): {
  industria: string;
  origem: "subsetor" | "setor" | "padrao";
} {
  const code = (sectorId ?? "").trim();
  if (code && B3_SUBSETOR_PARA_DAMODARAN[code]) {
    return { industria: B3_SUBSETOR_PARA_DAMODARAN[code]!, origem: "subsetor" };
  }
  // Subsetor desconhecido: sobe para o pai (o código do pai é o prefixo antes de "__").
  const pai = code.includes("__") ? code.split("__")[0]! : code;
  if (pai && B3_SETOR_PARA_DAMODARAN[pai]) {
    return { industria: B3_SETOR_PARA_DAMODARAN[pai]!, origem: "setor" };
  }
  return { industria: DAMODARAN_PADRAO, origem: "padrao" };
}

/**
 * Nomes das indústrias Damodaran em PORTUGUÊS (pedido do usuário, 22/07/2026).
 * A CHAVE em inglês continua sendo a identidade — é ela que casa com a tabela
 * de betas e com a fonte original; só a EXIBIÇÃO muda. Traduzir a chave
 * quebraria o vínculo com o dado publicado pelo Damodaran.
 */
export const DAMODARAN_PT: Record<string, string> = {
  Advertising: "Publicidade",
  "Aerospace/Defense": "Aeroespacial e Defesa",
  "Air Transport": "Transporte Aéreo",
  Apparel: "Vestuário",
  "Auto & Truck": "Automóveis e Caminhões",
  "Auto Parts": "Autopeças",
  "Bank (Money Center)": "Bancos (grandes centros)",
  "Banks (Regional)": "Bancos (regionais)",
  "Beverage (Alcoholic)": "Bebidas (alcoólicas)",
  "Beverage (Soft)": "Bebidas (não alcoólicas)",
  Broadcasting: "Radiodifusão",
  "Brokerage & Investment Banking": "Corretoras e Banco de Investimento",
  "Building Materials": "Materiais de Construção",
  "Business & Consumer Services": "Serviços a Empresas e ao Consumidor",
  "Cable TV": "TV por Assinatura",
  "Chemical (Basic)": "Químicos (básicos)",
  "Chemical (Diversified)": "Químicos (diversificados)",
  "Chemical (Specialty)": "Químicos (especialidades)",
  "Coal & Related Energy": "Carvão e Energia Relacionada",
  "Computer Services": "Serviços de Informática",
  "Computers/Peripherals": "Computadores e Periféricos",
  "Construction Supplies": "Suprimentos para Construção",
  Diversified: "Diversificado (holding)",
  "Drugs (Biotechnology)": "Medicamentos (biotecnologia)",
  "Drugs (Pharmaceutical)": "Medicamentos (farmacêutica)",
  Education: "Educação",
  "Electrical Equipment": "Equipamentos Elétricos",
  "Electronics (Consumer & Office)": "Eletrônicos (consumo e escritório)",
  "Electronics (General)": "Eletrônicos (geral)",
  "Engineering/Construction": "Engenharia e Construção",
  Entertainment: "Entretenimento",
  "Environmental & Waste Services": "Serviços Ambientais e Resíduos",
  "Farming/Agriculture": "Agropecuária",
  "Financial Svcs. (Non-bank & Insurance)": "Serviços Financeiros (não bancários)",
  "Food Processing": "Alimentos Processados",
  "Food Wholesalers": "Atacado de Alimentos",
  "Furn/Home Furnishings": "Móveis e Decoração",
  "Green & Renewable Energy": "Energia Renovável",
  "Healthcare Products": "Produtos para Saúde",
  "Healthcare Support Services": "Serviços de Apoio à Saúde",
  "Heathcare Information and Technology": "Tecnologia da Informação em Saúde",
  Homebuilding: "Construção Civil (residencial)",
  "Hospitals/Healthcare Facilities": "Hospitais e Clínicas",
  "Hotel/Gaming": "Hotelaria e Cassinos",
  "Household Products": "Produtos de Uso Doméstico",
  "Information Services": "Serviços de Informação",
  "Insurance (General)": "Seguros (geral)",
  "Insurance (Life)": "Seguros (vida)",
  "Insurance (Prop/Cas.)": "Seguros (patrimonial)",
  "Investments & Asset Management": "Investimentos e Gestão de Ativos",
  Machinery: "Máquinas e Equipamentos",
  "Metals & Mining": "Metais e Mineração",
  "Office Equipment & Services": "Equipamentos e Serviços de Escritório",
  "Oil/Gas (Integrated)": "Petróleo e Gás (integrado)",
  "Oil/Gas (Production and Exploration)": "Petróleo e Gás (exploração e produção)",
  "Oil/Gas Distribution": "Distribuição de Gás",
  "Oilfield Svcs/Equip.": "Serviços e Equipamentos para Petróleo",
  "Packaging & Container": "Embalagens",
  "Paper/Forest Products": "Papel e Celulose",
  Power: "Energia Elétrica",
  "Precious Metals": "Metais Preciosos",
  "Publishing & Newspapers": "Editoras e Jornais",
  "R.E.I.T.": "Fundos Imobiliários (REIT)",
  "Real Estate (Development)": "Imobiliário (incorporação)",
  "Real Estate (General/Diversified)": "Imobiliário (geral)",
  "Real Estate (Operations & Services)": "Imobiliário (operação e serviços)",
  Recreation: "Lazer e Recreação",
  Reinsurance: "Resseguros",
  "Restaurant/Dining": "Restaurantes e Alimentação",
  "Retail (Automotive)": "Varejo (automotivo)",
  "Retail (Building Supply)": "Varejo (material de construção)",
  "Retail (Distributors)": "Distribuição e Atacado",
  "Retail (General)": "Varejo (geral)",
  "Retail (Grocery and Food)": "Varejo (supermercados e alimentos)",
  "Retail (REITs)": "Varejo (fundos imobiliários)",
  "Retail (Special Lines)": "Varejo (especializado)",
  "Rubber& Tires": "Borracha e Pneus",
  Semiconductor: "Semicondutores",
  "Semiconductor Equip": "Equipamentos para Semicondutores",
  "Shipbuilding & Marine": "Construção Naval e Marítima",
  Shoe: "Calçados",
  "Software (Entertainment)": "Software (entretenimento e jogos)",
  "Software (Internet)": "Software (internet)",
  "Software (System & Application)": "Software (sistemas e aplicações)",
  Steel: "Siderurgia",
  "Telecom (Wireless)": "Telecomunicações (móvel)",
  "Telecom. Equipment": "Equipamentos de Telecomunicações",
  "Telecom. Services": "Telecomunicações (serviços)",
  Tobacco: "Tabaco",
  Transportation: "Transporte e Logística",
  "Transportation (Railroads)": "Transporte Ferroviário",
  Trucking: "Transporte Rodoviário de Cargas",
  "Utility (General)": "Saneamento e Utilidades (geral)",
  "Utility (Water)": "Água e Saneamento",
  "Total Market": "Mercado total (todas as empresas)",
  "Total Market (without financials)": "Mercado total (exceto financeiras)",
};

/** Rótulo de exibição: português na frente, inglês entre parênteses (a chave
 *  em inglês é a que casa com a fonte — esconder confundiria na conferência). */
export function rotuloDamodaran(industria: string): string {
  const pt = DAMODARAN_PT[industria];
  return pt ? `${pt} (${industria})` : industria;
}
