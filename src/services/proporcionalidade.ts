/**
 * TESTE DE PROPORCIONALIDADE — a janela YTD está no ritmo do último exercício
 * fechado, linha a linha?
 *
 * O acervo típico é: exercícios anteriores FECHADOS (anuais) + ano corrente em
 * balancete mensal. "Mesmo mês do ano anterior" e "LTM da empresa" não existem
 * e em geral nunca existirão. Mas a comparação que importa não precisa deles:
 * basta perguntar quanto do exercício fechado cada linha já realizou, e comparar
 * com a fração de calendário decorrida.
 *
 * Por que NÃO medir concentração de receita dentro da janela (tentativa
 * anterior, descartada): irregularidade intra-janela não testa proporcionalidade.
 * Medido na Belagro, a receita dos 5 meses é 44,3% do exercício fechado em 41,7%
 * do calendário — ADIANTE do proporcional — enquanto a métrica de concentração
 * marcava a empresa como "janela não proporcional". O desvio real está no
 * RESULTADO e na DESPESA FINANCEIRA, e só o teste linha a linha o encontra.
 *
 * O que este teste NÃO faz: separar sazonalidade de deterioração, nem julgar se
 * um desvio é grande. Ele publica DOIS FATOS por linha — quanto do exercício
 * fechado a janela já realizou e quanto do calendário já passou — e a razão
 * entre eles. A causa exige o mesmo mês do ano anterior, que a base não tem, e
 * o tamanho aceitável dependeria de um limiar que ninguém mediu. Quem lê julga.
 */

/** Linhas testadas — a espinha da DRE, do topo ao resultado. */
const LINHAS = ["Receita Líquida", "Custo Operacional", "EBITDA", "Despesas Financeiras", "Lucro Líquido"] as const;

/**
 * SEM LIMIAR, DE PROPÓSITO (19/08/2026, decisão do dono: "não podemos inventar
 * números").
 *
 * A versão anterior classificava a linha como dentro ou fora de uma faixa de
 * ±15%. Esses 15% eram invenção minha: não vinham de documento nenhum, não se
 * ajustavam ao ponto do ano (com 1 mês fechado a janela é 1/12 do exercício e um
 * contrato grande move o ritmo em 30% sem nada de errado) e, numa carteira
 * sazonal, acenderiam quase sempre — aviso que sempre acende vira ruído.
 *
 * Agora não há classificação. O motor publica DOIS FATOS medidos por linha —
 * quanto do exercício fechado a janela já realizou, e quanto do calendário já
 * passou — e a razão entre eles. Quem lê julga. É estritamente mais honesto e
 * elimina o único número inventado que havia aqui.
 *
 * O que sobra abaixo não é afirmação sobre o negócio, é higiene numérica.
 */
/** Denominador irrelevante: fechamento perto de zero não é base de razão. */
const MIN_BASE = 1_000;

export interface LinhaProporcional {
  conta: string;
  /** Acumulado do exercício corrente. */
  ytd: number;
  /** Mesmo linha no último exercício fechado. */
  fechado: number;
  /** ytd ÷ fechado. */
  razao: number;
  /** razao ÷ fração de calendário decorrida. 1,0 = exatamente no ritmo. */
  ritmo: number;
}

export interface Proporcionalidade {
  periodoYTD: string;
  periodoFechado: string;
  /** Meses decorridos do exercício corrente (1–12). */
  meses: number;
  /** meses ÷ 12. */
  fracaoCalendario: number;
  linhas: LinhaProporcional[];
  leitura: string;
}

const ehMensal = (p: string): boolean => /^\d{2}\/\d{2}\/\d{4}$/.test(p);
const mesDe = (p: string): number => Number(p.slice(3, 5));
const anoDe = (p: string): number => Number(p.slice(-4));
const rot = (p: string, exercicio = false): string =>
  exercicio || !ehMensal(p) ? String(anoDe(p)) : `${p.slice(3, 5)}/${p.slice(-4)}`;

/**
 * @param periodosYTD colunas de balancete do exercício corrente (parciais).
 * @returns null quando falta o par YTD × exercício fechado — ausência de medida.
 */
export function medirProporcionalidade(
  dre: Array<{ conta: string; valores?: Record<string, number> }> | null | undefined,
  periodos: string[] | null | undefined,
  periodosYTD: string[] | null | undefined,
  /** Colunas que cobrem o EXERCÍCIO INTEIRO (`periodosDeExercicioFechado`).
   *  NUNCA se infere isto pela ausência em `periodosYTD`: 31/12 é acumulado E
   *  fechado ao mesmo tempo, e a inferência derrubava a comparação para o ano
   *  anterior — na Belagro, contra 2024 em vez de 2025. */
  periodosFechados?: string[] | null,
): Proporcionalidade | null {
  if (!Array.isArray(dre) || !dre.length || !Array.isArray(periodos) || !periodos.length) return null;
  const ytdSet = new Set(periodosYTD ?? []);

  // Coluna PARCIAL mais recente do exercício corrente. Dezembro fecha o ano e
  // não é parcial — nada a testar quando a série chega ao fim do exercício.
  const parciais = periodos.filter((p) => ehMensal(p) && ytdSet.has(p) && mesDe(p) < 12);
  if (!parciais.length) return null;
  const ytdP = parciais.sort((a, b) => anoDe(a) - anoDe(b) || mesDe(a) - mesDe(b)).at(-1)!;
  const meses = mesDe(ytdP);

  // Último EXERCÍCIO FECHADO anterior ao ano corrente.
  const anoCorrente = anoDe(ytdP);
  const fechadosSet = new Set(periodosFechados ?? []);
  const fechados = periodos
    .filter((p) => fechadosSet.has(p) && anoDe(p) < anoCorrente)
    // Desempate EXPLÍCITO: com "2025" e "31/12/2025" na série, o rótulo ANUAL
    // vence — não se apoia na estabilidade do sort.
    .sort((a, b) => anoDe(a) - anoDe(b) || (ehMensal(a) ? 0 : 1) - (ehMensal(b) ? 0 : 1));
  const fechadoP = fechados.at(-1);
  if (!fechadoP) return null;
  // SEM CORTE POR IDADE. Um corte silencioso já custou caro hoje (exigir
  // `periodoInicio` apagou a régua inteira). A referência vai SEMPRE nomeada na
  // leitura — "exercício fechado de 2019" se avisa sozinho, e mostrar com
  // ressalva é melhor que recusar em silêncio.

  const fracao = meses / 12;
  const val = (conta: string, p: string): number | null => {
    const v = dre.find((l) => l?.conta === conta)?.valores?.[p];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };

  // A coluna parcial é mesmo uma DRE? Receita zerada contra fechamento material
  // é coluna recusada, não empresa sem faturamento — ausência de medida.
  const recYTD = val("Receita Líquida", ytdP);
  const recFech = val("Receita Líquida", fechadoP);
  if (recFech !== null && Math.abs(recFech) >= MIN_BASE && (recYTD === null || Math.abs(recYTD) < 0.005)) return null;

  const linhas: LinhaProporcional[] = [];
  for (const conta of LINHAS) {
    const a = val(conta, ytdP);
    const b = val(conta, fechadoP);
    // MATERIAL nos dois lados: `0` é number e passava. Coluna de DRE recusada
    // grava 0 nos subtotais, e a razão 0,00× marcava a linha como desviante —
    // amordaçando o diagnóstico da DRE inteira com número que não existe.
    if (a === null || b === null || Math.abs(b) < MIN_BASE || Math.abs(a) < 0.005) continue;
    const razao = a / b;
    const ritmo = razao / fracao;
    linhas.push({ conta, ytd: a, fechado: b, razao, ritmo });
  }
  if (!linhas.length) return null;

  const pct = (v: number) => `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
  const x = (v: number) => `${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`;

  // FATOS, sem veredicto: as duas porcentagens medidas e a razão entre elas.
  const leitura =
    `Comparado ao exercício fechado de ${rot(fechadoP, true)}: o acumulado de ${meses} meses de ${anoCorrente} cobre ` +
    `${pct(fracao)} do calendário, e cada linha da DRE já realizou — ` +
    linhas.map((l) => `${l.conta} ${pct(l.razao)} (${x(l.ritmo)} do proporcional)`).join("; ") + ". " +
    `Este teste NÃO distingue sazonalidade de deterioração: isso exigiria o mesmo mês do exercício anterior, que não está na base. ` +
    `Também não classifica desvio como grande ou pequeno — não há limiar medido para isso.`

  return { periodoYTD: ytdP, periodoFechado: fechadoP, meses, fracaoCalendario: fracao, linhas, leitura };
}
