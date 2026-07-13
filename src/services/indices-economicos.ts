/**
 * Índices econômicos OFICIAIS com um clique — fontes públicas do Banco Central
 * (sem chave, sem custo):
 *  - PROJEÇÕES por ano (IPCA, Selic, Câmbio): API "Expectativas de Mercado"
 *    (Boletim Focus) — mediana das expectativas anuais da pesquisa mais recente.
 *  - CÂMBIO ATUAL (base da variação do 1º ano): SGS série 1 (dólar PTAX venda).
 * O Focus é semanal → cache em memória de 12h. Anos além do horizonte da
 * pesquisa repetem o último disponível (regra "ano vazio continua o último"),
 * com a memória dizendo exatamente o que veio da fonte e o que foi repetido.
 */

export interface IndicesEconomicos {
  fonte: string;
  /** Data da pesquisa Focus usada (a mais recente). */
  dataPesquisa: string | null;
  /** R$/US$ atual (PTAX venda) — base da variação cambial do 1º ano. */
  cambioAtual: number | null;
  /** % AO ANO por ano-calendário, em NÚMEROS-PORCENTAGEM (4.5 = 4,5%) —
   *  exceto cambioNivel, que é o R$/US$ projetado para o fim de cada ano. */
  indices: {
    ipca: Record<string, number>;
    /** IGP-M projetado (comum em contratos de aluguel/reajuste). */
    igpm: Record<string, number>;
    /** Selic projetada (fim de ano) — proxy usual do CDI. */
    selic: Record<string, number>;
    /** R$/US$ no fim de cada ano (nível projetado). */
    cambioNivel: Record<string, number>;
    /** Variação esperada do dólar no ano (pode ser negativa). */
    cambioVar: Record<string, number>;
    /** Crescimento real do PIB projetado. */
    pib: Record<string, number>;
  };
  memoria: string[];
}

let cache: { chave: string; em: number; dados: IndicesEconomicos } | null = null;
const CACHE_MS = 12 * 3600 * 1000;

async function fetchJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/** Mediana anual do Focus para um indicador, da pesquisa mais recente. */
async function expectativaAnual(indicador: string): Promise<{ dataPesquisa: string; porAno: Record<string, number> }> {
  const filtro = encodeURIComponent(`Indicador eq '${indicador}' and baseCalculo eq 0`);
  const url = `https://olinda.bcb.gov.br/olinda/servico/Expectativas/versao/v1/odata/ExpectativasMercadoAnuais?%24filter=${filtro}&%24orderby=Data%20desc&%24top=80&%24format=json`;
  const j = (await fetchJson(url)) as { value?: Array<{ Data: string; DataReferencia: string | number; Mediana: number }> };
  const rows = j.value ?? [];
  if (!rows.length) throw new Error(`Focus sem dados para ${indicador}`);
  const dataPesquisa = rows[0].Data;
  const porAno: Record<string, number> = {};
  for (const r of rows) {
    if (r.Data === dataPesquisa && typeof r.Mediana === "number") porAno[String(r.DataReferencia)] = r.Mediana;
  }
  return { dataPesquisa, porAno };
}

/** Preenche os anos pedidos; ano sem projeção repete o último conhecido. */
function completar(porAno: Record<string, number>, anos: string[], rotulo: string, memoria: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const anosFonte = Object.keys(porAno).sort();
  let vigente = anosFonte.length ? porAno[anosFonte[0]] : undefined;
  const repetidos: string[] = [];
  for (const ano of anos) {
    if (typeof porAno[ano] === "number") {
      vigente = porAno[ano];
      out[ano] = vigente;
    } else if (vigente !== undefined) {
      out[ano] = vigente;
      repetidos.push(ano);
    }
  }
  if (repetidos.length) memoria.push(`${rotulo}: Focus cobre até ${anosFonte[anosFonte.length - 1]}; ${repetidos.join(", ")} repete o último valor`);
  return out;
}

export async function buscarIndicesEconomicos(anos: string[], forcar = false): Promise<IndicesEconomicos> {
  const ordenados = [...anos].sort();
  const chave = ordenados.join(",");
  if (!forcar && cache && cache.chave === chave && Date.now() - cache.em < CACHE_MS) return cache.dados;

  const memoria: string[] = [];
  const vazio = { dataPesquisa: "", porAno: {} as Record<string, number> };
  const [ipca, selic, cambio, ptax, pib, igpm] = await Promise.all([
    expectativaAnual("IPCA"),
    expectativaAnual("Selic"),
    expectativaAnual("Câmbio"),
    fetchJson("https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados/ultimos/1?formato=json").catch(() => null),
    // PIB/IGP-M são complementares: se o Focus não devolver, o resto segue.
    expectativaAnual("PIB Total").catch(() => vazio),
    expectativaAnual("IGP-M").catch(() => vazio),
  ]);

  const ptaxRow = Array.isArray(ptax) ? (ptax[0] as { data?: string; valor?: string } | undefined) : undefined;
  const cambioAtual = ptaxRow?.valor ? Number(String(ptaxRow.valor).replace(",", ".")) : null;
  if (cambioAtual) memoria.push(`Câmbio atual (PTAX venda ${ptaxRow?.data}): R$ ${cambioAtual.toFixed(4)}`);

  // Variação cambial ano a ano a partir dos NÍVEIS projetados (R$/US$ fim de ano);
  // a base do 1º ano é o câmbio de hoje (PTAX). Sem PTAX, o 1º ano fica 0%.
  const nivelCambio = completar(cambio.porAno, ordenados, "Câmbio (nível)", memoria);
  const cambioVar: Record<string, number> = {};
  let base = cambioAtual ?? undefined;
  let ultimaVar = 0;
  for (const ano of ordenados) {
    const alvo = nivelCambio[ano];
    if (typeof alvo !== "number") continue;
    if (typeof base === "number" && base > 0 && Math.abs(alvo - base) > 1e-9) {
      ultimaVar = (alvo / base - 1) * 100;
      cambioVar[ano] = ultimaVar;
    } else if (typeof base === "number" && base > 0) {
      // nível repetido (além do Focus): repete a última variação conhecida
      cambioVar[ano] = ultimaVar;
    } else {
      cambioVar[ano] = 0;
      memoria.push(`Câmbio ${ano}: sem PTAX para basear a variação do 1º ano — ficou 0%`);
    }
    base = alvo;
  }

  const dados: IndicesEconomicos = {
    fonte: "Banco Central do Brasil — Expectativas de Mercado (Boletim Focus) + PTAX",
    dataPesquisa: ipca.dataPesquisa ?? selic.dataPesquisa ?? null,
    cambioAtual,
    indices: {
      ipca: completar(ipca.porAno, ordenados, "IPCA", memoria),
      igpm: completar(igpm.porAno, ordenados, "IGP-M", memoria),
      selic: completar(selic.porAno, ordenados, "Selic", memoria),
      cambioNivel: nivelCambio,
      cambioVar,
      pib: completar(pib.porAno, ordenados, "PIB", memoria),
    },
    memoria,
  };
  cache = { chave, em: Date.now(), dados };
  return dados;
}
