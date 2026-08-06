/**
 * VISÃO POR UNIDADE (F1 do orçamento dimensional, 25/07/2026).
 *
 * Deriva a DRE por unidade de negócio a partir da DRE CONSOLIDADA do motor +
 * as etiquetas (unidade/centro de custo) das linhas + a estrutura organizacional
 * da empresa. Decisões de desenho (do usuário):
 *
 *  - CC pertence a UMA unidade; CC SEM unidade é COMPARTILHADO (CSC) e o custo
 *    dele é RATEADO entre as unidades pelo critério do CC (pesos manuais ou
 *    proporcional à receita direta de cada unidade no mês).
 *  - O CONSOLIDADO é o próprio modelo — a visão por unidade é derivada, e a
 *    prova de partição garante: Σ unidades + não atribuído = consolidado, ao
 *    centavo, todo mês.
 *  - A visão vai até o EBITDA. Depreciação, juros e IR são da EMPRESA (decisão
 *    de financiamento e apuração fiscal), não da filial — abaixo do EBITDA é
 *    leitura consolidada.
 *  - Linha sem etiqueta não é chutada para lugar nenhum: cai em "Não atribuído",
 *    visível, para o analista etiquetar — nada entra em silêncio.
 *
 * Puro e determinístico: sem I/O, sem IA (padrão model-engine).
 */
import { LinhaDre, Serie } from "./model-engine";

// ── Tipos ──────────────────────────────────────────────────────────────────

export interface UnidadeDim {
  id: string;
  nome: string;
  ehMatriz?: boolean;
  ativo?: boolean;
}

export interface RateioCC {
  driver: "manual" | "receita";
  /** driver manual: fração por unidade (normalizada aqui — não precisa somar 1). */
  pesos?: Record<string, number>;
}

export interface CentroCustoDim {
  id: string;
  nome: string;
  /** null = compartilhado (CSC) — rateia entre as unidades. */
  unidadeId: string | null;
  rateio?: RateioCC | null;
  ativo?: boolean;
}

/** Etiqueta de uma linha do modelo (gravada na config do bloco). */
export interface TagLinha {
  unidadeId?: string | null;
  centroCustoId?: string | null;
}

export interface LinhaUnidade {
  id: string;
  nome: string;
  grupo: "receita" | "custos" | "despesas";
  valores: Serie;
  /** "direta" = etiquetada nesta unidade · "rateio" = fatia de CC compartilhado. */
  origem: "direta" | "rateio";
  /** Nome do CC (quando a linha chegou por um CC — direto ou compartilhado). */
  centroCusto?: string;
}

export interface DreUnidade {
  unidadeId: string;
  nome: string;
  linhas: LinhaUnidade[];
  receita: Serie;
  custos: Serie;
  despesas: Serie;
  /** Fatia recebida dos CCs compartilhados (já dentro de custos/despesas). */
  rateioRecebido: Serie;
  ebitda: Serie;
}

export interface ResultadoPorUnidade {
  unidades: DreUnidade[];
  /** Linhas de valor sem etiqueta — visíveis, nunca distribuídas em silêncio. */
  naoAtribuido: { linhas: LinhaUnidade[]; receita: Serie; custos: Serie; despesas: Serie; ebitda: Serie };
  /** Prova de partição: Σ unidades + não atribuído = consolidado, por mês. */
  provaParticao: { ok: boolean; maiorDiferenca: number; mesDaDiferenca: string | null };
  avisos: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

const zero = (): Serie => ({});

function somar(dest: Serie, src: Serie | undefined, fator = 1): void {
  if (!src) return;
  for (const [m, v] of Object.entries(src)) {
    if (Number.isFinite(v)) dest[m] = (dest[m] ?? 0) + v * fator;
  }
}

/** Normaliza pesos manuais sobre as unidades ATIVAS presentes na estrutura. */
export function pesosManuais(cc: CentroCustoDim, unidades: UnidadeDim[]): Record<string, number> {
  const ativos = unidades.filter((u) => u.ativo !== false);
  const brutos = ativos
    .map((u) => [u.id, Math.max(0, cc.rateio?.pesos?.[u.id] ?? 0)] as const)
    .filter(([, p]) => p > 0);
  const total = brutos.reduce((s, [, p]) => s + p, 0);
  if (total <= 0) {
    // Sem pesos declarados: divide igual — declarado no aviso, nunca em silêncio.
    const igual = ativos.length > 0 ? 1 / ativos.length : 0;
    return Object.fromEntries(ativos.map((u) => [u.id, igual]));
  }
  return Object.fromEntries(brutos.map(([id, p]) => [id, p / total]));
}

/**
 * Pesos do rateio por RECEITA num mês: fração da receita DIRETA de cada unidade.
 * Mês sem receita direta nenhuma cai em partes iguais (o custo do CSC existe
 * mesmo no mês sem faturamento — sumir com ele quebraria a prova de partição).
 */
export function pesosPorReceita(
  receitaPorUnidade: Map<string, Serie>,
  unidades: UnidadeDim[],
  mes: string,
): Record<string, number> {
  const ativos = unidades.filter((u) => u.ativo !== false);
  const brutos = ativos.map((u) => [u.id, Math.max(0, receitaPorUnidade.get(u.id)?.[mes] ?? 0)] as const);
  const total = brutos.reduce((s, [, v]) => s + v, 0);
  if (total <= 0) {
    const igual = ativos.length > 0 ? 1 / ativos.length : 0;
    return Object.fromEntries(ativos.map((u) => [u.id, igual]));
  }
  return Object.fromEntries(brutos.map(([id, v]) => [id, v / total]));
}

// ── Folha por unidade (F2) ─────────────────────────────────────────────────

/** Posição do bloco Pessoas, no mínimo que a decomposição precisa. */
export interface PosicaoDim {
  id: string;
  nome: string;
  classificacao: "custo" | "despesa";
  unidadeId?: string | null;
  centroCustoId?: string | null;
}

const normNome = (s: string): string =>
  (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * DECOMPÕE A FOLHA nas posições etiquetadas, ANTES da distribuição por unidade.
 *
 * O motor dobra a folha inteira numa linha só — "folha-custos"/"folha-despesas",
 * ou SOMADA na conta canônica ("Custo Operacional"/"Despesas com Pessoas") — e
 * uma linha agregada não tem unidade. Mas o motor também emite a série de custo
 * POR POSIÇÃO (`series["folha_<id>_custo"]`); aqui cada posição etiquetada vira
 * uma pseudo-linha própria (`pos:<id>`, com a etiqueta dela) e o valor sai da
 * linha agregada, que fica com o RESTO (premissa da linha + posições sem
 * etiqueta). Soma preservada por construção — a prova de partição continua
 * valendo ao centavo.
 */
export function decomporFolha(
  dre: LinhaDre[],
  posicoes: PosicaoDim[],
  series: Record<string, Serie>,
): { dre: LinhaDre[]; tagsExtras: Record<string, TagLinha> } {
  const etiquetadas = posicoes.filter((p) => p.unidadeId || p.centroCustoId);
  if (etiquetadas.length === 0) return { dre, tagsExtras: {} };

  // A MESMA regra de destino do motor: linha própria da folha, senão a canônica.
  const alvoDe = (classificacao: "custo" | "despesa", linhas: LinhaDre[]): LinhaDre | undefined => {
    const grupo = classificacao === "custo" ? "custos" : "despesas";
    const idProprio = classificacao === "custo" ? "folha-custos" : "folha-despesas";
    const nomeCanonico = classificacao === "custo" ? "custo operacional" : "despesas com pessoas";
    return (
      linhas.find((l) => l.id === idProprio) ??
      linhas.find((l) => l.grupo === grupo && normNome(l.nome) === nomeCanonico)
    );
  };

  const saida: LinhaDre[] = dre.map((l) => ({ ...l, valores: { ...l.valores } }));
  const tagsExtras: Record<string, TagLinha> = {};
  const idxEbitda = saida.findIndex((l) => l.id === "ebitda");

  for (const pos of etiquetadas) {
    const custoPos = series[`folha_${pos.id}_custo`];
    if (!custoPos || !Object.values(custoPos).some((v) => v !== 0)) continue;
    const alvo = alvoDe(pos.classificacao, saida);
    if (!alvo) continue; // folha não dobrou em linha nenhuma — nada a decompor

    // Subtrai da linha agregada e emite a pseudo-linha da posição.
    for (const [m, v] of Object.entries(custoPos)) {
      alvo.valores[m] = (alvo.valores[m] ?? 0) - v;
    }
    const pseudo: LinhaDre = {
      id: `pos:${pos.id}`,
      nome: `Folha — ${pos.nome}`,
      grupo: pos.classificacao === "custo" ? "custos" : "despesas",
      valores: { ...custoPos },
      pctReceita: {},
    };
    // Entra ANTES do EBITDA (dentro do corte da visão por unidade).
    saida.splice(idxEbitda >= 0 ? idxEbitda : saida.length, 0, pseudo);
    tagsExtras[pseudo.id] = { unidadeId: pos.unidadeId ?? null, centroCustoId: pos.centroCustoId ?? null };
  }
  return { dre: saida, tagsExtras };
}

// ── Trava de edição por responsável (F4) ───────────────────────────────────

/** Config de bloco no mínimo que a trava precisa (linhas e posições). */
interface ConfigComLinhas {
  linhasReceita?: Array<{ id: string; unidadeId?: string | null; centroCustoId?: string | null }>;
  linhasCusto?: Array<{ id: string; unidadeId?: string | null; centroCustoId?: string | null }>;
  posicoes?: Array<{ id: string; unidadeId?: string | null; centroCustoId?: string | null }>;
  [k: string]: unknown;
}

/**
 * F4 — colaboração por área: um usuário RESPONSÁVEL por unidade(s) edita SÓ as
 * linhas/posições das suas unidades. Devolve a lista de violações (vazia = pode
 * salvar). Regras:
 *  - linha cuja unidade resolvida (direta ou via CC) NÃO é do usuário: nem
 *    alterar, nem criar, nem excluir;
 *  - linha sem etiqueta ou de CC COMPARTILHADO é corporativa — fora do escopo
 *    do responsável;
 *  - mudanças fora das linhas (campos do bloco: deduções, sazonalidade, tabela
 *    de encargos…) são corporativas — bloqueadas;
 *  - mudar a PRÓPRIA etiqueta de unidade é mudar de dono — bloqueado (isso é
 *    decisão de quem consolida).
 */
export function validarEdicaoRestrita(
  configAntes: ConfigComLinhas,
  configDepois: ConfigComLinhas,
  unidadesDoUsuario: Set<string>,
  centros: CentroCustoDim[],
): string[] {
  const porCc = new Map(centros.map((c) => [c.id, c]));
  const unidadeDe = (l: { unidadeId?: string | null; centroCustoId?: string | null }): string | null => {
    if (l.centroCustoId) return porCc.get(l.centroCustoId)?.unidadeId ?? null; // CSC → null (corporativo)
    return l.unidadeId ?? null;
  };
  const violacoes: string[] = [];
  const j = (v: unknown) => JSON.stringify(v ?? null);

  for (const chave of ["linhasReceita", "linhasCusto", "posicoes"] as const) {
    const antes = new Map((configAntes[chave] ?? []).map((l) => [l.id, l]));
    const depois = new Map((configDepois[chave] ?? []).map((l) => [l.id, l]));
    for (const [id, ld] of depois) {
      const la = antes.get(id);
      if (!la) {
        const u = unidadeDe(ld);
        if (!u || !unidadesDoUsuario.has(u)) violacoes.push(`criar linha fora das suas unidades (${id})`);
        continue;
      }
      if (j(la) === j(ld)) continue; // inalterada
      const uAntes = unidadeDe(la);
      const uDepois = unidadeDe(ld);
      if (uAntes !== uDepois) { violacoes.push(`mudar a unidade/CC de uma linha (${id}) — decisão de quem consolida`); continue; }
      if (!uAntes || !unidadesDoUsuario.has(uAntes)) violacoes.push(`alterar linha fora das suas unidades (${id})`);
    }
    for (const [id, la] of antes) {
      if (depois.has(id)) continue;
      const u = unidadeDe(la);
      if (!u || !unidadesDoUsuario.has(u)) violacoes.push(`excluir linha fora das suas unidades (${id})`);
    }
  }

  // Campos do bloco FORA das linhas: corporativos.
  const semLinhas = (c: ConfigComLinhas) => {
    const { linhasReceita, linhasCusto, posicoes, ...resto } = c;
    void linhasReceita; void linhasCusto; void posicoes;
    return resto;
  };
  if (j(semLinhas(configAntes)) !== j(semLinhas(configDepois))) {
    violacoes.push("alterar configuração do bloco fora das linhas (deduções, curvas, encargos…) — corporativo");
  }
  return violacoes;
}

// ── Motor ──────────────────────────────────────────────────────────────────

export function calcularPorUnidade(input: {
  /** DRE consolidada do motor (linhas + subtotais). */
  dre: LinhaDre[];
  /** Etiqueta por id de linha (vinda da config dos blocos). */
  tags: Record<string, TagLinha>;
  unidades: UnidadeDim[];
  centros: CentroCustoDim[];
  meses: string[];
}): ResultadoPorUnidade {
  const { dre, tags, meses } = input;
  const unidades = input.unidades.filter((u) => u.ativo !== false);
  const centros = new Map(input.centros.map((c) => [c.id, c]));
  const avisos: string[] = [];

  // Só o que está ACIMA do EBITDA entra na partição: a cascata do motor empurra
  // depreciação, juros, não operacionais e IR DEPOIS da linha "ebitda", e esses
  // são da empresa, não da filial. O corte é pela POSIÇÃO (a ordem da cascata é
  // contrato do motor), porque "grupo" não distingue — depreciação também sai
  // como "despesas".
  const idxEbitda = dre.findIndex((l) => l.id === "ebitda");
  const acimaDoEbitda = idxEbitda >= 0 ? dre.slice(0, idxEbitda) : dre;
  // Só linhas de VALOR (as de config); subtotais ficam de fora — são derivados,
  // e derivado se recalcula, não se rateia. ABERTURAS fiscais também ficam de
  // fora (05/08/2026): o valor delas já está dentro do total "(−) Impostos
  // sobre a receita"/"(−) Deduções", que é rateado — particioná-las de novo
  // descontava o imposto DUAS vezes por unidade e quebrava a prova de partição.
  const linhasValor = acimaDoEbitda.filter((l) => l.grupo !== "subtotal" && !(l as { abertura?: boolean }).abertura);

  /** Resolve o destino da linha: unidade direta, CC compartilhado ou nada. */
  function destinoDe(linhaId: string): { unidadeId: string | null; cc: CentroCustoDim | null } {
    const tag = tags[linhaId];
    if (!tag) return { unidadeId: null, cc: null };
    if (tag.centroCustoId) {
      const cc = centros.get(tag.centroCustoId) ?? null;
      if (!cc) return { unidadeId: tag.unidadeId ?? null, cc: null };
      // CC com unidade: a linha é da unidade do CC (o CC só refina a leitura).
      // CC sem unidade: compartilhado — rateia.
      return { unidadeId: cc.unidadeId, cc };
    }
    return { unidadeId: tag.unidadeId ?? null, cc: null };
  }

  // ── Passo 1: receita DIRETA por unidade (base do driver "receita") ──
  const receitaPorUnidade = new Map<string, Serie>(unidades.map((u) => [u.id, zero()]));
  for (const l of linhasValor) {
    if (l.grupo !== "receita") continue;
    const { unidadeId, cc } = destinoDe(l.id);
    if (unidadeId && !ccCompartilhado(cc)) somar(receitaPorUnidade.get(unidadeId)!, l.valores);
  }

  function ccCompartilhado(cc: CentroCustoDim | null): boolean {
    return !!cc && cc.unidadeId === null;
  }

  // ── Passo 2: distribui cada linha ──
  const porUnidade = new Map<string, DreUnidade>(
    unidades.map((u) => [u.id, {
      unidadeId: u.id, nome: u.nome, linhas: [],
      receita: zero(), custos: zero(), despesas: zero(), rateioRecebido: zero(), ebitda: zero(),
    }]),
  );
  const naoAtribuido = { linhas: [] as LinhaUnidade[], receita: zero(), custos: zero(), despesas: zero(), ebitda: zero() };
  let temRateioSemPesos = false;

  // Deduções e impostos sobre a receita são linhas do MOTOR (% da receita) —
  // não têm etiqueta e nunca terão. Rateio automático proporcional à receita
  // direta de cada unidade: é exatamente a regra pela qual nascem, então a
  // alocação é exata, não palpite.
  const RATEIO_AUTOMATICO_POR_RECEITA = new Set(["deducoes-receita", "impostos-receita"]);
  // Sem NENHUMA receita etiquetada, o rateio automático não tem base — essas
  // linhas caem em "Não atribuído" junto com a receita, em vez de espalhar
  // imposto por unidades que não mostram faturamento.
  const temReceitaEtiquetada = [...receitaPorUnidade.values()].some((s) => Object.values(s).some((v) => v > 0));

  for (const l of linhasValor) {
    const grupo = l.grupo as LinhaUnidade["grupo"];

    if (RATEIO_AUTOMATICO_POR_RECEITA.has(l.id) && temReceitaEtiquetada) {
      for (const u of unidades) {
        const alvo = porUnidade.get(u.id)!;
        const fatia: Serie = {};
        for (const m of meses) {
          const v = l.valores?.[m] ?? 0;
          if (v === 0) continue;
          const peso = pesosPorReceita(receitaPorUnidade, unidades, m)[u.id] ?? 0;
          if (peso > 0) fatia[m] = v * peso;
        }
        if (Object.keys(fatia).length === 0) continue;
        alvo.linhas.push({ id: `${l.id}@${u.id}`, nome: l.nome, grupo, valores: fatia, origem: "rateio", centroCusto: "proporcional à receita" });
        somar(alvo[grupo === "receita" ? "receita" : grupo], fatia);
      }
      continue;
    }

    const { unidadeId, cc } = destinoDe(l.id);

    if (cc && ccCompartilhado(cc)) {
      // CSC: rateia a série da linha entre as unidades, mês a mês.
      const driver = cc.rateio?.driver ?? "manual";
      if (driver === "manual" && !cc.rateio?.pesos) temRateioSemPesos = true;
      const fixos = driver === "manual" ? pesosManuais(cc, unidades) : null;
      for (const u of unidades) {
        const alvo = porUnidade.get(u.id)!;
        const fatia: Serie = {};
        for (const m of meses) {
          const v = l.valores?.[m] ?? 0;
          if (v === 0) continue;
          const peso = fixos ? (fixos[u.id] ?? 0) : (pesosPorReceita(receitaPorUnidade, unidades, m)[u.id] ?? 0);
          if (peso > 0) fatia[m] = v * peso;
        }
        if (Object.keys(fatia).length === 0) continue;
        alvo.linhas.push({ id: `${l.id}@${u.id}`, nome: l.nome, grupo, valores: fatia, origem: "rateio", centroCusto: cc.nome });
        somar(alvo[grupo === "receita" ? "receita" : grupo], fatia);
        if (grupo !== "receita") somar(alvo.rateioRecebido, fatia);
      }
      continue;
    }

    const alvo = unidadeId ? porUnidade.get(unidadeId) : null;
    if (alvo) {
      alvo.linhas.push({ id: l.id, nome: l.nome, grupo, valores: { ...l.valores }, origem: "direta", centroCusto: cc?.nome });
      somar(alvo[grupo === "receita" ? "receita" : grupo], l.valores);
    } else {
      naoAtribuido.linhas.push({ id: l.id, nome: l.nome, grupo, valores: { ...l.valores }, origem: "direta" });
      somar(naoAtribuido[grupo === "receita" ? "receita" : grupo], l.valores);
    }
  }

  // ── Passo 3: EBITDA por unidade + prova de partição ──
  const ebitdaDe = (r: Serie, c: Serie, d: Serie): Serie => {
    const out: Serie = {};
    for (const m of meses) out[m] = (r[m] ?? 0) - (c[m] ?? 0) - (d[m] ?? 0);
    return out;
  };
  for (const u of porUnidade.values()) u.ebitda = ebitdaDe(u.receita, u.custos, u.despesas);
  naoAtribuido.ebitda = ebitdaDe(naoAtribuido.receita, naoAtribuido.custos, naoAtribuido.despesas);

  // Prova: Σ (unidades + não atribuído) = EBITDA consolidado do motor, por mês.
  const ebitdaConsolidado = dre.find((l) => l.id === "ebitda")?.valores ?? {};
  let maiorDif = 0;
  let mesDif: string | null = null;
  for (const m of meses) {
    let soma = naoAtribuido.ebitda[m] ?? 0;
    for (const u of porUnidade.values()) soma += u.ebitda[m] ?? 0;
    const dif = Math.abs(soma - (ebitdaConsolidado[m] ?? 0));
    if (dif > maiorDif) { maiorDif = dif; mesDif = m; }
  }
  const provaOk = maiorDif < 0.01; // ao centavo
  if (!provaOk) {
    avisos.push(`A soma das unidades diverge do consolidado em até R$ ${maiorDif.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} (${mesDif}) — verifique etiquetas duplicadas ou CC apontando para unidade inativa.`);
  }

  const totalLinhas = linhasValor.length;
  const semTag = naoAtribuido.linhas.length;
  if (semTag > 0) {
    avisos.push(`${semTag} de ${totalLinhas} linha(s) sem unidade/CC — estão em "Não atribuído". Etiquete-as para a visão por unidade ficar completa.`);
  }
  if (temRateioSemPesos) {
    avisos.push("Há CC compartilhado com rateio manual sem pesos declarados — dividido em partes iguais até você definir os pesos.");
  }
  avisos.push("A visão por unidade vai até o EBITDA: depreciação, juros e impostos são da empresa (consolidado), não da filial.");

  return {
    unidades: [...porUnidade.values()],
    naoAtribuido,
    provaParticao: { ok: provaOk, maiorDiferenca: maiorDif, mesDaDiferenca: mesDif },
    avisos,
  };
}
