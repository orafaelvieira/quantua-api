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

const FOLHA: ContaPadrao = { nome: "Salários e encargos", tipo: "despesa", destino: "Despesas com Pessoas" };

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
      { nome: "Salários e encargos (operação)", tipo: "custo", destino: "Custos com Pessoas (MOD)" },
      { nome: "Materiais de consumo", tipo: "custo" },
      { nome: "Manutenção de máquinas e instalações", tipo: "custo" },
      { nome: "Energia (produção)", tipo: "custo" },
      { nome: "Fretes e logística", tipo: "custo" },
    ],
  },
];

/** Nome da unidade criada quando a empresa ainda não tem nenhuma. */
export const UNIDADE_PADRAO = "Matriz";

/** O esqueleto no formato da importação de plano de contas — um caminho só de
 *  criação de conta (mesmo dedupe, mesma lotação, mesma trilha). */
export function contasDoEsqueleto(centros: CentroPadrao[] = CENTROS_PADRAO): Array<{
  nome: string; tipo: string; centroCusto: string; destino: string;
}> {
  return centros.flatMap((cc) =>
    cc.contas.map((c) => ({ nome: c.nome, tipo: c.tipo, centroCusto: cc.nome, destino: c.destino ?? "" })),
  );
}
