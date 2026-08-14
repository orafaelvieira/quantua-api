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
import { ETAPAS } from "./ai-usage";

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

/**
 * IDENTIDADE DA EMPRESA — o que o CADASTRO já sabe (Receita Federal via consulta
 * de CNPJ). Entra no prompt como FATO, não como pergunta.
 *
 * Sem isto (até 14/08/2026) a pesquisa recebia só a razão social e o setor, e o
 * prompt ainda MANDAVA pesquisar "dados cadastrais" na web — dado que já está no
 * banco. O resultado chegou ao cliente: "há incerteza sobre a identidade
 * jurídica exata, pois existem várias empresas com grafias parecidas... confirme
 * o CNPJ e a razão social antes de fechar conclusões". Numa entrega assinada,
 * isso não é ressalva: é o relatório dizendo que não sabe de quem está falando.
 *
 * NÃO inclui o quadro societário (nomes de sócios): dado pessoal de terceiro não
 * viaja para prompt de IA nem para documento do cliente.
 */
export interface IdentidadeEmpresa {
  razaoSocial: string;
  nomeFantasia?: string | null;
  cnpj?: string | null;
  setor?: string | null;
  porte?: string | null;
  municipio?: string | null;
  uf?: string | null;
  cnae?: string | null;
  cnaeDescricao?: string | null;
  naturezaJuridica?: string | null;
  dataInicioAtividade?: string | null;
  situacaoCadastral?: string | null;
  capitalSocial?: number | null;
  regimeTributario?: string | null;
}

/** Bloco de identidade em texto — as linhas que o cadastro tem, nada inventado. */
export function blocoIdentidade(e: IdentidadeEmpresa): string {
  const linhas: string[] = [`- Razão social: ${e.razaoSocial}`];
  const add = (rot: string, v: unknown): void => {
    if (v === null || v === undefined || v === "") return;
    linhas.push(`- ${rot}: ${v}`);
  };
  add("Nome fantasia", e.nomeFantasia);
  add("CNPJ", e.cnpj);
  add("Atividade principal (CNAE)", e.cnae && e.cnaeDescricao ? `${e.cnae} — ${e.cnaeDescricao}` : e.cnaeDescricao ?? e.cnae);
  add("Setor (classificação do IBR)", e.setor);
  add("Município/UF", e.municipio && e.uf ? `${e.municipio}/${e.uf}` : e.municipio ?? e.uf);
  add("Natureza jurídica", e.naturezaJuridica);
  add("Início das atividades", e.dataInicioAtividade);
  add("Situação cadastral", e.situacaoCadastral);
  add("Capital social", typeof e.capitalSocial === "number" ? `R$ ${e.capitalSocial.toLocaleString("pt-BR")}` : null);
  add("Regime tributário", e.regimeTributario);
  add("Porte", e.porte);
  return linhas.join("\n");
}

function prompt(empresa: IdentidadeEmpresa): string {
  const temCnpj = !!(empresa.cnpj && empresa.cnpj.replace(/\D/g, "").length === 14);
  return `Você é analista de um Independent Business Review (IBR). Pesquise na web informações ATUAIS e relevantes sobre a empresa abaixo para subsidiar a análise estratégica (diagnóstico financeiro/operacional e posicionamento).

IDENTIDADE CONFIRMADA — dados do cadastro do cliente, conferidos na Receita Federal. São FATO:
${blocoIdentidade(empresa)}

REGRA INEGOCIÁVEL SOBRE A IDENTIDADE:
- A empresa É esta. NÃO questione, NÃO peça para confirmar CNPJ ou razão social, NÃO escreva ressalvas do tipo "há incerteza sobre a identidade" ou "existem empresas com nomes parecidos". Esse relatório é assinado e entregue ao cliente que É essa empresa: duvidar de quem ele é seria constrangedor e falso.
- USE os dados acima para direcionar a busca${temCnpj ? " (o CNPJ é o desempatador quando houver homônimos)" : ""}: procure pela razão social E pelo nome fantasia, no município/UF do cadastro e no ramo do CNAE.
- Encontrou resultados de OUTRA empresa de nome parecido (outro CNPJ, outro estado, outro ramo)? DESCARTE em silêncio e siga com o que sobrar. Não relate a confusão.

Organize o resultado EXATAMENTE nestas 6 seções NUMERADAS, nesta ordem:
1) A empresa na web — presença, marcas, unidades e o que ela diz de si
2) Fatos relevantes e movimentos recentes
3) Posicionamento de mercado
4) Concorrentes
5) Contexto setorial — referências e tendências
6) Alertas para o IBR

FORMATAÇÃO (siga à risca):
- SEM preâmbulo. Comece DIRETO no título "1) A empresa na web — presença, marcas, unidades e o que ela diz de si".
- Cada título de seção em NEGRITO com o número, no formato **1) Título da seção** (markdown). NÃO use # nem ## em hipótese alguma.
- Sob cada título, escreva os pontos como bullets começando com "- " SEGUIDO do texto NA MESMA LINHA. NUNCA deixe uma linha contendo só "-" ou só um marcador sem texto.
- NÃO use "---" nem qualquer linha separadora entre seções.
- Frases curtas e objetivas. NO MÁXIMO uma linha em branco entre seções; nunca pule várias linhas seguidas.
- Texto total ≤ 380 palavras. Cite fonte/data quando relevante.

REGRAS DE CONTEÚDO:
- NÃO repita o bloco de identidade acima (o relatório já traz esses dados) — a seção 1 é sobre o que a WEB acrescenta: site, redes, marcas, unidades, catálogo, imprensa.
- Achou pouco sobre a empresa? Escreva "Pouca presença digital encontrada" na seção e vá para o contexto SETORIAL — a escassez é sobre a web, NUNCA sobre a identidade da empresa.
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
    }, 0, { etapa: ETAPAS.PESQUISA_WEB_PARES });
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
  empresa: IdentidadeEmpresa,
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
    }, 0, { etapa: ETAPAS.PESQUISA_WEB_EMPRESA });
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
