/**
 * Pesquisa WEB sobre a empresa (Input 3 da Análise Estratégica do IBR).
 *
 * UMA chamada de IA com a ferramenta server-side `web_search` do Anthropic:
 * Claude busca notícias/contexto/posicionamento e devolve uma síntese + fontes.
 * É best-effort — se falhar (sem crédito, rate limit, modelo sem suporte), retorna
 * null e a análise segue sem o contexto web.
 *
 * Custo (regra [[registrar-custo-ia]]): tokens via calcCusto + nº de buscas ×
 * US$10/1000 (preço da ferramenta web_search). Vinculado ao IBR em
 * resultado.custoWebResearch.
 *
 * Tool variant: `web_search_20250305` (básica) — compatível com Haiku/Sonnet/Opus.
 * (A `_20260209` exige Opus/Sonnet 4.6+ e quebraria se o modelo configurado for Haiku.)
 */

import { modeloAnaliseId, calcCusto, createWithRetry, type CustoIA } from "./ai-extraction";

/** Preço da ferramenta web_search da Anthropic: US$10 por 1.000 buscas. */
const WEB_SEARCH_USD_POR_BUSCA = 10 / 1000;
const MAX_BUSCAS = 5;

export interface WebResearchFonte { titulo: string; url: string }
export interface CustoWebResearch extends CustoIA {
  buscas: number;
  usdBuscas: number;
}
export interface WebResearchResult {
  resumo: string;
  fontes: WebResearchFonte[];
  custo: CustoWebResearch;
}

function prompt(empresa: { razaoSocial: string; setor?: string | null; site?: string | null }): string {
  const site = empresa.site ? ` Site: ${empresa.site}.` : "";
  const setor = empresa.setor ? ` Setor: ${empresa.setor}.` : "";
  return `Você é analista de um Independent Business Review (IBR). Pesquise na web informações ATUAIS e relevantes sobre a empresa abaixo para subsidiar a análise estratégica (diagnóstico financeiro/operacional e posicionamento).

Empresa: "${empresa.razaoSocial}".${setor}${site}

Organize o resultado EXATAMENTE nestas 6 seções NUMERADAS, nesta ordem:
1) Dados cadastrais e estrutura societária
2) Fatos relevantes e movimentos recentes
3) Posicionamento de mercado
4) Concorrentes
5) Contexto setorial — referências e tendências
6) Alertas para o IBR

FORMATAÇÃO (siga à risca):
- SEM preâmbulo. Comece DIRETO no título "1) Dados cadastrais e estrutura societária".
- Cada título de seção em NEGRITO com o número, no formato **1) Título da seção** (markdown). NÃO use # nem ## em hipótese alguma.
- Sob cada título, escreva os pontos como bullets começando com "- " SEGUIDO do texto NA MESMA LINHA (ex.: "- Razão social: ..."). NUNCA deixe uma linha contendo só "-" ou só um marcador sem texto.
- NÃO use "---" nem qualquer linha separadora entre seções.
- Frases curtas e objetivas. NO MÁXIMO uma linha em branco entre seções; nunca pule várias linhas seguidas.
- Texto total ≤ 380 palavras. Cite fonte/data quando relevante.

REGRAS DE CONTEÚDO:
- Se NÃO encontrar informação confiável sobre a empresa específica, diga isso na seção correspondente e foque no contexto setorial.
- NÃO invente fatos. Prefira fontes primárias (site da empresa, imprensa, órgãos reguladores).`;
}

/* ─────────── Pares via WEB para setores SEM par B3 (setor "Outros"/custom) ───────────
 * Quando o setor do cliente não existe na taxonomia B3, não há pares na base CVM
 * (coverage "ausente"). Aqui buscamos na web as FAIXAS TÍPICAS do setor para os
 * indicadores comparáveis — referência DIRECIONAL, nunca percentil/semáforo duro
 * ("verde só com prova"). Best-effort; custo registrado. */

export interface RefExternaWeb {
  indicador: string;
  referencia: number;      // valor típico (mediana aproximada) do setor
  fonte: string;           // sempre marca confiança baixa + web
  higherIsBetter: boolean;
}
export interface WebParesResult {
  refs: RefExternaWeb[];
  fontes: WebResearchFonte[];
  custo: CustoWebResearch;
}

// Só indicadores que fontes setoriais realmente publicam (Kanitz/Altman/Fleuriet
// não têm mediana setorial confiável na web → ficam de fora).
const WEB_PARES_INDICADORES = new Set<string>([
  "Margem Bruta", "Margem EBITDA", "Margem Líquida",
  "Liquidez Corrente", "Liquidez Seca",
  "ROE (Retorno sobre Patrimônio Líquido)", "ROA (Retorno sobre Ativos)", "Giro do Ativo",
  "Dívida Líquida/EBITDA", "Endividamento Geral",
  "Prazo Médio Contas a Receber", "Prazo Médio Estoque", "Prazo Médio Fornecedores", "Ciclo Financeiro",
]);

/** Extrai as refs do bloco JSON da resposta web (função pura, testável sem rede).
 *  Só aceita indicadores conhecidos (na polaridade) e valores numéricos sãos. */
export function parseWebParesJson(texto: string, polaridade: Map<string, boolean>): RefExternaWeb[] {
  const m = texto.match(/\[[\s\S]*\]/); // primeiro array JSON
  if (!m) return [];
  let parsed: Array<{ indicador?: string; valor?: unknown }>;
  try { parsed = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const refs: RefExternaWeb[] = [];
  const vistos = new Set<string>();
  for (const item of parsed) {
    const nome = String(item?.indicador ?? "").trim();
    const valor = typeof item?.valor === "number" ? item.valor : Number(item?.valor);
    if (!polaridade.has(nome) || vistos.has(nome) || !Number.isFinite(valor)) continue;
    if (Math.abs(valor) > 100000) continue; // sanidade grosseira contra absurdos
    vistos.add(nome);
    refs.push({
      indicador: nome,
      referencia: valor,
      fonte: "estimativa web (faixa típica do setor) · confiança baixa",
      higherIsBetter: polaridade.get(nome)!,
    });
  }
  return refs;
}

function promptPares(setor: string, indicadores: string[]): string {
  return `Você é analista financeiro de um IBR. O setor abaixo NÃO tem pares listados na B3, então preciso de uma REFERÊNCIA SETORIAL aproximada (mediana típica do setor no Brasil) para posicionar a empresa. Pesquise na web fontes setoriais confiáveis.

Setor/atividade: "${setor}".

Para CADA indicador abaixo, estime o VALOR TÍPICO (mediana) do setor no Brasil. Responda APENAS com um bloco JSON, sem texto antes ou depois:

\`\`\`json
[{"indicador": "<nome exato>", "valor": <número no formato pedido>}]
\`\`\`

Formato do valor (SIGA À RISCA):
- Margens, ROE, ROA, Endividamento Geral: DECIMAL (ex.: 25% → 0.25).
- Liquidez, Giro, Dívida Líquida/EBITDA: número puro (ex.: 1.5).
- Prazos médios e Ciclo Financeiro: dias inteiros (ex.: 45).

Indicadores: ${indicadores.join(" · ")}

REGRAS: só inclua indicadores para os quais encontrar base setorial razoável (omita o resto — não invente). Prefira fontes recentes. Nada de percentis, só o valor típico.`;
}

/** Pares via web para setor custom. Null se desligado/indisponível/erro (best-effort). */
export async function researchSectorBenchmarksWeb(
  setor: string,
  indicadores: Array<{ nome: string; higherIsBetter: boolean }>,
  modelKey?: string | null,
): Promise<WebParesResult | null> {
  if (process.env.RESEARCH_WEB_ATIVO === "false") return null;
  const alvo = indicadores.filter((i) => WEB_PARES_INDICADORES.has(i.nome));
  if (!setor.trim() || alvo.length === 0) return null;
  const polaridade = new Map(alvo.map((i) => [i.nome, i.higherIsBetter]));
  const model = modeloAnaliseId(modelKey);

  let msg: any;
  try {
    msg = await createWithRetry({
      model,
      max_tokens: 1500,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_BUSCAS }],
      messages: [{ role: "user", content: promptPares(setor, alvo.map((i) => i.nome)) }],
    });
  } catch (e: any) {
    console.warn(`[web-pares] falhou (${setor}): ${e?.message ?? e}`);
    return null;
  }

  const textos: string[] = [];
  const fontesMap = new Map<string, string>();
  for (const block of (msg.content ?? []) as any[]) {
    if (block.type === "text" && typeof block.text === "string") textos.push(block.text);
    else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) if (r?.type === "web_search_result" && r.url) fontesMap.set(r.url, r.title ?? r.url);
    }
  }
  const refs = parseWebParesJson(textos.join("\n"), polaridade);
  if (refs.length === 0) return null;

  const inTok = msg.usage?.input_tokens ?? 0;
  const outTok = msg.usage?.output_tokens ?? 0;
  const buscas = msg.usage?.server_tool_use?.web_search_requests ?? 0;
  const base = calcCusto(model, inTok, outTok);
  const usdBuscas = buscas * WEB_SEARCH_USD_POR_BUSCA;
  return {
    refs,
    fontes: [...fontesMap.entries()].map(([url, titulo]) => ({ titulo, url })),
    custo: { ...base, usd: base.usd + usdBuscas, buscas, usdBuscas },
  };
}

/** Pesquisa web sobre a empresa. Null se desligado/indisponível/erro (best-effort). */
export async function researchCompanyWeb(
  empresa: { razaoSocial: string; setor?: string | null; site?: string | null },
  modelKey?: string | null,
): Promise<WebResearchResult | null> {
  if (process.env.RESEARCH_WEB_ATIVO === "false") return null;
  const model = modeloAnaliseId(modelKey);

  let msg: any;
  try {
    msg = await createWithRetry({
      model,
      max_tokens: 3000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_BUSCAS }],
      messages: [{ role: "user", content: prompt(empresa) }],
    });
  } catch (e: any) {
    console.warn(`[web-research] falhou (${empresa.razaoSocial}): ${e?.message ?? e}`);
    return null;
  }

  // Concatena os blocos de texto (síntese) e coleta as fontes dos web_search_tool_result.
  const textos: string[] = [];
  const fontesMap = new Map<string, string>(); // url -> titulo
  for (const block of (msg.content ?? []) as any[]) {
    if (block.type === "text" && typeof block.text === "string") {
      textos.push(block.text);
    } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r?.type === "web_search_result" && r.url) fontesMap.set(r.url, r.title ?? r.url);
      }
    }
  }
  const resumo = textos.join("\n").trim();
  if (!resumo) return null;

  const inTok = msg.usage?.input_tokens ?? 0;
  const outTok = msg.usage?.output_tokens ?? 0;
  const buscas = msg.usage?.server_tool_use?.web_search_requests ?? 0;
  const base = calcCusto(model, inTok, outTok);
  const usdBuscas = buscas * WEB_SEARCH_USD_POR_BUSCA;

  return {
    resumo,
    fontes: [...fontesMap.entries()].map(([url, titulo]) => ({ titulo, url })),
    custo: { ...base, usd: base.usd + usdBuscas, buscas, usdBuscas },
  };
}
