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

export interface TermoFormula { origem: "BP" | "DRE"; conta: string; sinal?: 1 | -1; abs?: boolean }

interface ConfigRow {
  nome: string; sistema: boolean; ativo: boolean; grupo: string; tipoDado: string;
  formula: string | null; numerador: unknown; denominador: unknown; multiplicador: number | null;
  semDirecao: string | null; semCritico: number | null; semAtencao: number | null; ordem: number;
}

function semaforoDe(c: ConfigRow): SemaforoDef | undefined {
  if (c.semDirecao !== "menor_ruim" && c.semDirecao !== "maior_ruim") return undefined;
  if (c.semCritico === null || c.semAtencao === null) return undefined;
  return { direcao: c.semDirecao, critico: c.semCritico, atencao: c.semAtencao };
}

function somaTermos(termos: TermoFormula[], bp: BPLineItem[], dre: DRELineItem[], p: string): number {
  let s = 0;
  for (const t of termos) {
    const item = t.origem === "BP" ? bp.find((l) => l.conta === t.conta) : dre.find((l) => l.conta === t.conta);
    let v = item?.valores[p] ?? 0;
    if (t.abs) v = Math.abs(v);
    s += v * (t.sinal ?? 1);
  }
  return s;
}

function computeCustom(c: ConfigRow, bp: BPLineItem[], dre: DRELineItem[], periodos: string[]): Indicador {
  const num = Array.isArray(c.numerador) ? (c.numerador as TermoFormula[]) : [];
  const den = Array.isArray(c.denominador) ? (c.denominador as TermoFormula[]) : null;
  const sem = semaforoDe(c);
  const valores: Record<string, number | string | null> = {};
  const status: Record<string, "ok" | "atencao" | "critico" | null> = {};
  for (const p of periodos) {
    let v: number | null = num.length ? somaTermos(num, bp, dre, p) : null;
    if (v !== null && den && den.length) {
      const d = somaTermos(den, bp, dre, p);
      v = d === 0 ? null : v / d;
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
export async function buildIndicators(bp: BPLineItem[], dre: DRELineItem[], periodos: string[]): Promise<Indicador[]> {
  let configs: ConfigRow[] = [];
  try {
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
  const canonicos = calculateIndicators(bp, dre, periodos, overrides).map((ind) => {
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
