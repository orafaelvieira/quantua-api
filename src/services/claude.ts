import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";
import { calcCusto, modeloAnaliseId, createWithRetry, type CustoIA } from "./ai-extraction";
import type { PeerComparisonRow } from "./peer-benchmark";

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
  }>;
}

interface IndicadorLite {
  nome: string;
  valores: Record<string, number | string | null>;
  status?: Record<string, "ok" | "atencao" | "critico" | null>;
}

const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Monta os 8 KPIs + métricas secundárias a partir dos indicadores DETERMINÍSTICOS (a IA
 *  NÃO recalcula). Razão→pontos percentuais nos KPIs de %; EBITDA = Margem Operacional ×
 *  Receita Líquida (ambos indicadores); variação = mudança relativa vs período anterior. */
/** Ordena períodos cronologicamente: "31/12/2022" ou "2022" → chave numérica. */
function ordPeriodo(p: string): number {
  const m = p.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return Number(`${m[3]}${m[2]}${m[1]}`);
  const y = p.match(/\d{4}/);
  return y ? Number(`${y[0]}0000`) : 0;
}

function kpisDeterministicos(indicadores: IndicadorLite[], periodos: string[]) {
  const ord = [...periodos].sort((a, b) => ordPeriodo(a) - ordPeriodo(b)); // mais recente por último
  const ult = ord[ord.length - 1], ant = ord[ord.length - 2];
  const ind = (nome: string) => indicadores.find((i) => i.nome === nome);
  const raw = (nome: string, p?: string) => { const i = ind(nome); return i && p ? numOf(i.valores[p]) : null; };
  const stat = (nome: string): "ok" | "atencao" | "critico" => { const i = ind(nome); return (i && ult ? i.status?.[ult] : null) ?? "atencao"; };
  const variOf = (a: number | null, b: number | null) => (a != null && b != null && b !== 0 ? ((a - b) / Math.abs(b)) * 100 : 0);
  const ebitdaDe = (p?: string) => { const rec = raw("Receita Líquida", p), mop = raw("Margem Operacional", p); return rec != null && mop != null ? mop * rec : null; };

  const MAP: Record<string, { nome: string; pct: boolean }> = {
    receita: { nome: "Receita Líquida", pct: false },
    margemBruta: { nome: "Margem Bruta", pct: true },
    margemEbitda: { nome: "Margem Operacional", pct: true },
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
    return { valor: e ?? 0, variacao: variOf(e, ebitdaDe(ant)) || 0, status: stat("Margem Operacional") };
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
  // Tabela de fatos para o prompt (só indicadores com algum valor numérico).
  const tabela = indicadores
    .filter((i) => periodos.some((p) => numOf(i.valores[p]) != null))
    .map((i) => `${i.nome}: ${periodos.map((p) => `${p}=${typeof i.valores[p] === "number" ? (i.valores[p] as number).toFixed(4) : "-"}`).join(" · ")}`)
    .join("\n");
  return { kpis, ...sec, tabela };
}

interface PeerBlockInput {
  year: number | null;
  segment: string | null;
  coverage: "direta" | "aproximada" | "ausente";
  rows: PeerComparisonRow[];
  external: Array<{ indicador: string; referencia: number; fonte: string; higherIsBetter: boolean }>;
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
  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "-");
  const nivelLabel: Record<PeerComparisonRow["level"], string> = {
    subsetor: "subsetor", setor: "setor", classificacao: "classificação", mercado: "mercado",
  };
  const seg = peer.segment ? ` — ${peer.segment}` : "";
  const ano = peer.year ? `, ano ${peer.year}` : "";

  const nota =
    peer.coverage === "direta"
      ? "Cobertura: pares DIRETOS do subsetor na base."
      : peer.coverage === "aproximada"
      ? "Cobertura: SEM pares diretos no subsetor — comparação usa nível setor/classificação (par aproximado; trate como direcional)."
      : "Cobertura: SEM pares na base interna para este subsetor — sem referência interna. NÃO há percentil; use a referência externa da web (quando houver) + conhecimento do setor, e seja explícito de que não há pares diretos.";

  const linhasInternas = peer.rows
    .map(
      (r) =>
        `- ${r.indicador}: empresa=${fmt(r.valor)} · mediana pares=${fmt(r.p50)} · faixa p25–p75=${fmt(r.p25)}–${fmt(r.p75)} · percentil=${r.percentil} · ${r.higherIsBetter ? "maior é melhor" : "menor é melhor"} · nível=${nivelLabel[r.level]} (n=${r.count})`,
    )
    .join("\n");
  const linhasExternas = peer.external
    .map(
      (e) =>
        `- ${e.indicador}: referência=${fmt(e.referencia)} · ${e.higherIsBetter ? "maior é melhor" : "menor é melhor"} · fonte=${e.fonte} (sem percentil)`,
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
  periodos: string[],
  empresa: { razaoSocial: string; setor: string; porte: string },
  periodo: string,
  modelKey?: string | null,
  peer?: PeerBlockInput | null,
  web?: { resumo: string; fontes: { titulo: string; url: string }[] } | null,
): Promise<{ result: AnalysisResult; custo: CustoIA }> {
  const model = modeloAnaliseId(modelKey);
  const det = kpisDeterministicos(indicadores, periodos);
  const peerBlock = buildPeerBlock(peer);
  const webBlock = buildWebBlock(web);

  const prompt = `Você é um CFO/consultor financeiro sênior analisando uma empresa brasileira de pequeno/médio porte.

Empresa: "${empresa.razaoSocial}" · Setor: ${empresa.setor} · Porte: ${empresa.porte} · Período: ${periodo}

INDICADORES JÁ CALCULADOS E AUDITADOS (valores por período — NÃO recalcule, apenas INTERPRETE):
${det.tabela || "(indicadores indisponíveis)"}
${peerBlock}${webBlock}

Produza a CAMADA INTERPRETATIVA (não numérica) de um IBR — leitura de CFO desses indicadores.

Retorne APENAS um JSON válido (sem markdown, sem \`\`\`) com EXATAMENTE esta estrutura:
{
  "semaforo": [
    { "area": "Receita e Crescimento", "status": "ok|atencao|critico", "descricao": "<1 frase citando o número relevante>" },
    { "area": "Margens Operacionais", "status": "ok|atencao|critico", "descricao": "<...>" },
    { "area": "Liquidez", "status": "ok|atencao|critico", "descricao": "<...>" },
    { "area": "Endividamento", "status": "ok|atencao|critico", "descricao": "<...>" },
    { "area": "Rentabilidade", "status": "ok|atencao|critico", "descricao": "<...>" },
    { "area": "Capital de Giro", "status": "ok|atencao|critico", "descricao": "<...>" }
  ],
  "swot": { "forcas": ["<3 itens>"], "fraquezas": ["<3>"], "oportunidades": ["<3>"], "riscos": ["<3>"] },
  "recomendacoes": [ { "titulo": "<ação concreta>", "prioridade": "Alta|Média|Baixa", "impacto": "Alto|Médio|Baixo", "esforco": "Alto|Médio|Baixo", "horizonte": "0–30d|30–90d|90–180d", "descricao": "<detalhe prático>" } ],
  "destaques": ["<insight 1>", "<insight 2>", "<insight 3>", "<insight 4>"],
  "confianca": <0-100>,
  "opcoesEstrategicas": [
    { "pillar": "strategic_repositioning|value_focused_business_model|operational_excellence|financial_restructuring",
      "title": "<opção concreta>", "description": "<como executar / racional>",
      "estimatedImpactBRL": <impacto_em_reais_ou_omita>, "horizonMonths": <meses_ou_omita>,
      "effort": "low|medium|high", "priority": "p0|p1|p2" }
  ]
}

Pilares das opções (quatro frentes de valor): strategic_repositioning = Reposicionamento Estratégico (onde competir/como vencer) · value_focused_business_model = Modelo de Negócio orientado a Valor (proposta e captura de valor) · operational_excellence = Excelência Operacional (custos/processos/eficiência) · financial_restructuring = Reestruturação Financeira (capital/dívida/liquidez).

Regras:
- Baseie-se SOMENTE nos indicadores fornecidos. NÃO invente nem recalcule números.
- POSICIONAMENTO VS PARES: quando o bloco de pares estiver presente, o semáforo é RELATIVO ao setor — defina o status comparando a empresa à mediana e à faixa dos pares (não a um padrão absoluto), respeitando a polaridade indicada (maior/menor é melhor). Cite o percentil ou a mediana do par na descrição. Ancore forças/fraquezas (SWOT) e opções no GAP vs pares. RESPEITE A COBERTURA indicada: "direta" = comparação confiável; "aproximada" = par de nível superior, trate como direcional; "ausente" = NÃO invente percentil — use a referência externa da web (quando houver) + conhecimento do setor e seja EXPLÍCITO no diagnóstico de que não há pares diretos na base.
- semaforo: cite o valor numérico relevante na descrição. recomendações: 3 a 6, práticas e específicas para a empresa. destaques: frases curtas (≤15 palavras).
- opcoesEstrategicas: 4 a 8 no total, distribuídas pelos pilares conforme o diagnóstico (nem todo pilar precisa ter opção). priority p0=urgente, p1=importante, p2=oportuno. Específicas e acionáveis.
- confianca: maior quando há 2+ períodos e indicadores completos.
- Responda APENAS com o JSON.`;

  // max_tokens generoso: com pares + contexto web no prompt, o JSON interpretativo
  // ficou maior e estourava 4096 → truncado → JSON.parse falhava → SWOT/recs/opções
  // vazios. Parse robusto também: aceita cerca ``` e descarta preâmbulo/sufixo de texto.
  const message = await createWithRetry({ model, max_tokens: 8000, messages: [{ role: "user", content: prompt }] });
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
  };
  return { result, custo };
}
