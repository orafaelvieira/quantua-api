/**
 * REFERÊNCIAS DO WACC — datasets ANUAIS da planilha padrão (Base_Dados_WACC),
 * embutidos para o cálculo ser reproduzível e auditável. Atualização: 1×/ano,
 * por código (trocar as tabelas e as datas abaixo).
 *
 * Fontes (as MESMAS da planilha padrão):
 *  - ERP e betas desalavancados de emergentes: Aswath Damodaran
 *    (https://pages.stern.nyu.edu/~adamodar/ — datasets de 01/2026).
 *  - Prêmio por tamanho: Kroll (antiga Duff & Phelps), dados CRSP.
 *  - CSRP: checklist da metodologia da casa (penalidades típicas).
 */

/** ERP — prêmio de risco de mercado maduro (implied ERP S&P 500). */
export const ERP_REFERENCIA = {
  valor: 0.0423,
  data: "2026-01-01",
  fonte: "Aswath Damodaran — Implied ERP (S&P 500, riskfree ajustado)",
};

/** RISCO-PAÍS DO BRASIL por rating (Damodaran, jan/2026 — mesma aba "Country
 *  and ERP" da planilha padrão): fallback ANUAL do prêmio de risco-país quando
 *  a série de mercado não cobre a janela (o EMBI+ foi descontinuado pelo
 *  JPMorgan em 2024; o CDS 10Y do investing.com não tem API — cole manualmente
 *  quando quiser a leitura de mercado do dia). */
export const RISCO_PAIS_BRASIL = {
  rating: "Ba1",
  defaultSpread: 0.0212748888802989,
  crp: 0.032409700472794394,
  data: "2026-01-01",
  fonte: "Aswath Damodaran — Country Default Spreads (Brasil, Moody's Ba1)",
};

/** Betas DESALAVANCADOS por setor — Emerging Markets (Damodaran, 05/01/2026;
 *  coluna "unlevered beta corrected for cash"). */
export const BETAS_EMERGING: Array<{ setor: string; beta: number }> = [
  { setor: "Advertising", beta: 1.281 },
  { setor: "Aerospace/Defense", beta: 1.2563 },
  { setor: "Air Transport", beta: 0.5918 },
  { setor: "Apparel", beta: 0.6662 },
  { setor: "Auto & Truck", beta: 1.2172 },
  { setor: "Auto Parts", beta: 1.4669 },
  { setor: "Bank (Money Center)", beta: 0.3043 },
  { setor: "Banks (Regional)", beta: 0.1367 },
  { setor: "Beverage (Alcoholic)", beta: 0.953 },
  { setor: "Beverage (Soft)", beta: 0.5795 },
  { setor: "Broadcasting", beta: 0.8562 },
  { setor: "Brokerage & Investment Banking", beta: 0.4242 },
  { setor: "Building Materials", beta: 0.8907 },
  { setor: "Business & Consumer Services", beta: 1.1108 },
  { setor: "Cable TV", beta: 1.0277 },
  { setor: "Chemical (Basic)", beta: 1.0605 },
  { setor: "Chemical (Diversified)", beta: 0.8594 },
  { setor: "Chemical (Specialty)", beta: 1.1061 },
  { setor: "Coal & Related Energy", beta: 0.9674 },
  { setor: "Computer Services", beta: 1.0822 },
  { setor: "Computers/Peripherals", beta: 1.6178 },
  { setor: "Construction Supplies", beta: 0.9062 },
  { setor: "Diversified", beta: 0.4304 },
  { setor: "Drugs (Biotechnology)", beta: 1.4134 },
  { setor: "Drugs (Pharmaceutical)", beta: 1.0503 },
  { setor: "Education", beta: 0.7702 },
  { setor: "Electrical Equipment", beta: 1.4504 },
  { setor: "Electronics (Consumer & Office)", beta: 1.2063 },
  { setor: "Electronics (General)", beta: 1.7235 },
  { setor: "Engineering/Construction", beta: 0.6129 },
  { setor: "Entertainment", beta: 1.2158 },
  { setor: "Environmental & Waste Services", beta: 0.8904 },
  { setor: "Farming/Agriculture", beta: 0.498 },
  { setor: "Financial Svcs. (Non-bank & Insurance)", beta: 0.4041 },
  { setor: "Food Processing", beta: 0.6083 },
  { setor: "Food Wholesalers", beta: 0.433 },
  { setor: "Furn/Home Furnishings", beta: 1.1059 },
  { setor: "Green & Renewable Energy", beta: 0.5906 },
  { setor: "Healthcare Products", beta: 1.4339 },
  { setor: "Healthcare Support Services", beta: 0.7785 },
  { setor: "Heathcare Information and Technology", beta: 1.5623 },
  { setor: "Homebuilding", beta: 0.5059 },
  { setor: "Hospitals/Healthcare Facilities", beta: 0.6461 },
  { setor: "Hotel/Gaming", beta: 0.5798 },
  { setor: "Household Products", beta: 0.821 },
  { setor: "Information Services", beta: 1.0291 },
  { setor: "Insurance (General)", beta: 0.3638 },
  { setor: "Insurance (Life)", beta: 0.7043 },
  { setor: "Insurance (Prop/Cas.)", beta: 0.3315 },
  { setor: "Investments & Asset Management", beta: 0.4146 },
  { setor: "Machinery", beta: 1.4956 },
  { setor: "Metals & Mining", beta: 1.4018 },
  { setor: "Office Equipment & Services", beta: 0.7792 },
  { setor: "Oil/Gas (Integrated)", beta: 0.7426 },
  { setor: "Oil/Gas (Production and Exploration)", beta: 0.8134 },
  { setor: "Oil/Gas Distribution", beta: 0.4898 },
  { setor: "Oilfield Svcs/Equip.", beta: 0.7884 },
  { setor: "Packaging & Container", beta: 0.6124 },
  { setor: "Paper/Forest Products", beta: 0.5626 },
  { setor: "Power", beta: 0.461 },
  { setor: "Precious Metals", beta: 1.4989 },
  { setor: "Publishing & Newspapers", beta: 1.0076 },
  { setor: "R.E.I.T.", beta: 0.3215 },
  { setor: "Real Estate (Development)", beta: 0.4522 },
  { setor: "Real Estate (General/Diversified)", beta: 0.7193 },
  { setor: "Real Estate (Operations & Services)", beta: 0.5898 },
  { setor: "Recreation", beta: 0.9949 },
  { setor: "Reinsurance", beta: 0.9043 },
  { setor: "Restaurant/Dining", beta: 0.818 },
  { setor: "Retail (Automotive)", beta: 0.5828 },
  { setor: "Retail (Building Supply)", beta: 0.664 },
  { setor: "Retail (Distributors)", beta: 0.5327 },
  { setor: "Retail (General)", beta: 0.8902 },
  { setor: "Retail (Grocery and Food)", beta: 0.8562 },
  { setor: "Retail (REITs)", beta: 0.4277 },
  { setor: "Retail (Special Lines)", beta: 0.8533 },
  { setor: "Rubber& Tires", beta: 0.7899 },
  { setor: "Semiconductor", beta: 1.9759 },
  { setor: "Semiconductor Equip", beta: 2.0866 },
  { setor: "Shipbuilding & Marine", beta: 0.8428 },
  { setor: "Shoe", beta: 0.7888 },
  { setor: "Software (Entertainment)", beta: 1.5066 },
  { setor: "Software (Internet)", beta: 1.3292 },
  { setor: "Software (System & Application)", beta: 1.6397 },
  { setor: "Steel", beta: 0.9301 },
  { setor: "Telecom (Wireless)", beta: 0.6684 },
  { setor: "Telecom. Equipment", beta: 1.5149 },
  { setor: "Telecom. Services", beta: 0.6141 },
  { setor: "Tobacco", beta: 0.2305 },
  { setor: "Transportation", beta: 0.7938 },
  { setor: "Transportation (Railroads)", beta: 0.8873 },
  { setor: "Trucking", beta: 0.3674 },
  { setor: "Utility (General)", beta: 0.5725 },
  { setor: "Utility (Water)", beta: 0.4729 },
  { setor: "Total Market", beta: 0.8479 },
  { setor: "Total Market (without financials)", beta: 0.9878 },
];
export const BETAS_DATA = "2026-01-05";

/** Prêmio por tamanho — decis Kroll/CRSP (mesma tabela da planilha padrão). */
export const KROLL_DECIS: Array<{ decil: string; faixa: string; premio: number }> = [
  { decil: "1", faixa: "> US$ 190 bi (maiores empresas)", premio: -0.0045 },
  { decil: "2", faixa: "US$ 40 bi – 190 bi", premio: 0.0055 },
  { decil: "3", faixa: "US$ 18 bi – 40 bi", premio: 0.0121 },
  { decil: "4", faixa: "US$ 10 bi – 18 bi", premio: 0.0178 },
  { decil: "5", faixa: "US$ 6 bi – 10 bi", premio: 0.0205 },
  { decil: "6", faixa: "US$ 3,5 bi – 6 bi", premio: 0.0242 },
  { decil: "7", faixa: "US$ 2 bi – 3,5 bi", premio: 0.0288 },
  { decil: "8", faixa: "US$ 1 bi – 2 bi", premio: 0.0325 },
  { decil: "9", faixa: "US$ 618 mi – 1 bi", premio: 0.0399 },
  { decil: "10", faixa: "abaixo de US$ 618 mi (menores)", premio: 0.0492 },
  { decil: "10a", faixa: "US$ 121,5 mi – 250,3 mi", premio: 0.0571 },
  { decil: "10b", faixa: "abaixo de US$ 121,5 mi", premio: 0.0699 },
];
export const KROLL_FONTE = "Kroll (antiga Duff & Phelps) — dados de mercado CRSP";

/** CSRP — fatores de risco específicos da empresa (checklist da metodologia). */
export const CSRP_FATORES: Array<{ fator: string; faixa: string; pct: number }> = [
  { fator: "Dependência de clientes concentrados", faixa: "+1,0–2,0%", pct: 0.015 },
  { fator: "Histórico curto de EBITDA positivo", faixa: "+1,5–2,5%", pct: 0.02 },
  { fator: "Ausência de auditoria Big Four", faixa: "+0,5–1,0%", pct: 0.0075 },
  { fator: "PL negativo / estrutura frágil", faixa: "+1,0–1,5%", pct: 0.0125 },
  { fator: "Alta dependência de pessoas-chave", faixa: "+0,5–1,5%", pct: 0.01 },
  { fator: "Falta de contratos de longo prazo (backlog)", faixa: "+0,5–1,0%", pct: 0.0074 },
];
