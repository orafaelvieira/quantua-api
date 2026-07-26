/**
 * ANO SAFRA e JANELA MÓVEL — recortes de período do Modelo Financeiro.
 *
 * O agronegócio não fecha em dezembro: o resultado que importa é o da SAFRA
 * (ex.: jul/2025 → jun/2026, "safra 2025/26"). A planilha de referência oferece
 * esse recorte na aba Resumo ("ano contábil ou ano safra") e uma janela móvel
 * de 12 meses com mês inicial escolhido pelo usuário (Resumo!F6).
 *
 * REGRA DE AGREGAÇÃO — a mesma da planilha, e a razão de este módulo existir:
 * somar 12 meses só faz sentido para FLUXO. Um saldo de balanço agregado é o
 * do ÚLTIMO mês do período; uma margem é RECALCULADA sobre os agregados, nunca
 * a média das margens mensais (é aqui que a planilha erra ao usar AVERAGEIF
 * nos totais anuais — ver PLANO_BUSINESS_PLAN_BELAGRO.md, Parte 4, item 5).
 *
 * Determinístico: zero IA aqui.
 */
import { LinhaDre, Serie, mesAdd } from "./model-engine";
import { Janela, mesesDaJanela, ehLinhaPercentual } from "./model-orcamento";

// ── Tipos ──────────────────────────────────────────────────────────────────

/** Natureza da linha para fins de agregação. */
export type NaturezaLinha = "fluxo" | "saldo" | "taxa";

export interface PeriodoAgregado {
  /** Rótulo de exibição: "2026" (contábil) ou "2025/26" (safra). */
  rotulo: string;
  /** Primeiro e último mês do período (podem cair fora do horizonte). */
  janela: Janela;
  /** Meses do período efetivamente presentes no horizonte. */
  meses: string[];
  /** Período incompleto (horizonte não cobre os 12 meses). */
  parcial: boolean;
}

export interface OpcoesRecorte {
  /**
   * Mês (1–12) em que a safra começa. 1 = ano contábil (jan–dez).
   * Belagro: a safra de grãos costuma abrir em julho.
   */
  mesInicioSafra?: number;
}

// ── Períodos ───────────────────────────────────────────────────────────────

function anoDe(mes: string): number {
  return Number(mes.slice(0, 4));
}
function mesDe(mes: string): number {
  return Number(mes.slice(5, 7));
}

/**
 * Rótulo do período safra que CONTÉM o mês dado.
 * Safra iniciando em julho: jul/2025 … jun/2026 → "2025/26".
 * Com início em janeiro, degenera no ano contábil → "2025".
 */
export function rotuloSafra(mes: string, mesInicioSafra: number): string {
  if (mesInicioSafra === 1) return String(anoDe(mes));
  const anoInicio = mesDe(mes) >= mesInicioSafra ? anoDe(mes) : anoDe(mes) - 1;
  const fim = String(anoInicio + 1).slice(2);
  return `${anoInicio}/${fim}`;
}

/** Primeiro mês do período safra que contém o mês dado. */
export function inicioSafraDe(mes: string, mesInicioSafra: number): string {
  const anoInicio = mesInicioSafra === 1 || mesDe(mes) >= mesInicioSafra ? anoDe(mes) : anoDe(mes) - 1;
  return `${anoInicio}-${String(mesInicioSafra).padStart(2, "0")}`;
}

/**
 * Divide o horizonte em períodos (contábeis ou safra), na ordem cronológica.
 * Períodos nas pontas do horizonte saem marcados como `parcial`.
 */
export function periodosDoHorizonte(meses: string[], opts: OpcoesRecorte = {}): PeriodoAgregado[] {
  const inicioSafra = opts.mesInicioSafra ?? 1;
  if (meses.length === 0) return [];

  const porRotulo = new Map<string, string[]>();
  const ordem: string[] = [];
  for (const m of meses) {
    const rot = rotuloSafra(m, inicioSafra);
    if (!porRotulo.has(rot)) {
      porRotulo.set(rot, []);
      ordem.push(rot);
    }
    porRotulo.get(rot)!.push(m);
  }

  return ordem.map((rotulo) => {
    const doPeriodo = porRotulo.get(rotulo)!;
    const de = inicioSafraDe(doPeriodo[0]!, inicioSafra);
    const ate = mesAdd(de, 11);
    return {
      rotulo,
      janela: { de, ate },
      meses: doPeriodo,
      parcial: doPeriodo.length < 12,
    };
  });
}

/** Janela móvel de 12 meses a partir do mês escolhido (Resumo!F6 da planilha). */
export function janelaMovel(mesInicial: string, tamanhoMeses = 12): Janela {
  return { de: mesInicial, ate: mesAdd(mesInicial, tamanhoMeses - 1) };
}

// ── Agregação ──────────────────────────────────────────────────────────────

/**
 * Natureza de uma linha. Margens são taxa; linhas do balanço são saldo;
 * o resto é fluxo. `origem` permite ao chamador declarar (bp/fc/dre) em vez
 * de depender do nome.
 */
export function naturezaDaLinha(linha: LinhaDre, origem?: "dre" | "bp" | "fc"): NaturezaLinha {
  if (ehLinhaPercentual(linha.nome)) return "taxa";
  if (origem === "bp") return "saldo";
  return "fluxo";
}

/**
 * Agrega uma série num período, respeitando a natureza da linha.
 *  - fluxo: soma os meses
 *  - saldo: valor do ÚLTIMO mês presente (é estoque, não se soma)
 *  - taxa: recalcula sobre os agregados (Σvalor ÷ Σbase), nunca média de médias
 */
export function agregarSerie(
  linha: Pick<LinhaDre, "valores" | "pctReceita">,
  meses: string[],
  natureza: NaturezaLinha
): number {
  if (meses.length === 0) return 0;

  if (natureza === "saldo") {
    for (let i = meses.length - 1; i >= 0; i--) {
      const v = linha.valores?.[meses[i]!];
      if (v !== undefined) return v;
    }
    return 0;
  }

  if (natureza === "taxa") {
    // Reconstrói a base a partir de valor ÷ pctReceita e recalcula a razão.
    let somaValor = 0;
    let somaBase = 0;
    let temBase = false;
    for (const m of meses) {
      const v = linha.valores?.[m] ?? 0;
      const p = linha.pctReceita?.[m];
      somaValor += v;
      if (p !== undefined && p !== 0) {
        somaBase += v / p;
        temBase = true;
      }
    }
    if (temBase && somaBase !== 0) return somaValor / somaBase;
    const comValor = meses.filter((m) => (linha.valores?.[m] ?? 0) !== 0);
    if (comValor.length === 0) return 0;
    return comValor.reduce((a, m) => a + (linha.valores?.[m] ?? 0), 0) / comValor.length;
  }

  let t = 0;
  for (const m of meses) t += linha.valores?.[m] ?? 0;
  return t;
}

export interface LinhaAgregada {
  id: string;
  nome: string;
  grupo: LinhaDre["grupo"];
  natureza: NaturezaLinha;
  /** {rotuloDoPeriodo: valor}. */
  porPeriodo: Record<string, number>;
}

export interface ResultadoRecorte {
  periodos: PeriodoAgregado[];
  linhas: LinhaAgregada[];
  avisos: string[];
}

/**
 * Aplica o recorte (contábil ou safra) a um conjunto de linhas.
 * `origem` declara a natureza das linhas do bloco (bp = saldos).
 */
export function agregarPorPeriodo(
  linhas: LinhaDre[],
  meses: string[],
  opts: OpcoesRecorte & { origem?: "dre" | "bp" | "fc" } = {}
): ResultadoRecorte {
  const periodos = periodosDoHorizonte(meses, opts);
  const avisos: string[] = [];

  const parciais = periodos.filter((p) => p.parcial);
  if (parciais.length > 0) {
    avisos.push(
      `${parciais.length === 1 ? "O período" : "Os períodos"} ${parciais.map((p) => p.rotulo).join(", ")} ${parciais.length === 1 ? "está incompleto" : "estão incompletos"} no horizonte do modelo — o total não cobre 12 meses.`
    );
  }

  const linhasAgregadas: LinhaAgregada[] = linhas.map((l) => {
    const natureza = naturezaDaLinha(l, opts.origem);
    const porPeriodo: Record<string, number> = {};
    for (const p of periodos) porPeriodo[p.rotulo] = agregarSerie(l, p.meses, natureza);
    return { id: l.id, nome: l.nome, grupo: l.grupo, natureza, porPeriodo };
  });

  return { periodos, linhas: linhasAgregadas, avisos };
}

/**
 * Recorte de janela móvel: os 12 (ou N) meses a partir do mês escolhido,
 * mês a mês, mais a coluna de total do período — o layout da aba Resumo.
 */
export function recorteJanelaMovel(
  linhas: LinhaDre[],
  mesInicial: string,
  opts: { tamanhoMeses?: number; origem?: "dre" | "bp" | "fc"; mesesDisponiveis?: string[] } = {}
): {
  janela: Janela;
  meses: string[];
  linhas: Array<{ id: string; nome: string; grupo: LinhaDre["grupo"]; natureza: NaturezaLinha; valores: Serie; total: number }>;
  avisos: string[];
} {
  const janela = janelaMovel(mesInicial, opts.tamanhoMeses ?? 12);
  const meses = mesesDaJanela(janela);
  const avisos: string[] = [];

  if (opts.mesesDisponiveis) {
    const disp = new Set(opts.mesesDisponiveis);
    const fora = meses.filter((m) => !disp.has(m));
    if (fora.length > 0) {
      avisos.push(
        `${fora.length} ${fora.length === 1 ? "mês da janela está" : "meses da janela estão"} fora do horizonte do modelo (${fora[0]}${fora.length > 1 ? ` … ${fora[fora.length - 1]}` : ""}) — ${fora.length === 1 ? "entra" : "entram"} como zero.`
      );
    }
  }

  return {
    janela,
    meses,
    linhas: linhas.map((l) => {
      const natureza = naturezaDaLinha(l, opts.origem);
      const valores: Serie = {};
      for (const m of meses) valores[m] = l.valores?.[m] ?? 0;
      return {
        id: l.id,
        nome: l.nome,
        grupo: l.grupo,
        natureza,
        valores,
        total: agregarSerie(l, meses, natureza),
      };
    }),
    avisos,
  };
}
