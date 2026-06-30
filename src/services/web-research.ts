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

Busque e sintetize:
1. Notícias recentes relevantes (M&A, dívida/reestruturação, troca de gestão, fatos relevantes, processos, expansão/fechamento).
2. Posicionamento de mercado e principais concorrentes.
3. Tendências e referências do setor (margens/crescimento típicos) — úteis quando não há pares diretos comparáveis.

Regras:
- Resumo objetivo em tópicos, ≤ 400 palavras. Cite a fonte e a data quando relevante.
- Se NÃO encontrar informação confiável sobre a empresa específica, diga isso explicitamente e foque no contexto setorial.
- NÃO invente fatos. Prefira fontes primárias (site da empresa, imprensa, órgãos reguladores).`;
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
