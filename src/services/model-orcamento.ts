/**
 * ORÇAMENTO CONGELADO e ORÇADO × REALIZADO (B12 do PLANO_VALUATION_ORCAMENTO.md).
 *
 * Função pura, sem I/O (padrão model-engine): recebe o snapshot congelado + o
 * resultado vivo do modelo, devolve as variações por linha nas quatro faixas de
 * comparação da planilha de referência (Belagro).
 *
 * Origem do desenho: engenharia reversa da aba "Orçado x Realizado" do
 * Business Plan da Belagro (ver PLANO_BUSINESS_PLAN_BELAGRO.md, Parte 3).
 * A planilha soma uma JANELA de meses (OFFSET+HLOOKUP sobre os índices das
 * linhas 12/13) e compara com a MESMA janela 12 meses atrás.
 *
 * CORREÇÕES DELIBERADAS vs. a planilha (decisão de 19/07/2026 — "corrigir com
 * prova", ver Parte 4 do plano). Cada uma tem id em DIVERGENCIAS_PLANILHA:
 *  - a planilha devolve o texto "n.d" na variação absoluta de linhas percentuais;
 *    aqui a variação absoluta é `null` (ausência de valor, não string num campo
 *    numérico) e a variação percentual é a diferença em PONTOS.
 *  - a planilha divide por zero devolvendo 0 (IFERROR); aqui base zero devolve
 *    `null` e a UI mostra "—" (0% e "não calculável" são coisas diferentes).
 *
 * Determinístico: zero IA aqui.
 */
import { LinhaDre, Serie, mesAdd, RealizadoModelo } from "./model-engine";

// ── Tipos ──────────────────────────────────────────────────────────────────

/** Janela de meses inclusiva, "YYYY-MM". */
export interface Janela {
  de: string;
  ate: string;
}

/**
 * Orçamento CONGELADO: fotografia versionada da projeção num instante.
 * Política da casa: nunca deletar, substituir — cada congelamento é uma versão
 * nova, com autor, data e o cenário que estava ativo.
 */
export interface SnapshotOrcamento {
  id: string;
  nome: string;
  /** ISO. */
  criadoEm: string;
  /** Cenário ativo no momento do congelamento (selo do CFI). */
  cenario: string;
  mesInicial: string;
  horizonteMeses: number;
  /**
   * PROVENIÊNCIA DA ESTRUTURA (05/08/2026). O congelamento sempre foi imune a
   * alteração posterior — os números são clonados. Mas era ANÔNIMO: ninguém
   * conseguia responder "contra qual versão do modelo de DRE/BP este orçamento
   * foi montado?". Com a política da casa de versionar dicionário, DRE e BP
   * justamente para o passado não se mexer, faltava carimbar QUAL versão valia.
   *
   * Não muda número nenhum — acrescenta a etiqueta que torna o número
   * defensável seis meses depois.
   */
  estrutura?: {
    /** Versão do modelo de DRE/BP vigente no congelamento e de ONDE ela veio
     *  (o modelo é copy-on-write por empresa: "global" e "empresa" são versões
     *  diferentes). Mesmo formato de `getActiveModelVersions`, que o IBR já usa
     *  — a etiqueta do orçamento passa a ser comparável com a da análise. */
    dre: number | null;
    bp: number | null;
    dreEscopo: "global" | "empresa" | null;
    bpEscopo: "global" | "empresa" | null;
  };
  /** DRE congelada — mesma forma da saída do motor. */
  dre: LinhaDre[];
  bp?: LinhaDre[];
  fc?: LinhaDre[];
}

/** Uma comparação (orçado × realizado) numa janela. */
export interface Comparacao {
  orcado: number;
  realizado: number;
  /** null quando a linha é percentual (não faz sentido somar pontos). */
  varAbs: number | null;
  /** Linha de valor: variação relativa. Linha percentual: diferença em PONTOS.
   *  null quando a base é zero (não calculável ≠ zero). */
  varPct: number | null;
}

/** Comparação entre duas janelas do MESMO lado (orçado×orçado, real×real). */
export interface ComparacaoTemporal {
  atual: number;
  anterior: number;
  varAbs: number | null;
  varPct: number | null;
}

export type Semaforo = "verde" | "amarelo" | "vermelho" | "neutro";

export interface LinhaVariacao {
  id: string;
  nome: string;
  grupo: LinhaDre["grupo"];
  /** "valor" = R$ (soma na janela) · "percentual" = margem (recalculada na janela). */
  tipo: "valor" | "percentual";
  /**
   * O lado "realizado" desta linha veio de valor OBSERVADO (balancete) ou é a
   * própria projeção do modelo?
   *
   * Sem isto, uma linha sem observação apareceria como "Realizado" carregando o
   * número projetado — exatamente o tipo de mentira silenciosa que este módulo
   * existe para eliminar. A tela mostra as não observadas como referência, não
   * como realizado.
   */
  observado: boolean;
  /** Faixa 1 — janela corrente. */
  periodo: Comparacao;
  /** Faixa 2 — mesma janela, 12 meses atrás. */
  periodoAnterior: Comparacao;
  /** Faixa 3 — orçado corrente × orçado de 12 meses atrás. */
  orcadoVsAnterior: ComparacaoTemporal;
  /** Faixa 4 — realizado corrente × realizado de 12 meses atrás. */
  realizadoVsAnterior: ComparacaoTemporal;
  /** Semáforo da faixa 1, já considerando a DIREÇÃO do grupo. */
  semaforo: Semaforo;
}

export interface ResultadoOrcadoRealizado {
  janela: Janela;
  janelaAnterior: Janela;
  /** Meses da janela corrente que já estão fechados (realizado observado). */
  mesesFechados: string[];
  /** Meses da janela corrente ainda projetados — a comparação é parcial. */
  mesesProjetados: string[];
  linhas: LinhaVariacao[];
  /** Sempre devolvidos: verde só com prova. */
  avisos: string[];
}

export interface OrcadoRealizadoInput {
  snapshot: SnapshotOrcamento;
  /** DRE viva do motor (projeção do cenário ativo). */
  dreRealizada: LinhaDre[];
  /** Selo por mês vindo do motor. */
  statusMes: Record<string, "real" | "proj">;
  /**
   * Realizado observado (balancete). Quando presente, é ELE que forma o lado
   * "realizado" nos meses fechados — o motor projeta, não observa (por decisão
   * de produto ele mantém a premissa em todos os meses e guarda o realizado
   * como referência). Sem isto, a comparação seria orçado × projetado.
   */
  realizado?: RealizadoModelo | null;
  janela: Janela;
  /** Tolerância do semáforo amarelo (fração; default 5%). */
  toleranciaAmarelo?: number;
  /** Acima disso, vermelho (fração; default 10%). */
  toleranciaVermelho?: number;
}

// ── Divergências conhecidas vs. a planilha de referência ───────────────────

/**
 * Catálogo das correções aplicadas neste motor em relação ao comportamento da
 * planilha Belagro. Alimenta o painel de reconciliação (a "prova" da decisão
 * de corrigir em vez de replicar o defeito).
 */
export const DIVERGENCIAS_PLANILHA: Array<{ id: string; onde: string; planilha: string; motor: string }> = [
  {
    id: "orcrea-nd-textual",
    onde: "Orçado x Realizado, colunas de variação absoluta das linhas de margem",
    planilha: 'Devolve a string "n.d" numa coluna numérica.',
    motor: "Variação absoluta é null (ausência), e a variação percentual carrega a diferença em pontos.",
  },
  {
    id: "orcrea-divisao-zero",
    onde: "Orçado x Realizado, todas as colunas de variação %",
    planilha: "IFERROR(...,0) — base zero vira 0%, indistinguível de uma variação real de 0%.",
    motor: 'Base zero devolve null; a tela mostra "—".',
  },
  {
    id: "orcrea-janela-parcial",
    onde: "Orçado x Realizado, janela que inclui meses ainda não fechados",
    planilha: "Compara silenciosamente, somando meses projetados como se fossem realizados.",
    motor: "Compara e AVISA quais meses da janela ainda são projeção.",
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

/** Lista inclusiva de meses da janela. Janela invertida devolve vazio. */
export function mesesDaJanela(j: Janela): string[] {
  if (j.de > j.ate) return [];
  const out: string[] = [];
  let m = j.de;
  // Guarda de sanidade: horizonte de 100 anos é erro de entrada, não laço infinito.
  for (let i = 0; i < 1200 && m <= j.ate; i++) {
    out.push(m);
    m = mesAdd(m, 1);
  }
  return out;
}

/** A mesma janela deslocada 12 meses para trás (EOMONTH(x,-13)+1 da planilha). */
export function janelaAnteriorDe(j: Janela): Janela {
  return { de: mesAdd(j.de, -12), ate: mesAdd(j.ate, -12) };
}

function somaJanela(valores: Serie | undefined, meses: string[]): number {
  let t = 0;
  for (const m of meses) t += valores?.[m] ?? 0;
  return t;
}

/**
 * Uma linha é PERCENTUAL quando representa uma margem/índice — somar os meses
 * não significa nada. Detectado pelo nome (a DRE do motor não carrega unidade
 * por linha), da mesma forma que a planilha marca com [%] na coluna G.
 */
export function ehLinhaPercentual(nome: string): boolean {
  return /\(%\)|margem|%\s*$/i.test(nome || "");
}

/** Variação relativa protegida: base zero é "não calculável", não zero. */
function varRelativa(atual: number, base: number): number | null {
  if (base === 0) return null;
  return (atual - base) / Math.abs(base);
}

function comparar(orcado: number, realizado: number, percentual: boolean): Comparacao {
  if (percentual) {
    // Diferença em PONTOS percentuais; absoluto não se aplica.
    return { orcado, realizado, varAbs: null, varPct: realizado - orcado };
  }
  return { orcado, realizado, varAbs: realizado - orcado, varPct: varRelativa(realizado, orcado) };
}

function compararTemporal(atual: number, anterior: number, percentual: boolean): ComparacaoTemporal {
  if (percentual) return { atual, anterior, varAbs: null, varPct: atual - anterior };
  return { atual, anterior, varAbs: atual - anterior, varPct: varRelativa(atual, anterior) };
}

/** Subtotais que são CUSTO apesar de o motor classificá-los como "subtotal". */
const SUBTOTAIS_DE_CUSTO = new Set([
  "custos-total",
  "despesas-total",
  "desp-naoop-total",
  "depreciacao-total",
  "juros-divida",
  "irpj-csll",
  "impostos-total",
]);

/**
 * A linha piora quando SOBE?
 *
 * Não basta olhar `grupo`: o motor emite os subtotais de custo com
 * `grupo: "subtotal"` (ex.: "(−) Custos", id `custos-total`), e tratá-los como
 * lucro inverteria o semáforo — gastar menos que o orçado apareceria vermelho.
 * Por isso a decisão combina grupo, id conhecido e o prefixo "(−)" que o motor
 * usa para marcar linha redutora.
 */
export function ehLinhaDeCusto(id: string, nome: string, grupo: LinhaDre["grupo"]): boolean {
  if (grupo === "custos" || grupo === "despesas") return true;
  if (SUBTOTAIS_DE_CUSTO.has(id)) return true;
  return /^\s*\(\s*[−-]\s*\)/.test(nome || "");
}

/**
 * Direção do desvio: numa linha de RECEITA ou de resultado (Lucro Bruto,
 * EBITDA…), realizado acima do orçado é bom; numa linha de custo/despesa, é
 * ruim. Desvio favorável nunca acende alerta, por maior que seja.
 */
function semaforoDe(
  c: Comparacao,
  linha: { id: string; nome: string; grupo: LinhaDre["grupo"] },
  amarelo: number,
  vermelho: number
): Semaforo {
  const desvio = c.varPct;
  if (desvio === null) return "neutro";
  const ruimSeSobe = ehLinhaDeCusto(linha.id, linha.nome, linha.grupo);
  const desfavoravel = ruimSeSobe ? desvio : -desvio;
  if (desfavoravel <= amarelo) return "verde";
  if (desfavoravel <= vermelho) return "amarelo";
  return "vermelho";
}

/**
 * Recalcula uma linha percentual NA JANELA: a margem do período é a razão dos
 * agregados, nunca a média das margens mensais (a planilha erra isto ao usar
 * AVERAGEIF nos totais anuais). Sem a linha-base, cai no valor do último mês.
 */
function valorPercentualNaJanela(linha: LinhaDre, meses: string[]): number {
  if (meses.length === 0) return 0;
  // A DRE do motor já traz pctReceita por mês; a margem do período é
  // Σ(valor) ÷ Σ(receita), reconstruída a partir de valor e pctReceita.
  let somaValor = 0;
  let somaReceita = 0;
  let temReceita = false;
  for (const m of meses) {
    const v = linha.valores?.[m] ?? 0;
    const p = linha.pctReceita?.[m];
    somaValor += v;
    if (p !== undefined && p !== 0) {
      somaReceita += v / p;
      temReceita = true;
    }
  }
  if (temReceita && somaReceita !== 0) return somaValor / somaReceita;
  // Fallback: média simples dos meses com valor (melhor que devolver 0 mudo).
  const comValor = meses.filter((m) => (linha.valores?.[m] ?? 0) !== 0);
  if (comValor.length === 0) return 0;
  return comValor.reduce((a, m) => a + (linha.valores?.[m] ?? 0), 0) / comValor.length;
}

function valorNaJanela(linha: LinhaDre, meses: string[], percentual: boolean): number {
  return percentual ? valorPercentualNaJanela(linha, meses) : somaJanela(linha.valores, meses);
}

/**
 * Séries OBSERVADAS por id de linha da DRE, a partir do realizado do balancete.
 *
 * `porLinha` (acoplamento conta↔linha) manda quando existe. Sem ele, os totais
 * por grupo cobrem os três subtotais principais, e os dois subtotais derivados
 * (Lucro Bruto e EBITDA) saem da mesma aritmética do motor — assim a linha do
 * resultado também é observada, não projetada.
 */
function seriesObservadas(realizado: RealizadoModelo | null | undefined): Map<string, Serie> {
  const out = new Map<string, Serie>();
  if (!realizado) return out;

  for (const [linhaId, serie] of Object.entries(realizado.porLinha ?? {})) out.set(linhaId, serie);

  const g = realizado.porGrupo ?? {};
  const porGrupoId: Array<[string, Serie | undefined]> = [
    ["receita-total", g.receita],
    ["custos-total", g.custos],
    ["despesas-total", g.despesas],
  ];
  for (const [id, serie] of porGrupoId) if (serie && !out.has(id)) out.set(id, serie);

  // Subtotais derivados: mesma conta que o motor faz (receita − custos, e daí
  // menos despesas). Só quando as parcelas existem — senão a linha fica sem
  // observação e a tela diz isso.
  const rec = out.get("receita-total");
  const cus = out.get("custos-total");
  const des = out.get("despesas-total");
  const mesesObs = realizado.meses ?? [];
  if (rec && cus && !out.has("lucro-bruto")) {
    const lb: Serie = {};
    for (const m of mesesObs) lb[m] = (rec[m] ?? 0) - (cus[m] ?? 0);
    out.set("lucro-bruto", lb);
  }
  const lb = out.get("lucro-bruto");
  if (lb && des && !out.has("ebitda")) {
    const eb: Serie = {};
    for (const m of mesesObs) eb[m] = (lb[m] ?? 0) - (des[m] ?? 0);
    out.set("ebitda", eb);
  }
  return out;
}

// ── Motor ──────────────────────────────────────────────────────────────────

/**
 * Compara o orçamento congelado com o realizado/projetado vivo, nas quatro
 * faixas da planilha de referência.
 */
export function calcularOrcadoRealizado(input: OrcadoRealizadoInput): ResultadoOrcadoRealizado {
  const { snapshot, dreRealizada, statusMes, janela } = input;
  const amarelo = input.toleranciaAmarelo ?? 0.05;
  const vermelho = input.toleranciaVermelho ?? 0.1;

  const janelaAnterior = janelaAnteriorDe(janela);
  const meses = mesesDaJanela(janela);
  const mesesAnt = mesesDaJanela(janelaAnterior);

  const avisos: string[] = [];
  if (janela.de > janela.ate) avisos.push("Período inválido: o mês inicial é posterior ao mês final.");

  // Mês fechado = tem observação no balancete. O selo do motor é usado só como
  // fallback (ele projeta em todos os meses por decisão de produto).
  const observadas = seriesObservadas(input.realizado);
  const mesesComObservacao = new Set(input.realizado?.meses ?? []);
  const ehFechado = (m: string) => (mesesComObservacao.size > 0 ? mesesComObservacao.has(m) : statusMes[m] === "real");
  const mesesFechados = meses.filter(ehFechado);
  const mesesProjetados = meses.filter((m) => !ehFechado(m));
  if (mesesProjetados.length > 0 && mesesFechados.length > 0) {
    avisos.push(
      `A janela tem ${mesesProjetados.length} ${mesesProjetados.length === 1 ? "mês ainda projetado" : "meses ainda projetados"} (${mesesProjetados[0]}${mesesProjetados.length > 1 ? ` … ${mesesProjetados[mesesProjetados.length - 1]}` : ""}) — a comparação é parcial.`
    );
  } else if (mesesFechados.length === 0 && meses.length > 0) {
    avisos.push("Nenhum mês da janela está fechado — a comparação é entre orçado e projetado, não realizado.");
  }

  // Indexa o realizado por id de linha; o snapshot manda na ordem e no rótulo
  // (é ele o documento congelado).
  const realPorId = new Map(dreRealizada.map((l) => [l.id, l]));
  const vazia: LinhaDre = { id: "", nome: "", grupo: "subtotal", valores: {}, pctReceita: {} };

  const linhas: LinhaVariacao[] = snapshot.dre.map((orc) => {
    const percentual = ehLinhaPercentual(orc.nome);
    const obs = observadas.get(orc.id);

    // Lado "realizado": observação do balancete quando existe; senão a projeção
    // do motor — e a linha sai marcada como NÃO observada.
    const observado = !!obs && mesesFechados.length > 0;
    const real: LinhaDre = observado
      ? { id: orc.id, nome: orc.nome, grupo: orc.grupo, valores: obs!, pctReceita: {} }
      : (realPorId.get(orc.id) ?? vazia);

    const periodo = comparar(
      valorNaJanela(orc, meses, percentual),
      valorNaJanela(real, meses, percentual),
      percentual
    );
    const periodoAnterior = comparar(
      valorNaJanela(orc, mesesAnt, percentual),
      valorNaJanela(real, mesesAnt, percentual),
      percentual
    );

    return {
      id: orc.id,
      nome: orc.nome,
      grupo: orc.grupo,
      tipo: percentual ? "percentual" : "valor",
      observado,
      periodo,
      periodoAnterior,
      orcadoVsAnterior: compararTemporal(periodo.orcado, periodoAnterior.orcado, percentual),
      realizadoVsAnterior: compararTemporal(periodo.realizado, periodoAnterior.realizado, percentual),
      // Semáforo só faz sentido contra observação: comparar orçado com a própria
      // projeção sempre daria verde e induziria a leitura errada.
      semaforo: observado ? semaforoDe(periodo, orc, amarelo, vermelho) : "neutro",
    };
  });

  // Linhas que existem no realizado e sumiram do snapshot: o orçamento
  // congelado não as previa. Avisar em vez de omitir silenciosamente — é
  // exatamente o modo de falha registrado no Claude Log da planilha.
  const idsSnapshot = new Set(snapshot.dre.map((l) => l.id));
  // Linhas ESTRUTURAIS da cascata ficam fora do aviso (05/08/2026): a DRE
  // passou a ter sempre Receita líquida/impostos/IRPJ — snapshot congelado
  // antes dessa mudança não as tem, e o aviso trataria um subtotal que o
  // MOTOR criou como se fosse conta imprevista, em toda abertura da tela.
  const ESTRUTURAIS = new Set(["receita-liquida", "impostos-receita", "irpj-csll", "deducoes-receita", "lucro-liquido"]);
  const novas = dreRealizada.filter((l) => !idsSnapshot.has(l.id) && !ESTRUTURAIS.has(l.id) && somaJanela(l.valores, meses) !== 0);
  if (novas.length > 0) {
    avisos.push(
      `${novas.length} ${novas.length === 1 ? "linha existe" : "linhas existem"} no realizado e não ${novas.length === 1 ? "estava" : "estavam"} no orçamento congelado: ${novas.map((l) => l.nome).join(", ")}.`
    );
  }

  // Linhas sem observação: dizer, em vez de exibir projeção como se fosse
  // realizado (era esse o silêncio que quebrava a conciliação na planilha).
  const semObs = linhas.filter((l) => !l.observado);
  if (mesesFechados.length > 0 && semObs.length > 0) {
    avisos.push(
      `${semObs.length} de ${linhas.length} linhas não têm valor observado no balancete — nelas a coluna "Realizado" traz a projeção do modelo, e o semáforo fica neutro. Acople as contas ao modelo para comparar linha a linha.`
    );
  }

  return { janela, janelaAnterior, mesesFechados, mesesProjetados, linhas, avisos };
}

/** Congela o resultado vivo do motor numa versão nova do orçamento. */
export function congelarOrcamento(params: {
  id: string;
  nome: string;
  cenario: string;
  mesInicial: string;
  horizonteMeses: number;
  dre: LinhaDre[];
  bp?: LinhaDre[];
  fc?: LinhaDre[];
  criadoEm?: string;
  estrutura?: SnapshotOrcamento["estrutura"];
}): SnapshotOrcamento {
  return {
    id: params.id,
    nome: params.nome,
    criadoEm: params.criadoEm ?? new Date().toISOString(),
    cenario: params.cenario,
    mesInicial: params.mesInicial,
    horizonteMeses: params.horizonteMeses,
    ...(params.estrutura ? { estrutura: params.estrutura } : {}),
    // Clona: o snapshot não pode mudar quando o modelo vivo mudar.
    dre: JSON.parse(JSON.stringify(params.dre)) as LinhaDre[],
    bp: params.bp ? (JSON.parse(JSON.stringify(params.bp)) as LinhaDre[]) : undefined,
    fc: params.fc ? (JSON.parse(JSON.stringify(params.fc)) as LinhaDre[]) : undefined,
  };
}
