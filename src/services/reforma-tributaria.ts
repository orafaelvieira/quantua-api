/**
 * REFORMA TRIBUTÁRIA DO CONSUMO (EC 132/2023 · LC 214/2025 · LC 227/2026 ·
 * Decreto 12.955/2026) — parâmetros e cálculo do "mundo novo" (CBS + IBS)
 * para comparar com a tributação atual do modelo.
 *
 * NÚMEROS "DUROS" DA LEI (com artigo):
 *   · 2026 (ano-teste): CBS 0,9% (LC 214 art. 346) + IBS 0,1% (art. 343),
 *     COMPENSÁVEIS com PIS/COFINS e DISPENSADOS p/ quem cumpre as obrigações
 *     acessórias (art. 348; Decreto 12.955 arts. 464/583) → carga = atual;
 *   · 2027: PIS/COFINS EXTINTOS (art. 542); CBS = alíquota de referência
 *     − 0,1 p.p. em 2027-2028 (art. 347); IBS 0,05% + 0,05% (art. 344);
 *   · 2029-2032: IBS entra em 10/20/30/40% da referência (arts. 361-364) e
 *     ICMS/ISS caem 10/20/30/40% (arts. 501 e 508);
 *   · 2033: sistema pleno — ICMS/ISS extintos;
 *   · Reduções de alíquota: 30% (profissões regulamentadas, art. 127),
 *     60% (saúde/educação/alimentos/agro etc., arts. 128-142),
 *     80% (locação em reabilitação urbana, Decreto art. 234 §3º),
 *     zero (cesta básica/medicamentos/hortifrúti, arts. 125, 144-149);
 *   · Base "POR FORA": IBS/CBS não integram a própria base (art. 12 §2º I) e,
 *     na transição (2026-2032), ICMS/ISS/PIS/COFINS também ficam FORA da base
 *     (art. 12 §2º V);
 *   · Crédito AMPLO (art. 47), exceto uso/consumo pessoal (art. 57); venda com
 *     alíquota reduzida NÃO estorna crédito das compras (art. 47 §6º);
 *   · Simples: pode ficar no DAS (adquirente credita só o valor pago dentro do
 *     Simples — art. 47 §9º) ou optar pelo regime regular (art. 41 §3º).
 *
 * O QUE NÃO ESTÁ NA LEI: as alíquotas de REFERÊNCIA da CBS e do IBS (Senado
 * fixará por resolução — arts. 18 e 349; teto de gatilho 26,5%). Entram como
 * PREMISSA EDITÁVEL, com default nas estimativas oficiais de mercado.
 *
 * PREMISSA METODOLÓGICA da comparação: PREÇO FINAL AO CLIENTE CONSTANTE — a
 * receita bruta do modelo é o preço cobrado nos dois mundos; o que muda é
 * quanto dela vira tributo. Conservadora e explicável; repasse de preço é
 * decisão comercial, não efeito automático da lei.
 */
import type { Serie } from "./model-engine";

export type CategoriaReforma = "padrao" | "reducao30" | "reducao60" | "reducao80" | "zero";

export const CATEGORIAS_REFORMA: Array<{ id: CategoriaReforma; nome: string; fator: number; base: string }> = [
  { id: "padrao", nome: "Padrão (alíquota cheia)", fator: 1, base: "regra geral" },
  { id: "reducao30", nome: "Redução de 30% — profissões regulamentadas", fator: 0.7, base: "LC 214, art. 127 (advogados, contadores, engenheiros, médicos veterinários…)" },
  { id: "reducao60", nome: "Redução de 60% — saúde, educação, alimentos, agro…", fator: 0.4, base: "LC 214, arts. 128-142 e Anexos II-IX" },
  { id: "reducao80", nome: "Redução de 80% — locação em reabilitação urbana", fator: 0.2, base: "Decreto 12.955, art. 234 §3º" },
  { id: "zero", nome: "Alíquota zero — cesta básica, medicamentos, hortifrúti…", fator: 0, base: "LC 214, arts. 125 e 144-149 (créditos das compras são mantidos)" },
];

export interface ConfigReforma {
  /** Categoria do bem/serviço principal da empresa (define a redução). */
  categoria?: CategoriaReforma;
  /** Alíquota de REFERÊNCIA plena da CBS (premissa — Senado ainda não fixou). */
  aliqCbsRef?: number;
  /** Alíquota de REFERÊNCIA plena do IBS (estadual+municipal, premissa). */
  aliqIbsRef?: number;
  /** % da base de compras (custos + despesas − folha) que gera crédito. */
  pctCustosCreditaveis?: number;
  /** Capex gera crédito integral (crédito amplo, LC 214 art. 47). */
  capexCredita?: boolean;
}

/** Defaults das premissas NÃO fixadas em lei (estimativas oficiais correntes:
 *  soma ~26,5% no gatilho do art. 348-A — CBS ~8,8% + IBS ~17,7%). */
export const REFORMA_DEFAULTS = {
  aliqCbsRef: 0.088,
  aliqIbsRef: 0.177,
  pctCustosCreditaveis: 1,
  capexCredita: true,
} as const;

/** Cronograma de transição por ano-calendário. */
export interface AnoTransicao {
  /** Fração da alíquota de referência do IBS vigente (arts. 343-344, 361-364). */
  fracaoIbs: number;
  /** IBS simbólico fixo (0,1% em 2026; 0,05%+0,05% em 2027-28) — em decimal. */
  ibsFixo: number | null;
  /** CBS vigente? (2026 é neutra — compensável/dispensada). */
  cbsVigente: boolean;
  /** Redutor da CBS em p.p. (−0,1 p.p. em 2027-2028, art. 347). */
  cbsRedutorPp: number;
  /** PIS/COFINS ainda vigentes? (extintos a partir de 2027, art. 542). */
  pisCofinsVigente: boolean;
  /** Fração REMANESCENTE de ICMS/ISS (arts. 501 e 508). */
  fatorIcmsIss: number;
}

export function anoTransicao(ano: number): AnoTransicao {
  if (ano <= 2026) return { fracaoIbs: 0, ibsFixo: null, cbsVigente: false, cbsRedutorPp: 0, pisCofinsVigente: true, fatorIcmsIss: 1 };
  if (ano <= 2028) return { fracaoIbs: 0, ibsFixo: 0.001, cbsVigente: true, cbsRedutorPp: 0.001, pisCofinsVigente: false, fatorIcmsIss: 1 };
  if (ano === 2029) return { fracaoIbs: 0.1, ibsFixo: null, cbsVigente: true, cbsRedutorPp: 0, pisCofinsVigente: false, fatorIcmsIss: 0.9 };
  if (ano === 2030) return { fracaoIbs: 0.2, ibsFixo: null, cbsVigente: true, cbsRedutorPp: 0, pisCofinsVigente: false, fatorIcmsIss: 0.8 };
  if (ano === 2031) return { fracaoIbs: 0.3, ibsFixo: null, cbsVigente: true, cbsRedutorPp: 0, pisCofinsVigente: false, fatorIcmsIss: 0.7 };
  if (ano === 2032) return { fracaoIbs: 0.4, ibsFixo: null, cbsVigente: true, cbsRedutorPp: 0, pisCofinsVigente: false, fatorIcmsIss: 0.6 };
  return { fracaoIbs: 1, ibsFixo: null, cbsVigente: true, cbsRedutorPp: 0, pisCofinsVigente: false, fatorIcmsIss: 0 };
}

export function fatorCategoria(categoria?: CategoriaReforma): number {
  return CATEGORIAS_REFORMA.find((c) => c.id === (categoria ?? "padrao"))?.fator ?? 1;
}

/** Alíquotas novas VIGENTES no ano (já com transição e redução da categoria).
 *  tVenda = alíquota "por fora" aplicada às vendas da empresa;
 *  tCompra = alíquota "por fora" PADRÃO embutida nas compras (fornecedores
 *  tributam pela regra geral; a redução da venda não estorna o crédito —
 *  LC 214, art. 47 §6º). */
export function aliquotasNovasDoAno(ano: number, cfg: ConfigReforma): { tVenda: number; tCompra: number } {
  const t = anoTransicao(ano);
  const cbsRef = cfg.aliqCbsRef ?? REFORMA_DEFAULTS.aliqCbsRef;
  const ibsRef = cfg.aliqIbsRef ?? REFORMA_DEFAULTS.aliqIbsRef;
  const cbs = t.cbsVigente ? Math.max(0, cbsRef - t.cbsRedutorPp) : 0;
  const ibs = t.ibsFixo !== null ? t.ibsFixo : ibsRef * t.fracaoIbs;
  const cheia = cbs + ibs;
  const fator = fatorCategoria(cfg.categoria);
  // O IBS simbólico de 2027-28 também aplica as reduções (art. 344, p.ú.).
  return { tVenda: cheia * fator, tCompra: cheia };
}

export interface SerieImpostosAtuais {
  /** Impostos sobre a receita do SISTEMA ATUAL, decompostos por mês. */
  pisCofins: Serie; // sobre a receita (por dentro)
  icmsIss: Serie;   // sobre a receita (por dentro)
}

/** IMPOSTOS SOBRE O CONSUMO no MUNDO DA REFORMA, mês a mês.
 *
 *  antigoVigente = PIS/COFINS (até 2026) + ICMS/ISS × fração remanescente;
 *  base nova ("por fora", art. 12 §2º): (receita − tributos antigos da
 *  operação) ÷ (1 + tVenda) — preço final constante;
 *  débito = base × tVenda; crédito = compras creditáveis × tCompra/(1+tCompra);
 *  SALDO CREDOR acumula e compensa débitos futuros (corkscrew — na lei também
 *  é ressarcível em dinheiro, arts. 39-40; o carry é a leitura conservadora).
 */
export function calcularImpostosReforma(params: {
  meses: string[];
  receita: Serie;
  /** Base mensal de compras que geram crédito (custos+despesas−folha, já filtrada). */
  comprasCreditaveis: Serie;
  capex: Serie;
  cfg: ConfigReforma;
  /** Alíquotas ATUAIS por dentro (para a transição e a base por fora). */
  pisCofinsPct: number;
  icmsIssPct: number;
}): { impostosConsumo: Serie; debitoNovo: Serie; creditoNovo: Serie; antigoRemanescente: Serie; saldoCredor: Serie } {
  const { meses, receita, comprasCreditaveis, capex, cfg } = params;
  const pctCred = Math.min(1, Math.max(0, cfg.pctCustosCreditaveis ?? REFORMA_DEFAULTS.pctCustosCreditaveis));
  const capexCredita = cfg.capexCredita !== false;

  const impostosConsumo: Serie = {};
  const debitoNovo: Serie = {};
  const creditoNovo: Serie = {};
  const antigoRemanescente: Serie = {};
  const saldoCredorS: Serie = {};
  let saldoCredor = 0;
  let anoCorrente = "";

  for (const mes of meses) {
    const anoStr = mes.slice(0, 4);
    const ano = Number(anoStr);
    if (anoStr !== anoCorrente) {
      anoCorrente = anoStr;
      // Art. 465 do Decreto 12.955: saldo credor de CBS de 2026 NÃO passa
      // para 2027 (no teste a CBS é neutra — aqui nunca geramos crédito em
      // 2026, mas a regra fica registrada).
      if (ano === 2027) saldoCredor = 0;
    }
    const t = anoTransicao(ano);
    const { tVenda, tCompra } = aliquotasNovasDoAno(ano, cfg);
    const rec = receita[mes] ?? 0;

    // Tributos ATUAIS remanescentes (por dentro da receita)
    const antigoPct = (t.pisCofinsVigente ? params.pisCofinsPct : 0) + params.icmsIssPct * t.fatorIcmsIss;
    const antigo = Math.max(0, rec) * antigoPct;

    // Débito novo: base "por fora" = (receita − tributos antigos) ÷ (1 + t)
    const baseNova = tVenda > 0 ? Math.max(0, rec - antigo) / (1 + tVenda) : 0;
    const debito = baseNova * tVenda;

    // Crédito: IBS/CBS embutidos nas COMPRAS (alíquota padrão do ano)
    const compras = Math.max(0, comprasCreditaveis[mes] ?? 0) * pctCred + (capexCredita ? Math.max(0, capex[mes] ?? 0) : 0);
    const credito = tCompra > 0 ? (compras / (1 + tCompra)) * tCompra : 0;

    // Saldo credor compensa débitos futuros
    let novoLiquido = debito - credito - saldoCredor;
    if (novoLiquido < 0) {
      saldoCredor = -novoLiquido;
      novoLiquido = 0;
    } else {
      saldoCredor = 0;
    }

    impostosConsumo[mes] = antigo + novoLiquido;
    debitoNovo[mes] = debito;
    creditoNovo[mes] = credito;
    antigoRemanescente[mes] = antigo;
    saldoCredorS[mes] = saldoCredor;
  }

  return { impostosConsumo, debitoNovo, creditoNovo, antigoRemanescente, saldoCredor: saldoCredorS };
}

/** Notas metodológicas/legais da aba e do Excel. */
export const NOTAS_REFORMA: Array<{ n: number; texto: string }> = [
  { n: 1, texto: "Cronograma legal: 2026 é ano-teste NEUTRO (CBS 0,9% e IBS 0,1% compensáveis com PIS/COFINS e dispensados para quem cumpre as obrigações acessórias — LC 214, arts. 343-348; Decreto 12.955, arts. 464/582-583). Em 2027 PIS/COFINS são extintos e a CBS entra (menos 0,1 p.p. até 2028, art. 347), com IBS simbólico de 0,1%. De 2029 a 2032 o IBS entra em 10/20/30/40% da referência e ICMS/ISS caem na mesma proporção (arts. 361-364, 501 e 508). Em 2033 o sistema é pleno." },
  { n: 2, texto: "As alíquotas de REFERÊNCIA da CBS e do IBS ainda NÃO foram fixadas (dependem de resolução do Senado — LC 214, arts. 18 e 349). Os campos vêm com a estimativa corrente (~8,8% + ~17,7% ≈ 26,5%, o teto-gatilho do art. 348-A) e são premissas SUAS — ajuste e documente." },
  { n: 3, texto: "CBS/IBS incidem 'POR FORA' (não integram a própria base — art. 12 §2º) e, na transição, ICMS/ISS/PIS/COFINS também ficam fora da base (art. 12 §2º, V). A comparação assume PREÇO FINAL CONSTANTE: a receita bruta é a mesma nos dois mundos; muda quanto dela vira tributo. Repasse de preço é decisão comercial — teste nos Cenários." },
  { n: 4, texto: "Crédito AMPLO (art. 47): compras da atividade geram crédito, exceto uso e consumo pessoal (art. 57). A base creditável aqui = custos + despesas − folha de pagamento (salários não geram crédito) × o percentual configurável, + capex (investimento credita integral). Compras de fornecedor do Simples geram crédito LIMITADO ao valor pago dentro do DAS (art. 47 §9º) — se seus fornecedores forem majoritariamente do Simples, reduza o percentual." },
  { n: 5, texto: "Venda com alíquota reduzida (30%/60%/80%/zero) NÃO estorna o crédito das compras (art. 47 §6º) — por isso o crédito usa a alíquota PADRÃO do ano. Saldo credor acumulado compensa débitos futuros (na lei também é ressarcível em dinheiro — a leitura aqui é a conservadora)." },
  { n: 6, texto: "Simples Nacional: quem permanece no DAS não muda a PRÓPRIA carga com a reforma (o teste de 2026 nem se aplica — Decreto, art. 582 p.ú. IV). O efeito é COMPETITIVO: o comprador do regime regular passa a se creditar só do valor pago dentro do DAS. A opção de recolher IBS/CBS 'por fora' do DAS (art. 41 §3º) pode valer a pena para quem vende a empresas — avalie com o contador." },
  { n: 7, texto: "IRPJ/CSLL NÃO mudam com esta reforma (é a reforma do CONSUMO) — mas o lucro tributável muda quando a carga de consumo muda, e o modelo recalcula isso. A comparação roda o MODELO INTEIRO nos dois mundos: DRE, caixa, balanço e valuation." },
];
