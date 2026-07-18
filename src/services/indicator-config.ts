/**
 * INDICADORES CONFIGURÁVEIS — ponte entre a tabela IndicatorConfig (tela "Indicadores")
 * e o motor determinístico.
 *
 * Regras de segurança (a análise NUNCA quebra):
 * - Indicadores de SISTEMA são sempre calculados (IA/estágio/pares dependem deles);
 *   a config só pode editar o semáforo e ocultar a EXIBIÇÃO (flag `oculto` no item).
 * - Indicadores PERSONALIZADOS são aditivos: (Σ numerador) / (Σ denominador) × mult,
 *   sobre linhas do modelo padrão — determinísticos, sem IA, nunca afetam os canônicos.
 */
import { prisma } from "../db/client";
import type { BPLineItem, DRELineItem, Indicador } from "../types/financial";
import { calculateIndicators, statusPorSemaforo, type SemaforoDef } from "./indicator-calculator";

export interface TermoFormula {
  origem: "BP" | "DRE";
  conta: string;
  sinal?: 1 | -1;
  abs?: boolean;
  /** Operação aplicada na SEQUÊNCIA (estilo calculadora, sem precedência):
   *  acumulado (op) valor. Ausente = "+" (ou "−" via sinal legado). */
  op?: "+" | "-" | "*" | "/";
}

export interface ConfigRow {
  nome: string; sistema: boolean; ativo: boolean; grupo: string; tipoDado: string;
  formula: string | null; numerador: unknown; denominador: unknown; multiplicador: number | null;
  semDirecao: string | null; semCritico: number | null; semAtencao: number | null; ordem: number;
}

function semaforoDe(c: ConfigRow): SemaforoDef | undefined {
  if (c.semDirecao !== "menor_ruim" && c.semDirecao !== "maior_ruim") return undefined;
  if (c.semCritico === null || c.semAtencao === null) return undefined;
  return { direcao: c.semDirecao, critico: c.semCritico, atencao: c.semAtencao };
}

/** Avalia os termos NA ORDEM (calculadora, sem precedência): +, −, × e ÷.
 *  Compat: termo sem `op` usa o sinal legado (+/−). Divisão por zero → null. */
function avaliaTermos(termos: TermoFormula[], bp: BPLineItem[], dre: DRELineItem[], p: string): number | null {
  let acc = 0;
  for (let i = 0; i < termos.length; i++) {
    const t = termos[i];
    const item = t.origem === "BP" ? bp.find((l) => l.conta === t.conta) : dre.find((l) => l.conta === t.conta);
    let v = item?.valores[p] ?? 0;
    if (t.abs) v = Math.abs(v);
    const op = t.op ?? ((t.sinal ?? 1) === -1 ? "-" : "+");
    if (i === 0) {
      // 1º termo é a BASE da sequência: × e ÷ não fazem sentido sobre 0.
      acc = op === "-" ? -v : v;
      continue;
    }
    if (op === "+") acc += v;
    else if (op === "-") acc -= v;
    else if (op === "*") acc *= v;
    else {
      if (v === 0) return null; // divisão por zero → sem valor (não NaN/Infinity)
      acc /= v;
    }
  }
  return acc;
}

function computeCustom(c: ConfigRow, bp: BPLineItem[], dre: DRELineItem[], periodos: string[]): Indicador {
  const num = Array.isArray(c.numerador) ? (c.numerador as TermoFormula[]) : [];
  const den = Array.isArray(c.denominador) ? (c.denominador as TermoFormula[]) : null;
  const sem = semaforoDe(c);
  const valores: Record<string, number | string | null> = {};
  const status: Record<string, "ok" | "atencao" | "critico" | null> = {};
  for (const p of periodos) {
    let v: number | null = num.length ? avaliaTermos(num, bp, dre, p) : null;
    if (v !== null && den && den.length) {
      const d = avaliaTermos(den, bp, dre, p);
      v = d === null || d === 0 ? null : v / d;
    }
    if (v !== null && c.multiplicador) v = v * c.multiplicador;
    if (v !== null && c.tipoDado === "Dias") v = Math.round(v);
    valores[p] = v;
    status[p] = typeof v === "number" ? statusPorSemaforo(sem, v) : null;
  }
  return {
    tipo: c.grupo, nome: c.nome, formula: c.formula ?? "", tipoDado: (c.tipoDado as Indicador["tipoDado"]) ?? "Índice",
    valores, status, overrides: {},
  };
}

/**
 * Calcula TODOS os indicadores (canônicos + personalizados) aplicando a config do banco
 * (semáforo editado, exibição, ordem). Best-effort: se a tabela não existir/der erro,
 * cai nos canônicos com defaults — o processamento nunca quebra por causa da config.
 */
export async function buildIndicators(
  bp: BPLineItem[],
  dre: DRELineItem[],
  periodos: string[],
  // Config DO IBR (Analysis.indicadorConfig.rows): quando presente, substitui o catálogo
  // global — semáforo calibrado pelos pares, exibição e personalizados daquele engajamento.
  ibrRows?: ConfigRow[] | null,
  // Períodos de BALANCETE (DRE acumulada no ano): prazos médios usam dias YTD (mês × 30).
  periodosYTD?: string[],
): Promise<Indicador[]> {
  let configs: ConfigRow[] = [];
  if (ibrRows && ibrRows.length > 0) {
    configs = ibrRows;
  } else try {
    configs = (await prisma.indicatorConfig.findMany({ orderBy: [{ grupo: "asc" }, { ordem: "asc" }] })) as unknown as ConfigRow[];
  } catch (e: unknown) {
    console.warn("[indicators] config indisponível (segue com defaults):", e instanceof Error ? e.message : e);
  }
  const byNome = new Map(configs.map((c) => [c.nome, c]));

  // Canônicos: semáforo editado no banco sobrepõe o default do código.
  const overrides: Record<string, SemaforoDef> = {};
  for (const c of configs) {
    if (!c.sistema) continue;
    const sem = semaforoDe(c);
    if (sem) overrides[c.nome] = sem;
  }
  const canonicos = calculateIndicators(bp, dre, periodos, overrides, undefined, periodosYTD).map((ind) => {
    const c = byNome.get(ind.nome);
    return c && !c.ativo ? { ...ind, oculto: true } : ind;
  });

  // Personalizados (aditivos), na ordem da config.
  const customs = configs.filter((c) => !c.sistema).map((c) => {
    const ind = computeCustom(c, bp, dre, periodos);
    return c.ativo ? ind : { ...ind, oculto: true };
  });

  return [...canonicos, ...customs];
}
