/**
 * DETECTOR DE CONTA PARTICULAR (2026-07-18) — proteção LGPD do dicionário GLOBAL.
 *
 * Contas de mútuo/partes ligadas/clientes/fornecedores carregam NOMES DE
 * TERCEIROS (razão social, pessoa física) que são informação comercial da
 * empresa de origem — promover ao dicionário global exporia esses nomes a
 * TODOS os clientes da plataforma. O conhecimento reutilizável nesses casos é
 * o GRUPO onde a conta está ("EMPRÉSTIMOS A PESSOAS LIGADAS" → destino), nunca
 * o nome da folha.
 *
 * Determinístico, zero IA. Três sinais, do mais duro ao mais contextual:
 *  1. CNPJ/CPF no nome → particular e BLOQUEIO DURO (nunca vai ao global);
 *  2. sufixo de razão social (LTDA, S.A., EIRELI, ME, EPP…) → particular;
 *  3. grupo de CONTRAPARTE no caminho do documento (mútuos, partes ligadas,
 *     clientes, fornecedores, adiantamentos…) + nome SEM nenhum termo do
 *     vocabulário contábil genérico → nome próprio → particular.
 */

const normalizar = (s: string): string =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

const RE_CNPJ = /\d{2}\.?\d{3}\.?\d{3}\/\d{4}-?\d{2}/;
const RE_CPF = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/;
/** Sufixos societários — fortes indícios de razão social de terceiro. */
const RE_RAZAO_SOCIAL = /\b(ltda|eireli|epp|s\/a|s\.a\.?|cia\.?|companhia)\b|\bme\b(?![a-z])/i;

/** Grupos de CONTRAPARTE — onde folha costuma ser nome de terceiro. */
const RE_GRUPO_CONTRAPARTE =
  /mutuo|m[uú]tuo|pessoas? ligadas|partes? (ligadas|relacionadas)|coligad|controlad|interligad|clientes|fornecedor|adiantament|duplicatas|contas a (receber|pagar)|emprestimos a|credito de (socio|acionista)|debito de (socio|acionista)|socios|acionistas/;

/** Vocabulário contábil genérico — se o nome contém ALGUM destes, não é nome próprio. */
const VOCABULARIO_CONTABIL = [
  "caixa", "banco", "aplicac", "poupanca", "estoque", "almoxarifado", "imposto", "tribut",
  "icms", "ipi", "iss", "isqn", "pis", "cofins", "csll", "irpj", "irrf", "inss", "fgts", "simples",
  "receita", "venda", "revenda", "servic", "despes", "custo", "gasto", "salario", "folha", "prolabore", "pro-labore",
  "energia", "agua", "aluguel", "aluguéis", "arrendament", "deprecia", "amortiza", "exaustao", "provis",
  "juros", "multa", "desconto", "abatiment", "frete", "carreto", "seguro", "manutenc", "conservac",
  "marketing", "publicid", "propaganda", "viagem", "viagens", "telefon", "celular", "internet", "software",
  "licenc", "consultor", "assessor", "honorar", "contabil", "juridic", "advocat", "cartor", "taxa", "tarifa",
  "emprestimo", "financiament", "leasing", "duplicata", "titulo", "adiantament", "fornecedor", "cliente",
  "funcionario", "empregado", "colaborador", "diretor", "socio", "acionista", "capital", "reserva",
  "lucro", "prejuizo", "resultado", "dividendo", "jcp", "patrimonio", "imobilizado", "intangivel",
  "veiculo", "maquina", "equipament", "movei", "imovei", "imovel", "terreno", "edificac", "obra", "benfeitoria",
  "instalac", "computador", "hardware", "marca", "patente", "cambial", "cambio", "variac", "rendiment",
  "ganho", "perda", "doacao", "brinde", "uniforme", "epi", "treinament", "vale", "transporte",
  "refeic", "alimentac", "cesta", "combustive", "lubrificant", "pedagio", "estacionament", "correio",
  "material", "escritorio", "expedient", "limpeza", "higiene", "copa", "cozinha", "condominio",
  "iptu", "ipva", "licenciament", "sindic", "associac", "conselho", "anuidade", "assinatura",
  "jornal", "revista", "curso", "palestra", "feira", "evento", "congresso", "comiss", "bonus", "bonificac",
  "gratificac", "ferias", "decimo", "13o", "rescis", "indeniz", "acordo", "processo", "contingen",
  "transfer", "ajuste", "arredond", "diversos", "outros", "outras", "geral", "nacional", "exterior",
  "mercado interno", "mercado externo", "exportac", "importac", "numerario", "transito", "cheque",
  "cofre", "fundo fixo", "disponibilidade", "circulante", "realizavel", "exigivel", "compensac",
  "apurac", "encerrament", "abertura", "saldo", "deposito", "caucao", "garantia", "judicial",
  "restituic", "recuperac", "ressarcim", "reembols", "antecipac", "parcelament", "refis",
];

export interface AvaliacaoParticular {
  particular: boolean;
  /** true = NUNCA pode ir ao global (CNPJ/CPF no nome) — sem override. */
  bloqueioDuro: boolean;
  motivo: string | null;
}

/**
 * @param nome     nome da conta como está no documento
 * @param contexto grupo/caminho da conta no documento (quanto mais completo, melhor)
 */
export function avaliarContaParticular(nome: string, contexto?: string | null): AvaliacaoParticular {
  const n = normalizar(nome);
  if (!n) return { particular: false, bloqueioDuro: false, motivo: null };

  if (RE_CNPJ.test(nome) || RE_CPF.test(nome)) {
    return { particular: true, bloqueioDuro: true, motivo: "contém CNPJ/CPF — dado identificável de terceiro (LGPD)" };
  }
  if (RE_RAZAO_SOCIAL.test(n)) {
    return { particular: true, bloqueioDuro: false, motivo: "sufixo de razão social (LTDA/S.A./EIRELI/ME…) — nome de terceiro" };
  }
  const ctx = normalizar(contexto ?? "");
  if (RE_GRUPO_CONTRAPARTE.test(ctx)) {
    const temVocabulario = VOCABULARIO_CONTABIL.some((t) => n.includes(t));
    if (!temVocabulario) {
      return {
        particular: true,
        bloqueioDuro: false,
        motivo: "nome próprio em grupo de contraparte (mútuo/partes ligadas/clientes/fornecedores) — específico desta empresa",
      };
    }
  }
  return { particular: false, bloqueioDuro: false, motivo: null };
}

/** Último nível do caminho ("A > B > C" → "C") — o GRUPO imediato da folha. */
export function grupoImediatoDoCaminho(caminho: string | null | undefined): string | null {
  if (!caminho) return null;
  const partes = caminho.split(">").map((p) => p.trim()).filter(Boolean);
  return partes.length >= 2 ? partes[partes.length - 1] : null;
}
