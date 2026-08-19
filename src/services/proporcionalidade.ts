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
 * O que este teste NÃO faz: separar sazonalidade de deterioração. Ele NOMEIA a
 * linha que desvia e o tamanho do desvio; a causa exige o mesmo mês do ano
 * anterior, que a base não tem. Por isso a saída trava o veredicto em vez de
 * emitir um.
 */

/** Linhas testadas — a espinha da DRE, do topo ao resultado. */
const LINHAS = ["Receita Líquida", "Custo Operacional", "EBITDA", "Despesas Financeiras", "Lucro Líquido"] as const;

/** Fora desta faixa a linha não está no ritmo do exercício fechado. */
const FAIXA: [number, number] = [0.85, 1.15];
/** Denominador irrelevante: fechamento perto de zero não é base de razão. */
const MIN_BASE = 1_000;
/** Exercício fechado mais antigo que isso não é referência do mesmo negócio. */
const MAX_ANOS = 2;

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
  desvia: boolean;
}

export interface Proporcionalidade {
  periodoYTD: string;
  periodoFechado: string;
  /** Meses decorridos do exercício corrente (1–12). */
  meses: number;
  /** meses ÷ 12. */
  fracaoCalendario: number;
  linhas: LinhaProporcional[];
  /** Contas fora da faixa — onde o veredicto de fluxo fica travado. */
  desviantes: string[];
  /** true = ao menos uma linha fora do ritmo. */
  temDesvio: boolean;
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
  /** Balancetes lidos — dá a JANELA declarada de cada coluna mensal. Sem isso um
   *  balancete de DEZEMBRO encerrado (janela 01/12–31/12, um mês) passa por
   *  "exercício fechado" e vira denominador anual: medido, 11,61× contra 0,97×. */
  balancetes?: Array<{ periodo?: string; periodoInicio?: string; provas?: { exercicioEncerrado?: boolean } }> | null,
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
  const bals = Array.isArray(balancetes) ? balancetes : [];
  const doBalancete = new Map(bals.filter((b) => b?.periodo).map((b) => [String(b.periodo), b]));
  /** Coluna cobre o EXERCÍCIO inteiro? Documento anual sempre; balancete só se a
   *  janela declarada começa em 01/01. Sem `periodoInicio` não se presume o ano. */
  const cobreExercicio = (p: string): boolean => {
    const b = doBalancete.get(p);
    if (!b) return true;                                  // não veio de balancete
    return /^01\/01\//.test(String(b.periodoInicio ?? ""));
  };
  const fechados = periodos
    .filter((p) => !ytdSet.has(p) && (!ehMensal(p) || mesDe(p) === 12))
    .filter((p) => anoDe(p) < anoCorrente && cobreExercicio(p))
    // Desempate EXPLÍCITO: com "2025" e "31/12/2025" na série, o ano vence — não
    // se apoia na estabilidade do sort, que entregava a coluna de um mês.
    .sort((a, b) => anoDe(a) - anoDe(b) || (doBalancete.has(a) ? 0 : 1) - (doBalancete.has(b) ? 0 : 1));
  const fechadoP = fechados.at(-1);
  if (!fechadoP) return null;
  // DISTÂNCIA: base velha demais deixa de ser referência do mesmo negócio.
  if (anoCorrente - anoDe(fechadoP) > MAX_ANOS) return null;

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
    linhas.push({ conta, ytd: a, fechado: b, razao, ritmo, desvia: ritmo < FAIXA[0] || ritmo > FAIXA[1] });
  }
  if (!linhas.length) return null;

  const desviantes = linhas.filter((l) => l.desvia).map((l) => l.conta);
  const temDesvio = desviantes.length > 0;
  const x = (v: number) => `${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`;
  const noRitmo = linhas.filter((l) => !l.desvia).map((l) => l.conta);

  const leitura = temDesvio
    ? `Comparado ao exercício fechado de ${rot(fechadoP, true)}, o acumulado de ${meses} meses de ${anoCorrente} realizou ${(fracao * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% do calendário. ` +
      (noRitmo.length ? `No ritmo: ${noRitmo.join(", ")}. ` : "") +
      `FORA do ritmo: ${linhas.filter((l) => l.desvia).map((l) => `${l.conta} a ${x(l.ritmo)} do proporcional`).join("; ")}. ` +
      `O desvio está nessas linhas, não na janela inteira — e este teste NÃO distingue sazonalidade de deterioração, porque isso exigiria o mesmo mês do exercício anterior, que não está na base.`
    : `Comparado ao exercício fechado de ${rot(fechadoP, true)}, todas as linhas testadas do acumulado de ${meses} meses estão no ritmo do calendário decorrido (${(fracao * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%). A janela é aproximadamente proporcional ao exercício.`;

  return { periodoYTD: ytdP, periodoFechado: fechadoP, meses, fracaoCalendario: fracao, linhas, desviantes, temDesvio, leitura };
}
