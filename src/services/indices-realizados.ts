/**
 * ÍNDICES MACRO REALIZADOS por ano-calendário (pedido do usuário, 24/07/2026:
 * "se tiver do macroeconômico também pode trazer, seguindo o mesmo período do
 * histórico da empresa").
 *
 * O snapshot que o modelo já guarda (indices-economicos.ts) traz PROJEÇÕES do
 * Boletim Focus — expectativa de mercado para os anos à frente. Não serve para
 * as colunas históricas: ali o que interessa é o que de fato aconteceu.
 *
 * Fonte: BCB / SGS, as mesmas séries públicas sem chave que o resto do sistema
 * usa. Buscamos a série MENSAL e acumulamos por ano civil, em vez de pedir uma
 * série de "acumulado no ano" pronta: assim o número é reproduzível a partir de
 * dados brutos e não depende de o BCB manter uma série derivada específica.
 *
 * Composição, não soma: IPCA de 0,5% em doze meses dá 6,17% no ano, não 6,0%.
 */

const BASE = "https://api.bcb.gov.br/dados/serie";

/** Séries SGS usadas nas colunas históricas do quadro macro. */
const SERIES = {
  /** IPCA — variação mensal (%). */
  ipca: 433,
  /** IGP-M — variação mensal (%). */
  igpm: 189,
  /** Selic acumulada no mês (%) — proxy do CDI, mesma régua da projeção. */
  selic: 4390,
  /** Dólar PTAX venda (diário, R$/US$). */
  cambio: 1,
} as const;

export interface IndicesRealizados {
  fonte: string;
  /** % NO ANO, em números-porcentagem (4.62 = 4,62%) — a mesma unidade da projeção. */
  indices: {
    ipca: Record<string, number>;
    igpm: Record<string, number>;
    selic: Record<string, number>;
    /** R$/US$ no ÚLTIMO pregão do ano (nível, não variação). */
    cambioNivel: Record<string, number>;
    /** Variação do dólar no ano (%), quando há o ano anterior para comparar. */
    cambioVar: Record<string, number>;
  };
  memoria: string[];
}

interface PontoSgs { data: string; valor: string | number }

const anoDe = (ddmmyyyy: string): string => ddmmyyyy.slice(-4);
const numero = (v: string | number): number => {
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
};

async function buscaSerie(codigo: number, de: string, ate: string): Promise<PontoSgs[]> {
  const url = `${BASE}/bcdata.sgs.${codigo}/dados?formato=json&dataInicial=${de}&dataFinal=${ate}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`SGS ${codigo}: HTTP ${r.status}`);
    const j = await r.json();
    return Array.isArray(j) ? (j as PontoSgs[]) : [];
  } finally {
    clearTimeout(t);
  }
}

/** Compõe as variações mensais de cada ano: Π(1+i) − 1, em % ao ano. */
function acumulaPorAno(pontos: PontoSgs[], anos: Set<string>): Record<string, number> {
  const fator: Record<string, number> = {};
  const meses: Record<string, number> = {};
  for (const p of pontos) {
    const a = anoDe(p.data);
    if (!anos.has(a)) continue;
    const v = numero(p.valor);
    if (!Number.isFinite(v)) continue;
    fator[a] = (fator[a] ?? 1) * (1 + v / 100);
    meses[a] = (meses[a] ?? 0) + 1;
  }
  const out: Record<string, number> = {};
  for (const a of Object.keys(fator)) {
    // Ano incompleto não vira número de ano fechado: melhor omitir do que
    // publicar "IPCA de 2025: 2,1%" quando só cinco meses entraram na conta.
    if ((meses[a] ?? 0) < 12) continue;
    out[a] = (fator[a] - 1) * 100;
  }
  return out;
}

/** Último valor de cada ano (medida de NÍVEL — câmbio). */
function ultimoDoAno(pontos: PontoSgs[], anos: Set<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of pontos) {
    const a = anoDe(p.data);
    if (!anos.has(a)) continue;
    const v = numero(p.valor);
    if (Number.isFinite(v)) out[a] = v; // a série vem cronológica: o último vence
  }
  return out;
}

const cache = new Map<string, { em: number; dados: IndicesRealizados }>();
const CACHE_MS = 12 * 3600 * 1000;

/**
 * Índices realizados nos anos pedidos. Anos sem 12 meses de dado são omitidos
 * (ver acumulaPorAno) — a tabela mostra "—" em vez de um número parcial que
 * seria lido como fechado.
 */
export async function indicesRealizadosPorAno(anos: string[]): Promise<IndicesRealizados | null> {
  const alvo = [...new Set(anos.filter((a) => /^\d{4}$/.test(a)))].sort();
  if (!alvo.length) return null;

  const chave = alvo.join(",");
  const cacheado = cache.get(chave);
  if (cacheado && Date.now() - cacheado.em < CACHE_MS) return cacheado.dados;

  const anoSet = new Set(alvo);
  // Um ano antes do primeiro: base da variação cambial do ano mais antigo.
  const de = `01/01/${Number(alvo[0]) - 1}`;
  const ate = `31/12/${alvo[alvo.length - 1]}`;
  const memoria: string[] = [];

  const buscar = async (nome: string, cod: number): Promise<PontoSgs[]> => {
    try {
      return await buscaSerie(cod, de, ate);
    } catch (e) {
      // Uma série fora do ar não pode derrubar as outras nem a tela inteira.
      memoria.push(`${nome}: série SGS ${cod} indisponível (${e instanceof Error ? e.message : "erro"}).`);
      return [];
    }
  };

  const [pIpca, pIgpm, pSelic, pCambio] = await Promise.all([
    buscar("IPCA", SERIES.ipca), buscar("IGP-M", SERIES.igpm),
    buscar("Selic", SERIES.selic), buscar("Câmbio", SERIES.cambio),
  ]);

  // O câmbio precisa do ano anterior para a variação; os índices, não.
  const anoSetComBase = new Set([...anoSet, String(Number(alvo[0]) - 1)]);
  const cambioNivelTodos = ultimoDoAno(pCambio, anoSetComBase);
  const cambioNivel: Record<string, number> = {};
  const cambioVar: Record<string, number> = {};
  for (const a of alvo) {
    if (typeof cambioNivelTodos[a] === "number") cambioNivel[a] = cambioNivelTodos[a];
    const ant = cambioNivelTodos[String(Number(a) - 1)];
    if (typeof cambioNivelTodos[a] === "number" && typeof ant === "number" && ant !== 0) {
      cambioVar[a] = (cambioNivelTodos[a] / ant - 1) * 100;
    }
  }

  const dados: IndicesRealizados = {
    fonte: "Banco Central do Brasil — SGS (séries 433 IPCA, 189 IGP-M, 4390 Selic, 1 PTAX venda)",
    indices: {
      ipca: acumulaPorAno(pIpca, anoSet),
      igpm: acumulaPorAno(pIgpm, anoSet),
      selic: acumulaPorAno(pSelic, anoSet),
      cambioNivel,
      cambioVar,
    },
    memoria: [
      "Realizado: variações mensais compostas no ano civil — Π(1+i) − 1, não a soma.",
      "Ano sem os 12 meses publicados fica em branco em vez de sair como ano fechado.",
      ...memoria,
    ],
  };
  cache.set(chave, { em: Date.now(), dados });
  return dados;
}

/** Só para teste: zera o cache de 12h entre casos. */
export function _limparCacheRealizados(): void {
  cache.clear();
}

export const _internos = { acumulaPorAno, ultimoDoAno };
