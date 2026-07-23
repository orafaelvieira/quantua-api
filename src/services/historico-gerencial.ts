/**
 * HISTÓRICO GERENCIAL DO BUSINESS PLAN (decisão do usuário, 22/07/2026).
 *
 * O BP é estudo de viabilidade de algo NOVO — não exige IBR. Mas a empresa
 * quase sempre TEM passado: uma planilha gerencial, um Excel do contador, um
 * controle próprio. Este módulo deixa esse histórico entrar no modelo sem
 * passar pelo IBR e sem exigir que o analista reformate nada: ele sobe a
 * planilha como ela é, o sistema propõe o de-para linha a linha e o humano
 * confirma UMA vez (mesma arquitetura do dicionário de contas — IA/heurística
 * sugere, humano decide, nada entra em silêncio).
 *
 * Escopo: DRE + Balanço (o balanço destrava dívida e FCFF realizados nos
 * gráficos, que a DRE sozinha não permite calcular).
 *
 * O resultado é gravado no MESMO formato que o histórico vindo do IBR
 * (HistoricoAnual + linhas `bp-*`), então tudo que já lê histórico — gráficos,
 * seed, Demonstração — funciona sem saber de onde ele veio. A proveniência
 * fica declarada em `origem: "gerencial"`.
 *
 * Puro e determinístico: sem I/O, sem IA.
 */

import { DRE_TEMPLATE } from "./financial-templates";
import { sugerirConta } from "./account-mapper";

/** Linha crua da planilha, como o parser devolve. */
export interface LinhaCrua {
  conta: string;
  valores: Record<string, number>;
}

/** Destino canônico possível para uma linha da planilha. */
export interface DestinoCanonico {
  id: string;
  nome: string;
  grupo: "DRE" | "BP";
  /** Ajuda de contexto para a tela (o que entra nesta conta). */
  dica?: string;
}

/**
 * Contas de BALANÇO que o modelo consome. Os ids são os MESMOS que a rota
 * /historico-dfs devolve para o histórico vindo do IBR — é isso que faz os
 * gráficos funcionarem sem código novo.
 */
export const DESTINOS_BP: DestinoCanonico[] = [
  { id: "bp-caixa", nome: "Caixa e Equivalentes", grupo: "BP", dica: "caixa, bancos, aplicações de liquidez imediata" },
  { id: "bp-cr", nome: "Contas a Receber", grupo: "BP", dica: "clientes, duplicatas a receber" },
  { id: "bp-estoques", nome: "Estoques", grupo: "BP", dica: "mercadorias, matéria-prima, produtos acabados" },
  { id: "bp-ativo-circ", nome: "Ativo Circulante (total)", grupo: "BP", dica: "subtotal — só se a planilha o traz" },
  { id: "bp-imobilizado", nome: "Imobilizado", grupo: "BP", dica: "máquinas, veículos, imóveis (valor bruto)" },
  { id: "bp-depreciacao", nome: "(−) Depreciação acumulada", grupo: "BP", dica: "redutora do imobilizado" },
  { id: "bp-intangivel", nome: "Intangível", grupo: "BP", dica: "marcas, softwares, ágio" },
  { id: "bp-amortizacao", nome: "(−) Amortização acumulada", grupo: "BP", dica: "redutora do intangível" },
  { id: "bp-ativo-nc", nome: "Ativo Não Circulante (total)", grupo: "BP", dica: "subtotal" },
  { id: "bp-ativo", nome: "Ativo Total", grupo: "BP", dica: "subtotal — usado na prova Ativo = Passivo" },
  { id: "bp-fornecedores", nome: "Fornecedores", grupo: "BP", dica: "contas a pagar a fornecedores" },
  { id: "bp-divida-cp", nome: "Empréstimos e Financiamentos — CP", grupo: "BP", dica: "dívida vencendo em até 12 meses" },
  { id: "bp-passivo-circ", nome: "Passivo Circulante (total)", grupo: "BP", dica: "subtotal" },
  { id: "bp-divida-lp", nome: "Empréstimos e Financiamentos — LP", grupo: "BP", dica: "dívida de longo prazo" },
  { id: "bp-passivo-nc", nome: "Passivo Não Circulante (total)", grupo: "BP", dica: "subtotal" },
  { id: "bp-pl", nome: "Patrimônio Líquido", grupo: "BP", dica: "capital social, reservas, lucros acumulados" },
  { id: "bp-passivo-pl", nome: "Passivo Total", grupo: "BP", dica: "subtotal — Passivo + PL" },
];

/** Contas de DRE: as do modelo padrão da casa (mesmas do IBR). */
export function destinosDRE(): DestinoCanonico[] {
  return DRE_TEMPLATE.map((t) => ({
    id: `dre:${t.conta}`,
    nome: t.conta,
    grupo: "DRE" as const,
    dica: t.subtotal ? "subtotal (calculado a partir das linhas acima)" : undefined,
  }));
}

/** Todos os destinos aceitos no de-para. */
export function todosDestinos(): DestinoCanonico[] {
  return [...destinosDRE(), ...DESTINOS_BP];
}

/** Uma linha da planilha com a sugestão de para onde ela vai. */
export interface LinhaMapeada {
  /** Índice na planilha original (a tela devolve o mapa por este índice). */
  indice: number;
  nomeOriginal: string;
  valores: Record<string, number>;
  /** Destino sugerido (id) ou null quando o sistema não arrisca. */
  sugestao: string | null;
  /** Por que a sugestão — texto curto para a tela. */
  motivo?: string;
}

/** Normaliza para casar nome sem depender de acento/caixa/pontuação. */
const DIACRITICOS = new RegExp("[\\u0300-\\u036f]", "g");
function norm(s: string): string {
  return s.normalize("NFD").replace(DIACRITICOS, "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Palavras que denunciam BALANÇO — usadas só para ESCOLHER O LADO (DRE × BP)
 * antes de sugerir a conta. Sugerir "Estoques" para uma linha de DRE seria pior
 * que não sugerir nada, então a partição vem primeiro.
 */
const PISTAS_BP = [
  "ativo", "passivo", "circulante", "caixa", "banco", "aplicacao", "cliente",
  "duplicata", "receber", "estoque", "almoxarifado", "imobilizado", "veiculo",
  "maquina", "imovel", "intangivel", "deprecia", "amortiza", "fornecedor",
  "emprestimo", "financiamento", "patrimonio liquido", "capital social",
  "reserva", "lucros acumulados", "pagar", "obrigacao", "provisao",
];
const PISTAS_DRE = [
  "receita", "venda", "faturamento", "custo", "cmv", "cpv", "despesa", "lucro",
  "prejuizo", "margem", "ebitda", "ebit", "resultado", "imposto", "deducao",
  "abatimento", "devolucao", "juros", "amortizacao do emprestimo",
];

/** Lado provável da linha (BP ou DRE) por palavras-chave. */
export function ladoProvavel(nomeConta: string): "BP" | "DRE" | null {
  const n = norm(nomeConta);
  if (!n) return null;
  const bp = PISTAS_BP.filter((p) => n.includes(p)).length;
  const dre = PISTAS_DRE.filter((p) => n.includes(p)).length;
  if (bp > dre) return "BP";
  if (dre > bp) return "DRE";
  return null;
}

/**
 * SINÔNIMOS GERENCIAIS → conta canônica. A sobreposição de palavras sozinha
 * erra feio no vocabulário real das planilhas: "Faturamento bruto" casava com
 * *Lucro* Bruto (a palavra "bruto" domina), "Despesas com pessoal" casava com
 * Despesas com P&D, e "Financiamentos de longo prazo" caía no curto prazo.
 * Este dicionário resolve o caso conhecido ANTES do palpite genérico.
 *
 * Ordem IMPORTA: o primeiro padrão que casar vence, então o mais específico
 * ("longo prazo") vem antes do mais geral ("financiamento").
 */
const SINONIMOS: Array<{ re: RegExp; destino: string }> = [
  // ── Receita ──
  { re: /\b(faturamento|receita)\s*(bruta?|total|de vendas)?\b/, destino: "dre:Receita Bruta" },
  { re: /\b(venda|vendas)\s+(bruta|total|de (produtos|servicos|mercadorias))\b/, destino: "dre:Receita Bruta" },
  { re: /\breceita\s+liquida\b/, destino: "dre:Receita Líquida" },
  { re: /\b(imposto|tributo)s?\s+(sobre|s\/)\s*(venda|faturamento|receita)/, destino: "dre:Impostos s/ Faturamento" },
  { re: /\b(deducao|deducoes|devolucao|devolucoes|abatimento|cancelada)/, destino: "dre:Deduções da Receita Bruta" },
  // ── Custos ──
  { re: /\b(cmv|cpv|custo da mercadoria|custo dos produtos|custo das mercadorias|custo operacional|custo dos servicos)\b/, destino: "dre:Custo Operacional" },
  { re: /\bcusto.*(pessoal|pessoas|mao de obra|mod)\b/, destino: "dre:Custos com Pessoas (MOD)" },
  // ── Despesas (o "pessoal" precisa vir antes do genérico de despesa) ──
  { re: /\bdespesa.*(pessoal|pessoas|folha|salario|rh)\b/, destino: "dre:Despesas com Pessoas" },
  { re: /\bdespesa.*(administrativ|geral|gerais)\b/, destino: "dre:Despesas Gerais e Administrativas" },
  { re: /\bdespesa.*(aluguel|condominio|iptu|locacao)\b/, destino: "dre:Despesas com Aluguel, Condomínio e IPTU" },
  { re: /\bdespesa.*(energia|agua|telefone|internet|luz|utilidade)\b/, destino: "dre:Despesas com Energia, Água, Telefone e Internet" },
  { re: /\bdespesa.*(limpeza|manutencao|reparo|conservacao)\b/, destino: "dre:Despesas com Limpeza, Manutenção e Reparos" },
  { re: /\bdespesa.*(veiculo|frota|combustivel)\b/, destino: "dre:Despesas com Veículos" },
  { re: /\bdespesa.*(terceiro|servico de terceiro|terceirizad)\b/, destino: "dre:Despesas com Terceiros" },
  { re: /\bdespesa.*(comercial|venda|marketing|publicidade)\b/, destino: "dre:Despesas com Vendas" },
  { re: /\bdespesa.*financeir/, destino: "dre:Despesas Financeiras" },
  // ── Resultados ──
  { re: /\b(lucro|resultado|margem)\s+brut/, destino: "dre:Lucro Bruto" },
  { re: /\b(lucro|resultado|prejuizo)\s+liquid/, destino: "dre:Lucro Líquido" },
  { re: /\b(ebitda|lajida|geracao operacional)\b/, destino: "dre:EBITDA" },
  { re: /\b(ebit|lajir|resultado operacional)\b/, destino: "dre:EBIT" },
  { re: /\b(deprecia|amortiza)/, destino: "dre:Depreciação e Amortização" },
  { re: /\b(ir|irpj|csll|imposto de renda|contribuicao social)\b/, destino: "dre:IR e CSLL" },
  // ── Balanço: ativo ──
  { re: /\b(caixa|banco|disponivel|disponibilidade|aplicacao financeira)\b/, destino: "bp-caixa" },
  { re: /\b(cliente|duplicata|contas? a receber|receber de cliente)\b/, destino: "bp-cr" },
  { re: /\b(estoque|almoxarifado|mercadoria em estoque)\b/, destino: "bp-estoques" },
  { re: /\b(imobilizado|maquina|equipamento|veiculos do ativo|imovel|benfeitoria)\b/, destino: "bp-imobilizado" },
  { re: /\b(intangivel|marca|patente|software|agio)\b/, destino: "bp-intangivel" },
  { re: /\bativo\s+(total|geral)\b|\btotal do ativo\b/, destino: "bp-ativo" },
  { re: /\bativo\s+circulante\b/, destino: "bp-ativo-circ" },
  { re: /\bativo\s+nao\s+circulante\b|\bativo permanente\b/, destino: "bp-ativo-nc" },
  // ── Balanço: passivo (longo prazo ANTES do genérico) ──
  { re: /\b(emprestimo|financiamento|divida|debenture).*(longo prazo|lp|nao circulante)\b/, destino: "bp-divida-lp" },
  { re: /\b(emprestimo|financiamento|divida|debenture)/, destino: "bp-divida-cp" },
  { re: /\b(fornecedor|contas? a pagar)\b/, destino: "bp-fornecedores" },
  { re: /\b(patrimonio liquido|capital social|reserva de lucro|lucros acumulados|pl)\b/, destino: "bp-pl" },
  { re: /\bpassivo\s+(total|geral)\b|\btotal do passivo\b/, destino: "bp-passivo-pl" },
  { re: /\bpassivo\s+circulante\b/, destino: "bp-passivo-circ" },
  { re: /\bpassivo\s+nao\s+circulante\b|\bexigivel a longo prazo\b/, destino: "bp-passivo-nc" },
];

/** Destino por sinônimo conhecido, ou null. */
export function porSinonimo(nomeConta: string): string | null {
  const n = norm(nomeConta);
  if (!n) return null;
  for (const s of SINONIMOS) if (s.re.test(n)) return s.destino;
  return null;
}

/**
 * Propõe o de-para de cada linha da planilha. Determinístico, em cascata:
 * nome canônico exato → sinônimo gerencial conhecido → sobreposição de
 * palavras dentro do lado provável (DRE × Balanço, nunca cruzando).
 */
export function sugerirMapa(linhas: LinhaCrua[]): LinhaMapeada[] {
  const dre = destinosDRE();
  const porNomeDRE = new Map(dre.map((d) => [norm(d.nome), d.id]));
  const porNomeBP = new Map(DESTINOS_BP.map((d) => [norm(d.nome), d.id]));
  const nomesDRE = dre.map((d) => d.nome);
  const nomesBP = DESTINOS_BP.map((d) => d.nome);

  return linhas.map((l, indice) => {
    const base = { indice, nomeOriginal: l.conta, valores: l.valores };
    const n = norm(l.conta);
    if (!n) return { ...base, sugestao: null };

    // 1. Casamento EXATO com o nome canônico (os dois lados).
    const exatoDRE = porNomeDRE.get(n);
    if (exatoDRE) return { ...base, sugestao: exatoDRE, motivo: "nome idêntico ao da conta padrão" };
    const exatoBP = porNomeBP.get(n);
    if (exatoBP) return { ...base, sugestao: exatoBP, motivo: "nome idêntico ao da conta padrão" };

    // 2. Sinônimo gerencial conhecido (o vocabulário real das planilhas).
    const sin = porSinonimo(l.conta);
    if (sin) return { ...base, sugestao: sin, motivo: "termo gerencial reconhecido" };

    // 3. Aproximação DENTRO do lado provável.
    const lado = ladoProvavel(l.conta);
    if (lado === "BP") {
      const s = sugerirConta(l.conta, nomesBP);
      if (s) return { ...base, sugestao: DESTINOS_BP.find((d) => d.nome === s)!.id, motivo: "parece conta de balanço" };
    } else if (lado === "DRE") {
      const s = sugerirConta(l.conta, nomesDRE);
      if (s) return { ...base, sugestao: `dre:${s}`, motivo: "parece conta de resultado" };
    }
    // 4. Sem lado claro: tenta os dois e fica com o que casar (DRE primeiro,
    //    que é o caso mais comum numa planilha gerencial).
    const sD = sugerirConta(l.conta, nomesDRE);
    if (sD) return { ...base, sugestao: `dre:${sD}`, motivo: "aproximação pelo nome" };
    const sB = sugerirConta(l.conta, nomesBP);
    if (sB) return { ...base, sugestao: DESTINOS_BP.find((d) => d.nome === sB)!.id, motivo: "aproximação pelo nome" };
    return { ...base, sugestao: null };
  });
}

/** Mapa confirmado pelo analista: índice da linha → id do destino (ou null = ignorar). */
export type MapaConfirmado = Record<number, string | null>;

export interface HistoricoGerencialMontado {
  periodos: string[];
  /** Linhas de DRE consolidadas por conta canônica. */
  dre: Record<string, Record<string, number>>;
  /** Linhas de balanço por id `bp-*`. */
  bp: Record<string, Record<string, number>>;
  /** Provas de integridade — exibidas ao analista, nunca escondidas. */
  avisos: string[];
}

/**
 * Aplica o mapa confirmado e consolida o histórico. Várias linhas da planilha
 * podem apontar para a MESMA conta canônica (o gerencial costuma ser mais
 * detalhado que o padrão) — nesse caso os valores SOMAM, que é o comportamento
 * do fold do IBR.
 */
export function montarHistorico(
  linhas: LinhaCrua[],
  periodos: string[],
  mapa: MapaConfirmado,
): HistoricoGerencialMontado {
  const dre: Record<string, Record<string, number>> = {};
  const bp: Record<string, Record<string, number>> = {};

  linhas.forEach((l, i) => {
    const destino = mapa[i];
    if (!destino) return; // não mapeada = ignorada por decisão do analista
    const alvo = destino.startsWith("dre:") ? dre : bp;
    const chave = destino.startsWith("dre:") ? destino.slice(4) : destino;
    alvo[chave] ??= {};
    for (const p of periodos) {
      const v = l.valores[p];
      if (Number.isFinite(v)) alvo[chave][p] = (alvo[chave][p] ?? 0) + v;
    }
  });

  // ── PROVAS (a planilha gerencial não passou por auditoria nenhuma) ──
  const avisos: string[] = [];
  const soma = (obj: Record<string, Record<string, number>>, id: string, p: string) => obj[id]?.[p] ?? 0;
  for (const p of periodos) {
    const ativo = soma(bp, "bp-ativo", p);
    const passivo = soma(bp, "bp-passivo-pl", p);
    if (ativo > 0 && passivo > 0) {
      const dif = Math.abs(ativo - passivo);
      // Tolerância de 1 centavo por real de ativo (0,01%) — planilha gerencial
      // costuma ter arredondamento; diferença material vira aviso, não bloqueio.
      if (dif > Math.max(1, ativo * 0.0001)) {
        avisos.push(`${p}: Ativo (${ativo.toLocaleString("pt-BR")}) ≠ Passivo + PL (${passivo.toLocaleString("pt-BR")}) — diferença de ${dif.toLocaleString("pt-BR")}.`);
      }
    }
  }
  const semDestino = linhas.filter((_, i) => !mapa[i]).length;
  if (semDestino > 0) avisos.push(`${semDestino} linha(s) da planilha não foram mapeadas e ficaram de fora do histórico.`);

  return { periodos, dre, bp, avisos };
}

/**
 * Converte o resultado para o formato de HistoricoAnual (o mesmo do IBR), para
 * que gráficos, Demonstração e seed leiam sem saber a origem.
 * Subtotais ausentes na planilha são DERIVADOS quando dá (lucro bruto, EBITDA);
 * o que não dá para derivar fica ausente — nunca zero, que afirmaria um fato.
 */
export function paraHistoricoAnual(m: HistoricoGerencialMontado): {
  periodos: string[];
  linhas: Record<string, Record<string, number>>;
} {
  const g = (conta: string, p: string): number | undefined => {
    const v = m.dre[conta]?.[p];
    return Number.isFinite(v) ? v : undefined;
  };
  const abs = (v: number | undefined) => (v === undefined ? undefined : Math.abs(v));

  const linhas: Record<string, Record<string, number>> = {
    receita: {}, deducoes: {}, receitaLiquida: {}, custos: {}, lucroBruto: {},
    despesas: {}, ebitda: {}, depreciacao: {}, ebit: {}, despesasFinanceiras: {},
    resultadoAntesIr: {}, irCsll: {}, lucroLiquido: {},
  };
  const por: Array<[string, string]> = [
    ["receita", "Receita Bruta"],
    ["deducoes", "Deduções da Receita Bruta"],
    ["receitaLiquida", "Receita Líquida"],
    ["lucroBruto", "Lucro Bruto"],
    ["ebitda", "EBITDA"],
    ["depreciacao", "Depreciação e Amortização"],
    ["ebit", "EBIT"],
    ["despesasFinanceiras", "Despesas Financeiras"],
    ["resultadoAntesIr", "Resultado Antes do IR e CSLL"],
    ["irCsll", "IR e CSLL"],
    ["lucroLiquido", "Lucro Líquido"],
  ];
  for (const p of m.periodos) {
    for (const [destino, conta] of por) {
      const v = g(conta, p);
      if (v !== undefined) linhas[destino][p] = destino === "receita" || destino === "deducoes" || destino === "depreciacao" || destino === "despesasFinanceiras" || destino === "irCsll" ? Math.abs(v) : v;
    }
    // Custos e despesas: preferem o subtotal declarado; senão derivam.
    const liq = linhas.receitaLiquida[p] ?? (linhas.receita[p] !== undefined ? linhas.receita[p] - (linhas.deducoes[p] ?? 0) : undefined);
    if (liq !== undefined) linhas.receitaLiquida[p] = liq;
    const lb = linhas.lucroBruto[p];
    const custoDireto = abs(g("Custo Operacional", p)) ?? abs(g("Custos com Pessoas (MOD)", p));
    if (custoDireto !== undefined) linhas.custos[p] = custoDireto;
    else if (liq !== undefined && lb !== undefined) linhas.custos[p] = liq - lb;
    if (lb !== undefined && linhas.ebitda[p] !== undefined) linhas.despesas[p] = lb - linhas.ebitda[p];
  }
  // Limpa linhas que ficaram vazias (ausência ≠ zero).
  for (const k of Object.keys(linhas)) if (!Object.keys(linhas[k]).length) delete linhas[k];
  return { periodos: m.periodos, linhas };
}
