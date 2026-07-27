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
  { id: "agro_area", nome: "Área × produtividade × preço", descricao: "Hectares plantados × sacas por hectare × preço da saca — a receita da produção própria. Distribua a colheita pelos meses na curva de cada variável.", exemplos: "Produção agrícola, fazendas, cooperativas" },
  // ── Agronegócio (revenda de insumos e grãos) ──
  { id: "agro_insumo", nome: "Insumo agrícola (preço a partir do custo)", descricao: "Volume vendido × preço, com o preço calculado a partir do custo do produto: sobe o custo pelos impostos, frete, armazenagem, comissão e a margem que você quer ganhar.", exemplos: "Revenda de fertilizantes, defensivos, sementes" },
  { id: "agro_graos", nome: "Grãos (volume em kg, preço por saca)", descricao: "Volume controlado em quilos e preço negociado por saca de 60 kg — a conversão é automática.", exemplos: "Revenda de soja, milho, sorgo" },
  { id: "agro_agrupado", nome: "Família de produtos (receita e margem)", descricao: "Para quem não quer detalhar produto a produto: digite a receita do mês e a margem da família.", exemplos: "Agro, distribuição, atacado" },
  { id: "agro_barter", nome: "Barter (troca de insumo por grão)", descricao: "O produtor paga em grão. Converte a venda em sacas pelo preço pago ao produtor e revaloriza pelo preço da trading — o ganho é o spread entre os dois.", exemplos: "Revendas agrícolas com operação de barter" },
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
          // EXPANSÃO (F7, waterfall SaaS): upsell/cross-sell como % do MRR do
          // mês — não cumulativo (o cumulativo é o ARPU crescendo por ano).
          no({ id: p("expansao"), tipo: "taxa", nome: "Expansão (upsell) — % do MRR no mês", unidade: "%", params: { valorMensal: 0 } }),
          no({ id: p("receita"), tipo: "formula", nome: `Memória de Cálculo — ${nome}`, unidade: "R$", params: { expr: `${p("clientes")} * ${p("arpu")} * (1 + ${p("expansao")})` } }),
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
    case "agro_area": {
      // Produção própria (F7): hectares × sacas/ha × R$/saca. A colheita é
      // sazonal — o analista distribui pelos meses nas curvas das variáveis.
      return {
        id: linhaId, nome, template, nodeRaiz: p("receita"),
        nodes: [
          no({ id: p("area"), tipo: "serie", nome: "Área plantada (hectares)", unidade: "#", params: { valorMensal: 0 } }),
          // sacas POR hectare = [#/un] — assim hectares × (sacas/ha) fecha em
          // sacas e × R$/saca fecha em R$ (a prova de unidades cobra isso).
          no({ id: p("produtividade"), tipo: "serie", nome: "Produtividade (sacas por hectare no mês)", unidade: "#/un", params: { valorMensal: 0 } }),
          no({ id: p("preco"), tipo: "preco", nome: "Preço da saca", unidade: "R$/un", params: { valorMensal: 0 } }),
          no({ id: p("receita"), tipo: "formula", nome: `Memória de Cálculo — ${nome}`, unidade: "R$", params: { expr: `${p("area")} * ${p("produtividade")} * ${p("preco")}` } }),
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
    // ── Agronegócio ──
    // Cada linha nasce AUTOSSUFICIENTE (nós próprios, inclusive a pilha de
    // custos variáveis do barter/insumo): o analista adiciona uma linha por vez
    // pela tela. Para montar o bloco inteiro de uma vez (17 SKUs com a pilha
    // COMPARTILHADA entre eles, como na planilha), use montarBlocoAgro().
    case "agro_insumo": {
      const custo = 100;
      const volume = receitaMensal > 0 ? Math.round(receitaMensal / (custo / 0.9)) : 1_000;
      return {
        id: linhaId, nome, template, nodeRaiz: p("receita"),
        nodes: [
          no({ id: p("cv_impostos"), tipo: "taxa", nome: "Impostos sobre venda", unidade: "%", params: { valorMensal: 0.02, max: 1 } }),
          no({ id: p("cv_frete"), tipo: "taxa", nome: "Custo com frete", unidade: "%", params: { valorMensal: 0, max: 1 } }),
          no({ id: p("cv_armazenagem"), tipo: "taxa", nome: "Custo de armazenagem", unidade: "%", params: { valorMensal: 0.01, max: 1 } }),
          no({ id: p("cv_comissao"), tipo: "taxa", nome: "Comissão sobre vendas", unidade: "%", params: { valorMensal: 0, max: 1 } }),
          no({ id: p("cv_financeiro"), tipo: "taxa", nome: "Custo financeiro", unidade: "%", params: { valorMensal: 0, max: 1 } }),
          no({ id: p("cv_margem"), tipo: "taxa", nome: "Margem de contribuição desejada", unidade: "%", params: { valorMensal: 0.07, max: 1 } }),
          no({ id: p("cv_soma"), tipo: "formula", nome: "Soma dos custos variáveis e da margem", unidade: "%", params: { expr: `${p("cv_impostos")} + ${p("cv_frete")} + ${p("cv_armazenagem")} + ${p("cv_comissao")} + ${p("cv_financeiro")} + ${p("cv_margem")}` } }),
          no({ id: p("volume"), tipo: "serie", nome: "Volume vendido no mês", unidade: "#", papel: "quantidade", params: { valorMensal: volume } }),
          no({ id: p("custo"), tipo: "preco", nome: "Custo unitário do produto", unidade: "R$/un", params: { valorMensal: custo } }),
          // Preço DERIVADO: sobe o custo pela pilha (custo ÷ (1 − Σ%)).
          no({ id: p("preco"), tipo: "formula", nome: "Preço de venda", unidade: "R$/un", params: { expr: `${p("custo")} / (1 - ${p("cv_soma")})` } }),
          no({ id: p("receita"), tipo: "formula", nome: `Memória de Cálculo — ${nome}`, unidade: "R$", params: { expr: `${p("volume")} * ${p("preco")}` } }),
        ],
      };
    }
    case "agro_graos": {
      const precoSaca = 130;
      const volumeKg = receitaMensal > 0 ? Math.round((receitaMensal / precoSaca) * 60) : 600_000;
      return {
        id: linhaId, nome, template, nodeRaiz: p("receita"),
        nodes: [
          no({ id: p("volume_kg"), tipo: "serie", nome: "Volume vendido no mês (kg)", unidade: "#", papel: "quantidade", params: { valorMensal: volumeKg } }),
          no({ id: p("preco_saca"), tipo: "preco", nome: "Preço por saca (60 kg)", unidade: "R$/un", params: { valorMensal: precoSaca } }),
          no({ id: p("sacas"), tipo: "formula", nome: "Sacas vendidas (60 kg por saca)", unidade: "#", params: { expr: `${p("volume_kg")} / 60` } }),
          no({ id: p("receita"), tipo: "formula", nome: `Memória de Cálculo — ${nome}`, unidade: "R$", params: { expr: `${p("sacas")} * ${p("preco_saca")}` } }),
        ],
      };
    }
    case "agro_agrupado": {
      return {
        id: linhaId, nome, template, nodeRaiz: p("receita"),
        nodes: [
          no({ id: p("margem"), tipo: "taxa", nome: "Margem bruta da família", unidade: "%", params: { valorMensal: 0.15, max: 1 } }),
          no({ id: p("receita"), tipo: "serie", nome: `Memória de Cálculo — ${nome}`, unidade: "R$", params: { valorMensal: receitaMensal || 100_000, crescimentoAnual: cresc } }),
        ],
      };
    }
    case "agro_barter": {
      const precoProdutor = 120;
      return {
        id: linhaId, nome, template, nodeRaiz: p("receita"),
        nodes: [
          no({ id: p("base"), tipo: "serie", nome: "Venda de insumos liquidada em grão (R$)", unidade: "R$", params: { valorMensal: receitaMensal || 0 } }),
          no({ id: p("preco_produtor"), tipo: "preco", nome: "Preço da saca pago ao produtor", unidade: "R$/un", params: { valorMensal: precoProdutor } }),
          no({ id: p("preco_trading"), tipo: "preco", nome: "Preço da saca na trading", unidade: "R$/un", params: { valorMensal: precoProdutor * 1.1 } }),
          // R$ ÷ (R$/un) = un: a análise dimensional garante que isto fecha em sacas.
          no({ id: p("sacas"), tipo: "formula", nome: "Sacas recebidas do produtor", unidade: "#", params: { expr: `${p("base")} / ${p("preco_produtor")}` } }),
          no({ id: p("receita"), tipo: "formula", nome: `Memória de Cálculo — ${nome}`, unidade: "R$", params: { expr: `${p("sacas")} * ${p("preco_trading")}` } }),
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
