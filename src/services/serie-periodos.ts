/**
 * SÉRIE DE PERÍODOS — a regra da sequência contínua.
 *
 * Pedido do dono (11/08/2026): "quanto mais histórico melhor, não faz sentido
 * escolher ex. 2022, 2025 e junho/2026, precisa ter sequência".
 *
 * POR QUE IMPORTA, e não é preciosismo: um IBR com buraco no meio produz
 * variação mentirosa. Receita "cresceu 180%" entre 2022 e 2025 é uma frase
 * sem sentido apresentada como análise — e a mesma série alimenta indicadores,
 * prazos médios, fluxo de caixa indireto (que compara balanços CONSECUTIVOS) e
 * as projeções. O buraco não fica no lugar onde nasceu: ele viaja.
 *
 * A CONTINUIDADE SE MEDE POR INTERVALO, NÃO POR RÓTULO. Balancete mensal é
 * ACUMULADO no ano (01/01 a 31/05), então "2024, 2025, jun/2026" é uma série
 * PERFEITA — junho/2026 cobre de 1º de janeiro. Já "2022, 2025, jun/2026" tem
 * dois anos de buraco. Quem sabe a diferença é o intervalo lido do documento,
 * não o nome da coluna.
 *
 * O que esta função NÃO faz: julgar sobreposição. Duas fontes cobrindo o mesmo
 * período não quebram a série (a base já escolhe uma e avisa) — só divergência
 * de VALOR entre elas seria problema, e isso é conciliação, não sequência.
 */

/** Uma coluna candidata da série, do jeito que a base contábil a conhece. */
export type ColunaSerie = {
  /** Data-chave da coluna (fim do intervalo), dd/mm/aaaa. */
  periodo: string;
  tipo: "mes" | "exercicio";
  /** Intervalo COBERTO pelo documento (DRE). Sem intervalo, assume-se o ano
   *  cheio da data-chave — é o que um demonstrativo anual cobre. */
  inicio?: string | null;
  fim?: string | null;
};

export type Lacuna = { de: string; ate: string; rotulo: string };

export type AvaliacaoSerie = {
  /** true = sem buraco entre a primeira e a última coluna. */
  ok: boolean;
  lacunas: Lacuna[];
  /** Colunas em ordem cronológica (data-chave). */
  ordenada: string[];
  /** Cobertura total, para a tela dizer "de X a Y". */
  cobertura: { de: string; ate: string } | null;
  /** Frases prontas para o analista — sempre dizem O QUE falta. */
  motivos: string[];
};

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** dd/mm/aaaa → Date (UTC, sem hora). Fora do formato → null. */
export function dataBR(s: string | null | undefined): Date | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s ?? "").trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3]!, +m[2]! - 1, +m[1]!));
  return Number.isNaN(d.getTime()) ? null : d;
}

const paraBR = (d: Date): string =>
  `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;

const somaDias = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000);

/** "de 01/01/2023 a 31/12/2024" vira "2023 e 2024"; buraco curto vira
 *  "fevereiro a maio de 2026". Rótulo é para o analista agir, não decorar. */
function rotularLacuna(de: Date, ate: Date): string {
  const anoDe = de.getUTCFullYear(), anoAte = ate.getUTCFullYear();
  const cobreAnoInteiro = de.getUTCMonth() === 0 && de.getUTCDate() === 1 && ate.getUTCMonth() === 11 && ate.getUTCDate() === 31;
  if (cobreAnoInteiro) return anoDe === anoAte ? `${anoDe}` : `${anoDe} a ${anoAte}`;
  if (anoDe === anoAte) {
    const mDe = MESES[de.getUTCMonth()]!, mAte = MESES[ate.getUTCMonth()]!;
    return mDe === mAte ? `${mDe} de ${anoDe}` : `${mDe} a ${mAte} de ${anoDe}`;
  }
  return `${MESES[de.getUTCMonth()]} de ${anoDe} a ${MESES[ate.getUTCMonth()]} de ${anoAte}`;
}

/** Intervalo coberto por uma coluna. Sem `inicio` declarado, um exercício
 *  cobre o ano cheio e um mês cobre do 1º de janeiro (balancete é acumulado). */
export function intervaloDaColuna(c: ColunaSerie): { inicio: Date; fim: Date } | null {
  const fim = dataBR(c.fim ?? c.periodo);
  if (!fim) return null;
  const inicio = dataBR(c.inicio) ?? new Date(Date.UTC(fim.getUTCFullYear(), 0, 1));
  return inicio > fim ? { inicio: fim, fim } : { inicio, fim };
}

/**
 * Avalia a sequência das colunas selecionadas. Uma coluna só, ou nenhuma,
 * nunca tem buraco — a falta de HISTÓRICO é outra conversa (o wizard avisa
 * separadamente), não uma quebra de série.
 */
export function avaliarSerie(colunas: ColunaSerie[]): AvaliacaoSerie {
  const validas = colunas
    .map((c) => ({ c, iv: intervaloDaColuna(c) }))
    .filter((x): x is { c: ColunaSerie; iv: { inicio: Date; fim: Date } } => x.iv !== null)
    .sort((a, b) => a.iv.inicio.getTime() - b.iv.inicio.getTime() || a.iv.fim.getTime() - b.iv.fim.getTime());

  const ordenada = [...validas].sort((a, b) => a.iv.fim.getTime() - b.iv.fim.getTime()).map((x) => x.c.periodo);
  if (validas.length === 0) return { ok: true, lacunas: [], ordenada: [], cobertura: null, motivos: [] };

  const lacunas: Lacuna[] = [];
  let coberto = validas[0]!.iv.fim;
  const inicioTotal = validas[0]!.iv.inicio;
  for (const { iv } of validas.slice(1)) {
    // Sobreposição e aninhamento (o acumulado 01/01–31/05 dentro de
    // 01/01–30/06) não abrem buraco: só um salto ADIANTE do coberto abre.
    if (iv.inicio.getTime() > somaDias(coberto, 1).getTime()) {
      const de = somaDias(coberto, 1), ate = somaDias(iv.inicio, -1);
      lacunas.push({ de: paraBR(de), ate: paraBR(ate), rotulo: rotularLacuna(de, ate) });
    }
    if (iv.fim > coberto) coberto = iv.fim;
  }

  const motivos = lacunas.map(
    (l) => `A série tem buraco em ${l.rotulo} (de ${l.de} a ${l.ate}): sem esse período, toda variação que atravessa o buraco fica sem significado. Inclua o documento que cobre esse intervalo ou recorte a seleção para um trecho contínuo.`,
  );
  return {
    ok: lacunas.length === 0,
    lacunas,
    ordenada,
    cobertura: { de: paraBR(inicioTotal), ate: paraBR(coberto) },
    motivos,
  };
}

/**
 * Trecho CONTÍNUO mais recente dentro de uma seleção furada — é o que a tela
 * oferece com um clique ("usar só 2024 em diante") quando o analista não tem
 * como obter o documento que falta.
 */
export function trechoContinuoMaisRecente(colunas: ColunaSerie[]): string[] {
  const av = avaliarSerie(colunas);
  if (av.ok) return av.ordenada;
  const ultimaLacuna = av.lacunas[av.lacunas.length - 1]!;
  const corte = dataBR(ultimaLacuna.ate)!;
  return colunas
    .map((c) => ({ c, iv: intervaloDaColuna(c) }))
    .filter((x) => x.iv && x.iv.inicio > corte)
    .sort((a, b) => a.iv!.fim.getTime() - b.iv!.fim.getTime())
    .map((x) => x.c.periodo);
}

/**
 * Colunas da série a partir do que o IBR guardou em `dadosEstruturados`.
 *
 * Serve os dois caminhos de extração: quando o IBR leu a base do workspace, o
 * intervalo real de cada documento veio junto (`intervaloPorPeriodo`); no
 * caminho antigo não existe esse dado e vale a convenção do motor — mês de
 * balancete é ACUMULADO (cobre desde 1º de janeiro) e exercício cobre o ano
 * cheio. É a mesma suposição que `intervaloDaColuna` já faz.
 */
export function colunasDoIBR(dados: {
  periodos?: string[];
  arvoresBalancete?: Array<{ periodo?: string }>;
  intervaloPorPeriodo?: Record<string, { inicio: string; fim: string; tipo: "mes" | "exercicio" }>;
}): ColunaSerie[] {
  const meses = new Set((dados.arvoresBalancete ?? []).map((a) => a?.periodo).filter(Boolean) as string[]);
  return (dados.periodos ?? []).map((p) => {
    const iv = dados.intervaloPorPeriodo?.[p];
    if (iv) return { periodo: p, tipo: iv.tipo, inicio: iv.inicio, fim: iv.fim };
    return { periodo: p, tipo: meses.has(p) ? ("mes" as const) : ("exercicio" as const) };
  });
}
