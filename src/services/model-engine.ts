/**
 * Model Engine — motor do MODELO FINANCEIRO VIVO (produto Modelos Financeiros).
 *
 * Função pura, sem I/O (padrão projection-engine): recebe blocos + cenário +
 * realizado, devolve séries mensais por nó, DRE consolidada, agregações e checks.
 *
 * Princípios (PLANO_VALUATION_ORCAMENTO.md, Parte 4):
 * - Motor SEMPRE mensal; trimestral/anual são agregação da saída.
 * - Receita = árvore de drivers componível (7 primitivas); demais linhas por config.
 * - Corkscrew: saldo final do mês M entra como saldo inicial de M+1.
 * - Análise DIMENSIONAL: cada nó declara unidade ([#], [%], [R$], [R$/un]); fórmulas
 *   têm a dimensão inferida e conferida — linha de receita que não fecha em R$ é
 *   check vermelho (à prova de estagiário).
 * - Realizado sobrepõe projetado nos meses fechados (selo real|proj por mês).
 * - Determinístico: zero IA aqui.
 */

// Sem ciclo em runtime: reforma-tributaria só importa TIPOS deste arquivo.
import { calcularImpostosReforma } from "./reforma-tributaria";

// ── Tipos ──────────────────────────────────────────────────────────────────

export type UnidadeNode = "#" | "%" | "R$" | "R$/un" | "#/un";
export type TipoNode = "estoque" | "fluxo" | "taxa" | "preco" | "capacidade" | "serie" | "formula";

/** Série mensal: chave "YYYY-MM". */
export type Serie = Record<string, number>;

export interface DriverNode {
  id: string;
  tipo: TipoNode;
  nome: string;
  unidade: UnidadeNode;
  /** Papel semântico opcional (tag do template): "baseClientes" | "novos" | "churnRate" |
   *  "arpu" | "ocupacao" | "capacidade" | "tpv" | "takeRate"… — habilita KPIs derivados
   *  e checks específicos (ex.: ocupação ≤ 100%). */
  papel?: string;
  /**
   * Parâmetros por tipo:
   * - serie/taxa/preco/capacidade: { valorMensal?, valores?: Serie, crescimentoAnual?,
   *   sazonalidade?: number[12] (média 1; aplicada sobre a base) , max? (teto p/ taxa) }
   * - estoque: { saldoInicial, entradasRef?, saidasRef? }
   * - fluxo/formula: { expr? } (sem expr, avalia como série)
   */
  params: Record<string, unknown>;
  /** Override pontual de meses (mão do analista, com selo "editado" na UI). */
  serieManual?: Serie;
}

/** Linha de um bloco de RECEITAS: aponta o nó raiz (que deve fechar em R$). */
export interface LinhaReceita {
  id: string;
  nome: string;
  /** Template usado na criação ("saas", "transacional", "capacidade", …) — só metadado. */
  template?: string;
  nodes: DriverNode[];
  /** id do nó cujo valor é a receita da linha. */
  nodeRaiz: string;
  /** Só em bloco CAPEX: taxa de depreciação linear da classe (a.a.; 0.1 = 10 anos). */
  depreciacaoAnual?: number;
  /** Só em bloco CAPEX: CARÊNCIA em meses antes de começar a depreciar (0 = mês
   *  seguinte ao investimento). Cultura em formação/obra em andamento: 24, 36… */
  carenciaMeses?: number;
  /** Só em bloco CAPEX: tipo do ativo (metadado do dropdown da tela). */
  tipoAtivo?: string;
  /** Posição de exibição na lista (nova linha = fim). Metadado da tela. */
  ordem?: number;
}

/** Linha de custos/despesas (modo simples da F1). */
export interface LinhaCusto {
  id: string;
  nome: string;
  modo: "pctReceita" | "fixoReajuste" | "serie";
  /** pctReceita: fração da base (0.12 = 12%). */
  pct?: number;
  /** pctReceita: % VARIANDO POR ANO CALENDÁRIO ({"2027": 0.14}); ausente no ano → cai no pct. */
  pctPorAno?: Record<string, number>;
  /** pctReceita: base do % — id de uma LINHA DE RECEITA específica; ausente = receita total.
   *  (Feedback do usuário: nem tudo é % da receita total — às vezes é % de um produto.) */
  baseRef?: string;
  /** fixoReajuste: valor mensal + reajuste por ANO CALENDÁRIO composto. */
  valorMensal?: number;
  /** Reajuste padrão ao ano (índice de inflação ou índice do analista). */
  reajusteAnual?: number;
  /** Reajuste específico por ano ({"2027": 0.045}); ausente no ano → cai no reajusteAnual. */
  reajustePorAno?: Record<string, number>;
  /** fixoReajuste: reajustar pelo ÍNDICE OFICIAL do snapshot BCB do modelo
   *  (IPCA/IGP-M) — sobrepõe os %s manuais; "Atualizar índices" corrige junto. */
  reajusteIndice?: "ipca" | "igpm";
  /** serie: valores explícitos. */
  valores?: Serie;
  /** Só em bloco CAPEX: taxa de depreciação linear da classe (a.a.; 0.1 = 10 anos). */
  depreciacaoAnual?: number;
  /** Só em bloco CAPEX: carência em meses antes de depreciar (0 = mês seguinte). */
  carenciaMeses?: number;
  /** Só em bloco CAPEX: tipo do ativo (metadado do dropdown da tela). */
  tipoAtivo?: string;
  /** Posição de exibição na lista (nova linha = fim). Metadado da tela. */
  ordem?: number;
}

/** Ativo que a empresa JÁ TEM na largada (das DFs ou informado): imobilizado,
 *  intangível, cultura em formação… — cada um deprecia/amortiza pela sua taxa
 *  (taxa 0 = não deprecia, ex.: terrenos). */
export interface AtivoExistente {
  id: string;
  nome: string;
  valor: number;
  taxaAnual: number;
  /** Tipo do catálogo da tela (metadado). */
  tipoAtivo?: string;
}

/** POSIÇÃO da folha (B4): um cargo/função com contrato, salário e projeção de
 *  quantidade. Headcount é NÍVEL (inteiro, vigente no mês). */
export interface Posicao {
  id: string;
  nome: string;
  /** Área para agregação (TI, Comercial, Produção…) — livre. */
  area?: string;
  /** Onde entra na DRE: produção = custo; administrativo/comercial = despesa. */
  classificacao: "custo" | "despesa";
  tipoContrato: "clt" | "pj" | "prolabore" | "estagio";
  /** % de encargos sobre o salário — default do tipo de contrato, editável. */
  encargosPct?: number;
  /** Salário/remuneração MENSAL por pessoa (R$) — ponto de partida. */
  salarioMensal: number;
  /** Salário POR ANO ({"2028": 2000}): ano digitado MANDA (vale desde janeiro);
   *  ano vazio herda o vigente e o dissídio corrige na data-base. */
  salarioPorAno?: Record<string, number>;
  /** Benefícios por pessoa/mês (VR, plano…) — não sofrem dissídio. */
  beneficiosMensal?: number;
  /** Dissídio/reajuste anual (%) aplicado no mês da data-base. */
  dissidioAnual?: number;
  /** Data-base do dissídio (1-12; default 1 = janeiro). 1º reajuste ocorre na
   *  primeira data-base APÓS o início do horizonte. */
  mesDissidio?: number;
  /** Como projetar a QUANTIDADE de pessoas. */
  modoQtd: "ano" | "mes" | "variavel";
  /** modo ano: pessoas no FIM de cada ano. */
  qtdPorAno?: Record<string, number>;
  /** modo ano: "janeiro" = muda na virada; "rampa" = distribui a variação
   *  LINEARMENTE ao longo dos meses do ano (resolve o "tudo em janeiro"). */
  distribuicao?: "janeiro" | "rampa";
  /** modo mes: quantidade digitada mês a mês. */
  qtdMeses?: Serie;
  /** modo variavel: id da variável do negócio + quanto dela 1 pessoa cobre. */
  variavelRef?: string;
  unidadesPorPessoa?: number;
  /** Variação POR ANO do "quanto 1 pessoa cobre" (ganho de escala); ausente → flat. */
  unidadesPorPessoaPorAno?: Record<string, number>;
  /** modo variavel: mínimo de pessoas (piso). */
  qtdMinima?: number;
  ordem?: number;
}

/** CONTRATO DE DÍVIDA (B8): dívida que JÁ EXISTE (saldoInicial) ou CAPTAÇÃO
 *  futura (principal + mesCaptacao). Corkscrew mensal: saldo + captação −
 *  amortização; juros do mês sobre o saldo do início do mês (captação do
 *  próprio mês só paga juros a partir do mês seguinte). As parcelas ocupam a
 *  janela [início da amortização … início + prazo − 1]:
 *  - SAC:    quota FIXA = saldo na 1ª parcela ÷ prazo (juros decrescentes);
 *  - PRICE:  parcela fixa (PMT); a taxa mudando de ano REPRECIFICA o PMT
 *            sobre o saldo e as parcelas restantes (pós-fixado na prática);
 *  - BULLET: só juros no caminho; o principal INTEIRO sai na última parcela. */
export interface ContratoDivida {
  id: string;
  nome: string;
  sistema: "sac" | "price" | "bullet";
  /** Dívida existente: saldo devedor no início do horizonte (R$). */
  saldoInicial?: number;
  /** Captação futura: valor liberado (R$)… */
  principal?: number;
  /** …no mês da liberação ("YYYY-MM"). Ausente = dívida existente. */
  mesCaptacao?: string;
  /** Nº de parcelas de amortização (bullet: nº de meses até o vencimento). */
  prazoMeses: number;
  /** Meses SÓ de juros antes da 1ª parcela (0 = amortiza desde o começo). */
  carenciaMeses?: number;
  /** Custo efetivo da dívida (a.a.; 0.18 = 18%) — convertido a mensal composto. */
  taxaAnual: number;
  /** Taxa POR ANO-calendário ({"2027": 0.16}); ano ausente cai na taxaAnual. */
  taxaPorAno?: Record<string, number>;
  /** Rótulo do indexador (CDI + spread, IPCA +, Pré…) — metadado da tela. */
  indexador?: string;
  /** ASSISTENTE DE TAXA (metadados da tela — o motor usa só a taxa composta
   *  gravada em taxaAnual/taxaPorAno): "indexada" = índice + spread. */
  modoTaxa?: "direta" | "indexada";
  /** Índice de referência do assistente: "ipca" | "cdi" | "cambio" | "outro". */
  indiceRef?: string;
  /** Spread sobre o índice (a.a. decimal; 0.05 = 5%). */
  spreadAA?: number;
  /** Projeção do índice por ano (a.a. decimal; {"2026": 0.045}). */
  indicePorAno?: Record<string, number>;
  /** Posição de exibição (novo contrato = fim). */
  ordem?: number;
}

/** OUTROS ITENS DO BALANÇO (fora de giro/imobilizado/dívida/caixa): mútuos,
 *  antecipações, impostos e pessoal a pagar… Cada item tem CLASSIFICAÇÃO
 *  contábil e um modo de projeção do SALDO; a variação entra no FCO
 *  (ativo que cresce consome caixa; passivo que cresce libera). */
export interface ItemBalanco {
  id: string;
  nome: string;
  /** ac | anc | pc | pnc (circulante = realiza/vence em até 12 meses). */
  classificacao: "ac" | "anc" | "pc" | "pnc";
  /** constante (saldo parado, ex.: mútuo) | dias (PRAZO MÉDIO × base — impostos
   *  a pagar, adiantamentos…) | porAno (cronograma: saldo vigente em cada ano). */
  modo: "constante" | "dias" | "porAno";
  /** constante: o saldo (também é fallback do porAno sem anos digitados). */
  saldo?: number;
  /** dias: base da régua do prazo médio (saldo = base do mês × dias ÷ 30). */
  base?: "receita" | "custos" | "folha" | "impostos";
  dias?: number;
  /** dias variando por ano-calendário (ano ausente cai no dias). */
  diasPorAno?: Record<string, number>;
  /** porAno: saldo vigente por ano ({"2027": 0} = liquidado em 2027; ano vazio repete). */
  saldoPorAno?: Record<string, number>;
  ordem?: number;
}

/** CONFIG DE IMPOSTOS (F3) do bloco "impostos": um regime por modelo. */
export interface ConfigImpostos {
  /** "nenhum" (default: DRE para no LAIR) | "simples" | "presumido" | "real". */
  regime?: "nenhum" | "simples" | "presumido" | "real";
  // ── Simples Nacional ──
  /** Anexo da atividade (I comércio, II indústria, III/IV/V serviços). */
  anexo?: "I" | "II" | "III" | "IV" | "V";
  /** Fator R automático (anexos III/V): folha 12m ÷ receita 12m ≥ 28% → III. */
  usarFatorR?: boolean;
  /** Receita bruta dos 12 meses ANTERIORES ao início do horizonte (âncora do RBT12). */
  rbt12Inicial?: number;
  // ── Lucro Presumido ──
  /** Presunção do IRPJ (0.08 comércio/indústria, 0.32 serviços…). */
  presuncaoIRPJ?: number;
  /** Presunção da CSLL (0.12 comércio/indústria, 0.32 serviços…). */
  presuncaoCSLL?: number;
  /** LC 224/2025: +10% na presunção (IRPJ e CSLL) sobre a parcela da receita
   *  ANUAL acima de R$ 5 mi, desde jan/2026. Default LIGADO (lei em vigor);
   *  false = empresa com liminar suspendendo a majoração. */
  aplicarLC224?: boolean;
  // ── Presumido e Real ──
  /** PIS/COFINS sobre a receita (Presumido cumulativo 0.0365; Real 0.0925 —
   *  edite para refletir créditos do não-cumulativo). */
  pisCofinsPct?: number;
  /** ISS sobre a receita de serviços (0.02–0.05) — simplificação sobre a receita total. */
  issPct?: number;
  /** ICMS líquido sobre a receita (comércio/indústria) — simplificação (débito−crédito). */
  icmsPct?: number;
}

/** TABELAS DO SIMPLES NACIONAL (LC 123/2006, redação da LC 155/2016 — vigentes
 *  desde 2018): faixas de RBT12 com alíquota NOMINAL e PARCELA A DEDUZIR.
 *  Alíquota EFETIVA = (RBT12 × nominal − dedução) ÷ RBT12. Teto: R$ 4,8 mi. */
export const SIMPLES_ANEXOS: Record<"I" | "II" | "III" | "IV" | "V", Array<{ ate: number; aliq: number; deducao: number }>> = {
  // Anexo I — Comércio
  I: [
    { ate: 180_000, aliq: 0.04, deducao: 0 },
    { ate: 360_000, aliq: 0.073, deducao: 5_940 },
    { ate: 720_000, aliq: 0.095, deducao: 13_860 },
    { ate: 1_800_000, aliq: 0.107, deducao: 22_500 },
    { ate: 3_600_000, aliq: 0.143, deducao: 87_300 },
    { ate: 4_800_000, aliq: 0.19, deducao: 378_000 },
  ],
  // Anexo II — Indústria
  II: [
    { ate: 180_000, aliq: 0.045, deducao: 0 },
    { ate: 360_000, aliq: 0.078, deducao: 5_940 },
    { ate: 720_000, aliq: 0.1, deducao: 13_860 },
    { ate: 1_800_000, aliq: 0.112, deducao: 22_500 },
    { ate: 3_600_000, aliq: 0.147, deducao: 85_500 },
    { ate: 4_800_000, aliq: 0.3, deducao: 720_000 },
  ],
  // Anexo III — Serviços (fator R ≥ 28%) e locação de bens móveis
  III: [
    { ate: 180_000, aliq: 0.06, deducao: 0 },
    { ate: 360_000, aliq: 0.112, deducao: 9_360 },
    { ate: 720_000, aliq: 0.135, deducao: 17_640 },
    { ate: 1_800_000, aliq: 0.16, deducao: 35_640 },
    { ate: 3_600_000, aliq: 0.21, deducao: 125_640 },
    { ate: 4_800_000, aliq: 0.33, deducao: 648_000 },
  ],
  // Anexo IV — Serviços (limpeza/vigilância/obras/advocacia; INSS patronal por fora)
  IV: [
    { ate: 180_000, aliq: 0.045, deducao: 0 },
    { ate: 360_000, aliq: 0.09, deducao: 8_100 },
    { ate: 720_000, aliq: 0.102, deducao: 12_420 },
    { ate: 1_800_000, aliq: 0.14, deducao: 39_780 },
    { ate: 3_600_000, aliq: 0.22, deducao: 183_780 },
    { ate: 4_800_000, aliq: 0.33, deducao: 828_000 },
  ],
  // Anexo V — Serviços (tecnologia, engenharia… fator R < 28%)
  V: [
    { ate: 180_000, aliq: 0.155, deducao: 0 },
    { ate: 360_000, aliq: 0.18, deducao: 4_500 },
    { ate: 720_000, aliq: 0.195, deducao: 9_900 },
    { ate: 1_800_000, aliq: 0.205, deducao: 17_100 },
    { ate: 3_600_000, aliq: 0.23, deducao: 62_100 },
    { ate: 4_800_000, aliq: 0.305, deducao: 540_000 },
  ],
};

/** Alíquota EFETIVA do Simples para um RBT12 no anexo dado (fórmula da LC 123).
 *  RBT12 acima do teto usa a última faixa (o CHECK aponta o estouro). */
export function aliquotaEfetivaSimples(rbt12: number, anexo: "I" | "II" | "III" | "IV" | "V"): number {
  const faixas = SIMPLES_ANEXOS[anexo];
  const base = Math.max(1, rbt12);
  const faixa = faixas.find((f) => base <= f.ate) ?? faixas[faixas.length - 1];
  return Math.max(0, (base * faixa.aliq - faixa.deducao) / base);
}

/** Encargos DEFAULT por tipo de contrato (% sobre o salário) — editável por
 *  posição. CLT ≈ INSS patronal 20% + RAT/terceiros ~7,8% + FGTS 8% + 13º 8,33%
 *  + férias+1/3 11,11% + encargos sobre provisões ≈ 68% (Lucro Presumido/Real;
 *  no Simples ajuste para ~35-40%). Pró-labore: CPP 20%. Estágio: recesso ~8,3%. */
export const ENCARGOS_PADRAO: Record<Posicao["tipoContrato"], number> = {
  clt: 0.68,
  pj: 0,
  prolabore: 0.2,
  estagio: 0.083,
};

export interface BlocoModelo {
  id: string;
  tipo: "receitas" | "custos" | "despesas" | string;
  nome: string;
  ativo: boolean;
  config: {
    /** Linhas com ÁRVORE DE DRIVERS (mesma estrutura em qualquer bloco):
     *  em "receitas" somam na receita; em "custos"/"despesas" somam no grupo
     *  do bloco. O nome do campo é histórico — leia como "linhas com drivers". */
    linhasReceita?: LinhaReceita[];
    /** Linhas SIMPLES de custos/despesas (% da receita, fixo+reajuste, série). */
    linhasCusto?: LinhaCusto[];
    /** Só bloco RECEITAS: deduções da receita (vendas canceladas, devoluções e
     *  abatimentos) como % da receita BRUTA — flat + por ano calendário. */
    deducoesPct?: number;
    deducoesPorAno?: Record<string, number>;
    /** Só em bloco CAPEX: imobilizado que a empresa JÁ TEM na largada… */
    saldoInicialImobilizado?: number;
    /** …e a taxa de depreciação linear dele (a.a.). */
    depreciacaoLegadoAnual?: number;
    /** Só em bloco CAPEX: ativos existentes POR CLASSE (substitui os 2 campos
     *  acima quando presente — eles ficam como retrocompatibilidade). */
    ativosExistentes?: AtivoExistente[];
    /** Só em bloco GIRO (capital de giro): dias de PMR/PME/PMP — flat + por ano
     *  (ano sem valor repete o vigente, como os %s dos custos). */
    pmr?: number;
    pme?: number;
    pmp?: number;
    pmrPorAno?: Record<string, number>;
    pmePorAno?: Record<string, number>;
    pmpPorAno?: Record<string, number>;
    /** Só em bloco GIRO: caixa e equivalentes no INÍCIO do horizonte (abertura
     *  do corkscrew de caixa do Fluxo de Caixa/Balanço projetado). */
    caixaInicial?: number;
    /** Só em bloco GIRO: outros itens do balanço (mútuos, antecipações,
     *  impostos/pessoal a pagar…) — ver ItemBalanco. */
    itensBalanco?: ItemBalanco[];
    /** Só em bloco GIRO: o seed do BP histórico já rodou (não re-semear o que
     *  o analista excluiu de propósito). */
    itensBalancoSeed?: boolean;
    /** Só em bloco FOLHA (B4): posições/cargos. */
    posicoes?: Posicao[];
    /** Só em bloco FOLHA: encargos POR CONTRATO válidos para toda a estrutura
     *  (% sobre o salário) — sobrepõe o ENCARGOS_PADRAO. */
    encargosPorContrato?: Record<string, number>;
    /** Só em bloco DÍVIDA (B8): contratos de empréstimo/financiamento. */
    contratos?: ContratoDivida[];
    /** Só em bloco IMPOSTOS (F3): regime tributário e parâmetros. */
    impostos?: ConfigImpostos;
    /** Só em bloco WACC (F5): premissas da taxa de desconto (o cálculo do WACC
     *  é determinístico na tela/export; o motor mensal não o usa — ainda). */
    wacc?: Record<string, unknown>;
    /** Só em bloco VALUATION (F5): g na perpetuidade e DLOM. */
    valuation?: Record<string, unknown>;
    /** Só em bloco REFORMA: premissas da comparação atual × CBS/IBS
     *  (categoria de redução, alíquotas de referência, base creditável). */
    reforma?: import("./reforma-tributaria").ConfigReforma;
    /** Só em bloco DASHBOARD: linhas de despesa marcadas como aquisição (CAC)
     *  — só exibição; o motor não usa. */
    dashboard?: { linhasCac?: string[] };
  };
}

/** SNAPSHOT dos índices macroeconômicos (BCB — Boletim Focus + PTAX) gravado
 *  NO MODELO: a projeção é reproduzível/auditável (não muda porque o Focus
 *  mudou; o botão Atualizar renova o snapshot e recalcula). Números-porcentagem
 *  por ano (4.5 = 4,5%); cambioNivel/cambioAtual em R$/US$. */
export interface IndicesMacroSnapshot {
  atualizadoEm?: string;
  dataPesquisa?: string | null;
  fonte?: string;
  cambioAtual?: number | null;
  indices?: {
    ipca?: Record<string, number>;
    igpm?: Record<string, number>;
    selic?: Record<string, number>;
    cambioNivel?: Record<string, number>;
    cambioVar?: Record<string, number>;
    pib?: Record<string, number>;
  };
}

/** Catálogo dos índices macro utilizáveis em FÓRMULAS (chips da tela e IA).
 *  Taxas viram a MENSAL EQUIVALENTE composta ((1+a.a.)^(1/12)−1 — 12 meses
 *  fecham exatamente o ano); IPCA/IGP-M ganham também o FATOR ACUMULADO
 *  (1 no 1º mês do horizonte, multiplicando dali em diante) — é ele que
 *  corrige aluguel/contrato: valor base × fator. */
export const SERIES_MACRO: Array<{ id: string; key: "ipca" | "igpm" | "selic" | "cambioVar" | "pib"; nome: string; acumId?: string; nomeAcum?: string }> = [
  { id: "macro_ipca", key: "ipca", nome: "IPCA — taxa mensal equivalente", acumId: "macro_ipca_acum", nomeAcum: "Fator acumulado do IPCA (1º mês = 1)" },
  { id: "macro_igpm", key: "igpm", nome: "IGP-M — taxa mensal equivalente", acumId: "macro_igpm_acum", nomeAcum: "Fator acumulado do IGP-M (1º mês = 1)" },
  { id: "macro_selic", key: "selic", nome: "Selic/CDI — taxa mensal equivalente" },
  { id: "macro_cambio_var", key: "cambioVar", nome: "Variação mensal do câmbio (US$)" },
  { id: "macro_pib", key: "pib", nome: "PIB — crescimento mensal equivalente" },
];
export const MACRO_CAMBIO = { id: "macro_cambio", nome: "Câmbio R$/US$ (nível do mês)" };

/** Nó injetado no grafo sem vir da config: série PRONTA (valores), quantidade
 *  de posição POR VARIÁVEL (qtdPosicao — avaliada mês a mês: ceil(variável ÷
 *  cobertura), com piso) ou SOMA de outros nós (somaIds — ex.: headcount total). */
interface SerieFixa {
  id: string;
  nome: string;
  unidade: UnidadeNode;
  tipo: TipoNode;
  valores?: Serie;
  qtdPosicao?: Posicao;
  somaIds?: string[];
}

/** Série × (−1) e soma de séries — montagem das linhas do FC/BP. */
function negativoDe(serie: Serie | undefined, meses: string[]): Serie {
  const out: Serie = {};
  for (const m of meses) out[m] = -(serie?.[m] ?? 0);
  return out;
}
function somaDe(a: Serie, b: Serie, meses: string[]): Serie {
  const out: Serie = {};
  for (const m of meses) out[m] = (a[m] ?? 0) + (b[m] ?? 0);
  return out;
}

/** Valor anual por ano do horizonte com CARRY (ano além do dado repete o
 *  último; anos antes do primeiro usam o primeiro). null = índice sem dados. */
function resolverPorAno(porAno: Record<string, number> | undefined, anos: string[]): Record<string, number> | null {
  if (!porAno) return null;
  const chaves = Object.keys(porAno).filter((k) => typeof porAno[k] === "number").sort();
  if (!chaves.length) return null;
  const res: Record<string, number> = {};
  let vigente = porAno[chaves[0]];
  for (const ano of anos) {
    if (typeof porAno[ano] === "number") vigente = porAno[ano];
    res[ano] = vigente;
  }
  return res;
}

/** Séries mensais dos índices macro a partir do snapshot. Ano além do snapshot
 *  repete o último conhecido (regra "ano vazio continua o último"). */
function seriesMacroDe(snap: IndicesMacroSnapshot | null | undefined, meses: string[]): SerieFixa[] {
  const out: SerieFixa[] = [];
  const idx = snap?.indices;
  if (!idx || !meses.length) return out;
  const anos = [...new Set(meses.map((m) => m.slice(0, 4)))];

  for (const def of SERIES_MACRO) {
    const porAno = resolverPorAno(idx[def.key], anos);
    if (!porAno) continue;
    const mensal: Serie = {};
    const acum: Serie = {};
    let fator = 1;
    for (let i = 0; i < meses.length; i++) {
      const mes = meses[i];
      const aa = Math.max(-0.99, (porAno[mes.slice(0, 4)] ?? 0) / 100); // % → fração
      const m = Math.pow(1 + aa, 1 / 12) - 1;
      mensal[mes] = m;
      if (i > 0) fator *= 1 + m; // fator = 1 no 1º mês (a correção começa no 2º)
      acum[mes] = fator;
    }
    out.push({ id: def.id, nome: def.nome, unidade: "%", tipo: "taxa", valores: mensal });
    if (def.acumId) out.push({ id: def.acumId, nome: def.nomeAcum!, unidade: "%", tipo: "taxa", valores: acum });
  }

  // Câmbio: NÍVEL R$/US$ — interpolação linear do câmbio de hoje (PTAX) até o
  // fim do 1º ano, e de fim de ano a fim de ano dali em diante.
  const niveis = resolverPorAno(idx.cambioNivel, anos);
  if (niveis) {
    const serie: Serie = {};
    let base = typeof snap?.cambioAtual === "number" && snap.cambioAtual > 0 ? snap.cambioAtual : niveis[anos[0]];
    let mesBase = Number(meses[0].split("-")[1]) - 1; // âncora do 1º ano = mês anterior ao início
    for (const mes of meses) {
      const alvo = niveis[mes.slice(0, 4)];
      const mesNum = Number(mes.split("-")[1]);
      serie[mes] = base + (alvo - base) * ((mesNum - mesBase) / (12 - mesBase));
      if (mesNum === 12) { base = alvo; mesBase = 0; }
    }
    out.push({ id: MACRO_CAMBIO.id, nome: MACRO_CAMBIO.nome, unidade: "R$/un", tipo: "preco", valores: serie });
  }
  return out;
}

/** Quantidade MENSAL de uma posição projetada por PREMISSA (Por ano/Por mês) —
 *  null para "por variável" (depende de outra série; o bloco folha resolve).
 *  Usada 2×: no bloco folha e para injetar a posição como VARIÁVEL DO NEGÓCIO
 *  (nó "folha_{id}_qtd" [#] — custo = pessoas × R$/pessoa) sem divergência. */
function qtdPremissaDaPosicao(pos: Posicao, meses: string[], anosLista: string[]): Serie | null {
  if (pos.modoQtd === "variavel") return null;
  const qtd: Serie = {};
  if (pos.modoQtd === "mes") {
    for (const mes of meses) qtd[mes] = Math.max(0, Math.round(num(pos.qtdMeses?.[mes])));
    return qtd;
  }
  // modo ANO: alvo = pessoas no FIM do ano. "janeiro" muda na virada;
  // "rampa" interpola LINEAR do fim do ano anterior até o alvo (dez = alvo).
  let anterior = 0;
  let primeiroComValor = true;
  let alvoVigente = 0;
  for (const ano of anosLista) {
    const alvoBruto = pos.qtdPorAno?.[ano];
    const alvo = typeof alvoBruto === "number" ? Math.max(0, Math.round(alvoBruto)) : alvoVigente; // ano vazio repete
    const mesesAno = meses.filter((m) => m.startsWith(ano));
    if (primeiroComValor) {
      // 1º ano do horizonte: vale o alvo o ano inteiro (não há "de onde" rampar).
      for (const m of mesesAno) qtd[m] = alvo;
    } else if (pos.distribuicao === "rampa" && alvo !== anterior) {
      mesesAno.forEach((m, k) => {
        qtd[m] = Math.round(anterior + ((alvo - anterior) * (k + 1)) / mesesAno.length);
      });
    } else {
      for (const m of mesesAno) qtd[m] = alvo;
    }
    anterior = alvo;
    alvoVigente = alvo;
    primeiroComValor = false;
  }
  return qtd;
}

/** Overrides de cenário: { nodeId: { param: valor } } e { linhaCustoId: { pct|valorMensal } }. */
export type ScenarioOverrides = Record<string, Record<string, unknown>>;

export interface RealizadoModelo {
  /** Meses FECHADOS (ordem qualquer), "YYYY-MM". */
  meses: string[];
  /** Totais observados por grupo (mínimo p/ F1). */
  porGrupo?: { receita?: Serie; custos?: Serie; despesas?: Serie };
  /** Séries observadas por linha do modelo (quando o seed acoplou conta↔linha). */
  porLinha?: Record<string, Serie>;
}

export interface ModeloInput {
  mesInicial: string; // 1º mês do horizonte (pode coincidir com meses realizados)
  horizonteMeses: number;
  blocks: BlocoModelo[];
  overrides?: ScenarioOverrides;
  realizado?: RealizadoModelo | null;
  /** Snapshot dos índices macro do modelo → vira séries macro_* nas fórmulas. */
  indicesMacro?: IndicesMacroSnapshot | null;
  /** REFORMA TRIBUTÁRIA (LC 214/2025): quando presente, os impostos sobre o
   *  consumo são calculados no MUNDO NOVO (CBS+IBS com transição 2026-2033)
   *  no lugar de PIS/COFINS/ISS/ICMS — usado pela comparação "atual × reforma".
   *  Simples permanece no DAS (a carga própria não muda). */
  reforma?: import("./reforma-tributaria").ConfigReforma | null;
}

export interface CheckModelo {
  id: string;
  nome: string;
  ok: boolean;
  /** Prova/explicação legível (verde só com prova; vermelho diz onde). */
  prova: string;
}

export interface LinhaDre {
  id: string;
  nome: string;
  grupo: "receita" | "custos" | "despesas" | "subtotal";
  valores: Serie;
  pctReceita: Serie;
}

export interface ResultadoModelo {
  meses: string[];
  /** Selo por mês: valores observados (real) ou projetados (proj). */
  statusMes: Record<string, "real" | "proj">;
  series: Record<string, Serie>;
  dre: LinhaDre[];
  /** Fluxo de caixa INDIRETO (linhas mensais; anual = soma). */
  fc: LinhaDre[];
  /** Balanço projetado (linhas mensais; anual = FIM do ano, é saldo). */
  bp: LinhaDre[];
  agregacoes: { anual: Record<string, Record<string, number>> }; // {linhaId: {"2026": total}}
  kpis: Array<{ id: string; nome: string; valores: Serie }>;
  checks: CheckModelo[];
  erros: string[];
}

// ── Meses ──────────────────────────────────────────────────────────────────

export function mesAdd(mes: string, n: number): string {
  const [y, m] = mes.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

function listaMeses(inicial: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => mesAdd(inicial, i));
}

// ── Dimensões (análise dimensional) ────────────────────────────────────────
// Unidade → vetor de expoentes {rs, un}. "%" é adimensional.
// Multiplicação soma expoentes; divisão subtrai; soma/subtração exige igualdade.

type Dim = { rs: number; un: number };

const DIM_POR_UNIDADE: Record<UnidadeNode, Dim> = {
  "R$": { rs: 1, un: 0 },
  "#": { rs: 0, un: 1 },
  "%": { rs: 0, un: 0 },
  "R$/un": { rs: 1, un: -1 },
  // Quantidade POR UNIDADE (horas por profissional, operações por cliente):
  // razão adimensional — multiplicada pela contagem, devolve a contagem certa.
  "#/un": { rs: 0, un: 0 },
};

function dimIgual(a: Dim, b: Dim): boolean {
  return a.rs === b.rs && a.un === b.un;
}

function dimNome(d: Dim): string {
  if (d.rs === 1 && d.un === 0) return "R$";
  if (d.rs === 0 && d.un === 1) return "#";
  if (d.rs === 0 && d.un === 0) return "%/adimensional";
  if (d.rs === 1 && d.un === -1) return "R$/un";
  return `rs^${d.rs}·un^${d.un}`;
}

// ── Parser de expressões (sem eval) ────────────────────────────────────────
// Gramática: expr := termo (('+'|'-') termo)* ; termo := fator (('*'|'/') fator)* ;
// fator := numero | ident | '(' expr ')' | ('min'|'max') '(' expr ',' expr ')'
//        | ('anterior'|'futuro') '(' expr [',' inteiro] ')' | '-' fator
// anterior(x[, n]) = valor de x N MESES ATRÁS (padrão 1). Antes do horizonte
// vale o próprio mês (variação zero na partida).
// futuro(x[, n]) = valor de x N MESES À FRENTE (padrão 1; 12 = um ano). Além do
// horizonte vale ZERO (não existe projeção lá) — quem usa futuro() calcula numa
// ONDA posterior, depois que o alvo fechou o horizonte inteiro.

type Ast =
  | { k: "num"; v: number }
  | { k: "ref"; id: string }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; a: Ast; b: Ast }
  | { k: "fn"; fn: "min" | "max"; a: Ast; b: Ast }
  | { k: "lag"; a: Ast; n: number }
  | { k: "lead"; a: Ast; n: number }
  | { k: "mavg"; a: Ast; n: number } // media(x, n): média dos últimos n meses (incluindo o atual)
  | { k: "neg"; a: Ast };

function tokenizar(expr: string): string[] {
  const toks: string[] = [];
  const re = /\s*([A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[()+\-*/,])/g;
  let m: RegExpExecArray | null;
  let consumido = 0;
  while ((m = re.exec(expr))) {
    toks.push(m[1]);
    consumido = re.lastIndex;
  }
  if (expr.slice(consumido).trim().length > 0) {
    throw new Error(`Expressão inválida perto de "${expr.slice(consumido).trim().slice(0, 12)}"`);
  }
  return toks;
}

function parseExpr(expr: string): Ast {
  const toks = tokenizar(expr);
  let pos = 0;
  const olhar = () => toks[pos];
  const comer = () => toks[pos++];

  function fator(): Ast {
    const t = olhar();
    if (t === undefined) throw new Error("Expressão terminou cedo");
    if (t === "-") { comer(); return { k: "neg", a: fator() }; }
    if (t === "(") {
      comer();
      const e = e0();
      if (comer() !== ")") throw new Error("Faltou ')'");
      return e;
    }
    if (t === "min" || t === "max") {
      comer();
      if (comer() !== "(") throw new Error(`Faltou '(' após ${t}`);
      const a = e0();
      if (comer() !== ",") throw new Error(`Faltou ',' em ${t}()`);
      const b = e0();
      if (comer() !== ")") throw new Error(`Faltou ')' em ${t}()`);
      return { k: "fn", fn: t, a, b };
    }
    if (t === "media") {
      comer();
      if (comer() !== "(") throw new Error("Faltou '(' após media");
      const a = e0();
      if (comer() !== ",") throw new Error("media(x, n): informe o número de meses — ex.: media(Receita, 3)");
      const nt = comer();
      if (!nt || !/^\d+$/.test(nt) || Number(nt) < 1) throw new Error("media(x, n): n deve ser um número inteiro de meses (1, 2, 3…)");
      if (comer() !== ")") throw new Error("Faltou ')' em media()");
      return { k: "mavg", a, n: Number(nt) };
    }
    if (t === "anterior" || t === "futuro") {
      comer();
      if (comer() !== "(") throw new Error(`Faltou '(' após ${t}`);
      const a = e0();
      let n = 1;
      if (olhar() === ",") {
        comer();
        const nt = comer();
        if (!nt || !/^\d+$/.test(nt) || Number(nt) < 1) throw new Error(`${t}(x, n): n deve ser um número inteiro de meses (1, 2, 3…)`);
        n = Number(nt);
      }
      if (comer() !== ")") throw new Error(`Faltou ')' em ${t}()`);
      return t === "anterior" ? { k: "lag", a, n } : { k: "lead", a, n };
    }
    if (/^\d/.test(t)) { comer(); return { k: "num", v: Number(t) }; }
    comer();
    return { k: "ref", id: t };
  }

  function termo(): Ast {
    let a = fator();
    while (olhar() === "*" || olhar() === "/") {
      const op = comer() as "*" | "/";
      a = { k: "bin", op, a, b: fator() };
    }
    return a;
  }

  function e0(): Ast {
    let a = termo();
    while (olhar() === "+" || olhar() === "-") {
      const op = comer() as "+" | "-";
      a = { k: "bin", op, a, b: termo() };
    }
    return a;
  }

  const ast = e0();
  if (pos !== toks.length) throw new Error(`Sobrou token "${toks[pos]}" na expressão`);
  return ast;
}

/** Valida uma fórmula avulsa (parser + refs conhecidas). Null = ok; senão o erro.
 *  Usado pela geração de fórmula por IA: nada entra no modelo sem passar aqui. */
export function validarFormula(expr: string, idsConhecidos: Set<string>): string | null {
  try {
    const ast = parseExpr(expr);
    const refs = new Set<string>();
    refsDo(ast, refs);
    const desconhecidas = [...refs].filter((r) => !idsConhecidos.has(r));
    if (desconhecidas.length) return `Variáveis desconhecidas: ${desconhecidas.join(", ")}`;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function refsDo(ast: Ast, out: Set<string>): void {
  if (ast.k === "ref") out.add(ast.id);
  else if (ast.k === "bin" || ast.k === "fn") { refsDo(ast.a, out); refsDo(ast.b, out); }
  else if (ast.k === "neg" || ast.k === "lag" || ast.k === "lead" || ast.k === "mavg") refsDo(ast.a, out);
}

/** Refs que valem para a ORDENAÇÃO do mês corrente: o que está dentro de
 *  anterior()/futuro() usa OUTRO mês — fica fora do grafo do mês, como o saldo
 *  de abertura do corkscrew. */
function refsParaOrdenacao(ast: Ast, out: Set<string>): void {
  if (ast.k === "ref") out.add(ast.id);
  else if (ast.k === "bin" || ast.k === "fn") { refsParaOrdenacao(ast.a, out); refsParaOrdenacao(ast.b, out); }
  else if (ast.k === "neg" || ast.k === "mavg") refsParaOrdenacao(ast.a, out); // media inclui o mês corrente
  // k === "lag"/"lead": outro mês — não é dependência dentro do mês
}

/** Refs DESLOCADAS no tempo, para as ONDAS de cálculo: `lag` = mês passado
 *  (basta estar na mesma onda ou antes); `lead` = mês futuro (o alvo precisa
 *  ter fechado o horizonte inteiro → onda anterior). Uma ref aninhada dentro de
 *  futuro() conta como lead mesmo se houver anterior() por fora (conservador). */
function refsDeslocadas(ast: Ast, lag: Set<string>, lead: Set<string>, dentroLead = false, dentroLag = false): void {
  if (ast.k === "ref") {
    if (dentroLead) lead.add(ast.id);
    else if (dentroLag) lag.add(ast.id);
    return;
  }
  if (ast.k === "bin" || ast.k === "fn") {
    refsDeslocadas(ast.a, lag, lead, dentroLead, dentroLag);
    refsDeslocadas(ast.b, lag, lead, dentroLead, dentroLag);
  } else if (ast.k === "neg" || ast.k === "mavg") refsDeslocadas(ast.a, lag, lead, dentroLead, dentroLag);
  else if (ast.k === "lag") refsDeslocadas(ast.a, lag, lead, dentroLead, true);
  else if (ast.k === "lead") refsDeslocadas(ast.a, lag, lead, true, dentroLag);
}

/** Avaliação com DESLOCAMENTO de mês acumulado: anterior()/futuro() somam no
 *  delta e o resolver decide o valor de (id, delta) — aninhamento compõe
 *  naturalmente (anterior(futuro(x, 3)) = x 2 meses à frente). */
function avaliarAst(ast: Ast, resolver: (id: string, delta: number) => number, delta = 0): number {
  switch (ast.k) {
    case "num": return ast.v;
    case "ref": return resolver(ast.id, delta);
    case "neg": return -avaliarAst(ast.a, resolver, delta);
    case "lag": return avaliarAst(ast.a, resolver, delta - ast.n);
    case "lead": return avaliarAst(ast.a, resolver, delta + ast.n);
    case "mavg": {
      // Média dos últimos n meses (o corrente + n−1 anteriores). Antes do
      // horizonte, os meses faltantes valem o mês corrente (média "aquece").
      let soma = 0;
      for (let k = 0; k < ast.n; k++) soma += avaliarAst(ast.a, resolver, delta - k);
      return soma / ast.n;
    }
    case "fn": {
      const a = avaliarAst(ast.a, resolver, delta);
      const b = avaliarAst(ast.b, resolver, delta);
      return ast.fn === "min" ? Math.min(a, b) : Math.max(a, b);
    }
    case "bin": {
      const a = avaliarAst(ast.a, resolver, delta);
      const b = avaliarAst(ast.b, resolver, delta);
      if (ast.op === "+") return a + b;
      if (ast.op === "-") return a - b;
      if (ast.op === "*") return a * b;
      return b === 0 ? 0 : a / b; // divisão por zero → 0 (não NaN; check aponta se relevante)
    }
  }
}

function dimAst(ast: Ast, dimDe: (id: string) => Dim, caminho: string): Dim {
  switch (ast.k) {
    case "num": return { rs: 0, un: 0 };
    case "ref": return dimDe(ast.id);
    case "neg": return dimAst(ast.a, dimDe, caminho);
    case "lag": return dimAst(ast.a, dimDe, caminho); // mesma unidade, mês passado
    case "lead": return dimAst(ast.a, dimDe, caminho); // mesma unidade, mês futuro
    case "mavg": return dimAst(ast.a, dimDe, caminho); // média preserva a unidade
    case "fn": {
      // Literal como piso/teto (ex.: max(x − y, 0)) assume a unidade do outro lado.
      if (ast.a.k === "num") return dimAst(ast.b, dimDe, caminho);
      if (ast.b.k === "num") return dimAst(ast.a, dimDe, caminho);
      const a = dimAst(ast.a, dimDe, caminho);
      const b = dimAst(ast.b, dimDe, caminho);
      if (!dimIgual(a, b)) throw new Error(`${caminho}: min/max entre ${dimNome(a)} e ${dimNome(b)}`);
      return a;
    }
    case "bin": {
      const a = dimAst(ast.a, dimDe, caminho);
      const b = dimAst(ast.b, dimDe, caminho);
      if (ast.op === "+" || ast.op === "-") {
        if (!dimIgual(a, b)) throw new Error(`${caminho}: soma de ${dimNome(a)} com ${dimNome(b)}`);
        return a;
      }
      if (ast.op === "*") return { rs: a.rs + b.rs, un: a.un + b.un };
      return { rs: a.rs - b.rs, un: a.un - b.un };
    }
  }
}

// ── Avaliação de nós ───────────────────────────────────────────────────────

interface NoResolvido {
  node: DriverNode;
  params: Record<string, unknown>;
  ast?: Ast;
  deps: string[];
  /** Referências que resolvem para o SALDO DE ABERTURA (mês anterior) de um estoque.
   *  Semântica de planilha: o churn do mês M é calculado sobre a base que ABRIU o mês
   *  (fechamento de M−1) — é isso que quebra o "ciclo" feeder↔estoque do corkscrew. */
  refsAbertura: Set<string>;
  /** Refs dentro de anterior(): mês passado — mesma onda ou anterior. */
  refsLag: Set<string>;
  /** Refs dentro de futuro(): mês à frente — o alvo calcula numa onda ANTERIOR. */
  refsLead: Set<string>;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Valor de um nó "tipo série" no mês de índice i (0-based no horizonte).
 *
 *  Modos de preenchimento (params.modoPreenchimento, escolhido na UI):
 *  - "mes":     params.valores {"YYYY-MM": n} — grade mensal (colável do Excel);
 *               mês ausente cai na base (permite preencher só um trecho).
 *  - "ano":     params.valoresAno {"YYYY": n} — para [R$] o número é o TOTAL DO ANO
 *               (espalhado /12 × sazonalidade); para taxa/preço/# é o valor vigente.
 *  - "simples": valorMensal × (1+crescimentoAnual)^(i/12) × sazonalidade.
 *  Sem modo declarado (legado): valores[mes] explícito vence, depois a base. */
function valorSerie(
  params: Record<string, unknown>,
  unidade: UnidadeNode,
  tipo: TipoNode,
  mes: string,
  i: number,
  mesesDoAno: number[] // números (1-12) dos meses deste ano DENTRO do horizonte
): number {
  const modo = params.modoPreenchimento as string | undefined;
  const valores = params.valores as Serie | undefined;
  const valoresAno = params.valoresAno as Record<string, number> | undefined;
  const ano = mes.slice(0, 4);
  const mesNum = Number(mes.split("-")[1]);
  const saz = params.sazonalidade as number[] | undefined;
  const temSaz = Array.isArray(saz) && saz.length === 12;
  const fatorSaz = temSaz ? num(saz[mesNum - 1], 1) : 1;
  // Multiplicador de CENÁRIO: escala o driver inteiro (qualquer modo de preenchimento).
  const multi = num(params.multiplicador, 1);

  // Extensiva = FLUXO somável (vendas, novos clientes, R$ do período).
  // NÍVEL vigente NÃO anualiza: capacidade [#] (equipe, quartos, dias) e
  // R$ declarado como preco/capacidade (salário, mensalidade, aluguel mensal).
  const vigentePorTipo = tipo === "capacidade" || tipo === "preco";
  const extensiva = (unidade === "R$" || unidade === "#" || unidade === "#/un") && !vigentePorTipo;

  // O MENSAL MANDA: valor mensal explícito vence qualquer modo — a tela anual é
  // só uma lente que escreve/lê estes meses (regra canônica do produto).
  const podeMes = valores && typeof valores[mes] === "number";
  if (podeMes) return valores![mes] * multi;

  const podeAno = (modo === undefined || modo === "ano") && valoresAno && typeof valoresAno[ano] === "number";
  if (podeAno) {
    // EXTENSIVAS (R$, quantidade #): o número do ano é o TOTAL do ano.
    // INTENSIVAS (%, R$/un): o número é o valor VIGENTE nos meses do ano.
    if (!extensiva) return valoresAno![ano] * multi;
    // Total do ano distribuído pelos meses do ano NO HORIZONTE. Com sazonalidade,
    // o rateio segue o PESO de cada mês normalizado pelos meses presentes —
    // a soma dos meses SEMPRE fecha no total informado (ano cheio ou parcial).
    if (temSaz) {
      const somaPesos = mesesDoAno.reduce((s, m) => s + num(saz![m - 1], 1), 0);
      return somaPesos > 0 ? valoresAno![ano] * (fatorSaz / somaPesos) * multi : 0;
    }
    return (valoresAno![ano] / Math.max(1, mesesDoAno.length)) * multi;
  }

  const base = num(params.valorMensal);
  const g = num(params.crescimentoAnual);
  return base * Math.pow(1 + g, i / 12) * fatorSaz * multi;
}

/** Modo "Por ano": materializa valoresAno para TODOS os anos do horizonte, para
 *  os modos ficarem EXCLUSIVOS (ano vazio nunca cai no Simples escondido):
 *  - ano vazio CONTINUA o último informado — pela TAXA MENSAL em [R$] (ano
 *    parcial de 6 meses a 10.000 → ano cheio seguinte 20.000, não 10.000);
 *  - anos ANTES do primeiro informado usam a taxa do primeiro (backfill);
 *  - modoAno "crescimento": % do ano aplica sobre a taxa mensal do anterior;
 *  - nada informado → o modo Por ano fica inerte e vale o Simples.
 *  Valor explícito num ano REINICIA a base. */
function materializarPorAno(
  params: Record<string, unknown>,
  unidade: UnidadeNode,
  tipo: TipoNode,
  anosInfo: Array<{ ano: string; meses: number }>
): void {
  if (params.modoPreenchimento !== "ano") return;
  const modoCrescimento = params.modoAno === "crescimento";
  const explicitos = (params.valoresAno ?? {}) as Record<string, number>;
  const cres = (params.crescimentoPorAno ?? {}) as Record<string, number>;
  const ehRs = (unidade === "R$" || unidade === "#" || unidade === "#/un") && tipo !== "capacidade" && tipo !== "preco"; // extensivas: taxa mensal = total/meses
  const primeiroIdx = anosInfo.findIndex((a) => typeof explicitos[a.ano] === "number");
  if (primeiroIdx < 0) { delete params.valoresAno; return; }

  const taxaDe = (a: { ano: string; meses: number }) => (ehRs ? explicitos[a.ano] / Math.max(1, a.meses) : explicitos[a.ano]);
  const efetivo: Record<string, number> = {};
  let taxa = taxaDe(anosInfo[primeiroIdx]);
  // Backfill: anos anteriores ao primeiro informado usam a mesma taxa mensal.
  for (let k = 0; k < primeiroIdx; k++) {
    efetivo[anosInfo[k].ano] = ehRs ? taxa * anosInfo[k].meses : taxa;
  }
  for (let k = primeiroIdx; k < anosInfo.length; k++) {
    const a = anosInfo[k];
    if (typeof explicitos[a.ano] === "number") taxa = taxaDe(a);
    else if (modoCrescimento && typeof cres[a.ano] === "number") taxa = taxa * (1 + cres[a.ano]);
    // sem valor e sem % → taxa carrega (continua o último ano)
    efetivo[a.ano] = ehRs ? taxa * a.meses : taxa;
  }
  params.valoresAno = efetivo;
}

/** Ao RECUAR o início da projeção, os meses que ENTRAM no começo do horizonte
 *  ganham premissa: todo driver/linha com meses explícitos repete PARA TRÁS o
 *  valor do primeiro mês informado — a mesma régua do backfill do Por ano
 *  ("anos antes do primeiro informado usam a taxa do primeiro"). Sem isso, os
 *  meses novos projetariam ZERO e a próxima edição materializaria o zero.
 *  Meses que JÁ têm valor explícito são preservados (voltar atrás nunca perde
 *  dado digitado). Retorna a memória do que foi preenchido, por bloco. */
export function backfillPremissasAoRecuar(
  blocks: BlocoModelo[],
  novoInicio: string,
  inicioAntigo: string
): Array<{ blocoId: string; memoria: string }> {
  const out: Array<{ blocoId: string; memoria: string }> = [];
  if (!/^\d{4}-\d{2}$/.test(novoInicio) || novoInicio >= inicioAntigo) return out;

  // Meses novos: de novoInicio até o mês ANTERIOR ao início antigo.
  const novos: string[] = [];
  let [y, m] = novoInicio.split("-").map(Number);
  for (let guarda = 0; guarda < 240; guarda++) {
    const mes = `${y}-${String(m).padStart(2, "0")}`;
    if (mes >= inicioAntigo) break;
    novos.push(mes);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }

  const preencher = (valores: Serie, rotulo: string, blocoId: string) => {
    const chaves = Object.keys(valores).filter((k) => typeof valores[k] === "number").sort();
    if (!chaves.length) return;
    const primeiro = chaves[0];
    const alvos = novos.filter((mes) => mes < primeiro && typeof valores[mes] !== "number");
    if (!alvos.length) return;
    for (const mes of alvos) valores[mes] = valores[primeiro];
    out.push({ blocoId, memoria: `${rotulo}: ${alvos.length} mês(es) novos ← ${valores[primeiro]} (valor de ${primeiro})` });
  };

  for (const b of blocks) {
    for (const linha of b.config.linhasReceita ?? []) {
      for (const node of linha.nodes) {
        const valores = node.params.valores as Serie | undefined;
        if (valores) preencher(valores, `"${linha.nome}" › "${node.nome}"`, b.id);
      }
    }
    for (const linha of b.config.linhasCusto ?? []) {
      if (linha.valores) preencher(linha.valores, `"${linha.nome}"`, b.id);
    }
  }
  return out;
}

function resolverNos(
  blocks: BlocoModelo[],
  overrides: ScenarioOverrides,
  anosInfo: Array<{ ano: string; meses: number }>,
  erros: string[],
  seriesFixas: SerieFixa[] = []
): Map<string, NoResolvido> {
  const nos = new Map<string, NoResolvido>();
  // Nós INJETADOS (índices macro, posições da folha, totais): ids macro_*/
  // folha_* são reservados (duplicar vira erro abaixo).
  for (const sf of seriesFixas) {
    const params: Record<string, unknown> = sf.qtdPosicao
      ? { __qtdPosicao: sf.qtdPosicao }
      : sf.somaIds
        ? { __somaIds: sf.somaIds }
        : { valores: sf.valores };
    const deps = sf.qtdPosicao?.variavelRef ? [sf.qtdPosicao.variavelRef] : (sf.somaIds ?? []);
    const node: DriverNode = { id: sf.id, tipo: sf.tipo, nome: sf.nome, unidade: sf.unidade, params: {} };
    nos.set(sf.id, {
      node,
      params: { ...params, ...(overrides[sf.id] ?? {}) }, // cenário pode escalar
      ast: undefined, deps, refsAbertura: new Set(), refsLag: new Set(), refsLead: new Set(),
    });
  }
  for (const b of blocks) {
    if (!b.ativo) continue;
    for (const linha of b.config.linhasReceita ?? []) {
      for (const node of linha.nodes) {
        if (nos.has(node.id)) {
          erros.push(`Nó duplicado: "${node.id}" (linha ${linha.nome})`);
          continue;
        }
        const params = { ...node.params, ...(overrides[node.id] ?? {}) };
        materializarPorAno(params, node.unidade, node.tipo, anosInfo);
        const deps: string[] = [];
        const refsLag = new Set<string>();
        const refsLead = new Set<string>();
        let ast: Ast | undefined;
        const expr = params.expr as string | undefined;
        if ((node.tipo === "formula" || node.tipo === "fluxo") && expr) {
          try {
            ast = parseExpr(expr);
            const s = new Set<string>();
            refsParaOrdenacao(ast, s); // refs dentro de anterior()/futuro() ficam fora do grafo do mês
            s.forEach((d) => deps.push(d));
            refsDeslocadas(ast, refsLag, refsLead);
          } catch (e) {
            erros.push(`Fórmula do nó "${node.nome}": ${e instanceof Error ? e.message : e}`);
          }
        }
        if (node.tipo === "estoque") {
          const ent = params.entradasRef as string | undefined;
          const sai = params.saidasRef as string | undefined;
          if (ent) deps.push(ent);
          if (sai) deps.push(sai);
        }
        nos.set(node.id, { node, params, ast, deps, refsAbertura: new Set(), refsLag, refsLead });
      }
    }
  }

  // Nó sintético "receita_total": soma das raízes das linhas de receita — permite
  // que fórmulas de CUSTO/DESPESA referenciem a receita do modelo (ex.: comissão
  // = % × Receita total) sem acoplamento a uma linha específica.
  if (!nos.has("receita_total")) {
    const raizes: string[] = [];
    for (const b of blocks) {
      if (!b.ativo || b.tipo !== "receitas") continue;
      for (const l of b.config.linhasReceita ?? []) if (nos.has(l.nodeRaiz)) raizes.push(l.nodeRaiz);
    }
    const expr = raizes.length ? raizes.join(" + ") : "0";
    const node: DriverNode = { id: "receita_total", tipo: "formula", nome: "Receita total", unidade: "R$", params: { expr } };
    nos.set("receita_total", { node, params: { ...node.params }, ast: parseExpr(expr), deps: [...raizes], refsAbertura: new Set(), refsLag: new Set(), refsLead: new Set() });
  }

  // Corkscrew: para cada estoque E, os nós na CADEIA DOS FEEDERS (o que E precisa
  // para calcular entradas/saídas) que referenciam E leem o saldo de ABERTURA —
  // a referência sai da ordenação (não é dependência dentro do mês).
  for (const [idEstoque, noEstoque] of nos) {
    if (noEstoque.node.tipo !== "estoque") continue;
    const fecho = new Set<string>();
    const fila = [...noEstoque.deps];
    while (fila.length) {
      const atual = fila.pop()!;
      if (fecho.has(atual) || atual === idEstoque) continue;
      fecho.add(atual);
      const no = nos.get(atual);
      if (no) fila.push(...no.deps);
    }
    for (const idFeeder of fecho) {
      const feeder = nos.get(idFeeder);
      if (!feeder) continue;
      const k = feeder.deps.indexOf(idEstoque);
      if (k >= 0) {
        feeder.deps.splice(k, 1);
        feeder.refsAbertura.add(idEstoque);
      }
    }
  }

  return nos;
}

/** Ordenação topológica; devolve o caminho do ciclo quando houver. */
function ordenarNos(nos: Map<string, NoResolvido>, erros: string[]): string[] {
  const ordem: string[] = [];
  const estado = new Map<string, 0 | 1 | 2>(); // 0=não visto, 1=na pilha, 2=pronto
  const pilha: string[] = [];

  function visitar(id: string): boolean {
    const st = estado.get(id) ?? 0;
    if (st === 2) return true;
    if (st === 1) {
      const ini = pilha.indexOf(id);
      erros.push(`Ciclo no grafo de drivers: ${[...pilha.slice(ini), id].join(" → ")}`);
      return false;
    }
    estado.set(id, 1);
    pilha.push(id);
    const no = nos.get(id);
    if (no) {
      for (const dep of no.deps) {
        // Dependência de estoque para si mesmo (saldo M-1) é permitida: corkscrew
        // usa o MÊS ANTERIOR, não cria ciclo dentro do mês.
        if (dep === id) continue;
        if (!nos.has(dep)) continue; // nó órfão vira check, não trava a ordenação
        if (!visitar(dep)) return false;
      }
    }
    pilha.pop();
    estado.set(id, 2);
    ordem.push(id);
    return true;
  }

  for (const id of nos.keys()) {
    if (!visitar(id)) return [];
  }
  return ordem;
}

// ── Motor ──────────────────────────────────────────────────────────────────

export function calcularModelo(input: ModeloInput): ResultadoModelo {
  const erros: string[] = [];
  const checks: CheckModelo[] = [];
  const meses = listaMeses(input.mesInicial, input.horizonteMeses);
  const mesesSet = new Set(meses);
  const overrides = input.overrides ?? {};

  const statusMes: Record<string, "real" | "proj"> = {};
  const mesesReais = new Set((input.realizado?.meses ?? []).filter((m) => mesesSet.has(m)));
  for (const m of meses) statusMes[m] = "proj"; // valores exibidos são sempre premissa

  // Premissas cobrem TODOS os meses do horizonte (decisão do produto): o ano
  // corrente segue a mesma regra dos demais — total anual ÷ meses do ano no
  // horizonte — e o analista ajusta os meses reais à mão quando tiver o dado.
  const mesesProjetados = meses;
  const contagemAno: Record<string, number> = {};
  for (const m of mesesProjetados) contagemAno[m.slice(0, 4)] = (contagemAno[m.slice(0, 4)] ?? 0) + 1;
  const anosInfo = [...new Set(meses.map((m) => m.slice(0, 4)))].map((ano) => ({ ano, meses: contagemAno[ano] ?? 0 }));
  // TODAS as posições da folha entram no grafo como VARIÁVEL DO NEGÓCIO
  // (nó "#": custo = pessoas × R$/pessoa): premissa vira série pronta;
  // "por variável" vira nó com avaliação própria (deps = a variável que puxa).
  // O total soma todas — ciclo de verdade (posição puxada pelo total) o motor acusa.
  const fixasFolha: SerieFixa[] = [];
  const blocoFolhaPre = input.blocks.find((b) => b.ativo && b.tipo === "folha");
  for (const pos of (blocoFolhaPre?.config.posicoes ?? []).filter((p) => p.salarioMensal > 0 || p.modoQtd)) {
    const id = `folha_${pos.id}_qtd`;
    const nome = `Pessoas — ${pos.nome}`;
    if (pos.modoQtd === "variavel") {
      fixasFolha.push({ id, nome, unidade: "#", tipo: "capacidade", qtdPosicao: pos });
    } else {
      const valores = qtdPremissaDaPosicao(pos, meses, anosInfo.map((a) => a.ano));
      if (valores) fixasFolha.push({ id, nome, unidade: "#", tipo: "capacidade", valores });
    }
  }
  if (fixasFolha.length) {
    fixasFolha.push({ id: "headcount_total", nome: "Pessoas — total", unidade: "#", tipo: "capacidade", somaIds: fixasFolha.map((f) => f.id) });
  }
  const nos = resolverNos(input.blocks, overrides, anosInfo, erros, [...seriesMacroDe(input.indicesMacro, meses), ...fixasFolha]);

  // Nós órfãos: fórmula referencia id que não existe (inclui refs de anterior()).
  const orfaos: string[] = [];
  for (const [, no] of nos) {
    const refs = new Set(no.deps);
    if (no.ast) refsDo(no.ast, refs);
    for (const dep of refs) {
      if (dep !== no.node.id && !nos.has(dep)) orfaos.push(`"${dep}" (usado em ${no.node.nome})`);
    }
  }
  checks.push({
    id: "grafo-orfaos",
    nome: "Todas as referências existem",
    ok: orfaos.length === 0,
    prova: orfaos.length === 0 ? `${nos.size} nós, todas as referências resolvidas` : `Referências sem nó: ${orfaos.join(", ")}`,
  });

  const ordem = ordenarNos(nos, erros);
  const semCiclo = ordem.length === nos.size || nos.size === 0;
  checks.push({
    id: "grafo-ciclos",
    nome: "Grafo de drivers sem ciclos",
    ok: semCiclo && erros.every((e) => !e.startsWith("Ciclo")),
    prova: semCiclo ? "Ordenação topológica completa" : erros.find((e) => e.startsWith("Ciclo")) ?? "Ciclo detectado",
  });

  // ── Dimensões ──
  const dimProblemas: string[] = [];
  const dimDeclarada = (id: string): Dim => {
    const no = nos.get(id);
    return no ? DIM_POR_UNIDADE[no.node.unidade] : { rs: 0, un: 0 };
  };
  for (const [, no] of nos) {
    if (!no.ast) continue;
    try {
      const d = dimAst(no.ast, dimDeclarada, no.node.nome);
      const decl = DIM_POR_UNIDADE[no.node.unidade];
      if (!dimIgual(d, decl)) {
        dimProblemas.push(`"${no.node.nome}" declara [${no.node.unidade}] mas a fórmula resulta em ${dimNome(d)}`);
      }
    } catch (e) {
      dimProblemas.push(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Ondas de cálculo ──
  // Quem usa futuro(x) só calcula depois que x fechou o HORIZONTE INTEIRO:
  // onda(n) = max(onda(deps do mês), onda(refs de anterior()), 1 + onda(refs
  // de futuro())). Sem futuro() há uma onda só (comportamento idêntico).
  const onda = new Map<string, number>();
  const calculandoOnda = new Set<string>();
  let cicloNoTempo = false;
  const ondaDe = (id: string): number => {
    if (onda.has(id)) return onda.get(id)!;
    if (calculandoOnda.has(id)) { cicloNoTempo = true; return 0; }
    calculandoOnda.add(id);
    const no = nos.get(id);
    let w = 0;
    if (no) {
      for (const d of no.deps) if (d !== id && nos.has(d)) w = Math.max(w, ondaDe(d));
      for (const d of no.refsLag) if (d !== id && nos.has(d)) w = Math.max(w, ondaDe(d));
      for (const d of no.refsLead) if (nos.has(d)) w = Math.max(w, 1 + ondaDe(d));
    }
    calculandoOnda.delete(id);
    onda.set(id, w);
    return w;
  };
  for (const id of nos.keys()) ondaDe(id);
  if (cicloNoTempo) {
    erros.push("Referência circular no tempo: uma fórmula usa futuro() de algo que depende dela mesma — ajuste as fórmulas.");
  }
  const ondas = [...new Set([...onda.values()])].sort((a, b) => a - b);

  // ── Avaliação mês a mês, onda por onda ──
  const series: Record<string, Serie> = {};
  for (const id of nos.keys()) series[id] = {};

  // Meses PROJETADOS (números 1-12) de cada ano — divisor/normalização das
  // premissas anuais (exclui meses realizados: ver comentário do anosInfo).
  const mesesIdxPorAno: Record<string, number[]> = {};
  for (const m of mesesProjetados) {
    const a = m.slice(0, 4);
    (mesesIdxPorAno[a] ??= []).push(Number(m.split("-")[1]));
  }

  for (const w of ondas) {
    const idsDaOnda = ordem.filter((id) => (onda.get(id) ?? 0) === w);
    for (let i = 0; i < meses.length; i++) {
      const mes = meses[i];
      const anterior = i > 0 ? meses[i - 1] : null;
      const valorNoMes = (id: string): number => series[id]?.[mes] ?? 0;
      const mesesNoAno = mesesIdxPorAno[mes.slice(0, 4)] ?? [];

      for (const id of idsDaOnda) {
        const no = nos.get(id)!;
        const manual = no.node.serieManual?.[mes];
        if (typeof manual === "number") {
          series[id][mes] = manual;
          continue;
        }
        // Nós injetados com avaliação própria (ver SerieFixa):
        const qtdPos = no.params.__qtdPosicao as Posicao | undefined;
        if (qtdPos) {
          // Posição POR VARIÁVEL: pessoas do mês = variável ÷ cobertura (ceil, piso).
          const ano = mes.slice(0, 4);
          const porPessoa = Math.max(1e-9, num(qtdPos.unidadesPorPessoaPorAno?.[ano], num(qtdPos.unidadesPorPessoa, 1)));
          const minimo = Math.max(0, Math.round(num(qtdPos.qtdMinima)));
          series[id][mes] = Math.max(minimo, Math.ceil(Math.max(0, qtdPos.variavelRef ? valorNoMes(qtdPos.variavelRef) : 0) / porPessoa));
          continue;
        }
        const somaIds = no.params.__somaIds as string[] | undefined;
        if (somaIds) {
          series[id][mes] = somaIds.reduce((s, r) => s + valorNoMes(r), 0);
          continue;
        }
        let v = 0;
        switch (no.node.tipo) {
          case "estoque": {
            const saldoAnt = anterior ? series[id][anterior] : num(no.params.saldoInicial);
            const base = anterior !== null ? saldoAnt : num(no.params.saldoInicial);
            const ent = no.params.entradasRef ? valorNoMes(no.params.entradasRef as string) : 0;
            const sai = no.params.saidasRef ? valorNoMes(no.params.saidasRef as string) : 0;
            v = base + ent - sai;
            // Estoque de GENTE/COISAS ([#]: clientes, pacientes, alunos) é inteiro —
            // o saldo arredonda a cada mês (fluxos fracionários se acumulam no saldo).
            if (no.node.unidade === "#") v = Math.round(v);
            break;
          }
          case "formula":
          case "fluxo": {
            if (no.ast) {
              const abertura = (refId: string): number => {
                if (anterior) return series[refId]?.[anterior] ?? 0;
                return num(nos.get(refId)?.params.saldoInicial);
              };
              v = avaliarAst(no.ast, (ref, delta) => {
                if (delta === 0) {
                  if (no.refsAbertura.has(ref)) return abertura(ref);
                  if (ref === id && anterior) return series[id][anterior];
                  return valorNoMes(ref);
                }
                const j = i + delta;
                if (j >= 0 && j < meses.length) return series[ref]?.[meses[j]] ?? 0;
                // Fora do horizonte: passado → o próprio mês (variação zero na
                // partida); futuro → ZERO (não existe projeção além do horizonte).
                return delta < 0 ? valorNoMes(ref) : 0;
              });
            } else {
              v = valorSerie(no.params, no.node.unidade, no.node.tipo, mes, i, mesesNoAno);
            }
            break;
          }
          default:
            v = valorSerie(no.params, no.node.unidade, no.node.tipo, mes, i, mesesNoAno);
        }
        series[id][mes] = Number.isFinite(v) ? v : 0;
      }
    }
  }

  // ── Linhas de receita ──
  const linhasReceita: Array<{ id: string; nome: string; valores: Serie }> = [];
  for (const b of input.blocks) {
    if (!b.ativo || b.tipo !== "receitas") continue;
    for (const linha of b.config.linhasReceita ?? []) {
      const raiz = nos.get(linha.nodeRaiz);
      if (!raiz) {
        erros.push(`Linha "${linha.nome}": nó raiz "${linha.nodeRaiz}" não existe`);
        continue;
      }
      if (raiz.node.unidade !== "R$") {
        dimProblemas.push(`Linha de receita "${linha.nome}" fecha em [${raiz.node.unidade}], deveria fechar em [R$]`);
      }
      linhasReceita.push({ id: linha.id, nome: linha.nome, valores: series[linha.nodeRaiz] ?? {} });
    }
  }

  // Linhas de CUSTOS/DESPESAS (operacionais e não operacionais) com drivers:
  // a raiz também deve fechar em R$.
  for (const b of input.blocks) {
    if (!b.ativo || !["custos", "despesas", "receitasNaoOp", "despesasNaoOp", "capex"].includes(b.tipo)) continue;
    for (const linha of b.config.linhasReceita ?? []) {
      const raiz = nos.get(linha.nodeRaiz);
      if (!raiz) {
        erros.push(`Linha "${linha.nome}": nó raiz "${linha.nodeRaiz}" não existe`);
        continue;
      }
      if (raiz.node.unidade !== "R$") {
        dimProblemas.push(`Linha de ${b.tipo} "${linha.nome}" fecha em [${raiz.node.unidade}], deveria fechar em [R$]`);
      }
    }
  }

  checks.push({
    id: "dimensional",
    nome: "Unidades fecham (análise dimensional)",
    ok: dimProblemas.length === 0,
    prova: dimProblemas.length === 0
      ? `${nos.size} nós e ${linhasReceita.length} linhas de receita com unidades consistentes`
      : dimProblemas.join("; "),
  });

  // ── Receita total (realizado sobrepõe nos meses fechados) ──
  const receitaTotal: Serie = {};
  for (const mes of meses) {
    receitaTotal[mes] = linhasReceita.reduce((s, l) => s + (l.valores[mes] ?? 0), 0);
  }

  // ── Custos e despesas (modo simples) ──
  function calcularGrupo(tipo: string): Array<{ id: string; nome: string; valores: Serie }> {
    const out: Array<{ id: string; nome: string; valores: Serie }> = [];
    const anosHorizonte = [...new Set(meses.map((m) => m.slice(0, 4)))];
    for (const b of input.blocks) {
      if (!b.ativo || b.tipo !== tipo) continue;
      for (const linha of b.config.linhasCusto ?? []) {
        const ov = overrides[linha.id] ?? {};
        // Multiplicador de CENÁRIO: escala a linha inteira (mesma alavanca dos
        // sliders que os nós de driver já têm) — vale p/ % da receita e fixo.
        const multiLinha = num(ov.multiplicador, 1);
        const pctFlat = num(ov.pct ?? linha.pct);
        const pctPorAno = (ov.pctPorAno ?? linha.pctPorAno) as Record<string, number> | undefined;
        const valorMensal = num(ov.valorMensal ?? linha.valorMensal);
        const reajusteFlat = num(ov.reajusteAnual ?? linha.reajusteAnual);
        const reajustePorAno = (ov.reajustePorAno ?? linha.reajustePorAno) as Record<string, number> | undefined;

        // Base do %: linha de receita específica (produto) ou a receita total.
        const baseLinha = linha.baseRef ? linhasReceita.find((l) => l.id === linha.baseRef) : undefined;
        const baseEm = (mes: string): number => (baseLinha ? baseLinha.valores[mes] ?? 0 : receitaTotal[mes]);

        // Reajuste composto por ANO CALENDÁRIO: 1º ano do horizonte = valor base;
        // cada virada de ano multiplica por (1 + índice daquele ano). Com
        // reajusteIndice, o % vem do ÍNDICE OFICIAL do snapshot BCB (IPCA/IGP-M,
        // em números-porcentagem) — "Atualizar índices" corrige a linha junto.
        const idxOficial = linha.reajusteIndice === "ipca" || linha.reajusteIndice === "igpm"
          ? resolverPorAno(input.indicesMacro?.indices?.[linha.reajusteIndice], anosHorizonte)
          : null;
        // Com índice OFICIAL, a virada usa a inflação do ANO ANTERIOR (regra de
        // contrato: o aniversário corrige pelos 12 meses passados).
        const fatorAno: Record<string, number> = {};
        let fator = 1;
        anosHorizonte.forEach((ano, k) => {
          if (k > 0) fator *= 1 + (idxOficial ? (idxOficial[anosHorizonte[k - 1]] ?? 0) / 100 : num(reajustePorAno?.[ano], reajusteFlat));
          fatorAno[ano] = fator;
        });

        const valores: Serie = {};
        for (const mes of meses) {
          const ano = mes.slice(0, 4);
          if (linha.modo === "pctReceita") {
            const pct = typeof pctPorAno?.[ano] === "number" ? pctPorAno[ano] : pctFlat;
            valores[mes] = baseEm(mes) * pct * multiLinha;
          } else if (linha.modo === "fixoReajuste") {
            valores[mes] = valorMensal * (fatorAno[ano] ?? 1) * multiLinha;
          } else {
            valores[mes] = num(linha.valores?.[mes]) * multiLinha;
          }
        }
        out.push({ id: linha.id, nome: linha.nome, valores });
      }
      // Linhas com ÁRVORE DE DRIVERS (mesma estrutura das receitas): o valor da
      // linha é a série do nó raiz — % via fórmula (pode referenciar receita_total
      // e raízes de receita), variável do negócio × custo unitário, crescimento…
      for (const linha of b.config.linhasReceita ?? []) {
        if (!nos.has(linha.nodeRaiz)) continue; // erro já registrado acima
        out.push({ id: linha.id, nome: linha.nome, valores: series[linha.nodeRaiz] ?? {} });
      }
    }
    return out;
  }

  const linhasCustos = calcularGrupo("custos");
  const linhasDespesas = calcularGrupo("despesas");

  // ── B4: PESSOAS (folha por posição) ──
  const blocoFolha = input.blocks.find((b) => b.ativo && b.tipo === "folha");
  const posicoes = (blocoFolha?.config.posicoes ?? []).filter((pos) => pos.salarioMensal > 0 || pos.modoQtd);
  if (posicoes.length) {
    const anosLista = anosInfo.map((a) => a.ano);
    const headcountTotal: Serie = {};
    const folhaTotal: Serie = {};
    const folhaCusto: Serie = {};
    const folhaDespesa: Serie = {};
    for (const mes of meses) { headcountTotal[mes] = 0; folhaTotal[mes] = 0; folhaCusto[mes] = 0; folhaDespesa[mes] = 0; }

    for (const pos of posicoes) {
      // 1) QUANTIDADE mês a mês (inteira): vem do GRAFO — toda posição é um nó
      // "folha_{id}_qtd" (premissa = série pronta; por variável = avaliação
      // própria com deps). Fonte ÚNICA: a folha e as fórmulas usam o mesmo número.
      const qtd: Serie = series[`folha_${pos.id}_qtd`] ?? qtdPremissaDaPosicao(pos, meses, anosLista) ?? {};

      // 2) CUSTO: salário × fator dissídio × (1+encargos) + benefícios (sem dissídio)
      // Encargos: TABELA do bloco (vale p/ toda a estrutura) → default do contrato.
      const encargos = Math.max(0, num(blocoFolha!.config.encargosPorContrato?.[pos.tipoContrato], ENCARGOS_PADRAO[pos.tipoContrato] ?? 0));
      const dissidio = num(pos.dissidioAnual);
      const dataBase = Math.min(12, Math.max(1, Math.round(num(pos.mesDissidio, 1))));
      const custoPos: Serie = {};
      let salario = Math.max(0, num(pos.salarioMensal));
      for (let i = 0; i < meses.length; i++) {
        const mes = meses[i];
        const anoMes = mes.slice(0, 4);
        const mesNum = Number(mes.split("-")[1]);
        const salExplicito = pos.salarioPorAno?.[anoMes];
        // Salário POR ANO: ano digitado MANDA (desde janeiro daquele ano);
        // ano vazio herda o vigente e o dissídio corrige na data-base — nunca
        // os dois no mesmo ano (sem dupla contagem).
        if ((i === 0 || mesNum === 1) && typeof salExplicito === "number") salario = Math.max(0, salExplicito);
        if (i > 0 && mesNum === dataBase && dissidio > 0 && typeof salExplicito !== "number") salario *= 1 + dissidio;
        const porPessoa = salario * (1 + encargos) + num(pos.beneficiosMensal);
        custoPos[mes] = (qtd[mes] ?? 0) * porPessoa;
        headcountTotal[mes] += qtd[mes] ?? 0;
        folhaTotal[mes] += custoPos[mes];
        if (pos.classificacao === "custo") folhaCusto[mes] += custoPos[mes];
        else folhaDespesa[mes] += custoPos[mes];
      }
      series[`folha_${pos.id}_qtd`] = qtd;
      series[`folha_${pos.id}_custo`] = custoPos;
    }

    series["headcount_total"] = headcountTotal;
    series["folha_total"] = folhaTotal;
    // A folha entra na DRE como PRIMEIRA linha aberta de cada grupo — logo
    // abaixo de "(−) Custos" / "(−) Despesas" (pedido do produto).
    if (Object.values(folhaCusto).some((v) => v !== 0)) {
      linhasCustos.unshift({ id: "folha-custos", nome: "Folha e encargos (produção)", valores: folhaCusto });
    }
    if (Object.values(folhaDespesa).some((v) => v !== 0)) {
      linhasDespesas.unshift({ id: "folha-despesas", nome: "Folha e encargos (adm/comercial)", valores: folhaDespesa });
    }
  }
  // NÃO OPERACIONAIS (abaixo do EBITDA): o valuation separa o operacional do
  // resto — aluguéis recebidos, venda de ativo, multas etc. entram aqui.
  const linhasRecNaoOp = calcularGrupo("receitasNaoOp");
  const linhasDespNaoOp = calcularGrupo("despesasNaoOp");

  // ── B6: CAPEX e DEPRECIAÇÃO (waterfall por safra) ──
  // Cada mês de investimento é uma SAFRA que deprecia LINEAR pela taxa da linha,
  // começando no MÊS SEGUINTE (o ativo entra em operação), até esgotar o valor.
  // O imobilizado é corkscrew: saldo + capex − depreciação, nunca negativo.
  const linhasCapex = calcularGrupo("capex");
  const blocoCapex = input.blocks.find((b) => b.ativo && b.tipo === "capex");
  // Ativos que JÁ EXISTEM (das DFs): lista por classe; os 2 campos antigos viram
  // um item único (retrocompatibilidade). Taxa 0 = não deprecia (terrenos).
  const ativosExistentes: AtivoExistente[] = blocoCapex?.config.ativosExistentes
    ?? (num(blocoCapex?.config.saldoInicialImobilizado) > 0
      ? [{ id: "legado", nome: "Imobilizado existente", valor: num(blocoCapex?.config.saldoInicialImobilizado), taxaAnual: num(blocoCapex?.config.depreciacaoLegadoAnual, 0.1) }]
      : []);
  const saldoIniImob = ativosExistentes.reduce((sm, a) => sm + Math.max(0, a.valor), 0);
  const temCapex = !!blocoCapex && (linhasCapex.length > 0 || saldoIniImob > 0);
  const capexTotal: Serie = {};
  const depreciacaoTotal: Serie = {};
  const imobilizadoLiquido: Serie = {};
  if (temCapex) {
    const taxaPorLinha = new Map<string, number>();
    const carenciaPorLinha = new Map<string, number>();
    for (const l of [...(blocoCapex!.config.linhasCusto ?? []), ...(blocoCapex!.config.linhasReceita ?? [])]) {
      taxaPorLinha.set(l.id, num(l.depreciacaoAnual, 0.1));
      carenciaPorLinha.set(l.id, Math.max(0, Math.round(num(l.carenciaMeses))));
    }
    const legados = ativosExistentes
      .filter((a) => a.valor > 0)
      .map((a) => ({ residuo: a.valor, deprMensal: a.valor * (Math.max(0, a.taxaAnual) / 12) }));
    // Safra com CARÊNCIA: deprecia a partir de inicioEm (mês seguinte + carência).
    const safras: Array<{ valor: number; residuo: number; taxaMensal: number; inicioEm: number }> = [];
    let saldo = saldoIniImob;
    for (let i = 0; i < meses.length; i++) {
      const mes = meses[i];
      // Deprecia o que já existe (legados por classe + safras liberadas)…
      let depr = 0;
      for (const lg of legados) {
        if (lg.residuo <= 0 || lg.deprMensal <= 0) continue;
        const d = Math.min(lg.deprMensal, lg.residuo);
        depr += d;
        lg.residuo -= d;
      }
      for (const sf of safras) {
        if (sf.residuo <= 0 || i < sf.inicioEm) continue;
        const d = Math.min(sf.valor * sf.taxaMensal, sf.residuo);
        depr += d;
        sf.residuo -= d;
      }
      // …e só DEPOIS o capex do mês vira safra (mês seguinte + carência da linha).
      let capexMes = 0;
      for (const l of linhasCapex) {
        const v = l.valores[mes] ?? 0;
        if (v > 0) {
          safras.push({ valor: v, residuo: v, taxaMensal: (taxaPorLinha.get(l.id) ?? 0.1) / 12, inicioEm: i + 1 + (carenciaPorLinha.get(l.id) ?? 0) });
        }
        capexMes += Math.max(0, v);
      }
      saldo = saldo + capexMes - depr;
      capexTotal[mes] = capexMes;
      depreciacaoTotal[mes] = depr;
      imobilizadoLiquido[mes] = saldo;
    }
    // Séries sintéticas para a tela/export (memória do imobilizado).
    series["capex_total"] = capexTotal;
    series["depreciacao_total"] = depreciacaoTotal;
    series["imobilizado_liquido"] = imobilizadoLiquido;
  }

  // ── B8: DÍVIDA POR CONTRATO (corkscrew) ──
  const blocoDivida = input.blocks.find((b) => b.ativo && b.tipo === "divida");
  const contratos = (blocoDivida?.config.contratos ?? []).filter(
    (c) => num(c.saldoInicial) > 0 || num(c.principal) > 0
  );
  const temDivida = contratos.length > 0;
  const dividaSaldoTotal: Serie = {};
  const jurosDividaTotal: Serie = {};
  const amortizacaoDividaTotal: Serie = {};
  const captacaoDividaTotal: Serie = {};
  const dividaCpTotal: Serie = {};
  const dividaLpTotal: Serie = {};
  let saldoIniDividaTotal = 0;
  if (temDivida) {
    for (const mes of meses) {
      dividaSaldoTotal[mes] = 0; jurosDividaTotal[mes] = 0; amortizacaoDividaTotal[mes] = 0; captacaoDividaTotal[mes] = 0;
      dividaCpTotal[mes] = 0; dividaLpTotal[mes] = 0;
    }
    for (const c of contratos) {
      const prazo = Math.max(1, Math.round(num(c.prazoMeses, 1)));
      const carencia = Math.max(0, Math.round(num(c.carenciaMeses)));
      const taxaDoAno = (ano: string): number =>
        Math.max(0, typeof c.taxaPorAno?.[ano] === "number" ? c.taxaPorAno[ano] : num(c.taxaAnual));
      const mensalDe = (ano: string): number => Math.pow(1 + taxaDoAno(ano), 1 / 12) - 1;

      // Captação dentro do horizonte → evento no mês; antes do horizonte (ou
      // ausente) → dívida existente na largada; depois do fim → contrato inerte.
      let idxCaptacao = -1;
      let saldo = Math.max(0, num(c.saldoInicial));
      const principal = Math.max(0, num(c.principal));
      if (c.mesCaptacao && principal > 0) {
        if (c.mesCaptacao > meses[meses.length - 1]) continue;
        idxCaptacao = meses.indexOf(c.mesCaptacao);
        if (idxCaptacao < 0) saldo += principal; // liberado antes do horizonte: já está no saldo
      } else if (principal > 0) {
        saldo += principal; // sem mês de captação = existente
      }
      saldoIniDividaTotal += saldo;

      const inicioAmort = idxCaptacao + 1 + carencia; // existente (idx −1): mês 0 + carência
      const fimJanela = inicioAmort + prazo - 1;
      let quotaSac = 0;      // fixada na 1ª parcela
      let pmt = 0;           // reprecificado quando a taxa do ano muda
      let taxaPmt = -1;
      const saldoC: Serie = {};
      const jurosC: Serie = {};
      // Simula 12 meses ALÉM do horizonte só para a régua contábil CP × LP:
      // curto prazo = amortizações programadas nos próximos 12 meses.
      const amortFutura: number[] = [];
      const totalIter = meses.length + 12;
      for (let i = 0; i < totalIter; i++) {
        const mes = i < meses.length ? meses[i] : mesAdd(input.mesInicial, i);
        const m = mensalDe(mes.slice(0, 4));
        const captacao = i === idxCaptacao ? principal : 0;
        // Juros sobre o saldo do início do mês (captação do mês ainda não rende).
        const juros = saldo * m;
        let amortizacao = 0;
        if (saldo > 0 && i >= inicioAmort && i <= fimJanela) {
          const parcelasRestantes = fimJanela - i + 1;
          if (i === fimJanela) {
            amortizacao = saldo; // última parcela SEMPRE liquida (sem resíduo de arredondamento)
          } else if (c.sistema === "sac") {
            if (quotaSac === 0) quotaSac = saldo / prazo;
            amortizacao = Math.min(quotaSac, saldo);
          } else if (c.sistema === "price") {
            if (taxaPmt !== m) {
              taxaPmt = m;
              pmt = m > 0 ? (saldo * m) / (1 - Math.pow(1 + m, -parcelasRestantes)) : saldo / parcelasRestantes;
            }
            amortizacao = Math.min(Math.max(0, pmt - juros), saldo);
          }
          // bullet: amortização 0 até a última parcela (tratada acima)
        }
        saldo = saldo + captacao - amortizacao;
        amortFutura[i] = amortizacao;
        if (i >= meses.length) continue; // além do horizonte: só o cronograma p/ CP/LP
        saldoC[mes] = saldo;
        jurosC[mes] = juros;
        dividaSaldoTotal[mes] += saldo;
        jurosDividaTotal[mes] += juros;
        amortizacaoDividaTotal[mes] += amortizacao;
        captacaoDividaTotal[mes] += captacao;
      }
      // CP = min(saldo, amortizações dos 12 meses seguintes); LP = o resto.
      for (let i = 0; i < meses.length; i++) {
        const mes = meses[i];
        let cp = 0;
        for (let k = i + 1; k <= i + 12; k++) cp += amortFutura[k] ?? 0;
        cp = Math.min(cp, saldoC[mes] ?? 0);
        dividaCpTotal[mes] += cp;
        dividaLpTotal[mes] += (saldoC[mes] ?? 0) - cp;
      }
      series[`divida_${c.id}_saldo`] = saldoC;
      series[`divida_${c.id}_juros`] = jurosC;
    }
    const servico: Serie = {};
    for (const mes of meses) servico[mes] = jurosDividaTotal[mes] + amortizacaoDividaTotal[mes];
    series["divida_total"] = dividaSaldoTotal;
    series["divida_cp_total"] = dividaCpTotal;
    series["divida_lp_total"] = dividaLpTotal;
    series["juros_divida_total"] = jurosDividaTotal;
    series["amortizacao_divida_total"] = amortizacaoDividaTotal;
    series["captacao_divida_total"] = captacaoDividaTotal;
    series["servico_divida_total"] = servico;
  }

  const totalGrupoMes = (linhas: Array<{ valores: Serie }>, _grupo: "custos" | "despesas", mes: string): number =>
    linhas.reduce((s, l) => s + (l.valores[mes] ?? 0), 0);

  // ── DRE ──
  const pctDe = (valores: Serie): Serie => {
    const out: Serie = {};
    for (const mes of meses) out[mes] = receitaTotal[mes] ? (valores[mes] ?? 0) / receitaTotal[mes] : 0;
    return out;
  };

  // ── B7: CAPITAL DE GIRO por dias (PMR/PME/PMP) ──
  // Versão mensal da régua dos indicadores do IBR: conta = base do mês × dias/30.
  // NCG = CR + Estoques − Fornecedores; ΔNCG (mês a mês) alimenta o Fluxo de
  // Caixa (F2); no 1º mês do horizonte a variação conta como zero (a abertura
  // real entra quando o BP integrar).
  const blocoGiro = input.blocks.find((b) => b.ativo && b.tipo === "giro");
  const cfgGiro = blocoGiro?.config;
  const temGiro = !!cfgGiro && (num(cfgGiro.pmr) > 0 || num(cfgGiro.pme) > 0 || num(cfgGiro.pmp) > 0
    || Object.keys(cfgGiro.pmrPorAno ?? {}).length > 0 || Object.keys(cfgGiro.pmePorAno ?? {}).length > 0 || Object.keys(cfgGiro.pmpPorAno ?? {}).length > 0);

  // ── DEDUÇÕES DA RECEITA (vendas canceladas, devoluções e abatimentos) ──
  // Linha própria entre a receita BRUTA e os impostos: % sobre a bruta (flat
  // ou por ano). Também REDUZ a base fiscal — a lei exclui vendas canceladas e
  // descontos incondicionais da base de PIS/COFINS/ICMS/Simples/presunção
  // (DL 1.598 art. 12; LC 123 art. 3º §1º).
  const cfgReceitasBloco = input.blocks.find((b) => b.ativo && b.tipo === "receitas")?.config;
  const deducoesFlat = Math.max(0, Math.min(0.9, num(cfgReceitasBloco?.deducoesPct)));
  const deducoesPorAnoCfg = cfgReceitasBloco?.deducoesPorAno;
  const deducoes: Serie = {};
  let temDeducoes = false;
  for (const mes of meses) {
    const ano = mes.slice(0, 4);
    const pct = typeof deducoesPorAnoCfg?.[ano] === "number"
      ? Math.max(0, Math.min(0.9, deducoesPorAnoCfg[ano]))
      : deducoesFlat;
    deducoes[mes] = Math.max(0, receitaTotal[mes] ?? 0) * pct;
    if (deducoes[mes] !== 0) temDeducoes = true;
  }
  // Base fiscal = bruta − deduções (usada por TODOS os regimes e pela reforma).
  const receitaBase: Serie = {};
  for (const mes of meses) receitaBase[mes] = (receitaTotal[mes] ?? 0) - (deducoes[mes] ?? 0);
  if (temDeducoes) series["deducoes_receita_total"] = deducoes;

  // ── F3: IMPOSTOS SOBRE A RECEITA (Simples/PIS-COFINS/ISS/ICMS) ──
  // Simples: RBT12 em JANELA MÓVEL de 12 meses (antes do horizonte, cada mês
  // vale rbt12Inicial ÷ 12); alíquota efetiva da LC 123 por anexo; Fator R
  // (folha 12m ÷ receita 12m ≥ 28% → Anexo III, senão V) quando ligado — a
  // folha pré-horizonte é aproximada pela folha do 1º mês projetado.
  const blocoImpostos = input.blocks.find((b) => b.ativo && b.tipo === "impostos");
  const cfgImp = blocoImpostos?.config.impostos;
  const regime = cfgImp?.regime && cfgImp.regime !== "nenhum" ? cfgImp.regime : null;
  const impostosReceita: Serie = {};
  const estourosSimples: string[] = [];
  let provaImpostos = "";
  if (regime === "simples") {
    const anexoBase = cfgImp!.anexo ?? "III";
    const rbt12Inicial = Math.max(0, num(cfgImp!.rbt12Inicial));
    const rbt12Serie: Serie = {};
    const aliqSerie: Serie = {};
    // RBT12 e a base do DAS excluem as deduções (vendas canceladas — LC 123 art. 3º §1º)
    const receitaEm = (i: number): number => (i >= 0 ? receitaBase[meses[i]] ?? 0 : rbt12Inicial / 12);
    const folhaEm = (i: number): number => (i >= 0 ? series["folha_total"]?.[meses[i]] ?? 0 : series["folha_total"]?.[meses[0]] ?? 0);
    for (let i = 0; i < meses.length; i++) {
      const mes = meses[i];
      let rbt12 = 0;
      let folha12 = 0;
      for (let k = i - 12; k <= i - 1; k++) {
        rbt12 += receitaEm(k);
        folha12 += folhaEm(k);
      }
      const anexoDoMes = cfgImp!.usarFatorR && (anexoBase === "III" || anexoBase === "V")
        ? (rbt12 > 0 && folha12 / rbt12 >= 0.28 ? "III" : "V")
        : anexoBase;
      const aliq = aliquotaEfetivaSimples(rbt12, anexoDoMes);
      impostosReceita[mes] = (receitaBase[mes] ?? 0) * aliq;
      rbt12Serie[mes] = rbt12;
      aliqSerie[mes] = aliq;
      if (rbt12 > 4_800_000 && estourosSimples.length < 3) estourosSimples.push(`${mes} (RBT12 R$ ${(rbt12 / 1e6).toFixed(2)} mi)`);
    }
    series["rbt12"] = rbt12Serie;
    series["aliquota_efetiva_simples"] = aliqSerie;
    provaImpostos = `Simples anexo ${anexoBase}${cfgImp!.usarFatorR ? " (fator R automático)" : ""}: alíquota efetiva de ${(aliqSerie[meses[0]] * 100).toFixed(2)}% (1º mês) a ${(aliqSerie[meses[meses.length - 1]] * 100).toFixed(2)}% (último)`;
  } else if (regime) {
    const pisCofins = Math.max(0, num(cfgImp!.pisCofinsPct, regime === "presumido" ? 0.0365 : 0.0925));
    const iss = Math.max(0, num(cfgImp!.issPct));
    const icms = Math.max(0, num(cfgImp!.icmsPct));
    // Componentes ABERTOS (o resumo da aba e o Excel detalham a composição).
    const sPisCofins: Serie = {};
    const sIss: Serie = {};
    const sIcms: Serie = {};
    for (const mes of meses) {
      const rec = receitaBase[mes] ?? 0; // base já líquida das deduções
      sPisCofins[mes] = rec * pisCofins;
      sIss[mes] = rec * iss;
      sIcms[mes] = rec * icms;
      impostosReceita[mes] = sPisCofins[mes] + sIss[mes] + sIcms[mes];
    }
    if (pisCofins > 0) series["impostos_pis_cofins"] = sPisCofins;
    if (iss > 0) series["impostos_iss"] = sIss;
    if (icms > 0) series["impostos_icms"] = sIcms;
    provaImpostos = `${regime === "presumido" ? "Presumido" : "Real"}: ${((pisCofins + iss + icms) * 100).toFixed(2)}% sobre a receita (PIS/COFINS${iss ? " + ISS" : ""}${icms ? " + ICMS" : ""}) + IRPJ/CSLL abaixo do resultado`;
    // ELEGIBILIDADE do Presumido: receita ANUAL acima de R$ 78 mi obriga o
    // Lucro Real no ano seguinte (art. 13 da Lei 9.718). A presunção NÃO muda
    // com o faturamento — o check aponta a migração, sem alterar a conta.
    // Ano parcial compara pela receita ANUALIZADA (média mensal × 12).
    if (regime === "presumido") {
      const recPorAno: Record<string, number> = {};
      const mesesPorAno: Record<string, number> = {};
      for (const mes of meses) {
        const a = mes.slice(0, 4);
        recPorAno[a] = (recPorAno[a] ?? 0) + (receitaTotal[mes] ?? 0);
        mesesPorAno[a] = (mesesPorAno[a] ?? 0) + 1;
      }
      for (const [ano, rec] of Object.entries(recPorAno)) {
        const anualizada = mesesPorAno[ano] ? (rec / mesesPorAno[ano]) * 12 : rec;
        if (anualizada > 78_000_000 && estourosSimples.length < 3) {
          estourosSimples.push(`${ano} (receita R$ ${(anualizada / 1e6).toFixed(1)} mi > limite de R$ 78 mi do Presumido)`);
        }
      }
    }
  }
  // ── REFORMA TRIBUTÁRIA (mundo novo, só quando a comparação pede) ──
  // Presumido/Real: PIS/COFINS/ISS/ICMS dão lugar a CBS+IBS pelo cronograma
  // legal de transição (débito por categoria − crédito sobre as compras).
  // Simples: permanece no DAS — a carga própria NÃO muda (LC 214, art. 41;
  // Decreto 12.955, art. 582 p.ú. IV); o efeito é competitivo (crédito do
  // comprador limitado — art. 47 §9º).
  if (input.reforma && regime && regime !== "simples") {
    const comprasCreditaveis: Serie = {};
    for (const mes of meses) {
      // Base de compras: custos + despesas SEM a folha (salários não geram
      // crédito de IBS/CBS — não são "aquisição de bens e serviços").
      comprasCreditaveis[mes] =
        [...linhasCustos, ...linhasDespesas]
          .filter((l) => l.id !== "folha-custos" && l.id !== "folha-despesas")
          .reduce((s, l) => s + Math.max(0, l.valores[mes] ?? 0), 0);
    }
    const pisCofinsAtual = Math.max(0, num(cfgImp!.pisCofinsPct, regime === "presumido" ? 0.0365 : 0.0925));
    const r = calcularImpostosReforma({
      meses,
      receita: receitaBase, // vendas canceladas também ficam fora do IBS/CBS
      comprasCreditaveis,
      capex: series["capex_total"] ?? {},
      cfg: input.reforma,
      pisCofinsPct: pisCofinsAtual,
      icmsIssPct: Math.max(0, num(cfgImp!.issPct)) + Math.max(0, num(cfgImp!.icmsPct)),
    });
    for (const mes of meses) impostosReceita[mes] = r.impostosConsumo[mes] ?? 0;
    // No mundo reforma os componentes atuais não somam ao total novo — saem
    // para não induzir leitura errada (o detalhe do mundo novo está abaixo).
    delete series["impostos_pis_cofins"];
    delete series["impostos_iss"];
    delete series["impostos_icms"];
    series["reforma_debito_novo"] = r.debitoNovo;
    series["reforma_credito_novo"] = r.creditoNovo;
    series["reforma_antigo_remanescente"] = r.antigoRemanescente;
    series["reforma_saldo_credor"] = r.saldoCredor;
    provaImpostos = `REFORMA TRIBUTÁRIA (CBS+IBS, LC 214/2025) sobre o ${regime === "presumido" ? "Presumido" : "Real"}: transição 2026-2033, débito por categoria − crédito sobre as compras · IRPJ/CSLL inalterados`;
  } else if (input.reforma && regime === "simples") {
    provaImpostos += " · reforma: permanece no DAS (carga própria inalterada; efeito é no crédito do comprador — LC 214, art. 47 §9º)";
  }
  if (regime) series["impostos_receita_total"] = impostosReceita;

  // A DRE SEMPRE abre por produto/linha (nomes são do analista; esconder a linha
  // única fazia o produto "sumir" da Demonstração).
  const dre: LinhaDre[] = [];
  dre.push({ id: "receita-total", nome: "Receita", grupo: "subtotal", valores: receitaTotal, pctReceita: pctDe(receitaTotal) });
  for (const l of linhasReceita) dre.push({ id: l.id, nome: l.nome, grupo: "receita", valores: l.valores, pctReceita: pctDe(l.valores) });

  // Cascata contábil: BRUTA → (−) deduções (vendas canceladas/abatimentos) →
  // (−) impostos sobre a receita → RECEITA LÍQUIDA; o lucro bruto parte dela.
  const receitaLiquida: Serie = {};
  for (const mes of meses) {
    receitaLiquida[mes] = (receitaTotal[mes] ?? 0) - (deducoes[mes] ?? 0) - (regime ? impostosReceita[mes] ?? 0 : 0);
  }
  if (temDeducoes) {
    dre.push({
      id: "deducoes-receita",
      nome: "(−) Deduções da receita (vendas canceladas e abatimentos)",
      grupo: "despesas", valores: deducoes, pctReceita: pctDe(deducoes),
    });
  }
  if (regime) {
    dre.push({
      id: "impostos-receita",
      nome: regime === "simples" ? "(−) Simples Nacional (DAS)" : "(−) Impostos sobre a receita",
      grupo: "despesas", valores: impostosReceita, pctReceita: pctDe(impostosReceita),
    });
  }
  if (regime || temDeducoes) {
    dre.push({ id: "receita-liquida", nome: "Receita líquida", grupo: "subtotal", valores: receitaLiquida, pctReceita: pctDe(receitaLiquida) });
  }

  const custosTotal: Serie = {};
  const despesasTotal: Serie = {};
  const lucroBruto: Serie = {};
  const ebitda: Serie = {};
  for (const mes of meses) {
    custosTotal[mes] = totalGrupoMes(linhasCustos, "custos", mes);
    despesasTotal[mes] = totalGrupoMes(linhasDespesas, "despesas", mes);
    lucroBruto[mes] = receitaLiquida[mes] - custosTotal[mes];
    ebitda[mes] = lucroBruto[mes] - despesasTotal[mes];
  }
  if (temGiro) {
    const diasDe = (flat: number | undefined, porAno: Record<string, number> | undefined, ano: string): number =>
      Math.max(0, typeof porAno?.[ano] === "number" ? porAno[ano] : num(flat));
    const cr: Serie = {};
    const est: Serie = {};
    const forn: Serie = {};
    const ncg: Serie = {};
    const deltaNcg: Serie = {};
    for (let i = 0; i < meses.length; i++) {
      const mes = meses[i];
      const ano = mes.slice(0, 4);
      cr[mes] = (receitaTotal[mes] ?? 0) * (diasDe(cfgGiro!.pmr, cfgGiro!.pmrPorAno, ano) / 30);
      est[mes] = (custosTotal[mes] ?? 0) * (diasDe(cfgGiro!.pme, cfgGiro!.pmePorAno, ano) / 30);
      forn[mes] = (custosTotal[mes] ?? 0) * (diasDe(cfgGiro!.pmp, cfgGiro!.pmpPorAno, ano) / 30);
      ncg[mes] = cr[mes] + est[mes] - forn[mes];
      deltaNcg[mes] = i === 0 ? 0 : ncg[mes] - ncg[meses[i - 1]];
    }
    series["contas_a_receber"] = cr;
    series["estoques_giro"] = est;
    series["fornecedores_giro"] = forn;
    series["ncg"] = ncg;
    series["delta_ncg"] = deltaNcg;
  }

  // Custos/despesas abrem POR LINHA sempre, como a receita: total primeiro e as
  // linhas ABAIXO dele (mesma ordem da receita — feedback do produto).
  dre.push({ id: "custos-total", nome: "(−) Custos", grupo: "subtotal", valores: custosTotal, pctReceita: pctDe(custosTotal) });
  for (const l of linhasCustos) dre.push({ id: l.id, nome: l.nome, grupo: "custos", valores: l.valores, pctReceita: pctDe(l.valores) });
  dre.push({ id: "lucro-bruto", nome: "Lucro Bruto", grupo: "subtotal", valores: lucroBruto, pctReceita: pctDe(lucroBruto) });
  dre.push({ id: "despesas-total", nome: "(−) Despesas", grupo: "subtotal", valores: despesasTotal, pctReceita: pctDe(despesasTotal) });
  for (const l of linhasDespesas) dre.push({ id: l.id, nome: l.nome, grupo: "despesas", valores: l.valores, pctReceita: pctDe(l.valores) });
  dre.push({ id: "ebitda", nome: "EBITDA", grupo: "subtotal", valores: ebitda, pctReceita: pctDe(ebitda) });
  // D&A e EBIT só aparecem quando há capex/imobilizado no modelo.
  const ebit: Serie = {};
  for (const mes of meses) ebit[mes] = ebitda[mes] - (temCapex ? depreciacaoTotal[mes] ?? 0 : 0);
  // Último subtotal da cascata (EBITDA → EBIT → após não-op) — base dos juros.
  let resultadoCorrente: Serie = ebitda;
  if (temCapex) {
    dre.push({ id: "depreciacao-total", nome: "(−) Depreciação e amortização", grupo: "despesas", valores: depreciacaoTotal, pctReceita: pctDe(depreciacaoTotal) });
    dre.push({ id: "ebit", nome: "EBIT (resultado operacional)", grupo: "subtotal", valores: ebit, pctReceita: pctDe(ebit) });
    resultadoCorrente = ebit;
  }
  if (linhasRecNaoOp.length || linhasDespNaoOp.length) {
    const recNaoOpTotal: Serie = {};
    const despNaoOpTotal: Serie = {};
    const resultadoAposNaoOp: Serie = {};
    const baseNaoOp = temCapex ? ebit : ebitda; // não-op parte do último subtotal operacional
    for (const mes of meses) {
      recNaoOpTotal[mes] = linhasRecNaoOp.reduce((sm, l) => sm + (l.valores[mes] ?? 0), 0);
      despNaoOpTotal[mes] = linhasDespNaoOp.reduce((sm, l) => sm + (l.valores[mes] ?? 0), 0);
      resultadoAposNaoOp[mes] = baseNaoOp[mes] + recNaoOpTotal[mes] - despNaoOpTotal[mes];
    }
    dre.push({ id: "rec-naoop-total", nome: "(+) Receitas não operacionais", grupo: "subtotal", valores: recNaoOpTotal, pctReceita: pctDe(recNaoOpTotal) });
    for (const l of linhasRecNaoOp) dre.push({ id: l.id, nome: l.nome, grupo: "receita", valores: l.valores, pctReceita: pctDe(l.valores) });
    dre.push({ id: "desp-naoop-total", nome: "(−) Despesas não operacionais", grupo: "subtotal", valores: despNaoOpTotal, pctReceita: pctDe(despNaoOpTotal) });
    for (const l of linhasDespNaoOp) dre.push({ id: l.id, nome: l.nome, grupo: "despesas", valores: l.valores, pctReceita: pctDe(l.valores) });
    dre.push({ id: "resultado-apos-naoop", nome: "Resultado após não operacionais", grupo: "subtotal", valores: resultadoAposNaoOp, pctReceita: pctDe(resultadoAposNaoOp) });
    resultadoCorrente = resultadoAposNaoOp;
  }
  // B8: juros da dívida descem para a DRE; LAIR fecha a cascata (IR entra na F3).
  if (temDivida) {
    const lair: Serie = {};
    for (const mes of meses) lair[mes] = resultadoCorrente[mes] - (jurosDividaTotal[mes] ?? 0);
    dre.push({ id: "juros-divida", nome: "(−) Juros de empréstimos e financiamentos", grupo: "despesas", valores: jurosDividaTotal, pctReceita: pctDe(jurosDividaTotal) });
    dre.push({ id: "lair", nome: "Resultado antes dos impostos", grupo: "subtotal", valores: lair, pctReceita: pctDe(lair) });
    resultadoCorrente = lair;
  }

  // ── F3: IRPJ/CSLL e LUCRO LÍQUIDO ──
  // Presumido: base presumida sobre a receita (15% + adicional de 10% acima de
  // R$ 20 mil/mês; CSLL 9%). Real: sobre o resultado do MÊS, com PREJUÍZO
  // FISCAL acumulado (corkscrew) compensável até a TRAVA de 30% da base.
  // Simples: já está no DAS — vai direto ao lucro líquido.
  if (regime) {
    const irpjCsll: Serie = {};
    if (regime === "presumido") {
      const pIr = Math.max(0, num(cfgImp!.presuncaoIRPJ, 0.08));
      const pCs = Math.max(0, num(cfgImp!.presuncaoCSLL, 0.12));
      // LC 224/2025 (26/12/2025, efeitos desde jan/2026): a presunção sobe 10%
      // (32%→35,2%; 8%→8,8%…) na PARCELA da receita bruta ANUAL acima de
      // R$ 5 mi. Motor mensal: excedente acumulado no ano → a fatia nova de
      // cada mês é majorada (o total do ano bate exato com a régua da lei).
      const aplicaLC224 = cfgImp!.aplicarLC224 !== false;
      let anoCorrente = "";
      let recAcum = 0;
      let excedenteAnterior = 0;
      for (const mes of meses) {
        const ano = mes.slice(0, 4);
        if (ano !== anoCorrente) { anoCorrente = ano; recAcum = 0; excedenteAnterior = 0; }
        const rec = receitaBase[mes] ?? 0; // presunção sobre a receita já líquida das deduções
        recAcum += rec;
        const vale224 = aplicaLC224 && Number(ano) >= 2026;
        const excedenteAcum = vale224 ? Math.max(0, recAcum - 5_000_000) : 0;
        const majoradaMes = Math.min(rec, Math.max(0, excedenteAcum - excedenteAnterior));
        excedenteAnterior = excedenteAcum;
        const normalMes = rec - majoradaMes;
        const baseIr = normalMes * pIr + majoradaMes * pIr * 1.10;
        const baseCs = normalMes * pCs + majoradaMes * pCs * 1.10;
        irpjCsll[mes] = baseIr * 0.15 + Math.max(0, baseIr - 20_000) * 0.10 + baseCs * 0.09;
      }
      if (aplicaLC224) provaImpostos += " · majoração LC 224/2025 (+10% na presunção acima de R$ 5 mi/ano) aplicada";
      series["irpj_csll_total"] = irpjCsll;
    } else if (regime === "real") {
      const prejuizoAcum: Serie = {};
      let prejuizo = 0;
      for (const mes of meses) {
        let base = resultadoCorrente[mes] ?? 0;
        if (base > 0 && prejuizo > 0) {
          const compensa = Math.min(prejuizo, base * 0.3); // trava dos 30%
          base -= compensa;
          prejuizo -= compensa;
        } else if (base < 0) {
          prejuizo += -base;
          base = 0;
        }
        irpjCsll[mes] = base * 0.15 + Math.max(0, base - 20_000) * 0.10 + base * 0.09;
        prejuizoAcum[mes] = prejuizo;
      }
      series["irpj_csll_total"] = irpjCsll;
      series["prejuizo_fiscal_acumulado"] = prejuizoAcum;
    } else {
      for (const mes of meses) irpjCsll[mes] = 0;
    }
    const lucroLiquido: Serie = {};
    for (const mes of meses) lucroLiquido[mes] = (resultadoCorrente[mes] ?? 0) - (irpjCsll[mes] ?? 0);
    if (regime !== "simples") {
      dre.push({ id: "irpj-csll", nome: "(−) IRPJ e CSLL", grupo: "despesas", valores: irpjCsll, pctReceita: pctDe(irpjCsll) });
    }
    dre.push({ id: "lucro-liquido", nome: "Lucro líquido", grupo: "subtotal", valores: lucroLiquido, pctReceita: pctDe(lucroLiquido) });
    series["lucro_liquido"] = lucroLiquido;
    resultadoCorrente = lucroLiquido; // o FC indireto parte do último subtotal

    checks.push({
      id: "impostos-regime",
      nome: "Regime tributário aplicado",
      ok: estourosSimples.length === 0,
      prova: estourosSimples.length
        ? (regime === "simples"
          ? `RBT12 ACIMA do teto de R$ 4,8 mi do Simples em: ${estourosSimples.join(", ")} — projete a migração de regime`
          : `Receita ACIMA do limite do Lucro Presumido em: ${estourosSimples.join(", ")} — a partir do ano seguinte o Lucro Real é obrigatório`)
        : provaImpostos,
    });
  }

  // ── F2: FLUXO DE CAIXA INDIRETO + BALANÇO PROJETADO (com prova) ──
  // FC parte do ÚLTIMO subtotal da DRE (lucro líquido quando há regime):
  //   FCO = resultado + depreciação (não é caixa) − ΔNCG (giro consome/libera);
  //   FCI = − capex;  FCF = captações − amortizações (juros já estão no resultado).
  // Caixa é corkscrew a partir do caixaInicial (bloco giro). O BP monta dos
  // saldos já calculados; PL = capital de abertura IMPLÍCITO (residual que
  // fecha o 1º mês) + resultados acumulados. A partir do 2º mês, "Ativo =
  // Passivo + PL" é um TEOREMA da consistência do motor — se qualquer peça
  // (ΔNCG, corkscrew, depreciação) estiver errada, o check quebra e aponta.
  const caixaInicial = Math.max(0, num(cfgGiro?.caixaInicial));
  const resultadoFinal = resultadoCorrente;

  // OUTROS ITENS DO BALANÇO: saldo mês a mês por modo (constante | prazo médio
  // × base | cronograma anual). Variação líquida entra no FCO (mês 1 = 0; a
  // abertura entra no capital de abertura implícito, como o giro).
  const itensBalanco = (cfgGiro?.itensBalanco ?? []).filter((it) => it.nome?.trim());
  const anosDoHorizonte = anosInfo.map((a) => a.ano);
  const baseItemDe = (b?: ItemBalanco["base"]): Serie => {
    if (b === "custos") return custosTotal;
    if (b === "folha") return series["folha_total"] ?? {};
    if (b === "impostos") return somaDe(series["impostos_receita_total"] ?? {}, series["irpj_csll_total"] ?? {}, meses);
    return receitaTotal;
  };
  const saldoItemDe = (it: ItemBalanco): Serie => {
    const out: Serie = {};
    if (it.modo === "dias") {
      const baseS = baseItemDe(it.base);
      for (const mes of meses) {
        const ano = mes.slice(0, 4);
        const dias = Math.max(0, typeof it.diasPorAno?.[ano] === "number" ? it.diasPorAno[ano] : num(it.dias));
        out[mes] = Math.max(0, baseS[mes] ?? 0) * (dias / 30);
      }
    } else if (it.modo === "porAno") {
      const porAno = resolverPorAno(it.saldoPorAno, anosDoHorizonte);
      for (const mes of meses) out[mes] = Math.max(0, porAno?.[mes.slice(0, 4)] ?? num(it.saldo));
    } else {
      for (const mes of meses) out[mes] = Math.max(0, num(it.saldo));
    }
    return out;
  };
  const itensCalc = itensBalanco.map((it) => ({ it, serie: saldoItemDe(it) }));
  for (const { it, serie: s } of itensCalc) series[`bpitem_${it.id}`] = s;
  const ehAtivoItem = (c: ItemBalanco["classificacao"]) => c === "ac" || c === "anc";
  const deltaOutros: Serie = {};
  for (let i = 0; i < meses.length; i++) {
    const mes = meses[i];
    if (i === 0) { deltaOutros[mes] = 0; continue; }
    let d = 0;
    for (const { it, serie: s } of itensCalc) {
      const delta = (s[mes] ?? 0) - (s[meses[i - 1]] ?? 0);
      d += ehAtivoItem(it.classificacao) ? -delta : delta;
    }
    deltaOutros[mes] = d;
  }
  const fcoS: Serie = {}; const fciS: Serie = {}; const fcfS: Serie = {};
  const variacaoS: Serie = {}; const caixaIniS: Serie = {}; const caixaS: Serie = {};
  const plS: Serie = {}; const ativoS: Serie = {}; const passivoS: Serie = {};
  const acS: Serie = {}; const ancS: Serie = {}; const pcS: Serie = {}; const pncS: Serie = {};
  let saldoCaixa = caixaInicial;
  let plAcum = 0;
  const difMax = { v: 0, mes: "" };
  const caixaMin = { v: Number.POSITIVE_INFINITY, mes: "" };
  for (let i = 0; i < meses.length; i++) {
    const mes = meses[i];
    const depr = temCapex ? depreciacaoTotal[mes] ?? 0 : 0;
    const dNcg = temGiro ? series["delta_ncg"]?.[mes] ?? 0 : 0;
    fcoS[mes] = (resultadoFinal[mes] ?? 0) + depr - dNcg + (deltaOutros[mes] ?? 0);
    fciS[mes] = -(temCapex ? capexTotal[mes] ?? 0 : 0);
    fcfS[mes] = temDivida ? (captacaoDividaTotal[mes] ?? 0) - (amortizacaoDividaTotal[mes] ?? 0) : 0;
    variacaoS[mes] = fcoS[mes] + fciS[mes] + fcfS[mes];
    caixaIniS[mes] = saldoCaixa;
    saldoCaixa += variacaoS[mes];
    caixaS[mes] = saldoCaixa;
    if (saldoCaixa < caixaMin.v) { caixaMin.v = saldoCaixa; caixaMin.mes = mes; }

    const cr = temGiro ? series["contas_a_receber"]?.[mes] ?? 0 : 0;
    const est = temGiro ? series["estoques_giro"]?.[mes] ?? 0 : 0;
    const forn = temGiro ? series["fornecedores_giro"]?.[mes] ?? 0 : 0;
    const imob = temCapex ? imobilizadoLiquido[mes] ?? 0 : 0;
    const dividaCp = temDivida ? dividaCpTotal[mes] ?? 0 : 0;
    const dividaLp = temDivida ? dividaLpTotal[mes] ?? 0 : 0;
    let outrosAc = 0, outrosAnc = 0, outrosPc = 0, outrosPnc = 0;
    for (const { it, serie: s } of itensCalc) {
      const v = s[mes] ?? 0;
      if (it.classificacao === "ac") outrosAc += v;
      else if (it.classificacao === "anc") outrosAnc += v;
      else if (it.classificacao === "pc") outrosPc += v;
      else outrosPnc += v;
    }
    // Grupos contábeis: circulante = realiza/vence em até 12 meses.
    const ativoCirc = saldoCaixa + cr + est + outrosAc;
    const ativoNaoCirc = imob + outrosAnc;
    const passivoCirc = forn + dividaCp + outrosPc;
    const passivoNaoCirc = dividaLp + outrosPnc;
    const ativo = ativoCirc + ativoNaoCirc;
    const passivo = passivoCirc + passivoNaoCirc;
    if (i === 0) plAcum = ativo - passivo; // capital de abertura implícito
    else plAcum += resultadoFinal[mes] ?? 0;
    ativoS[mes] = ativo;
    passivoS[mes] = passivo;
    plS[mes] = plAcum;
    acS[mes] = ativoCirc;
    ancS[mes] = ativoNaoCirc;
    pcS[mes] = passivoCirc;
    pncS[mes] = passivoNaoCirc;
    if (i > 0) {
      const dif = Math.abs(ativo - passivo - plAcum);
      if (dif > difMax.v) { difMax.v = dif; difMax.mes = mes; }
    }
  }
  series["fc_fco"] = fcoS;
  series["fc_fci"] = fciS;
  series["fc_fcf"] = fcfS;
  series["fc_variacao"] = variacaoS;
  series["caixa_final"] = caixaS;
  series["bp_ativo"] = ativoS;
  series["bp_passivo"] = passivoS;
  series["bp_pl"] = plS;

  // Estrutura de exibição (mesma forma da DRE; a tela agrega anual: FC soma,
  // BP usa o FIM do ano por ser saldo).
  const fc: LinhaDre[] = [
    { id: "fc-resultado", nome: "Resultado do período", grupo: "subtotal", valores: resultadoFinal, pctReceita: pctDe(resultadoFinal) },
    ...(temCapex ? [{ id: "fc-depreciacao", nome: "(+) Depreciação e amortização (não é caixa)", grupo: "receita" as const, valores: depreciacaoTotal, pctReceita: pctDe(depreciacaoTotal) }] : []),
    ...(temGiro ? [{ id: "fc-ncg", nome: "(−) Variação do capital de giro (NCG)", grupo: "despesas" as const, valores: negativoDe(series["delta_ncg"], meses), pctReceita: pctDe(series["delta_ncg"]) }] : []),
    ...(itensCalc.length ? [{ id: "fc-outros", nome: "(±) Variação de outros itens do balanço", grupo: "despesas" as const, valores: deltaOutros, pctReceita: pctDe(deltaOutros) }] : []),
    { id: "fc-fco", nome: "Caixa das operações (FCO)", grupo: "subtotal", valores: fcoS, pctReceita: pctDe(fcoS) },
    ...(temCapex ? [
      { id: "fc-capex", nome: "(−) Compra de ativos (capex)", grupo: "despesas" as const, valores: fciS, pctReceita: pctDe(fciS) },
      { id: "fc-fci", nome: "Caixa dos investimentos (FCI)", grupo: "subtotal" as const, valores: fciS, pctReceita: pctDe(fciS) },
    ] : []),
    ...(temDivida ? [
      { id: "fc-captacoes", nome: "(+) Captações de dívida", grupo: "receita" as const, valores: captacaoDividaTotal, pctReceita: pctDe(captacaoDividaTotal) },
      { id: "fc-amortizacoes", nome: "(−) Amortização de dívida", grupo: "despesas" as const, valores: negativoDe(amortizacaoDividaTotal, meses), pctReceita: pctDe(amortizacaoDividaTotal) },
      { id: "fc-fcf", nome: "Caixa dos financiamentos (FCF)", grupo: "subtotal" as const, valores: fcfS, pctReceita: pctDe(fcfS) },
    ] : []),
    { id: "fc-variacao", nome: "Variação do caixa no período", grupo: "subtotal", valores: variacaoS, pctReceita: pctDe(variacaoS) },
    { id: "fc-caixa-inicio", nome: "Caixa no início do período", grupo: "receita", valores: caixaIniS, pctReceita: pctDe(caixaIniS) },
    { id: "fc-caixa-fim", nome: "Caixa no fim do período", grupo: "subtotal", valores: caixaS, pctReceita: pctDe(caixaS) },
  ];
  // BALANÇO nas regras contábeis: circulante (realiza/vence em até 12 meses)
  // separado do não circulante, no ativo e no passivo; dívida aberta CP × LP
  // pelo cronograma real de amortização. Convenção da casa: total ANTES das linhas.
  const linhasItens = (cl: ItemBalanco["classificacao"]): LinhaDre[] =>
    itensCalc
      .filter(({ it }) => it.classificacao === cl)
      .map(({ it, serie: s }) => ({
        id: `bp-item-${it.id}`,
        nome: it.nome,
        grupo: (cl === "ac" || cl === "anc" ? "receita" : "despesas") as LinhaDre["grupo"],
        valores: s,
        pctReceita: pctDe(s),
      }));
  const bp: LinhaDre[] = [
    { id: "bp-ativo", nome: "ATIVO", grupo: "subtotal", valores: ativoS, pctReceita: pctDe(ativoS) },
    { id: "bp-ativo-circ", nome: "Ativo circulante", grupo: "subtotal", valores: acS, pctReceita: pctDe(acS) },
    { id: "bp-caixa", nome: "Caixa e equivalentes", grupo: "receita", valores: caixaS, pctReceita: pctDe(caixaS) },
    ...(temGiro ? [
      { id: "bp-cr", nome: "Contas a receber", grupo: "receita" as const, valores: series["contas_a_receber"], pctReceita: pctDe(series["contas_a_receber"]) },
      { id: "bp-estoques", nome: "Estoques", grupo: "receita" as const, valores: series["estoques_giro"], pctReceita: pctDe(series["estoques_giro"]) },
    ] : []),
    ...linhasItens("ac"),
    { id: "bp-ativo-nc", nome: "Ativo não circulante", grupo: "subtotal", valores: ancS, pctReceita: pctDe(ancS) },
    ...(temCapex ? [{ id: "bp-imobilizado", nome: "Imobilizado líquido", grupo: "receita" as const, valores: imobilizadoLiquido, pctReceita: pctDe(imobilizadoLiquido) }] : []),
    ...linhasItens("anc"),
    { id: "bp-passivo-pl", nome: "PASSIVO + PATRIMÔNIO LÍQUIDO", grupo: "subtotal", valores: somaDe(passivoS, plS, meses), pctReceita: pctDe(ativoS) },
    { id: "bp-passivo-circ", nome: "Passivo circulante", grupo: "subtotal", valores: pcS, pctReceita: pctDe(pcS) },
    ...(temGiro ? [{ id: "bp-fornecedores", nome: "Fornecedores", grupo: "despesas" as const, valores: series["fornecedores_giro"], pctReceita: pctDe(series["fornecedores_giro"]) }] : []),
    ...(temDivida ? [{ id: "bp-divida-cp", nome: "Empréstimos e financiamentos (curto prazo)", grupo: "despesas" as const, valores: dividaCpTotal, pctReceita: pctDe(dividaCpTotal) }] : []),
    ...linhasItens("pc"),
    { id: "bp-passivo-nc", nome: "Passivo não circulante", grupo: "subtotal", valores: pncS, pctReceita: pctDe(pncS) },
    ...(temDivida ? [{ id: "bp-divida-lp", nome: "Empréstimos e financiamentos (longo prazo)", grupo: "despesas" as const, valores: dividaLpTotal, pctReceita: pctDe(dividaLpTotal) }] : []),
    ...linhasItens("pnc"),
    { id: "bp-pl", nome: "Patrimônio líquido (abertura + resultados acumulados)", grupo: "subtotal", valores: plS, pctReceita: pctDe(plS) },
  ];
  series["bp_ativo_circulante"] = acS;
  series["bp_ativo_nao_circulante"] = ancS;
  series["bp_passivo_circulante"] = pcS;
  series["bp_passivo_nao_circulante"] = pncS;

  checks.push({
    id: "bp-fecha",
    nome: "Balanço fecha (Ativo = Passivo + PL)",
    ok: difMax.v <= 0.01,
    prova: difMax.v <= 0.01
      ? `Equação patrimonial fechada nos ${meses.length} meses (maior diferença R$ ${difMax.v.toFixed(4)})`
      : `Diferença de R$ ${difMax.v.toFixed(2)} em ${difMax.mes} — inconsistência entre FC, giro e corkscrews`,
  });
  checks.push({
    id: "caixa-minimo",
    nome: "Caixa nunca negativo",
    ok: caixaMin.v >= 0,
    prova: caixaMin.v >= 0
      ? `Menor caixa projetado: R$ ${caixaMin.v.toFixed(2)} em ${caixaMin.mes}`
      : `Caixa NEGATIVO (mínimo R$ ${caixaMin.v.toFixed(2)} em ${caixaMin.mes}) — a operação não se paga nesse trecho: projete captação, aporte ou ajuste as premissas`,
  });

  // ── Checks de valores ──
  const naoFinitos: string[] = [];
  for (const [id, s] of Object.entries(series)) {
    for (const mes of meses) {
      if (!Number.isFinite(s[mes])) { naoFinitos.push(`${id}@${mes}`); break; }
    }
  }
  checks.push({
    id: "valores-finitos",
    nome: "Séries sem valores inválidos",
    ok: naoFinitos.length === 0,
    prova: naoFinitos.length === 0 ? `${Object.keys(series).length} séries × ${meses.length} meses avaliados` : `Inválidos: ${naoFinitos.join(", ")}`,
  });

  // Capacidade/taxa com teto (ocupação ≤ 100% etc.)
  const estouros: string[] = [];
  for (const [id, no] of nos) {
    const max = no.node.tipo === "taxa"
      ? num(no.params.max, no.node.papel === "ocupacao" ? 1 : Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(max)) continue;
    for (const mes of meses) {
      if ((series[id][mes] ?? 0) > max + 1e-9) {
        estouros.push(`"${no.node.nome}" = ${(series[id][mes] * 100).toFixed(1)}% em ${mes} (teto ${(max * 100).toFixed(0)}%)`);
        break;
      }
    }
  }
  checks.push({
    id: "capacidade",
    nome: "Tetos respeitados (ocupação/capacidade)",
    ok: estouros.length === 0,
    prova: estouros.length === 0 ? "Nenhuma taxa acima do teto" : estouros.join("; "),
  });

  // Receita negativa não existe: se uma fórmula produzir (ex.: descontos maiores
  // que a receita), o check aponta a linha e o mês — o analista corrige a premissa.
  const negativas: string[] = [];
  for (const l of linhasReceita) {
    for (const mes of meses) {
      if ((l.valores[mes] ?? 0) < -1e-9) {
        negativas.push(`"${l.nome}" em ${mes} (${(l.valores[mes]).toFixed(2)})`);
        break;
      }
    }
  }
  checks.push({
    id: "receita-nao-negativa",
    nome: "Nenhuma linha de receita negativa",
    ok: negativas.length === 0,
    prova: negativas.length === 0 ? `${linhasReceita.length} linha(s) de receita ≥ 0 em todos os meses` : negativas.join("; "),
  });

  // Prova do corkscrew da dívida: o saldo final TEM que fechar com a conta
  // início + captações − amortizações, e o saldo nunca fica negativo.
  if (temDivida) {
    const somaCapt = meses.reduce((s, m) => s + (captacaoDividaTotal[m] ?? 0), 0);
    const somaAmort = meses.reduce((s, m) => s + (amortizacaoDividaTotal[m] ?? 0), 0);
    const saldoFim = dividaSaldoTotal[meses[meses.length - 1]] ?? 0;
    const esperado = saldoIniDividaTotal + somaCapt - somaAmort;
    const mesNegativo = meses.find((m) => (dividaSaldoTotal[m] ?? 0) < -0.005);
    checks.push({
      id: "divida-corkscrew",
      nome: "Dívida fecha (início + captações − amortizações)",
      ok: Math.abs(saldoFim - esperado) < 0.01 && !mesNegativo,
      prova: mesNegativo
        ? `Saldo devedor NEGATIVO em ${mesNegativo}`
        : `Saldo final ${saldoFim.toFixed(2)} = início ${saldoIniDividaTotal.toFixed(2)} + captações ${somaCapt.toFixed(2)} − amortizações ${somaAmort.toFixed(2)}`,
    });
  }

  checks.push({
    id: "realizado",
    nome: "Realizado de referência",
    ok: true,
    prova: mesesReais.size > 0
      ? `${mesesReais.size} mês(es) do balancete disponíveis como referência (comparação orçado×realizado entra em fase futura)`
      : "Sem meses de balancete no horizonte — modelo 100% premissa",
  });

  // ── Agregações e KPIs ──
  const anual: Record<string, Record<string, number>> = {};
  for (const linha of dre) {
    anual[linha.id] = {};
    for (const mes of meses) {
      const ano = mes.slice(0, 4);
      anual[linha.id][ano] = (anual[linha.id][ano] ?? 0) + (linha.valores[mes] ?? 0);
    }
  }

  const kpis: ResultadoModelo["kpis"] = [];
  const noPorPapel = (papel: string): string | undefined => {
    for (const [id, no] of nos) if (no.node.papel === papel) return id;
    return undefined;
  };
  const margemEbitda: Serie = {};
  for (const mes of meses) margemEbitda[mes] = receitaTotal[mes] ? ebitda[mes] / receitaTotal[mes] : 0;
  kpis.push({ id: "margem-ebitda", nome: "Margem EBITDA", valores: margemEbitda });
  const baseId = noPorPapel("baseClientes");
  const arpuId = noPorPapel("arpu");
  const churnId = noPorPapel("churnRate");
  if (baseId) kpis.push({ id: "base-clientes", nome: "Base de clientes", valores: series[baseId] });
  if (baseId && arpuId) {
    const mrr: Serie = {};
    for (const mes of meses) mrr[mes] = (series[baseId][mes] ?? 0) * (series[arpuId][mes] ?? 0);
    kpis.push({ id: "mrr", nome: "Receita recorrente mensal (MRR)", valores: mrr });
  }
  if (churnId) kpis.push({ id: "churn", nome: "Churn mensal de clientes", valores: series[churnId] });

  return { meses, statusMes, series, dre, fc, bp, agregacoes: { anual }, kpis, checks, erros };
}
