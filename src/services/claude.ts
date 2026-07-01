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
  /** DIAGNÓSTICO de IBR (camada rica, Fase 1a) — leitura de sócio de reestruturação. */
  estagioCicloVida?: { estagio: string; justificativa: string };
  tipoCrise?: { classificacao: string; racional: string };
  sustentabilidadeDivida?: { status: string; mesesDeCaixa: number | null; leitura: string };
  causasProvaveis?: Array<{
    problema: string;
    causaHipotese: string;
    natureza: "interna" | "externa" | "mista" | string;
    evidencia: string;
    confianca: "alta" | "media" | "baixa" | string;
    verificar: string;
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
  materiais?: Array<{ nome: string; resumo: string }> | null,
  dre?: Array<{ conta: string; valores: Record<string, number>; subtotal?: boolean }> | null,
): Promise<{ result: AnalysisResult; custo: CustoIA }> {
  const model = modeloAnaliseId(modelKey);
  const det = kpisDeterministicos(indicadores, periodos);
  const peerBlock = buildPeerBlock(peer);
  const webBlock = buildWebBlock(web);
  const materiaisBlock = buildMateriaisBlock(materiais);
  const dreBlock = buildDreBlock(dre, periodos);

  const prompt = `Você é sócio de uma consultoria de reestruturação (turnaround / Independent Business Review) de elite, com background de CFO e de private equity. Está analisando uma empresa brasileira de pequeno/médio porte. Sua leitura precisa ser de nível INSTITUCIONAL — o diagnóstico que um credor ou investidor usaria para decidir aportar, reestruturar ou sair. Profundidade, precisão e conexão entre os dados são o diferencial.

Empresa: "${empresa.razaoSocial}" · Setor: ${empresa.setor} · Porte: ${empresa.porte} · Período analisado: ${periodo}

Você recebe VÁRIAS fontes. USE TODAS e CRUZE-AS — o valor está em conectar número → causa → contexto → ação:

[1] INDICADORES JÁ CALCULADOS E AUDITADOS (determinísticos — NÃO recalcule, apenas INTERPRETE):
${det.tabela || "(indicadores indisponíveis)"}
${dreBlock}${peerBlock}${webBlock}${materiaisBlock}

MÉTODO DE RACIOCÍNIO (siga NESTA ordem — cada etapa condiciona a próxima):
1. ESTÁGIO DO CICLO DE VIDA: pela TENDÊNCIA multi-ano (não pela foto de um período), classifique: Crescimento / Platô / Declínio / Crise de caixa / Insolvência iminente. Condiciona toda a leitura.
2. CAUSA × SINTOMA (sempre HIPÓTESE, nunca afirmação — "a causa não está nas demonstrações"): separe o SINTOMA (o número ruim) da CAUSA provável. Regra de natureza: indicador piorou E os pares/setor também → provável causa EXTERNA (mercado); piorou E os pares NÃO → provável causa INTERNA (gestão). Cada hipótese com evidência (qual número/par/fato a sustenta), confiança e O QUE VERIFICAR (pergunta de entrevista ou documento a pedir).
3. CRISE OPERACIONAL × FINANCEIRA: a deterioração nasce na OPERAÇÃO (margem/custo) ou na ALAVANCAGEM (estrutura de capital/dívida)? Muda o diagnóstico e o valor.
4. SUSTENTABILIDADE DA DÍVIDA × CAIXA: a dívida é pagável pela geração de caixa atual? Estime meses de caixa. "Dívida barata não adianta se não paga." Sinalize se o caixa cobre menos de 3 meses de operação.
5. OPÇÕES por LENTE analítica: Reposicionamento → 5 Forças de Porter (rivalidade, entrantes, substitutos, poder de fornecedor e de cliente) ancoradas no contexto setorial da web; Excelência Operacional → ÁRVORE DE CUSTOS da DRE (aponte QUAL rubrica destrói a margem, da bruta para a operacional); Reestruturação Financeira → dívida/liquidez/capital de giro/runway; Modelo de Negócio orientado a Valor → onde se CRIA e onde se CAPTURA valor (proposta, pricing, mix, canais).

Retorne APENAS um JSON válido (sem markdown, sem \`\`\`) com EXATAMENTE esta estrutura:
{
  "estagioCicloVida": { "estagio": "Crescimento|Platô|Declínio|Crise de caixa|Insolvência iminente", "justificativa": "<1-2 frases citando a tendência dos números>" },
  "tipoCrise": { "classificacao": "sem crise|operacional|financeira|mista", "racional": "<onde nasce a deterioração, com evidência>" },
  "sustentabilidadeDivida": { "status": "ok|apertada|insustentavel", "mesesDeCaixa": <número ou null>, "leitura": "<dívida vs geração de caixa; runway>" },
  "causasProvaveis": [ { "problema": "<sintoma>", "causaHipotese": "<causa-raiz provável>", "natureza": "interna|externa|mista", "evidencia": "<número/par/fato>", "confianca": "alta|media|baixa", "verificar": "<o que perguntar/pedir>" } ],
  "semaforo": [
    { "area": "Receita e Crescimento", "status": "ok|atencao|critico", "descricao": "<1 frase citando número e percentil vs pares>" },
    { "area": "Margens Operacionais", "status": "ok|atencao|critico", "descricao": "<...>" },
    { "area": "Liquidez", "status": "ok|atencao|critico", "descricao": "<...>" },
    { "area": "Endividamento", "status": "ok|atencao|critico", "descricao": "<...>" },
    { "area": "Rentabilidade", "status": "ok|atencao|critico", "descricao": "<...>" },
    { "area": "Capital de Giro", "status": "ok|atencao|critico", "descricao": "<...>" }
  ],
  "swot": { "forcas": ["<3-4, ancoradas em gap vs pares e no contexto>"], "fraquezas": ["<3-4>"], "oportunidades": ["<3-4>"], "riscos": ["<3-4>"] },
  "recomendacoes": [ { "titulo": "<ação concreta>", "prioridade": "Alta|Média|Baixa", "impacto": "Alto|Médio|Baixo", "esforco": "Alto|Médio|Baixo", "horizonte": "0–30d|30–90d|90–180d", "descricao": "<detalhe prático com número>" } ],
  "destaques": ["<insight 1>", "<insight 2>", "<insight 3>", "<insight 4>"],
  "confianca": <0-100>,
  "opcoesEstrategicas": [
    { "pillar": "strategic_repositioning|value_focused_business_model|operational_excellence|financial_restructuring",
      "title": "<opção concreta>", "description": "<como executar + a LENTE do pilar aplicada, com número>",
      "estimatedImpactBRL": <impacto_em_reais_ou_omita>, "horizonMonths": <meses_ou_omita>,
      "effort": "low|medium|high", "priority": "p0|p1|p2" }
  ]
}

Pilares das opções (quatro frentes de valor): strategic_repositioning = Reposicionamento Estratégico (onde competir/como vencer) · value_focused_business_model = Modelo de Negócio orientado a Valor (proposta e captura de valor) · operational_excellence = Excelência Operacional (custos/processos/eficiência) · financial_restructuring = Reestruturação Financeira (capital/dívida/liquidez).

PRINCÍPIOS (inegociáveis):
- Hipótese e FATO sempre separados. A IA NÃO inventa nem recalcula número — cita os números já prontos (indicadores, DRE, pares).
- Lente PME-Brasil: gestão familiar/pessoa-chave, peso tributário, custo do capital de giro, informalidade de mercado.
- Toda afirmação relevante ancorada em NÚMERO (R$, %, dias, percentil) e, quando houver, no GAP vs pares e no contexto web/materiais. Nada de generalidade vazia.
- POSICIONAMENTO VS PARES: com o bloco de pares presente, o semáforo é RELATIVO ao setor (status pela posição vs mediana/faixa, respeitando a polaridade "maior/menor é melhor"); cite percentil/mediana. RESPEITE A COBERTURA: "direta" = confiável; "aproximada" = nível superior, direcional; "ausente" = NÃO invente percentil, use referência externa da web + conhecimento do setor e seja explícito.
- causasProvaveis: 3 a 6, priorizando as que explicam a MAIOR destruição de valor. opcoesEstrategicas: 4 a 8 distribuídas pelos pilares conforme o diagnóstico. recomendacoes: 4 a 6. destaques: frases ≤15 palavras. priority p0=urgente, p1=importante, p2=oportuno.
- confianca: maior com 2+ períodos e indicadores/DRE completos.
- Responda APENAS com o JSON.`;

  // max_tokens generoso: o JSON rico (diagnóstico + semáforo + swot + causas + opções) é grande.
  // Parse robusto: aceita cerca ``` e descarta preâmbulo/sufixo de texto.
  const message = await createWithRetry({ model, max_tokens: 12000, messages: [{ role: "user", content: prompt }] });
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
    estagioCicloVida: ai.estagioCicloVida && typeof ai.estagioCicloVida === "object" ? ai.estagioCicloVida : undefined,
    tipoCrise: ai.tipoCrise && typeof ai.tipoCrise === "object" ? ai.tipoCrise : undefined,
    sustentabilidadeDivida: ai.sustentabilidadeDivida && typeof ai.sustentabilidadeDivida === "object" ? ai.sustentabilidadeDivida : undefined,
    causasProvaveis: Array.isArray(ai.causasProvaveis) ? ai.causasProvaveis : [],
  };
  return { result, custo };
}
