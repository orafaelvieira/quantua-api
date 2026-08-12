/**
 * O IBR LÊ A BASE CONTÁBIL DO WORKSPACE (pedido do dono, 11/08/2026).
 *
 * ANTES: o mesmo documento era lido DUAS vezes. Uma na porta da Data room
 * (quando sobe para o pool da empresa) e outra dentro do IBR (quando o analista
 * fixa o documento e roda a extração). Mesmo motor, mesma cascata — e mesmo
 * assim duas verdades: a cascata é estocástica nos níveis de IA e cada rodada
 * pode parar num nível diferente. Medido no caso Move Farma: a leitura do IBR
 * venceu em VISÃO (88 nós, US$ 0,27) e a da porta em HÍBRIDO (86 nós, US$ 0,08)
 * — duas contas a menos, com todas as provas de soma passando. O analista via
 * um número na aba Conciliação contábil e outro no IBR, sem explicação possível.
 *
 * AGORA: quando todos os documentos contábeis do IBR vieram do pool da empresa
 * e estão CONCILIADOS, o IBR não extrai nada — ele consome a base que a aba
 * Conciliação contábil já montou. Uma leitura, uma verdade, e a IA da porta
 * paga uma vez só.
 *
 * ELEGIBILIDADE (todas obrigatórias, e o motivo de cada recusa viaja junto):
 *   1. todo documento contábil do IBR tem origem no pool (`fixadoDeId`);
 *   2. a base conseguiu ler todos eles;
 *   3. todos estão conciliados — a mesma régua da garantia 6 ("documento que
 *      não fechou 100% não entra em IBR"), decidida em UM lugar só;
 *   4. a base produziu período e linha (base vazia não substitui extração).
 * Falhou alguma? O IBR segue pelo caminho antigo, intocado. Sem retrocesso:
 * o plug só entra onde comprovadamente entrega o mesmo ou melhor.
 */
import { insumosDaBase, montarBaseContabil } from "./base-contabil";
import { validateFinancialData } from "./validation";
import { chaveNM } from "./classification-suggest";
import type { BPLineItem, DRELineItem, UnmatchedAccount } from "../types/financial";
import type { NaoMapeado } from "./ai-extraction";

/** Documento contábil do IBR, do jeito que a rota já os tem em mãos. */
export type DocDoIBR = {
  id: string;
  nome: string;
  tipo: string;
  status: string;
  fixadoDeId: string | null;
};

export type ResultadoBaseIBR = {
  /** Espelha o vencedor da cascata — a rota materializa igual, sem saber a origem. */
  escolhido: {
    fonte: "base-workspace";
    bp: BPLineItem[];
    dre: DRELineItem[];
    periodos: string[];
    declarados: Record<string, Record<string, number>>;
    unmatched: UnmatchedAccount[];
    arvoreBP: unknown;
    arvoreDRE: unknown;
    naoMapeados: NaoMapeado[];
    alertasComposicao: unknown[];
    custoUsd: 0;
    /** Mesma trava do IBR, recalculada sobre o modelo MESCLADO da base. */
    validacao: ReturnType<typeof validateFinancialData>;
    /** A base entrou porque TODO documento estava conciliado; `fecha` confirma
     *  que o modelo montado com todos eles juntos também fecha. */
    fecha: boolean;
  };
  /** Árvores mensais por documento — o /refold as re-dobra quando o dicionário muda. */
  arvoresBalancete: Array<{ docId: string; nome: string; periodo: string; arvoreBP: unknown; arvoreDRE: unknown }>;
  /** Provas por balancete (alimentam aplicarProvasBalancete na validação). */
  balancetes: Array<Record<string, unknown>>;
  /**
   * Sugestões de classificação já traduzidas para a CHAVE DO IBR. A base as
   * calcula de graça (vocabulário contábil + contas irmãs do documento +
   * similaridade com o modelo); sem esta tradução o IBR chamaria a IA de novo
   * para as mesmas contas, pagando duas vezes por uma resposta que já existe.
   */
  sugestoes: Record<string, { sugestao: string; justificativa: string; confianca: string }>;
  /** Intervalo REAL coberto por cada coluna — a regra da série contínua se
   *  mede por intervalo, e sem isto o IBR teria de adivinhar. */
  intervaloPorPeriodo: Record<string, { inicio: string; fim: string; tipo: "mes" | "exercicio" }>;
  /** Impressão digital dos insumos desta base — o IBR a guarda para saber, mais
   *  tarde, se a base mudou (é o detector de "extração desatualizada"). */
  marcaBase: string;
  /** Ids do POOL que formaram esta base — proveniência no envelope do IBR. */
  poolIds: string[];
  avisos: string[];
};

export type RecusaBaseIBR = { elegivel: false; motivos: string[] };

/**
 * Monta a base do workspace para este IBR, ou explica por que não dá.
 *
 * @param docs documentos contábeis ATIVOS do IBR (materiais complementares e
 *   substituídos já filtrados pela rota).
 */
export async function baseDoWorkspaceParaIBR(
  companyId: string,
  scopeUserIds: string[],
  docs: DocDoIBR[],
): Promise<ResultadoBaseIBR | RecusaBaseIBR> {
  const motivos: string[] = [];
  if (docs.length === 0) return { elegivel: false, motivos: ["nenhum documento contábil no IBR"] };

  const semOrigem = docs.filter((d) => !d.fixadoDeId);
  if (semOrigem.length) {
    // Documento enviado direto no IBR (fluxo antigo) não passou pela porta da
    // Data room, então não existe leitura conciliada dele no workspace.
    motivos.push(
      `${semOrigem.length} documento(s) não vieram da Data room da empresa (${semOrigem.slice(0, 3).map((d) => `"${d.nome}"`).join(", ")}${semOrigem.length > 3 ? "…" : ""}) — envie-os pela Data room para que entrem na base contábil`,
    );
    return { elegivel: false, motivos };
  }

  const poolIds = docs.map((d) => d.fixadoDeId!);
  const insumos = await insumosDaBase(companyId, scopeUserIds, poolIds);
  const base = await montarBaseContabil(companyId, scopeUserIds, insumos, { paraProduto: true });

  // A base ignora silenciosamente documento que não conseguiu ler; aqui o
  // silêncio não serve — cada documento pedido precisa aparecer no relatório.
  const lidos = new Set(base.relatorio.filter((r) => r.lido).map((r) => r.documentId));
  const naoLidos = docs.filter((d) => !lidos.has(d.fixadoDeId!));
  for (const d of naoLidos) {
    const r = base.relatorio.find((x) => x.documentId === d.fixadoDeId);
    motivos.push(`"${d.nome}": ${r?.erro ?? "ainda sem leitura na Data room"}`);
  }

  const conc = base.conciliacaoPorDocumento as Record<string, { ok: boolean; motivos: string[] }>;
  for (const d of docs) {
    if (naoLidos.includes(d)) continue;
    const c = conc[d.fixadoDeId!];
    if (c && !c.ok) motivos.push(`"${d.nome}" não está conciliado: ${c.motivos.join(" · ")}`);
  }

  if (base.periodos.length === 0) motivos.push("a base do workspace não produziu nenhuma coluna de período");
  if (base.bp.length === 0 && base.dre.length === 0) motivos.push("a base do workspace não produziu nenhuma linha");

  if (motivos.length) return { elegivel: false, motivos };

  // A conciliação foi conferida documento a documento; falta a trava do
  // CONJUNTO — colunas de fontes diferentes na mesma série ainda precisam
  // fechar a equação patrimonial entre si.
  const declarados = (base as { declarados?: Record<string, Record<string, number>> }).declarados ?? {};
  const validacao = validateFinancialData(
    base.bp as never, base.dre as never, base.periodos, declarados,
  );

  // Tradução das chaves: a base indexa DRE por "DRE|DRE|nome" e BP por
  // "BP|grupoRaiz|nome"; o IBR indexa tudo por chaveNM (tipo|grupoRaiz|nome).
  const daBaseSug = (base as { sugestoesIA?: Record<string, { sugestao: string; justificativa: string; confianca: string }> }).sugestoesIA ?? {};
  const raiz = (g: string) => (g || "").split(">")[0]!.trim();
  const sugestoes: ResultadoBaseIBR["sugestoes"] = {};
  for (const nm of base.naoMapeadosDetalhe as unknown as Array<{ tipo: string; nome: string; grupo: string; valor: number }>) {
    const candidatas = nm.tipo === "DRE"
      ? [`DRE|DRE|${nm.nome}|${nm.valor > 0 ? "+" : "-"}`, `DRE|DRE|${nm.nome}`]
      : [`BP|${raiz(nm.grupo)}|${nm.nome}`];
    const achada = candidatas.map((k) => daBaseSug[k]).find(Boolean);
    if (achada) sugestoes[chaveNM(nm)] = achada;
  }

  return {
    escolhido: {
      fonte: "base-workspace",
      bp: base.bp as unknown as BPLineItem[],
      dre: base.dre as unknown as DRELineItem[],
      periodos: base.periodos,
      declarados,
      // A tela de classificação do IBR lê `unmatchedAccounts`; a base já entrega
      // as pendências consolidadas, e a rota as converte com a mesma função.
      unmatched: [],
      arvoreBP: base.arvoreOriginalBP,
      arvoreDRE: base.arvoreOriginalDRE,
      naoMapeados: base.naoMapeadosDetalhe as unknown as NaoMapeado[],
      alertasComposicao: (base as { alertasComposicao?: unknown[] }).alertasComposicao ?? [],
      // Custo ZERO aqui e isso é literal: a IA da leitura foi paga UMA vez, na
      // porta da Data room, com trilha no escopo da empresa ([[registrar-custo-ia]]).
      custoUsd: 0,
      validacao,
      fecha: validacao.equacaoPatrimonial,
    },
    arvoresBalancete: (base as { arvoresBalancete?: ResultadoBaseIBR["arvoresBalancete"] }).arvoresBalancete ?? [],
    balancetes: ((base as { balancetes?: Array<Record<string, unknown>> }).balancetes ?? []),
    sugestoes,
    marcaBase: insumos.marca,
    intervaloPorPeriodo: Object.fromEntries(
      Object.values(base.intervaloPorDocumento).map((iv) => [iv.fim, iv]),
    ),
    poolIds,
    avisos: base.avisos,
  };
}

export const ehRecusa = (r: ResultadoBaseIBR | RecusaBaseIBR): r is RecusaBaseIBR =>
  (r as RecusaBaseIBR).elegivel === false;
