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
 *   frágil" e "Retração sólida").
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
  /** O QUE DEFINE O FÔLEGO, com todas as letras: a pontuação nos testes de
   *  estrutura e a régua que separa sólida/intermediária/frágil. É o que o
   *  quadro de Fôlego abre — o leitor tem de saber por que está nessa coluna. */
  oQueDefine: string;
  /** Legível para o relatório: ["Estrutura de giro (Fleuriet): Insuficiente", …] */
  componentes: string[];
  /** Os testes que DE FATO entraram no placar, na ordem. Fica gravado no
   *  resultado para o app não precisar deduzi-los pela ordem canônica — dedução
   *  que publicava o nome errado quando o teste ausente não era o último. */
  testes: string[];
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
  if (v >= -3) return { pts: 1, rotulo: "zona de alerta" };
  return { pts: 0, rotulo: "risco elevado" };
}
function pontosAltman(v: number): { pts: number; rotulo: string } {
  if (v > 2.6) return { pts: 2, rotulo: "zona segura" };
  if (v >= 1.1) return { pts: 1, rotulo: "zona cinzenta" };
  return { pts: 0, rotulo: "zona de atenção elevada" };
}

/** Score de solidez em um período: soma dos componentes disponíveis (2 pts cada).
 *  LEITOR = DONO DA EMPRESA: cada componente é escrito com o SIGNIFICADO na frente
 *  e o nome técnico entre parênteses no fim (o analista continua rastreando a
 *  fonte, o dono entende sem dicionário). */
function solidezEm(indicadores: IndicadorLite[], p: string): { score: number; max: number; componentes: string[]; testes: string[] } | null {
  const fmtN = (v: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let score = 0, max = 0;
  const componentes: string[] = [];
  // Os NOMES dos testes que de fato entraram: a frase "o que define o fôlego"
  // listava os três sempre, e com Fleuriet "Indefinida" publicava "passa por 2
  // testes (capital de giro, solvência e risco de insolvência)" — dois testes,
  // três nomes, e o de capital de giro não tinha sido aplicado.
  const testes: string[] = [];

  // Cada componente = UMA frase curta: o que o teste responde, seguido da
  // resposta. O texto longo anterior virava um parágrafo denso no cartão.
  const fle = pontosFleuriet(acha(indicadores, "Situação de Liquidez (Fleuriet)")?.valores[p]);
  if (fle) {
    score += fle.pts; max += 2; testes.push("capital de giro");
    const leitura = fle.pts === 2
      ? "as vendas do dia a dia se financiam sozinhas"
      : fle.pts === 1
      ? "as vendas do dia a dia dependem em parte de dinheiro de curto prazo"
      : "as vendas do dia a dia dependem de dinheiro de curto prazo, como cheque especial e antecipação de recebíveis";
    // Vírgula, não travessão: o saneador de fonte do PDF troca " — " por ", " e
    // a mesma frase saía diferente na tela e no documento.
    componentes.push(`A operação se financia sozinha? ${fle.pts === 2 ? "Sim" : "Não"}, ${leitura}.`);
  }

  const kan = numOf(acha(indicadores, "Termômetro de Kanitz")?.valores[p]);
  if (kan != null) {
    const r = pontosKanitz(kan); score += r.pts; max += 2; testes.push("solvência");
    const leitura = r.pts === 2
      ? "está em terreno confortável"
      : r.pts === 1
      ? "está no limite, sem margem para um mês ruim"
      : "está no nível que exige atenção imediata";
    componentes.push(`Consegue honrar os compromissos? A nota que combina lucro, folga de caixa e endividamento ${leitura}.`);
  }

  const alt = numOf(acha(indicadores, "Altman Z-Score (EM)")?.valores[p]);
  if (alt != null) {
    const r = pontosAltman(alt); score += r.pts; max += 2; testes.push("risco de insolvência");
    const leitura = r.pts === 2
      ? "tem folga para atravessar um período ruim"
      : r.pts === 1
      ? "tem pouca folga para atravessar um período ruim"
      : "tem pouca margem para absorver um período ruim";
    componentes.push(`Como um banco enxergaria a empresa? Pela nota que eles usam, ela ${leitura} (${fmtN(alt)} numa escala em que acima de 2,6 é confortável).`);
  }

  return max > 0 ? { score, max, componentes, testes } : null;
}

const TODOS_OS_TESTES = ["capital de giro", "solvência", "risco de insolvência"];
const listaPt = (xs: string[]): string => xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} e ${xs[xs.length - 1]}`;

/** Cada componente abre com a pergunta do seu teste — é por ela que o acervo
 *  (gravado antes de `testes` existir) descobre QUAIS testes rodaram. Deduzir
 *  pela ordem canônica ("os n primeiros") publicava o nome errado sempre que o
 *  teste ausente não era o último: com Fleuriet indisponível, o texto afirmava
 *  ao credor que o capital de giro fora testado e que o Altman faltara. */
const PERGUNTA_DO_TESTE: Array<[RegExp, string]> = [
  [/^A opera[çc][ãa]o se financia sozinha\?/i, "capital de giro"],
  [/^Consegue honrar os compromissos\?/i, "solvência"],
  [/^Como um banco enxergaria a empresa\?/i, "risco de insolvência"],
];
export function testesDosComponentes(componentes?: string[] | null): string[] | null {
  if (!componentes || !componentes.length) return null;
  const nomes = componentes
    .map((c) => PERGUNTA_DO_TESTE.find(([re]) => re.test(c.trim()))?.[1])
    .filter((x): x is string => !!x);
  return nomes.length === componentes.length ? nomes : null;
}

/**
 * A FRASE DO GATILHO DA COLUNA, como função pura dos números (dono, 21/08/2026:
 * "deixar muito claro ao leitor o que levou a empresa a estar naquela coluna").
 * Exportada porque o app a reproduz para o acervo gravado antes desta frase
 * existir (score/max/tendência já estavam persistidos) — a bancada dos dois
 * lados prova que as duas cópias escrevem a mesma coisa.
 */
export function oQueDefineDaSolidez(x: { nivel: string; score: number; max: number; tendencia: string | null; testes?: string[]; componentes?: string[] | null }): string {
  const n = Math.round(x.max / 2);
  // Ordem da confiança: os nomes que o motor gravou > os nomes que as perguntas
  // dos componentes revelam > (só com os TRÊS testes) a lista canônica. Sem
  // nenhum dos três, o texto NÃO chuta nome: diz quantos testes couberam.
  const nomes = (x.testes && x.testes.length ? x.testes : testesDosComponentes(x.componentes))
    ?? (n === TODOS_OS_TESTES.length ? TODOS_OS_TESTES : null);
  const faltam = nomes ? TODOS_OS_TESTES.filter((t) => !nomes.includes(t)) : [];
  const fmtPts = (v: number) => v.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  const regua = x.nivel === "sólida"
    ? "é sólida quando soma pelo menos três quartos dos pontos"
    : x.nivel === "intermediária"
    ? "é intermediária quando fica entre 40% e três quartos dos pontos"
    : "é frágil quando fica abaixo de 40% dos pontos";
  const direcao = x.tendencia === "deteriorando" ? ", e piorou em relação ao período anterior"
    : x.tendencia === "melhorando" ? ", e melhorou em relação ao período anterior"
    : x.tendencia === "estável" ? ", sem mudança em relação ao período anterior"
    : "";
  const semNome = !nomes && n < TODOS_OS_TESTES.length;
  const ressalva = faltam.length
    ? ` ${faltam.length > 1 ? `Os testes de ${listaPt(faltam)} não puderam ser aplicados` : `O teste de ${listaPt(faltam)} não pôde ser aplicado`} com os dados deste período${n === 1 ? ", então o nível se apoia num único teste" : ""}.`
    : semNome
    ? ` Os demais testes não puderam ser aplicados com os dados deste período${n === 1 ? ", então o nível se apoia num único teste" : ""}.`
    : "";
  return (
    `O que define o fôlego financeiro: a estrutura da empresa passa por ${n} teste${n === 1 ? "" : "s"}${nomes ? ` (${listaPt(nomes)})` : " de estrutura"}, ` +
    `cada um valendo até 2 pontos, e somou ${fmtPts(x.score)} de ${x.max}${direcao}. A estrutura ${regua}.${ressalva}`
  );
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
  const oQueDefine = oQueDefineDaSolidez({ nivel, score: atual.score, max: atual.max, tendencia, testes: atual.testes, componentes: atual.componentes });
  return { nivel, score: atual.score, max: atual.max, tendencia, componentes: atual.componentes, testes: atual.testes, oQueDefine };
}

/* ───────────────────────── EIXO 1 — ESTÁGIO (Dickinson robusto) ───────────────────────── */

type Sig = -1 | 0 | 1;
const sigDe = (v: number, eps: number): Sig => (Math.abs(v) <= eps ? 0 : v > 0 ? 1 : -1);

/** "31/12/2025" → "2025"; "31/05/2026" → "05/2026"; "2024" → "2024". Nunca a data crua. */
function rotuloCurto(p: string): string {
  const m = p.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return m[2] === "12" ? m[3]! : `${m[2]}/${m[3]}`;
  return p.trim();
}

/** R$ em linguagem de gente: "R$ 4,0 milhões", "R$ 25 mil". */
function reais(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) {
    // O plural segue o número QUE VAI SAIR IMPRESSO, não o bruto: R$ 1.950.000
    // arredonda para "2,0" e saía "R$ 2,0 milhão".
    const m = Math.round(a / 100_000) / 10;
    return `R$ ${m.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${m >= 2 ? "milhões" : "milhão"}`;
  }
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
  if (fco < 0 && fci > 0) return "Retração";                 // vende ativo p/ cobrir queima
  if (fco < 0 && fci <= 0 && fcf < 0) return "Retração";     // consome caixa em todas as frentes
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
 * primeiro que casa vence; rótulo entre: Pressão de caixa | Crescimento | Maturidade |
 * Platô | Retração. Retorna null com < 2 períodos (sem base para tendência).
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
  const num = (v: number, casas: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });

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
    // LEITOR = DONO. A frase começa pela CONCLUSÃO (o que está acontecendo com o
    // negócio) e só depois cita o número que a sustenta — o inverso do texto
    // antigo, que abria com três índices seguidos e enterrava o significado.
    // Margem que ARREDONDA para 0,0% não é lucro nem prejuízo: dizer "resultado
    // operacional negativo (margem EBITDA de 0,0%)" é afirmar o que o número não
    // diz, e "sobram cerca de R$ 0" no ramo positivo é pior ainda.
    const margemZero = margemOp != null && Math.abs(margemOp) * 100 < 0.05;
    const operacaoVai = margemOp != null && margemOp > 0 && !margemZero;

    // A JANELA VAI DECLARADA (dono, 21/08/2026, "ajustes relatório ibr4"). O
    // texto dizia "a operação está gastando mais do que fatura" como se fosse
    // traço permanente — e três linhas abaixo o mesmo relatório lembrava que o
    // exercício fechado anterior teve EBITDA positivo e lucro. Quando a última
    // coluna é um acumulado parcial, a frase diz de que janela está falando;
    // a causa (sazonalidade × deterioração) não é determinável com esta base,
    // e cabe à leitura da situação cruzar com o exercício fechado.
    // "31/05/2026" OU o rótulo curto "05/2026", que existe no acervo como chave
    // de coluna de balancete (diasYTD e o fluxo de caixa já o aceitam). Sem
    // isso o acumulado de junho num acervo de rótulo curto era lido como traço
    // permanente — exatamente o que o dono apontou.
    const mAno = (() => {
      const longo = ult.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (longo) return { mes: longo[2]!, ano: longo[3]! };
      const curto = ult.match(/^(\d{2})\/(\d{4})$/);
      return curto ? { mes: curto[1]!, ano: curto[2]! } : null;
    })();
    const parcial = mAno !== null && Number(mAno.mes) < 12;
    // Capitaliza a frase inteira: sem janela, a abertura é o começo do parágrafo
    // e saía em minúscula ("a operação ainda não cobre…") em todo IBR cujo
    // último período é exercício fechado — a maioria do acervo.
    const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
    const janela = parcial ? `na janela de ${mAno!.ano} analisada (acumulado até ${mAno!.mes}/${mAno!.ano}), ` : "";

    // O ESTÁGIO É CURTO (dono, 21/08/2026, "ajustes relatório ibr4": "uma frase
    // curta explicando o estágio"). Fala da margem da janela e de mais nada —
    // liquidez corrente e imediata têm UM dono, o cartão da situação, onde a IA
    // as prova com a definição exata. Quando o motor as citava aqui e o prompt
    // mandava a IA prová-las ali, o mesmo número saía nos dois cartões, com a
    // mesma frase.
    const abertura = operacaoVai
      ? cap(`${janela}o negócio em si está saudável: de cada R$ 100 que a empresa fatura, sobra${
          margemOp! * 100 < 1 ? "m menos de R$ 1" : `m cerca de R$ ${num(margemOp! * 100, 0)}`
        } depois de pagar os custos e as despesas do dia a dia. O problema não está em vender nem em produzir, está no dinheiro em conta.`)
      : margemZero
      ? cap(`${janela}a operação empata: o que a empresa fatura cobre os custos e as despesas do dia a dia e não sobra nada (margem EBITDA de 0,0%).`)
      : margemOp != null
      ? cap(`${janela}a operação ainda não cobre integralmente os custos e as despesas: cada R$ 100 de receita deixam ${
          Math.abs(margemOp) * 100 < 1 ? "menos de R$ 1" : `cerca de R$ ${num(Math.abs(margemOp) * 100, 0)}`
        } de resultado operacional negativo (margem EBITDA de ${num(margemOp * 100, 1)}%).`)
      : cap(`${janela}a empresa está sem fôlego de caixa.`);

    // O QUE DEFINIU O ESTÁGIO, com todas as letras (dono, 21/08/2026: "deixar
    // muito claro ao leitor o que levou a empresa a estar naquela linha"). A
    // regra que disparou é declarada com os números DESTA empresa. A liquidez
    // aparece aqui como GATILHO (uma linha, sem definição longa); quem a define
    // e a desdobra é o quadro de fôlego.
    // Liquidez corrente que arredonda para 1,00 ainda é < 1 — a frase declara
    // a borda em vez de publicar "superam os ativos (liquidez corrente de 1,00)".
    const lcTxt = liqCorr != null ? num(liqCorr, 2) : "";
    const lcFrase = lcTxt === "1,00" ? "liquidez corrente logo abaixo de 1,00"
      : lcTxt === "0,00" ? "liquidez corrente abaixo de 0,01"
      : `liquidez corrente de ${lcTxt}`;
    // A liquidez imediata entra SÓ em %, com piso: "4,6% (liquidez imediata de
    // 0,05)" eram duas arredondagens do mesmo número na mesma frase.
    const liPct = liqImed != null ? (liqImed * 100 < 0.1 ? "menos de 0,1%" : `${num(liqImed * 100, 1)}%`) : "";
    const gatilhos: string[] = [];
    let liCitada = false;
    if (margemNeg && liqBaixa) gatilhos.push(`a operação fecha no vermelho e, ao mesmo tempo, os compromissos de curto prazo superam os ativos de curto prazo (${lcFrase})`);
    else if (margemNeg && caixaMinimo) { gatilhos.push(`a operação fecha no vermelho e o dinheiro em conta cobre só ${liPct} dos compromissos de curto prazo`); liCitada = true; }
    // O placar da coluna NÃO se repete aqui (ele abre o quadro de fôlego); o
    // estágio só aponta que a estrutura também acendeu.
    if (solvenciaColapsada && caixaMinimo) gatilhos.push(
      liCitada
        ? "os testes de solidez da estrutura ficaram no nível frágil (detalhado no quadro de fôlego financeiro)"
        : `os testes de solidez da estrutura ficaram no nível frágil (detalhado no quadro de fôlego financeiro) e o dinheiro em conta cobre só ${liPct} dos compromissos de curto prazo`,
    );
    const evidencia = gatilhos.length
      ? ` O que define o estágio: ${gatilhos.join("; e ")}. Essa combinação coloca o caixa à frente de qualquer outra leitura do momento do negócio.`
      : "";
    const implicacao = "";

    // A RESSALVA DA JANELA só cita o que EXISTE na série: "exercício fechado
    // anterior" quando há um (rótulo anual ou 31/12 antes desta coluna), e a
    // sazonalidade como hipótese, não como fato do negócio que o motor não mediu.
    const temFechado = ord.slice(0, -1).some((p) => /^\d{4}$/.test(p.trim()) || /^\d{2}\/12\/\d{4}$/.test(p.trim()) || /^12\/\d{4}$/.test(p.trim()));
    const ressalvaJanela = parcial
      ? temFechado
        ? " Esse resultado é de uma janela parcial e deve ser lido junto com o exercício fechado anterior e com a sazonalidade, se o negócio a tiver, antes de ser tratado como traço permanente."
        : " Esse resultado é de uma janela parcial e não deve ser tratado como traço permanente sem um exercício fechado para comparar."
      : "";
    // Quando foi o TRIO que disparou a classificação, o texto precisa dizer —
    // senão o dono lê "o negócio vai bem" sem saber qual sinal acendeu.
    // Quando o gatilho estrutural já foi declarado acima, não se repete.
    const sinalEstrutural = solvenciaColapsada && !(solvenciaColapsada && caixaMinimo)
      ? " Os indicadores de solidez financeira, que olham a estrutura e não só o mês, também estão no nível que pede atenção imediata."
      : "";
    // SÓ SE AFIRMA O QUE FOI MEDIDO: sem margem na série o motor não sabe se a
    // operação cobre os próprios custos, e a frase da consequência ficava em
    // branco. E a ressalva da janela parcial vale para os DOIS sinais — antes
    // ela era descartada justamente quando o número bom era o parcial.
    const consequenciaBase = operacaoVai
      ? " Uma empresa pode dar lucro e ainda assim não ter dinheiro para pagar o que vence, e é exatamente isso que acontece aqui: o resultado existe, mas está preso em prazos, estoques ou já saiu em retiradas e dívidas."
      : margemOp == null || margemZero || parcial
      ? ""
      : " Enquanto a operação não voltar a cobrir os próprios custos, o caixa continuará encolhendo mês a mês.";
    const consequencia = `${consequenciaBase}${parcial ? ressalvaJanela : ""}`;
    return com({
      // "PRESSÃO DE CAIXA", não "Dificuldade de caixa" (dono, 21/08/2026: o termo
      // soa forte demais para quem construiu a empresa). O FATO não muda — falta
      // dinheiro para os compromissos de curto prazo, e os números continuam os
      // mesmos; muda a palavra que abre a conversa. Rótulos antigos gravados
      // ("Crise de caixa", "Dificuldade de caixa") seguem mapeados na matriz.
      estagio: "Pressão de caixa",
      // A ressalva/consequência vira parágrafo próprio (a tela e o PDF respeitam
      // a linha em branco): o fato num bloco, como lê-lo no outro.
      justificativa: `${abertura}${evidencia}${implicacao}${sinalEstrutural}${consequencia ? `\n\n${consequencia.trim()}` : ""}`,
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

    // A explicação segue os SINAIS da coluna: "ainda remunera sócios e credores"
    // era texto fixo e saía logo depois de "sem movimento relevante com sócios e
    // credores" quando o financiamento ficou no zero.
    const explicaDe = (estagio: string, l: { fco: number; fci: number; fcf: number; eps: number }): string => {
      const fcfZero = Math.abs(l.fcf) <= l.eps, fciZero = Math.abs(l.fci) <= l.eps;
      switch (estagio) {
        case "Crescimento": return "padrão de crescimento: o negócio expande e atrai recursos para acelerar";
        case "Maturidade": return fcfZero
          ? `padrão maduro: a própria operação sustenta a empresa, sem depender de sócios nem credores${fciZero ? " e sem novos investimentos relevantes" : ""}`
          : "padrão maduro: a própria operação sustenta a empresa e ainda devolve dinheiro a sócios e credores";
        case "Platô": return "padrão de acomodação: gera caixa mas desfaz posições, sem novas frentes de crescimento";
        case "Retração": return "padrão de retração: a operação ainda não se sustenta sozinha";
        default: return "";
      }
    };
    if (rec.estagio && (!ant || !ant.estagio || ant.estagio === rec.estagio)) {
      // Sem coluna anterior provada, ou padrão CONSISTENTE nos dois anos → Dickinson decide.
      const persistencia = ant?.estagio === rec.estagio ? ` O mesmo padrão se repete em ${rotuloCurto(colAnt!)} — leitura consistente.` : "";
      return com({
        estagio: rec.estagio,
        justificativa: `O que define o estágio: o sentido dos três fluxos de caixa (operação, investimento e financiamento) no período mais recente, pelo método Dickinson. ${narrarFluxos(rec.fco, rec.fci, rec.fcf, rec.eps, rotuloCurto(colRecente!))} É o ${explicaDe(rec.estagio, rec)}.${persistencia}`,
      });
    }
    if (rec.estagio && ant?.estagio && ant.estagio !== rec.estagio) {
      // TRANSIÇÃO (anos divergem): a tendência multi-ano decide; sinais só narram.
      const porTendencia = porReceitaMargem();
      if (porTendencia) {
        return com({
          estagio: porTendencia.estagio,
          justificativa: `${porTendencia.justificativa} Os sinais do fluxo de caixa mudaram entre os períodos (${rotuloCurto(colAnt!)}: ${ant.estagio.toLowerCase()}; ${rotuloCurto(colRecente!)}: ${rec.estagio.toLowerCase()}) — transição em curso; um período isolado não define o estágio.${solidez?.tendencia === "deteriorando" ? " A solidez financeira vem se deteriorando, o que pede atenção ao caixa nesta transição." : ""}`,
        });
      }
    }
    // rec ambíguo → heurística abaixo
  }

  // 3) Fallback: tendência de RECEITA/MARGEM no histórico completo.
  const fallback = porReceitaMargem();
  return fallback ? com(fallback) : null;

  function porReceitaMargem(): Omit<EstagioResult, "solidez"> | null {
    // Pares (período, receita) para o rótulo acompanhar o número — filtrar só
    // a receita desalinhava os índices quando uma coluna vinha sem valor.
    const serie = ord.map((p) => ({ p: rotuloCurto(p), r: val("Receita Líquida", p) })).filter((x): x is { p: string; r: number } => x.r != null);
    if (serie.length < 2) return null;
    const n = serie.length;
    const first = serie[0]!.r, last = serie[n - 1]!.r;
    // Percentual de crescimento só existe com base não nula: de R$ 0 para R$ 5
    // milhões o "0" de fallback saía impresso como "estável (0%)".
    const crescMedivel = first !== 0;
    const cresc = crescMedivel ? (last - first) / Math.abs(first) : 0;
    const quedaUlt = serie[n - 1]!.r < serie[n - 2]!.r && (n < 3 || serie[n - 2]!.r <= serie[n - 3]!.r);
    // "Caiu em DOIS períodos seguidos" exige duas quedas de verdade: com
    // 10 / 10 / 8 a lista de números desmentia a frase acima dela.
    const caiuDuasVezes = n >= 3 && serie[n - 1]!.r < serie[n - 2]!.r && serie[n - 2]!.r < serie[n - 3]!.r;
    const cresceUlt = serie[n - 1]!.r > serie[n - 2]!.r && (n < 3 || serie[n - 2]!.r >= serie[n - 3]!.r);
    const saiuDoZero = serie[n - 2]!.r === 0 && serie[n - 1]!.r > 0;
    const margemPos = margemOp != null && margemOp > 0;
    const crescUltAno = serie[n - 2]!.r !== 0 ? (serie[n - 1]!.r - serie[n - 2]!.r) / Math.abs(serie[n - 2]!.r) : 0;
    // Sinal só onde ele informa: "recuou -20%" é o mesmo sinal duas vezes, e
    // "-0%" é sinal em cima de zero.
    const pctSinal = (r: number) => Math.abs(r * 100) < 0.5 ? "0%" : `${r > 0 ? "+" : ""}${(r * 100).toFixed(0)}%`;
    const pctAbs = (r: number) => `${Math.abs(r * 100).toFixed(0)}%`;
    const margemTxt = margemOp == null ? "" : margemPos
      ? ` A operação fecha no azul: de cada R$ 100 de receita sobram cerca de R$ ${num(margemOp * 100, 0)} depois de custos e despesas (margem EBITDA de ${num(margemOp * 100, 1)}%).`
      : ` A operação fecha no vermelho: margem EBITDA de ${num(margemOp * 100, 1)}%.`;

    // CADA RAMO DECLARA SÓ O QUE TESTOU, com os números desta empresa. O texto
    // fixo anterior afirmava "sem aperto de caixa" sem ter olhado a liquidez, e
    // publicava "vem encolhendo, 180% no acumulado" quando o gatilho era a queda
    // dos dois últimos anos numa série que cresceu no total.
    const gatilho = "O que define o estágio: a trajetória do faturamento e o sinal da margem ao longo do período.";
    if (quedaUlt || cresc < -0.1) {
      const queda = caiuDuasVezes
        ? ` O faturamento caiu em dois períodos seguidos: ${reais(serie[n - 3]!.r)} em ${serie[n - 3]!.p}, ${reais(serie[n - 2]!.r)} em ${serie[n - 2]!.p} e ${reais(serie[n - 1]!.r)} em ${serie[n - 1]!.p}${cresc < 0 ? ` (${pctSinal(cresc)} no acumulado do período)` : ", ainda que o acumulado do período siga positivo"}.`
        : quedaUlt
        ? ` O faturamento caiu de ${reais(serie[n - 2]!.r)} em ${serie[n - 2]!.p} para ${reais(serie[n - 1]!.r)} em ${serie[n - 1]!.p}${crescMedivel ? ` (${pctSinal(cresc)} no acumulado do período)` : ""}.`
        : ` O faturamento recuou de ${reais(first)} em ${serie[0]!.p} para ${reais(last)} em ${serie[n - 1]!.p} (${pctAbs(cresc)} no acumulado do período).`;
      // O fecho declara SÓ o que foi medido: sem olhar a liquidez, "não é pagar
      // as contas do mês" contradizia o quadro de fôlego no mesmo relatório.
      const fecho = liqCorr == null
        ? ""
        : liqCorr < 1
        ? ` E a queda vem junto com aperto de curto prazo: para cada R$ 1,00 de obrigações de curto prazo há R$ ${num(liqCorr, 2)} em ativos de curto prazo.`
        : ` O aperto está em vender menos: a folga de curto prazo ainda cobre as obrigações do período (liquidez corrente de ${num(liqCorr, 2)}).`;
      return { estagio: "Retração", justificativa: `${gatilho}${queda}${margemTxt}${fecho}` };
    }
    if ((cresceUlt && crescUltAno > 0.15 && margemPos) || (saiuDoZero && margemPos)) {
      const alta = saiuDoZero
        ? ` O faturamento saiu de zero em ${serie[n - 2]!.p} para ${reais(last)} em ${serie[n - 1]!.p}.`
        : ` O faturamento está em expansão, com alta de ${pctSinal(crescUltAno)} no último período.`;
      return { estagio: "Crescimento", justificativa: `${gatilho}${alta}${margemTxt}` };
    }
    if (crescMedivel && Math.abs(cresc) <= 0.1 && margemPos && (liqCorr == null || liqCorr >= 1)) {
      const folga = liqCorr != null ? ` Para cada R$ 1,00 de obrigações de curto prazo há R$ ${num(liqCorr, 2)} em ativos de curto prazo (liquidez corrente de ${num(liqCorr, 2)}).` : "";
      return { estagio: "Maturidade", justificativa: `${gatilho} O faturamento se manteve estável no período (${pctSinal(cresc)}).${margemTxt}${folga}` };
    }
    // Platô: diz a trajetória REAL e por que não é Crescimento nem Maturidade.
    const traj = !crescMedivel
      ? `saiu de ${reais(first)} em ${serie[0]!.p} para ${reais(last)} em ${serie[n - 1]!.p}`
      : cresc > 0.1 ? `cresceu ${pctSinal(cresc)} no período`
      : cresc < -0.1 ? `recuou ${pctAbs(cresc)} no período`
      : `ficou praticamente estável (${pctSinal(cresc)} no período)`;
    // Margem AUSENTE não é margem negativa: o texto afirmava prejuízo em série
    // que não trazia margem nenhuma.
    const porque = margemOp == null
      ? " A margem não está disponível nesta série, o que impede a leitura de maturidade."
      : margemOp < 0
      ? " A margem negativa impede a leitura de crescimento ou maturidade."
      : !margemPos
      ? " A operação empata (margem EBITDA de 0,0%), o que impede a leitura de maturidade."
      : liqCorr != null && liqCorr < 1
      ? ` A folga de curto prazo está abaixo de 1 (liquidez corrente de ${num(liqCorr, 2)}), o que impede a leitura de maturidade.`
      : " Sem alta consistente nos últimos períodos, não há leitura de crescimento.";
    const fechoPlato = crescMedivel && cresc > 0.1
      ? " O faturamento avança, mas ainda não se sustenta como crescimento."
      : " A empresa se mantém, mas não avança.";
    return { estagio: "Platô", justificativa: `${gatilho} O faturamento ${traj}.${margemTxt}${porque}${fechoPlato}` };
  }
}
