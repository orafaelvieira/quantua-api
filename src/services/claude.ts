import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";
import { calcCusto, modeloAnaliseId, createWithRetry, type CustoIA } from "./ai-extraction";
import type { PeerComparisonRow } from "./peer-benchmark";
import { INDICADORES_TEMPLATE } from "./financial-templates";
import { calcularValorCanonico, type AlavancaValor, type ValorCanonico } from "./valor-na-mesa";
import { calcularContaRegressiva } from "./conta-regressiva";

// tipoDado por nome de indicador (template) — formata os números do prompt na unidade
// final ("39,0%", "45 dias") para a IA nunca confundir fração com percentual.
const TIPO_DADO_INDICADOR: Record<string, string> = Object.fromEntries(
  INDICADORES_TEMPLATE.map((t) => [t.nome, t.tipoDado]),
);
function fmtValorIndicador(nome: string, v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "-";
  switch (TIPO_DADO_INDICADOR[nome]) {
    case "%": return `${(v * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
    case "Dias": return `${Math.round(v).toLocaleString("pt-BR")} dias`;
    case "R$": return `R$ ${v.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}`;
    default: return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}

const client = new Anthropic({ apiKey: env.anthropicApiKey });

export interface AnalysisResult {
  kpis: {
    receita:          { valor: number; variacao: number; status: "ok" | "atencao" | "critico" };
    margemBruta:      { valor: number; variacao: number; status: "ok" | "atencao" | "critico" };
    ebitda:           { valor: number; variacao: number; status: "ok" | "atencao" | "critico" };
    margemEbitda:     { valor: number; variacao: number; status: "ok" | "atencao" | "critico" };
    liquidezCorrente: { valor: number; variacao: number; status: "ok" | "atencao" | "critico" };
    endividamento:    { valor: number; variacao: number; status: "ok" | "atencao" | "critico" };
    roe:              { valor: number; variacao: number; status: "ok" | "atencao" | "critico" };
    roa:              { valor: number; variacao: number; status: "ok" | "atencao" | "critico" };
  };
  capitalDeGiro?: number;
  liquidezSeca?: number;
  margemLiquida?: number;
  divLiqEbitda?: number;
  coberturaJuros?: number;
  dreData: Array<{ mes: string; receita: number; custos: number; bruto: number; operacional: number; liquido: number }>;
  semaforo: Array<{ area: string; status: "ok" | "atencao" | "critico"; descricao: string }>;
  recomendacoes: Array<{ titulo: string; prioridade: "Alta" | "Média" | "Baixa"; impacto: string; esforco: string; horizonte: string; descricao: string }>;
  swot: { forcas: string[]; fraquezas: string[]; oportunidades: string[]; riscos: string[] };
  confianca: number;
  destaques: string[];
  /** Opções estratégicas já classificadas nos 4 pilares estratégicos. Semeiam a aba
   *  "Opções estratégicas"; o analista pode adicionar/editar/excluir depois. */
  opcoesEstrategicas?: Array<{
    pillar: "strategic_repositioning" | "value_focused_business_model" | "operational_excellence" | "financial_restructuring";
    title: string;
    description: string;
    estimatedImpactBRL?: number;
    horizonMonths?: number;
    effort: "low" | "medium" | "high";
    priority: "p0" | "p1" | "p2";
    /** Como a IA chegou no impacto em R$ (base de cálculo / premissa) — transparência. */
    impactoRacional?: string;
  }>;
  /** Aviso quando o período analisado é curto demais (1 período) para leitura assertiva. */
  avisoPeriodo?: string | null;
  /** DIAGNÓSTICO de IBR (camada rica) — leitura universal (empresa boa, estável ou sob pressão).
   *  solidez = eixo 2 do motor (trio Fleuriet/Kanitz/Altman) — presente quando calculável. */
  estagioCicloVida?: { estagio: string; justificativa: string; solidez?: import("./estagio-ciclo").SolidezResult };
  situacao?: { classificacao: string; racional: string };
  saudeFinanceira?: { status: string; mesesDeCaixa: number | null; leitura: string; diasDeCaixa?: number | null };
  /** Conta regressiva de caixa — quanto tempo o dinheiro dura (motor, determinística). */
  contaRegressiva?: import("./conta-regressiva").ContaRegressiva;
  fatoresChave?: Array<{
    fator: string;
    hipotese: string;
    natureza: "interna" | "externa" | "mista" | string;
    evidencia: string;
    confianca: "alta" | "media" | "baixa" | string;
    verificar: string;
  }>;
  /** REVELAÇÕES — o "não tinha noção disso": descobertas que exigem cruzamento de fontes,
   *  quantificadas em DINHEIRO EM CAIXA. O coração do diferencial do IBR. */
  revelacoes?: Array<{
    titulo: string;
    dadoEscondido: string;
    porQueInvisivel: string;
    valorEmCaixa: number | null;
    comoChegou: string;
    perguntaAmanha: string;
  }>;
  /** Placar agregado: quanto dinheiro está na mesa (sem dupla contagem).
   *  alavancas = detalhamento auditável: origem "motor" (canônicas, determinísticas —
   *  gaps vs mediana dos pares) + "analise" (específicas, estimadas pela IA). */
  valorNaMesa?: {
    total: number; caixaLiberavel: number; margemRecuperavel: number; leitura: string;
    alavancas?: AlavancaValor[];
    base?: { segmento: string | null; periodo: string | null };
  };
  /** O que PROTEGER — forças que sustentam o resultado e como blindá-las. */
  protecoes?: Array<{ oQueProteger: string; ameaca: string; acaoDefensiva: string }>;
  /** Confronto declarado×observado: cada dor julgada pelos números. Só com dores preenchidas. */
  confrontoDores?: Array<{ dor: string; veredicto: "confirmada" | "desmentida" | "parcial" | string; evidencia: string; leitura: string }>;
  /** Número ruim SEM dor declarada — ninguém na empresa está olhando. Só com dores preenchidas. */
  pontosCegos?: Array<{ titulo: string; evidencia: string; porQueImporta: string; acaoSugerida: string }>;
  /** Apresentação da empresa em TEXTO CORRIDO (15-20 linhas): quem é, história, o que faz,
   *  modelo de negócio e momento. Abre a Análise Estratégica no PDF. Sem tópicos, sem fontes. */
  perfilEmpresa?: string;
}

interface IndicadorLite {
  nome: string;
  valores: Record<string, number | string | null>;
  status?: Record<string, "ok" | "atencao" | "critico" | null>;
  /** "%" | "Índice" | "Dias" | "R$" | "Texto" — unidade do indicador (motor). */
  tipoDado?: string;
}

const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Monta os 8 KPIs + métricas secundárias a partir dos indicadores DETERMINÍSTICOS (a IA
 *  NÃO recalcula). Razão→pontos percentuais nos KPIs de %; EBITDA = Margem EBITDA ×
 *  Receita Líquida (ambos indicadores); variação = mudança relativa vs período anterior. */
/** Ordena períodos cronologicamente: "31/12/2022" ou "2022" → chave numérica. */
function ordPeriodo(p: string): number {
  const m = p.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return Number(`${m[3]}${m[2]}${m[1]}`);
  const y = p.match(/\d{4}/);
  return y ? Number(`${y[0]}0000`) : 0;
}

/** Renomeações de indicador — IBRs antigos guardam o nome anterior em dadosEstruturados;
 *  a busca tenta o nome novo e cai no antigo (regerar análise de IBR antigo segue OK). */
const NOME_ANTIGO_INDICADOR: Record<string, string> = {
  "Margem EBITDA": "Margem Operacional",
  "Dívida Líquida/EBITDA": "Dívida Líquida/Lucro Operacional",
  "Capital de Terceiros + Partes Relacionadas": "Capital de Terceiros",
  "Situação de Liquidez (Fleuriet)": "Situação da empresa",
};
function achaIndicador(indicadores: IndicadorLite[], nome: string): IndicadorLite | undefined {
  return indicadores.find((i) => i.nome === nome)
    ?? (NOME_ANTIGO_INDICADOR[nome] ? indicadores.find((i) => i.nome === NOME_ANTIGO_INDICADOR[nome]) : undefined);
}

function kpisDeterministicos(indicadores: IndicadorLite[], periodos: string[]) {
  const ord = [...periodos].sort((a, b) => ordPeriodo(a) - ordPeriodo(b)); // mais recente por último
  const ult = ord[ord.length - 1], ant = ord[ord.length - 2];
  const ind = (nome: string) => achaIndicador(indicadores, nome);
  const raw = (nome: string, p?: string) => { const i = ind(nome); return i && p ? numOf(i.valores[p]) : null; };
  const stat = (nome: string): "ok" | "atencao" | "critico" => { const i = ind(nome); return (i && ult ? i.status?.[ult] : null) ?? "atencao"; };
  const variOf = (a: number | null, b: number | null) => (a != null && b != null && b !== 0 ? ((a - b) / Math.abs(b)) * 100 : 0);
  const ebitdaDe = (p?: string) => { const rec = raw("Receita Líquida", p), mop = raw("Margem EBITDA", p); return rec != null && mop != null ? mop * rec : null; };

  const MAP: Record<string, { nome: string; pct: boolean }> = {
    receita: { nome: "Receita Líquida", pct: false },
    margemBruta: { nome: "Margem Bruta", pct: true },
    margemEbitda: { nome: "Margem EBITDA", pct: true },
    liquidezCorrente: { nome: "Liquidez Corrente", pct: false },
    endividamento: { nome: "Endividamento Geral", pct: false },
    roe: { nome: "ROE (Retorno sobre Patrimônio Líquido)", pct: true },
    roa: { nome: "ROA (Retorno sobre Ativos)", pct: true },
  };
  const mk = (key: string) => {
    const m = MAP[key];
    const r = raw(m.nome, ult);
    const valor = r == null ? 0 : (m.pct ? r * 100 : r);
    return { valor, variacao: variOf(raw(m.nome, ult), raw(m.nome, ant)) || 0, status: stat(m.nome) };
  };
  const ebitda = (() => {
    const e = ebitdaDe(ult);
    return { valor: e ?? 0, variacao: variOf(e, ebitdaDe(ant)) || 0, status: stat("Margem EBITDA") };
  })();

  const kpis = {
    receita: mk("receita"), margemBruta: mk("margemBruta"), ebitda,
    margemEbitda: mk("margemEbitda"), liquidezCorrente: mk("liquidezCorrente"),
    endividamento: mk("endividamento"), roe: mk("roe"), roa: mk("roa"),
  };
  const margemLiq = raw("Margem Líquida", ult);
  const sec = {
    capitalDeGiro: raw("Capital de Giro", ult) ?? undefined,
    liquidezSeca: raw("Liquidez Seca", ult) ?? undefined,
    margemLiquida: margemLiq == null ? undefined : margemLiq * 100,
    divLiqEbitda: raw("Dívida Líquida / EBITDA", ult) ?? raw("Dívida Líquida/EBITDA", ult) ?? undefined,
    coberturaJuros: raw("Índice de Cobertura de Juros", ult) ?? raw("Cobertura de Juros", ult) ?? undefined,
  };
  // Tabela de fatos para o prompt — valores JÁ NA UNIDADE FINAL pelo tipoDado do
  // indicador. Antes iam crus (toFixed(4)): "Crescimento da Receita = 0.3900" levou a
  // IA a escrever "0,39%" quando o real era 39% (flagrado na Move Farma). Percentual
  // vai multiplicado e com símbolo; texto (Fleuriet) agora também entra.
  const fmtFato = (v: number | string | null | undefined, tipoDado?: string): string => {
    if (typeof v === "string") return v.trim() || "-";
    if (typeof v !== "number" || !Number.isFinite(v)) return "-";
    switch (tipoDado) {
      case "%": return `${(v * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
      case "Dias": return `${Math.round(v).toLocaleString("pt-BR")} dias`;
      case "R$": return `R$ ${v.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}`;
      case "Índice": return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      default: return v.toLocaleString("pt-BR", { maximumFractionDigits: 4 });
    }
  };
  const tabela = indicadores
    .filter((i) => periodos.some((p) => i.valores[p] != null && i.valores[p] !== ""))
    .map((i) => `${i.nome}: ${periodos.map((p) => `${p}=${fmtFato(i.valores[p], i.tipoDado)}`).join(" · ")}`)
    .join("\n");
  return { kpis, ...sec, tabela };
}

// Estágio do ciclo: motor extraído para ./estagio-ciclo (2 eixos: Dickinson robusto
// com materialidade+persistência × SOLIDEZ pelo trio Fleuriet/Kanitz/Altman).
export { classifyEstagio, type EstagioResult, type FluxoCaixaLite, type SolidezResult } from "./estagio-ciclo";
import { classifyEstagio, type EstagioResult, type FluxoCaixaLite } from "./estagio-ciclo";

interface PeerBlockInput {
  year: number | null;
  periodo?: string | null; // "1T26 (LTM)" — fonte CVM
  segment: string | null;
  coverage: "direta" | "aproximada" | "ausente";
  rows: PeerComparisonRow[];
  external: Array<{ indicador: string; referencia: number; fonte: string; higherIsBetter: boolean }>;
}

/** Formata as LINHAS DA DRE (estrutura de custo/resultado) pro prompt — base da árvore
 *  de custos do pilar Operacional (onde a margem se perde). Vazio se não houver. */
function buildDreBlock(dre?: Array<{ conta: string; valores: Record<string, number>; subtotal?: boolean }> | null, periodos?: string[]): string {
  if (!dre || dre.length === 0) return "";
  const ps = periodos && periodos.length ? periodos : Object.keys(dre[0]?.valores ?? {});
  const linhas = dre
    .filter((l) => ps.some((p) => typeof l.valores[p] === "number"))
    .map((l) => {
      const vals = ps.map((p) => `${p}=${typeof l.valores[p] === "number" ? Math.round(l.valores[p]).toLocaleString("pt-BR") : "-"}`).join(" · ");
      return `${l.subtotal ? "» " : "- "}${l.conta}: ${vals}`;
    })
    .join("\n");
  if (!linhas) return "";
  return `
LINHAS DA DRE (valores em R$ por período; "»" = subtotal — use para a árvore de custos e a ponte margem bruta→operacional):
${linhas}`;
}

/** Formata o FLUXO DE CAIXA INDIRETO pro prompt — a ponte lucro→caixa (para onde o
 *  dinheiro FOI) é a maior fonte de revelações. Só entra quando a prova FECHA. */
function buildFluxoCaixaBlock(fc?: FluxoCaixaLite & { fco?: Array<{ nome: string; valores: Record<string, number> }>; fci?: Array<{ nome: string; valores: Record<string, number> }>; fcf?: Array<{ nome: string; valores: Record<string, number> }> } | null): string {
  if (!fc || !fc.colunas?.length) return "";
  const provaOk = (fc.prova ?? []).length > 0 && (fc.prova ?? []).every((p) => p.fecha);
  if (!provaOk) return "";
  const fmtL = (l: { nome: string; valores: Record<string, number> }) =>
    `- ${l.nome}: ${fc.colunas.map((c) => `${c}=${Math.round(l.valores[c] ?? 0).toLocaleString("pt-BR")}`).join(" · ")}`;
  const tot = (nome: string, t: Record<string, number>) =>
    `» ${nome}: ${fc.colunas.map((c) => `${c}=${Math.round(t[c] ?? 0).toLocaleString("pt-BR")}`).join(" · ")}`;
  const linhas = [
    ...(fc.fco ?? []).map(fmtL), tot("FCO — Fluxo de Caixa Operacional", fc.totais.fco),
    ...(fc.fci ?? []).map(fmtL), tot("FCI — Fluxo de Caixa de Investimento", fc.totais.fci),
    ...(fc.fcf ?? []).map(fmtL), tot("FCF — Fluxo de Caixa de Financiamento", fc.totais.fcf),
  ].join("\n");
  return `

[FC] FLUXO DE CAIXA — MÉTODO INDIRETO (determinístico, PROVADO contra o ΔCaixa do balanço; cada coluna = variação vs período anterior, em R$):
${linhas}
Use este bloco para contar PARA ONDE O DINHEIRO FOI — a ponte lucro→caixa (lucro que virou estoque/prazo, dívida que financiou queima, capex engolindo geração) é onde nascem as maiores revelações.`;
}

/** Dor declarada pelo dono/gestão na entrevista (input humano, tela "Dores"). */
export interface DorDeclarada { categoria: string; descricao: string; severidade: string }

/** Formata o bloco de DORES DECLARADAS pro prompt — a metade humana do confronto
 *  declarado×observado. Vazio se não houver. */
function buildDoresBlock(dores?: DorDeclarada[] | null): string {
  if (!dores || dores.length === 0) return "";
  const linhas = dores.map((d) => `- [${d.categoria} · severidade ${d.severidade}] ${d.descricao}`).join("\n");
  return `

[5] DORES DECLARADAS pelo dono/gestão na entrevista (percepção DELES — não é fato contábil):
${linhas}
CONFRONTO OBRIGATÓRIO declarado×observado — para CADA dor, os números confirmam, desmentem ou nuançam? E o inverso: número RUIM sem dor declarada = PONTO CEGO (ninguém na empresa está olhando — o achado mais valioso). Use também as dores como contexto dos fatoresChave e das revelações.`;
}

/** Formata o bloco dos MATERIAIS COMPLEMENTARES (Input 4) pro prompt — resumos de
 *  docs não-financeiros (notas de reunião, apresentações). Vazio se não houver. */
function buildMateriaisBlock(materiais?: Array<{ nome: string; resumo: string }> | null): string {
  if (!materiais || materiais.length === 0) return "";
  const blocos = materiais.map((m) => `• ${m.nome}:\n${m.resumo}`).join("\n");
  return `
MATERIAIS COMPLEMENTARES (contexto qualitativo enviado pelo analista — notas de reunião, apresentações; use para SWOT, posicionamento, causas e opções; NÃO extrapole além do que está aqui):
${blocos}`;
}

/** Formata o bloco de contexto da WEB (Input 3) pro prompt. Vazio se não houver. */
function buildWebBlock(web?: { resumo: string; fontes: { titulo: string; url: string }[] } | null): string {
  if (!web || !web.resumo.trim()) return "";
  const fontes = web.fontes.slice(0, 8).map((f) => `- ${f.titulo}: ${f.url}`).join("\n");
  return `
CONTEXTO DA WEB (pesquisa de notícias/mercado sobre a empresa — use para SWOT, posicionamento e opções; NÃO extrapole além do que está aqui):
${web.resumo}
${fontes ? "Fontes:\n" + fontes + "\n" : ""}`;
}

/** Formata o bloco "Posicionamento vs Pares" (Benchmark Setorial B3) pro prompt.
 *  Inclui nota de cobertura e, quando a base interna não cobre, a referência
 *  setorial externa. Vazio quando não há nada comparável. */
function buildPeerBlock(peer?: PeerBlockInput | null): string {
  if (!peer || (peer.rows.length === 0 && peer.external.length === 0)) return "";
  const nivelLabel: Record<PeerComparisonRow["level"], string> = {
    subsetor: "subsetor", setor: "setor", classificacao: "classificação", mercado: "mercado",
  };
  const seg = peer.segment ? ` — ${peer.segment}` : "";
  const ano = peer.periodo ? `, pares @ ${peer.periodo} — fonte CVM` : peer.year ? `, ano ${peer.year}` : "";

  const nota =
    peer.coverage === "direta"
      ? "Cobertura: pares DIRETOS do subsetor na base."
      : peer.coverage === "aproximada"
      ? "Cobertura: SEM pares diretos no subsetor — comparação usa nível setor/classificação (par aproximado; trate como direcional)."
      : "Cobertura: SEM pares na base interna para este subsetor — sem referência interna. NÃO há percentil; use a referência externa da web (quando houver) + conhecimento do setor, e seja explícito de que não há pares diretos.";

  // Valores na UNIDADE FINAL pelo tipoDado do indicador (margem 0,12 → "12,0%"):
  // cru, a IA podia citar "0,12%" — mesmo bug do "0,39%" da tabela de fatos.
  const linhasInternas = peer.rows
    .map(
      (r) =>
        `- ${r.indicador}: empresa=${fmtValorIndicador(r.indicador, r.valor)} · mediana pares=${fmtValorIndicador(r.indicador, r.p50)} · faixa p25–p75=${fmtValorIndicador(r.indicador, r.p25)}–${fmtValorIndicador(r.indicador, r.p75)} · percentil=${r.percentil} · ${r.higherIsBetter ? "maior é melhor" : "menor é melhor"} · nível=${nivelLabel[r.level]} (n=${r.count})`,
    )
    .join("\n");
  const linhasExternas = peer.external
    .map(
      (e) =>
        `- ${e.indicador}: referência=${fmtValorIndicador(e.indicador, e.referencia)} · ${e.higherIsBetter ? "maior é melhor" : "menor é melhor"} · fonte=${e.fonte} (sem percentil)`,
    )
    .join("\n");

  return `
POSICIONAMENTO VS PARES (Benchmark Setorial B3${seg}${ano}):
${nota}
${linhasInternas ? linhasInternas + "\n" : ""}${linhasExternas ? "REFERÊNCIA EXTERNA (web):\n" + linhasExternas + "\n" : ""}`;
}

/**
 * Camada INTERPRETATIVA do IBR. Recebe os indicadores JÁ CALCULADOS (determinísticos) — a IA
 * não recalcula número nenhum, só interpreta. Roda no modelo escolhido (Workspace.aiAnalysisModel,
 * default sonnet) e devolve o custo da chamada. `peer` injeta o Benchmark Setorial (pares B3)
 * pra tornar o semáforo RELATIVO ao setor.
 */
export async function generateAnalysis(
  indicadores: IndicadorLite[],
  periodosBrutos: string[],
  empresa: { razaoSocial: string; setor: string; porte: string },
  periodo: string,
  modelKey?: string | null,
  peer?: PeerBlockInput | null,
  web?: { resumo: string; fontes: { titulo: string; url: string }[] } | null,
  materiais?: Array<{ nome: string; resumo: string }> | null,
  dre?: Array<{ conta: string; valores: Record<string, number>; subtotal?: boolean }> | null,
  fluxoCaixa?: FluxoCaixaLite | null,
  dores?: DorDeclarada[] | null,
  bp?: Array<{ conta: string; valores: Record<string, number> }> | null,
): Promise<{ result: AnalysisResult; custo: CustoIA }> {
  // Ordem CRONOLÓGICA uma vez, para TODO o prompt (séries de indicadores, bloco da DRE,
  // KPIs, estágio) — dados.periodos pode vir na ordem dos documentos (ex.: 2022, 2020, 2021).
  const periodos = [...periodosBrutos].sort((a, b) => ordPeriodo(a) - ordPeriodo(b));
  const model = modeloAnaliseId(modelKey);
  const det = kpisDeterministicos(indicadores, periodos);
  const peerBlock = buildPeerBlock(peer);
  const webBlock = buildWebBlock(web);
  const materiaisBlock = buildMateriaisBlock(materiais);
  const dreBlock = buildDreBlock(dre, periodos);
  const fcBlock = buildFluxoCaixaBlock(fluxoCaixa);
  const doresBlock = buildDoresBlock(dores);
  // Estágio DETERMINÍSTICO (motor, multi-ano; Dickinson quando o FC fecha) — a IA recebe
  // como fato e não reclassifica.
  const estagioDet = classifyEstagio(indicadores, periodos, fluxoCaixa);
  const nPeriodos = new Set(periodos).size;
  const periodoInsuficiente = nPeriodos < 2;
  // VALOR NA MESA — ESTRATO 1 (canônico/determinístico): gaps vs mediana dos pares.
  // Entra no prompt como FATO "já contado"; a IA só ADICIONA alavancas específicas.
  const canonico: ValorCanonico | null = calcularValorCanonico(
    indicadores, periodos, peer?.rows ?? [], dre ?? null,
    { segmento: peer?.segment ?? null, periodo: peer?.periodo ?? null },
  );
  const canonicoBlock = canonico && canonico.alavancas.length > 0
    ? `\nVALOR NA MESA — ALAVANCAS CANÔNICAS JÁ CALCULADAS PELO MOTOR (fatos; NÃO re-some, NÃO altere, NÃO repita nas adicionais):\n${canonico.alavancas.map((a) => `- [${a.tipo}] ${a.titulo}: R$ ${a.valor.toLocaleString("pt-BR")} — ${a.memoria}`).join("\n")}\nSubtotal canônico: caixa liberável R$ ${canonico.caixaLiberavel.toLocaleString("pt-BR")} · margem recuperável/ano R$ ${canonico.margemRecuperavelAno.toLocaleString("pt-BR")}.`
    : "";

  // CONTA REGRESSIVA de caixa (determinística): traduz o caixa em TEMPO — a
  // unidade que o dono entende. A IA recebe como FATO e não recalcula.
  const ultimoPeriodo = periodos[periodos.length - 1];
  const contaRegressiva = bp && dre && ultimoPeriodo
    ? calcularContaRegressiva(
        bp, dre as Array<{ conta: string; valores: Record<string, number> }>, ultimoPeriodo,
        fluxoCaixa?.totais?.fco?.[ultimoPeriodo] ?? null,
      )
    : null;
  const regressivaBlock = contaRegressiva
    ? `\nCONTA REGRESSIVA DE CAIXA (calculada pelo MOTOR — use como VERDADE, NÃO recalcule): ${contaRegressiva.leitura}`
    : "";
  const estagioBlock = estagioDet
    ? `\nESTÁGIO DO CICLO (determinado pelo MOTOR a partir do histórico — use como VERDADE, NÃO reclassifique): ${estagioDet.estagio}. ${estagioDet.justificativa}`
    : periodoInsuficiente
      ? `\nATENÇÃO — SÓ 1 PERÍODO: não há histórico para avaliar tendência. NÃO afirme crescimento/declínio; trate o estágio como "Indeterminado (período curto)" e seja explícito sobre a limitação em toda a leitura.`
      : "";

  const prompt = `Você é diretor de estratégia e líder de um Independent Business Review (IBR), com background de CFO e de private equity. Sua leitura é de nível INSTITUCIONAL — do tipo que um sócio, conselho, credor ou investidor usa para decidir. Profundidade, precisão e a CONEXÃO entre os dados são o diferencial.

A empresa pode estar em QUALQUER momento — crescendo bem, madura e estável, ou sob pressão. NÃO assuma crise POR PADRÃO; mas quando os números mostram aperto (caixa baixo, margem operacional negativa, dívida insustentável), NOMEIE a situação com honestidade — suavizar um problema real é um erro tão grave quanto exagerar um inexistente. ADAPTE a leitura ao estágio: empresa saudável recebe foco em crescer com rentabilidade, alocar capital e defender a posição; empresa sob pressão recebe foco em estabilizar e recuperar. O mesmo rigor serve para planejar o futuro de uma empresa boa e para virar o jogo de uma empresa em dificuldade.

Empresa: "${empresa.razaoSocial}" · Setor: ${empresa.setor} · Porte: ${empresa.porte} · Período analisado: ${periodo}

Você recebe VÁRIAS fontes. USE TODAS e CRUZE-AS — o valor está em conectar número → causa → contexto → ação:

[1] INDICADORES JÁ CALCULADOS E AUDITADOS (determinísticos — NÃO recalcule, apenas INTERPRETE):
${det.tabela || "(indicadores indisponíveis)"}
${dreBlock}${fcBlock}${peerBlock}${webBlock}${materiaisBlock}${doresBlock}${estagioBlock}${regressivaBlock}${canonicoBlock}

IMPORTANTE — olhe o HISTÓRICO: leia SEMPRE a evolução multi-ano (tendência entre os períodos), nunca um ano isolado. A força de um IBR está na trajetória.

MÉTODO DE RACIOCÍNIO (siga NESTA ordem — cada etapa condiciona a próxima):
1. ESTÁGIO DO CICLO: ${estagioDet ? "o MOTOR já determinou o estágio acima — USE-O como verdade e apenas explique-o à luz da trajetória; NÃO reclassifique." : "aplique estes CRITÉRIOS OBJETIVOS na ordem (o PRIMEIRO que casa vence), pela TENDÊNCIA multi-ano: Dificuldade de caixa (margem operacional < 0 E liquidez corrente < 1, ou caixa mínimo) → Retração (receita caindo 2+ períodos) → Crescimento (alta consistente com margem positiva) → Maturidade (estável, margem positiva, boa liquidez) → Platô (estagnada). NUNCA Platô/Maturidade com aperto de caixa ou margem operacional negativa."} O estágio condiciona TODA a leitura e o tom das opções.
2. SITUAÇÃO: leia o momento com honestidade — de "saudável" a "crise" —, indicando se a força/pressão nasce na OPERAÇÃO (margem/custo) ou na ESTRUTURA FINANCEIRA (capital/dívida/caixa).
3. SAÚDE FINANCEIRA × CAIXA: liquidez, dívida e geração de caixa são compatíveis com o estágio? Estime meses de caixa. Para empresa boa, avalie capacidade de investir/distribuir; para empresa apertada, avalie runway (sinalize se caixa < 3 meses).
4. FATORES-CHAVE (sempre HIPÓTESE, nunca afirmação — "a causa não está nas demonstrações"): os vetores que explicam o desempenho — POSITIVOS e negativos. Regra de natureza: indicador acima/abaixo E os pares no mesmo sentido → provável causa EXTERNA (mercado); divergente dos pares → provável causa INTERNA (gestão). Cada fator com evidência (número/par/fato), confiança e O QUE VERIFICAR (pergunta de entrevista ou documento a pedir).
5. OPÇÕES por LENTE analítica, condicionadas ao estágio: Reposicionamento → 5 Forças de Porter (rivalidade, entrantes, substitutos, poder de fornecedor e de cliente) ancoradas no contexto da web; Excelência Operacional → ÁRVORE DE CUSTOS da DRE (qual rubrica pesa na margem, da bruta para a operacional); Reestruturação/Estrutura Financeira → capital, dívida, liquidez, giro, alocação de caixa; Modelo de Negócio orientado a Valor → onde se CRIA e onde se CAPTURA valor (proposta, pricing, mix, canais).
6. REVELAÇÕES — a etapa mais importante. Depois do diagnóstico, garimpe 3 a 5 DESCOBERTAS que o dono provavelmente NÃO SABE. TESTE DO DONO (elimine o que falhar): se o dono do negócio provavelmente já sabe ("a margem caiu", "a dívida subiu", "o setor está difícil"), NÃO é revelação — descarte. Revelação de verdade EXIGE um CRUZAMENTO que ele não faz no dia a dia (≥2 fontes diferentes: DRE × fluxo de caixa, indicador × pares, ciclo financeiro × crescimento, trajetória multi-ano × caixa). Classes que costumam render: (a) a ponte lucro→caixa ("o lucro existiu mas virou estoque/prazo — para onde o dinheiro FOI"); (b) o custo em R$ de 1 dia de ciclo financeiro (receita/365 × dias) e quanto caixa 10-30 dias liberariam; (c) o contrafactual vs pares ("na mediana do setor, teriam sobrado +R$X no ano"); (d) crescimento que CONSOME caixa (NCG/receita — quanto cada R$1 de venda nova exige de giro); (e) trajetória projetada ("no ritmo dos últimos períodos, o caixa acaba/dobra em N meses"); (f) ativo parado ou estrutura ociosa quantificada. SEMPRE que possível, o valor da revelação em R$ DE CAIXA (não % abstrato), com a memória de cálculo — e a PERGUNTA que o dono deve fazer à equipe amanhã de manhã.

Retorne APENAS um JSON válido (sem markdown, sem \`\`\`) com EXATAMENTE esta estrutura. Evite REPETIR conteúdo entre seções — cada uma tem um papel distinto (veja as regras):
{
  "perfilEmpresa": "<apresentação da empresa em TEXTO CORRIDO de 15 a 20 linhas (2-3 parágrafos separados por \\n\\n): quem é, quando e como nasceu, o que faz e para quem, modelo de negócio e proposta de valor, canais/clientes, mercado e concorrência, momento atual. Escreva como NARRATIVA de abertura de relatório (o leitor vai conhecer a empresa antes das análises) — frases completas encadeadas, como se estivesse contando a história da empresa a um investidor. PROIBIDO: seções numeradas ('1) Dados cadastrais'), rótulos 'Campo: valor', separadores '|', listas, repetir minúcias cadastrais (CNPJ, CEP, código CNAE, tipo de natureza jurídica), recomendações de consulta (TJSP/Serasa) e citação de arquivos/fontes. Use a pesquisa web e os materiais como matéria-prima digerida, não como transcrição.>",
  "estagioCicloVida": { "estagio": "Crescimento|Maturidade|Platô|Retração|Dificuldade de caixa", "justificativa": "<1-2 frases citando a tendência dos números>" },
  "situacao": { "classificacao": "saudável|estável|atenção|pressão operacional|pressão financeira|dificuldade financeira", "racional": "<onde nasce a força ou a pressão (na operação ou na estrutura financeira), CONTANDO a trajetória do período e com cada indicador citado já explicado em linguagem de dono>" },
  "saudeFinanceira": { "status": "sólida|adequada|apertada|frágil", "mesesDeCaixa": <número ou null>, "leitura": "<quanto dinheiro há e por quanto tempo ele dura, o peso da dívida e o que isso permite ou exige agora; traduza cada indicador para dinheiro ou consequência prática, e termine com o que acontece se nada mudar>" },
  "fatoresChave": [ { "fator": "<vetor de desempenho, positivo ou negativo>", "hipotese": "<causa-raiz provável>", "natureza": "interna|externa|mista", "evidencia": "<número/par/fato>", "confianca": "alta|media|baixa", "verificar": "<o que perguntar/pedir>" } ],
  "semaforo": [
    { "area": "Receita e Crescimento", "status": "ok|atencao|critico", "descricao": "<1 frase citando número e percentil vs pares>" },
    { "area": "Margens Operacionais", "status": "ok|atencao|critico", "descricao": "<...>" },
    { "area": "Liquidez", "status": "ok|atencao|critico", "descricao": "<...>" },
    { "area": "Endividamento", "status": "ok|atencao|critico", "descricao": "<...>" },
    { "area": "Rentabilidade", "status": "ok|atencao|critico", "descricao": "<...>" },
    { "area": "Capital de Giro", "status": "ok|atencao|critico", "descricao": "<...>" }
  ],
  "swot": { "forcas": ["<3-4>"], "fraquezas": ["<3-4>"], "oportunidades": ["<3-4>"], "riscos": ["<3-4>"] },
  "opcoesEstrategicas": [
    { "pillar": "strategic_repositioning|value_focused_business_model|operational_excellence|financial_restructuring",
      "title": "<movimento concreto>", "description": "<como executar + a LENTE do pilar aplicada, com número>",
      "estimatedImpactBRL": <impacto_em_reais_ou_omita>, "impactoRacional": "<como chegou nesse impacto: a base de cálculo/premissa, ex.: 'reduzir PMR de 155→75d × receita/365 ≈ R$X de caixa liberado'. Omita só se não houver impacto em R$>", "horizonMonths": <meses_ou_omita>,
      "effort": "low|medium|high", "priority": "p0|p1|p2" }
  ],
  "recomendacoes": [ { "titulo": "<qual OPÇÃO priorizar>", "prioridade": "Alta|Média|Baixa", "impacto": "Alto|Médio|Baixo", "esforco": "Alto|Médio|Baixo", "horizonte": "0–30d|30–90d|90–180d", "descricao": "<por que primeiro e como sequenciar; referencia uma opção acima>" } ],
  "revelacoes": [
    { "titulo": "<a descoberta em 1 frase direta e forte — tom 'você não sabia disso'>",
      "dadoEscondido": "<o CRUZAMENTO que revela: quais números, de quais fontes, conectados>",
      "porQueInvisivel": "<por que o dono não enxerga isso no dia a dia (contabilidade não mostra, número diluído, efeito entre relatórios)>",
      "valorEmCaixa": <R$ se endereçado, ou null quando for alerta sem valor direto>,
      "comoChegou": "<memória de cálculo em 1 linha, ex.: 'receita 6,6M/365 = R$18k/dia × 80 dias de PMR acima dos pares ≈ R$1,45M parados'>",
      "perguntaAmanha": "<a pergunta que o dono deve fazer à equipe amanhã de manhã>" }
  ],
  ${canonico && canonico.alavancas.length > 0
    ? `"alavancasAdicionais": [ { "titulo": "<alavanca ESPECÍFICA que o motor não calcula (ex.: disciplina de distribuição, ativo ocioso, custo financeiro) — NUNCA repita as canônicas (prazos vs mediana, gap de margem vs mediana)>", "tipo": "caixa|margem", "valor": <R$>, "memoria": "<a conta explicada em prosa, citando os números-fonte>" } ],
  "valorNaMesaLeitura": "<1-2 frases: o número-manchete (canônicas + suas adicionais) e de onde vem; ordem de grandeza a validar>",`
    : `"valorNaMesa": { "total": <R$>, "caixaLiberavel": <R$ de caixa que pode ser liberado (giro/ativos)>, "margemRecuperavel": <R$ ANUAIS de resultado recuperável (custo/preço/mix)>, "leitura": "<1-2 frases: o número-manchete e de onde vem; deixe claro que é ordem de grandeza a validar>" },`}
  "protecoes": [ { "oQueProteger": "<força que SUSTENTA o resultado atual>", "ameaca": "<o que pode destruí-la>", "acaoDefensiva": "<como blindar, concreto>" } ],
  "confrontoDores": [ { "dor": "<a dor declarada, resumida>", "veredicto": "confirmada|desmentida|parcial", "evidencia": "<os números que confirmam/desmentem>", "leitura": "<o que isso muda na prioridade — 1-2 frases diretas>" } ],
  "pontosCegos": [ { "titulo": "<problema que os números mostram e NINGUÉM declarou como dor>", "evidencia": "<número/tendência>", "porQueImporta": "<consequência em R$/caixa se continuar invisível>", "acaoSugerida": "<primeiro passo concreto>" } ],
  "destaques": ["<insight 1>", "<insight 2>", "<insight 3>", "<insight 4>"],
  "confianca": <0-100>
}
(confrontoDores e pontosCegos: SÓ quando o bloco [5] DORES DECLARADAS estiver presente — sem dores, omita os dois campos.)

Pilares das opções (quatro frentes de valor): strategic_repositioning = Reposicionamento Estratégico (onde competir/como vencer) · value_focused_business_model = Modelo de Negócio orientado a Valor (proposta e captura de valor) · operational_excellence = Excelência Operacional (custos/processos/eficiência) · financial_restructuring = Estrutura Financeira (capital/dívida/liquidez/alocação).

PAPÉIS DAS SEÇÕES (NÃO haja overlap — cada uma responde a uma pergunta diferente):
- estagioCicloVida + situacao + saudeFinanceira + fatoresChave + semaforo = o DIAGNÓSTICO ("onde a empresa está e por quê"). O semaforo é o placar por área; os fatoresChave são as hipóteses de causa. NÃO repita os números do semáforo dentro do swot.
- swot = POSIÇÃO ESTRATÉGICA/COMPETITIVA ("como se posiciona no mercado"). Use Porter, pares e contexto (web/materiais). NÃO re-liste índices financeiros aqui — força/fraqueza aqui é de mercado, modelo, marca, capacidade, dependência, canal.
- opcoesEstrategicas = o LEQUE de movimentos possíveis por pilar ("o que dá para fazer").
- recomendacoes = o PLANO PRIORIZADO ("por onde começar"): escolha e SEQUENCIE as melhores opcoesEstrategicas em horizontes (0–30d/30–90d/90–180d). NÃO invente ações novas fora das opções — priorize e ordene as que você propôs.
- revelacoes = "O QUE VOCÊ NÃO SABIA" — a seção que faz o dono falar "uau". Só entra o que passa no TESTE DO DONO (etapa 6). É diferente de destaques (resumo) e de fatoresChave (hipóteses de causa): revelação é DESCOBERTA quantificada em caixa. Uma revelação pode alimentar uma opção estratégica — mas aqui o papel é REVELAR, não recomendar.
- valorNaMesa/alavancasAdicionais = o PLACAR: quando o motor entregou as ALAVANCAS CANÔNICAS (bloco acima), elas JÁ ESTÃO CONTADAS — você só ADICIONA alavancas específicas que o motor não calcula, cada uma com memória em prosa; NUNCA repita prazos-vs-mediana ou gap-de-margem-vs-mediana. Sem o bloco canônico, monte o placar completo você mesmo. SEM DUPLA CONTAGEM; ordem de grandeza, não promessa.
- protecoes = O QUE NÃO PODE QUEBRAR: 2-3 forças que sustentam o resultado atual e como blindá-las (pessoa-chave, contrato, canal, licença, cliente-âncora). Em empresa saudável esta seção é TÃO importante quanto as opções — manter o que funciona também é resultado.
- confrontoDores = REALIDADE × PERCEPÇÃO: cada dor declarada julgada pelos números (confirmada/desmentida/parcial) com honestidade — desmentir uma dor liberta energia da gestão; confirmar dá prioridade. pontosCegos = o INVERSO: problema numérico relevante que NINGUÉM declarou — apresente com respeito, mas sem suavizar.

PRINCÍPIOS (inegociáveis):
- Hipótese e FATO sempre separados. A IA NÃO inventa nem recalcula número — cita os números já prontos (indicadores, DRE, pares).
- EXATIDÃO NUMÉRICA (erro aqui destrói a credibilidade do relatório): os valores da tabela de indicadores JÁ ESTÃO na unidade final — percentuais já vêm multiplicados e com o símbolo % ("39,0%"), dias com "dias", moeda com "R$". Copie-os EXATAMENTE como estão: NUNCA re-escale, divida/multiplique por 100, nem adicione/remova o símbolo de %. Antes de citar qualquer percentual, faça o teste de sanidade contra a série (receita indo de 18,8M para 26,3M é crescimento de ~39%, jamais 0,39%). Se um número parecer inconsistente com a série, NÃO o cite — descreva a tendência sem o número.
- Lente PME-Brasil: gestão familiar/pessoa-chave, peso tributário, custo do capital de giro, informalidade de mercado.
- Toda afirmação relevante ancorada em NÚMERO (R$, %, dias, percentil) e, quando houver, no GAP vs pares e no contexto web/materiais. Nada de generalidade vazia.
- POSICIONAMENTO VS PARES: com o bloco de pares presente, o semáforo é RELATIVO ao setor (status pela posição vs mediana/faixa, respeitando a polaridade "maior/menor é melhor"); cite percentil/mediana. RESPEITE A COBERTURA: "direta" = confiável; "aproximada" = nível superior, direcional; "ausente" = NÃO invente percentil, use referência externa da web + conhecimento do setor e seja explícito.
- fatoresChave: 3 a 6, priorizando os que mais explicam o desempenho. opcoesEstrategicas: 4 a 8 pelos pilares conforme o diagnóstico. recomendacoes: 4 a 6, todas derivadas das opções. revelacoes: 3 a 5, TODAS aprovadas no teste do dono (melhor 3 fortes que 5 mornas). protecoes: 2 a 3. destaques: frases ≤15 palavras. priority p0=urgente, p1=importante, p2=oportuno.
- confianca: maior com 2+ períodos e indicadores/DRE completos.
- ESTILO (todo campo de texto): prosa profissional em português; NUNCA use travessão (— ou –) nem marcação markdown (**, *, #, listas com hífen) — o texto vai direto para o relatório do cliente. Separe ideias com vírgula, dois-pontos ou ponto.
- EXPLIQUE O INDICADOR NA HORA DE CITÁ-LO (inegociável): NUNCA cite um indicador como se o leitor soubesse o que ele mede. Todo indicador citado vem com o SIGNIFICADO na mesma frase, em linguagem de dono de empresa, e de preferência traduzido para dinheiro ou consequência prática. NÃO escreva "liquidez corrente de 0,01"; escreva "para cada R$ 1,00 que vence nos próximos meses a empresa tem apenas R$ 0,01 para pagar (é o que chamamos de liquidez corrente)". NÃO escreva "capital de giro negativo em R$ 3,07 milhões"; escreva "faltam R$ 3,07 milhões de recursos próprios para bancar o dia a dia da operação, ou seja, o funcionamento da empresa está sendo financiado por dívida de curto prazo (capital de giro negativo)". NÃO escreva "endividamento geral de 58,3%"; escreva "de cada R$ 1,00 que a empresa tem, R$ 0,58 pertencem a terceiros, bancos e fornecedores (endividamento geral de 58,3%)". Mesma regra para margem, prazos médios, ROE, EBITDA, cobertura de juros, Kanitz, Altman e Fleuriet. O nome técnico pode aparecer, mas SEMPRE depois da explicação, entre parênteses, como referência para o contador.
- TOM: RECOMENDAÇÃO, NÃO SENTENÇA (inegociável). Quem lê construiu esta empresa; palavra dura soa como ofensa e trava a conversa que o relatório quer abrir. Seja FRANCO com o fato e RESPEITOSO com a pessoa: os números e a gravidade permanecem exatamente os mesmos, muda o vocabulário. Escreva "dificuldade de caixa" e não "crise"; "retração" e não "declínio"; "a estrutura não se sustenta no ritmo atual" e não "a empresa vai quebrar"; "risco elevado" e não "insolvência iminente"; "atenção elevada" e não "zona de perigo"; "vale rever" e não "está errado"; "a decisão ainda é da empresa" e não "antes que seja tarde". PROIBIDO julgar a gestão ("má gestão", "descontrole", "irresponsável", "amadorismo") — descreva o EFEITO no número, nunca a qualidade de quem decidiu. Nada de dramatização ("sangria", "colapso", "beira do abismo", "situação insustentável"). Suavizar o FATO continua proibido: se o caixa paga 6 dias de operação, diga os 6 dias.
- O RELÓGIO (quando houver o bloco CONTA REGRESSIVA DE CAIXA): comece a saudeFinanceira.leitura pelo TEMPO, não pelo índice. "O caixa de hoje paga X dias de operação" diz mais ao dono do que qualquer índice de liquidez. Use os números do bloco como estão, sem recalcular.
- O CUSTO DE NÃO FAZER NADA: em recomendacoes.descricao das ações de prioridade Alta, feche com a consequência de adiar, em dinheiro ou em tempo, ancorada em número já existente ("cada mês sem renegociar esse prazo mantém cerca de R$ X parados no estoque"; "adiar um trimestre consome metade do fôlego de caixa restante"). Sem número disponível, descreva a consequência concreta, nunca uma frase genérica de urgência.
- ESTA SEMANA, NESTA ORDEM: as recomendacoes de horizonte "0–30d" começam por uma ação que cabe nos PRÓXIMOS SETE DIAS e que dependa só da empresa (ligar para o banco, listar os dez maiores clientes em atraso, suspender uma retirada, renegociar um contrato). Escreva o primeiro passo como se fosse item de agenda de segunda-feira, com quem faz e o que traz de volta.
- COMPARAÇÃO QUE O DONO ENTENDE: ao usar os pares, traduza percentil em gente, não em estatística. Em vez de "percentil 22 em prazo médio de recebimento", escreva "sete de cada dez empresas parecidas recebem dos clientes em cerca de 45 dias, esta recebe em 155". Diga também o que a diferença vale em dinheiro quando for calculável.
- O QUE ESTÁ FUNCIONANDO: relatório só de problema paralisa. Garanta que protecoes nomeie de 2 a 3 forças REAIS e concretas que sustentam o resultado (margem, cliente-âncora, produto, equipe, canal), com o número que as comprova, e que ao menos um dos destaques seja um ponto positivo quando existir. Em empresa sob pressão isso é ainda mais importante: é o ativo com que ela vai virar o jogo.
- CONTE A HISTÓRIA, NÃO SÓ A FOTO (inegociável em estagioCicloVida.justificativa, situacao.racional e saudeFinanceira.leitura): o dono quer entender COMO chegou até aqui. Amarre a trajetória do período (o que aconteceu do primeiro ao último ano com faturamento, margem e caixa), o ponto de virada quando existir ("o resultado financeiro saltou de R$ 265 mil para R$ 1,43 milhão em três anos") e o que isso significa daqui para frente, incluindo a consequência prática de não fazer nada. Escreva como quem explica a situação a um sócio na mesa, com frases completas encadeadas.
- LEITOR LEIGO (inegociável): quem lê o relatório é o DONO DA EMPRESA, sem formação em finanças. Em todo campo de texto: frases COMPLETAS, nunca telegrama de fórmula. NENHUMA sigla sem tradução: escreva "necessidade de capital de giro, o dinheiro que fica preso entre pagar fornecedores e receber dos clientes" (não NCG), "prazo médio de recebimento dos clientes" (não PMR), "prazo médio de pagamento aos fornecedores" (não PMP), "caixa gerado pela operação" (não FCO), "patrimônio dos sócios" (não PL), "dívida de curto prazo" (não CP). "percentil 78" vira "melhor que 78% das empresas comparáveis"; "YoY" vira "em relação ao ano anterior"; "p.p." vira "pontos percentuais". NADA de termos em inglês: em vez de due diligence escreva auditoria prévia, em vez de SLA escreva prazo de entrega acordado, em vez de pipeline escreva carteira de negociações, em vez de valuation escreva valor da empresa na negociação. NADA de setas, sinais de vezes ou til no texto (em vez de "43->69d = 26d × R$51,7k ~ R$1,35M", escreva "alongar o prazo de pagamento aos fornecedores de 43 para 69 dias, que é a prática dos concorrentes, mantém no caixa cerca de R$ 1,35 milhão"). Valores por extenso na escala: "R$ 1,3 milhão", "R$ 692 mil".
- PROFUNDIDADE das recomendações: recomendacoes.descricao e opcoesEstrategicas.description têm 3 a 5 frases completas cada, nesta lógica: o que fazer na prática, por que (o problema explicado em linguagem simples, com o número), o que a empresa ganha se fizer, e o primeiro passo concreto. impactoRacional e comoChegou: a conta explicada em PROSA, passo a passo, sem símbolos. destaques continuam curtos, mas sem sigla.
- Responda APENAS com o JSON.`;

  // max_tokens generoso: o JSON rico (diagnóstico + semáforo + swot + causas + opções) é grande.
  // Parse robusto: aceita cerca ``` e descarta preâmbulo/sufixo de texto.
  // A estabilidade dos rótulos-chave (estágio etc.) vem do classificador DETERMINÍSTICO no
  // motor, não da amostragem. Opus 4.8 NÃO aceita `temperature` (depreciado) — não enviar.
  // max_tokens: os textos "para leigos" (3-5 frases por recomendação + perfilEmpresa)
  // alongaram o JSON e 12k passou a TRUNCAR a resposta (parse falhava e a análise era
  // gravada VAZIA por cima da anterior — incidente Move Farma 08/07). 24k dá folga 2x;
  // haiku fica em 8k (limite do modelo rápido).
  const maxTokensAnalise = modelKey === "haiku" ? 8000 : 24000;
  const message = await createWithRetry({ model, max_tokens: maxTokensAnalise, messages: [{ role: "user", content: prompt }] });
  const truncada = (message as { stop_reason?: string }).stop_reason === "max_tokens";
  let text = message.content[0]?.type === "text" ? message.content[0].text.trim() : "";
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  let ai: any = {};
  try {
    ai = JSON.parse(text);
  } catch {
    const ini = text.indexOf("{"), fim = text.lastIndexOf("}");
    if (ini >= 0 && fim > ini) {
      try { ai = JSON.parse(text.slice(ini, fim + 1)); } catch { ai = {}; }
    }
  }

  // GUARD: se o JSON não veio íntegro (truncado/não parseável), FALHA ALTO — jamais
  // persistir uma análise vazia por cima da anterior. O chamador preserva o resultado.
  const essenciais = Array.isArray(ai.semaforo) && ai.semaforo.length > 0
    && Array.isArray(ai.opcoesEstrategicas) && ai.opcoesEstrategicas.length > 0
    && ai.swot && Array.isArray(ai.swot.forcas) && ai.swot.forcas.length > 0;
  if (!essenciais) {
    throw new Error(truncada
      ? `Resposta da IA truncada no limite de ${maxTokensAnalise} tokens — a análise anterior foi preservada; regenere.`
      : "Resposta da IA incompleta/não parseável — a análise anterior foi preservada; regenere.");
  }

  const custo = calcCusto(model, message.usage?.input_tokens ?? 0, message.usage?.output_tokens ?? 0);
  const result: AnalysisResult = {
    kpis: det.kpis,
    capitalDeGiro: det.capitalDeGiro,
    liquidezSeca: det.liquidezSeca,
    margemLiquida: det.margemLiquida,
    divLiqEbitda: det.divLiqEbitda,
    coberturaJuros: det.coberturaJuros,
    dreData: [],
    semaforo: Array.isArray(ai.semaforo) ? ai.semaforo : [],
    recomendacoes: Array.isArray(ai.recomendacoes) ? ai.recomendacoes : [],
    swot: ai.swot ?? { forcas: [], fraquezas: [], oportunidades: [], riscos: [] },
    confianca: typeof ai.confianca === "number" ? ai.confianca : 60,
    destaques: Array.isArray(ai.destaques) ? ai.destaques : [],
    opcoesEstrategicas: Array.isArray(ai.opcoesEstrategicas) ? ai.opcoesEstrategicas : [],
    estagioCicloVida: ai.estagioCicloVida && typeof ai.estagioCicloVida === "object" ? ai.estagioCicloVida : undefined,
    situacao: ai.situacao && typeof ai.situacao === "object" ? ai.situacao : undefined,
    saudeFinanceira: ai.saudeFinanceira && typeof ai.saudeFinanceira === "object" ? ai.saudeFinanceira : undefined,
    fatoresChave: Array.isArray(ai.fatoresChave) ? ai.fatoresChave : [],
    revelacoes: Array.isArray(ai.revelacoes) ? ai.revelacoes.filter((r: any) => r && r.titulo) : [],
    valorNaMesa: (() => {
      if (canonico && canonico.alavancas.length > 0) {
        // MOTOR manda: canônicas são imutáveis; a IA só adiciona (com sanidade).
        const adicionais: AlavancaValor[] = (Array.isArray(ai.alavancasAdicionais) ? ai.alavancasAdicionais : [])
          .filter((a: any) => a && typeof a.titulo === "string" && typeof a.valor === "number" && a.valor > 0 && a.valor <= 5 * (canonico.total + 1_000_000))
          .slice(0, 5)
          .map((a: any): AlavancaValor => ({
            origem: "analise",
            titulo: String(a.titulo).slice(0, 160),
            tipo: a.tipo === "margem" ? "margem" : "caixa",
            valor: Math.round(a.valor),
            memoria: String(a.memoria ?? "").slice(0, 400),
          }));
        const caixaAdd = adicionais.filter((a) => a.tipo === "caixa").reduce((x, a) => x + a.valor, 0);
        const margemAdd = adicionais.filter((a) => a.tipo === "margem").reduce((x, a) => x + a.valor, 0);
        return {
          total: canonico.total + caixaAdd + margemAdd,
          caixaLiberavel: canonico.caixaLiberavel + caixaAdd,
          margemRecuperavel: canonico.margemRecuperavelAno + margemAdd,
          leitura: typeof ai.valorNaMesaLeitura === "string" && ai.valorNaMesaLeitura.trim()
            ? ai.valorNaMesaLeitura.trim()
            : `Valor endereçável calculado dos gaps vs os pares do setor${adicionais.length ? " somado às alavancas específicas identificadas na análise" : ""} — ordem de grandeza a validar.`,
          alavancas: [...canonico.alavancas, ...adicionais],
          base: canonico.base,
        };
      }
      // Sem base de pares → comportamento anterior (100% IA), declarado como tal.
      return ai.valorNaMesa && typeof ai.valorNaMesa === "object" && typeof ai.valorNaMesa.total === "number" ? ai.valorNaMesa : undefined;
    })(),
    protecoes: Array.isArray(ai.protecoes) ? ai.protecoes.filter((p: any) => p && p.oQueProteger) : [],
    confrontoDores: Array.isArray(ai.confrontoDores) ? ai.confrontoDores.filter((c: any) => c && c.dor) : [],
    pontosCegos: Array.isArray(ai.pontosCegos) ? ai.pontosCegos.filter((p: any) => p && p.titulo) : [],
    perfilEmpresa: typeof ai.perfilEmpresa === "string" && ai.perfilEmpresa.trim().length > 0 ? ai.perfilEmpresa.trim() : undefined,
  };

  // Conta regressiva: número do MOTOR, nunca estimativa da IA (mesma régua do estágio).
  if (contaRegressiva) {
    result.contaRegressiva = contaRegressiva;
    if (result.saudeFinanceira && contaRegressiva.diasDeCaixa != null) {
      result.saudeFinanceira.diasDeCaixa = Math.round(contaRegressiva.diasDeCaixa);
    }
  }
  // Estágio: o MOTOR manda. Sobrescreve o que a IA disser (rótulo estável, "verde só com prova").
  if (estagioDet) result.estagioCicloVida = estagioDet;
  else if (periodoInsuficiente && !result.estagioCicloVida) {
    result.estagioCicloVida = { estagio: "Indeterminado (período curto)", justificativa: "Só há 1 período — sem histórico para avaliar tendência." };
  }
  // Aviso de período curto — some quando há 2+ períodos.
  result.avisoPeriodo = periodoInsuficiente
    ? "Apenas 1 período analisado. Sem histórico, a leitura é limitada: tendências (crescimento/declínio), estágio do ciclo e causas ficam menos assertivos. Para um IBR robusto, use 2–3 anos de demonstrações."
    : null;

  return { result, custo };
}
