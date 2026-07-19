/**
 * TEMPLATES DE RECEITA DO AGRONEGÓCIO (revenda de insumos, grãos e barter).
 *
 * Réplica funcional do motor de receita do Business Plan da Belagro
 * (ver PLANO_BUSINESS_PLAN_BELAGRO.md, Parte 3), montada sobre as primitivas
 * do model-engine — sem motor paralelo.
 *
 * A planilha tem DOIS modos mutuamente exclusivos, escolhidos mês a mês na
 * linha 15 do Orçamento. Aqui viram dois montadores; o modo fica no metadado
 * `template` da linha e a tela oferece a troca.
 *
 *  - DETALHADO: 17 SKUs (produto × unidade de medida). O analista digita
 *    VOLUME e CUSTO UNITÁRIO; o PREÇO é DERIVADO — a planilha "sobe" o custo
 *    pela pilha de custos variáveis e pela margem de contribuição alvo:
 *        preço = custo ÷ (1 − Σ(% impostos, frete, armazenagem, comissão,
 *                                custo financeiro, margem de contribuição))
 *    Os seis percentuais são GLOBAIS (valem para todos os SKUs) — por isso
 *    vivem num conjunto de nós compartilhado, referenciado por todas as linhas.
 *
 *  - AGRUPADO: 7 famílias comerciais. O analista digita a RECEITA em R$ e a
 *    MARGEM; o custo é derivado (receita × (1 − margem)).
 *
 * Grãos são vendidos por SACA de 60 kg, mas o volume é controlado em kg:
 *        receita = (volume_kg ÷ 60) × preço_por_saca
 *
 * BARTER (troca de insumo por grão): o produtor paga em grão. A margem da
 * operação é o spread entre o preço da saca pago ao PRODUTOR e o preço da saca
 * obtido na TRADING:
 *        sacas   = receita_insumos × %barter × %cultura ÷ preço_saca_produtor
 *        receita = sacas × preço_saca_trading
 *
 * Determinístico: zero IA aqui.
 */
import { LinhaReceita, DriverNode } from "./model-engine";

/** Saca brasileira = 60 kg. Constante do negócio, não premissa. */
export const KG_POR_SACA = 60;

function no(parcial: Omit<DriverNode, "params"> & { params?: Record<string, unknown> }): DriverNode {
  return { params: {}, ...parcial };
}

// ── Catálogos ──────────────────────────────────────────────────────────────

export interface SkuAgro {
  /** Sufixo do id dos nós — só [a-z0-9_] (o parser trata "-" como subtração). */
  id: string;
  nome: string;
  /** Unidade de medida comercial: DS, KG, LT, TON, SC, BAG. */
  um: string;
  volumeMensal?: number;
  custoUnitario?: number;
}

/**
 * Os 17 SKUs do modo Detalhado da Belagro, na ordem da planilha.
 * Os 14 primeiros são insumos/químicos; os 3 últimos são grãos de revenda
 * (controlados em kg e precificados por saca).
 */
export const SKUS_INSUMOS_PADRAO: SkuAgro[] = [
  { id: "nutricao_ds", nome: "Nutrição", um: "DS" },
  { id: "nutricao_kg", nome: "Nutrição", um: "KG" },
  { id: "nutricao_lt", nome: "Nutrição", um: "LT" },
  { id: "defensivos_kg", nome: "Defensivos", um: "KG" },
  { id: "defensivos_lt", nome: "Defensivos", um: "LT" },
  { id: "defensivos_sc", nome: "Defensivos", um: "SC" },
  { id: "adubo_ton", nome: "Adubo e Fertilizantes", um: "TON" },
  { id: "corretivo_ton", nome: "Corretivo de Solo", um: "TON" },
  { id: "sem_milho_bag", nome: "Semente de Milho", um: "BAG" },
  { id: "sem_milho_sc", nome: "Semente de Milho", um: "SC" },
  { id: "sem_soja_bag", nome: "Semente de Soja", um: "BAG" },
  { id: "sem_soja_sc", nome: "Semente de Soja", um: "SC" },
  { id: "sem_sorgo_bag", nome: "Semente de Sorgo", um: "BAG" },
  { id: "sem_sorgo_sc", nome: "Semente de Sorgo", um: "SC" },
];

/** Culturas de grão negociadas (revenda e barter). */
export const GRAOS_PADRAO = [
  { id: "soja", nome: "Soja" },
  { id: "milho", nome: "Milho" },
  { id: "sorgo", nome: "Sorgo" },
];

/** As 7 famílias comerciais do modo Agrupado. */
export const FAMILIAS_AGRUPADO_PADRAO = [
  { id: "fert_nutricao", nome: "Fertilizantes - Nutrição", margem: 0.2 },
  { id: "fert_adubos", nome: "Fertilizantes - Adubos & Fertilizantes", margem: 0.09 },
  { id: "fert_corretivo", nome: "Fertilizantes - Corretivo de Solo", margem: 0.1 },
  { id: "insumos", nome: "Insumos", margem: 0.15 },
  { id: "sementes_soja", nome: "Sementes Soja", margem: 0.1 },
  { id: "sementes_milho", nome: "Sementes Milho", margem: 0.15 },
  { id: "sementes_sorgo", nome: "Sementes Sorgo", margem: 0.15 },
];

/**
 * Os seis percentuais que compõem a pilha entre custo e preço.
 * `margem_contribuicao` é a margem ALVO da operação — é ela que transforma
 * custo em preço; as outras cinco são custos variáveis que o preço precisa
 * cobrir.
 */
export interface CustoVariavelAgro {
  id: string;
  nome: string;
  valor: number;
}

export const CUSTOS_VARIAVEIS_PADRAO: CustoVariavelAgro[] = [
  { id: "imposto_venda", nome: "Impostos sobre Venda", valor: 0.02 },
  { id: "frete", nome: "Custo com Frete", valor: 0 },
  { id: "armazenagem", nome: "Custo de Armazenagem", valor: 0.01 },
  { id: "comissao", nome: "Comissão sobre Vendas", valor: 0 },
  { id: "custo_financeiro", nome: "Custo Financeiro", valor: 0 },
  { id: "margem_contribuicao", nome: "Margem de Contribuição", valor: 0.07 },
];

// ── Nós compartilhados (a pilha de custos variáveis) ───────────────────────

/** Prefixo dos ids dos nós compartilhados de um bloco. */
export function idsCustosVariaveis(prefixo = "cv"): { itens: string[]; soma: string } {
  return {
    itens: CUSTOS_VARIAVEIS_PADRAO.map((c) => `${prefixo}_${c.id}`),
    soma: `${prefixo}_soma`,
  };
}

/**
 * Monta os nós GLOBAIS da pilha de custos variáveis + o nó de soma.
 * Ficam pendurados na primeira linha do bloco (nós são um espaço de nomes
 * global no motor — qualquer linha os referencia), sem virar linha de receita.
 */
export function montarCustosVariaveis(
  prefixo = "cv",
  valores?: Partial<Record<string, number>>
): DriverNode[] {
  const ids = idsCustosVariaveis(prefixo);
  const itens = CUSTOS_VARIAVEIS_PADRAO.map((c) =>
    no({
      id: `${prefixo}_${c.id}`,
      tipo: "taxa",
      nome: c.nome,
      unidade: "%",
      params: { valorMensal: valores?.[c.id] ?? c.valor, max: 1 },
    })
  );
  return [
    ...itens,
    no({
      id: ids.soma,
      tipo: "formula",
      nome: "Soma dos custos variáveis e da margem",
      unidade: "%",
      params: { expr: ids.itens.join(" + ") },
    }),
  ];
}

// ── Modo DETALHADO ─────────────────────────────────────────────────────────

/**
 * Uma linha de SKU: volume × preço, com o preço derivado do custo unitário.
 * `nosCompartilhados` entra apenas na primeira linha do bloco.
 */
export function montarLinhaInsumoDetalhado(
  sku: SkuAgro,
  opts: { prefixoCustos?: string; nosCompartilhados?: DriverNode[]; ordem?: number } = {}
): LinhaReceita {
  const prefixo = opts.prefixoCustos ?? "cv";
  const somaId = idsCustosVariaveis(prefixo).soma;
  const p = (s: string) => `sku_${sku.id}_${s}`;

  return {
    id: `sku_${sku.id}`,
    nome: `${sku.nome} [${sku.um}]`,
    template: "agro_insumo",
    nodeRaiz: p("receita"),
    ordem: opts.ordem,
    nodes: [
      ...(opts.nosCompartilhados ?? []),
      no({
        id: p("volume"),
        tipo: "serie",
        nome: `Volume vendido — ${sku.nome} [${sku.um}]`,
        unidade: "#",
        papel: "quantidade",
        params: { valorMensal: sku.volumeMensal ?? 0 },
      }),
      no({
        id: p("custo"),
        tipo: "preco",
        nome: `Custo unitário — ${sku.nome} [${sku.um}]`,
        unidade: "R$/un",
        params: { valorMensal: sku.custoUnitario ?? 0 },
      }),
      // Preço DERIVADO: sobe o custo pela pilha. Se a soma chegar a 1 (100%),
      // o preço é indefinido — o motor devolve 0 na divisão por zero e o check
      // de plausibilidade da tela acusa.
      no({
        id: p("preco"),
        tipo: "formula",
        nome: `Preço de venda — ${sku.nome} [${sku.um}]`,
        unidade: "R$/un",
        params: { expr: `${p("custo")} / (1 - ${somaId})` },
      }),
      no({
        id: p("receita"),
        tipo: "formula",
        nome: `Memória de Cálculo — ${sku.nome} [${sku.um}]`,
        unidade: "R$",
        params: { expr: `${p("volume")} * ${p("preco")}` },
      }),
    ],
  };
}

/**
 * Linha de GRÃO de revenda: volume em kg, preço por saca de 60 kg.
 * Mantém o volume na unidade em que o negócio controla (kg) e converte na
 * fórmula — a planilha faz o mesmo com o divisor 60 embutido.
 */
export function montarLinhaGraos(
  grao: { id: string; nome: string; volumeKgMensal?: number; precoSaca?: number },
  opts: { ordem?: number } = {}
): LinhaReceita {
  const p = (s: string) => `grao_${grao.id}_${s}`;
  return {
    id: `grao_${grao.id}`,
    nome: `${grao.nome} (grão)`,
    template: "agro_graos",
    nodeRaiz: p("receita"),
    ordem: opts.ordem,
    nodes: [
      no({
        id: p("volume_kg"),
        tipo: "serie",
        nome: `Volume — ${grao.nome} [KG]`,
        unidade: "#",
        papel: "quantidade",
        params: { valorMensal: grao.volumeKgMensal ?? 0 },
      }),
      no({
        id: p("preco_saca"),
        tipo: "preco",
        nome: `Preço por saca — ${grao.nome}`,
        unidade: "R$/un",
        params: { valorMensal: grao.precoSaca ?? 0 },
      }),
      no({
        id: p("sacas"),
        tipo: "formula",
        nome: `Sacas — ${grao.nome} (${KG_POR_SACA} kg por saca)`,
        unidade: "#",
        params: { expr: `${p("volume_kg")} / ${KG_POR_SACA}` },
      }),
      no({
        id: p("receita"),
        tipo: "formula",
        nome: `Memória de Cálculo — ${grao.nome} (grão)`,
        unidade: "R$",
        params: { expr: `${p("sacas")} * ${p("preco_saca")}` },
      }),
    ],
  };
}

// ── Modo AGRUPADO ──────────────────────────────────────────────────────────

/**
 * Família comercial do modo Agrupado: a receita é digitada direto em R$.
 * A margem fica como nó (alimenta o custo derivado no bloco de custos e os
 * KPIs), mas não entra no cálculo da receita.
 */
export function montarLinhaFamiliaAgrupada(
  familia: { id: string; nome: string; receitaMensal?: number; margem?: number },
  opts: { ordem?: number } = {}
): LinhaReceita {
  const p = (s: string) => `fam_${familia.id}_${s}`;
  return {
    id: `fam_${familia.id}`,
    nome: familia.nome,
    template: "agro_agrupado",
    nodeRaiz: p("receita"),
    ordem: opts.ordem,
    nodes: [
      no({
        id: p("margem"),
        tipo: "taxa",
        nome: `Margem bruta — ${familia.nome}`,
        unidade: "%",
        params: { valorMensal: familia.margem ?? 0, max: 1 },
      }),
      no({
        id: p("receita"),
        tipo: "serie",
        nome: `Memória de Cálculo — ${familia.nome}`,
        unidade: "R$",
        params: { valorMensal: familia.receitaMensal ?? 0 },
      }),
    ],
  };
}

// ── BARTER ─────────────────────────────────────────────────────────────────

export interface ConfigBarter {
  /** Nó (ou linha) cuja receita é a base trocada por grão. */
  receitaBaseRef: string;
  /** Fração da venda liquidada em grão (0,25 = 25%). */
  pctBarter?: number;
  /** Split por cultura — deve somar 1. */
  culturas: Array<{
    id: string;
    nome: string;
    /** Fração do barter nesta cultura. */
    split: number;
    /** Preço da saca pago AO PRODUTOR (converte R$ em sacas). */
    precoProdutor?: number;
    /** Preço da saca obtido na TRADING (converte sacas de volta em R$). */
    precoTrading?: number;
  }>;
}

/**
 * Operação de barter: uma linha por cultura. A receita da linha é o valor das
 * sacas recebidas avaliadas ao preço de trading — o ganho da operação é o
 * spread trading − produtor.
 *
 * Atenção ao sinal econômico: estas linhas SOMAM receita, e a parcela da venda
 * liquidada em grão deve ser retirada da receita em dinheiro (a planilha faz
 * isso com `Receita Produtor - (R$) = total × %financeiro`). Quem monta o
 * bloco é responsável por essa complementaridade — ver montarBlocoAgro.
 */
export function montarLinhasBarter(cfg: ConfigBarter, opts: { ordem?: number } = {}): LinhaReceita[] {
  const pctId = "barter_pct";
  return cfg.culturas.map((c, i) => {
    const p = (s: string) => `barter_${c.id}_${s}`;
    const compartilhados: DriverNode[] =
      i === 0
        ? [
            no({
              id: pctId,
              tipo: "taxa",
              nome: "Parcela das vendas liquidada em grão (barter)",
              unidade: "%",
              params: { valorMensal: cfg.pctBarter ?? 0, max: 1 },
            }),
          ]
        : [];

    return {
      id: `barter_${c.id}`,
      nome: `Barter — ${c.nome}`,
      template: "agro_barter",
      nodeRaiz: p("receita"),
      ordem: (opts.ordem ?? 0) + i,
      nodes: [
        ...compartilhados,
        no({
          id: p("split"),
          tipo: "taxa",
          nome: `Participação do barter em ${c.nome}`,
          unidade: "%",
          params: { valorMensal: c.split, max: 1 },
        }),
        no({
          id: p("preco_produtor"),
          tipo: "preco",
          nome: `Preço da saca pago ao produtor — ${c.nome}`,
          unidade: "R$/un",
          params: { valorMensal: c.precoProdutor ?? 0 },
        }),
        no({
          id: p("preco_trading"),
          tipo: "preco",
          nome: `Preço da saca na trading — ${c.nome}`,
          unidade: "R$/un",
          params: { valorMensal: c.precoTrading ?? 0 },
        }),
        // R$ ÷ (R$/un) = un — a análise dimensional garante que isto fecha em sacas.
        no({
          id: p("sacas"),
          tipo: "formula",
          nome: `Sacas recebidas — ${c.nome}`,
          unidade: "#",
          params: {
            expr: `${cfg.receitaBaseRef} * ${pctId} * ${p("split")} / ${p("preco_produtor")}`,
          },
        }),
        no({
          id: p("receita"),
          tipo: "formula",
          nome: `Memória de Cálculo — Barter ${c.nome}`,
          unidade: "R$",
          params: { expr: `${p("sacas")} * ${p("preco_trading")}` },
        }),
      ],
    };
  });
}

// ── Montador do bloco inteiro ──────────────────────────────────────────────

export interface OpcoesBlocoAgro {
  modo: "detalhado" | "agrupado";
  skus?: SkuAgro[];
  familias?: Array<{ id: string; nome: string; receitaMensal?: number; margem?: number }>;
  graos?: Array<{ id: string; nome: string; volumeKgMensal?: number; precoSaca?: number }>;
  custosVariaveis?: Partial<Record<string, number>>;
  barter?: Omit<ConfigBarter, "receitaBaseRef"> & { receitaBaseRef?: string };
}

/**
 * Monta o conjunto de linhas de receita do bloco agro.
 *
 * No modo detalhado, os nós compartilhados da pilha de custos variáveis são
 * pendurados na primeira linha (espaço de nomes global do motor).
 */
export function montarBlocoAgro(opts: OpcoesBlocoAgro): LinhaReceita[] {
  const linhas: LinhaReceita[] = [];

  if (opts.modo === "detalhado") {
    const skus = opts.skus ?? SKUS_INSUMOS_PADRAO;
    const compartilhados = montarCustosVariaveis("cv", opts.custosVariaveis);
    skus.forEach((sku, i) => {
      linhas.push(
        montarLinhaInsumoDetalhado(sku, {
          prefixoCustos: "cv",
          nosCompartilhados: i === 0 ? compartilhados : undefined,
          ordem: i,
        })
      );
    });
  } else {
    const familias = opts.familias ?? FAMILIAS_AGRUPADO_PADRAO;
    familias.forEach((f, i) => linhas.push(montarLinhaFamiliaAgrupada(f, { ordem: i })));
  }

  const base = linhas.length;
  (opts.graos ?? []).forEach((g, i) => linhas.push(montarLinhaGraos(g, { ordem: base + i })));

  if (opts.barter && opts.barter.culturas.length > 0) {
    // Sem base explícita, o barter incide sobre a receita da primeira linha.
    const receitaBaseRef = opts.barter.receitaBaseRef ?? linhas[0]?.nodeRaiz;
    if (receitaBaseRef) {
      linhas.push(
        ...montarLinhasBarter(
          { ...opts.barter, receitaBaseRef },
          { ordem: linhas.length }
        )
      );
    }
  }

  return linhas;
}

/** Soma dos splits do barter — deve fechar em 1 (check da tela). */
export function splitBarterFecha(cfg: Pick<ConfigBarter, "culturas">): boolean {
  const soma = cfg.culturas.reduce((a, c) => a + (c.split || 0), 0);
  return Math.abs(soma - 1) < 1e-9;
}
