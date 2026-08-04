/**
 * PREÇO DA IA — tabela versionada, com prova.
 *
 * Nenhum provedor devolve dólar na resposta: os TOKENS (ou as PÁGINAS) são
 * medidos pela API, o preço é nosso. Por isso duas regras:
 *
 * 1. Toda precificação devolve o preço APLICADO junto com o valor, para o
 *    chamador carimbar no evento. Sem isso, mexer nesta tabela reescreve todo o
 *    histórico em silêncio e nenhum custo passado fica auditável.
 * 2. Modelo fora da tabela NÃO vira custo zero. Devolve `preco: null` e
 *    `desconhecido: true`, e o relatório mostra "custo não apurado" — nunca R$ 0.
 *    O fallback `?? { in: 0, out: 0 }` que existia antes escondia exatamente o
 *    caso que mais importa: um modelo novo entrando em produção sem preço.
 */

/** Suba esta versão SEMPRE que mudar qualquer número abaixo. */
export const PRECO_VERSAO = "2026-08-03";

export interface PrecoToken {
  /** USD por milhão de tokens de entrada. */
  inMtok: number;
  /** USD por milhão de tokens de saída. */
  outMtok: number;
  /** Escrita de cache — mais cara que o token normal (TTL 5 min ≈ 1,25×). */
  cacheCriacaoMtok: number;
  /** Leitura de cache — muito mais barata (≈ 0,10×). */
  cacheLeituraMtok: number;
}

/** Tabela Anthropic. Haiku 4.5 $1/$5 · Sonnet 4.6 $3/$15 · Opus 4.8 $5/$25 por Mtok. */
const TOKENS: Record<string, PrecoToken> = {
  "claude-haiku-4-5-20251001": { inMtok: 1, outMtok: 5, cacheCriacaoMtok: 1.25, cacheLeituraMtok: 0.1 },
  "claude-sonnet-4-6": { inMtok: 3, outMtok: 15, cacheCriacaoMtok: 3.75, cacheLeituraMtok: 0.3 },
  "claude-opus-4-8": { inMtok: 5, outMtok: 25, cacheCriacaoMtok: 6.25, cacheLeituraMtok: 0.5 },
};

/** Busca web server-side: cobrada por BUSCA, fora da conta de token. */
export const BUSCA_WEB_USD = 10 / 1000;

/**
 * Provedores que cobram por UNIDADE (não por token). Preço de LISTA por unidade.
 *
 * Franquia: o Cloud Vision dá as primeiras 1.000 páginas do mês de graça. O
 * evento grava o preço de LISTA, e a franquia é aplicada na AGREGAÇÃO — só o
 * relatório sabe o total do mês. Gravar zero no evento esconderia o consumo.
 */
export const POR_UNIDADE: Record<string, { usdUnidade: number; unidade: string; franquiaMes?: number }> = {
  // Cloud Vision — Text/Document Text Detection. Conferido no console do projeto
  // quantua em 03/08/2026: grátis até 1.000/mês, depois R$ 8,725154872/mil.
  "google-vision:DOCUMENT_TEXT_DETECTION": { usdUnidade: 1.5 / 1000, unidade: "paginas", franquiaMes: 1000 },
  "google-vision:TEXT_DETECTION": { usdUnidade: 1.5 / 1000, unidade: "paginas", franquiaMes: 1000 },
};

export interface UsoTokens {
  inputTokens?: number;
  outputTokens?: number;
  cacheCriacaoTokens?: number;
  cacheLeituraTokens?: number;
  buscasWeb?: number;
}

export interface Precificacao {
  usdTotal: number;
  preco: PrecoToken | null;
  desconhecido: boolean;
}

/** Precifica consumo por TOKEN. Modelo sem preço → desconhecido, nunca zero. */
export function precificarTokens(modelo: string, u: UsoTokens): Precificacao {
  const p = TOKENS[modelo];
  const buscas = (u.buscasWeb ?? 0) * BUSCA_WEB_USD;
  if (!p) return { usdTotal: buscas, preco: null, desconhecido: true };
  const usd =
    ((u.inputTokens ?? 0) * p.inMtok +
      (u.outputTokens ?? 0) * p.outMtok +
      (u.cacheCriacaoTokens ?? 0) * p.cacheCriacaoMtok +
      (u.cacheLeituraTokens ?? 0) * p.cacheLeituraMtok) /
    1e6;
  return { usdTotal: usd + buscas, preco: p, desconhecido: false };
}

/** Precifica consumo por UNIDADE (páginas do Vision, requisições, etc.). */
export function precificarUnidades(chave: string, quantidade: number): { usdTotal: number; usdUnidade: number | null; desconhecido: boolean } {
  const p = POR_UNIDADE[chave];
  if (!p) return { usdTotal: 0, usdUnidade: null, desconhecido: true };
  return { usdTotal: quantidade * p.usdUnidade, usdUnidade: p.usdUnidade, desconhecido: false };
}

/** Só para exibição/depuração — a fonte da verdade é o preço carimbado no evento. */
export function precoDe(modelo: string): PrecoToken | null {
  return TOKENS[modelo] ?? null;
}
