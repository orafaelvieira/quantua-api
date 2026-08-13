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

import { limparNomeConta } from "./nome-conta";

const normalizar = (s: string): string =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

const RE_CNPJ = /\d{2}\.?\d{3}\.?\d{3}\/\d{4}-?\d{2}/;
const RE_CPF = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/;
/** CNPJ/CPF SEM pontuação — o contador digita dos dois jeitos (10/08/2026).
 *  Testado sobre o nome com pontuação removida. */
const RE_DOC_SEM_PONTO = /(?<!\d)(\d{14}|\d{11})(?!\d)/;
/** Sufixos societários — fortes indícios de razão social de terceiro. */
const RE_RAZAO_SOCIAL = /\b(ltda|eireli|epp|s\/a|s\.a\.?|cia\.?|companhia)\b|\bme\b(?![a-z])/i;

/**
 * IDENTIFICADOR DE TERCEIRO (13/08/2026 — a linha "4.03.02.01 PROCESSO
 * 000014.0316758/2020" da LACTOBOM, que o dono viu na fila).
 *
 * Número de processo judicial, de contrato e de conta bancária são dado
 * identificável tanto quanto CNPJ: dizem QUEM é a outra ponta. Ficam na mesma
 * classe do bloqueio duro. O detector antigo não via nada disso porque
 * "processo" está no vocabulário contábil e todo token numérico é descartado no
 * resíduo — o nome inteiro virava "nada suspeito".
 *
 * O teste roda sobre o nome SEM pontuação de separador mas COM os espaços: sem
 * os espaços, "Conta 1234 5678" viraria uma corrida de 8 dígitos e cairia como
 * falso positivo.
 */
const RE_PROCESSO_CNJ = /\b\d{5,7}[-.]\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/;
const RE_PROCESSO_SIMPLES = /\b\d{4,7}[.\-]\d{6,8}[\/.\-]\d{4}\b/;
const RE_NUMERO_LONGO = /(?<!\d)\d{8,}(?!\d)/;

/**
 * INICIAIS DE RAZÃO SOCIAL + NOME PRÓPRIO ("G Belusso Transportes",
 * "WG Armazéns", "J. Belusso").
 *
 * Este era o buraco do relato: o detector só decidia pelo CONTEXTO, e a fila
 * quase sempre entrega contexto pobre ("Ativo Circulante") porque o caminho do
 * documento só é gravado quando vem com ">". Fail-open — e o nome do cliente
 * ficava esperando um clique em "Aprovar" para ir ao dicionário de todos.
 *
 * A inicial é destruída em `residuoDeNomeProprio` (que joga fora token de 1
 * letra), então esta regra tokeniza por conta própria. O que separa "G Belusso"
 * de "IR Diferido" é a guarda da VOGAL: sigla contábil de 2 letras quase sempre
 * tem vogal (ir, cs, pl não… por isso a lista explícita também).
 */
const SIGLAS_CONTABEIS = new Set([
  "ir", "irpj", "irrf", "cs", "csll", "pis", "ipi", "iss", "icms", "inss", "fgts", "iof", "iptu", "ipva",
  "pl", "cp", "lp", "np", "ap", "ll", "dre", "bp", "dfc", "dmpl", "cdb", "lci", "lca", "fi", "fic",
  "rf", "rv", "cdi", "tr", "di", "in", "of", "to", "on", "at", "me", "epp", "sa", "cia", "mei",
  "ti", "rh", "epi", "vr", "va", "vt", "pat", "enc", "obrig", "deprec", "contrib", "adm", "op",
]);
/** Palavra que ANTECEDE uma letra e a transforma em rótulo de classe, não em sigla de empresa. */
const MARCADOR_CLASSE = new Set([
  "classe", "serie", "série", "tipo", "grupo", "nivel", "nível", "bloco", "lote",
  "ag", "agencia", "agência", "conta", "cc", "categoria", "coluna",
]);

/**
 * Grupos NOMINAIS — a folha é SEMPRE uma entidade nomeada (empresa/pessoa), então
 * o nome do terceiro é particular MESMO contendo palavra de setor ("Belagro
 * Transportes", "Paragominas Revendedora de Combustível"). Sem escape de
 * vocabulário. (Só não flagra quando a folha DESCREVE o grupo — ver abaixo.)
 */
const RE_GRUPO_NOMINAL =
  /pessoas? ligadas|partes? (ligadas|relacionadas)|coligad|controlad|interligad|m[uú]tuo|s[óo]cios?|acionistas?|cr[ée]dito de (s[óo]cio|acionista)|d[ée]bito de (s[óo]cio|acionista)/;

/** Grupos de CONTRAPARTE (clientes/fornecedores/…) — folha PODE ser sub-conta
 *  genérica ("Duplicatas a receber", "Clientes no exterior"). Aí vale o escape
 *  de vocabulário: só é particular quando o nome não tem termo contábil. */
const RE_GRUPO_CONTRAPARTE =
  /clientes|fornecedor|adiantament|duplicatas|contas a (receber|pagar)/;

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
  "transfer", "ajuste", "arredond", "diversos", "outros", "outras", "geral", "nacion", "exterior",
  "mercado interno", "mercado externo", "exportac", "importac", "numerario", "transito", "cheque",
  "cofre", "fundo fixo", "disponibilidade", "circulante", "realizavel", "exigivel", "compensac",
  "apurac", "encerrament", "abertura", "saldo", "deposito", "caucao", "garantia", "judicial",
  "restituic", "recuperac", "ressarcim", "reembols", "antecipac", "parcelament", "refis",
  // Palavras estruturais que sobravam no resíduo e faziam conta comum passar
  // por nome próprio (10/08/2026: "Duplicatas a RECEBER" era flagrada).
  "receber", "recebiment", "pagar", "pagament", "vencid", "vencer", "prazo", "curto", "longo",
  "vista", "haver", "credit", "debit", "matriz", "filial", "grupo", "subgrupo", "interno", "externo",
  "terceir", "coligad", "controlad", "ligad", "relacionad", "parte", "partes", "pessoa", "pessoas",
  // Estruturais que sobravam no resíduo e faziam conta de PLANO virar "nome
  // próprio" na bancada de 13/08/2026 ("Participações em Coligadas",
  // "Lucro Líquido Atribuível aos Acionistas Controladores", "Partes
  // Relacionadas - Ativo").
  "ativo", "passivo", "participac", "atribuiv", "minoritari", "majoritari", "investiment",
  "obrigac", "encargo", "contribuic", "mercadoria", "produto", "bens", "valores", "renda",
  "aquisic", "aumento", "futuro", "concedid", "recebid", "descontad", "carteira",
  "recolh", "compensar", "recuperar", "apropriar", "comercial", "societari", "permanente",
  "corrente", "conselho", "anuidade",
];

/** Conectivos e ruído que não contam como "nome próprio" no resíduo. */
const CONECTIVOS = new Set([
  "de", "da", "do", "das", "dos", "a", "ao", "aos", "as", "e", "em", "com", "para", "por", "no", "na",
  "nos", "nas", "sobre", "s", "c", "cc", "ref", "conta", "contas", "cta", "sr", "sra", "dr", "dra",
  // Qualificadores que sobravam e faziam conta de plano virar nome próprio
  // ("Lucro LÍQUIDO dos Acionistas da Controladora", "Participação dos NÃO
  // Controladores") — bancada de 13/08/2026.
  "nao", "total", "liquido", "liquida", "bruto", "bruta",
]);

/**
 * O que SOBRA do nome depois de tirar o termo do grupo, o vocabulário contábil,
 * conectivos, números e siglas de uma letra. Se sobra alguma coisa, essa coisa é
 * quase sempre um NOME PRÓPRIO — a razão social ou a pessoa.
 *
 * É o que separa "Mútuos" (nada sobra → conhecimento reutilizável, pode ir ao
 * global) de "Mútuos - João da Silva" (sobra "joao silva" → dado do cliente).
 */
export function residuoDeNomeProprio(nome: string): string[] {
  const n = normalizar(nome).replace(/[()\[\]{}.,;:/\-]/g, " ");
  return n.split(/\s+/).filter((t) => {
    if (!t || t.length < 2) return false;              // sigla de 1 letra ("G", "W")
    if (/^\d+$/.test(t)) return false;                 // número de conta/parcela
    if (CONECTIVOS.has(t)) return false;
    // Sigla contábil conhecida nunca é nome de gente. Sem isto o "- LP" de
    // "Créditos com Controladas - LP" era lido como razão social (13/08/2026).
    if (SIGLAS_CONTABEIS.has(t)) return false;
    if (RE_GRUPO_NOMINAL.test(t) || RE_GRUPO_CONTRAPARTE.test(t)) return false;
    return !VOCABULARIO_CONTABIL.some((v) => t.startsWith(v) || v.startsWith(t));
  });
}

/**
 * Acha o par (SIGLA, NomePróprio) — "G Belusso", "WG Armazéns", "J. Belusso".
 * Devolve o trecho encontrado, ou null.
 */
export function iniciaisDeRazaoSocial(nome: string): string | null {
  // Tokeniza por ESPAÇO, guardando a pontuação: ela é o sinal que separa
  // "G Belusso" (sigla + nome) de "(CRC, CREA, OAB)" (enumeração de conselhos —
  // falso positivo pego na bancada de 13/08/2026). Vírgula depois da sigla = lista.
  const brutos = nome.split(/\s+/).filter(Boolean);
  const tokens = brutos.map((t) => t.replace(/^[(\[{]+/, "").replace(/[)\]}:;]+$/, ""));
  for (let i = 0; i < tokens.length - 1; i++) {
    if (/,$/.test(tokens[i])) continue;                    // "CRC, CREA" é enumeração
    const bruto = tokens[i].replace(/\.$/, "");
    if (!/^[A-ZÀ-Þ]{1,3}$/.test(bruto)) continue;
    const sigla = normalizar(bruto);
    if (CONECTIVOS.has(sigla) || SIGLAS_CONTABEIS.has(sigla)) continue;
    // Sigla de 2+ letras COM vogal é quase sempre palavra/sigla contábil ("IR",
    // "OF"); sem vogal ("WG", "JK") ou de 1 letra é iniciais de empresa.
    if (sigla.length > 1 && /[aeiouy]/.test(sigla)) continue;
    // "Ações Classe B Preferenciais": a letra é rótulo, não empresa.
    if (i > 0 && MARCADOR_CLASSE.has(normalizar(tokens[i - 1].replace(/\.$/, "")))) continue;
    const seguinte = tokens[i + 1].replace(/[.,;]$/, "");
    if (!/^[A-ZÀ-Þ][A-Za-zÀ-ÿ'´`-]{2,}$/.test(seguinte)) continue;
    const s = normalizar(seguinte);
    if (CONECTIVOS.has(s) || SIGLAS_CONTABEIS.has(s)) continue;
    if (residuoDeNomeProprio(seguinte).length === 0) continue;  // "G Caixa" não é empresa
    return `${bruto} ${seguinte}`;
  }
  return null;
}

/**
 * O que vem DEPOIS do separador ("Adiantamento de estoque — WG Armazéns" →
 * "WG Armazéns"). É onde o contador pendura a contraparte; o começo do rótulo é
 * a natureza contábil e o fim é de quem se trata.
 */
function caudaDoSeparador(nome: string): string | null {
  const partes = nome.split(/\s+[-–—]\s+|\s+\/\s+/);
  if (partes.length < 2) return null;
  const cauda = partes[partes.length - 1].trim();
  if (!cauda) return null;
  // MARCADOR DE PRAZO/SEÇÃO NÃO É TERCEIRO (bancada de 13/08/2026): "Créditos
  // com Controladas - LP", "Débitos com Partes Relacionadas - CP",
  // "Adiantamento para Aumento de Capital - PL", "Partes Relacionadas - Ativo"
  // são nomes de PLANO DE CONTAS e caíam todos como nome de cliente. O que vem
  // depois do traço só é gente se PARECER gente: 3+ letras e fora do
  // vocabulário contábil e das siglas.
  const residuo = residuoDeNomeProprio(cauda).filter((t) => t.length >= 3 && !SIGLAS_CONTABEIS.has(t));
  return residuo.length > 0 ? cauda : null;
}

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
  // O CÓDIGO DO PLANO SAI ANTES DE QUALQUER REGRA (13/08/2026). Sem isto,
  // "1.1.1.01.0001 Caixa Geral" viraria "identificador de terceiro" pela regra
  // do número longo — o código da própria empresa acusando terceiro que não
  // existe. Ver [nome-conta.ts].
  const limpo = limparNomeConta(nome);
  const n = normalizar(limpo);
  if (!n) return { particular: false, bloqueioDuro: false, motivo: null };

  if (RE_CNPJ.test(limpo) || RE_CPF.test(limpo) || RE_DOC_SEM_PONTO.test(limpo.replace(/[.\-\/]/g, ""))) {
    return { particular: true, bloqueioDuro: true, motivo: "contém CNPJ/CPF — dado identificável de terceiro (LGPD)" };
  }
  const semSeparador = limpo.replace(/[.\-\/]/g, "");
  if (RE_PROCESSO_CNJ.test(limpo) || RE_PROCESSO_SIMPLES.test(limpo) || RE_NUMERO_LONGO.test(semSeparador)) {
    return { particular: true, bloqueioDuro: true, motivo: "identificador de terceiro no nome (processo, contrato ou conta) — dado identificável (LGPD)" };
  }
  if (RE_RAZAO_SOCIAL.test(n)) {
    return { particular: true, bloqueioDuro: false, motivo: "sufixo de razão social (LTDA/S.A./EIRELI/ME…) — nome de terceiro" };
  }
  const iniciais = iniciaisDeRazaoSocial(limpo);
  if (iniciais) {
    return { particular: true, bloqueioDuro: false, motivo: `iniciais de razão social junto a nome próprio ("${iniciais}") — nome de terceiro` };
  }
  const ctx = normalizar(contexto ?? "");

  // Grupo NOMINAL (partes ligadas/sócios/mútuo/coligadas): a folha é uma
  // entidade nomeada — particular, salvo quando o próprio nome DESCREVE o grupo
  // ("Adiantamento a coligadas") ou é um balde genérico ("Outros", "Diversos").
  if (RE_GRUPO_NOMINAL.test(ctx)) {
    // ATENÇÃO (10/08/2026 — a garantia do dono): "descreve o grupo" é o nome
    // que SÓ tem o termo do grupo ("Mútuos", "Empréstimos a sócios"). A régua
    // antiga aceitava QUALQUER nome que CONTIVESSE o termo — e "Mútuos - João
    // da Silva" ia direto para o dicionário global, que é exatamente o caso
    // que o dono citou. O que decide é o RESÍDUO.
    const generico = /^(outr[oa]s|diversos|geral|total|conta transit)/.test(n);
    const nomeDescreveGrupo = generico || (RE_GRUPO_NOMINAL.test(n) && residuoDeNomeProprio(n).length === 0);
    if (!nomeDescreveGrupo) {
      return {
        particular: true,
        bloqueioDuro: false,
        motivo: "nome de entidade em grupo de partes ligadas/sócios/mútuo — específico desta empresa",
      };
    }
  }

  // Grupo de CONTRAPARTE (clientes/fornecedores): particular só se o nome não
  // tiver termo contábil genérico (aí é nome próprio, não sub-conta).
  if (RE_GRUPO_CONTRAPARTE.test(ctx)) {
    // O escape de vocabulário era um OR sobre o nome inteiro: UMA palavra
    // contábil livrava o nome próprio ("Adiantamento de estoque - WG
    // Armazéns" passava). Agora vale o RESÍDUO: sobrou nome, é particular.
    if (residuoDeNomeProprio(n).length > 0) {
      return {
        particular: true,
        bloqueioDuro: false,
        motivo: "nome próprio em grupo de clientes/fornecedores — específico desta empresa",
      };
    }
  }

  // O MESMO SINAL, LIDO NO PRÓPRIO NOME (13/08/2026). O ramo acima só olha o
  // CONTEXTO, e a fila entrega contexto pobre na maioria das linhas — era por
  // isso que "Adiantamento de estoque - WG Armazéns" ficava esperando um clique
  // em Aprovar. Aqui a leitura é restrita à CAUDA do separador: o começo do
  // rótulo é a natureza contábil ("Adiantamento de estoque"), o fim é de quem
  // se trata. Sobre o nome inteiro esta regra dava 25 falsos positivos em 1.393
  // nomes reais; sobre a cauda, zero.
  if (RE_GRUPO_CONTRAPARTE.test(n) || RE_GRUPO_NOMINAL.test(n)) {
    const cauda = caudaDoSeparador(limpo);
    if (cauda) {
      return {
        particular: true,
        bloqueioDuro: false,
        motivo: `nome de terceiro depois do separador ("${cauda}") em conta de cliente/fornecedor/mútuo`,
      };
    }
  }
  // SEM CONTEXTO o detector era cego (fail-open). Mas há um sinal que basta
  // pelo próprio nome: termo de parte ligada/mútuo/sócio GRUDADO num nome
  // próprio — "Mútuos - João da Silva", "Empréstimo sócio Pedro". O grupo do
  // documento nem sempre chega até aqui; a garantia não pode depender disso.
  if (RE_GRUPO_NOMINAL.test(n) && residuoDeNomeProprio(n).length > 0) {
    return {
      particular: true,
      bloqueioDuro: false,
      motivo: "nome de terceiro junto ao termo de mútuo/sócio/parte ligada — específico desta empresa",
    };
  }
  return { particular: false, bloqueioDuro: false, motivo: null };
}

/** Último nível do caminho ("A > B > C" → "C") — o GRUPO imediato da folha. */
export function grupoImediatoDoCaminho(caminho: string | null | undefined): string | null {
  if (!caminho) return null;
  const partes = caminho.split(">").map((p) => p.trim()).filter(Boolean);
  return partes.length >= 2 ? partes[partes.length - 1] : null;
}
