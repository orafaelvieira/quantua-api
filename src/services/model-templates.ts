/**
 * Templates de LINHA DE RECEITA do Modelo Financeiro (B1 do plano).
 *
 * Cada template entrega a árvore de drivers pré-montada NA LINGUAGEM DO SETOR
 * ("taxa de ocupação", não "nó de taxa") — o analista ajusta números, não monta grafo.
 * IDs de nó usam _ (nunca hífen: o parser de fórmulas trata "-" como subtração).
 */
import { LinhaReceita, DriverNode } from "./model-engine";

export interface TemplateReceita {
  id: string;
  nome: string;
  /** Descrição leiga mostrada no card do wizard. */
  descricao: string;
  /** Setores B3 onde o template é o default sugerido (informativo). */
  exemplos: string;
}

export const TEMPLATES_RECEITA: TemplateReceita[] = [
  { id: "generico", nome: "Crescimento sobre o histórico", descricao: "A receita parte do que a empresa já fatura e cresce por um percentual ao ano. O jeito mais simples de começar.", exemplos: "Qualquer empresa" },
  { id: "personalizada", nome: "Personalizada (multiplicação de variáveis)", descricao: "Monte a receita multiplicando as variáveis que você definir — duas, três ou quantas precisar, cada uma com seu tipo de dado (R$, %, quantidade…). Ex.: quartos × ocupação × receita média por quarto.", exemplos: "Qualquer negócio" },
  { id: "saas", nome: "Assinaturas / recorrência", descricao: "Base de clientes que entra e sai todo mês (novos e cancelamentos) multiplicada pelo valor pago por cliente.", exemplos: "Software, clubes de assinatura, academias" },
  { id: "transacional", nome: "Volume × quantidade", descricao: "Quantidade vendida/transacionada multiplicada pelo valor de cada unidade. Para volume financeiro × percentual da empresa (comissão/spread), use a Personalizada.", exemplos: "Comércio, indústria, serviços por unidade" },
  { id: "capacidade", nome: "Capacidade × ocupação", descricao: "Quantos lugares existem, quantos ficam ocupados e quanto rende cada um.", exemplos: "Clínicas, hotéis, escolas com vagas, restaurantes" },
  { id: "servicos", nome: "Horas de serviço", descricao: "Profissionais × horas que conseguem faturar × valor da hora.", exemplos: "Consultorias, escritórios, agências" },
  { id: "varejo", nome: "Fluxo × conversão × ticket", descricao: "Quantas pessoas passam, quantas compram e quanto gastam.", exemplos: "Lojas, e-commerce" },
];

function no(parcial: Omit<DriverNode, "params"> & { params?: Record<string, unknown> }): DriverNode {
  return { params: {}, ...parcial };
}

/**
 * Monta a linha de receita de um template. `seed` traz âncoras do histórico
 * (receita mensal, crescimento) quando o seed determinístico rodou.
 */
export function montarLinhaReceita(
  template: string,
  linhaId: string,
  nome: string,
  seed?: { receitaMensal?: number; crescimentoAnual?: number }
): LinhaReceita {
  const p = (sufixo: string) => `${linhaId}_${sufixo}`;
  const receitaMensal = seed?.receitaMensal ?? 0;
  const cresc = seed?.crescimentoAnual ?? 0.1;

  switch (template) {
    case "saas": {
      // base inicial estimada: receita ÷ ARPU chutado (ajustável na tela)
      const arpu = 300;
      const baseInicial = receitaMensal > 0 ? Math.round(receitaMensal / arpu) : 100;
      return {
        id: linhaId, nome, template, nodeRaiz: p("receita"),
        nodes: [
          no({ id: p("novos"), tipo: "serie", nome: "Novos clientes por mês", unidade: "#", papel: "novos", params: { valorMensal: Math.max(1, Math.round(baseInicial * 0.05)) } }),
          no({ id: p("churn"), tipo: "taxa", nome: "Cancelamento mensal (churn)", unidade: "%", papel: "churnRate", params: { valorMensal: 0.02 } }),
          no({ id: p("cancelados"), tipo: "fluxo", nome: "Clientes que saem", unidade: "#", params: { expr: `${p("clientes")} * ${p("churn")}` } }),
          no({ id: p("clientes"), tipo: "estoque", nome: "Base de clientes", unidade: "#", papel: "baseClientes", params: { saldoInicial: baseInicial, entradasRef: p("novos"), saidasRef: p("cancelados") } }),
          no({ id: p("arpu"), tipo: "preco", nome: "Valor médio por cliente/mês", unidade: "R$/un", papel: "arpu", params: { valorMensal: arpu } }),
          no({ id: p("receita"), tipo: "formula", nome: `Memória de Cálculo — ${nome}`, unidade: "R$", params: { expr: `${p("clientes")} * ${p("arpu")}` } }),
        ],
      };
    }
    case "transacional": {
      const valorUnitario = 100;
      const quantidade = receitaMensal > 0 ? Math.round(receitaMensal / valorUnitario) : 1_000;
      return {
        id: linhaId, nome, template, nodeRaiz: p("receita"),
        nodes: [
          no({ id: p("quantidade"), tipo: "serie", nome: "Quantidade por mês", unidade: "#", papel: "quantidade", params: { valorMensal: quantidade, crescimentoAnual: cresc } }),
          no({ id: p("valorUnit"), tipo: "preco", nome: "Valor por unidade", unidade: "R$/un", params: { valorMensal: valorUnitario } }),
          no({ id: p("receita"), tipo: "formula", nome: `Memória de Cálculo — ${nome}`, unidade: "R$", params: { expr: `${p("quantidade")} * ${p("valorUnit")}` } }),
        ],
      };
    }
    case "personalizada": {
      // Duas variáveis de partida; a tela permite adicionar/remover quantas precisar
      // (a fórmula da receita é o produto de todas — a análise dimensional confere).
      return {
        id: linhaId, nome, template, nodeRaiz: p("receita"),
        nodes: [
          no({ id: p("f1"), tipo: "serie", nome: "Quantidade", unidade: "#", params: { valorMensal: 0 } }),
          no({ id: p("f2"), tipo: "serie", nome: "Valor por unidade", unidade: "R$/un", params: { valorMensal: 0 } }),
          no({ id: p("receita"), tipo: "formula", nome: `Memória de Cálculo — ${nome}`, unidade: "R$", params: { expr: `${p("f1")} * ${p("f2")}` } }),
        ],
      };
    }
    case "capacidade": {
      const ticket = 300;
      const capacidade = receitaMensal > 0 ? Math.round(receitaMensal / (ticket * 0.7)) : 900;
      return {
        id: linhaId, nome, template, nodeRaiz: p("receita"),
        nodes: [
          no({ id: p("capacidade"), tipo: "capacidade", nome: "Lugares disponíveis no mês", unidade: "#", papel: "capacidade", params: { valorMensal: capacidade } }),
          no({ id: p("ocupacao"), tipo: "taxa", nome: "Taxa de ocupação", unidade: "%", papel: "ocupacao", params: { valorMensal: 0.7, max: 1 } }),
          no({ id: p("ticket"), tipo: "preco", nome: "Valor por lugar ocupado", unidade: "R$/un", params: { valorMensal: ticket } }),
          no({ id: p("receita"), tipo: "formula", nome: `Memória de Cálculo — ${nome}`, unidade: "R$", params: { expr: `${p("capacidade")} * ${p("ocupacao")} * ${p("ticket")}` } }),
        ],
      };
    }
    case "servicos": {
      const valorHora = 250;
      const horasMes = 160;
      const util = 0.65;
      const profissionais = receitaMensal > 0 ? Math.max(1, Math.round(receitaMensal / (valorHora * horasMes * util))) : 5;
      return {
        id: linhaId, nome, template, nodeRaiz: p("receita"),
        nodes: [
          no({ id: p("profissionais"), tipo: "capacidade", nome: "Profissionais que faturam", unidade: "#", params: { valorMensal: profissionais } }),
          no({ id: p("horas"), tipo: "serie", nome: "Horas disponíveis por profissional", unidade: "#/un", params: { valorMensal: horasMes } }),
          no({ id: p("utilizacao"), tipo: "taxa", nome: "Taxa de utilização (horas vendidas)", unidade: "%", papel: "ocupacao", params: { valorMensal: util, max: 1 } }),
          no({ id: p("valorHora"), tipo: "preco", nome: "Valor da hora", unidade: "R$/un", params: { valorMensal: valorHora } }),
          no({ id: p("receita"), tipo: "formula", nome: `Memória de Cálculo — ${nome}`, unidade: "R$", params: { expr: `${p("profissionais")} * ${p("horas")} * ${p("utilizacao")} * ${p("valorHora")}` } }),
        ],
      };
    }
    case "varejo": {
      const ticket = 120;
      const conversao = 0.25;
      const fluxo = receitaMensal > 0 ? Math.round(receitaMensal / (ticket * conversao)) : 5_000;
      return {
        id: linhaId, nome, template, nodeRaiz: p("receita"),
        nodes: [
          no({ id: p("fluxo"), tipo: "serie", nome: "Visitantes por mês", unidade: "#", params: { valorMensal: fluxo, crescimentoAnual: cresc } }),
          no({ id: p("conversao"), tipo: "taxa", nome: "Taxa de conversão (quem compra)", unidade: "%", params: { valorMensal: conversao, max: 1 } }),
          no({ id: p("ticket"), tipo: "preco", nome: "Gasto médio por compra", unidade: "R$/un", params: { valorMensal: ticket } }),
          no({ id: p("receita"), tipo: "formula", nome: `Memória de Cálculo — ${nome}`, unidade: "R$", params: { expr: `${p("fluxo")} * ${p("conversao")} * ${p("ticket")}` } }),
        ],
      };
    }
    default: {
      // generico: receita mensal do histórico crescendo por % ao ano
      return {
        id: linhaId, nome, template: "generico", nodeRaiz: p("receita"),
        nodes: [
          no({ id: p("receita"), tipo: "serie", nome: `Memória de Cálculo — ${nome}`, unidade: "R$", params: { valorMensal: receitaMensal || 100_000, crescimentoAnual: cresc } }),
        ],
      };
    }
  }
}
