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
import { tipoDaLinha } from "./classificacao-conta";

// ── Tipos ──────────────────────────────────────────────────────────────────

export type UnidadeNode = "#" | "%" | "R$" | "R$/un" | "#/un";
export type TipoNode = "estoque" | "fluxo" | "taxa" | "preco" | "capacidade" | "serie" | "formula";

/** Série mensal: chave "YYYY-MM". */
export type Serie = Record<string, number>;

/** Linha de DRE em construção que pode carregar um DESTINO (soma/reduz numa
 *  conta canônica). Compartilhada por receitas, custos e despesas. */
type LinhaComDestino = {
  id: string; nome: string; valores: Serie;
  destino?: { conta: string; sinal: "soma" | "reduz" };
  /** Classe fiscal declarada pelo analista (imposto/dedução) — decide o PONTO
   *  da cascata em que o valor entra, e viaja com a linha desde o bloco. */
  classe?: string;
};

/** Normaliza nome de conta para casar destino ↔ linha canônica (acentos/caixa/espaços). */
function normNomeConta(s: string): string {
  return (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Contas canônicas de FOLHA — a linha que aponta para uma delas (ou que foi
 *  marcada como folha) é a que a aba Pessoas substitui quando o centro de custo
 *  tem posição cadastrada. */
const CONTAS_DE_FOLHA = ["despesas com pessoas", "custos com pessoas (mod)", "custo com pessoas (mod)"];
export function ehLinhaDeFolha(l: { folha?: boolean; destino?: { conta: string } | null; nome?: string }): boolean {
  if (l.folha === true) return true;
  const alvo = l.destino?.conta;
  if (alvo && CONTAS_DE_FOLHA.includes(normNomeConta(alvo))) return true;
  // Sem de-para declarado, o nome resolve: "Salários e encargos (Comercial)".
  return /^salarios? e encargos/.test(normNomeConta(l.nome ?? ""));
}

/**
 * CLASSE FISCAL DA CONTA (05/08/2026) — a conta mora onde o cliente a colocou,
 * mas o VALOR entra onde a contabilidade manda.
 *
 * No plano de contas do cliente, ICMS e PIS são contas de despesa; devolução de
 * venda é conta de receita. Só que imposto sobre faturamento e devolução DEDUZEM
 * A RECEITA BRUTA — ficam ACIMA da Receita Líquida e fora do EBITDA. Lançados
 * como despesa comum, comiam o EBITDA e inflavam a Receita Líquida.
 *
 * A classe é um campo da LINHA, não um bloco novo: nada de migração de schema,
 * e a conta continua visível no grupo em que o analista a cadastrou. Quem lê a
 * DRE vê cada conta pelo NOME (a Belagro tem duas devoluções, Mercado Interno e
 * Externo — o dono pediu que aparecessem abertas, não somadas numa linha só).
 */
export type ClasseFiscal = "impostoReceita" | "impostoResultado" | "deducaoReceita";

/** Separa as linhas de uma classe fiscal do resto do grupo. Roda ANTES de
 *  `aplicarDestinos`: se o destino engolisse a linha primeiro, a conta de
 *  imposto viraria parte de outra e não haveria mais o que extrair. */
function separarClasse<T extends { classe?: string }>(linhas: T[], classe: ClasseFiscal): { resto: T[]; extraidas: T[] } {
  const resto: T[] = [];
  const extraidas: T[] = [];
  for (const l of linhas) (l.classe === classe ? extraidas : resto).push(l);
  return { resto, extraidas };
}

/** Soma mês a mês das linhas extraídas (o total que entra na cascata). */
function somaMensal(linhas: Array<{ valores?: Serie }>, meses: string[]): Serie {
  const s: Serie = {};
  for (const mes of meses) {
    let t = 0;
    for (const l of linhas) t += l.valores?.[mes] ?? 0;
    s[mes] = t;
  }
  return s;
}

/** Aplica os DESTINOS de um grupo (2026-07-16): linhas COM destino não viram
 *  linha própria — o valor é SOMADO (ou SUBTRAÍDO) na conta canônica-alvo,
 *  criada zerada se ainda não existir no grupo. O total do grupo (soma das
 *  linhas resultantes) fica correto nos dois casos. Sem destino = linha própria. */
function aplicarDestinos(linhas: LinhaComDestino[], meses: string[]): LinhaComDestino[] {
  if (!linhas.some((l) => l.destino?.conta)) return linhas;
  const out: LinhaComDestino[] = [];
  const porNome = new Map<string, LinhaComDestino>();
  for (const l of linhas) {
    if (l.destino?.conta) continue;
    out.push(l);
    porNome.set(normNomeConta(l.nome), l);
  }
  for (const l of linhas) {
    if (!l.destino?.conta) continue;
    const sinal = l.destino.sinal === "reduz" ? -1 : 1;
    const chave = normNomeConta(l.destino.conta);
    let alvo = porNome.get(chave);
    if (!alvo) {
      alvo = { id: `dest_${chave.replace(/[^a-z0-9]+/g, "-")}`, nome: l.destino.conta, valores: {} };
      for (const mes of meses) alvo.valores[mes] = 0;
      out.push(alvo);
      porNome.set(chave, alvo);
    }
    // Clona (nunca muta a série original, que pode ser series[nodeRaiz]).
    const somada: Serie = {};
    for (const mes of meses) somada[mes] = (alvo.valores[mes] ?? 0) + sinal * (l.valores[mes] ?? 0);
    alvo.valores = somada;
  }
  return out;
}

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
  /** F7 (comércio) — memória dos SKUs que geraram a série da linha (importação
   *  em massa "centenas de produtos × preço médio", agregada por categoria).
   *  Só proveniência: o motor lê a série do nó, nunca isto. */
  skuDetalhe?: Array<{ nome: string; preco: number; qtd: number }>;
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
  /** DESTINO na DRE (2026-07-16): idem LinhaCusto.destino — soma/reduz numa
   *  conta canônica em vez de virar linha própria. */
  destino?: { conta: string; sinal: "soma" | "reduz" };
  /** CLASSE FISCAL (05/08/2026): "deducaoReceita" etc. — o motor extrai o valor
   *  da linha para o ponto certo da cascata (ver separarClasse). */
  classe?: string;
  /** ALÍQUOTAS PRÓPRIAS da linha (06/08/2026 — "ISS diferente por tipo de
   *  receita"). Fração (0.05 = 5%); componente ausente cai na alíquota do
   *  modelo (aba Impostos). Só vale em Presumido/Real — o Simples é DAS único
   *  por lei. A base da linha rateia as deduções na proporção da receita. */
  aliquotas?: { pisCofinsPct?: number; issPct?: number; icmsPct?: number };
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
  /** Curva do ano: 12 fatores de MÉDIA 1 (uniforme = sem efeito). Distribui o
   *  gasto dentro do ano nos modos pctReceita e fixoReajuste — o modo "serie"
   *  já é mês a mês e não usa. */
  sazonalidade?: number[];
  /** Visão de preenchimento da TELA ("ano" default | "mes"). O motor não muda de
   *  conta por causa dela — quem manda no cálculo é `valores` (mês digitado é
   *  fato). Fica aqui só para o modelo carregar a tela no estado em que ficou. */
  preenchimento?: "ano" | "mes";
  /** serie: valores explícitos. */
  valores?: Serie;
  /** Só em bloco CAPEX: taxa de depreciação linear da classe (a.a.; 0.1 = 10 anos). */
  depreciacaoAnual?: number;
  /** Só em bloco CAPEX: carência em meses antes de depreciar (0 = mês seguinte). */
  carenciaMeses?: number;
  /** Só em bloco CAPEX: tipo do ativo (metadado do dropdown da tela). */
  tipoAtivo?: string;
  /** DESTINO na DRE (2026-07-16): quando definido, esta linha NÃO vira uma linha
   *  própria — o valor SOMA (ou REDUZ) numa CONTA CANÔNICA existente (ex.: um novo
   *  "Aluguel 2" soma em "Despesas com Aluguel, Condomínio e IPTU"). Ausente =
   *  linha própria (comportamento de sempre). */
  destino?: { conta: string; sinal: "soma" | "reduz" };
  /** Posição de exibição na lista (nova linha = fim). Metadado da tela. */
  ordem?: number;
  /** F8 — DETALHAMENTO sob a conta (itens livres, série mensal cada). Quando
   *  existe, a TELA materializa a soma em `valores`; o motor segue lendo só
   *  `valores` (profundidade progressiva sem tocar o cálculo). */
  detalhes?: Array<{ id: string; nome: string; valores: Serie }>;
  /** F9 — ORÇAMENTO BASE ZERO: justificativa obrigatória para aprovar quando o
   *  modelo tem tipoOrcamento "base-zero". Metadado da governança, não do cálculo. */
  obz?: { justificativa: string; classificacao: "obrigatorio" | "importante" | "desejavel" };
  /** CÓDIGO DO PLANO DE CONTAS DO CLIENTE (ex.: "4.1.02.001"). A empresa fala a
   *  língua dela; o roll-up para a conta canônica continua via `destino`. Só
   *  identificação/reconciliação — o motor não lê. */
  codigo?: string;
  /** Declara que a linha É FOLHA: quando o centro de custo dela tiver posição
   *  cadastrada na aba Pessoas, o valor passa a vir de lá (e o digitado aqui
   *  fica guardado, fora do cálculo). Ver `ehLinhaDeFolha`. */
  folha?: boolean;
  /** ETIQUETAS DIMENSIONAIS (orçamento por unidade/CC). O cálculo da DRE não
   *  as usa — quem lê são a visão Por unidade, a matriz GMD e a regra de
   *  precedência da folha. */
  unidadeId?: string | null;
  centroCustoId?: string | null;
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
  /** CENTRO DE CUSTO onde a posição mora (28/07/2026). É por ele que a folha
   *  detalhada SUBSTITUI a linha "Salários e encargos (CC)" digitada na grade:
   *  CC com posição cadastrada passa a valer pela aba Pessoas; CC sem posição
   *  continua valendo o valor digitado. Ausente = folha corporativa (não
   *  substitui linha nenhuma). */
  centroCustoId?: string | null;
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
  /** COMPONENTES DESLIGADOS (30/07/2026): a planilha importada já traz a conta
   *  do imposto — o motor NÃO calcula o componente, senão contaria duas vezes.
   *  A importação desmarca sozinha ao detectar as contas; o analista pode
   *  religar na aba Impostos (decisão dele considerar os dois).
   *  Valores: "simples" | "pisCofins" | "iss" | "icms" | "irCsll". */
  desativados?: string[];
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
    /** DEDUÇÕES DIGITADAS (30/07/2026): série mensal em R$ — mês digitado é
     *  FATO e vence o % naquele mês (mês-que-manda, como nas contas). Vem da
     *  grade (célula/regra) ou da linha "Deduções da receita" da planilha. */
    deducoesValores?: Serie;
    /** Só em bloco CAPEX: imobilizado que a empresa JÁ TEM na largada… */
    saldoInicialImobilizado?: number;
    /** …e a taxa de depreciação linear dele (a.a.). */
    depreciacaoLegadoAnual?: number;
    /** Só em bloco CAPEX: ativos existentes POR CLASSE (substitui os 2 campos
     *  acima quando presente — eles ficam como retrocompatibilidade). */
    ativosExistentes?: AtivoExistente[];
    /** Só em bloco CAPEX (seed, 2026-07-16): BRUTO + acumulada por natureza do
     *  BP v3 do IBR — o balanço projetado CONTINUA os saldos brutos e as
     *  redutoras "(-) Depreciação"/"(-) Amortização" do histórico. */
    aberturaSegregada?: { imobilizadoBruto?: number; depreciacaoAcumulada?: number; intangivelBruto?: number; amortizacaoAcumulada?: number };
    /** Só em bloco CAPEX (30/07/2026): false = o motor NÃO deprecia as linhas
     *  de capex do orçamento — a planilha importada já traz a conta de
     *  depreciação e calcular aqui somaria duas vezes. A importação desliga
     *  sozinha ao detectar as duas coisas; o analista religa na aba
     *  Investimentos. Legado/ativos existentes seguem depreciando normalmente. */
    depreciarCapex?: boolean;
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
  /** ABERTURA informativa de um total fiscal (conta classificada exibida sob
   *  "(−) Impostos sobre a receita"/"(−) Deduções"). O VALOR dela já está no
   *  total logo acima — quem soma ou particiona a DRE deve pular estas linhas,
   *  senão conta duas vezes (foi o defeito da visão por unidade). */
  abertura?: boolean;
}

/** VERSÃO DO MOTOR (07/08/2026): carimbada no resultado — cache calculado por
 *  versão anterior é recalculado na abertura do modelo (sem isto, um deploy do
 *  motor deixava a aba DFs exibindo números velhos até alguém editar algo). */
export const MOTOR_VERSAO = 6;

export interface ResultadoModelo {
  /** Versão do motor que calculou — ver MOTOR_VERSAO. */
  motorVersao?: number;
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
  /** Série de CADA linha de receita/custo/despesa pelo id dela, ANTES de os
   *  destinos serem aplicados. A DRE mostra a conta canônica (uma linha com
   *  destino soma dentro de outra e some da lista); telas que trabalham POR
   *  LINHA — a grade orçamentária — precisam do número da linha mesmo assim. */
  linhasCalculadas: Record<string, Serie>;
  /** Linhas de folha que a aba PESSOAS assumiu (o CC tem posição cadastrada):
   *  saíram do cálculo, mas o valor digitado segue gravado no bloco. */
  linhasFolhaSubstituidas: Array<{ id: string; nome: string; centroCustoId: string }>;
  /** Folha calculada por centro de custo — é o número que a grade mostra na
   *  linha substituída, no lugar do digitado. */
  folhaPorCentro: Record<string, Serie>;
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

/**
 * RATEIO DO ANO COM MESES TRAVADOS (regra do usuário, 24/07/2026).
 *
 * O total do ano é a PREMISSA; os meses que o analista digitou são FATOS; os
 * meses livres absorvem a diferença, mantendo entre si a proporção da
 * sazonalidade. Exemplo do usuário: ano projetado 100, curva uniforme, mas
 * jan–jun foram digitados somando 60 → jul–dez recebem os 40 restantes (e não
 * os 50 que a curva pediria), para o ano fechar em 100. Ano sem mês digitado
 * segue a sazonalidade integralmente — nada muda.
 *
 * Por que importa: sem isto, digitar o realizado de um mês estoura (ou fura) o
 * total do ano em silêncio — o valuation passa a descontar um fluxo que não é
 * o que a premissa anual declara.
 *
 * @param total       total do ano (premissa)
 * @param mesesDoAno  meses (1–12) do ano PRESENTES no horizonte
 * @param pesos       sazonalidade por mês (índice 0–11, média 1); undefined = uniforme
 * @param travados    mês (1–12) → valor digitado
 * @returns valor por mês (1–12) para os meses LIVRES; os travados saem como digitados
 */
export function ratearAnoComTravas(
  total: number,
  mesesDoAno: number[],
  pesos: number[] | undefined,
  travados: Record<number, number>,
): Record<number, number> {
  const peso = (m: number) => (Array.isArray(pesos) && pesos.length === 12 ? num(pesos[m - 1], 1) : 1);
  const out: Record<number, number> = {};
  const livres: number[] = [];
  let somaTravados = 0;
  for (const m of mesesDoAno) {
    if (typeof travados[m] === "number" && Number.isFinite(travados[m])) {
      out[m] = travados[m];
      somaTravados += travados[m];
    } else {
      livres.push(m);
    }
  }
  if (!livres.length) return out; // ano inteiro digitado: o total vira a soma deles
  const resto = total - somaTravados;
  const somaPesosLivres = livres.reduce((s, m) => s + peso(m), 0);
  for (const m of livres) {
    // Peso zero em todos os livres: divide igual, senão o resto se perderia.
    out[m] = somaPesosLivres > 0 ? resto * (peso(m) / somaPesosLivres) : resto / livres.length;
  }
  return out;
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
      // Linha com CLASSE FISCAL fica de fora do nó (revisão adversarial): uma
      // devolução classificada mora no bloco de receitas mas NÃO é receita —
      // somá-la aqui inflava a base de toda fórmula "% × receita_total",
      // divergindo do modo pctReceita, que usa a receita já sem as extraídas.
      for (const l of b.config.linhasReceita ?? []) {
        if ((l as { classe?: string }).classe) continue;
        if (nos.has(l.nodeRaiz)) raizes.push(l.nodeRaiz);
      }
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
  let linhasReceita: Array<LinhaComDestino> = [];
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
      linhasReceita.push({ id: linha.id, nome: linha.nome, valores: series[linha.nodeRaiz] ?? {}, destino: linha.destino, classe: (linha as { classe?: string }).classe });
    }
  }
  // Série POR LINHA (antes do destino): a grade orçamentária mostra a linha do
  // analista, que pode estar somando dentro de uma conta canônica.
  const linhasCalculadas: Record<string, Serie> = {};
  for (const l of linhasReceita) linhasCalculadas[l.id] = l.valores;
  // CONTAS COM CLASSE FISCAL saem da receita ANTES do destino — e a extração é
  // SIMÉTRICA de propósito (05/08/2026, revisão adversarial): a primeira versão
  // só tirava dedução da receita e imposto do gasto, e uma conta classificada
  // no bloco "errado" ficava com o rótulo de um tratamento e a matemática de
  // outro — a grade dizia "Dedução da receita" e o EBITDA pagava a conta. A
  // classe declara O QUE a conta é; o bloco onde mora não pode mudar isso.
  const sepDed = separarClasse(linhasReceita as Array<LinhaComDestino & { classe?: string }>, "deducaoReceita");
  const sepImpRecR = separarClasse(sepDed.resto, "impostoReceita");
  const sepIrR = separarClasse(sepImpRecR.resto, "impostoResultado");
  const contasDeducao = sepDed.extraidas;
  const contasImpostoReceitaDoLadoReceita = sepImpRecR.extraidas;
  const contasImpostoResultadoDoLadoReceita = sepIrR.extraidas;
  linhasReceita = sepIrR.resto;
  // DESTINO: linha de receita direcionada SOMA/REDUZ num produto canônico
  // (não vira linha própria). A receita total é a mesma; muda quais linhas aparecem.
  linhasReceita = aplicarDestinos(linhasReceita, meses);

  // ── GRUPO ABAIXO DO EBITDA — coletores e extração SIMÉTRICA (07/08/2026) ──
  // A extração vale para RECEITA, custos e despesas ("receita financeira com
  // receita bruta, que padrão contábil é este?" — dono). A linha canônica com
  // um destes nomes sai do bloco em que mora e o valor entra no ponto certo
  // da cascata (a receita-side TEM de sair ANTES da soma da receita bruta —
  // senão vira base de imposto). Mesma lição da simetria das classes fiscais.
  const normCanonAbaixo = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const GRUPOS_ABAIXO_EBITDA: Record<string, "da" | "equiv" | "recFin" | "despFin" | "recNaoOpX" | "despNaoOpX"> = {
    "depreciacao e amortizacao": "da",
    "equivalencia patrimonial": "equiv",
    "receitas financeiras": "recFin",
    "despesas financeiras": "despFin",
    "outras receitas nao operacionais": "recNaoOpX",
    "outras despesas nao operacionais": "despNaoOpX",
  };
  const abaixoEbitda: Record<"da" | "equiv" | "recFin" | "despFin" | "recNaoOpX" | "despNaoOpX", Array<{ id: string; nome: string; valores: Serie }>> =
    { da: [], equiv: [], recFin: [], despFin: [], recNaoOpX: [], despNaoOpX: [] };
  const extrairAbaixoEbitdaDe = (linhas: Array<{ id: string; nome: string; valores: Serie; grupoDre?: string }>) => {
    for (let i = linhas.length - 1; i >= 0; i--) {
      // O NOME canônico manda; sem ele, vale o grupoDre da conta SEMEADA do
      // IBR ("Tarifas bancárias" nasce com grupoDre Despesas Financeiras e
      // estava presa no não operacional — apontado pelo dono, 07/08).
      const chave = GRUPOS_ABAIXO_EBITDA[normCanonAbaixo(linhas[i].nome)]
        ?? (linhas[i].grupoDre ? GRUPOS_ABAIXO_EBITDA[normCanonAbaixo(linhas[i].grupoDre!)] : undefined);
      if (chave) abaixoEbitda[chave].unshift(...linhas.splice(i, 1));
    }
  };
  extrairAbaixoEbitdaDe(linhasReceita);

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
  function calcularGrupo(tipo: string): Array<LinhaComDestino> {
    const out: Array<LinhaComDestino> = [];
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

        // SAZONALIDADE nos modos simples (23/07/2026): 12 fatores de média 1,
        // como nos drivers. Uniforme (todos 1) = sem efeito, que é o default —
        // por isso ligar isto não muda nenhum modelo existente. Serve ao gasto
        // com curva própria (13º em dezembro, energia no verão).
        const sazLinha = linha.sazonalidade;
        const temSazLinha = Array.isArray(sazLinha) && sazLinha.length === 12;

        // O MÊS DIGITADO MANDA, E O ANO FECHA (regra do usuário, 24/07/2026).
        // Valores mensais preenchidos à mão (tipicamente o realizado de jan..N)
        // são FATO; a premissa anual continua valendo como total; os meses
        // livres absorvem a diferença na proporção da sazonalidade. Sem meses
        // digitados, nada muda — o rateio é o de sempre.
        const manuais = (linha.valores ?? {}) as Serie;
        const temManual = linha.modo !== "serie" && Object.keys(manuais).some((m) => mesesSet.has(m));

        const valores: Serie = {};
        if (temManual) {
          // Total do ANO pela premissa (o que a linha renderia sem travas).
          const brutoMes = (mes: string): number => {
            const ano = mes.slice(0, 4);
            const fSaz = temSazLinha ? num(sazLinha![Number(mes.split("-")[1]) - 1], 1) : 1;
            return linha.modo === "pctReceita"
              ? baseEm(mes) * (typeof pctPorAno?.[ano] === "number" ? pctPorAno[ano] : pctFlat) * fSaz
              : valorMensal * (fatorAno[ano] ?? 1) * fSaz;
          };
          const porAno = new Map<string, string[]>();
          for (const mes of meses) porAno.set(mes.slice(0, 4), [...(porAno.get(mes.slice(0, 4)) ?? []), mes]);
          for (const [ano, mesesAno] of porAno) {
            const total = mesesAno.reduce((s, m) => s + brutoMes(m), 0);
            const travados: Record<number, number> = {};
            for (const m of mesesAno) {
              const v = manuais[m];
              if (typeof v === "number" && Number.isFinite(v)) travados[Number(m.split("-")[1])] = v;
            }
            const rateio = ratearAnoComTravas(total, mesesAno.map((m) => Number(m.split("-")[1])), sazLinha, travados);
            for (const m of mesesAno) valores[m] = num(rateio[Number(m.split("-")[1])]) * multiLinha;
          }
        } else {
          for (const mes of meses) {
            const ano = mes.slice(0, 4);
            const fSaz = temSazLinha ? num(sazLinha![Number(mes.split("-")[1]) - 1], 1) : 1;
            if (linha.modo === "pctReceita") {
              const pct = typeof pctPorAno?.[ano] === "number" ? pctPorAno[ano] : pctFlat;
              valores[mes] = baseEm(mes) * pct * fSaz * multiLinha;
            } else if (linha.modo === "fixoReajuste") {
              valores[mes] = valorMensal * (fatorAno[ano] ?? 1) * fSaz * multiLinha;
            } else {
              valores[mes] = num(linha.valores?.[mes]) * multiLinha; // série já é mês a mês
            }
          }
        }
        out.push({ id: linha.id, nome: linha.nome, valores, destino: linha.destino, classe: (linha as { classe?: string }).classe, grupoDre: (linha as { grupoDre?: string }).grupoDre, codigo: (linha as { codigo?: string }).codigo } as LinhaComDestino);
      }
      // Linhas com ÁRVORE DE DRIVERS (mesma estrutura das receitas): o valor da
      // linha é a série do nó raiz — % via fórmula (pode referenciar receita_total
      // e raízes de receita), variável do negócio × custo unitário, crescimento…
      for (const linha of b.config.linhasReceita ?? []) {
        if (!nos.has(linha.nodeRaiz)) continue; // erro já registrado acima
        out.push({ id: linha.id, nome: linha.nome, valores: series[linha.nodeRaiz] ?? {}, destino: linha.destino, classe: (linha as { classe?: string }).classe, grupoDre: (linha as { grupoDre?: string }).grupoDre, codigo: (linha as { codigo?: string }).codigo } as LinhaComDestino);
      }
    }
    return out;
  }

  // Grupos operacionais com DESTINO aplicado: uma linha nova ("Aluguel 2")
  // direcionada a "Despesas com Aluguel…" soma NAQUELA linha em vez de abrir
  // uma própria. Total do grupo inalterado (soma/reduz certos). A folha do
  // bloco Pessoas ainda soma na linha canônica DEPOIS (abaixo).
  // ── PESSOAS MANDA NA FOLHA DO CENTRO DE CUSTO (28/07/2026) ──────────────
  // A mesma folha podia ser orçada em dois lugares: digitada na linha
  // "Salários e encargos (Comercial)" da grade E detalhada por posição na aba
  // Pessoas — e as duas somavam na DRE (folha em dobro).
  //
  // Regra: CENTRO DE CUSTO com posição cadastrada em Pessoas passa a valer POR
  // ELA; a linha digitada continua GRAVADA (o analista não perde o que
  // escreveu) mas sai do cálculo. CC sem posição segue valendo o digitado.
  // Quem foi substituída volta em `linhasFolhaSubstituidas`, para a tela poder
  // dizer de onde vem cada número.
  const ccsComPosicao = new Set<string>();
  for (const pos of blocoFolhaPre?.config.posicoes ?? []) {
    if (pos.centroCustoId && (pos.salarioMensal > 0 || pos.modoQtd)) ccsComPosicao.add(pos.centroCustoId);
  }
  const linhasFolhaSubstituidas: Array<{ id: string; nome: string; centroCustoId: string }> = [];
  const folhaPorCentro: Record<string, Serie> = {};
  const zerarFolhaCoberta = (linhas: LinhaComDestino[], origem: LinhaCusto[]): LinhaComDestino[] => {
    if (ccsComPosicao.size === 0) return linhas;
    const porId = new Map(origem.map((l) => [l.id, l]));
    return linhas.map((l) => {
      const cfg = porId.get(l.id);
      const cc = cfg?.centroCustoId;
      if (!cfg || !cc || !ccsComPosicao.has(cc) || !ehLinhaDeFolha(cfg)) return l;
      linhasFolhaSubstituidas.push({ id: l.id, nome: l.nome, centroCustoId: cc });
      const zerada: Serie = {};
      for (const mes of meses) zerada[mes] = 0;
      return { ...l, valores: zerada };
    });
  };
  const linhasCfgCustos = input.blocks.filter((b) => b.ativo && b.tipo === "custos").flatMap((b) => b.config.linhasCusto ?? []);
  const linhasCfgDespesas = input.blocks.filter((b) => b.ativo && b.tipo === "despesas").flatMap((b) => b.config.linhasCusto ?? []);
  const brutasCustos = zerarFolhaCoberta(calcularGrupo("custos"), linhasCfgCustos);
  const brutasDespesas = zerarFolhaCoberta(calcularGrupo("despesas"), linhasCfgDespesas);
  // Idem para custo/despesa: fotografa antes de o destino engolir a linha.
  for (const l of [...brutasCustos, ...brutasDespesas]) linhasCalculadas[l.id] = l.valores;
  // CONTAS DE IMPOSTO saem do custo/despesa antes do destino. O tributo sobre
  // faturamento sobe para a cascata da receita; IRPJ/CSLL desce para depois do
  // LAIR. Nos dois casos, fora do EBITDA — que é o ponto de toda esta mudança.
  const sepImpC = separarClasse(brutasCustos as Array<LinhaComDestino & { classe?: string }>, "impostoReceita");
  const sepImpD = separarClasse(brutasDespesas as Array<LinhaComDestino & { classe?: string }>, "impostoReceita");
  const sepIrC = separarClasse(sepImpC.resto, "impostoResultado");
  const sepIrD = separarClasse(sepImpD.resto, "impostoResultado");
  // SIMETRIA (revisão adversarial): dedução também sai do lado do gasto — uma
  // devolução de venda importada numa aba de despesas é dedução do mesmo jeito.
  const sepDedC = separarClasse(sepIrC.resto, "deducaoReceita");
  const sepDedD = separarClasse(sepIrD.resto, "deducaoReceita");
  const contasImpostoReceita = [...contasImpostoReceitaDoLadoReceita, ...sepImpC.extraidas, ...sepImpD.extraidas];
  const contasImpostoResultado = [...contasImpostoResultadoDoLadoReceita, ...sepIrC.extraidas, ...sepIrD.extraidas];
  contasDeducao.push(...sepDedC.extraidas, ...sepDedD.extraidas);
  const linhasCustos = aplicarDestinos(sepDedC.resto, meses);
  const linhasDespesas = aplicarDestinos(sepDedD.resto, meses);

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
        // Folha POR CENTRO DE CUSTO: é este número que a grade mostra na linha
        // que a aba Pessoas assumiu.
        if (pos.centroCustoId) {
          const acc = folhaPorCentro[pos.centroCustoId] ?? (folhaPorCentro[pos.centroCustoId] = {});
          acc[mes] = (acc[mes] ?? 0) + custoPos[mes];
        }
      }
      series[`folha_${pos.id}_qtd`] = qtd;
      series[`folha_${pos.id}_custo`] = custoPos;
    }

    series["headcount_total"] = headcountTotal;
    series["folha_total"] = folhaTotal;
    // FOLHA DÁ SEQUÊNCIA À LINHA CANÔNICA (2026-07-16): quando o modelo tem a
    // conta do modelo padrão correspondente ("Despesas com Pessoas" no bloco de
    // despesas; "Custo Operacional" na produção), o valor do bloco Pessoas SOMA
    // NELA — a projeção continua na MESMA linha do histórico do IBR, sem linha
    // paralela. Uso típico é INCREMENTAL (contratações além da folha corrente,
    // que segue na premissa da linha); ao modelar a folha INTEIRA no bloco,
    // zere a premissa da linha (o realizado ao lado dá a régua). Sem a conta
    // canônica no modelo, o comportamento antigo (linha própria) permanece.
    const normNomeLinha = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
    const somaNaLinha = (linhas: Array<{ id: string; nome: string; valores: Serie }>, alvoNome: string, extra: Serie): boolean => {
      const alvo = linhas.find((l) => normNomeLinha(l.nome) === alvoNome);
      if (!alvo) return false;
      const somada: Serie = {};
      for (const mes of meses) somada[mes] = (alvo.valores[mes] ?? 0) + (extra[mes] ?? 0);
      alvo.valores = somada;
      return true;
    };
    if (Object.values(folhaCusto).some((v) => v !== 0)) {
      if (!somaNaLinha(linhasCustos, "custo operacional", folhaCusto)) {
        linhasCustos.unshift({ id: "folha-custos", nome: "Folha e encargos (produção)", valores: folhaCusto });
      }
    }
    if (Object.values(folhaDespesa).some((v) => v !== 0)) {
      if (!somaNaLinha(linhasDespesas, "despesas com pessoas", folhaDespesa)) {
        linhasDespesas.unshift({ id: "folha-despesas", nome: "Folha e encargos (adm/comercial)", valores: folhaDespesa });
      }
    }
  }
  // NÃO OPERACIONAIS (abaixo do EBITDA): o valuation separa o operacional do
  // resto — aluguéis recebidos, venda de ativo, multas etc. entram aqui.
  const linhasRecNaoOp = calcularGrupo("receitasNaoOp");
  const linhasDespNaoOp = calcularGrupo("despesasNaoOp");

  // ── GRUPO ABAIXO DO EBITDA MOVE A CONTA (07/08/2026, "a estrutura das DFs
  // deve obrigatoriamente seguir as regras contábeis") ──
  // Conta do orçamento cujo GRUPO DE CONTAS aponta para uma conta canônica
  // ABAIXO do EBITDA (D&A, Equivalência, Receitas/Despesas Financeiras, Outras
  // Não Operacionais) estava presa no bloco de custos/despesas e PESAVA no
  // EBITDA — a D&A de conta aparecia duas vezes na leitura (na despesa e
  // zerada na linha oficial). Aqui, DEPOIS do destino (a linha canônica já
  // somou as contas com sinal), a linha canônica é EXTRAÍDA do bloco e o valor
  // entra no ponto certo da cascata. A extração é por NOME canônico — mesmo
  // critério do fold do IBR.
  // Custos, despesas e os blocos NÃO OPERACIONAIS passam pelos MESMOS
  // coletores da receita (simetria completa): financeira semeada no não-op
  // move para o resultado financeiro.
  extrairAbaixoEbitdaDe(linhasCustos);
  extrairAbaixoEbitdaDe(linhasDespesas);
  extrairAbaixoEbitdaDe(linhasRecNaoOp);
  extrairAbaixoEbitdaDe(linhasDespNaoOp);
  const somaLinhasDe = (linhas: Array<{ valores: Serie }>): Serie => {
    const s: Serie = {};
    for (const mes of meses) s[mes] = linhas.reduce((sm, l) => sm + (l.valores[mes] ?? 0), 0);
    return s;
  };
  const contasDeDA = abaixoEbitda.da;
  const contasEquivalencia = abaixoEbitda.equiv;
  const contasRecFinanceiras = abaixoEbitda.recFin;
  const contasDespFinanceiras = abaixoEbitda.despFin;
  // Outras Não Operacionais extraídas (grupo declarado) entram DIRETO na
  // seção não operacional — sem passar pelo split por tipo (o grupo manda).
  const depContasDre = somaLinhasDe(contasDeDA);
  const equivContas = somaLinhasDe(contasEquivalencia);
  const recFinContas = somaLinhasDe(contasRecFinanceiras);
  const despFinContas = somaLinhasDe(contasDespFinanceiras);
  const temDepContas = contasDeDA.length > 0;
  const temEquivContas = contasEquivalencia.length > 0;
  const temFinContas = contasRecFinanceiras.length > 0 || contasDespFinanceiras.length > 0;

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
  // SEGREGAÇÃO IMOBILIZADO × INTANGÍVEL (2026-07-16, espelho do BP v3): a
  // natureza vem da classe fiscal (tipoAtivo) — intangível AMORTIZA, o resto
  // DEPRECIA — e o balanço projetado abre BRUTO + redutora por natureza
  // ("Imobilizado"/"(-) Depreciação"/"Intangível"/"(-) Amortização"), como o
  // modelo padrão. Totais (capex/D&A/líquido) permanecem — DRE e FC intactos.
  const brutoImobS: Serie = {}; const brutoIntangS: Serie = {};
  const deprAcumS: Serie = {}; const amortAcumS: Serie = {};
  const liqImobS: Serie = {}; const liqIntangS: Serie = {};
  const capexImobS: Serie = {}; const capexIntangS: Serie = {};
  const deprImobS: Serie = {}; const amortIntangS: Serie = {};
  if (temCapex) {
    // Classes INTANGÍVEIS do catálogo da tela (manter em sincronia com
    // TIPOS_ATIVO em custoTemplates.ts); sem classe (ou "outro"), o nome decide.
    const TIPOS_INTANGIVEL = new Set(["intangivelGeral", "software", "marcas"]);
    const ehIntangivel = (tipoAtivo?: string, nome?: string): boolean => {
      if (tipoAtivo && TIPOS_INTANGIVEL.has(tipoAtivo)) return true;
      if (tipoAtivo && tipoAtivo !== "outro" && tipoAtivo !== "seed-historico") return false;
      const n = (nome ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
      return /intangivel|software|licenc|marca|patente|agio|fundo de comercio/.test(n);
    };
    const taxaPorLinha = new Map<string, number>();
    const carenciaPorLinha = new Map<string, number>();
    const naturezaPorLinha = new Map<string, "imob" | "intang">();
    // depreciarCapex === false: a depreciação já vem como CONTA da planilha
    // importada — taxa 0 nas linhas do orçamento (o capex continua no FCI e no
    // BP; só a derivação da despesa sai). Legado deprecia normalmente.
    const depreciarLinhas = blocoCapex!.config.depreciarCapex !== false;
    for (const l of [...(blocoCapex!.config.linhasCusto ?? []), ...(blocoCapex!.config.linhasReceita ?? [])]) {
      taxaPorLinha.set(l.id, depreciarLinhas ? num(l.depreciacaoAnual, 0.1) : 0);
      carenciaPorLinha.set(l.id, Math.max(0, Math.round(num(l.carenciaMeses))));
      naturezaPorLinha.set(l.id, ehIntangivel((l as { tipoAtivo?: string }).tipoAtivo, l.nome) ? "intang" : "imob");
    }
    const legados = ativosExistentes
      .filter((a) => a.valor > 0)
      .map((a) => ({ residuo: a.valor, deprMensal: a.valor * (Math.max(0, a.taxaAnual) / 12), nat: ehIntangivel(a.tipoAtivo, a.nome) ? "intang" as const : "imob" as const }));
    const liqIniImobNat = legados.filter((lg) => lg.nat === "imob").reduce((s, lg) => s + lg.residuo, 0);
    const liqIniIntangNat = legados.filter((lg) => lg.nat === "intang").reduce((s, lg) => s + lg.residuo, 0);
    // Abertura SEGREGADA do seed (bruto/acumulada do BP do IBR) — o BP projetado
    // CONTINUA os saldos brutos e as redutoras do histórico. Sem o carimbo
    // (modelo antigo/extração sem redutoras), bruto = líquido e acumulada = 0.
    // Identidade FORÇADA: acumulada inicial = bruto − líquido (nunca negativa).
    const seg = blocoCapex!.config.aberturaSegregada;
    const brutoIniImob = Math.max(liqIniImobNat, num(seg?.imobilizadoBruto, liqIniImobNat));
    const brutoIniIntang = Math.max(liqIniIntangNat, num(seg?.intangivelBruto, liqIniIntangNat));
    const acumIniImob = brutoIniImob - liqIniImobNat;
    const acumIniIntang = brutoIniIntang - liqIniIntangNat;
    // Safra com CARÊNCIA: deprecia a partir de inicioEm (mês seguinte + carência).
    const safras: Array<{ valor: number; residuo: number; taxaMensal: number; inicioEm: number; nat: "imob" | "intang" }> = [];
    let saldoImob = liqIniImobNat;
    let saldoIntang = liqIniIntangNat;
    let capexAcumImob = 0; let capexAcumIntang = 0;
    let deprAcum = acumIniImob; let amortAcum = acumIniIntang;
    for (let i = 0; i < meses.length; i++) {
      const mes = meses[i];
      // Deprecia/amortiza o que já existe (legados por classe + safras liberadas)…
      let deprImobMes = 0; let amortIntangMes = 0;
      for (const lg of legados) {
        if (lg.residuo <= 0 || lg.deprMensal <= 0) continue;
        const d = Math.min(lg.deprMensal, lg.residuo);
        if (lg.nat === "intang") amortIntangMes += d; else deprImobMes += d;
        lg.residuo -= d;
      }
      for (const sf of safras) {
        if (sf.residuo <= 0 || i < sf.inicioEm) continue;
        const d = Math.min(sf.valor * sf.taxaMensal, sf.residuo);
        if (sf.nat === "intang") amortIntangMes += d; else deprImobMes += d;
        sf.residuo -= d;
      }
      // …e só DEPOIS o capex do mês vira safra (mês seguinte + carência da linha).
      let capexImobMes = 0; let capexIntangMes = 0;
      for (const l of linhasCapex) {
        const v = l.valores[mes] ?? 0;
        const nat = naturezaPorLinha.get(l.id) ?? "imob";
        if (v > 0) {
          safras.push({ valor: v, residuo: v, taxaMensal: (taxaPorLinha.get(l.id) ?? 0.1) / 12, inicioEm: i + 1 + (carenciaPorLinha.get(l.id) ?? 0), nat });
        }
        if (nat === "intang") capexIntangMes += Math.max(0, v); else capexImobMes += Math.max(0, v);
      }
      saldoImob = saldoImob + capexImobMes - deprImobMes;
      saldoIntang = saldoIntang + capexIntangMes - amortIntangMes;
      capexAcumImob += capexImobMes; capexAcumIntang += capexIntangMes;
      deprAcum += deprImobMes; amortAcum += amortIntangMes;
      capexTotal[mes] = capexImobMes + capexIntangMes;
      depreciacaoTotal[mes] = deprImobMes + amortIntangMes;
      imobilizadoLiquido[mes] = saldoImob + saldoIntang;
      capexImobS[mes] = capexImobMes; capexIntangS[mes] = capexIntangMes;
      deprImobS[mes] = deprImobMes; amortIntangS[mes] = amortIntangMes;
      liqImobS[mes] = saldoImob; liqIntangS[mes] = saldoIntang;
      brutoImobS[mes] = brutoIniImob + capexAcumImob;
      brutoIntangS[mes] = brutoIniIntang + capexAcumIntang;
      deprAcumS[mes] = deprAcum; amortAcumS[mes] = amortAcum;
    }
    // Séries sintéticas para a tela/export (memória por natureza + agregados).
    series["capex_total"] = capexTotal;
    series["depreciacao_total"] = depreciacaoTotal;
    series["imobilizado_liquido"] = imobilizadoLiquido;
    series["capex_imobilizado"] = capexImobS;
    series["capex_intangivel"] = capexIntangS;
    series["depreciacao_imobilizado"] = deprImobS;
    series["amortizacao_intangivel"] = amortIntangS;
    series["imob_liquido"] = liqImobS;
    series["intang_liquido"] = liqIntangS;
    series["imobilizado_bruto"] = brutoImobS;
    series["intangivel_bruto"] = brutoIntangS;
    series["depreciacao_acumulada"] = deprAcumS;
    series["amortizacao_acumulada"] = amortAcumS;
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
  // MÊS DIGITADO MANDA (30/07/2026): a linha de deduções se comporta como as
  // outras contas — valor mensal digitado (grade/planilha) é FATO e vence o %
  // naquele mês; nos demais o % (por ano, senão flat) segue vivo com a receita.
  const deducoesDigitadas = cfgReceitasBloco?.deducoesValores;
  const deducoes: Serie = {};
  let temDeducoes = false;
  for (const mes of meses) {
    const ano = mes.slice(0, 4);
    const digitado = deducoesDigitadas?.[mes];
    if (typeof digitado === "number" && Number.isFinite(digitado)) {
      deducoes[mes] = Math.max(0, digitado);
    } else {
      const pct = typeof deducoesPorAnoCfg?.[ano] === "number"
        ? Math.max(0, Math.min(0.9, deducoesPorAnoCfg[ano]))
        : deducoesFlat;
      deducoes[mes] = Math.max(0, receitaTotal[mes] ?? 0) * pct;
    }
    if (deducoes[mes] !== 0) temDeducoes = true;
  }
  // CONTAS de dedução somam à linha do % / série. As duas fontes convivem: quem
  // usa só o percentual continua igual; quem trouxe as contas (Devoluções
  // Mercado Interno/Externo) as vê abertas E dentro da base fiscal.
  //
  // SOMA CRUA, SEM Math.abs (revisão adversarial): a convenção declarada é
  // "valor positivo, o motor subtrai" — e um mês NEGATIVO é estorno legítimo,
  // que devolve. O abs transformava estorno em acréscimo (jan +100k, fev −20k
  // virava 120k de dedução em vez de 80k) e fazia o total divergir das linhas
  // abertas logo abaixo, que sempre mostraram o valor cru.
  const totalContasDeducao = somaMensal(contasDeducao, meses);
  for (const mes of meses) {
    const v = totalContasDeducao[mes] ?? 0;
    if (v !== 0) { deducoes[mes] = (deducoes[mes] ?? 0) + v; temDeducoes = true; }
  }
  // Conta classificada mas ainda sem valor CONTINUA na Demonstração, zerada —
  // sumir da DRE ao ganhar a classe parecia que a classificação apagou a conta.
  if (contasDeducao.length > 0) temDeducoes = true;
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
  // COMPONENTE DESLIGADO (30/07/2026): o imposto já veio como CONTA na planilha
  // importada — calcular aqui somaria duas vezes. O check fica na aba Impostos.
  const impDesligado = new Set(Array.isArray(cfgImp?.desativados) ? cfgImp!.desativados : []);
  if (regime === "simples" && impDesligado.has("simples")) {
    for (const mes of meses) impostosReceita[mes] = 0;
    provaImpostos = "DAS do Simples DESLIGADO na aba Impostos — o imposto entra pelas contas do orçamento (planilha importada)";
  } else if (regime === "simples") {
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
    const pisCofins = impDesligado.has("pisCofins") ? 0 : Math.max(0, num(cfgImp!.pisCofinsPct, regime === "presumido" ? 0.0365 : 0.0925));
    const iss = impDesligado.has("iss") ? 0 : Math.max(0, num(cfgImp!.issPct));
    const icms = impDesligado.has("icms") ? 0 : Math.max(0, num(cfgImp!.icmsPct));
    // ALÍQUOTA POR LINHA DE RECEITA (06/08/2026, Frente 2 — pedido do dono:
    // "tem empresas com ISS diferente por tipo de receita"). A linha pode
    // declarar `aliquotas: { pisCofinsPct?/issPct?/icmsPct? }`; sem declarar,
    // vale a alíquota do modelo. O imposto vira a soma por linha, com a base de
    // cada uma RATEANDO as deduções na proporção da receita (fator base/bruta)
    // — mesma base fiscal de sempre, só repartida. Sem nenhuma linha declarada,
    // Σ(valor_linha × fator) = receitaBase e o total é IDÊNTICO ao de antes:
    // regressão zero por construção.
    // Valores pré-destino (linhasCalculadas) COM O SINAL DO DESTINO (revisão
    // adversarial 06/08): linha com destino "reduz" (ex.: anulação de frete
    // reduzindo a conta de fretes) entra NEGATIVA — devolve o imposto na
    // alíquota dela (ou do modelo). Sem o sinal, a soma das bases estourava a
    // receita bruta e a devolução era TRIBUTADA em vez de devolvida. Com o
    // sinal, Σ(valor × sinal) = receitaTotal pós-destino, exato. Linha com
    // classe fiscal fica fora — não é receita. Componente desligado zera
    // também o override da linha.
    // Mesma varredura da coleta de linhas (TODOS os blocos de receita ativos —
    // não só o primeiro): Σ(valor × sinal) tem de bater com receitaTotal.
    const linhasAliquota = input.blocks
      .filter((b) => b.ativo && b.tipo === "receitas")
      .flatMap((b) => b.config.linhasReceita ?? [])
      .filter((l) => !(l as { classe?: string }).classe)
      .map((l) => ({
        valores: linhasCalculadas[l.id] ?? {},
        sinal: l.destino?.sinal === "reduz" ? -1 : 1,
        aliq: (l as { aliquotas?: { pisCofinsPct?: number; issPct?: number; icmsPct?: number } }).aliquotas,
      }));
    const temAliquotaPropria = linhasAliquota.some((l) => l.aliq && (l.aliq.pisCofinsPct != null || l.aliq.issPct != null || l.aliq.icmsPct != null));
    // Componentes ABERTOS (o resumo da aba e o Excel detalham a composição).
    const sPisCofins: Serie = {};
    const sIss: Serie = {};
    const sIcms: Serie = {};
    for (const mes of meses) {
      const rec = receitaBase[mes] ?? 0; // base já líquida das deduções
      // bruta=0 com base≠0 (mês só de dedução): não há o que ratear — cai na
      // fórmula do modelo para não perder o estorno que o caminho legado dá.
      if (temAliquotaPropria && (receitaTotal[mes] ?? 0) !== 0) {
        const bruta = receitaTotal[mes] ?? 0;
        const fator = rec / bruta;
        let pc = 0, is = 0, ic = 0;
        for (const l of linhasAliquota) {
          const base = (l.valores[mes] ?? 0) * l.sinal * fator;
          pc += base * (impDesligado.has("pisCofins") ? 0 : Math.max(0, l.aliq?.pisCofinsPct ?? pisCofins));
          is += base * (impDesligado.has("iss") ? 0 : Math.max(0, l.aliq?.issPct ?? iss));
          ic += base * (impDesligado.has("icms") ? 0 : Math.max(0, l.aliq?.icmsPct ?? icms));
        }
        sPisCofins[mes] = pc; sIss[mes] = is; sIcms[mes] = ic;
      } else {
        sPisCofins[mes] = rec * pisCofins;
        sIss[mes] = rec * iss;
        sIcms[mes] = rec * icms;
      }
      impostosReceita[mes] = sPisCofins[mes] + sIss[mes] + sIcms[mes];
    }
    // O gate olha a SÉRIE, não a alíquota do modelo: com override por linha o
    // componente pode existir mesmo com a alíquota global zerada.
    const temValor = (s: Serie) => meses.some((m) => (s[m] ?? 0) !== 0);
    if (temValor(sPisCofins)) series["impostos_pis_cofins"] = sPisCofins;
    if (temValor(sIss)) series["impostos_iss"] = sIss;
    if (temValor(sIcms)) series["impostos_icms"] = sIcms;
    provaImpostos = `${regime === "presumido" ? "Presumido" : "Real"}: ${((pisCofins + iss + icms) * 100).toFixed(2)}% sobre a receita (PIS/COFINS${iss ? " + ISS" : ""}${icms ? " + ICMS" : ""}) + IRPJ/CSLL abaixo do resultado`;
    if (temAliquotaPropria) {
      const n = linhasAliquota.filter((l) => l.aliq && (l.aliq.pisCofinsPct != null || l.aliq.issPct != null || l.aliq.icmsPct != null)).length;
      provaImpostos += ` · ${n} linha(s) de receita com alíquota própria (base rateada pelas deduções)`;
    }
    if (impDesligado.size > 0) provaImpostos += ` · componente(s) DESLIGADO(S) na aba Impostos (o imposto entra pelas contas importadas): ${[...impDesligado].join(", ")}`;
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
    // Componente desligado fica fora TAMBÉM no mundo reforma (o imposto veio
    // pelas contas importadas — a régua é a mesma nos dois mundos).
    const pisCofinsAtual = impDesligado.has("pisCofins") ? 0 : Math.max(0, num(cfgImp!.pisCofinsPct, regime === "presumido" ? 0.0365 : 0.0925));
    const r = calcularImpostosReforma({
      meses,
      receita: receitaBase, // vendas canceladas também ficam fora do IBS/CBS
      comprasCreditaveis,
      capex: series["capex_total"] ?? {},
      cfg: input.reforma,
      pisCofinsPct: pisCofinsAtual,
      icmsIssPct: (impDesligado.has("iss") ? 0 : Math.max(0, num(cfgImp!.issPct)))
        + (impDesligado.has("icms") ? 0 : Math.max(0, num(cfgImp!.icmsPct))),
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
  // (a série é publicada mais abaixo, DEPOIS da soma das contas classificadas —
  //  publicar aqui deixava o caso "regime nenhum + contas" com a série vazia.)

  // A DRE SEMPRE abre por produto/linha (nomes são do analista; esconder a linha
  // única fazia o produto "sumir" da Demonstração).
  const dre: LinhaDre[] = [];
  dre.push({ id: "receita-total", nome: "Receita", grupo: "subtotal", valores: receitaTotal, pctReceita: pctDe(receitaTotal) });
  for (const l of linhasReceita) dre.push({ id: l.id, nome: l.nome, grupo: "receita", valores: l.valores, pctReceita: pctDe(l.valores) });

  // Cascata contábil: BRUTA → (−) deduções (vendas canceladas/abatimentos) →
  // (−) impostos sobre a receita → RECEITA LÍQUIDA; o lucro bruto parte dela.
  // A CASCATA É SEMPRE A MESMA (05/08/2026, decisão do dono: "sem impostos deve
  // apenas ZERAR as alíquotas e MANTER as linhas").
  //
  // Antes, regime "nenhum" não zerava imposto: ele apagava a estrutura. Sumiam
  // a linha de impostos, o subtotal RECEITA LÍQUIDA, a linha de IRPJ/CSLL e o
  // subtotal LUCRO LÍQUIDO — a DRE parava no LAIR, e o fluxo de caixa indireto
  // passava a partir dele. Quem calcula o próprio imposto por fora não tinha
  // como usar essa opção: perdia a demonstração inteira junto com o cálculo.
  //
  // Agora "nenhum" quer dizer alíquota zero. A DRE de um modelo sem regime é a
  // mesma de um com regime, com zeros no lugar dos tributos — e comparável com
  // qualquer outra. Os VALORES não mudam para quem já tinha regime: as séries
  // de imposto continuam vindo do mesmo cálculo.
  // ZERO DECLARADO, NÃO CÉLULA VAZIA: sem regime nenhum ramo acima preenche a
  // série, e a linha sairia na DRE com os meses ausentes — em branco na tela e
  // fora de qualquer soma. "Alíquota zero" precisa ser um zero de verdade.
  for (const mes of meses) if (typeof impostosReceita[mes] !== "number") impostosReceita[mes] = 0;

  // CONTAS DE IMPOSTO SOMAM AO QUE O MOTOR CALCULOU (05/08/2026, decisão do
  // dono: "o que tiver no motor é fato"). Não há desligamento automático: se o
  // analista deixar o regime ligado E trouxer a conta, os dois entram — e a
  // importação AVISA que isso vai acontecer. Quem calcula por fora deixa o
  // regime em "nenhum" (alíquota zero) e só as contas contam.
  const totalContasImpReceita = somaMensal(contasImpostoReceita, meses);
  const totalContasImpResultado = somaMensal(contasImpostoResultado, meses);
  for (const mes of meses) impostosReceita[mes] = (impostosReceita[mes] ?? 0) + (totalContasImpReceita[mes] ?? 0);
  // A SÉRIE ACOMPANHA A LINHA DA DRE, SEMPRE (revisão adversarial): ela só era
  // publicada com regime, e o caso-bandeira desta mudança — "calculo por fora",
  // regime nenhum + contas — deixava o valuation (NOPAT/FCFF), o item de
  // balanço de obrigações tributárias, o Dashboard e o Excel lendo ZERO
  // enquanto a DRE imprimia o imposto. Número contando histórias diferentes.
  series["impostos_receita_total"] = impostosReceita;

  const receitaLiquida: Serie = {};
  for (const mes of meses) {
    receitaLiquida[mes] = (receitaTotal[mes] ?? 0) - (deducoes[mes] ?? 0) - (impostosReceita[mes] ?? 0);
  }
  if (temDeducoes) {
    dre.push({
      id: "deducoes-receita",
      nome: "(−) Deduções da receita (vendas canceladas e abatimentos)",
      grupo: "despesas", valores: deducoes, pctReceita: pctDe(deducoes),
    });
    // ABERTA POR CONTA (pedido do dono): a Belagro tem "(-) Devoluções/
    // Cancelamentos Mercado Interno" e "…Externo". Somadas numa linha só, o
    // analista não sabe de qual mercado veio a devolução. Cada conta aparece
    // com o próprio nome, logo abaixo do total.
    for (const c of contasDeducao) {
      dre.push({ id: c.id, nome: c.nome, grupo: "despesas", valores: c.valores ?? {}, pctReceita: pctDe(c.valores ?? {}), abertura: true });
    }
  }
  dre.push({
    id: "impostos-receita",
    nome: regime === "simples" ? "(−) Simples Nacional (DAS)" : "(−) Impostos sobre a receita",
    grupo: "despesas", valores: impostosReceita, pctReceita: pctDe(impostosReceita),
  });
  for (const c of contasImpostoReceita) {
    dre.push({ id: c.id, nome: c.nome, grupo: "despesas", valores: c.valores ?? {}, pctReceita: pctDe(c.valores ?? {}), abertura: true });
  }
  dre.push({ id: "receita-liquida", nome: "Receita líquida", grupo: "subtotal", valores: receitaLiquida, pctReceita: pctDe(receitaLiquida) });

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
  // CASCATA COMPLETA SEMPRE (2026-07-16): a Demonstração replica o modelo
  // padrão do IBR até o Lucro Líquido — bloco vazio = linha ZERADA, nunca
  // omitida (o realizado do IBR acompanha ao lado; zero não muda os números).
  const zeroSerie: Serie = {};
  for (const mes of meses) zeroSerie[mes] = 0;
  // D&A = capex (waterfall) + CONTAS com grupo "Depreciação e Amortização"
  // (07/08/2026): a conta declarada sai do EBITDA e soma aqui, aberta abaixo
  // do total com o próprio nome.
  const depExibida: Serie = {};
  for (const mes of meses) depExibida[mes] = (temCapex ? depreciacaoTotal[mes] ?? 0 : 0) + (temDepContas ? depContasDre[mes] ?? 0 : 0);
  const ebit: Serie = {};
  for (const mes of meses) ebit[mes] = ebitda[mes] - depExibida[mes];
  dre.push({ id: "depreciacao-total", nome: "(−) Depreciação e amortização", grupo: "despesas", valores: depExibida, pctReceita: pctDe(depExibida) });
  for (const c of contasDeDA) {
    dre.push({ id: c.id, nome: c.nome, grupo: "despesas", valores: c.valores ?? {}, pctReceita: pctDe(c.valores ?? {}), abertura: true });
  }
  // EQUIVALÊNCIA PATRIMONIAL: resultado de participações — entra DEPOIS da
  // D&A e ANTES do EBIT (posição do modelo padrão). Conta declarada SOMA no
  // resultado (o sinal do roll-up já veio aplicado do destino).
  if (temEquivContas) {
    for (const mes of meses) ebit[mes] += equivContas[mes] ?? 0;
    dre.push({ id: "equivalencia-patrimonial", nome: "(+) Equivalência patrimonial", grupo: "receita", valores: equivContas, pctReceita: pctDe(equivContas) });
    for (const c of contasEquivalencia) {
      dre.push({ id: c.id, nome: c.nome, grupo: "receita", valores: c.valores ?? {}, pctReceita: pctDe(c.valores ?? {}), abertura: true });
    }
  }
  dre.push({ id: "ebit", nome: "EBIT (resultado operacional)", grupo: "subtotal", valores: ebit, pctReceita: pctDe(ebit) });
  // Último subtotal da cascata (EBIT → após não-op) — base dos juros.
  let resultadoCorrente: Serie = ebit;
  // ── ABAIXO DO EBIT NA SEMÂNTICA DO PRODUTO (07/08/2026, dono: "tarifa
  // bancária e juros são despesa FINANCEIRA") ──
  // O bloco despesasNaoOp É o balde de "Despesa financeira" (tipoDaLinha):
  // TODAS as linhas dele entram em "(−) Despesas financeiras". O bloco
  // receitasNaoOp hospeda duas famílias — código 3.2/nome financeiro vai para
  // "(+) Receitas financeiras", o resto para "(+) Receitas não operacionais".
  // A seção NÃO OPERACIONAL fica só com as "Outras" (inclui contas com grupo
  // "Outras … Não Operacionais" extraídas dos blocos operacionais).
  const recFinDoBloco: typeof linhasRecNaoOp = [];
  const outrasRecNaoOp: typeof linhasRecNaoOp = [];
  for (const l of linhasRecNaoOp) {
    (tipoDaLinha("receitasNaoOp", { codigo: (l as { codigo?: string }).codigo ?? null, nome: l.nome }) === "receitaFinanceira"
      ? recFinDoBloco : outrasRecNaoOp).push(l);
  }
  const contasRecFinTot = [...contasRecFinanceiras, ...recFinDoBloco];
  const contasDespFinTot = [...contasDespFinanceiras, ...linhasDespNaoOp];
  const linhasOutrasDespNaoOp = abaixoEbitda.despNaoOpX;
  outrasRecNaoOp.push(...abaixoEbitda.recNaoOpX);
  if (outrasRecNaoOp.length || linhasOutrasDespNaoOp.length) {
    const recNaoOpTotal: Serie = {};
    const despNaoOpTotal: Serie = {};
    const resultadoAposNaoOp: Serie = {};
    // Base = o EBIT VIGENTE (resultadoCorrente), nunca o EBITDA: a regra
    // antiga "sem capex, parte do EBITDA" perdia a D&A DE CONTA e a
    // equivalência — o LL do sistema saía R$ 309,17/mês acima do Excel da
    // Belagro (validação do dono, 07/08/2026; diferença provada = D&A).
    const baseNaoOp = resultadoCorrente;
    for (const mes of meses) {
      recNaoOpTotal[mes] = outrasRecNaoOp.reduce((sm, l) => sm + (l.valores[mes] ?? 0), 0);
      despNaoOpTotal[mes] = linhasOutrasDespNaoOp.reduce((sm, l) => sm + (l.valores[mes] ?? 0), 0);
      resultadoAposNaoOp[mes] = baseNaoOp[mes] + recNaoOpTotal[mes] - despNaoOpTotal[mes];
    }
    dre.push({ id: "rec-naoop-total", nome: "(+) Receitas não operacionais", grupo: "subtotal", valores: recNaoOpTotal, pctReceita: pctDe(recNaoOpTotal) });
    for (const l of outrasRecNaoOp) dre.push({ id: l.id, nome: l.nome, grupo: "receita", valores: l.valores, pctReceita: pctDe(l.valores), abertura: true });
    dre.push({ id: "desp-naoop-total", nome: "(−) Despesas não operacionais", grupo: "subtotal", valores: despNaoOpTotal, pctReceita: pctDe(despNaoOpTotal) });
    for (const l of linhasOutrasDespNaoOp) dre.push({ id: l.id, nome: l.nome, grupo: "despesas", valores: l.valores, pctReceita: pctDe(l.valores), abertura: true });
    dre.push({ id: "resultado-apos-naoop", nome: "Resultado após não operacionais", grupo: "subtotal", valores: resultadoAposNaoOp, pctReceita: pctDe(resultadoAposNaoOp) });
    resultadoCorrente = resultadoAposNaoOp;
  }
  // B8: RESULTADO FINANCEIRO na ordem do modelo — Receitas financeiras →
  // Despesas financeiras (contas: juros, tarifas, IOF) → juros da dívida
  // estruturada → LAIR. Sem dívida, a linha de juros vem zerada.
  {
    const jurosExibidos = temDivida ? jurosDividaTotal : zeroSerie;
    const recFinTotS = somaLinhasDe(contasRecFinTot);
    const despFinTotS = somaLinhasDe(contasDespFinTot);
    const lair: Serie = {};
    for (const mes of meses) {
      lair[mes] = resultadoCorrente[mes] - (jurosExibidos[mes] ?? 0)
        + (recFinTotS[mes] ?? 0) - (despFinTotS[mes] ?? 0);
    }
    if (contasRecFinTot.length > 0) {
      dre.push({ id: "rec-financeiras", nome: "(+) Receitas financeiras", grupo: "receita", valores: recFinTotS, pctReceita: pctDe(recFinTotS) });
      for (const c of contasRecFinTot) dre.push({ id: c.id, nome: c.nome, grupo: "receita", valores: c.valores ?? {}, pctReceita: pctDe(c.valores ?? {}), abertura: true });
    }
    if (contasDespFinTot.length > 0) {
      dre.push({ id: "desp-financeiras", nome: "(−) Despesas financeiras", grupo: "despesas", valores: despFinTotS, pctReceita: pctDe(despFinTotS) });
      for (const c of contasDespFinTot) dre.push({ id: c.id, nome: c.nome, grupo: "despesas", valores: c.valores ?? {}, pctReceita: pctDe(c.valores ?? {}), abertura: true });
    }
    dre.push({ id: "juros-divida", nome: "(−) Juros de empréstimos e financiamentos", grupo: "despesas", valores: jurosExibidos, pctReceita: pctDe(jurosExibidos) });
    dre.push({ id: "lair", nome: "Resultado antes dos impostos", grupo: "subtotal", valores: lair, pctReceita: pctDe(lair) });
    resultadoCorrente = lair;
  }

  // ── F3: IRPJ/CSLL e LUCRO LÍQUIDO ──
  // Presumido: base presumida sobre a receita (15% + adicional de 10% acima de
  // R$ 20 mil/mês; CSLL 9%). Real: sobre o resultado do MÊS, com PREJUÍZO
  // FISCAL acumulado (corkscrew) compensável até a TRAVA de 30% da base.
  // Simples: já está no DAS — vai direto ao lucro líquido. Sem regime, o `else`
  // lá embaixo publica IRPJ/CSLL zerado e o Lucro Líquido: a estrutura da DRE
  // não depende de haver regime (só os números dependem).
  if (regime) {
    const irpjCsll: Serie = {};
    if (impDesligado.has("irCsll")) {
      // Provisão de IRPJ/CSLL veio como CONTA na planilha importada — o motor
      // não recalcula (senão contaria duas vezes). Check na aba Impostos.
      for (const mes of meses) irpjCsll[mes] = 0;
      provaImpostos += " · IRPJ/CSLL DESLIGADO na aba Impostos (a provisão entra pelas contas importadas)";
    } else if (regime === "presumido") {
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
    // A provisão que veio como CONTA soma ao que o motor calculou — mesma regra
    // do imposto sobre a receita: motor é fato, conta é fato, os dois entram.
    // Soma CRUA (estorno é mês negativo legítimo; abs o transformava em cobrança).
    for (const mes of meses) irpjCsll[mes] = (irpjCsll[mes] ?? 0) + (totalContasImpResultado[mes] ?? 0);
    // Publicada SEMPRE que a linha existe (revisão adversarial): o valuation lê
    // esta série para o NOPAT — sem ela, FCFF/EV saíam superestimados no Simples
    // e no caso com componente desligado.
    series["irpj_csll_total"] = irpjCsll;
    const lucroLiquido: Serie = {};
    for (const mes of meses) lucroLiquido[mes] = (resultadoCorrente[mes] ?? 0) - (irpjCsll[mes] ?? 0);
    // No Simples o DAS já embute IRPJ/CSLL e a linha não existia — mas a CONTA
    // lançada à parte precisa aparecer: descontar do Lucro líquido sem linha
    // visível deixava a Demonstração sem fechar aos olhos de quem soma.
    if (regime !== "simples" || contasImpostoResultado.length > 0) {
      dre.push({ id: "irpj-csll", nome: "(−) IRPJ e CSLL", grupo: "despesas", valores: irpjCsll, pctReceita: pctDe(irpjCsll) });
      for (const c of contasImpostoResultado) {
        dre.push({ id: c.id, nome: c.nome, grupo: "despesas", valores: c.valores ?? {}, pctReceita: pctDe(c.valores ?? {}), abertura: true });
      }
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
  } else {
    // Sem regime configurado: o motor não calcula NADA — mas a provisão que a
    // empresa lançou como CONTA continua valendo. É exatamente o caso "calculo
    // meus impostos por fora": regime "nenhum" (alíquota zero) + contas.
    const irSemRegime: Serie = {};
    for (const mes of meses) irSemRegime[mes] = totalContasImpResultado[mes] ?? 0;
    // O valuation lê esta série para o NOPAT — é o caso-bandeira "calculo por
    // fora", e sem a publicação o FCFF saía sem imposto nenhum.
    series["irpj_csll_total"] = irSemRegime;
    const lucroSemRegime: Serie = {};
    for (const mes of meses) lucroSemRegime[mes] = (resultadoCorrente[mes] ?? 0) - irSemRegime[mes];
    dre.push({ id: "irpj-csll", nome: "(−) IRPJ e CSLL", grupo: "despesas", valores: irSemRegime, pctReceita: pctDe(irSemRegime) });
    for (const c of contasImpostoResultado) {
      dre.push({ id: c.id, nome: c.nome, grupo: "despesas", valores: c.valores ?? {}, pctReceita: pctDe(c.valores ?? {}), abertura: true });
    }
    dre.push({ id: "lucro-liquido", nome: "Lucro líquido", grupo: "subtotal", valores: lucroSemRegime, pctReceita: pctDe(lucroSemRegime) });
    series["lucro_liquido"] = lucroSemRegime;
    // O FC indireto parte do ÚLTIMO subtotal: sem isto, a provisão lançada como
    // conta sairia do resultado mas não do caixa — e o balanço não fecharia.
    resultadoCorrente = lucroSemRegime;
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
    if (b === "folha") {
      // Base FOLHA = a linha canônica "Despesas com Pessoas" PROJETADA (premissa
      // da linha + bloco Pessoas, que soma nela desde a v90) — a mesma régua dos
      // dias implícitos do histórico. O bloco vazio zerava a base ("Obrigações
      // Trabalhistas" por prazo médio calculava R$ 0 mesmo com folha projetada,
      // 2026-07-16). Sem a linha canônica, cai no total do bloco Pessoas.
      const normN = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
      const linhaPessoas = linhasDespesas.find((l) => normN(l.nome) === "despesas com pessoas");
      if (linhaPessoas && Object.values(linhaPessoas.valores).some((v) => v > 0)) return linhaPessoas.valores;
      return series["folha_total"] ?? {};
    }
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
  // CONTAS ABAIXO DO EBITDA no FC/BP (07/08/2026): a D&A de CONTA é não-caixa
  // (volta no FCO e ACUMULA como redutora do ativo); a equivalência é receita
  // não-caixa (sai do FCO e acumula em Investimentos). Sem os dois lados, o
  // fechamento Ativo = Passivo + PL quebraria na primeira conta declarada.
  let depContasAcum = 0;
  let equivAcum = 0;
  const depContasAcumS: Serie = {};
  const equivAcumS: Serie = {};
  const difMax = { v: 0, mes: "" };
  const caixaMin = { v: Number.POSITIVE_INFINITY, mes: "" };
  for (let i = 0; i < meses.length; i++) {
    const mes = meses[i];
    const depr = (temCapex ? depreciacaoTotal[mes] ?? 0 : 0) + (temDepContas ? depContasDre[mes] ?? 0 : 0);
    const equivMes = temEquivContas ? equivContas[mes] ?? 0 : 0;
    depContasAcum += temDepContas ? depContasDre[mes] ?? 0 : 0;
    equivAcum += equivMes;
    depContasAcumS[mes] = depContasAcum;
    equivAcumS[mes] = equivAcum;
    const dNcg = temGiro ? series["delta_ncg"]?.[mes] ?? 0 : 0;
    fcoS[mes] = (resultadoFinal[mes] ?? 0) + depr - equivMes - dNcg + (deltaOutros[mes] ?? 0);
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
    const imob = (temCapex ? imobilizadoLiquido[mes] ?? 0 : 0) - depContasAcum + equivAcum;
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
    { id: "fc-resultado", nome: "Lucro Líquido do período", grupo: "subtotal", valores: resultadoFinal, pctReceita: pctDe(resultadoFinal) },
    ...(temCapex || temDepContas ? [{ id: "fc-depreciacao", nome: "(+) Depreciação e Amortização (não-caixa)", grupo: "receita" as const, valores: depExibida, pctReceita: pctDe(depExibida) }] : []),
    ...(temEquivContas ? [{ id: "fc-equivalencia", nome: "(−) Equivalência patrimonial (não-caixa)", grupo: "despesas" as const, valores: negativoDe(equivContas, meses), pctReceita: pctDe(equivContas) }] : []),
    ...(temGiro ? [{ id: "fc-ncg", nome: "(−) Variação do capital de giro (NCG)", grupo: "despesas" as const, valores: negativoDe(series["delta_ncg"], meses), pctReceita: pctDe(series["delta_ncg"]) }] : []),
    ...(itensCalc.length ? [{ id: "fc-outros", nome: "(±) Variação de outros itens do balanço", grupo: "despesas" as const, valores: deltaOutros, pctReceita: pctDe(deltaOutros) }] : []),
    { id: "fc-fco", nome: "Caixa das operações (FCO)", grupo: "subtotal", valores: fcoS, pctReceita: pctDe(fcoS) },
    ...(temCapex ? [
      { id: "fc-capex", nome: "(−) Aquisições de Imobilizado/Intangível (capex)", grupo: "despesas" as const, valores: fciS, pctReceita: pctDe(fciS) },
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
  // ESTRUTURA FIXA do modelo padrão do IBR (2026-07-16): as linhas-padrão
  // aparecem SEMPRE — bloco não configurado = ZERO na projeção, nunca omissão
  // (as colunas de realizado do IBR acompanham cada linha).
  // Depreciação acumulada EXIBIDA = capex + contas de D&A do orçamento.
  const deprAcumExibida: Serie = {};
  for (const m of meses) deprAcumExibida[m] = -((temCapex ? deprAcumS[m] ?? 0 : 0) + (depContasAcumS[m] ?? 0));
  const bp: LinhaDre[] = [
    { id: "bp-ativo", nome: "Ativo Total", grupo: "subtotal", valores: ativoS, pctReceita: pctDe(ativoS) },
    { id: "bp-ativo-circ", nome: "Ativo Circulante", grupo: "subtotal", valores: acS, pctReceita: pctDe(acS) },
    { id: "bp-caixa", nome: "Caixa e Equivalentes de Caixa", grupo: "receita", valores: caixaS, pctReceita: pctDe(caixaS) },
    { id: "bp-cr", nome: "Contas a Receber - CP", grupo: "receita", valores: temGiro ? series["contas_a_receber"] : zeroSerie, pctReceita: pctDe(temGiro ? series["contas_a_receber"] : zeroSerie) },
    { id: "bp-estoques", nome: "Estoques - CP", grupo: "receita", valores: temGiro ? series["estoques_giro"] : zeroSerie, pctReceita: pctDe(temGiro ? series["estoques_giro"] : zeroSerie) },
    ...linhasItens("ac"),
    { id: "bp-ativo-nc", nome: "Ativo Não Circulante", grupo: "subtotal", valores: ancS, pctReceita: pctDe(ancS) },
    // Segregação BP v3 (2026-07-16): BRUTO + redutora por natureza — a soma das
    // 4 linhas É o líquido do corkscrew (identidade garantida no waterfall).
    { id: "bp-imobilizado", nome: "Imobilizado", grupo: "receita", valores: temCapex ? brutoImobS : zeroSerie, pctReceita: pctDe(temCapex ? brutoImobS : zeroSerie) },
    // (-) Depreciação soma a acumulada do capex com a das CONTAS de D&A do
    // orçamento (ativos existentes não modelados — 07/08/2026).
    { id: "bp-depreciacao", nome: "(-) Depreciação", grupo: "receita", valores: deprAcumExibida, pctReceita: pctDe(deprAcumExibida) },
    { id: "bp-intangivel", nome: "Intangível", grupo: "receita", valores: temCapex ? brutoIntangS : zeroSerie, pctReceita: pctDe(temCapex ? brutoIntangS : zeroSerie) },
    { id: "bp-amortizacao", nome: "(-) Amortização", grupo: "receita", valores: temCapex ? negativoDe(amortAcumS, meses) : zeroSerie, pctReceita: pctDe(temCapex ? negativoDe(amortAcumS, meses) : zeroSerie) },
    ...(temEquivContas ? [{ id: "bp-investimentos", nome: "Investimentos", grupo: "receita" as const, valores: equivAcumS, pctReceita: pctDe(equivAcumS) }] : []),
    ...linhasItens("anc"),
    { id: "bp-passivo-pl", nome: "Passivo Total", grupo: "subtotal", valores: somaDe(passivoS, plS, meses), pctReceita: pctDe(ativoS) },
    { id: "bp-passivo-circ", nome: "Passivo Circulante", grupo: "subtotal", valores: pcS, pctReceita: pctDe(pcS) },
    { id: "bp-fornecedores", nome: "Fornecedores - CP", grupo: "despesas", valores: temGiro ? series["fornecedores_giro"] : zeroSerie, pctReceita: pctDe(temGiro ? series["fornecedores_giro"] : zeroSerie) },
    { id: "bp-divida-cp", nome: "Empréstimos e Financiamentos - CP", grupo: "despesas", valores: temDivida ? dividaCpTotal : zeroSerie, pctReceita: pctDe(temDivida ? dividaCpTotal : zeroSerie) },
    ...linhasItens("pc"),
    { id: "bp-passivo-nc", nome: "Passivo Não Circulante", grupo: "subtotal", valores: pncS, pctReceita: pctDe(pncS) },
    { id: "bp-divida-lp", nome: "Empréstimos e Financiamentos - LP", grupo: "despesas", valores: temDivida ? dividaLpTotal : zeroSerie, pctReceita: pctDe(temDivida ? dividaLpTotal : zeroSerie) },
    ...linhasItens("pnc"),
    { id: "bp-pl", nome: "Patrimônio Líquido", grupo: "subtotal", valores: plS, pctReceita: pctDe(plS) },
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

  return { motorVersao: MOTOR_VERSAO, meses, statusMes, series, dre, fc, bp, agregacoes: { anual }, linhasCalculadas, linhasFolhaSubstituidas, folhaPorCentro, kpis, checks, erros };
}
