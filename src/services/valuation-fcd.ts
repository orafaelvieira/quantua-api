/**
 * Valuation FCD no BACKEND — mesmo cálculo da aba Valuation do front
 * (quantua-app/src/app/pages/models/valuation.ts), reduzido ao que a simulação
 * de Monte Carlo precisa: EV e Equity de um ResultadoModelo.
 *
 *   FCFF mensal = (EBIT − IR/CSLL) + D&A − capex ± variação de giro,
 *   onde a variação de giro sai por RESÍDUO do FCO (inclui outros itens);
 *   desconto mensal (1+WACC)^(1/12) − 1; perpetuidade de Gordon sobre o FCFF
 *   dos últimos 12 meses; ponte EV + caixa − dívida da data-base = Equity.
 *
 * Se mudar a matemática aqui, mudar TAMBÉM no front (e vice-versa).
 */
import type { ResultadoModelo, Serie } from "./model-engine";

export interface ParamsFcd {
  wacc: number;
  taxaImpostos: number;
  caixaDataBase: number;
  g: number;
  /** DLOM sobre o Equity (0.25 = 25%); default 0. */
  dlom?: number;
}

export interface ValorFcd {
  ok: boolean;
  motivo?: string;
  ev: number;
  equity: number;
  /** Equity após DLOM (igual ao equity quando dlom = 0). */
  equityFinal: number;
}

export function equityFcd(resultado: ResultadoModelo, p: ParamsFcd): ValorFcd {
  const meses = resultado.meses;
  const s = resultado.series;
  const falha = (motivo: string): ValorFcd => ({ ok: false, motivo, ev: 0, equity: 0, equityFinal: 0 });
  if (!meses.length || !s["fc_fco"]) return falha("Fluxo de caixa não calculado (recalcule o modelo).");
  if (p.wacc <= 0) return falha("WACC precisa ser positivo.");
  if (p.g >= p.wacc) return falha("g precisa ser MENOR que o WACC (Gordon não converge).");

  const wm = Math.pow(1 + p.wacc, 1 / 12) - 1;
  const ebitMes = (resultado.dre.find((l) => l.id === "ebit") ?? resultado.dre.find((l) => l.id === "ebitda"))?.valores ?? {};
  const resMes = resultado.fc.find((l) => l.id === "fc-resultado")?.valores ?? {};

  const fcffMes: Serie = {};
  let vpFluxos = 0;
  for (let i = 0; i < meses.length; i++) {
    const m = meses[i];
    const ebit = ebitMes[m] ?? 0;
    const ir = s["irpj_csll_total"]?.[m] ?? 0;
    const da = s["depreciacao_total"]?.[m] ?? 0;
    const capex = s["capex_total"]?.[m] ?? 0;
    const varGiro = (s["fc_fco"][m] ?? 0) - (resMes[m] ?? 0) - da;
    const fcff = (ebit - ir) + da - capex + varGiro;
    fcffMes[m] = fcff;
    vpFluxos += fcff / Math.pow(1 + wm, i + 1);
  }

  const ult12 = meses.slice(-12);
  const somaUlt12 = ult12.reduce((sm, m) => sm + (fcffMes[m] ?? 0), 0);
  const fcffUltimos12m = ult12.length === 12 ? somaUlt12 : (somaUlt12 / Math.max(1, ult12.length)) * 12;
  const valorTerminal = (fcffUltimos12m * (1 + p.g)) / (p.wacc - p.g);
  const vpValorTerminal = valorTerminal / Math.pow(1 + wm, meses.length);

  const ev = vpFluxos + vpValorTerminal;
  const m1 = meses[0];
  const dividaDataBase = s["divida_total"]
    ? (s["divida_total"][m1] ?? 0) - (s["captacao_divida_total"]?.[m1] ?? 0) + (s["amortizacao_divida_total"]?.[m1] ?? 0)
    : 0;
  const equity = ev + Math.max(0, p.caixaDataBase) - dividaDataBase;
  const dlom = Math.min(0.9, Math.max(0, p.dlom ?? 0));
  return { ok: true, ev, equity, equityFinal: equity * (1 - dlom) };
}
