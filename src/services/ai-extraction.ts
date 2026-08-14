import Anthropic from "@anthropic-ai/sdk";
import { registrarUsoIA, usoDaResposta, ETAPAS } from "./ai-usage";
import { env } from "../config/env";
import { DRE_TEMPLATE } from "./financial-templates";
import type { BPLineItem, DRELineItem } from "../types/financial";
import type { DREModel } from "./model-version";
import { normalizeDRESigns, recomputeDRESubtotals, mapAccountToBPGroup, mapAccountToDRE, isContaIgnorada, blocoDoCaminhoDRE, CONFLITO_CONTEXTO_DRE, DEFAULT_BP_MODEL, DRE_DESPESAS_OPERACIONAIS, type BPModel, type DictionaryEntry } from "./account-mapper";
import { construirArvoreBPporIndentacao, linhasParaTextoIndentado } from "./bp-tree-indent";
import { construirArvoreDREporIndentacao } from "./dre-tree-indent";
import type { ParsedDocument, ExtractedRow } from "./parser";
import { limparNomeConta, ehContaDePatrimonio } from "./nome-conta";

const client = new Anthropic({ apiKey: env.anthropicApiKey });
const AI_MODEL = "claude-sonnet-4-6";        // visão (lê o PDF) — caro
const AI_MODEL_FAST = "claude-haiku-4-5-20251001"; // estrutura texto do parser — barato
const AI_MODEL_OPUS = "claude-opus-4-8";     // análise premium (julgamento/recomendação)

/** Mapa friendly-key → model id usado pela ANÁLISE (generateAnalysis). Default sonnet. */
export function modeloAnaliseId(key?: string | null): string {
  if (key === "haiku") return AI_MODEL_FAST;
  if (key === "opus") return AI_MODEL_OPUS;
  return AI_MODEL; // "sonnet" (default)
}
const dreInputs = DRE_TEMPLATE.filter((t) => !t.subtotal).map((t) => t.conta);
const dreInputsSet = new Set(dreInputs);

export interface DRESecaoItem { nome: string; valor: number; destino?: string; filhos?: DRESecaoItem[] }
export type ArvoreOriginalDRE = Record<string, DRESecaoItem[]>;

// ── Tipos da árvore do BP ──
// `filhos` (opcional): hierarquia COMPLETA do documento (1-7 níveis). Capturas antigas
// (flat, sem filhos) continuam válidas — o fold trata os dois formatos.
export interface BPN3Item { nome: string; valor: number; destino?: string; filhos?: BPN3Item[] }
export interface BPN3Periodo { grupos: Record<string, BPN3Item[]>; totais?: Record<string, number> }
/** Árvore original do BP até o nível 3, por período (auditoria). */
export type ArvoreOriginalBP = Record<string, BPN3Periodo>;

export interface NaoMapeado { nome: string; grupo: string; destino: string; valor: number; periodo: string; tipo: "BP" | "DRE" }

export interface AIExtractionResult {
  bp: BPLineItem[];
  dre: DRELineItem[];
  periodos: string[];
  declarados: Record<string, Record<string, number>>;
  /** árvore original do BP (nível 3) — fiel ao documento, para auditoria */
  arvoreOriginalBP: ArvoreOriginalBP;
  /** seções originais da DRE — fiel ao documento, para auditoria */
  arvoreOriginalDRE: ArvoreOriginalDRE;
  /** contas N3/seções que o de-para não reconheceu (foram p/ "Outros" ou sinalizadas) */
  naoMapeados: NaoMapeado[];
  /** nós cujo subtotal declarado não bate com a soma dos filhos (prova de composição) */
  alertasComposicao: AlertaComposicaoBP[];
  /** custo da chamada de IA (tokens + USD) — para medir o custo por processo */
  custo: CustoIA;
}

const yearOf = (p: string): string | null => (p.match(/(20[0-3]\d)/) || [])[1] ?? null;
function canonicalPeriod(returned: string, canonicos: string[]): string {
  if (canonicos.includes(returned)) return returned;
  const y = yearOf(returned);
  if (y) {
    const m = canonicos.find((c) => yearOf(c) === y);
    if (m) return m;
    return y; // sem canônico → colapsa para o ANO, alinhando BP ("31/12/2022") e DRE ("2022") do mesmo ano
  }
  return returned;
}
function periodKeyInstruction(periodos: string[]): string {
  if (!periodos.length) return "Use o(s) período(s) do documento como chave (ex.: o ano).";
  return `Use EXATAMENTE estas chaves de período: ${JSON.stringify(periodos)} (mapeie pelo ano).`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// input: ou um PDF (visão, caro) ou texto já extraído pelo parser (barato).
// Devolve os dados + os tokens consumidos (para medir custo por processo).
interface AskResult { data: any; inTok: number; outTok: number }
async function ask(input: { buffer?: Buffer; text?: string }, prompt: string, model: string = AI_MODEL, attempt = 0, maxTokens = 4000): Promise<AskResult> {
  const content: any[] = input.text
    ? [{ type: "text", text: `${prompt}\n\nCONTEÚDO EXTRAÍDO DO DOCUMENTO:\n${input.text}` }]
    : [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: input.buffer!.toString("base64") } },
        { type: "text", text: prompt },
      ];
  let msg;
  // MEDIDO SEM TROCAR O CAMINHO (03/08/2026). Delegar ao `createWithRetry` faria
  // esta função passar a usar STREAMING quando max_tokens > 12000 — caminho de
  // código diferente do que roda em produção hoje, e o teste de extração pegou.
  // Telemetria não pode mudar comportamento: mede-se aqui mesmo.
  const iniciadoIA = new Date();
  try {
    msg = await client.messages.create({ model, max_tokens: maxTokens, temperature: 0, messages: [{ role: "user", content }] });
  } catch (e: any) {
    if ((e?.status === 429 || e?.status === 529) && attempt < 4) {
      await sleep(7000 * (attempt + 1));
      return ask(input, prompt, model, attempt + 1, maxTokens);
    }
    void registrarUsoIA({
      etapa: input?.buffer ? ETAPAS.EXTRACAO_VISAO : ETAPAS.EXTRACAO_HIBRIDA,
      provedor: "anthropic", modelo: model, iniciadoEm: iniciadoIA,
      sequencia: attempt + 1, ehRetentativa: attempt > 0,
      status: "erro", erroTipo: String(e?.status ?? e?.name ?? "erro"),
    });
    throw e;
  }
  void registrarUsoIA({
    etapa: input?.buffer ? ETAPAS.EXTRACAO_VISAO : ETAPAS.EXTRACAO_HIBRIDA,
    provedor: "anthropic", modelo: model, iniciadoEm: iniciadoIA,
    tokens: usoDaResposta(msg),
    sequencia: attempt + 1, ehRetentativa: attempt > 0,
    stopReason: msg?.stop_reason ?? null,
    status: msg?.stop_reason === "max_tokens" ? "truncado" : "ok",
  });
  if (msg.stop_reason === "max_tokens") console.warn(`[ask] SAÍDA TRUNCADA em ${maxTokens} tokens (${model}) — captura pode estar incompleta`);
  let txt = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
  if (txt.startsWith("```")) txt = txt.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  const inTok = msg.usage?.input_tokens ?? 0;
  const outTok = msg.usage?.output_tokens ?? 0;
  let data: any = {};
  try { data = JSON.parse(txt); } catch {
    // JSON quebrado (preâmbulo, truncamento): tenta o maior objeto plausível antes de desistir.
    const ini = txt.indexOf("{"), fim = txt.lastIndexOf("}");
    if (ini >= 0 && fim > ini) { try { data = JSON.parse(txt.slice(ini, fim + 1)); } catch { data = {}; } }
    if (!Object.keys(data).length) console.warn(`[ask] resposta não-JSON (${outTok} tk out): "${txt.slice(0, 220).replace(/\n/g, " ")}…"`);
  }
  return { data: limparNomesDaResposta(data), inTok, outTok };
}

/**
 * UM FUNIL SÓ PARA O NOME QUE A IA DEVOLVE (13/08/2026).
 *
 * O nome que o modelo entrega virava árvore original, "não mapeados", tela e
 * chave de dicionário SEM PASSAR POR RÉGUA NENHUMA — enquanto o caminho
 * determinístico já limpava código do plano e sinal desde o parser. Como 85 dos
 * 115 PDFs de BP/DRE do acervo caem no LLM, a limpeza valia para a minoria dos
 * documentos: quem caísse na IA continuava alimentando o dicionário com
 * "4.03.02.01 PROCESSO …" e com o "(-)" duplicado do SPED.
 *
 * A limpeza vai AQUI, no ponto onde o JSON do modelo entra no sistema, e não nos
 * vinte lugares que leem `it.nome` depois — remendo espalhado vira régua
 * divergente na primeira correção.
 *
 * `limparNomeConta` (código + sinal) é a régua do que vem do DOCUMENTO, a mesma
 * que o parser aplica. A régua de IDENTIDADE é outra (`limparCodigoDoNome`) e
 * não é usada aqui de propósito.
 */
function limparNomesDaResposta<T>(no: T): T {
  if (Array.isArray(no)) return no.map((x) => limparNomesDaResposta(x)) as unknown as T;
  if (!no || typeof no !== "object") return no;
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(no as Record<string, unknown>)) {
    saida[k] = (k === "nome" || k === "conta") && typeof v === "string" ? limparNomeConta(v) : limparNomesDaResposta(v);
  }
  return saida as unknown as T;
}

/** Preço por TOKEN em USD (tabela Anthropic — atualizar se mudar). Haiku 4.5 = $1/$5 por
 *  Mtok; Sonnet 4.6 = $3/$15 por Mtok; Opus 4.8 = $5/$25 por Mtok. */
const PRECO_USD: Record<string, { in: number; out: number }> = {
  [AI_MODEL_FAST]: { in: 1 / 1e6, out: 5 / 1e6 },
  [AI_MODEL]: { in: 3 / 1e6, out: 15 / 1e6 },
  [AI_MODEL_OPUS]: { in: 5 / 1e6, out: 25 / 1e6 },
};
/** Quem é a etapa por trás da chamada — o que dá nome ao gasto no relatório. */
export interface MetaUsoIA { etapa: string; documentId?: string | null; modeloSolicitado?: string | null }

export interface CustoIA { modelo: string; inputTokens: number; outputTokens: number; usd: number }
export function calcCusto(modelo: string, inTok: number, outTok: number): CustoIA {
  const p = PRECO_USD[modelo] ?? { in: 0, out: 0 };
  return { modelo, inputTokens: inTok, outputTokens: outTok, usd: inTok * p.in + outTok * p.out };
}

/** Pergunta AVULSA de texto com resposta JSON (Haiku, barata) — para features
 *  pontuais fora do pipeline (ex.: escrever a fórmula do Modelo Financeiro).
 *  Devolve o custo junto: quem chama REGISTRA (regra da casa). */
export async function perguntarJson(prompt: string, maxTokens = 800, modelo: "haiku" | "sonnet" = "haiku"): Promise<{ data: Record<string, unknown>; custo: CustoIA }> {
  const modelId = modelo === "sonnet" ? AI_MODEL : AI_MODEL_FAST;
  // Passa pelo gate: ganha backoff de 429/529 (que aqui NÃO existia) e telemetria.
  const msg = await createWithRetry(
    { model: modelId, max_tokens: maxTokens, temperature: 0, messages: [{ role: "user", content: prompt }] },
    0,
    { etapa: ETAPAS.FORMULA_MODELO, modeloSolicitado: modelo },
  );
  let txt = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
  if (txt.startsWith("```")) txt = txt.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(txt); } catch {
    const i = txt.indexOf("{"), f = txt.lastIndexOf("}");
    if (i >= 0 && f > i) { try { data = JSON.parse(txt.slice(i, f + 1)); } catch { /* fica vazio */ } }
  }
  return { data, custo: calcCusto(modelId, msg.usage?.input_tokens ?? 0, msg.usage?.output_tokens ?? 0) };
}

/**
 * `messages.create` com retry/backoff em 429 (rate limit) e 529 (overloaded) —
 * espelha o que o `ask()` faz na extração. Picos transitórios da API NÃO podem
 * derrubar a geração da análise nem a pesquisa web (causa do "Erro ao processar"
 * intermitente). Erros não-transitórios (400/401/...) sobem na hora.
 */
export async function createWithRetry(params: any, attempt = 0, meta?: MetaUsoIA): Promise<any> {
  const iniciadoEm = new Date();
  try {
    // max_tokens grande (análise "para leigos": 24k) → o SDK EXIGE streaming em
    // requisições potencialmente longas ("Streaming is strongly recommended…").
    // O stream é consumido inteiro aqui e finalMessage() devolve o MESMO shape de
    // Message (content/usage/stop_reason) — os chamadores não mudam em nada.
    let msg: any;
    if (typeof params?.max_tokens === "number" && params.max_tokens > 12000) {
      const stream = client.messages.stream(params);
      msg = await stream.finalMessage();
    } else {
      msg = await client.messages.create(params);
    }
    // TELEMETRIA DE CUSTO (03/08/2026): esta é a porta por onde passam 11 das 15
    // etapas com IA. Instrumentar POR DENTRO cobre todas de uma vez, e o chamador
    // que não declarar `meta` grava etapa "desconhecida" — visível no relatório,
    // nunca invisível. Best-effort: `registrarUsoIA` engole o próprio erro.
    void registrarUsoIA({
      etapa: meta?.etapa ?? ETAPAS.DESCONHECIDA,
      provedor: "anthropic",
      modelo: params?.model ?? "desconhecido",
      modeloSolicitado: meta?.modeloSolicitado ?? null,
      documentId: meta?.documentId ?? null,
      iniciadoEm,
      tokens: usoDaResposta(msg),
      sequencia: attempt + 1,
      ehRetentativa: attempt > 0,
      stopReason: msg?.stop_reason ?? null,
      // Bater no teto de tokens gasta o token E entrega resultado truncado — o
      // relatório precisa mostrar isso separado de uma chamada sã.
      status: msg?.stop_reason === "max_tokens" ? "truncado" : "ok",
    });
    return msg;
  } catch (e: any) {
    if ((e?.status === 429 || e?.status === 529) && attempt < 4) {
      // 429/529 são rejeição ANTES do processamento: não há usage, não há custo.
      // O que importa registrar é que a chamada boa precisou de N tentativas —
      // vai em `sequencia` na linha que der certo.
      await sleep(7000 * (attempt + 1));
      return createWithRetry(params, attempt + 1, meta);
    }
    void registrarUsoIA({
      etapa: meta?.etapa ?? ETAPAS.DESCONHECIDA,
      provedor: "anthropic",
      modelo: params?.model ?? "desconhecido",
      documentId: meta?.documentId ?? null,
      iniciadoEm,
      sequencia: attempt + 1,
      ehRetentativa: attempt > 0,
      status: "erro",
      erroTipo: String(e?.status ?? e?.name ?? "erro"),
    });
    throw e;
  }
}

// ───────────────────────── DRE (captura da ÁRVORE de seções) ─────────────────────────
// Mesma filosofia do BP: a IA TRANSCREVE a hierarquia (seção → subseção → conta) sem
// julgar o nível; o fold classifica no nó mais alto que mapeia, com contexto do pai.
function dreTreePrompt(periodos: string[]): string {
  return `Você é especialista em contabilidade brasileira. TRANSCREVA a HIERARQUIA da DRE deste documento — fielmente, nível por nível, com o NOME ORIGINAL EXATO e o VALOR IMPRESSO de cada nó; filhos aninhados em "filhos".
- Um nó PAI (seção como "RECEITA OPERACIONAL BRUTA", "DESPESAS ADMINISTRATIVAS") leva o valor impresso na linha dele E os filhos aninhados — NÃO some nada por conta própria, NÃO pule níveis.
- PARE de descer quando os filhos virarem lançamentos individuais (notas, nomes de clientes/fornecedores, contratos) — retorne só o nó pai com o valor.
- NÃO retorne como nó as linhas de RESULTADO/subtotal CALCULADO entre seções (Receita Líquida, Lucro Bruto, EBITDA, EBIT, Resultado/Lucro/Prejuízo Líquido) — elas vão em "declarados".
- Sinais como impressos: RECEITAS positivas; DEDUÇÕES, CUSTOS, DESPESAS e IR/CSLL NEGATIVOS.
- COLUNAS: se houver "do mês"/"no período" e "acumulado"/"até a data", use o ACUMULADO do exercício (fechamento), nunca o mensal.
- DOCUMENTO COM MAIS DE UMA DRE (matriz e filiais — um bloco por CNPJ/estabelecimento, mesmo período): transcreva TODAS, até a última página; as seções de cada bloco entram na MESMA lista do período, na sequência. NÃO some blocos por conta própria e NUNCA descarte um bloco — perder uma filial subdimensiona a empresa inteira.
- ${periodKeyInstruction(periodos)}
Retorne APENAS JSON: { "secoes": { "<periodo>": [ {"nome":"<original>","valor":<n>,"filhos":[ {"nome":"<original>","valor":<n>} ]} ] }, "declarados": { "<periodo>": { "Receita Líquida": <exibido>, "Lucro Bruto": <exibido>, "Lucro Líquido": <exibido> } } }`;
}

/** Nome genérico ("Outras Obrigações", "Outros Créditos", "Diversos"…): quando cai no balde
 *  "Outros ..." do grupo, o balde É a classificação correta — não pede ação do analista. */
const ehNomeGenerico = (nome: string): boolean => /^(outros|outras|demais|diversos|diversas)( |$)/.test(nome.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim());
const normNome = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Seções que são SUBTOTAIS/pais na DRE. Se vierem na captura, seus filhos também
 *  vêm — então NÃO podem ser somadas na cascata (dupla contagem). */
const DRE_SUBTOTAIS = new Set([
  "despesas operacionais", "receitas e despesas operacionais", "despesas e receitas operacionais",
  "despesas operacionais liquidas", "total das despesas operacionais", "total despesas operacionais",
  "despesas e receitas operacionais liquidas", "outras receitas e despesas operacionais",
  "resultado operacional", "lucro operacional", "prejuizo operacional",
  "resultado antes do resultado financeiro", "lucro antes do resultado financeiro",
].map(normNome));
/** destinos que compõem o bloco operacional/financeiro — candidatos a "filhos" de um
 *  subtotal "Despesas Operacionais". Usados para decidir POR VALOR se o pai é redundante. */
const DESP_OP_DESTINOS = new Set([
  ...DRE_DESPESAS_OPERACIONAIS,
  "Outras Despesas Operacionais", "Outras Receitas Operacionais",
  "Receitas Financeiras", "Despesas Financeiras",
]);

/** Rede semântica mínima ANTES do balde: "Custo(s) …" é CUSTO (acima do Lucro Bruto),
 *  nunca despesa — cair no balde de despesas desloca o Lucro Bruto (visto no sweep:
 *  TECHWAY/AçãoCorretora/OCEANDROP). E "Impostos s/ vendas…" é DEDUÇÃO da receita. */
export function fallbackSemanticoDRE(nome: string): string | null {
  const n = normNome(nome);
  if (ehContaDePatrimonio(nome)) return null;
  if (/^\(?\s*-?\s*\)?\s*custos?\b/.test(n) && !/despes/.test(n)) return "Custo Operacional";
  if (/\bcustos? (de|dos|da|das|com) /.test(n) && !/despes/.test(n)) return "Custo Operacional";
  // Impostos sobre vendas/serviços/faturamento têm linha canônica PRÓPRIA —
  // não são "Deduções" (lá ficam devoluções/cancelamentos/abatimentos).
  if (/impostos? (s |s\/|sobre |incidentes)/.test(n) && /venda|servic|faturamento/.test(n)) return "Impostos s/ Faturamento";
  // "Receita Operacional (Bruta)" no TOPO da DRE é a receita bruta. Via caminho, dá
  // herança às folhas da seção (SPED AOCP: "ARRENDAMENTO" sob "Receita Operacional"
  // caía em Outras Receitas e a Receita Bruta ficava só com os serviços). Anclado no
  // início: nunca casa "Outras Receitas Operacionais" nem "Receita Líquida".
  if (/^receitas? operacion/.test(n) && !/liquida/.test(n)) return "Receita Bruta";
  // RECEITA DE (RE)VENDA — a regra-espelho do custo (13/08/2026, conciliação
  // manual do dono na Clorofila): "Custos Vendas Prod Terceiros" caía em Custo
  // Operacional pela regra de custo, mas "Receita de Revenda Producao
  // Terceitos" (R$ 947.961 em 2024; R$ 7.442.896 em 2025) não casava NADA e
  // ficava FORA da Receita Bruta — custo dentro, receita fora, margem mentindo
  // em todas as linhas abaixo. Regra de custo sem a regra-espelho de receita é
  // assimetria que só aparece na conciliação. Medido no corpus (12.088 nomes):
  // 3 casam, todos Receita Bruta legítima; a guarda barra venda de imobilizado/
  // sucata/canceladas (não-operacional ou dedução, nunca Receita Bruta).
  if (/^receitas? (de |da |com )?(re)?vendas?\b/.test(n) && !/imobilizad|ativo fixo|sucata|cancelad|devolu|nao operacional/.test(n)) {
    return "Receita Bruta";
  }
  return null;
}

export function foldDRE(arvore: ArvoreOriginalDRE, periodos: string[], dict?: DictionaryEntry[], dreModel?: DREModel): { dre: DRELineItem[]; naoMapeados: NaoMapeado[]; alertasComposicao: AlertaComposicaoBP[] } {
  // Bridge: usa o modelo DRE do banco (contas do editor) quando fornecido; senão, o template do código.
  const inputsSet = dreModel ? dreModel.inputs : dreInputsSet;
  const candidatosDRE = dreModel ? [...dreModel.inputs] : dreInputs;
  const templateLines: Array<{ conta: string; subtotal: boolean }> = dreModel ? dreModel.lines : DRE_TEMPLATE;
  const acc: Record<string, Record<string, number>> = {};
  const naoMapeados: NaoMapeado[] = [];
  const alertasComposicao: AlertaComposicaoBP[] = [];
  const addAcc = (dest: string, p: string, v: number) => { (acc[dest] ??= {})[p] = (acc[dest][p] ?? 0) + v; };
  const BALDES_DRE = new Set(["Outras Despesas Operacionais", "Outras Receitas Operacionais"]);

  for (const p of periodos) {
    const secoes = arvore[p] ?? [];
    const temHierarquia = secoes.some((it) => it.filhos && it.filhos.length > 0);

    if (!temHierarquia) {
      // ── Caminho FLAT (capturas legadas): comportamento anterior, intacto ──
      const subtotais = secoes.filter((it) => DRE_SUBTOTAIS.has(normNome(it.nome)));
      const inputs = secoes.filter((it) => !DRE_SUBTOTAIS.has(normNome(it.nome)));
      for (const it of inputs) {
        if (typeof it.valor !== "number" || it.valor === 0) continue;
        if (isContaIgnorada(it.nome, dict)) { it.destino = "(ignorada pelo analista)"; continue; }
        let dest = mapAccountToDRE(it.nome, dict, candidatosDRE);
        if (!dest || !inputsSet.has(dest)) dest = fallbackSemanticoDRE(it.nome);
        if (!dest || !inputsSet.has(dest)) {
          dest = it.valor < 0 ? "Outras Despesas Operacionais" : "Outras Receitas Operacionais";
          naoMapeados.push({ nome: it.nome, grupo: "DRE", destino: dest, valor: it.valor, periodo: p, tipo: "DRE" });
        }
        it.destino = dest;
        addAcc(dest, p, it.valor);
      }
      // Subtotais estruturais (pais) — descarte POR VALOR (só é pai se os filhos capturados
      // somarem ≈ o valor dele; senão é INPUT real e precisa entrar na cascata).
      const childSum = inputs
        .filter((it) => it.destino && DESP_OP_DESTINOS.has(it.destino))
        .reduce((s, it) => s + (it.valor || 0), 0);
      for (const st of subtotais) {
        if (typeof st.valor !== "number" || st.valor === 0) { st.destino = "(subtotal)"; continue; }
        const cobre = Math.abs(childSum) > 1 &&
          Math.abs(Math.abs(childSum) - Math.abs(st.valor)) / Math.abs(st.valor) < 0.12;
        if (cobre) { st.destino = "(subtotal — filhos já contabilizados)"; continue; }
        const dest = st.valor < 0 ? "Outras Despesas Operacionais" : "Outras Receitas Operacionais";
        st.destino = dest;
        naoMapeados.push({ nome: st.nome, grupo: "DRE", destino: dest, valor: st.valor, periodo: p, tipo: "DRE" });
        addAcc(dest, p, st.valor);
      }
      continue;
    }

    // ── Caminho ÁRVORE (mesma filosofia do foldBP v2) ──
    const tolDe = (v: number) => Math.max(0.05, Math.abs(v) * 0.001);
    const somaDireta = (filhos: DRESecaoItem[]): number =>
      filhos.reduce((s, f) => s + (typeof f.valor === "number" ? f.valor : 0), 0);
    const marcaAbsorvidos = (filhos: DRESecaoItem[], dest: string): void => {
      for (const f of filhos) { f.destino = `(absorvido em ${dest})`; if (f.filhos?.length) marcaAbsorvidos(f.filhos, dest); }
    };
    const processa = (it: DRESecaoItem, caminho: string[], heranca?: string): void => {
      if (isContaIgnorada(it.nome, dict)) { it.destino = "(ignorada pelo analista)"; return; }
      const temValor = typeof it.valor === "number" && it.valor !== 0;
      const filhos = it.filhos ?? [];
      // Wrapper conhecido ("Despesas Operacionais" etc.) nunca mapeia — é estrutural.
      const ehWrapper = DRE_SUBTOTAIS.has(normNome(it.nome));
      // Blindagem contextual: o bloco declarado pelo caminho (CUSTOS × DESPESAS) participa
      // da consulta ao dicionário — a POSIÇÃO no documento tem prioridade sobre o nome.
      const blocoCtx = blocoDoCaminhoDRE(caminho);
      let dest = !ehWrapper && temValor ? mapAccountToDRE(it.nome, dict, candidatosDRE, blocoCtx) : null;
      let conflitoCtx = false;
      if (dest === CONFLITO_CONTEXTO_DRE) {
        // O dicionário só conhece esta conta em OUTRO bloco (ex.: cadastrada como despesa,
        // mas aqui está debaixo de CUSTOS). A posição manda: classifica pelo bloco do
        // documento e abre âmbar — o analista confirma e nasce a entrada CONTEXTUAL,
        // que passa a coexistir com a original (mesma garantia do BP para CP/LP).
        conflitoCtx = true;
        dest = blocoCtx === "custo"
          ? "Custo Operacional"
          : it.valor < 0 ? "Outras Despesas Operacionais" : "Outras Receitas Operacionais";
      }
      if (dest && !inputsSet.has(dest)) { dest = null; conflitoCtx = false; }
      if (!dest && !ehWrapper && temValor) {
        dest = fallbackSemanticoDRE(it.nome);
        if (dest && !inputsSet.has(dest)) dest = null; // modelo DRE custom pode não ter a linha
      }
      if (dest && BALDES_DRE.has(dest) && filhos.length > 0) { dest = null; conflitoCtx = false; } // filhos podem ser mais específicos
      if (dest) {
        // DESCIDA POR DIVERGÊNCIA: se algum filho DIRETO mapeia (com prova de
        // dicionário) para um destino canônico DIFERENTE e a soma dos filhos
        // FECHA com o valor declarado, classificar os filhos preserva o total
        // E ganha o detalhe — ex.: o documento agrega "Impostos Incidentes
        // sobre Vendas" dentro de "Deduções da Receita Bruta"; absorver
        // apagaria a linha canônica "Impostos s/ Faturamento".
        if (filhos.length && Math.abs(somaDireta(filhos) - it.valor) <= tolDe(it.valor)) {
          const blocoFilho = blocoDoCaminhoDRE([...caminho, it.nome]);
          const divergente = filhos.some((f) => {
            if (typeof f.valor !== "number" || f.valor === 0) return false;
            // A prova pode vir do dicionário OU da rede semântica determinística
            // (fallbackSemanticoDRE) — ex.: "Impostos s/ Vendas" sob "Deduções".
            let dF = mapAccountToDRE(f.nome, dict, candidatosDRE, blocoFilho);
            if (!dF || dF === CONFLITO_CONTEXTO_DRE || !inputsSet.has(dF)) {
              const fbF = fallbackSemanticoDRE(f.nome);
              dF = fbF && inputsSet.has(fbF) ? fbF : null;
            }
            // Balde genérico não prova divergência (mesma regra do foldBP).
            return !!dF && dF !== CONFLITO_CONTEXTO_DRE && inputsSet.has(dF) && dF !== dest && !BALDES_DRE.has(dF);
          });
          if (divergente) {
            it.destino = "(estrutural — filhos classificados)";
            // Filho sem mapa próprio HERDA o destino do pai (é onde a
            // absorção o teria colocado) — nunca cai no balde por causa da descida.
            for (const f of filhos) processa(f, [...caminho, it.nome], dest);
            return;
          }
        }
        addAcc(dest, p, it.valor);
        it.destino = dest;
        if (conflitoCtx) {
          naoMapeados.push({ nome: it.nome, grupo: caminho.length ? `DRE > ${caminho.join(" > ")}` : "DRE", destino: dest, valor: it.valor, periodo: p, tipo: "DRE" });
        }
        if (filhos.length) {
          marcaAbsorvidos(filhos, dest);
          const s = somaDireta(filhos);
          if (Math.abs(s - it.valor) > tolDe(it.valor)) {
            // INFO: o nó mapeou e usou o valor DECLARADO — total certo; só transparência.
            alertasComposicao.push({ periodo: p, grupo: "DRE", caminho: [...caminho, it.nome].join(" > "), declarado: it.valor, somaFilhos: s, delta: it.valor - s, severidade: "info" });
          }
        }
        return;
      }
      if (filhos.length) {
        it.destino = "(estrutural — filhos classificados)";
        for (const f of filhos) processa(f, [...caminho, it.nome], heranca);
        if (temValor) {
          const s = somaDireta(filhos);
          if (Math.abs(s - it.valor) > tolDe(it.valor)) {
            const delta = it.valor - s;
            addAcc(delta < 0 ? "Outras Despesas Operacionais" : "Outras Receitas Operacionais", p, delta);
            // ERRO: delta foi para o balde — a composição precisa de revisão.
            alertasComposicao.push({ periodo: p, grupo: "DRE", caminho: [...caminho, it.nome].join(" > "), declarado: it.valor, somaFilhos: s, delta, severidade: "erro" });
          }
        }
        return;
      }
      if (!temValor) return;
      // Folha sem mapa direto: contexto do pai ("Receita Operacional Bruta Vendas de Produtos…").
      const ctx = caminho.length ? mapAccountToDRE(`${caminho[caminho.length - 1]} ${it.nome}`, undefined, candidatosDRE) : null;
      if (ctx && inputsSet.has(ctx)) { addAcc(ctx, p, it.valor); it.destino = ctx; return; }
      const fb = fallbackSemanticoDRE(it.nome) ?? (caminho.length ? fallbackSemanticoDRE(caminho[caminho.length - 1]) : null);
      if (fb && inputsSet.has(fb)) { addAcc(fb, p, it.valor); it.destino = fb; return; }
      // Herança da descida por divergência: o destino do pai mapeado.
      if (heranca && inputsSet.has(heranca)) { addAcc(heranca, p, it.valor); it.destino = heranca; return; }
      const balde = it.valor < 0 ? "Outras Despesas Operacionais" : "Outras Receitas Operacionais";
      addAcc(balde, p, it.valor);
      it.destino = balde;
      if (ehNomeGenerico(it.nome)) return; // genérico no balde = classificação correta (sem âmbar)
      naoMapeados.push({ nome: it.nome, grupo: caminho.length ? `DRE > ${caminho.join(" > ")}` : "DRE", destino: balde, valor: it.valor, periodo: p, tipo: "DRE" });
    };
    for (const it of secoes) processa(it, []);
  }

  const dre: DRELineItem[] = templateLines.map((t) => ({
    conta: t.conta, valores: t.subtotal ? {} : (acc[t.conta] ?? {}), subtotal: t.subtotal, editado: false,
  }));
  normalizeDRESigns(dre, periodos);
  recomputeDRESubtotals(dre, periodos, dreModel?.extrasPorBloco);
  return { dre, naoMapeados, alertasComposicao };
}

// ───────────────────────── BP (captura da ÁRVORE COMPLETA) ─────────────────────────
// Filosofia: a IA NÃO julga qual é "o nível certo" (isso não existe globalmente num doc
// de 1-7 níveis) — ela TRANSCREVE a hierarquia fielmente. Todo julgamento estrutural
// (subtotal, absorção, classificação) é do fold, determinístico e auditável.
function bpTreePrompt(periodos: string[]): string {
  return `Você é especialista em contabilidade brasileira. TRANSCREVA a HIERARQUIA COMPLETA do BALANÇO PATRIMONIAL deste documento — fielmente, nível por nível, sem julgar nem resumir.

Para cada um dos 5 grupos, retorne a ÁRVORE de contas como aparece no documento: cada nó com o NOME ORIGINAL EXATO, o VALOR IMPRESSO ao lado dele, e seus filhos aninhados em "filhos".
- Um nó PAI leva o valor impresso na linha dele (o subtotal declarado) E os filhos aninhados — NÃO some nada por conta própria, NÃO pule níveis, NÃO invente nomes.
- PARE de descer quando os filhos deixarem de ser CONTAS e virarem lançamentos individuais (bancos específicos, contratos, parcelas numeradas, CNPJs, nomes de pessoas/clientes): nesse caso retorne só o nó pai com seu valor, sem "filhos".
- Wrappers que são o PRÓPRIO grupo (ex.: "CIRCULANTE", "NÃO CIRCULANTE", "EXIGÍVEL A CURTO PRAZO" como primeiro nível) NÃO entram como nó — o grupo já é a chave. MAS as contas abaixo deles entram TODAS, preservando a hierarquia interna.
- Níveis INTERMEDIÁRIOS entre o grupo e as contas-folha (ex.: "EXIGÍVEL A CURTO PRAZO" dentro do Passivo Circulante, "CRÉDITOS" dentro do Ativo Circulante) SÃO nós normais: transcreva cada um COM seus filhos aninhados, em QUALQUER profundidade (grau 4, 5, 6+). NUNCA resuma um nível intermediário numa linha única e NUNCA omita as contas-folha abaixo dele.
- Valores negativos com sinal negativo (ex.: depreciação, encargos, retificadoras "(-)").
- COLUNAS: se o documento (ex.: ECF/ECD/SPED, "Período da Escrituração DD/MM a DD/MM") trouxer "Saldo Inicial" e "Saldo Final" do MESMO período, use SEMPRE o Saldo FINAL (fechamento) — nunca o inicial. (Não confundir com colunas de ANOS diferentes, que são períodos distintos e cada um vale.)
- DOCUMENTO COM MAIS DE UM BALANÇO (matriz e filiais — um bloco por CNPJ/estabelecimento, mesmo período): transcreva TODOS, até a última página; as contas de cada bloco entram nos MESMOS grupos do período, na sequência. NÃO some blocos por conta própria e NUNCA descarte um bloco.
- ${periodKeyInstruction(periodos)}
Grupos: "Ativo Circulante", "Ativo Não Circulante", "Passivo Circulante", "Passivo Não Circulante", "Patrimônio Líquido".
Retorne APENAS JSON:
{ "<periodo>": { "grupos": { "Passivo Circulante": [ {"nome":"<original>","valor":<n>,"filhos":[ {"nome":"<original>","valor":<n>} ]} ], ... }, "totais": { "Ativo Total": <n>, "Passivo Total": <n> } } }`;
}

const GRP: Record<string, string> = {
  "Ativo Circulante": "AC", "Ativo Não Circulante": "ANC",
  "Passivo Circulante": "PC", "Passivo Não Circulante": "PNC", "Patrimônio Líquido": "PL",
};
// Contas de COMPENSAÇÃO (memorando): aparecem dos dois lados com o mesmo valor para se
// anular — não são bens/dívidas reais. Excluídas do BP para não inflar Ativo e Passivo.
const isCompensacao = (nome: string): boolean => /compensa[çc][aã]o/i.test(nome);
const OUTROS_GRUPO: Record<string, string | null> = {
  AC: "Outros Ativos Circulantes", PC: "Outros Passivos Circulantes",
  ANC: "Outros Ativos Não Circulantes", PNC: "Outros Passivos não Circulantes",
  // O PL passou a ter balde (10/08/2026): sem ele o valor entrava no subtotal
  // e não aparecia em linha nenhuma — dinheiro invisível no balanço.
  PL: "Outras Contas do Patrimônio Líquido",
};

/** Busca um SUBCONJUNTO de `vals` que some ≈ `alvo` (DFS com poda e teto de nós).
 *  Retorna os índices do subconjunto, ou null. Tolerância apertada (centavos) —
 *  subtotal duplicado bate exato; coincidência de contas reais quase nunca. */
function achaSubsetSoma(vals: number[], alvo: number, tol: number): number[] | null {
  const ordem = vals.map((_, i) => i).sort((a, b) => Math.abs(vals[b]) - Math.abs(vals[a]));
  const sufAbs: number[] = new Array(ordem.length + 1).fill(0);
  for (let i = ordem.length - 1; i >= 0; i--) sufAbs[i] = sufAbs[i + 1] + Math.abs(vals[ordem[i]]);
  let nos = 0;
  const caminho: number[] = [];
  const dfs = (i: number, resto: number): number[] | null => {
    if (caminho.length > 0 && Math.abs(resto) <= tol) return [...caminho];
    if (i >= ordem.length || ++nos > 20000) return null;
    if (Math.abs(resto) - sufAbs[i] > tol) return null; // inalcançável mesmo com tudo
    caminho.push(ordem[i]);
    const com = dfs(i + 1, resto - vals[ordem[i]]);
    caminho.pop();
    if (com) return com;
    return dfs(i + 1, resto);
  };
  return dfs(0, alvo);
}

/** Detecta relações PAI→FILHOS numa captura FLAT (a IA nem sempre aninha): uma linha
 *  cujo valor é a soma exata de OUTRAS linhas do mesmo grupo/período é o PAI delas.
 *  Em vez de descartar o pai (que órfãva os filhos), RECONSTRUÍMOS a árvore — o fold
 *  então aplica a mesma lógica estrutural (pai que mapeia absorve; senão desce com
 *  contexto). Segurança: match a centavos (tol ≤ R$0,05); pareamento 1-para-1 só
 *  quando um nome contém o outro (valores iguais de contas distintas não são pai/filho). */
function detectaPaisFlat(itens: BPN3Item[]): Map<BPN3Item, BPN3Item[]> {
  const pares = new Map<BPN3Item, BPN3Item[]>();
  const validos = itens.filter((it) => typeof it.valor === "number" && it.valor !== 0 && !isCompensacao(it.nome));
  if (validos.length < 2) return pares;
  const usadoComoFilho = new Set<BPN3Item>();
  const ordenados = [...validos].sort((a, b) => Math.abs(b.valor) - Math.abs(a.valor)); // pais tendem a ser maiores
  for (const cand of ordenados) {
    if (pares.has(cand) || usadoComoFilho.has(cand)) continue;
    const outros = validos.filter((o) => o !== cand && !pares.has(o) && !usadoComoFilho.has(o));
    if (!outros.length) continue;
    const subset = achaSubsetSoma(outros.map((o) => o.valor), cand.valor, 0.05);
    if (!subset) continue;
    if (subset.length === 1) {
      const a = normNome(cand.nome), b = normNome(outros[subset[0]].nome);
      if (!(a.includes(b) || b.includes(a))) continue;
    }
    const filhos = subset.map((idx) => outros[idx]);
    pares.set(cand, filhos);
    for (const f of filhos) usadoComoFilho.add(f);
  }
  return pares;
}

/** Divergência de COMPOSIÇÃO: um nó declara um subtotal que não bate com a soma dos
 *  filhos capturados/classificados. O total não quebra (o delta é preservado), mas a
 *  composição precisa de revisão — é o alarme que faltava ("verde só com prova"). */
export interface AlertaComposicaoBP {
  periodo: string; grupo: string; caminho: string;
  declarado: number; somaFilhos: number; delta: number;
  /** "info" = nó mapeado usou o valor DECLARADO (total certo; captura interna incompleta —
   *  transparência, sem impacto). "erro" = delta foi para "Outros" (composição a revisar). */
  severidade: "info" | "erro";
}

/**
 * CONSERVAÇÃO DE VALOR (10/08/2026) — "o dinheiro que entra tem de sair".
 *
 * Cada folha do documento credita DOIS acumuladores: o subtotal do grupo (que
 * vira "Ativo Total"/"Passivo Total") e a linha de detalhe (que vira a conta
 * exibida e alimenta o Fluxo de Caixa). Quando o grupo não tem conta-balde no
 * modelo — o caso do Patrimônio Líquido — o valor entrava SÓ no subtotal: o
 * balanço continuava fechando, a linha sumia da tela e o FC deixava de bater
 * sem ninguém saber por quê ("por que o fluxo de caixa não bate com o BP?").
 *
 * A prova soma os dois lados e, quando divergem, NOMEIA a conta onde o
 * dinheiro ficou. Determinística, sem custo.
 */
export interface ConservacaoValorBP {
  periodo: string;
  /** Σ dos subtotais dos grupos (o que entrou do documento). */
  entrou: number;
  /** Σ das linhas de detalhe (o que saiu para a tela e para o FC). */
  saiu: number;
  diferenca: number;
  ok: boolean;
  vazamentos: Array<{ conta: string; grupo: string; valor: number; motivo: string }>;
}

export function foldBP(arvore: ArvoreOriginalBP, periodos: string[], dict?: DictionaryEntry[], model: BPModel = DEFAULT_BP_MODEL): { bp: BPLineItem[]; naoMapeados: NaoMapeado[]; alertasComposicao: AlertaComposicaoBP[]; conservacao: ConservacaoValorBP[] } {
  // Linhas do modelo que NÃO são input (subtotais/totais: "Passivo Circulante", "Ativo
  // Total"...). Um mapeamento para elas (dicionário/alias) identifica o nó como o PRÓPRIO
  // grupo/agregado reafirmado — NUNCA pode ser destino de absorção: o valor cairia numa
  // chave que nenhuma linha de input lê (a montagem lê subtotais de `subtotal[classif]`)
  // e as folhas seriam descartadas (caso Fibracabos Grau 4: "EXIGÍVEL A CURTO PRAZO" →
  // "Passivo Circulante" engolia Fornecedores/Obrigações e a composição do PC ficava R$ 0).
  const naoInputModelo = new Set(model.lines.filter((l) => l.tipo !== "input").map((l) => l.conta));
  /**
   * BALDE RESOLVIDO CONTRA O MODELO EM USO (10/08/2026). O nome canônico só
   * serve se a EMPRESA tiver essa linha: modelo copy-on-write (empresa que
   * editou o BP) pode não ter, e creditar um nome que nenhuma linha lê deixaria
   * o dinheiro invisível na tela COM a prova de conservação passando — o pior
   * dos mundos. Sem balde no modelo, devolve null: vira vazamento declarado.
   */
  const baldeDoGrupo = (g: string): string | null => {
    const canonico = OUTROS_GRUPO[g];
    if (canonico && model.names.includes(canonico)) return canonico;
    const doGrupo = model.lines.filter((l) => l.tipo === "input" && l.classificacao === g);
    return doGrupo.find((l) => /^outr[oa]s?\b/i.test(l.conta))?.conta ?? null;
  };
  const alertasComposicao: AlertaComposicaoBP[] = [];
  const vazamentos: ConservacaoValorBP["vazamentos"] & { periodo: string }[] = [] as never;
  const detalhe: Record<string, Record<string, number>> = {}; // conta → periodo → valor
  const subtotal: Record<string, Record<string, number>> = {}; // grupoCode → periodo → valor
  const naoMapeados: NaoMapeado[] = [];
  // Referências das folhas âmbar (para a exclusão automática de subtotal duplicado no pós-passe)
  const ambarRefs: Array<{ it: BPN3Item; grupoNome: string; g: string; p: string; v: number; balde: string | null; nm: NaoMapeado }> = [];
  const add = (acc: Record<string, Record<string, number>>, k: string, p: string, v: number) => { (acc[k] ??= {})[p] = (acc[k][p] ?? 0) + v; };

  for (const p of periodos) {
    const cap = arvore[p]; if (!cap) continue;

    // Detecta a convenção CRÉDITO-NEGATIVO (SPED): Ativo positivo, Passivo+PL negativos
    // (somam zero). Só vira o sinal do lado do Passivo quando o TOTAL dele é negativo —
    // assim PL negativo por prejuízo acumulado (com Passivo Total positivo) NÃO é afetado.
    let ativoRaw = 0, passivoRaw = 0;
    for (const [grupoNome, itens] of Object.entries(cap.grupos ?? {})) {
      const g = GRP[grupoNome]; if (!g) continue;
      for (const it of itens) {
        if (typeof it.valor !== "number" || isCompensacao(it.nome)) continue;
        if (g === "AC" || g === "ANC") ativoRaw += it.valor; else passivoRaw += it.valor;
      }
    }
    const flipPassivo = passivoRaw < 0 && ativoRaw > 0;

    for (const [grupoNome, itens] of Object.entries(cap.grupos ?? {})) {
      const g = GRP[grupoNome]; if (!g) continue;
      const fator = flipPassivo && (g === "PC" || g === "PNC" || g === "PL") ? -1 : 1;
      // Captura FLAT (a IA nem sempre aninha, e capturas antigas não têm `filhos`):
      // RECONSTRÓI a árvore pela relação de valor (pai = soma exata dos filhos) e roda a
      // MESMA lógica estrutural — pai que mapeia absorve os filhos (sem órfãos), pai que
      // não mapeia desce com contexto. Mutação in-place: a auditoria passa a ver aninhado.
      const temHierarquia = itens.some((it) => it.filhos && it.filhos.length > 0);
      let itensNivel0 = itens;
      if (!temHierarquia) {
        const pares = detectaPaisFlat(itens);
        if (pares.size > 0) {
          const filhosSet = new Set<BPN3Item>();
          for (const [pai, filhos] of pares) { pai.filhos = filhos; for (const f of filhos) filhosSet.add(f); }
          itensNivel0 = itens.filter((it) => !filhosSet.has(it));
          cap.grupos[grupoNome] = itensNivel0; // persiste a árvore reconstruída (auditoria aninhada)
        }
      }

      const somaDireta = (filhos: BPN3Item[]): number =>
        filhos.reduce((s, f) => s + (typeof f.valor === "number" && !isCompensacao(f.nome) ? f.valor : 0), 0);
      const tolDe = (v: number) => Math.max(0.05, Math.abs(v) * 0.001);
      const marcaAbsorvidos = (filhos: BPN3Item[], dest: string): void => {
        for (const f of filhos) { f.destino = `(absorvido em ${dest})`; if (f.filhos?.length) marcaAbsorvidos(f.filhos, dest); }
      };

      // ÁRVORE: classifica no nó MAIS ALTO que mapeia (a subárvore é absorvida — usa o
      // subtotal DECLARADO do nó, fiel ao documento); pai que não mapeia é ESTRUTURAL e
      // desce para os filhos, com o valor declarado virando PROVA de composição; folha
      // ambígua tenta o contexto do pai ("Obrigações Trabalhistas Provisões") antes do balde.
      const processa = (it: BPN3Item, caminho: string[]): void => {
        if (isCompensacao(it.nome)) { it.destino = "(compensação — excluída)"; return; }
        if (isContaIgnorada(it.nome, dict)) { it.destino = "(ignorada pelo analista)"; return; }
        const temValor = typeof it.valor === "number";
        const filhos = it.filhos ?? [];

        const destBruto = temValor ? mapAccountToBPGroup(it.nome, g, dict, model) : null;
        // (a) Destino que é SUBTOTAL/TOTAL do modelo: o nó "equivale ao grupo" — é
        // ESTRUTURAL por definição, em QUALQUER profundidade. Nunca absorve: com filhos,
        // desce e classifica as folhas; sem filhos, cai no tratamento de folha (balde do
        // grupo + âmbar), preservando o total e a prova de composição.
        const destEhSubtotalModelo = destBruto != null && naoInputModelo.has(destBruto);
        // (b) Se o pai só mapeia para um destino GENÉRICO — o balde do grupo OU qualquer linha
        // "Outros/Outras ..." (ex.: "Outros Créditos a Receber - CP") — mas TEM filhos,
        // prefira descer: os filhos podem classificar mais específico (ex.: "Tributos a
        // Recuperar" sob "OUTROS CRÉDITOS" → linha própria). Pior caso, o filho cai no
        // mesmo destino do pai via contexto — nunca pior que a absorção.
        const destEhGenerico = destBruto != null &&
          (Object.values(OUTROS_GRUPO).includes(destBruto) || /^outr[oa]s\b/.test(normNome(destBruto)));
        // (c) Pai-AGREGADO provado por VALOR: mapeia para um input específico (ex.: alias
        // "CRÉDITOS" → Contas a Receber - CP), mas os filhos somam exatamente o valor dele
        // E pelo menos um filho classifica DIRETO em OUTRA linha do modelo — absorver aqui
        // misturaria contas de naturezas distintas (Impostos a Recuperar, Adiantamentos...)
        // numa linha só. Trata como estrutural e desce; como a soma fecha, nada se perde.
        // Filhos homogêneos (mesmo destino do pai, ex.: bancos sob "Disponibilidades")
        // seguem absorvidos como antes.
        let paiAgregado = false;
        if (destBruto && !destEhSubtotalModelo && !destEhGenerico && filhos.length > 0 && temValor) {
          const sFilhos = somaDireta(filhos);
          if (Math.abs(sFilhos - it.valor) <= tolDe(it.valor)) {
            paiAgregado = filhos.some((f) => {
              if (typeof f.valor !== "number" || isCompensacao(f.nome)) return false;
              const df = mapAccountToBPGroup(f.nome, g, dict, model);
              // Destino GENÉRICO ("Outros …") não prova divergência: descer para jogar
              // o filho num balde perde a especificidade da linha do PAI (ex.: "Despesas
              // do Exercício Seguinte" → Outros AC descia e esvaziava "Despesas Ant.").
              if (df == null || naoInputModelo.has(df) || df === destBruto) return false;
              return !(Object.values(OUTROS_GRUPO).includes(df) || /^outr[oa]s\b/.test(normNome(df)));
            });
          }
        }
        const dest = destEhSubtotalModelo || paiAgregado || (destEhGenerico && filhos.length > 0) ? null : destBruto;
        if (dest) {
          const v = it.valor * fator;
          add(subtotal, g, p, v);
          add(detalhe, dest, p, v);
          it.destino = dest; // anota a trilha original → padrão
          if (filhos.length) {
            marcaAbsorvidos(filhos, dest);
            const s = somaDireta(filhos);
            if (Math.abs(s - it.valor) > tolDe(it.valor)) {
              // INFO: o nó mapeou e usou o valor DECLARADO — total certo; só transparência.
              alertasComposicao.push({ periodo: p, grupo: grupoNome, caminho: [...caminho, it.nome].join(" > "), declarado: it.valor, somaFilhos: s, delta: it.valor - s, severidade: "info" });
            }
          }
          return;
        }
        if (filhos.length) {
          it.destino = "(estrutural — filhos classificados)";
          for (const f of filhos) processa(f, [...caminho, it.nome]);
          if (temValor) {
            const s = somaDireta(filhos);
            if (Math.abs(s - it.valor) > tolDe(it.valor)) {
              // Delta preservado no balde (o total NUNCA se perde) + alerta apontando o nó.
              const delta = (it.valor - s) * fator;
              const balde = baldeDoGrupo(g);
              if (balde) { add(detalhe, balde, p, delta); add(subtotal, g, p, delta); }
              else (vazamentos as unknown as Array<Record<string, unknown>>).push({
                periodo: p, conta: `${it.nome} (diferença de composição)`, grupo: grupoNome, valor: delta,
                motivo: `o grupo ${grupoNome} não tem conta-balde no modelo: a diferença entre o valor declarado e a soma dos filhos não tem onde aparecer`,
              });
              // ERRO: delta foi para o balde — a composição precisa de revisão.
              alertasComposicao.push({ periodo: p, grupo: grupoNome, caminho: [...caminho, it.nome].join(" > "), declarado: it.valor, somaFilhos: s, delta: it.valor - s, severidade: "erro" });
            }
          }
          return;
        }
        if (!temValor) return; // nó sem valor e sem filhos — nada a somar
        const v = it.valor * fator;
        add(subtotal, g, p, v);
        // Folha sem mapa direto: tenta com o CONTEXTO do pai (keyword herda a semântica
        // da hierarquia — ex.: "Provisões" sob "Obrigações Trabalhistas" → Obrig. Trab. - CP).
        const comContexto = caminho.length
          ? mapAccountToBPGroup(`${caminho[caminho.length - 1]} ${it.nome}`, g, undefined, model)
          : null;
        // (contexto também nunca pode apontar para subtotal/total do modelo)
        if (comContexto && !naoInputModelo.has(comContexto)) { add(detalhe, comContexto, p, v); it.destino = comContexto; return; }
        const balde = baldeDoGrupo(g);
        if (balde) add(detalhe, balde, p, v);
        else (vazamentos as unknown as Array<Record<string, unknown>>).push({
          periodo: p, conta: it.nome, grupo: grupoNome, valor: v,
          motivo: `o modelo de BP desta empresa não tem conta-balde no grupo ${grupoNome} ("Outros…"): o valor entra no total mas não aparece em nenhuma linha (some da tela e do Fluxo de Caixa)`,
        });
        it.destino = balde ?? "(não classificado)";
        // Nome GENÉRICO ("Outras Obrigações", "Outros Créditos"...) que caiu no balde
        // "Outros ..." do próprio grupo: o balde É a classificação correta por definição —
        // não pede ação do analista (nada de âmbar).
        if (balde && ehNomeGenerico(it.nome)) return;
        const nm: NaoMapeado = { nome: it.nome, grupo: caminho.length ? `${grupoNome} > ${caminho.join(" > ")}` : grupoNome, destino: it.destino, valor: v, periodo: p, tipo: "BP" };
        naoMapeados.push(nm);
        ambarRefs.push({ it, grupoNome, g, p, v, balde: balde ?? null, nm });
      };
      for (const it of itensNivel0) processa(it, []);
    }
  }

  // ── EXCLUSÃO AUTOMÁTICA de SUBTOTAL DUPLICADO por prova de equilíbrio ──
  // O detectaPaisFlat resolve o grupo 100% flat; num grupo SEMI-hierárquico ele é pulado
  // e um total repetido vira folha âmbar somando em DUPLICIDADE — e o analista poderia
  // classificá-lo, dobrando o valor. Exclui automaticamente SÓ com prova dupla:
  // (1) a linha PARECE subtotal — valor = subconjunto dos irmãos de nível 0, duplicata
  //     exata de um irmão ou nome "total/soma/subtotal"; e
  // (2) removê-la FECHA o balanço (Ativo = Passivo) e é a ÚNICA âmbar que fecha
  //     (duplicatas exatas entre si contam como uma — excluir qualquer uma dá no mesmo).
  // Ambíguo → não mexe: fica âmbar para o analista. A prova fica anotada no destino.
  for (const p of periodos) {
    const cap = arvore[p]; if (!cap) continue;
    const somaA = (subtotal.AC?.[p] ?? 0) + (subtotal.ANC?.[p] ?? 0);
    const somaP = (subtotal.PC?.[p] ?? 0) + (subtotal.PNC?.[p] ?? 0) + (subtotal.PL?.[p] ?? 0);
    const delta = somaA - somaP;
    if (Math.abs(delta) <= Math.max(0.05, Math.abs(somaA) * 0.0001)) continue; // balanço já fecha
    const tolDe = (v: number) => Math.max(0.05, Math.abs(v) * 0.001);
    const candidatas = ambarRefs.filter((r) => {
      if (r.p !== p) return false;
      const novoDelta = r.g === "AC" || r.g === "ANC" ? delta - r.v : delta + r.v;
      if (Math.abs(novoDelta) > tolDe(r.v)) return false; // remover não fecha o balanço
      if (/\b(total|soma|subtotal)\b/i.test(r.it.nome)) return true;
      const irmaos = (cap.grupos[r.grupoNome] ?? []).filter((s) => s !== r.it && typeof s.valor === "number" && !isCompensacao(s.nome));
      const vals = irmaos.map((s) => s.valor);
      if (vals.some((x) => Math.abs(x - r.it.valor) <= tolDe(r.it.valor))) return true; // duplicata de irmão
      return achaSubsetSoma(vals, r.it.valor, tolDe(r.it.valor)) != null; // soma de irmãos
    });
    if (!candidatas.length) continue;
    const c0 = candidatas[0];
    const equivalentes = candidatas.every((r) =>
      r.grupoNome === c0.grupoNome && normNome(r.it.nome) === normNome(c0.it.nome) && Math.abs(r.it.valor - c0.it.valor) <= 0.05);
    if (!equivalentes) continue; // mais de uma candidata DISTINTA = ambíguo → analista decide
    add(subtotal, c0.g, p, -c0.v);
    if (c0.balde) add(detalhe, c0.balde, p, -c0.v);
    c0.it.destino = "(subtotal duplicado — excluído automaticamente: sem esta linha o balanço fecha)";
    const ix = naoMapeados.indexOf(c0.nm);
    if (ix >= 0) naoMapeados.splice(ix, 1);
  }

  // Estrutura por TIPO + CLASSIFICAÇÃO (códigos estáveis), não por nome — robusto a
  // renomeação do modelo. Subtotal = soma do grupo; total = soma dos subtotais.
  const bp: BPLineItem[] = model.lines.map((t) => {
    let valores: Record<string, number> = {};
    if (t.tipo === "total") {
      if (t.classificacao === "AT") for (const p of periodos) valores[p] = (subtotal.AC?.[p] ?? 0) + (subtotal.ANC?.[p] ?? 0);
      else if (t.classificacao === "PT") for (const p of periodos) valores[p] = (subtotal.PC?.[p] ?? 0) + (subtotal.PNC?.[p] ?? 0) + (subtotal.PL?.[p] ?? 0);
    } else if (t.tipo === "subtotal") {
      valores = subtotal[t.classificacao] ?? {};
    } else {
      valores = detalhe[t.conta] ?? {};
    }
    return { classificacao: t.classificacao, conta: t.conta, valores, nivel: t.nivel, editado: false };
  });
  // ── Conservação de valor: Σ subtotais × Σ detalhe, por período ──
  const conservacao: ConservacaoValorBP[] = periodos.map((p) => {
    const entrou = arred2(Object.values(subtotal).reduce((s2, porPeriodo) => s2 + (porPeriodo[p] ?? 0), 0));
    const saiu = arred2(Object.values(detalhe).reduce((s2, porPeriodo) => s2 + (porPeriodo[p] ?? 0), 0));
    const diferenca = arred2(entrou - saiu);
    const doPeriodo = (vazamentos as unknown as Array<{ periodo: string; conta: string; grupo: string; valor: number; motivo: string }>)
      .filter((v) => v.periodo === p)
      .map(({ conta, grupo, valor, motivo }) => ({ conta, grupo, valor, motivo }));
    return { periodo: p, entrou, saiu, diferenca, ok: Math.abs(diferenca) <= Math.max(0.05, Math.abs(entrou) * 1e-9), vazamentos: doPeriodo };
  });

  return { bp, naoMapeados, alertasComposicao, conservacao };
}

/** Arredonda a 2 casas — a conservação é conferida ao centavo. */
const arred2 = (n: number): number => Math.round(n * 100) / 100;

export async function extractFinancialsWithAI(
  docs: Array<{ buffer?: Buffer; raw?: string; rawIndent?: string; linhas?: ExtractedRow[]; tipo: string; periodos?: string[] }>,
  periodos: string[],
  dict?: DictionaryEntry[],
  bpModel: BPModel = DEFAULT_BP_MODEL,
  opts: { model?: string; dreModel?: DREModel } = {}
): Promise<AIExtractionResult> {
  // Texto do parser → Haiku (barato); PDF → Sonnet visão (caro). Default: visão.
  const model = opts.model ?? (docs.some((d) => d.raw) ? AI_MODEL_FAST : AI_MODEL);
  // Período POR-DOCUMENTO (fix multi-ano): o parser já conhece o(s) período(s) de cada doc
  // (doc.periodos). Quando o doc tem 1 só, fixamos (pin) — ignoramos o ano que a IA devolver,
  // que era a fonte da instabilidade (BP de um ano caía na chave de outro no batch de N docs).
  // Com 2+ períodos no mesmo doc, escopamos o canonicalPeriod aos períodos conhecidos do doc.
  type DocCtx = { pin: string | null; docPeriodos: string[] };
  // Capturas de BP resolvidas DETERMINISTICAMENTE (árvore por indentação) — não passam pelo
  // LLM. Cada uma vira uma "captura BP" já pronta, mesclada com as do LLM na mesma pipeline.
  const bpDeterministicos: Array<{ data: ArvoreOriginalBP; ctx: DocCtx }> = [];
  // Idem para a DRE: árvore de seções + declarados reconstruídos das LINHAS do parser
  // (indent), aceitos só com a prova de partição (Σ seções = LL declarado). Ver dre-tree-indent.
  const dreDeterministicos: Array<{ data: NonNullable<ReturnType<typeof construirArvoreDREporIndentacao>>; ctx: DocCtx }> = [];
  const taskThunks = docs.flatMap((doc) => {
    const t = doc.tipo.toLowerCase();
    const isDRE = /dre|resultado|demonstra/.test(t);
    const isBP = /balan|patrimonial|\bbp\b/.test(t);
    const input = { buffer: doc.buffer, text: doc.raw };
    const docPeriodos = doc.periodos?.length ? doc.periodos : periodos;
    const ctx: DocCtx = { pin: docPeriodos.length === 1 ? docPeriodos[0] : null, docPeriodos };
    const promptPeriodos = docPeriodos.length ? docPeriodos : periodos;
    const out: Array<() => Promise<{ kind: "dre" | "bp"; data: any; ctx: DocCtx; inTok: number; outTok: number }>> = [];
    if (isDRE || !isBP) {
      const arvoreDreDet = doc.linhas?.length ? construirArvoreDREporIndentacao(doc.linhas, promptPeriodos) : null;
      if (arvoreDreDet) dreDeterministicos.push({ data: arvoreDreDet, ctx });
      else out.push(() => ask(input, dreTreePrompt(promptPeriodos), model, 0, 16000).then((r) => ({ kind: "dre" as const, data: r.data, ctx, inTok: r.inTok, outTok: r.outTok })));
    }
    if (isBP || (!isDRE && !isBP)) {
      // ANTES do LLM: se o doc tem o texto INDENTADO do parser (`rawIndent` = doc.raw, com a
      // hierarquia preservada na coluna/x-position), reconstrói a árvore do BP de forma
      // DETERMINÍSTICA (captura as contas-folha que o Haiku colapsava — caso Fibracabos Grau 4)
      // e PULA a chamada de IA desse doc. IMPORTANTE: usa `rawIndent`, NÃO `raw` — o `raw` que
      // o híbrido passa é `linhasToText(linhas)` (contexto>conta, SEM indentação e já colapsado
      // no nível do parser), onde o builder sempre via 1 nível e caía no LLM. Se a reconstrução
      // não for confiável (null), mantém EXATAMENTE o fluxo LLM atual — sem regressão.
      const rawArvore = doc.rawIndent ?? doc.raw;
      let arvoreDet = rawArvore
        ? construirArvoreBPporIndentacao({ raw: rawArvore } as ParsedDocument, promptPeriodos)
        : null;
      // Cache herdado/editado: o rawIndent chega ACHATADO (dadosExtraidosToRaw) e o builder
      // devolve null. As linhas do cache preservam o indent — sintetiza o texto e tenta de
      // novo. As travas do builder continuam valendo (prova de fechamento); falhou → LLM.
      if (!arvoreDet && doc.linhas?.length) {
        const sintetico = linhasParaTextoIndentado(doc.linhas, promptPeriodos);
        if (sintetico) arvoreDet = construirArvoreBPporIndentacao({ raw: sintetico } as ParsedDocument, promptPeriodos);
      }
      if (arvoreDet) {
        bpDeterministicos.push({ data: arvoreDet, ctx });
      } else {
        // Árvore completa pode ser funda (1-7 níveis) → teto de saída maior que o padrão.
        out.push(() => ask(input, bpTreePrompt(promptPeriodos), model, 0, 16000).then((r) => ({ kind: "bp" as const, data: r.data, ctx, inTok: r.inTok, outTok: r.outTok })));
      }
    }
    return out;
  });
  // Paralelo com CONCORRÊNCIA LIMITADA (4): muito mais rápido em uploads multi-documento que
  // o antigo sequencial, sem estourar o rate limit (cada `ask` já tem retry+backoff em
  // 429/529). Preserva a ordem via índice. Antes (sequencial) 6 docs ~60-90s; agora ~1/4.
  const CONCORRENCIA = 4;
  const results: Array<{ kind: "dre" | "bp"; data: any; ctx: DocCtx; inTok: number; outTok: number }> = new Array(taskThunks.length);
  let proximo = 0;
  const worker = async () => {
    while (proximo < taskThunks.length) {
      const i = proximo++;
      results[i] = await taskThunks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCORRENCIA, taskThunks.length) }, worker));
  const custo = calcCusto(model, results.reduce((s, r) => s + r.inTok, 0), results.reduce((s, r) => s + r.outTok, 0));

  const declarados: Record<string, Record<string, number>> = {};
  const arvoreOriginalBP: ArvoreOriginalBP = {};
  const arvoreOriginalDRE: ArvoreOriginalDRE = {};
  const periodSet = new Set<string>(periodos);

  // Resolve a chave de período de uma captura: pin (1 período conhecido no doc) tem prioridade
  // absoluta sobre o que a IA devolveu; senão canonicaliza escopado aos períodos do doc.
  const resolvePeriod = (pRaw: string, ctx: DocCtx) =>
    ctx.pin ?? canonicalPeriod(pRaw, ctx.docPeriodos.length ? ctx.docPeriodos : periodos);

  const setDecl = (p: string, conta: string, valor: unknown) => { if (typeof valor === "number" && valor !== 0) (declarados[p] ??= {})[conta] = valor; };
  const storeDeclarados = (raw: any, ctx: DocCtx) => {
    if (!raw || typeof raw !== "object") return;
    const aninhado = Object.values(raw).some((v) => v && typeof v === "object");
    if (aninhado) for (const [pRaw, contas] of Object.entries(raw)) {
      if (!contas || typeof contas !== "object") continue;
      const p = resolvePeriod(pRaw, ctx); periodSet.add(p);
      for (const [c, v] of Object.entries(contas as any)) setDecl(p, c, v);
    } else { const p = ctx.pin ?? periodos[0] ?? Array.from(periodSet)[0] ?? "0"; for (const [c, v] of Object.entries(raw)) setDecl(p, c, v); }
  };
  // merge BP captures (árvore original), canonicalizando períodos
  const mergeBP = (raw: any, ctx: DocCtx) => {
    for (const [pRaw, cap] of Object.entries(raw ?? {})) {
      if (!cap || typeof cap !== "object") continue;
      const p = resolvePeriod(pRaw, ctx); periodSet.add(p);
      const c = cap as BPN3Periodo;
      const dest = (arvoreOriginalBP[p] ??= { grupos: {}, totais: {} });
      for (const [g, itens] of Object.entries(c.grupos ?? {})) (dest.grupos[g] ??= []).push(...(itens as BPN3Item[]));
      if (c.totais) dest.totais = { ...dest.totais, ...c.totais };
    }
  };

  // merge DRE captures (seções originais), canonicalizando períodos
  const mergeDRE = (raw: any, ctx: DocCtx) => {
    for (const [pRaw, secoes] of Object.entries(raw?.secoes ?? {})) {
      if (!Array.isArray(secoes)) continue;
      const p = resolvePeriod(pRaw, ctx); periodSet.add(p);
      (arvoreOriginalDRE[p] ??= []).push(...(secoes as DRESecaoItem[]));
    }
  };

  for (const r of results) {
    if (r.kind === "bp") mergeBP(r.data, r.ctx);
    else { mergeDRE(r.data, r.ctx); storeDeclarados(r.data?.declarados, r.ctx); }
  }
  // Capturas de BP determinísticas (árvore por indentação) entram na MESMA pipeline de merge
  // (canonicalização de período idêntica à do LLM) — apenas não custaram tokens.
  for (const b of bpDeterministicos) mergeBP(b.data, b.ctx);
  // DRE determinística: seções + declarados na MESMA pipeline (períodos já provados).
  for (const d of dreDeterministicos) { mergeDRE({ secoes: d.data.secoes }, d.ctx); storeDeclarados(d.data.declarados, d.ctx); }

  // UNIFICA períodos do MESMO ANO com formatos diferentes entre docs ("2022" no DRE vs
  // "31/12/2022" no BP dividia o período em dois — BP num, DRE noutro — e quebrava a
  // reconciliação e os indicadores). Canônico: a forma datada (31/12/AAAA) quando existir.
  {
    const porAno = new Map<string, string[]>();
    for (const k of periodSet) { const y = yearOf(k); if (y) (porAno.get(y) ?? porAno.set(y, []).get(y)!).push(k); }
    for (const [, keys] of porAno) {
      if (keys.length < 2) continue;
      const canonico = keys.find((k) => /\d{2}\/\d{2}\/\d{4}/.test(k)) ?? keys[0];
      for (const k of keys) {
        if (k === canonico) continue;
        // BP
        if (arvoreOriginalBP[k]) {
          const destBP = (arvoreOriginalBP[canonico] ??= { grupos: {}, totais: {} });
          for (const [g, itens] of Object.entries(arvoreOriginalBP[k].grupos ?? {})) (destBP.grupos[g] ??= []).push(...itens);
          destBP.totais = { ...destBP.totais, ...arvoreOriginalBP[k].totais };
          delete arvoreOriginalBP[k];
        }
        // DRE
        if (arvoreOriginalDRE[k]) { (arvoreOriginalDRE[canonico] ??= []).push(...arvoreOriginalDRE[k]); delete arvoreOriginalDRE[k]; }
        // Declarados
        if (declarados[k]) { declarados[canonico] = { ...declarados[canonico], ...declarados[k] }; delete declarados[k]; }
        periodSet.delete(k);
      }
    }
  }

  const allPeriodos = Array.from(periodSet);
  const { bp, naoMapeados: naoMapBP, alertasComposicao } = foldBP(arvoreOriginalBP, allPeriodos, dict, bpModel);
  const { dre, naoMapeados: naoMapDRE, alertasComposicao: alertasDRE } = foldDRE(arvoreOriginalDRE, allPeriodos, dict, opts.dreModel);

  return {
    bp, dre, periodos: allPeriodos, declarados,
    arvoreOriginalBP, arvoreOriginalDRE,
    naoMapeados: [...naoMapBP, ...naoMapDRE],
    alertasComposicao: [...alertasComposicao, ...alertasDRE],
    custo,
  };
}
