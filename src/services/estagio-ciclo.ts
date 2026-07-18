/**
 * ESTÁGIO DO CICLO DE VIDA — motor determinístico em DOIS EIXOS (metodologia própria
 * Quantua, ancorada em literatura consagrada):
 *
 *   EIXO 1 — ESTÁGIO (direção do negócio): sinais de FCO/FCI/FCF do FC indireto,
 *   Dickinson (2011), com dois reforços contra ruído de ano único:
 *     · MATERIALIDADE: fluxo com módulo < 1% da receita do período conta como NEUTRO
 *       (um FCI de R$ 25 mil numa receita de R$ 26 milhões não é "desinvestimento");
 *     · PERSISTÊNCIA: com 2 colunas de FC provadas, o Dickinson só decide sozinho se
 *       AMBAS apontam o mesmo estágio; divergência = transição → decide a tendência
 *       multi-ano de receita/margem (a própria Dickinson classifica firm-years e a
 *       literatura posterior recomenda persistência para rotular a FIRMA).
 *
 *   EIXO 2 — SOLIDEZ FINANCEIRA (força da estrutura): score do trio de solvência
 *   já calculado pelo motor — Fleuriet (estrutura de giro), Kanitz (solvência de
 *   curto prazo) e Altman Z''-EM (sustentação econômica) — 0 a 2 pontos cada,
 *   com tendência vs o período anterior. Análogo determinístico da separação
 *   business profile × financial profile das agências de rating: o estágio diz a
 *   DIREÇÃO, a solidez diz com que FÔLEGO — eixos ortogonais (existe "Crescimento
 *   frágil" e "Declínio sólido").
 *
 * "Verde só com prova": Dickinson só usa coluna cuja prova de fechamento FECHA.
 * Rótulo estável entre regerações; a IA recebe os dois eixos como FATO e só narra.
 */

export interface FluxoCaixaLite {
  colunas: string[];
  totais: { fco: Record<string, number>; fci: Record<string, number>; fcf: Record<string, number> };
  prova?: Array<{ periodo: string; fecha: boolean }>;
}

export interface SolidezResult {
  nivel: "sólida" | "intermediária" | "frágil";
  /** Pontos obtidos / máximo possível (2 por componente disponível). */
  score: number;
  max: number;
  tendencia: "melhorando" | "estável" | "deteriorando" | null;
  /** Legível para o relatório: ["Estrutura de giro (Fleuriet): Insuficiente", …] */
  componentes: string[];
}

export interface EstagioResult {
  estagio: string;
  justificativa: string;
  /** Eixo 2 — presente sempre que o trio de solvência estiver calculado. */
  solidez?: SolidezResult;
}

interface IndicadorLite {
  nome: string;
  valores: Record<string, number | string | null>;
  status?: Record<string, "ok" | "atencao" | "critico" | null>;
}

const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function ordPeriodo(p: string): number {
  const m = p.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return Number(`${m[3]}${m[2]}${m[1]}`);
  const y = p.match(/20\d{2}/);
  return y ? Number(`${y[0]}0000`) : 0;
}

/** Renomeações históricas (IBRs antigos guardam o nome anterior). */
const ALIAS: Record<string, string[]> = {
  "Situação de Liquidez (Fleuriet)": ["Situação da empresa"],
  "Margem EBITDA": ["Margem Operacional"],
};
function acha(indicadores: IndicadorLite[], nome: string): IndicadorLite | undefined {
  return indicadores.find((i) => i.nome === nome)
    ?? (ALIAS[nome] ? indicadores.find((i) => ALIAS[nome].includes(i.nome)) : undefined);
}

/* ───────────────────────── EIXO 2 — SOLIDEZ (trio de solvência) ───────────────────────── */

function pontosFleuriet(v: unknown): { pts: number; rotulo: string } | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.toLowerCase();
  if (s.includes("excelente") || s.includes("sólida") || s.includes("solida")) return { pts: 2, rotulo: v };
  if (s.includes("insuficiente")) return { pts: 1, rotulo: v };
  if (s.includes("muito ruim") || s.includes("alto risco")) return { pts: 0, rotulo: v };
  return null; // indefinida → não pontua
}
function pontosKanitz(v: number): { pts: number; rotulo: string } {
  if (v > 0) return { pts: 2, rotulo: "solvente" };
  if (v >= -3) return { pts: 1, rotulo: "zona de penumbra" };
  return { pts: 0, rotulo: "risco de insolvência" };
}
function pontosAltman(v: number): { pts: number; rotulo: string } {
  if (v > 2.6) return { pts: 2, rotulo: "zona segura" };
  if (v >= 1.1) return { pts: 1, rotulo: "zona cinzenta" };
  return { pts: 0, rotulo: "zona de perigo" };
}

/** Score de solidez em um período: soma dos componentes disponíveis (2 pts cada).
 *  LEITOR = DONO DA EMPRESA: cada componente é escrito com o SIGNIFICADO na frente
 *  e o nome técnico entre parênteses no fim (o analista continua rastreando a
 *  fonte, o dono entende sem dicionário). */
function solidezEm(indicadores: IndicadorLite[], p: string): { score: number; max: number; componentes: string[] } | null {
  const fmtN = (v: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let score = 0, max = 0;
  const componentes: string[] = [];

  const fle = pontosFleuriet(acha(indicadores, "Situação de Liquidez (Fleuriet)")?.valores[p]);
  if (fle) {
    score += fle.pts; max += 2;
    componentes.push(`Como a operação se financia: ${fle.rotulo.toLowerCase()} — mede se as vendas do dia a dia se sustentam sozinhas ou dependem de dinheiro de curto prazo, como cheque especial e antecipação de recebíveis (estrutura de giro, método Fleuriet)`);
  }

  const kan = numOf(acha(indicadores, "Termômetro de Kanitz")?.valores[p]);
  if (kan != null) {
    const r = pontosKanitz(kan); score += r.pts; max += 2;
    componentes.push(`Risco de não conseguir pagar as contas: ${r.rotulo} — nota que junta lucro, folga de caixa e endividamento para estimar esse risco; acima de zero é confortável (termômetro de Kanitz: ${fmtN(kan)})`);
  }

  const alt = numOf(acha(indicadores, "Altman Z-Score (EM)")?.valores[p]);
  if (alt != null) {
    const r = pontosAltman(alt); score += r.pts; max += 2;
    componentes.push(`Nota de solidez usada por bancos e investidores: ${r.rotulo} — quanto maior, menor a chance de a empresa quebrar; acima de 2,6 é zona segura (Altman Z-Score: ${fmtN(alt)})`);
  }

  return max > 0 ? { score, max, componentes } : null;
}

/** Solidez do período mais recente + tendência vs o anterior. */
export function avaliarSolidez(indicadores: IndicadorLite[], periodos: string[]): SolidezResult | null {
  const ord = [...periodos].sort((a, b) => ordPeriodo(a) - ordPeriodo(b));
  const ult = ord[ord.length - 1];
  if (!ult) return null;
  const atual = solidezEm(indicadores, ult);
  if (!atual) return null;
  const frac = atual.score / atual.max;
  const nivel: SolidezResult["nivel"] = frac >= 0.75 ? "sólida" : frac >= 0.4 ? "intermediária" : "frágil";

  let tendencia: SolidezResult["tendencia"] = null;
  const ant = ord.length >= 2 ? solidezEm(indicadores, ord[ord.length - 2]) : null;
  if (ant && ant.max === atual.max) {
    tendencia = atual.score > ant.score ? "melhorando" : atual.score < ant.score ? "deteriorando" : "estável";
  }
  return { nivel, score: atual.score, max: atual.max, tendencia, componentes: atual.componentes };
}

/* ───────────────────────── EIXO 1 — ESTÁGIO (Dickinson robusto) ───────────────────────── */

type Sig = -1 | 0 | 1;
const sigDe = (v: number, eps: number): Sig => (Math.abs(v) <= eps ? 0 : v > 0 ? 1 : -1);

/** R$ em linguagem de gente: "R$ 4,0 milhões", "R$ 25 mil". */
function reais(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `R$ ${(a / 1_000_000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${a >= 2_000_000 ? "milhões" : "milhão"}`;
  if (a >= 1_000) return `R$ ${Math.round(a / 1_000).toLocaleString("pt-BR")} mil`;
  return `R$ ${Math.round(a).toLocaleString("pt-BR")}`;
}

/** Estágio Dickinson de UMA coluna, com sinais já filtrados por materialidade.
 *  null = combinação ambígua (decide a heurística multi-ano). Exportada p/ teste. */
export function estagioDickinsonDe(fco: Sig, fci: Sig, fcf: Sig): string | null {
  if (fco > 0 && fci < 0 && fcf > 0) return "Crescimento";
  if (fco < 0 && fci < 0 && fcf > 0) return "Crescimento";
  if (fco > 0 && fci < 0 && fcf <= 0) return "Maturidade";
  if (fco > 0 && fci === 0 && fcf <= 0) return "Maturidade"; // gera caixa, não investe, devolve capital
  if (fco > 0 && fci > 0) return "Platô";                    // desinveste DE VERDADE (fci material)
  if (fco < 0 && fci > 0) return "Declínio";                 // vende ativo p/ cobrir queima
  if (fco < 0 && fci <= 0 && fcf < 0) return "Declínio";     // consome caixa em todas as frentes
  return null; // fco≈0 ou padrões sem leitura segura
}

/** Descrição leiga dos fluxos de uma coluna ("a operação gerou R$ 4,0 milhões…"). */
function narrarFluxos(fco: number, fci: number, fcf: number, eps: number, col: string): string {
  const op = Math.abs(fco) <= eps ? "a operação ficou no zero a zero de caixa"
    : fco > 0 ? `a operação gerou ${reais(fco)} de caixa` : `a operação consumiu ${reais(fco)} de caixa`;
  const inv = Math.abs(fci) <= eps ? "praticamente não houve investimento"
    : fci < 0 ? `os investimentos usaram ${reais(fci)}` : `a venda/resgate de ativos devolveu ${reais(fci)}`;
  const fin = Math.abs(fcf) <= eps ? "sem movimento relevante com sócios e credores"
    : fcf < 0 ? `${reais(fcf)} saíram para sócios e credores` : `entraram ${reais(fcf)} de captações/aportes`;
  return `Em ${col}, ${op}, ${inv} e ${fin}.`;
}

/**
 * Classifica o estágio (eixo 1) e anexa a solidez (eixo 2). Regra em ordem — o
 * primeiro que casa vence; rótulo entre: Crise de caixa | Crescimento | Maturidade |
 * Platô | Declínio. Retorna null com < 2 períodos (sem base para tendência).
 */
export function classifyEstagio(indicadores: IndicadorLite[], periodos: string[], fluxoCaixa?: FluxoCaixaLite | null): EstagioResult | null {
  const ord = [...periodos].sort((a, b) => ordPeriodo(a) - ordPeriodo(b));
  if (ord.length < 2) return null; // período insuficiente p/ tendência
  const val = (nome: string, p: string): number | null => { const i = acha(indicadores, nome); return i ? numOf(i.valores[p]) : null; };
  const ult = ord[ord.length - 1];

  const receita = ord.map((p) => val("Receita Líquida", p)).filter((x): x is number => x != null);
  const margemOp = val("Margem EBITDA", ult);
  const liqCorr = val("Liquidez Corrente", ult);
  const liqImed = val("Liquidez Imediata", ult);
  const pct = (r: number) => `${(r * 100).toFixed(0)}%`;

  const solidez = avaliarSolidez(indicadores, ord) ?? undefined;
  const com = (r: Omit<EstagioResult, "solidez">): EstagioResult => ({ ...r, ...(solidez ? { solidez } : {}) });

  // 1) CRISE DE CAIXA — aperto agudo manda, independentemente da tendência.
  const margemNeg = margemOp != null && margemOp < 0;
  const liqBaixa = liqCorr != null && liqCorr < 1;
  const caixaMinimo = liqImed != null && liqImed < 0.05;
  // (b) NOVO: trio de solvência em fundo de poço (score ≤ 25% do máximo) + caixa no
  // mínimo também é crise, mesmo com margem positiva — a estrutura já cedeu.
  const solvenciaColapsada = solidez != null && solidez.max >= 4 && solidez.score / solidez.max <= 0.25;
  if ((margemNeg && liqBaixa) || (margemNeg && caixaMinimo) || (solvenciaColapsada && caixaMinimo)) {
    // LEITOR = DONO: cada indicador vira uma frase que se explica sozinha. Números
    // em formato brasileiro (o toFixed antigo imprimia "0.01" com ponto).
    const num = (v: number, casas: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
    const partes = [
      liqCorr != null
        ? `para cada R$ 1,00 que vence no curto prazo a empresa tem apenas R$ ${num(liqCorr, 2)} em bens e direitos de curto prazo para cobrir (liquidez corrente de ${num(liqCorr, 2)})`
        : null,
      liqImed != null
        ? `o dinheiro disponível hoje cobre só ${num(liqImed * 100, 1)}% dessas contas (liquidez imediata)`
        : null,
      margemOp != null && margemOp < 0
        ? `a operação opera no vermelho, gastando mais do que fatura (margem operacional de ${pct(margemOp)})`
        : margemOp != null
        ? `a operação em si ainda dá resultado, com margem operacional de ${pct(margemOp)}`
        : null,
      solvenciaColapsada ? "e os três termômetros de solvência estão no nível crítico" : null,
    ].filter(Boolean).join("; ");
    return com({
      estagio: "Crise de caixa",
      justificativa: `A empresa está sem fôlego de caixa: ${partes}. Na prática, falta dinheiro disponível para honrar os compromissos que vencem nos próximos meses.`,
    });
  }

  // 2) DICKINSON com MATERIALIDADE + PERSISTÊNCIA sobre as colunas PROVADAS.
  const cols = fluxoCaixa?.colunas ?? [];
  const fecha = (c: string) => (fluxoCaixa?.prova ?? []).some((p) => p.periodo === c && p.fecha);
  const colRecente = cols.length > 0 ? cols[cols.length - 1] : null;
  const recenteOk = colRecente != null && fecha(colRecente);

  const epsDe = (c: string) => { const r = val("Receita Líquida", c); return r != null && r > 0 ? 0.01 * r : 0; };
  const leitura = (c: string) => {
    const fco = fluxoCaixa!.totais.fco[c] ?? 0;
    const fci = fluxoCaixa!.totais.fci[c] ?? 0;
    const fcf = fluxoCaixa!.totais.fcf[c] ?? 0;
    const eps = epsDe(c);
    return { fco, fci, fcf, eps, estagio: estagioDickinsonDe(sigDe(fco, eps), sigDe(fci, eps), sigDe(fcf, eps)) };
  };

  // "Verde só com prova" vale para a coluna que os sinais usam (a mais recente); a
  // persistência considera também a coluna anterior QUANDO provada.
  if (fluxoCaixa && recenteOk) {
    const rec = leitura(colRecente!);
    const colAnt = cols.length >= 2 ? cols[cols.length - 2] : null;
    const antOk = colAnt != null && fecha(colAnt);
    const ant = antOk ? leitura(colAnt!) : null;

    const EXPLICA: Record<string, string> = {
      "Crescimento": "padrão de crescimento: o negócio expande e atrai recursos para acelerar",
      "Maturidade": "padrão maduro: a própria operação sustenta a empresa e ainda remunera sócios e credores",
      "Platô": "padrão de acomodação: gera caixa mas desfaz posições, sem novas frentes de crescimento",
      "Declínio": "padrão de declínio: a operação não se sustenta sozinha",
    };
    if (rec.estagio && (!ant || !ant.estagio || ant.estagio === rec.estagio)) {
      // Sem coluna anterior provada, ou padrão CONSISTENTE nos dois anos → Dickinson decide.
      const persistencia = ant?.estagio === rec.estagio ? ` O mesmo padrão se repete em ${colAnt} — leitura consistente.` : "";
      return com({
        estagio: rec.estagio,
        justificativa: `${narrarFluxos(rec.fco, rec.fci, rec.fcf, rec.eps, colRecente!)} ${EXPLICA[rec.estagio] ?? ""} (classificação pelos sinais do fluxo de caixa, método Dickinson).${persistencia}`,
      });
    }
    if (rec.estagio && ant?.estagio && ant.estagio !== rec.estagio) {
      // TRANSIÇÃO (anos divergem): a tendência multi-ano decide; sinais só narram.
      const porTendencia = porReceitaMargem();
      if (porTendencia) {
        return com({
          estagio: porTendencia.estagio,
          justificativa: `${porTendencia.justificativa} Os sinais do fluxo de caixa mudaram entre os anos (${colAnt}: ${ant.estagio.toLowerCase()}; ${colRecente}: ${rec.estagio.toLowerCase()}) — transição em curso; um ano isolado não define o estágio.${solidez?.tendencia === "deteriorando" ? " A solidez financeira vem se deteriorando, o que pede atenção ao caixa nesta transição." : ""}`,
        });
      }
    }
    // rec ambíguo → heurística abaixo
  }

  // 3) Fallback: tendência de RECEITA/MARGEM no histórico completo.
  const fallback = porReceitaMargem();
  return fallback ? com(fallback) : null;

  function porReceitaMargem(): Omit<EstagioResult, "solidez"> | null {
    if (receita.length < 2) return null;
    const first = receita[0], last = receita[receita.length - 1], n = receita.length;
    const cresc = first !== 0 ? (last - first) / Math.abs(first) : 0;
    const quedaUlt = receita[n - 1] < receita[n - 2] && (n < 3 || receita[n - 2] <= receita[n - 3]);
    const cresceUlt = receita[n - 1] > receita[n - 2] && (n < 3 || receita[n - 2] >= receita[n - 3]);
    const margemPos = margemOp != null && margemOp > 0;
    const crescUltAno = receita[n - 2] !== 0 ? (receita[n - 1] - receita[n - 2]) / Math.abs(receita[n - 2]) : 0;

    // Frases que se explicam sozinhas: o que aconteceu com o faturamento e o que
    // isso significa, sem exigir que o leitor saiba o que é "margem operacional".
    if (quedaUlt || cresc < -0.1) return { estagio: "Declínio", justificativa: `O faturamento vem encolhendo ao longo do período analisado, ${pct(cresc)} no acumulado, mas sem aperto agudo de caixa por enquanto: a empresa ainda consegue pagar suas contas, e o problema está em vender menos a cada ano.` };
    if (cresceUlt && crescUltAno > 0.15 && margemPos) return { estagio: "Crescimento", justificativa: `O faturamento está em expansão, com alta de ${pct(crescUltAno)} no último ano, e a operação fecha no azul: o que sobra das vendas depois de custos e despesas do dia a dia é positivo.` };
    if (Math.abs(cresc) <= 0.1 && margemPos && (liqCorr == null || liqCorr >= 1)) return { estagio: "Maturidade", justificativa: `O faturamento se manteve estável no período, variação de ${pct(cresc)}, a operação fecha no azul e a empresa tem folga para pagar as contas de curto prazo.` };
    return { estagio: "Platô", justificativa: `O faturamento está praticamente parado, variação de ${pct(cresc)} no período, sem sinal claro de crescimento nem de queda, e sem aperto de caixa: a empresa se mantém, mas não avança.` };
  }
}
