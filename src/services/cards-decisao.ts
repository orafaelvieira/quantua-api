/**
 * CARDS DE DECISÃO (onda 3) — cada card responde UMA pergunta que o dono faz.
 *
 * Tudo determinístico, do que o motor já tem. Onde o dado não existe, o card
 * DECLARA a premissa em vez de inventar: o que separa este produto de uma
 * planilha bonita é dizer de onde veio cada número — e admitir o que não sabe.
 *
 * Limites reais da base (medidos, não supostos):
 * - NÃO existe cronograma de vencimento de dívida no histórico contábil, só o
 *   SALDO de curto prazo. A distribuição segura usa esse saldo como proxy e diz
 *   isso na cara do leitor.
 * - NÃO existe DSCR calculável (serviço da dívida exige amortização, que a base
 *   não tem). O card de covenants avalia o que dá para provar e marca o resto
 *   como "não verificável com os documentos deste IBR".
 * - Sem marcação fixo × variável, o efeito de ±5% de receita no RESULTADO não é
 *   calculável — a mesa mostra o efeito na receita e diz o que falta.
 * - NÃO existe taxa contratada por operação de crédito. O custo da dívida sai da
 *   despesa financeira da DRE sobre a dívida média — aproximação POR CIMA, porque
 *   essa linha carrega IOF, tarifas e descontos junto com o juro.
 * - NÃO existe referência de custo de crédito POR RAMO DE ATIVIDADE: a série que
 *   o produto ingere (Banco Central) é nacional para crédito PJ. O card compara
 *   com ela e diz exatamente isso — nunca "acima da média do seu ramo".
 */
import type { BPLineItem, DRELineItem } from "../types/financial";
import type { FluxoCaixaIndireto } from "./cash-flow-indirect";
import { calcularContaRegressiva } from "./conta-regressiva";
import { diasDoPeriodo, diasYTD } from "./indicator-calculator";
import { rotuloPeriodoSrv } from "./bridge-variacao";

export type StatusCard = "ok" | "atencao" | "critico" | "informativo";

export interface LinhaCard {
  rotulo: string;
  valor: string;
  /** Número cru para o Excel (mesma unidade do texto). */
  bruto?: number | null;
  destaque?: boolean;
}

export interface CardDecisao {
  id:
    | "distribuicao"
    | "covenants"
    | "headroom-captacao"
    | "custo-divida"
    | "crescer-sem-captar"
    | "reinvestimento"
    | "qualidade-lucro"
    | "sensibilidade";
  titulo: string;
  /** A pergunta que o card responde — o dono se reconhece nela. */
  pergunta: string;
  status: StatusCard;
  /** Manchete: a resposta em uma frase, com o número. */
  resposta: string;
  linhas: LinhaCard[];
  /** Premissas e limites — sempre visíveis, nunca em nota de rodapé escondida. */
  premissas: string[];
  /**
   * A premissa que o leitor EDITA na tela. Sai daqui estruturada (e não como mais
   * uma frase em `premissas`) para o controle não repetir o texto ao lado dele:
   * a tela desenha `antes [campo] depois`. Fora da tela — no PDF, no Excel — vira
   * frase normal, porque premissa escondida transforma número em chute.
   */
  edicao?: { chave: "mesesCaixaMinimo"; valor: number; antes: string; depois: string };
}

export interface PremissasDecisao {
  /** Meses de desembolso operacional que a empresa quer manter em caixa. */
  mesesCaixaMinimo?: number;
}

export const MESES_CAIXA_MINIMO_PADRAO = 3;

export interface DadosParaCards {
  bp?: BPLineItem[];
  dre?: DRELineItem[];
  periodos?: string[];
  fluxoCaixa?: FluxoCaixaIndireto | null;
  arvoresBalancete?: Array<{ periodo?: string }>;
  indicadores?: Array<{ nome: string; valores: Record<string, number | string | null> }>;
}

export interface CovenantParaCard {
  name: string;
  metric: string;
  operator: string;
  threshold: number;
}

/**
 * Referências EXTERNAS ao IBR (vêm do banco, não da contabilidade da empresa).
 * Chegam por parâmetro justamente para o motor continuar puro: sem a referência,
 * o card que depende dela não aparece — não existe "valor de mercado padrão"
 * chutado aqui dentro.
 */
export interface BenchmarksParaCards {
  /** Custo médio do crédito PJ no Brasil, DECIMAL ao ano (0,183 = 18,3%). */
  custoMedioDivida?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const val = (linhas: Array<{ conta: string; valores: Record<string, number> }> | undefined, conta: string, p: string): number =>
  linhas?.find((l) => l.conta === conta)?.valores?.[p] ?? 0;

/** Como `val`, mas distingue AUSENTE de ZERO — a diferença entre "não sei" e
 *  "é zero" decide se o card aparece ou some. */
const valOpt = (
  linhas: Array<{ conta: string; valores: Record<string, number> }> | undefined,
  conta: string,
  p: string,
): number | null => {
  const v = linhas?.find((l) => l.conta === conta)?.valores?.[p];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

const brl = (v: number): string => {
  const abs = Math.abs(v);
  const s = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${s}R$ ${(abs / 1_000_000).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mi`;
  // Uma casa decimal abaixo de R$ 10 mil: sem ela, R$ 1.500 sai como "R$ 2 mil" —
  // arredondamento de 33% num card que responde "quanto posso tirar".
  if (abs >= 1_000) return `${s}R$ ${(abs / 1_000).toLocaleString("pt-BR", { maximumFractionDigits: abs < 10_000 ? 1 : 0 })} mil`;
  return `${s}R$ ${abs.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}`;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Indicador do motor no período (a fonte única — nunca recalcular aqui). */
const ind = (dados: DadosParaCards, nome: string, p: string): number | null =>
  num(dados.indicadores?.find((i) => i.nome === nome)?.valores?.[p]);

/** Semáforo do indicador, já calibrado pelo motor — não inventar limiar aqui. */
const indStatus = (dados: DadosParaCards, nome: string, p: string): "ok" | "atencao" | "critico" | null => {
  const s = (dados.indicadores?.find((i) => i.nome === nome) as { status?: Record<string, string | null> } | undefined)?.status?.[p];
  return s === "ok" || s === "atencao" || s === "critico" ? s : null;
};

/** O pior de dois status — a boa notícia nunca apaga a ruim. */
const PESO_STATUS: Record<StatusCard, number> = { informativo: 0, ok: 1, atencao: 2, critico: 3 };
const pior = (a: StatusCard, b: StatusCard | null): StatusCard =>
  b !== null && PESO_STATUS[b] > PESO_STATUS[a] ? b : a;

/** Taxa em % ao leitor (0,183 → "18,3%"). */
const pct = (v: number, casas = 1): string =>
  `${(v * 100).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`;

/** Múltiplo com vírgula ("3,0x") — nunca "3x", que o leitor confunde com contagem. */
const mult = (v: number): string => `${v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}x`;

const NOME_ALAVANCAGEM = "Dívida Líquida/EBITDA";
/** Nome exato no template de indicadores — o card de custo lê o perfil de risco daqui. */
const NOME_COBERTURA_JUROS = "Índice de Cobertura de Juros";
const NOME_ROE = "ROE (Retorno sobre Patrimônio Líquido)";
const NOME_CRESCIMENTO = "Crescimento da Receita (YoY)";
const NOME_DIVIDA = "Capital de Terceiros + Partes Relacionadas";

/**
 * DÍVIDA BRUTA do período — as QUATRO contas, sempre.
 *
 * O indicador do motor manda quando existe (fonte única). O somatório das contas
 * é o piso, e lê as quatro: ler só "Empréstimos e Financiamentos - CP" zerava a
 * dívida de quem tem tudo em longo prazo ou em empréstimo de sócio (bug real).
 */
const dividaBruta = (dados: DadosParaCards, p: string): number => {
  const doIndicador = ind(dados, NOME_DIVIDA, p);
  if (doIndicador !== null) return Math.abs(doIndicador);
  const bp = dados.bp ?? [];
  return Math.abs(val(bp, "Empréstimos e Financiamentos - CP", p))
    + Math.abs(val(bp, "Passivos com Partes Relacionadas - CP", p))
    + Math.abs(val(bp, "Empréstimos e Financiamentos - LP", p))
    + Math.abs(val(bp, "Passivos com Partes Relacionadas - LP", p));
};

/**
 * EBITDA do período. O motor NÃO publica "EBITDA" na lista de indicadores (só
 * "Margem EBITDA"), então a fonte é o subtotal da DRE — que é exatamente de onde
 * o indicator-calculator também parte. Segunda via: margem × receita líquida, para
 * a DRE que chegou sem o subtotal aberto. Sem nenhuma das duas, devolve null e o
 * card some: EBITDA estimado por conta própria seria número inventado no
 * denominador de todo o resto.
 */
function ebitdaDoPeriodo(dados: DadosParaCards, p: string): number | null {
  const daDre = valOpt(dados.dre ?? [], "EBITDA", p);
  if (daDre !== null) return daDre;
  const margem = ind(dados, "Margem EBITDA", p);
  const receita = ind(dados, "Receita Líquida", p) ?? valOpt(dados.dre ?? [], "Receita Líquida", p);
  return margem !== null && receita !== null ? margem * receita : null;
}

// ── Card 1: quanto dá para distribuir ─────────────────────────────────────────

function cardDistribuicao(
  dados: DadosParaCards,
  p: string,
  dias: number,
  premissas: PremissasDecisao,
): CardDecisao | null {
  const bp = dados.bp ?? [];
  const dre = dados.dre ?? [];
  const caixa = val(bp, "Caixa e Equivalentes de Caixa", p);
  const fco = dados.fluxoCaixa?.totais?.fco?.[p] ?? null;
  const regressiva = calcularContaRegressiva(bp, dre, p, fco, dias);
  if (!regressiva?.desembolsoDiario) return null;

  const meses = premissas.mesesCaixaMinimo ?? MESES_CAIXA_MINIMO_PADRAO;
  const caixaMinimo = regressiva.desembolsoDiario * meses * 30;

  /**
   * DÍVIDA COMO O MOTOR DEFINE — as quatro contas, não uma.
   *
   * Lia só "Empréstimos e Financiamentos - CP". Empréstimo de sócio ou de empresa
   * ligada (Passivos com Partes Relacionadas), que é o normal em PME, ficava de
   * fora; e quem tinha a dívida toda em longo prazo via "R$ 0" na linha, que se
   * lê como "não tem dívida". O dono viu esse zero numa empresa endividada.
   * Mesma definição de "Capital de Terceiros + Partes Relacionadas".
   */
  const dividaCP = Math.abs(val(bp, "Empréstimos e Financiamentos - CP", p))
    + Math.abs(val(bp, "Passivos com Partes Relacionadas - CP", p));
  const dividaLP = Math.abs(val(bp, "Empréstimos e Financiamentos - LP", p))
    + Math.abs(val(bp, "Passivos com Partes Relacionadas - LP", p));
  // O indicador do motor manda quando existe (fonte única); as contas são o piso.
  const dividaTotal = ind(dados, "Capital de Terceiros + Partes Relacionadas", p) ?? (dividaCP + dividaLP);

  const sobra = caixa - caixaMinimo - dividaCP;

  // Capacidade RECORRENTE: o que a operação gera depois de investir e pagar juros
  // (a hierarquia do caixa da onda 2 chama isso de FCLE→FCLA). Sem FC provado, só
  // o retrato do caixa vale — e o card diz isso.
  const capex = Math.abs(dados.fluxoCaixa?.fci?.find((l) => /capex/i.test(l.nome))?.valores?.[p] ?? 0);
  const fcRecorrente = fco !== null ? fco - capex : null;

  // "1 meses" num relatório que vai ao cliente denuncia texto montado por máquina.
  const mesesTxt = `${meses.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${meses === 1 ? "mês" : "meses"}`;

  /**
   * FOTO DO CAIXA × FILME DA OPERAÇÃO.
   *
   * O caixa é o saldo de UMA data; a geração recorrente é o que a operação repõe
   * mês a mês. Julgar só pela foto marcava "crítico" numa empresa SEM DÍVIDA que
   * gera R$ 3,5 mi no período — o dono viu isso na primeira tela real, e ele
   * estava certo: não ter folga hoje é fato, mas só é crítico quando a operação
   * também não repõe. O tempo de reposição sai do próprio número do motor.
   */
  const geraCaixa = fcRecorrente !== null && fcRecorrente > 0;
  const falta = -sobra;
  const geracaoMensal = geraCaixa ? fcRecorrente! / (dias / 30) : null;
  const mesesParaRepor = geracaoMensal && falta > 0 ? falta / geracaoMensal : null;
  const nMeses = mesesParaRepor !== null ? Math.ceil(mesesParaRepor) : 0;

  /**
   * ALAVANCAGEM E RETIRADA JÁ FEITA entram na pergunta "quanto posso tirar".
   *
   * A conta do caixa sozinha dizia "em 9 meses a distribuição volta a caber" para
   * uma empresa cuja dívida subiu 123% no ano e cujo PL caiu pela metade — porque
   * a dívida era toda de LONGO prazo e não entrava na subtração. Continuar não
   * subtraindo está certo (ela não vence no exercício), mas ignorá-la na leitura
   * não: quem decide dividendo precisa ver os dois números.
   *
   * O limiar da alavancagem NÃO é inventado aqui — vem do semáforo que o motor já
   * calibra para Dívida Líquida/EBITDA. E a retirada do período é a linha que o
   * fluxo indireto já calcula (ΔPL − lucro − Δ capital), não uma conta nova.
   */
  const alavancagem = ind(dados, "Dívida Líquida/EBITDA", p);
  const statusAlavancagem = indStatus(dados, "Dívida Líquida/EBITDA", p);
  const retiradaLinha = dados.fluxoCaixa?.fcf?.find((l) => /dividendo|ajustes do pl/i.test(l.nome))?.valores?.[p] ?? 0;
  const jaRetirado = retiradaLinha < 0 ? Math.abs(retiradaLinha) : 0;
  // ALERTA só quando o semáforo ACENDE. Status nulo é desconhecido, não perigo:
  // sem esta guarda, empresa com dívida líquida NEGATIVA (mais caixa que dívida)
  // ouvia "distribuir aumenta a alavancagem".
  const alavancagemAcesa = statusAlavancagem === "atencao" || statusAlavancagem === "critico";
  // A promessa de "volta a caber em N meses" só vale com a alavancagem apagada:
  // senão a geração dos próximos meses já tem dono.
  const reporNoAno = mesesParaRepor !== null && mesesParaRepor <= 12;
  const podePrometer = reporNoAno && !alavancagemAcesa;

  const statusCaixa: StatusCard = sobra > 0
    ? (sobra < caixaMinimo * 0.5 ? "atencao" : "ok")
    : podePrometer ? "atencao" : "critico";
  const status = pior(statusCaixa, statusAlavancagem);

  const alavancagemTxt = alavancagem !== null
    ? ` (${alavancagem.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}x EBITDA)`
    : "";
  const contexto = [
    dividaTotal > 0 && alavancagemAcesa
      ? `A dívida total é ${brl(dividaTotal)}${alavancagemTxt}: distribuir agora aumenta a alavancagem.`
      : null,
    jaRetirado > 0
      ? `Neste período já saíram ${brl(jaRetirado)} do patrimônio em dividendos e ajustes.`
      : null,
  ].filter(Boolean).join(" ");

  const base = sobra > 0
    ? `Distribuição segura hoje: até ${brl(sobra)} — o que sobra depois de manter ${mesesTxt} de reserva e cobrir a dívida de curto prazo.`
    : podePrometer
      ? `Nada a distribuir hoje: o caixa (${brl(caixa)}) está ${brl(falta)} abaixo da linha de segurança. A operação gera ${brl(fcRecorrente!)} no período, o que recompõe essa diferença em cerca de ${nMeses} ${nMeses === 1 ? "mês" : "meses"} no mesmo ritmo — a partir daí a distribuição volta a caber.`
      : geraCaixa && !reporNoAno
        ? `Nada a distribuir: o caixa (${brl(caixa)}) está ${brl(falta)} abaixo da linha de segurança, e no ritmo atual a operação levaria mais de um ano para recompor.`
        : geraCaixa
          // Repõe dentro do ano, mas a alavancagem está acesa: a geração tem dono.
          ? `Nada a distribuir: o caixa (${brl(caixa)}) está ${brl(falta)} abaixo da linha de segurança, e a geração do período tem compromisso antes de virar dividendo.`
          : `Não há folga para distribuir: o caixa de hoje (${brl(caixa)}) não cobre a reserva mínima e os compromissos de curto prazo, e a operação não está gerando caixa para repor.`;

  const resposta = contexto ? `${base} ${contexto}` : base;

  return {
    id: "distribuicao",
    titulo: "Quanto dá para distribuir",
    pergunta: "Quanto posso tirar de dividendos sem comprometer o caixa?",
    status,
    resposta,
    // A conta fecha na linha em destaque e PARA nela: a geração recorrente não
    // entra na soma (é de outro período), então vive na resposta acima, não como
    // uma linha solta depois do total, parecendo uma parcela esquecida.
    linhas: [
      { rotulo: "Caixa disponível", valor: brl(caixa), bruto: caixa },
      { rotulo: `Reserva mínima (${mesesTxt} de operação)`, valor: `-${brl(caixaMinimo)}`, bruto: -caixaMinimo },
      {
        // Quando não há vencimento no exercício mas EXISTE dívida, o rótulo diz —
        // "R$ 0" sozinho passa a impressão de empresa sem dívida.
        rotulo: dividaCP <= 0 && dividaTotal > 0 ? "Dívida de curto prazo (toda no longo prazo)" : "Dívida de curto prazo",
        valor: dividaCP > 0 ? `-${brl(dividaCP)}` : brl(0),
        bruto: -dividaCP,
      },
      { rotulo: "Distribuição segura", valor: brl(sobra), bruto: sobra, destaque: true },
    ],
    edicao: {
      chave: "mesesCaixaMinimo",
      valor: meses,
      antes: "Reserva mínima =",
      depois: `${meses === 1 ? "mês" : "meses"} de desembolso operacional (${brl(regressiva.desembolsoDiario * 30)}/mês), premissa desta empresa.`,
    },
    premissas: [
      dividaTotal > 0
        ? `Dívida total de ${brl(dividaTotal)} (empréstimos e partes relacionadas); só a parcela de curto prazo, ${brl(dividaCP)}, entra nesta conta${dividaLP > 0 ? ` — os outros ${brl(dividaLP)} vencem depois do exercício e continuam pesando na decisão` : ""}.`
        : "A empresa não tem dívida financeira registrada no balanço deste período.",
      "Compromissos de curto prazo = SALDO das contas de dívida CP: a base contábil não traz cronograma de vencimentos.",
      ...(fcRecorrente !== null
        ? [`Geração recorrente do período = ${brl(fcRecorrente)} (caixa da operação menos o investimento, capex estimado do fluxo indireto).`]
        : []),
      ...(podePrometer
        ? ["O prazo de reposição supõe o mesmo ritmo de geração dos próximos meses, sem sazonalidade — é ordem de grandeza, não cronograma."]
        : []),
      ...(jaRetirado > 0
        ? [`Retirada do período (${brl(jaRetirado)}) = variação do patrimônio líquido menos o lucro e menos a variação de capital social, do fluxo de caixa indireto: inclui dividendos e outros ajustes do PL.`]
        : []),
      ...(statusAlavancagem === "critico" || statusAlavancagem === "atencao"
        ? ["O alerta de alavancagem vem do semáforo de Dívida Líquida/EBITDA da aba Indicadores, com os mesmos limites usados no resto do IBR."]
        : []),
      "Não considera obrigações fiscais parceladas nem sazonalidade do recebimento — confira antes de deliberar.",
    ],
  };
}

// ── Card 2: covenants ─────────────────────────────────────────────────────────

/**
 * ALIASES de métrica antiga → nome do indicador.
 *
 * O campo `metric` do covenant é TEXTO LIVRE preenchido pelo analista, e a aba
 * Covenants resolve casando com o NOME do indicador (comparação minúscula, sem
 * espaços nas pontas). O comentário do schema fala em chaves camelCase; nada em
 * produção grava assim. Este mapa cobre só o caso legado — a resolução de
 * verdade é por nome, igual à aba, senão o card diria "nenhum covenant
 * verificável" ao lado de uma aba mostrando descumprimento no mesmo IBR.
 */
const ALIAS_METRICA: Record<string, string> = {
  netdebtebitda: "dívida líquida/ebitda",
  currentratio: "liquidez corrente",
  ebitdamargin: "margem ebitda",
  mincash: "caixa e equivalentes",
  interestcoverage: "índice de cobertura de juros",
};

/**
 * Nome (minúsculo) do indicador para onde o `metric` do covenant aponta.
 *
 * Extraído para o card de headroom usar A MESMA resolução do card de covenants:
 * se o limite de alavancagem do contrato é verificado ali, o teto de captação
 * daqui tem que sair do mesmo covenant — duas telas do mesmo IBR discordando
 * sobre qual é o limite do banco é pior que não ter o card.
 */
function nomeIndicadorDoCovenant(metric: string): string {
  const alvo = (metric ?? "").toLowerCase().trim();
  return ALIAS_METRICA[alvo.replace(/[^a-z]/g, "")] ?? alvo;
}

/** Formata pela unidade do indicador (o motor carrega tipoDado junto). */
function fmtPorTipo(v: number, tipoDado: string | undefined): string {
  switch (tipoDado) {
    case "%": return `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
    case "Dias": return `${Math.round(v).toLocaleString("pt-BR")} dias`;
    case "R$": return brl(v);
    default: return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}

/**
 * Veredicto do covenant — MESMAS faixas da aba Covenants (breach / amber a 10%
 * do limite). Duas telas do mesmo produto não podem discordar sobre o mesmo
 * contrato: se a régua mudar lá, muda aqui.
 */
function avaliarCovenant(valor: number, operador: string, limite: number): "ok" | "amber" | "breach" {
  const safeT = limite === 0 ? 1 : Math.abs(limite);
  switch (operador) {
    case "<=": return valor > limite ? "breach" : valor > limite * 0.9 ? "amber" : "ok";
    case "<": return valor >= limite ? "breach" : valor >= limite * 0.9 ? "amber" : "ok";
    case ">=": return valor < limite ? "breach" : valor < limite * 1.1 ? "amber" : "ok";
    case ">": return valor <= limite ? "breach" : valor <= limite * 1.1 ? "amber" : "ok";
    case "==": {
      const d = Math.abs(valor - limite) / safeT;
      return d > 0.1 ? "breach" : d > 0.05 ? "amber" : "ok";
    }
    default: return "ok";
  }
}

function cardCovenants(dados: DadosParaCards, p: string, covenants: CovenantParaCard[]): CardDecisao | null {
  if (!covenants.length) return null;
  const linhas: LinhaCard[] = [];
  const naoVerificaveis: string[] = [];
  let quebrados = 0;
  let apertados = 0;

  for (const c of covenants) {
    const nomeBuscado = nomeIndicadorDoCovenant(c.metric);
    const indicador = dados.indicadores?.find((i) => i.nome.toLowerCase().trim() === nomeBuscado);
    const atual = indicador ? num(indicador.valores?.[p]) : null;
    if (!indicador || atual === null) {
      naoVerificaveis.push(c.name);
      continue;
    }
    const tipoDado = (indicador as { tipoDado?: string }).tipoDado;
    const veredicto = avaliarCovenant(atual, c.operator, c.threshold);
    if (veredicto === "breach") quebrados++;
    else if (veredicto === "amber") apertados++;
    linhas.push({
      rotulo: `${c.name} (limite ${c.operator} ${fmtPorTipo(c.threshold, tipoDado)})`,
      valor: `${fmtPorTipo(atual, tipoDado)} — ${veredicto === "breach" ? "descumprido" : veredicto === "amber" ? "no limite" : "cumprido"}`,
      bruto: atual,
      destaque: veredicto === "breach",
    });
  }
  if (linhas.length === 0 && naoVerificaveis.length === 0) return null;

  const status: StatusCard = quebrados > 0 ? "critico" : apertados > 0 ? "atencao" : linhas.length ? "ok" : "informativo";
  const resposta = quebrados > 0
    ? `${quebrados} covenant(s) descumprido(s) no período — risco de vencimento antecipado.`
    : apertados > 0
      ? `Todos cumpridos, mas ${apertados} a menos de 10% do limite: um trimestre ruim encosta.`
      : linhas.length
        ? "Todos os covenants verificáveis estão cumpridos, com folga."
        : "Nenhum covenant pôde ser verificado com os documentos deste IBR.";

  return {
    id: "covenants",
    titulo: "Covenants",
    pergunta: "Estou perto de furar algum compromisso com o banco?",
    status,
    resposta,
    linhas,
    premissas: [
      "Verificação contra o indicador do período de referência — covenant é apurado na data pactuada, que pode diferir.",
      ...(naoVerificaveis.length
        ? [`Não verificável com esta base: ${naoVerificaveis.join(", ")}. A métrica precisa ter o nome exato de um indicador da aba Indicadores; índices de serviço da dívida (DSCR) exigem cronograma de amortização, que a contabilidade não traz.`]
        : []),
    ],
  };
}

// ── Card 3: headroom de captação ──────────────────────────────────────────────

/** Limite da casa quando o IBR não tem covenant de alavancagem. NÃO é regra de
 *  banco: é a régua de mercado mais comum em crédito PJ, e o card diz isso. */
export const LIMITE_ALAVANCAGEM_PADRAO = 3.0;

/**
 * QUANTO AINDA DÁ PARA TOMAR DE DÍVIDA.
 *
 *   headroom = (limite × EBITDA) − dívida líquida
 *
 * A pergunta que o dono faz antes de ir ao banco. O limite sai do covenant do
 * próprio IBR quando existe (é o contrato dele que manda); na falta, uma premissa
 * declarada — e declarada COMO premissa, para ninguém sair da tela dizendo "o
 * banco me deixa até 3x".
 *
 * RÉGUA DO STATUS (explícita porque não há semáforo do motor para headroom):
 * - EBITDA ≤ 0 → crítico: não existe múltiplo de um EBITDA que não existe. O
 *   card APARECE mesmo assim, porque sumir justamente na empresa em dificuldade
 *   é o oposto do que um IBR serve para fazer.
 * - headroom < 0 → crítico: o teto já foi furado; a conversa com o banco é de
 *   amortização, não de captação.
 * - headroom < 25% da dívida líquida → atenção: espaço que um trimestre fraco de
 *   EBITDA consome sozinho não é espaço.
 */
function cardHeadroomCaptacao(
  dados: DadosParaCards,
  p: string,
  dias: number,
  covenants: CovenantParaCard[],
  rot: (p: string) => string,
): CardDecisao | null {
  const ebitda = ebitdaDoPeriodo(dados, p);
  if (ebitda === null) return null; // sem EBITDA não há régua — e não se inventa uma

  // Só limite SUPERIOR ("<=" / "<") é teto de captação: um covenant de piso não
  // diz até onde dá para tomar. Entre vários, vale o mais apertado.
  const doContrato = covenants
    .filter((c) => nomeIndicadorDoCovenant(c.metric) === NOME_ALAVANCAGEM.toLowerCase())
    .filter((c) => (c.operator === "<=" || c.operator === "<") && Number.isFinite(c.threshold) && c.threshold > 0)
    .sort((a, b) => a.threshold - b.threshold)[0];
  const limite = doContrato?.threshold ?? LIMITE_ALAVANCAGEM_PADRAO;

  const dividaLiquida = ind(dados, "Dívida Líquida", p)
    ?? (dividaBruta(dados, p) - val(dados.bp ?? [], "Caixa e Equivalentes de Caixa", p));
  const teto = limite * ebitda;
  const headroom = teto - dividaLiquida;
  const alavancagem = ind(dados, NOME_ALAVANCAGEM, p);
  const parcial = dias < 360;

  const origemLimite = doContrato
    ? `covenant "${doContrato.name}" deste IBR`
    : "premissa desta análise";

  const linhas: LinhaCard[] = [
    { rotulo: `EBITDA (${rot(p)})`, valor: brl(ebitda), bruto: ebitda },
    { rotulo: `Limite de alavancagem (${origemLimite})`, valor: `${mult(limite)} EBITDA`, bruto: limite },
    { rotulo: "Teto de dívida líquida no limite", valor: brl(teto), bruto: teto },
    {
      // Dívida líquida NEGATIVA é caixa líquido: escrever "-−R$ 600 mil" na coluna
      // de subtração transformaria uma boa notícia em erro de digitação.
      rotulo: dividaLiquida >= 0 ? "Dívida líquida hoje" : "Caixa líquido hoje (mais caixa que dívida)",
      valor: dividaLiquida >= 0 ? `-${brl(dividaLiquida)}` : `+${brl(-dividaLiquida)}`,
      bruto: -dividaLiquida,
    },
    { rotulo: "Espaço para dívida nova", valor: brl(headroom), bruto: headroom, destaque: true },
  ];

  if (ebitda <= 0) {
    return {
      id: "headroom-captacao",
      titulo: "Quanto ainda dá para tomar de dívida",
      pergunta: "Quanto de dívida nova a empresa aguenta sem furar o limite?",
      status: "critico",
      resposta: `Não há espaço para dívida nova: o EBITDA do período é ${brl(ebitda)}. Um limite em múltiplo de EBITDA não mede nada quando não há EBITDA — e dívida nova aqui não tem de onde ser paga.`,
      linhas: linhas.slice(0, 2),
      premissas: [
        doContrato
          ? `Limite de ${mult(limite)} vem do covenant "${doContrato.name}" deste IBR.`
          : `Sem covenant de ${NOME_ALAVANCAGEM} neste IBR: a régua de ${mult(LIMITE_ALAVANCAGEM_PADRAO)} é premissa desta análise, não uma exigência de banco.`,
        "Com EBITDA negativo ou zero a capacidade de tomar dívida não se calcula por múltiplo — ela depende de garantia e de projeção, que não estão nesta base.",
        ...(parcial ? [`O período cobre ${dias} dias, não um ano: o EBITDA aqui é o acumulado desses meses.`] : []),
      ],
    };
  }

  // Sensibilidade do teto ao EBITDA: quem decide captar precisa ver que o espaço
  // não é um saldo — ele encolhe junto com o resultado.
  const perdaPor10 = limite * ebitda * 0.1;
  linhas.push({
    rotulo: "Cada 10% a menos de EBITDA reduz o teto em",
    valor: brl(perdaPor10),
    bruto: perdaPor10,
  });

  const folgaRelativa = dividaLiquida > 0 ? headroom / dividaLiquida : null;
  const apertado = folgaRelativa !== null && folgaRelativa < 0.25;
  const statusBase: StatusCard = headroom < 0 ? "critico" : apertado ? "atencao" : "ok";
  const status = pior(statusBase, indStatus(dados, NOME_ALAVANCAGEM, p));

  // Múltiplo NEGATIVO não é leitura de alavancagem — é o efeito aritmético de ter
  // mais caixa que dívida, e "-0,18x EBITDA" na tela só confunde quem decide. O
  // ponto de partida já diz que há caixa líquido.
  const alavTxt = alavancagem !== null && alavancagem > 0 ? ` A alavancagem atual é ${mult(alavancagem)} EBITDA.` : "";
  const pontoPartida = dividaLiquida >= 0
    ? `partindo de uma dívida líquida de ${brl(dividaLiquida)}`
    : `partindo de um caixa líquido de ${brl(-dividaLiquida)} (hoje há mais caixa do que dívida)`;
  const resposta = headroom < 0
    ? `Não há espaço para dívida nova: a empresa já está ${brl(-headroom)} acima do teto de ${mult(limite)} EBITDA (${brl(teto)}).${alavTxt} O caminho aqui é amortizar ou renegociar o limite, não captar.`
    : apertado
      ? `Sobram ${brl(headroom)} de espaço até o teto de ${mult(limite)} EBITDA — pouco perto da dívida líquida atual de ${brl(dividaLiquida)}.${alavTxt} Um trimestre fraco de EBITDA consome esse espaço sem a empresa tomar um centavo a mais.`
      : `A empresa aguenta até ${brl(headroom)} de dívida nova antes de encostar no teto de ${mult(limite)} EBITDA (${brl(teto)}), ${pontoPartida}.${alavTxt}`;

  return {
    id: "headroom-captacao",
    titulo: "Quanto ainda dá para tomar de dívida",
    pergunta: "Quanto de dívida nova a empresa aguenta sem furar o limite?",
    status,
    resposta,
    linhas,
    premissas: [
      doContrato
        ? `Limite de ${mult(limite)} vem do covenant "${doContrato.name}" deste IBR — se o contrato mudar, o cadastro de covenants é o lugar de corrigir.`
        : `Sem covenant de ${NOME_ALAVANCAGEM} neste IBR: a régua de ${mult(LIMITE_ALAVANCAGEM_PADRAO)} é premissa desta análise, não uma exigência do banco desta empresa. Cadastre o covenant real para o número valer como compromisso.`,
      "Dívida líquida = empréstimos e financiamentos (curto e longo prazo) + passivos com partes relacionadas − caixa e equivalentes, a mesma definição da aba Indicadores.",
      "A base contábil não traz cronograma de amortização: o número é um TETO DE SALDO, não uma janela de captação por vencimento — dívida que vence no mês que vem não abre espaço aqui.",
      "Capacidade de tomar não é conveniência de tomar: o teto diz até onde o múltiplo aguenta, não se o projeto paga o juro nem se o banco aprova.",
      ...(parcial
        ? [`O período cobre ${dias} dias, não um ano, e o EBITDA NÃO foi anualizado (mesma base do indicador ${NOME_ALAVANCAGEM}): contra um limite anual, o teto sai subestimado.`]
        : []),
    ],
  };
}

// ── Card 4: custo da dívida ───────────────────────────────────────────────────

/**
 * SUA DÍVIDA ESTÁ CARA?
 *
 *   custo da empresa = |Despesa Financeira| ÷ dívida média do período
 *
 * A referência de comparação é NACIONAL para crédito PJ (CDI + spread médio,
 * Banco Central) e chega por parâmetro. Nunca é média do ramo de atividade da
 * empresa — e o texto do card não pode sugerir que seja, senão o leitor decide
 * trocar de banco com base numa comparação que não existe.
 *
 * O DESVIO SOZINHO NÃO É VEREDICTO (correção do dono, 16/08/2026).
 *
 * Comparar o custo da empresa com uma taxa média nacional e concluir "sua dívida
 * está cara" ignora quatro coisas, e cada uma consegue inverter a leitura:
 *  1. RISCO — empresa alavancada pagando prêmio pode estar pagando o preço JUSTO
 *     do risco dela; o problema seria a alavancagem, não o banco.
 *  2. COMPOSIÇÃO — a referência mistura capital de giro, desconto de duplicata e
 *     BNDES subsidiado. Quem só tem giro DEVE pagar acima da média.
 *  3. TEMPO — a referência é a taxa de HOJE; a dívida foi contratada ao longo de
 *     anos, com o CDI de cada época. Parte do desvio é calendário, não gestão.
 *  4. Nada disso é rating de crédito, e o card não pode fingir que é.
 *
 * O que o desvio significa depende do PERFIL DE RISCO da própria empresa, e esse
 * nós temos: alavancagem e cobertura de juros, do motor. Com perfil confortável,
 * pagar acima da referência é sinal de PODER DE BARGANHA não exercido — vale a
 * conversa com o banco. Com perfil apertado, o prêmio é preço de risco: atacar a
 * alavancagem vem antes de atacar a taxa. Por isso o card NUNCA marca crítico
 * pelo desvio: no máximo atenção, e só quando o perfil não explica o prêmio.
 */
function cardCustoDivida(
  dados: DadosParaCards,
  p: string,
  dias: number,
  referencia: number,
  rot: (p: string) => string,
  periodoAnterior: string | null,
): CardDecisao | null {
  const despFinPeriodo = Math.abs(val(dados.dre ?? [], "Despesas Financeiras", p));
  if (despFinPeriodo <= 0.005) return null; // sem juro registrado não há custo a medir

  const dividaAtual = dividaBruta(dados, p);
  const dividaAnterior = periodoAnterior ? dividaBruta(dados, periodoAnterior) : null;
  // Dívida MÉDIA: o saldo de uma data sozinho mede errado quem captou (ou quitou)
  // no meio do período — a despesa é do período inteiro, a base tem que ser também.
  const dividaMedia = dividaAnterior !== null && dividaAnterior > 0
    ? (dividaAnterior + dividaAtual) / 2
    : dividaAtual;
  if (dividaMedia <= 0.005) return null; // sem dívida não há custo de dívida

  // ANUALIZA a despesa em período parcial: a referência é uma taxa AO ANO, e
  // comparar 5 meses de juro com ela diria "sua dívida está barata" para quem paga caro.
  const parcial = dias < 360;
  const fatorAno = 365 / dias;
  const despFinAno = parcial ? despFinPeriodo * fatorAno : despFinPeriodo;
  const custo = despFinAno / dividaMedia;
  const diferenca = custo - referencia;
  const efeitoAno = diferenca * dividaMedia;

  /**
   * PERFIL DE RISCO DA PRÓPRIA EMPRESA — é ele que dá sentido ao desvio.
   *
   * Usa os semáforos que o motor JÁ calibra para alavancagem e cobertura de
   * juros, em vez de inventar limiar aqui. Sem nenhum dos dois sinais, o card
   * não classifica: fica informativo e entrega os ingredientes ao leitor.
   */
  const stAlav = indStatus(dados, NOME_ALAVANCAGEM, p);
  const stCob = indStatus(dados, NOME_COBERTURA_JUROS, p);
  const sinais = [stAlav, stCob].filter((s): s is "ok" | "atencao" | "critico" => s !== null);
  const perfilFolgado = sinais.length > 0 && sinais.every((s) => s === "ok");
  const perfilApertado = sinais.some((s) => s === "critico" || s === "atencao");

  // NUNCA crítico pelo desvio: a comparação é contra uma média nacional, contra
  // a taxa de HOJE, sobre uma dívida contratada no passado. Isso aponta onde
  // olhar; não condena.
  const status: StatusCard = custo <= referencia
    ? "ok"
    : perfilFolgado ? "atencao" : "informativo";

  const linhas: LinhaCard[] = [
    {
      rotulo: parcial ? `Despesa financeira (${rot(p)}, anualizada)` : `Despesa financeira (${rot(p)})`,
      valor: brl(despFinAno),
      bruto: despFinAno,
    },
    {
      rotulo: dividaAnterior !== null && dividaAnterior > 0
        ? `Dívida média do período (média entre ${rot(periodoAnterior!)} e ${rot(p)})`
        : `Dívida no fim do período (${rot(p)})`,
      valor: brl(dividaMedia),
      bruto: dividaMedia,
    },
    { rotulo: "Custo da dívida da empresa", valor: `${pct(custo)} ao ano`, bruto: custo, destaque: true },
    { rotulo: "Referência de mercado para crédito PJ", valor: `${pct(referencia)} ao ano`, bruto: referencia },
    {
      rotulo: diferenca >= 0 ? "Quanto a diferença custa por ano" : "Quanto a diferença economiza por ano",
      valor: brl(Math.abs(efeitoAno)),
      bruto: efeitoAno,
    },
  ];

  const alavancagem = ind(dados, NOME_ALAVANCAGEM, p);
  const cobertura = ind(dados, NOME_COBERTURA_JUROS, p);
  // O perfil de risco fica VISÍVEL ao lado do desvio: é com ele que o leitor
  // julga se o prêmio é preço de risco ou barganha não exercida.
  if (alavancagem !== null && alavancagem > 0) {
    linhas.push({ rotulo: "Alavancagem da empresa", valor: `${mult(alavancagem)} EBITDA`, bruto: alavancagem });
  }
  if (cobertura !== null) {
    linhas.push({ rotulo: "Cobertura de juros (EBIT ÷ juros)", valor: mult(cobertura), bruto: cobertura });
  }

  const difPP = Math.abs(diferenca * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const abertura = `A empresa paga ${pct(custo)} ao ano pela dívida, ${difPP} pontos percentuais ${diferenca > 0 ? "acima" : "abaixo"} da referência de mercado para crédito PJ (${pct(referencia)}).`;

  const resposta = diferenca <= 0
    ? `${abertura} Sobre a dívida média de ${brl(dividaMedia)}, são ${brl(Math.abs(efeitoAno))} por ano a menos do que custaria no preço de mercado.`
    : perfilFolgado
      // Risco baixo pagando prêmio: aqui o desvio é sinal de barganha não exercida.
      ? `${abertura} Sobre a dívida média de ${brl(dividaMedia)}, a diferença custa ${brl(Math.abs(efeitoAno))} por ano. O risco desta empresa não explica o prêmio: alavancagem e cobertura de juros estão em faixa confortável, o que dá margem para renegociar taxa.`
      : perfilApertado
        // Risco elevado: o prêmio provavelmente É o preço do risco.
        ? `${abertura} Sobre a dívida média de ${brl(dividaMedia)}, a diferença custa ${brl(Math.abs(efeitoAno))} por ano — mas o perfil de risco da empresa ajuda a explicar o prêmio. Aqui a taxa costuma ceder depois da alavancagem, não antes dela.`
        : `${abertura} Sobre a dívida média de ${brl(dividaMedia)}, a diferença custa ${brl(Math.abs(efeitoAno))} por ano. Antes de concluir que está cara, confira a composição da dívida e a data de contratação: parte do desvio pode ser preço de risco ou taxa de outra época.`;

  return {
    id: "custo-divida",
    titulo: "Sua dívida está cara?",
    pergunta: "O que a empresa paga de juros está acima ou abaixo do mercado?",
    status,
    resposta,
    linhas,
    premissas: [
      "A linha \"Despesas Financeiras\" da DRE costuma trazer IOF, tarifas bancárias, descontos concedidos e variação cambial junto com o juro: o custo calculado é aproximação POR CIMA do juro contratado.",
      "A referência é NACIONAL para crédito PJ (CDI + spread médio das operações de crédito, série do Banco Central), válida para o mercado inteiro — não é a média do ramo de atividade desta empresa, nem do porte dela.",
      dividaAnterior !== null && dividaAnterior > 0
        ? `Dívida média = média simples entre o saldo de ${rot(periodoAnterior!)} (${brl(dividaAnterior)}) e o de ${rot(p)} (${brl(dividaAtual)}), nas quatro contas de dívida (empréstimos e partes relacionadas, curto e longo prazo).`
        // Cobre os DOIS casos em que a média não se forma: período anterior
        // inexistente na série e período anterior sem saldo de dívida. Dizer "só
        // um período disponível" no segundo caso seria descrever errado a base.
        : `Não há saldo de dívida no período anterior para formar a média: a base é o saldo do próprio período (${brl(dividaAtual)}). Se a dívida foi tomada no meio do caminho, o custo apurado sai menor que o real.`,
      "Dívida com partes relacionadas costuma não pagar juro: quando ela pesa na dívida média, o custo apurado sai menor que o juro efetivamente pago ao banco.",
      ...(parcial
        ? [`O período cobre ${dias} dias, não um ano: a despesa financeira foi anualizada (×${fatorAno.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}) para comparar com uma taxa anual, supondo o mesmo ritmo nos meses restantes.`]
        : []),
      "A referência é a taxa de HOJE; a dívida foi contratada ao longo dos últimos anos, com o CDI de cada época. Parte da diferença pode ser calendário, não gestão.",
      "A referência mistura capital de giro, desconto de duplicata e linhas subsidiadas (BNDES). Empresa com dívida concentrada em giro de curto prazo tende a pagar acima dela por natureza; com linha subsidiada, abaixo.",
      "Isto NÃO é um rating de crédito: aponta onde olhar, não decide se a taxa é justa. Taxa justa depende de garantia, relacionamento bancário e histórico, que não estão na contabilidade.",
      "Não substitui a leitura dos contratos: taxa, prazo e garantia de cada operação não estão na contabilidade.",
    ],
  };
}

// ── Card 5: crescer sem captar ────────────────────────────────────────────────

/**
 * QUANTO DÁ PARA CRESCER SEM DINHEIRO NOVO (taxa de crescimento sustentável).
 *
 *   SGR = ROE × retenção, com retenção = 1 − (retirada do período ÷ lucro líquido)
 *
 * O caso que motivou o card: empresa que distribui quase tudo tem SGR perto de
 * zero e mesmo assim cresce em receita — o crescimento veio de dívida ou de
 * fornecedor, não do próprio lucro. Um número seco ("0,4%") não conta essa
 * história; o texto conta.
 *
 * RÉGUA DO STATUS: prejuízo → crítico (não há lucro para reter). Crescimento real
 * acima do sustentável por mais de 2 pontos percentuais → atenção: a diferença foi
 * financiada por alguém. SGR praticamente zero → atenção. O semáforo de
 * alavancagem do motor pode piorar o veredicto, nunca melhorar: crescer financiado
 * com a alavancagem já acesa é outra conversa.
 */
function cardCrescerSemCaptar(
  dados: DadosParaCards,
  p: string,
  dias: number,
  rot: (p: string) => string,
): CardDecisao | null {
  const roe = ind(dados, NOME_ROE, p);
  if (roe === null) return null; // sem ROE não há taxa sustentável — e não se estima uma

  const lucro = ind(dados, "Lucro Líquido", p) ?? valOpt(dados.dre ?? [], "Lucro Líquido", p);
  const crescimentoReal = ind(dados, NOME_CRESCIMENTO, p);
  const parcial = dias < 360;

  // Retirada = a MESMA linha que o card de distribuição lê (ΔPL − lucro − Δ capital):
  // inclui dividendos e demais ajustes do PL, que é o que de fato saiu do patrimônio.
  const linhaRetirada = dados.fluxoCaixa?.fcf?.find((l) => /dividendo|ajustes do pl/i.test(l.nome));
  const valorRetirada = linhaRetirada?.valores?.[p] ?? null;
  const retirada = typeof valorRetirada === "number" && valorRetirada < 0 ? Math.abs(valorRetirada) : 0;
  const temLinhaRetirada = linhaRetirada !== undefined && typeof valorRetirada === "number";

  if (lucro === null || lucro <= 0) {
    // Sem lucro não existe retenção: a fórmula perde o sentido e o card diz o que
    // acontece de verdade — todo crescimento, aqui, vem de fora.
    return {
      id: "crescer-sem-captar",
      titulo: "Quanto dá para crescer sem dinheiro novo",
      pergunta: "Até quanto a empresa cresce se financiando sozinha?",
      status: "critico",
      resposta: lucro === null
        ? `Não é possível calcular a taxa de crescimento sustentável: o lucro líquido do período (${rot(p)}) não está disponível na base.`
        : `Sem lucro no período (${rot(p)}) não há o que reter: qualquer crescimento hoje é financiado por dívida, por fornecedor ou por aporte do sócio — não pelo resultado da própria operação.`,
      linhas: [
        { rotulo: `ROE (${rot(p)})`, valor: pct(roe), bruto: roe },
        ...(lucro !== null ? [{ rotulo: `Lucro líquido (${rot(p)})`, valor: brl(lucro), bruto: lucro }] : []),
        ...(crescimentoReal !== null
          ? [{ rotulo: "Crescimento da receita no período", valor: pct(crescimentoReal), bruto: crescimentoReal }]
          : []),
      ],
      premissas: [
        "A taxa de crescimento sustentável (ROE × retenção do lucro) pressupõe lucro positivo — com prejuízo o patrimônio encolhe em vez de financiar crescimento.",
        ...(crescimentoReal !== null
          ? ["O crescimento da receita mostrado é o realizado no período, medido pelo motor — não uma projeção."]
          : []),
      ],
    };
  }

  const payout = retirada / lucro;
  const retencao = 1 - payout;
  const sgr = roe * retencao;
  /**
   * "Distribui quase tudo" é o caso que motivou o card, e ele se reconhece pelo
   * PAYOUT, não pelo SGR: com ROE alto, reter 5% ainda dá um número que parece
   * crescimento. A régua é a política de distribuição (≥ 90% do lucro sai) — ou
   * um SGR que já nasce colado no zero, quando o ROE também é baixo.
   */
  const distribuiQuaseTudo = payout >= 0.9 || sgr < 0.005;
  const financiado = crescimentoReal !== null && crescimentoReal > sgr + 0.02;

  const statusBase: StatusCard = financiado || distribuiQuaseTudo ? "atencao" : "ok";
  const status = pior(statusBase, indStatus(dados, NOME_ALAVANCAGEM, p));

  const linhas: LinhaCard[] = [
    { rotulo: `ROE (${rot(p)})`, valor: pct(roe), bruto: roe },
    {
      rotulo: temLinhaRetirada ? `Retirada do período (${rot(p)})` : "Retirada do período (não registrada)",
      valor: retirada > 0 ? `-${brl(retirada)}` : brl(0),
      bruto: -retirada,
    },
    { rotulo: "Distribuído sobre o lucro (payout)", valor: pct(payout), bruto: payout },
    { rotulo: "Retido no negócio", valor: pct(retencao), bruto: retencao },
    {
      // TAXA NEGATIVA NÃO É PREVISÃO. Distribuindo MAIS do que ganhou, a conta
      // devolve um número negativo que se lê como "vai encolher 40,7% ao ano" —
      // e não é isso: é o patrimônio diminuindo porque a retirada passou do
      // lucro. Mesma disciplina do card de qualidade do lucro, onde prejuízo não
      // vira taxa de conversão: quando a fórmula perde o sentido, diz-se o fato.
      rotulo: "Crescimento sustentável ao ano",
      valor: retencao < 0 ? "não se aplica — o patrimônio encolheu no período" : pct(sgr),
      bruto: retencao < 0 ? null : sgr,
      destaque: true,
    },
    ...(crescimentoReal !== null
      ? [{ rotulo: "Crescimento da receita no período", valor: pct(crescimentoReal), bruto: crescimentoReal }]
      : []),
  ];

  const abre = retencao <= 0
    ? `A empresa distribuiu ${pct(payout)} do lucro do período — mais do que ganhou. Sem retenção não há crescimento que se pague sozinho: o patrimônio encolheu.`
    : distribuiQuaseTudo
      ? `A empresa distribui praticamente tudo que ganha (${pct(payout)} do lucro): sobra ${pct(retencao)} no negócio, e com ROE de ${pct(roe)} isso sustenta só ${pct(sgr)} de crescimento ao ano por conta própria.`
      : `Retendo ${pct(retencao)} do lucro, com ROE de ${pct(roe)}, a empresa cresce até ${pct(sgr)} ao ano sem dívida nova nem aporte.`;

  const fecha = financiado
    ? ` A receita cresceu ${pct(crescimentoReal!)} no período — acima disso. A diferença não veio do lucro retido: veio de dívida, de prazo de fornecedor ou de aporte.`
    : crescimentoReal !== null && crescimentoReal > 0
      ? ` A receita cresceu ${pct(crescimentoReal)} no período, dentro do que o próprio resultado sustenta.`
      : "";

  return {
    id: "crescer-sem-captar",
    titulo: "Quanto dá para crescer sem dinheiro novo",
    pergunta: "Até quanto a empresa cresce se financiando sozinha?",
    status,
    resposta: `${abre}${fecha}`,
    linhas,
    premissas: [
      "Taxa de crescimento sustentável = ROE × parcela do lucro retida. Supõe margem, giro do ativo e alavancagem CONSTANTES: é o quanto o patrimônio cresce sozinho, não uma meta de vendas.",
      temLinhaRetirada
        ? `Retirada do período = variação do patrimônio líquido menos o lucro e menos a variação de capital social, do fluxo de caixa indireto: inclui dividendos e outros ajustes do patrimônio.`
        : "Não há linha de dividendos/ajustes do patrimônio no fluxo de caixa deste período: o cálculo ASSUME retenção total do lucro. Se houve distribuição não registrada, a taxa real é menor.",
      "O payout usado é o DESTE período: uma distribuição extraordinária (ou um ano sem distribuir) derruba ou infla a taxa e não descreve a política recorrente.",
      "ROE do período, da aba Indicadores — lucro líquido sobre patrimônio líquido de fechamento, sem média do patrimônio.",
      ...(parcial
        ? [`O período cobre ${dias} dias, não um ano: ROE e retirada são do acumulado desses meses, então a taxa sai menor que a de um exercício cheio.`]
        : []),
      ...(crescimentoReal !== null
        ? ["O crescimento da receita comparado é o realizado (variação vs. o período anterior), medido pelo motor."]
        : ["Não há crescimento de receita calculado para este período: sem período anterior comparável, o card não confronta a taxa sustentável com o crescimento real."]),
    ],
  };
}

// ── Card 6: reinvestimento (capex ÷ D&A) ──────────────────────────────────────

function cardReinvestimento(dados: DadosParaCards, rot: (p: string) => string): CardDecisao | null {
  const fc = dados.fluxoCaixa;
  if (!fc?.colunas?.length) return null;
  const linhaCapex = fc.fci?.find((l) => /capex/i.test(l.nome));
  if (!linhaCapex) return null;

  const linhas: LinhaCard[] = [];
  let abaixoDeUm = 0;
  let comparaveis = 0;
  for (const col of fc.colunas) {
    const capex = Math.abs(linhaCapex.valores?.[col] ?? 0);
    const da = Math.abs(val(dados.dre ?? [], "Depreciação e Amortização", col));
    if (da <= 0.005) continue;
    const razao = capex / da;
    comparaveis++;
    if (razao < 1) abaixoDeUm++;
    linhas.push({
      rotulo: rot(col),
      valor: `${razao.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}x  (investiu ${brl(capex)} · depreciou ${brl(da)})`,
      bruto: razao,
    });
  }
  if (comparaveis === 0) return null;

  const todosAbaixo = abaixoDeUm === comparaveis;
  const status: StatusCard = todosAbaixo && comparaveis >= 2 ? "atencao" : "ok";
  const resposta = todosAbaixo
    ? `A empresa investe menos do que consome os próprios ativos em ${comparaveis === 1 ? "o período" : `todos os ${comparaveis} períodos`} — a capacidade produtiva está encolhendo no papel.`
    : `Reinvestimento acima da depreciação em ${comparaveis - abaixoDeUm} de ${comparaveis} período(s) — a base de ativos se mantém.`;

  return {
    id: "reinvestimento",
    titulo: "Reinvestimento",
    pergunta: "Estou repondo o que gasto dos meus ativos?",
    status,
    resposta,
    linhas,
    premissas: [
      "Capex estimado pelo fluxo de caixa indireto (variação do imobilizado/intangível + depreciação do período).",
      "Abaixo de 1,0x por vários anos indica sucateamento — a menos que a operação esteja migrando para ativos de terceiros (aluguel, serviços).",
    ],
  };
}

// ── Card 4: qualidade do lucro ────────────────────────────────────────────────

function cardQualidadeLucro(dados: DadosParaCards, rot: (p: string) => string): CardDecisao | null {
  const fc = dados.fluxoCaixa;
  if (!fc?.colunas?.length) return null;
  const linhas: LinhaCard[] = [];
  let somaLucro = 0;
  let somaFco = 0;
  let comparaveis = 0;

  for (const col of fc.colunas) {
    const provaOk = fc.prova?.find((x) => x.periodo === col)?.fecha;
    if (!provaOk) continue;
    const lucro = val(dados.dre ?? [], "Lucro Líquido", col);
    const fco = fc.totais?.fco?.[col];
    if (typeof fco !== "number" || Math.abs(lucro) < 0.005) continue;
    comparaveis++;
    somaLucro += lucro;
    somaFco += fco;
    linhas.push({
      rotulo: rot(col),
      // Duas casas FIXAS: lado a lado, "0,9x" e "0,79x" parecem escalas diferentes.
      valor: `lucro ${brl(lucro)} · caixa da operação ${brl(fco)} (${(fco / lucro).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}x)`,
      bruto: lucro !== 0 ? fco / lucro : null,
    });
  }
  if (comparaveis === 0 || Math.abs(somaLucro) < 0.005) return null;

  // PREJUÍZO NÃO TEM TAXA DE CONVERSÃO. Dividir caixa por lucro negativo produz
  // número sem significado: prejuízo de 2 mi com FCO de +1 mi daria -0,5 e o card
  // gritaria "crítico" numa operação que gera caixa; com os dois negativos daria
  // razão POSITIVA e o card diria "o lucro vira caixa" para quem perdeu dinheiro.
  // Com prejuízo o que importa é outra pergunta: a operação sustenta o caixa?
  if (somaLucro < 0) {
    const sustenta = somaFco > 0;
    return {
      id: "qualidade-lucro",
      titulo: "Qualidade do lucro",
      pergunta: "O resultado da DRE virou dinheiro no banco?",
      status: sustenta ? "atencao" : "critico",
      resposta: sustenta
        ? `A empresa deu prejuízo de ${brl(Math.abs(somaLucro))} no acumulado, mas a operação ainda gerou ${brl(somaFco)} de caixa — o prejuízo está concentrado em despesas que não consomem caixa hoje.`
        : `Prejuízo de ${brl(Math.abs(somaLucro))} no acumulado e a operação também consumiu ${brl(Math.abs(somaFco))} de caixa: o resultado negativo está saindo do bolso.`,
      linhas,
      premissas: [
        "Com prejuízo não existe taxa de conversão de lucro em caixa — o card compara os dois valores em vez de dividir um pelo outro.",
        "Considera os períodos em que a prova do fluxo de caixa fecha.",
      ],
    };
  }

  const conversao = somaFco / somaLucro;
  const status: StatusCard = conversao < 0.5 ? "critico" : conversao < 0.8 ? "atencao" : "ok";
  const resposta = conversao < 0.8
    ? `De cada R$ 1,00 de lucro, apenas ${(conversao).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} viraram caixa no acumulado — o resultado está preso em giro ou em receita que não entrou.`
    : `O lucro vira caixa: ${(conversao).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} de caixa operacional para cada R$ 1,00 de lucro no acumulado.`;

  return {
    id: "qualidade-lucro",
    titulo: "Qualidade do lucro",
    pergunta: "O lucro que aparece na DRE virou dinheiro no banco?",
    status,
    resposta,
    linhas,
    premissas: [
      "Compara o lucro líquido com o caixa gerado pela operação, nos períodos em que a prova do fluxo de caixa fecha.",
      "Abaixo de 0,8x de forma persistente: o resultado depende de prazo (cliente que não pagou) ou de receita não-caixa.",
    ],
  };
}

// ── Card 5: mesa de sensibilidade ─────────────────────────────────────────────

function cardSensibilidade(dados: DadosParaCards, p: string, dias: number): CardDecisao | null {
  const receita = val(dados.dre ?? [], "Receita Líquida", p);
  const custo = Math.abs(val(dados.dre ?? [], "Custo Operacional", p));
  if (receita <= 0) return null;

  const receitaDia = receita / dias;
  const custoDia = custo > 0 ? custo / dias : null;
  // ANUALIZA quando o período é parcial (balancete YTD de 5 meses, por exemplo):
  // dizer "por ano" sobre a receita de 5 meses subestima o efeito em 2,4x. O
  // período cheio passa direto (fator 1), e a premissa declara o que foi feito.
  const parcial = dias < 360;
  const fatorAno = 365 / dias;
  const umPontoMargem = receita * 0.01 * fatorAno;
  const cincoPorCentoReceita = receita * 0.05;

  const linhas: LinhaCard[] = [
    { rotulo: "1 dia a menos para receber do cliente", valor: `${brl(receitaDia)} de caixa liberado`, bruto: receitaDia, destaque: true },
    ...(custoDia !== null
      ? [{ rotulo: "1 dia a mais para pagar fornecedor", valor: `${brl(custoDia)} de caixa liberado`, bruto: custoDia },
         { rotulo: "1 dia a menos de estoque", valor: `${brl(custoDia)} de caixa liberado`, bruto: custoDia }]
      : []),
    { rotulo: "1 ponto percentual de margem", valor: `${brl(umPontoMargem)} por ano no resultado`, bruto: umPontoMargem },
    { rotulo: "5% de receita", valor: `${brl(cincoPorCentoReceita)} de faturamento no período`, bruto: cincoPorCentoReceita },
  ];

  return {
    id: "sensibilidade",
    titulo: "O que cada movimento vale",
    pergunta: "Onde colocar energia primeiro — prazo, margem ou volume?",
    status: "informativo",
    resposta: `Cada dia a menos no prazo de recebimento libera ${brl(receitaDia)}; cada ponto de margem vale ${brl(umPontoMargem)} por ano.`,
    linhas,
    premissas: [
      `Base: receita e custo do período de referência, divididos por ${dias} dias.`,
      ...(parcial
        ? [`O período de referência cobre ${dias} dias, não um ano: o efeito da margem foi anualizado (×${fatorAno.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}) e supõe o mesmo ritmo nos meses restantes.`]
        : []),
      "O efeito de 5% de receita no RESULTADO depende da estrutura de custos (fixo × variável), que a base contábil não marca — por isso aqui só o efeito no faturamento.",
    ],
  };
}

// ── Montagem ──────────────────────────────────────────────────────────────────

export function montarCardsDecisao(
  dados: DadosParaCards,
  opts?: {
    covenants?: CovenantParaCard[];
    premissas?: PremissasDecisao;
    periodo?: string;
    /** Referências externas (banco de benchmarks). Ausente = o card que depende
     *  delas não aparece — comparar com número inventado é pior que não comparar. */
    benchmarks?: BenchmarksParaCards;
  },
): { periodo: string; periodoRotulo: string; cards: CardDecisao[] } | null {
  const periodos = [...(dados.periodos ?? [])];
  if (periodos.length === 0) return null;
  const ytd = new Set((dados.arvoresBalancete ?? []).map((a) => a?.periodo).filter(Boolean) as string[]);
  const ordenar = (a: string, b: string): number => {
    const key = (p: string): number => {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(p);
      if (m) return Number(`${m[3]}${m[2]}${m[1]}`);
      const y = /^(\d{4})$/.exec(p);
      return y ? Number(`${y[1]}0000`) : 0;
    };
    return key(a) - key(b);
  };
  const p = opts?.periodo && periodos.includes(opts.periodo) ? opts.periodo : [...periodos].sort(ordenar).pop()!;
  // Dias-base correto por período: balancete YTD usa mês×30 — assumir 365 num
  // acumulado de 5 meses infla prazos e desembolso em ~2,4x.
  const dias = ytd.has(p) ? diasYTD(p) : diasDoPeriodo(p, periodos.filter((x) => !ytd.has(x) || x === p));
  const premissas = opts?.premissas ?? {};
  // RÓTULO, não chave: "2024" e "05/2026" — nunca "31/12/2024" na cara do leitor
  // (regra do dono). Balancete ACUMULADO que fecha em dezembro É o exercício e se
  // lê "2024"; só o que para no meio do ano vira mês ("05/2026"). Forçar mês em
  // todo balancete rotulava ano cheio como "12/2024" — o próprio dono viu.
  const rot = (x: string): string => rotuloPeriodoSrv(x, ytd.has(x) && !/^\d{2}\/12\//.test(x));

  // Período IMEDIATAMENTE anterior na série ordenada — base da dívida média do
  // custo da dívida (a despesa é do período inteiro; o saldo de uma data só, não).
  const ordenados = [...periodos].sort(ordenar);
  const idxAtual = ordenados.indexOf(p);
  const periodoAnterior = idxAtual > 0 ? ordenados[idxAtual - 1]! : null;
  const custoRef = opts?.benchmarks?.custoMedioDivida;

  const cards = [
    cardDistribuicao(dados, p, dias, premissas),
    cardCovenants(dados, p, opts?.covenants ?? []),
    cardHeadroomCaptacao(dados, p, dias, opts?.covenants ?? [], rot),
    typeof custoRef === "number" && Number.isFinite(custoRef) && custoRef > 0
      ? cardCustoDivida(dados, p, dias, custoRef, rot, periodoAnterior)
      : null,
    cardCrescerSemCaptar(dados, p, dias, rot),
    cardReinvestimento(dados, rot),
    cardQualidadeLucro(dados, rot),
    cardSensibilidade(dados, p, dias),
  ].filter((c): c is CardDecisao => c !== null);

  // O RÓTULO vai junto: a tela sabe que 31/12 é fim de exercício, mas não sabe
  // que ESTE período veio de um balancete acumulado. Sem isto o cabeçalho dizia
  // "2026" e as linhas do mesmo card diziam "12/2026".
  return cards.length ? { periodo: p, periodoRotulo: rot(p), cards } : null;
}
