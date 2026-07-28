/**
 * ESQUELETO DO ORÇAMENTO (27/07/2026) — "não ter que começar do zero".
 *
 * Um orçamento novo abria com duas linhas agregadas ("Custos sobre a receita",
 * "Despesas operacionais") e nenhum centro de custo: o analista tinha que
 * digitar a estrutura inteira antes de orçar o primeiro real.
 *
 * Aqui mora o esqueleto que a maioria das empresas reconhece — centros de custo
 * das áreas e as contas mais comuns de cada uma. É PONTO DE PARTIDA, não regra:
 * nada aqui é obrigatório, o analista apaga o que não usa e cria o que falta. E
 * nada substitui o que já existe (a criação passa pelo mesmo dedupe da
 * importação de plano de contas).
 *
 * Contas de FOLHA aparecem como conta orçável simples porque muita empresa orça
 * "salários e encargos" como uma linha só; quem quer headcount por posição usa
 * a aba Pessoas, que soma na mesma conta canônica.
 */

export interface ContaPadrao { nome: string; tipo: "custo" | "despesa"; destino?: string }
export interface CentroPadrao { nome: string; contas: ContaPadrao[] }

/** A conta de FOLHA de cada área nasce com o nome do centro de custo entre
 *  parênteses — "Salários e encargos (Comercial)". Sem isso, sete contas com o
 *  mesmo nome conviviam na grade e só o lugar dizia de quem era cada uma
 *  (28/07/2026). O sufixo é aplicado em contasDoEsqueleto, com o nome REAL do
 *  CC da empresa (que pode ser "RH" em vez de "Recursos Humanos"). */
export const CONTA_FOLHA = "Salários e encargos";
const FOLHA: ContaPadrao = { nome: CONTA_FOLHA, tipo: "despesa", destino: "Despesas com Pessoas" };

export const CENTROS_PADRAO: CentroPadrao[] = [
  {
    nome: "Comercial",
    contas: [
      FOLHA,
      { nome: "Comissões sobre vendas", tipo: "despesa" },
      { nome: "Viagens e hospedagem", tipo: "despesa" },
      { nome: "Fretes sobre vendas", tipo: "despesa" },
      { nome: "Brindes e amostras", tipo: "despesa" },
    ],
  },
  {
    nome: "Marketing",
    contas: [
      { nome: "Publicidade e propaganda", tipo: "despesa" },
      { nome: "Marketing digital (mídia paga)", tipo: "despesa" },
      { nome: "Agência e produção de conteúdo", tipo: "despesa" },
      { nome: "Feiras e eventos", tipo: "despesa" },
    ],
  },
  {
    nome: "Administrativo",
    contas: [
      FOLHA,
      { nome: "Aluguel, condomínio e IPTU", tipo: "despesa" },
      { nome: "Energia elétrica", tipo: "despesa" },
      { nome: "Água e esgoto", tipo: "despesa" },
      { nome: "Telefonia e internet", tipo: "despesa" },
      { nome: "Material de escritório e copa", tipo: "despesa" },
      { nome: "Seguros", tipo: "despesa" },
      { nome: "Honorários contábeis e jurídicos", tipo: "despesa" },
      { nome: "Veículos (combustível e manutenção)", tipo: "despesa" },
    ],
  },
  {
    nome: "Financeiro",
    contas: [
      FOLHA,
      { nome: "Tarifas bancárias", tipo: "despesa" },
      { nome: "Despesas com cobrança", tipo: "despesa" },
      { nome: "Taxas de cartão e meios de pagamento", tipo: "despesa" },
    ],
  },
  {
    nome: "Recursos Humanos",
    contas: [
      FOLHA,
      { nome: "Benefícios (VT, VR e saúde)", tipo: "despesa", destino: "Despesas com Pessoas" },
      { nome: "Treinamento e desenvolvimento", tipo: "despesa" },
      { nome: "Recrutamento e seleção", tipo: "despesa" },
      { nome: "Medicina e segurança do trabalho", tipo: "despesa" },
    ],
  },
  {
    nome: "TI",
    contas: [
      { nome: "Licenças e assinaturas de software", tipo: "despesa" },
      { nome: "Serviços de TI e suporte", tipo: "despesa" },
      { nome: "Infraestrutura e nuvem", tipo: "despesa" },
      { nome: "Equipamentos e manutenção", tipo: "despesa" },
    ],
  },
  {
    nome: "Operações",
    contas: [
      // Folha da operação é CUSTO (mão de obra direta), não despesa.
      { nome: CONTA_FOLHA, tipo: "custo", destino: "Custos com Pessoas (MOD)" },
      { nome: "Materiais de consumo", tipo: "custo" },
      { nome: "Manutenção de máquinas e instalações", tipo: "custo" },
      { nome: "Energia (produção)", tipo: "custo" },
      { nome: "Fretes e logística", tipo: "custo" },
    ],
  },
];

/** Nome da unidade criada quando a empresa ainda não tem nenhuma. */
export const UNIDADE_PADRAO = "Matriz";

/** APELIDOS DE CENTRO DE CUSTO (27/07/2026): a empresa que já cadastrou "RH" ou
 *  "TI" não pode ganhar um "Recursos Humanos" duplicado do lado — as contas do
 *  esqueleto precisam cair NO CC que ela já tem. Chave = nome do catálogo;
 *  valores = como a casa costuma escrever. */
const APELIDOS: Record<string, string[]> = {
  "Comercial": ["comercial", "vendas", "area comercial", "departamento comercial"],
  "Marketing": ["marketing", "mkt", "comunicacao e marketing"],
  "Administrativo": ["administrativo", "adm", "administracao", "administrativo e geral", "geral"],
  "Financeiro": ["financeiro", "financas", "controladoria e financeiro"],
  "Recursos Humanos": ["recursos humanos", "rh", "gente e gestao", "pessoas", "dp", "departamento pessoal"],
  "TI": ["ti", "tecnologia", "tecnologia da informacao", "informatica", "sistemas"],
  "Operações": ["operacoes", "operacional", "producao", "industrial", "logistica e operacoes"],
};

/** Normalização (sem acento/caixa/pontuação) — a mesma régua de nome de conta. */
function norm(s: string): string {
  return (s || "").normalize("NFD").replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Acha, entre os CCs QUE A EMPRESA JÁ TEM, o equivalente a um do catálogo. */
export function centroEquivalente(nomeCatalogo: string, existentes: string[]): string | null {
  const alvos = new Set([norm(nomeCatalogo), ...(APELIDOS[nomeCatalogo] ?? []).map(norm)]);
  return existentes.find((e) => alvos.has(norm(e))) ?? null;
}

/** O esqueleto no formato da importação de plano de contas — um caminho só de
 *  criação de conta (mesmo dedupe, mesma lotação, mesma trilha).
 *
 *  `centrosDaEmpresa`: os CCs que existem hoje. Quando um deles equivale a um
 *  do catálogo (RH ≡ Recursos Humanos), as contas apontam para o NOME REAL —
 *  senão o importador não acharia o CC e jogaria tudo em "não atribuído". */
export function contasDoEsqueleto(
  centrosDaEmpresa: string[] = [],
  centros: CentroPadrao[] = CENTROS_PADRAO,
): Array<{ nome: string; tipo: string; centroCusto: string; destino: string }> {
  return centros.flatMap((cc) => {
    const alvo = centroEquivalente(cc.nome, centrosDaEmpresa) ?? cc.nome;
    return cc.contas.map((c) => ({
      // Folha leva o nome do CC no rótulo: "Salários e encargos (Comercial)".
      nome: c.nome === CONTA_FOLHA ? `${CONTA_FOLHA} (${alvo})` : c.nome,
      tipo: c.tipo, centroCusto: alvo, destino: c.destino ?? "",
    }));
  });
}
