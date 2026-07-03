/**
 * VISÕES DOS PARES CVM — TRI · ANO · LTM, com a convenção de mercado para rentabilidade.
 *
 * - TRI  = DRE do trimestre isolado + BP do fim do trimestre (prazos na base de 90 dias).
 * - ANO  = DRE do exercício (DFP) + BP de 31/12 (base 365).
 * - LTM  = soma dos 4 últimos trimestres DISCRETOS + BP do fim da janela (base 365).
 *          4T discreto = DFP do ano − acumulado do 3T (a CVM não publica o 4T isolado).
 *
 * RENTABILIDADE (regra do usuário + prática de mercado): retorno de janela curta sobre
 * estoque de balanço é incoerente (LL do tri ÷ PL do ano). Solução aplicada:
 * ROE/ROA/ROIC são SEMPRE calculados na visão LTM — LL dos últimos 12 meses sobre
 * PATRIMÔNIO/ATIVO MÉDIO (média entre o fim da janela e 12 meses antes; sem o BP
 * anterior, usa o final e marca a base). Nas visões TRI e ANO esses indicadores
 * REPLICAM o valor LTM (comparável e coerente em qualquer visão).
 */
import type { BPLineItem, DRELineItem, Indicador } from "../types/financial";
import { calculateIndicators } from "./indicator-calculator";
import { CVM_BP_CLASSIF, CVM_BP_NIVEL } from "./cvm-map";
import type { CvmEmpresa, CvmPeriodoDados } from "./cvm-ingest";

export type VisaoCvm = "TRI" | "ANO" | "LTM";

/** Indicadores que só fazem sentido em base 12 meses (fluxo × estoque): retornos,
 *  giro, alavancagem sobre EBITDA e os scores de solvência (EBIT/LL trimestral sobre
 *  balanço integral subestimaria Altman/Kanitz). */
const INDICADORES_LTM_ONLY = new Set([
  "ROE (Retorno sobre Patrimônio Líquido)",
  "ROA (Retorno sobre Ativos)",
  "ROA (Giro × Margem)",
  "ROIC (Retorno sobre Capital Investido)",
  "Giro do Ativo",
  "Dívida Líquida/EBITDA",
  "Índice de Cobertura de Juros",
  "Termômetro de Kanitz",
  "Altman Z-Score (EM)",
]);

const rotulo = (dtFim: string) => { const [a, m, d] = dtFim.split("-"); return `${d}/${m}/${a}`; };

function somaDre(parcelas: Array<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of parcelas) for (const [c, v] of Object.entries(p)) out[c] = (out[c] ?? 0) + v;
  return out;
}

function subtraiDre(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [c, v] of Object.entries(b)) out[c] = (out[c] ?? 0) - v;
  return out;
}

/** Fim do trimestre anterior a uma data de fim de trimestre (AAAA-MM-DD). */
export function triAnterior(dtFim: string): string {
  const mapa: Record<string, string> = { "03-31": "12-31", "06-30": "03-31", "09-30": "06-30", "12-31": "09-30" };
  const [ano, resto] = [dtFim.slice(0, 4), dtFim.slice(5)];
  const ant = mapa[resto];
  if (!ant) return dtFim;
  return resto === "03-31" ? `${Number(ano) - 1}-${ant}` : `${ano}-${ant}`;
}

/** DRE DISCRETA do trimestre que termina em dtFim.
 *  ATENÇÃO ao fechamento (31/12): a CVM NÃO publica o 4T isolado — no DFP o dreTri é
 *  o ANO inteiro. O 4T é SEMPRE derivado por diferença (acumulado 12M − acumulado 3T);
 *  sem o 3T disponível, retorna null (honesto — nunca usa o ano como se fosse tri). */
export function dreTrimestre(emp: CvmEmpresa, dtFim: string): Record<string, number> | null {
  const per = emp.periodos[dtFim];
  if (!per) return null;
  const fechamento = dtFim.endsWith("12-31");
  if (Object.keys(per.dreYtd).length >= 3) {
    if (dtFim.slice(5) === "03-31") return per.dreYtd; // 1T: acumulado = trimestre
    // 2T/3T/4T: PREFERIR a diferença de acumulados — só o YTD carrega D&A/EBITDA
    // (vêm do DFC, que a CVM publica apenas acumulado) e os subtotais oficiais;
    // e trimestres por diferença telescopam exato no LTM.
    const ant = emp.periodos[triAnterior(dtFim)];
    if (ant && Object.keys(ant.dreYtd).length >= 3) return subtraiDre(per.dreYtd, ant.dreYtd);
  }
  if (!fechamento && Object.keys(per.dreTri).length >= 3) return per.dreTri; // fallback: isolado da fonte
  return null;
}

/** DRE LTM: soma dos 4 trimestres discretos que terminam em dtFim. */
export function dreLtm(emp: CvmEmpresa, dtFim: string): Record<string, number> | null {
  const parcelas: Array<Record<string, number>> = [];
  let dt = dtFim;
  for (let i = 0; i < 4; i++) {
    const tri = dreTrimestre(emp, dt);
    if (!tri) return null; // janela incompleta → sem LTM (honesto, não estima)
    parcelas.push(tri);
    dt = triAnterior(dt);
  }
  return somaDre(parcelas);
}

function toLineItems(bp: Record<string, number>, dre: Record<string, number>, label: string): { bp: BPLineItem[]; dre: DRELineItem[] } {
  return {
    bp: Object.entries(bp).map(([conta, v]) => ({
      conta, classificacao: CVM_BP_CLASSIF[conta] ?? "AF", nivel: CVM_BP_NIVEL[conta] ?? 2, editado: false, valores: { [label]: v },
    })),
    dre: Object.entries(dre).map(([conta, v]) => ({ conta, subtotal: false, editado: false, valores: { [label]: v } })),
  };
}

export interface IndicadoresVisao { visao: VisaoCvm; dtFim: string; indicadores: Indicador[] }

/**
 * Calcula os indicadores de UMA visão para a empresa/período — MESMO motor do IBR.
 * `diasBase` controla os prazos (90 no TRI; 365 no ANO/LTM).
 */
function calculaVisao(bp: Record<string, number>, dre: Record<string, number>, label: string, diasBase: number): Indicador[] {
  const { bp: bpItems, dre: dreItems } = toLineItems(bp, dre, label);
  return calculateIndicators(bpItems, dreItems, [label], undefined, diasBase);
}

/** Média de uma conta do BP entre o fim da janela e 12 meses antes (se existir). */
function mediaBP(emp: CvmEmpresa, dtFim: string, conta: string): { valor: number; base: "media" | "final" } | null {
  const fim = emp.periodos[dtFim]?.bp?.[conta];
  if (fim === undefined) return null;
  let dtAnt = dtFim;
  for (let i = 0; i < 4; i++) dtAnt = triAnterior(dtAnt);
  const ini = emp.periodos[dtAnt]?.bp?.[conta];
  if (ini === undefined) return { valor: fim, base: "final" };
  return { valor: (fim + ini) / 2, base: "media" };
}

/**
 * Indicadores completos das TRÊS visões para (empresa, dtFim).
 * Rentabilidade/giro/alavancagem-fluxo: SEMPRE da LTM com estoque MÉDIO — replicada
 * nas visões TRI e ANO para nunca exibir um retorno incoerente.
 */
export function indicadoresDaEmpresa(emp: CvmEmpresa, dtFim: string): IndicadoresVisao[] {
  const per = emp.periodos[dtFim];
  if (!per || Object.keys(per.bp).length < 4) return [];
  const label = rotulo(dtFim);
  const out: IndicadoresVisao[] = [];

  const triDre = dreTrimestre(emp, dtFim);
  const ltmDre = dreLtm(emp, dtFim);
  const ehFechamento = dtFim.endsWith("12-31");

  // LTM primeiro (fonte da rentabilidade das demais visões)
  let ltmInds: Indicador[] | null = null;
  if (ltmDre) {
    ltmInds = calculaVisao(per.bp, ltmDre, label, 365);
    // Rentabilidade sobre ESTOQUE MÉDIO (prática de mercado) — o LL vem do motor.
    const llMotor = ltmInds.find((i) => i.nome === "Lucro Líquido")?.valores[label];
    const pl = mediaBP(emp, dtFim, "Patrimônio Líquido");
    const at = mediaBP(emp, dtFim, "Ativo Total");
    if (typeof llMotor === "number") {
      const roe = ltmInds.find((i) => i.nome === "ROE (Retorno sobre Patrimônio Líquido)");
      if (roe && pl && pl.valor !== 0) { roe.valores[label] = llMotor / Math.abs(pl.valor); roe.formula += ` — LTM sobre PL ${pl.base === "media" ? "médio" : "final"}`; }
      const roa = ltmInds.find((i) => i.nome === "ROA (Retorno sobre Ativos)");
      if (roa && at && at.valor !== 0) { roa.valores[label] = llMotor / at.valor; roa.formula += ` — LTM sobre ativo ${at.base === "media" ? "médio" : "final"}`; }
    }
    out.push({ visao: "LTM", dtFim, indicadores: ltmInds });
  }

  const injetaLtmOnly = (inds: Indicador[]) => {
    if (!ltmInds) return inds;
    for (const nome of INDICADORES_LTM_ONLY) {
      const alvo = inds.find((i) => i.nome === nome);
      const fonte = ltmInds.find((i) => i.nome === nome);
      if (alvo && fonte) { alvo.valores = { ...fonte.valores }; alvo.status = { ...fonte.status }; alvo.formula = fonte.formula; }
    }
    return inds;
  };

  if (triDre) out.push({ visao: "TRI", dtFim, indicadores: injetaLtmOnly(calculaVisao(per.bp, triDre, label, 90)) });
  if (ehFechamento && Object.keys(per.dreYtd).length >= 3) {
    out.push({ visao: "ANO", dtFim, indicadores: injetaLtmOnly(calculaVisao(per.bp, per.dreYtd, label, 365)) });
  }
  return out;
}

/** Une períodos de várias fontes (ITR de vários anos + DFP) numa única CvmEmpresa. */
export function mesclaEmpresas(mapas: Array<Map<string, CvmEmpresa>>): Map<string, CvmEmpresa> {
  const out = new Map<string, CvmEmpresa>();
  for (const mapa of mapas) {
    for (const emp of mapa.values()) {
      const ex = out.get(emp.cnpj);
      if (!ex) { out.set(emp.cnpj, { ...emp, periodos: { ...emp.periodos } }); continue; }
      for (const [dt, dados] of Object.entries(emp.periodos)) {
        if (!ex.periodos[dt]) { ex.periodos[dt] = dados; continue; }
        // mescla campo a campo (DFP e ITR podem trazer visões complementares do mesmo dtFim)
        ex.periodos[dt] = {
          bp: { ...ex.periodos[dt].bp, ...dados.bp },
          dreTri: { ...ex.periodos[dt].dreTri, ...dados.dreTri },
          dreYtd: { ...ex.periodos[dt].dreYtd, ...dados.dreYtd },
          dfcYtd: { ...ex.periodos[dt].dfcYtd, ...dados.dfcYtd },
        };
      }
    }
  }
  return out;
}
