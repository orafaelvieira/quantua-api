/**
 * INDICADORES POR IBR — réplica editável do catálogo padrão dentro da análise,
 * com o SEMÁFORO PRÉ-CALIBRADO PELOS PARES do setor (quartis da base CVM).
 *
 * Desenho (pedido 07/07/2026):
 * - O catálogo global (tela /indicadores) continua sendo o PADRÃO.
 * - Cada IBR pode ter a própria config (Analysis.indicadorConfig): seed-if-empty a
 *   partir do padrão + calibração determinística pelos pares — cada empresa nasce
 *   comparada com empresas similares, não com uma régua fixa.
 * - Calibração (por indicador com par confiável, respeitando a polaridade):
 *     maior é melhor → atenção abaixo da MEDIANA (p50), crítico abaixo do P25;
 *     menor é melhor → atenção acima da MEDIANA (p50), crítico acima do P75.
 * - Indicadores de SISTEMA nunca são removidos (o motor sempre calcula; a config
 *   só edita semáforo/exibição). Personalizados do IBR são aditivos.
 * - A config vive em coluna própria (sobrevive ao "Reprocessar tudo") e o cálculo
 *   dos indicadores usa a config do IBR quando existir; senão, o catálogo global.
 */
import { prisma } from "../db/client";
import { INDICADORES_TEMPLATE } from "./financial-templates";
import { SEMAFORO_DEFAULTS } from "./indicator-calculator";
import { comparePeersCvm, CVM_COMPARAVEIS } from "./peer-benchmark-cvm";
import type { PeerComparisonRow } from "./peer-benchmark";

/** Linha da config do IBR — mesmo shape da tabela IndicatorConfig (a tela replica a
 *  estrutura da página /indicadores), + a proveniência do semáforo. */
export interface IBRConfigRow {
  nome: string;
  sistema: boolean;
  ativo: boolean;
  grupo: string;
  tipoDado: string;
  formula: string | null;
  numerador?: unknown;
  denominador?: unknown;
  multiplicador?: number | null;
  semDirecao: string | null;
  semCritico: number | null;
  semAtencao: number | null;
  ordem: number;
  /** "pares (…)" quando calibrado pelos quartis do setor; "padrão" caso contrário. */
  origemSemaforo: string;
}

export interface IBRIndicadorConfig {
  /** true depois da 1ª calibração com pares (não recalibra sozinho — só via botão). */
  calibrado: boolean;
  /** Metadados da calibração (segmento, período dos pares, nº de indicadores calibrados). */
  pares: { segmento: string | null; periodo: string | null; calibrados: number } | null;
  atualizadoEm: string;
  rows: IBRConfigRow[];
}

/** Catálogo PADRÃO efetivo (template do código + edições da tabela IndicatorConfig) —
 *  o mesmo conjunto que buildIndicators usa quando o IBR não tem config própria. */
export async function catalogoPadraoEfetivo(): Promise<IBRConfigRow[]> {
  let configs: Array<Record<string, unknown>> = [];
  try {
    configs = (await prisma.indicatorConfig.findMany({ orderBy: [{ grupo: "asc" }, { ordem: "asc" }] })) as unknown as Array<Record<string, unknown>>;
  } catch {
    /* sem tabela/erro → só template com defaults (mesmo fallback do buildIndicators) */
  }
  const byNome = new Map(configs.map((c) => [c.nome as string, c]));

  const rows: IBRConfigRow[] = INDICADORES_TEMPLATE.map((t, i) => {
    const c = byNome.get(t.nome);
    const def = SEMAFORO_DEFAULTS[t.nome];
    return {
      nome: t.nome,
      sistema: true,
      ativo: c ? Boolean(c.ativo) : true,
      grupo: t.tipo,
      tipoDado: t.tipoDado,
      formula: t.formula,
      semDirecao: (c?.semDirecao as string | null) ?? def?.direcao ?? null,
      semCritico: (c?.semCritico as number | null) ?? def?.critico ?? null,
      semAtencao: (c?.semAtencao as number | null) ?? def?.atencao ?? null,
      ordem: typeof c?.ordem === "number" ? (c.ordem as number) : i,
      origemSemaforo: "padrão",
    };
  });

  // Personalizados globais entram na réplica (o IBR herda o catálogo completo do dia).
  for (const c of configs) {
    if (c.sistema) continue;
    rows.push({
      nome: c.nome as string,
      sistema: false,
      ativo: Boolean(c.ativo),
      grupo: (c.grupo as string) ?? "Personalizados",
      tipoDado: (c.tipoDado as string) ?? "Índice",
      formula: (c.formula as string | null) ?? null,
      numerador: c.numerador,
      denominador: c.denominador,
      multiplicador: (c.multiplicador as number | null) ?? null,
      semDirecao: (c.semDirecao as string | null) ?? null,
      semCritico: (c.semCritico as number | null) ?? null,
      semAtencao: (c.semAtencao as number | null) ?? null,
      ordem: typeof c.ordem === "number" ? (c.ordem as number) : 999,
      origemSemaforo: "padrão",
    });
  }
  return rows;
}

/** Arredonda o limiar vindo dos pares para uma régua legível (4 casas significativas). */
function arred(v: number): number {
  if (!Number.isFinite(v) || v === 0) return v;
  const mag = Math.pow(10, 3 - Math.floor(Math.log10(Math.abs(v))));
  return Math.round(v * mag) / mag;
}

/**
 * Calibra o semáforo das rows PELOS PARES do setor (mesma cascata do Benchmark
 * Setorial: subsetor real na base CVM; nível "mercado" é descartado como ruído).
 * Determinístico, sem IA. Muta as rows; retorna os metadados da calibração.
 */
export async function calibrarSemaforoComPares(
  rows: IBRConfigRow[],
  sectorId: string | null,
  indicadores: Array<{ nome: string; valores: Record<string, unknown> }>,
  periodos: string[],
): Promise<IBRIndicadorConfig["pares"]> {
  if (!sectorId || indicadores.length === 0 || periodos.length === 0) return null;
  const sector = await prisma.sector.findUnique({ where: { code: sectorId }, include: { parent: true } });
  if (!sector) return null;
  const seg = sector.parentCode && sector.parent
    ? { classificacao: sector.parent.name, setor: sector.name }
    : { classificacao: sector.name, setor: null as string | null };

  // Último período com valor (mesma escolha do buildPeerComparison do /process).
  const ordP = [...periodos].sort();
  const ult = ordP[ordP.length - 1];
  const valores: Array<{ indicador: string; valor: number }> = [];
  for (const ind of indicadores) {
    if (!(ind.nome in CVM_COMPARAVEIS)) continue;
    const v = ind.valores?.[ult];
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) valores.push({ indicador: ind.nome, valor: n });
  }
  if (valores.length === 0) return null;

  let periodo: string | null = null;
  let peerRows: PeerComparisonRow[] = [];
  try {
    const r = await comparePeersCvm({ classificacao: seg.classificacao, setor: seg.setor }, valores);
    periodo = r.periodo;
    peerRows = r.rows.filter((x) => x.level !== "mercado"); // mercado inteiro não é par
  } catch {
    return null; // best-effort: sem pares, semáforo fica no padrão
  }

  let calibrados = 0;
  for (const pr of peerRows) {
    const row = rows.find((r) => r.nome === pr.indicador);
    if (!row) continue;
    // Polaridade decide a direção; quartis viram a régua: mediana = atenção, quartil
    // "ruim" (p25 ou p75) = crítico. Sanidade: os limiares precisam estar ordenados.
    if (pr.higherIsBetter) {
      if (!(pr.p25 <= pr.p50)) continue;
      row.semDirecao = "menor_ruim";
      row.semCritico = arred(pr.p25);
      row.semAtencao = arred(pr.p50);
    } else {
      if (!(pr.p75 >= pr.p50)) continue;
      row.semDirecao = "maior_ruim";
      row.semCritico = arred(pr.p75);
      row.semAtencao = arred(pr.p50);
    }
    row.origemSemaforo = `pares (${pr.segment}, n=${pr.count})`;
    calibrados++;
  }
  return { segmento: seg.setor ?? seg.classificacao, periodo, calibrados };
}

/** Sanitiza rows vindas do cliente (PUT): indicador de SISTEMA mantém identidade do
 *  template (nome/grupo/tipoDado/fórmula) e aceita só semáforo/exibição/ordem;
 *  personalizado é validado no shape. Sistema ausente no payload volta do padrão. */
export function sanitizeRowsIBR(rowsIn: unknown, padrao: IBRConfigRow[]): IBRConfigRow[] {
  const arr = Array.isArray(rowsIn) ? (rowsIn as Array<Record<string, unknown>>) : [];
  const byNome = new Map(arr.map((r) => [String(r.nome ?? ""), r]));
  const out: IBRConfigRow[] = [];

  // Sistema: sempre presente (regra: o motor calcula tudo; config só semáforo/exibição).
  for (const base of padrao.filter((p) => p.sistema)) {
    const r = byNome.get(base.nome);
    out.push({
      ...base,
      ativo: r ? r.ativo !== false : base.ativo,
      semDirecao: r && (r.semDirecao === "menor_ruim" || r.semDirecao === "maior_ruim") ? (r.semDirecao as string) : r && r.semDirecao === null ? null : base.semDirecao,
      semCritico: r && (typeof r.semCritico === "number" || r.semCritico === null) ? (r.semCritico as number | null) : base.semCritico,
      semAtencao: r && (typeof r.semAtencao === "number" || r.semAtencao === null) ? (r.semAtencao as number | null) : base.semAtencao,
      ordem: r && typeof r.ordem === "number" ? (r.ordem as number) : base.ordem,
      origemSemaforo: r && typeof r.origemSemaforo === "string" ? (r.origemSemaforo as string) : base.origemSemaforo,
    });
  }

  // Personalizados do payload (do IBR): shape mínimo validado; nomes não colidem com sistema.
  const nomesSistema = new Set(out.map((o) => o.nome));
  for (const r of arr) {
    const nome = String(r.nome ?? "").trim();
    if (!nome || nomesSistema.has(nome) || r.sistema === true) continue;
    if (out.some((o) => o.nome === nome)) continue; // duplicado no payload
    out.push({
      nome,
      sistema: false,
      ativo: r.ativo !== false,
      grupo: typeof r.grupo === "string" && r.grupo.trim() ? (r.grupo as string) : "Personalizados",
      tipoDado: ["R$", "%", "Índice", "Dias"].includes(r.tipoDado as string) ? (r.tipoDado as string) : "Índice",
      formula: typeof r.formula === "string" ? (r.formula as string) : null,
      numerador: Array.isArray(r.numerador) ? r.numerador : [],
      denominador: Array.isArray(r.denominador) ? r.denominador : undefined,
      multiplicador: typeof r.multiplicador === "number" ? (r.multiplicador as number) : null,
      semDirecao: r.semDirecao === "menor_ruim" || r.semDirecao === "maior_ruim" ? (r.semDirecao as string) : null,
      semCritico: typeof r.semCritico === "number" ? (r.semCritico as number) : null,
      semAtencao: typeof r.semAtencao === "number" ? (r.semAtencao as number) : null,
      ordem: typeof r.ordem === "number" ? (r.ordem as number) : 999,
      origemSemaforo: "padrão",
    });
  }
  return out;
}
