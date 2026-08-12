/**
 * CASCATA DE EXTRAÇÃO — FONTE ÚNICA (10/08/2026).
 *
 * Este arquivo é a MUDANÇA de endereço da cascata que vivia dentro do
 * `POST /analyses/:id/process`. O motor não mudou: são as mesmas funções, na
 * mesma ordem, com o mesmo critério de decisão. O que muda é quem pode chamar.
 *
 * POR QUÊ (pergunta do dono, 10/08/2026: "no IBR estava funcionando tudo
 * normalmente, porque agora está com estes erros bobos?"): a porta da Data room
 * nasceu com uma versão SIMPLIFICADA — parser determinístico e UMA chamada de
 * IA em texto. Sem o gate de integridade e sem o degrau da visão, um balanço
 * que o Haiku lê pela metade (caso Dunamys/Move Farma: BP sem NENHUMA conta de
 * passivo) era publicado como se fosse fato. O IBR nunca aceitou isso: ele
 * PONTUA o resultado (equação patrimonial + composição do ativo + composição do
 * passivo + detalhe + DRE reconciliando) e, enquanto não fecha 5/5, escala —
 * Haiku no texto, depois Sonnet lendo o PDF original.
 *
 * Regra da casa: dois caminhos para o mesmo trabalho divergem sempre. Agora é um.
 *
 * CASCATA (cheapest-first, para no primeiro nível que FECHA 5/5):
 *   1. heurístico — parser determinístico, custo zero;
 *   2. híbrido    — Haiku sobre o texto do parser;
 *   3. visão      — Sonnet lendo o PDF original (último recurso, só PDF).
 * Nenhum fechou? Vence o de maior score, e a trava mostra vermelho na tela.
 */
import type { BPLineItem, DRELineItem, UnmatchedAccount } from "../types/financial";
import type { ExtractedRow, ParsedDocument } from "./parser";
import {
  mapExtractedToBP, mapExtractedToDRE, detectPeriodos, normalizeDRESigns, recomputeDRESubtotals,
  sugerirConta, type DictionaryEntry, type BPModel,
} from "./account-mapper";
import { DRE_TEMPLATE } from "./financial-templates";
import { validateFinancialData } from "./validation";
import { extractFinancialsWithAI, type NaoMapeado } from "./ai-extraction";
import { provarCobertura, type Cobertura } from "./prova-cobertura";
import type { DREModel } from "./model-version";

/** Documento pronto para a cascata. `buffer` é preguiçoso: só a visão baixa. */
export interface DocParaCascata {
  nome: string;
  tipo: string;
  parsed: ParsedDocument;
  /** Baixa o arquivo original — chamado SÓ se a cascata chegar à visão. */
  buffer?: () => Promise<Buffer>;
  /** Documento editado à mão / reaproveitado de cache: fora da visão. */
  pularVisao?: boolean;
}

export interface OpcoesCascata {
  dictForBP: DictionaryEntry[];
  dictForDRE: DictionaryEntry[];
  bpModel: BPModel;
  dreModel: DREModel;
  /** env.ibr.hibridoAtivo — desligado, a cascata para no heurístico. */
  hibridoAtivo: boolean;
  /** Rótulo para o log ("process" | "porta"). */
  origem?: string;
  /**
   * O que este lote PODE provar. "auto" (default) = as 5 provas de sempre —
   * é o que o /process usa e nada muda lá. A porta, que lê documento a
   * documento, declara "BP" ou "DRE" para não cobrar do documento uma prova
   * que ele não tem como dar (e não queimar IA atrás dela).
   */
  escopo?: EscopoRegua;
  /**
   * Quem consome a ÁRVORE ORIGINAL (a porta da Data room) precisa dizer aqui.
   * O nível heurístico não constrói árvore: sem esta flag ele venceria empates
   * e "fecharia" a cascata, e a leitura viraria erro depois de a IA já ter
   * pago. O /process NÃO liga (consome bp/dre) — nada muda lá.
   */
  exigeArvore?: boolean;
}

/** Escopo da régua de integridade — ver `escopo` em OpcoesCascata. */
export type EscopoRegua = "auto" | "BP" | "DRE";

export interface CandidatoCascata {
  fonte: "heuristico" | "hibrido" | "visao";
  bp: BPLineItem[];
  dre: DRELineItem[];
  periodos: string[];
  declarados: Record<string, Record<string, number>>;
  /** N3 não mapeados p/ a tela manual (só das vias com IA; heurístico = []). */
  unmatched: UnmatchedAccount[];
  arvoreBP: unknown;
  arvoreDRE: unknown;
  naoMapeados: unknown[];
  alertasComposicao: unknown[];
  custoUsd: number;
  validacao: ReturnType<typeof validateFinancialData>;
  /** Toda conta do documento chegou na árvore? Ver services/prova-cobertura. */
  cobertura: Cobertura;
  score: number;
  /** Teto do score no escopo usado (5 = auto · 4 = BP · 1 = DRE). */
  scoreMax: number;
  fecha: boolean;
}

export interface ResultadoCascata {
  escolhido: CandidatoCascata;
  custos: Array<{ fonte: string; usd: number }>;
  custoTotalUsd: number;
}

/** Auto-detect do tipo — CONTEÚDO primeiro, `tipo` declarado como reserva. */
export function detectDocType(doc: ParsedDocument): "BP" | "DRE" | "BOTH" | "UNKNOWN" {
  const raw = doc.raw.toLowerCase();
  const hasBP = raw.includes("ativo circulante") || raw.includes("passivo circulante") || raw.includes("a t i v o");
  // Palavras da DRE específicas o bastante para NÃO casar com nome de conta do BP.
  // Evitar: "prejuizo" (casa "LUCROS OU PREJUIZOS ACUMULADOS"), "resultado do
  // exerc" (casa a seção do PL), "despesas operacionais"/"lucro bruto" (genéricos).
  const hasDRE = raw.includes("receita bruta") || raw.includes("resultado liquido") ||
                 raw.includes("custo operacional") || raw.includes("custo produtos vendidos") ||
                 raw.includes("demonstrativo de resultado") || raw.includes("demonstração do resultado") ||
                 raw.includes("receita de vendas") || raw.includes("deducoes da receita") ||
                 raw.includes("deduções da receita") || raw.includes("despesas com vendas") ||
                 raw.includes("receita operacional líquida") || raw.includes("custo das mercadorias");

  if (hasBP && hasDRE) return "BOTH";
  if (hasBP) return "BP";
  if (hasDRE) return "DRE";

  const tipoNorm = doc.tipo.toLowerCase();
  if (tipoNorm.includes("balan") || tipoNorm.includes("balancete")) return "BP";
  if (tipoNorm.includes("dre") || tipoNorm.includes("resultado") || tipoNorm.includes("demonstra")) return "DRE";
  return "UNKNOWN";
}

/** Mescla por conta preservando o que já tem valor (o primeiro doc manda). */
export function mergeItensPorConta<T extends { conta: string; valores: Record<string, number> }>(existing: T[], newItems: T[]): void {
  const map = new Map<string, T>();
  for (const item of existing) map.set(item.conta, item);
  for (const novo of newItems) {
    const alvo = map.get(novo.conta);
    if (alvo) {
      for (const [periodo, valor] of Object.entries(novo.valores)) {
        if (alvo.valores[periodo] === undefined || alvo.valores[periodo] === 0) alvo.valores[periodo] = valor;
      }
    } else {
      existing.push(novo);
      map.set(novo.conta, novo);
    }
  }
}

/** Texto limpo p/ o LLM: contexto > conta = valores. */
export const linhasToText = (linhas: ExtractedRow[]): string =>
  linhas.map((l) => `${l.contexto ? l.contexto + " > " : ""}${l.conta} = ${JSON.stringify(l.valores)}`).join("\n");

/** SÓ PDF vai para a visão: `ask()` manda o buffer como application/pdf — um
 *  xlsx/csv nessa lista derruba a chamada inteira (e com ela o degrau todo). */
const ehPDF = (nome: string): boolean => /\.pdf$/i.test(nome.trim());

/**
 * N3 não mapeados → tela manual de classificação. NUNCA folhas N4+ (a soma
 * delas já está no N3: ofertar as duas dobraria o valor ao reclassificar).
 * A sugestão do BP é filtrada POR LADO do grupo — nunca cruza Ativo↔Passivo.
 * Exportada porque a rota do IBR também a usa nos balancetes.
 */
export function paraTelaManual(bpModel: BPModel): (naoMapeados: NaoMapeado[]) => UnmatchedAccount[] {
  const candidatosDRE = DRE_TEMPLATE.filter((t) => !t.subtotal).map((t) => t.conta);
  const candidatosBPdoGrupo = (grupo: string): string[] => {
    const lado = grupo.startsWith("Ativo") ? "A" : grupo.startsWith("Passivo") ? "P" : grupo.startsWith("Patrim") ? "PL" : null;
    if (!lado) return bpModel.names;
    return bpModel.lines
      .filter((l) => l.tipo === "input" && (lado === "PL" ? l.classificacao === "PL" : lado === "P" ? (l.classificacao[0] === "P" && l.classificacao !== "PL") : l.classificacao[0] === "A"))
      .map((l) => l.conta);
  };
  return (naoMapeados: NaoMapeado[]): UnmatchedAccount[] => {
    const byKey = new Map<string, UnmatchedAccount>();
    for (const nm of naoMapeados) {
      if (nm?.tipo !== "BP" && nm?.tipo !== "DRE") continue;
      const key = `${nm.tipo}|${nm.nome}`;
      const contexto = nm.tipo === "BP" ? nm.grupo : `Hoje em: ${nm.destino}`;
      const sugestao = sugerirConta(nm.nome, nm.tipo === "BP" ? candidatosBPdoGrupo(nm.grupo) : candidatosDRE) ?? undefined;
      const cur = byKey.get(key) ?? { conta: nm.nome, valores: {}, contexto, tipo: nm.tipo, sugestao };
      cur.valores[nm.periodo] = (cur.valores[nm.periodo] ?? 0) + nm.valor;
      byKey.set(key, cur);
    }
    return [...byKey.values()];
  };
}

export async function extrairComCascata(
  docs: DocParaCascata[],
  opts: OpcoesCascata,
): Promise<ResultadoCascata> {
  const { dictForBP, dictForDRE, bpModel, dreModel, hibridoAtivo } = opts;
  const dictAll = [...dictForBP, ...dictForDRE];
  const parsedDocs = docs.map((d) => d.parsed);

  const totalBP = (bp: BPLineItem[], conta: string, p: string) => bp.find((b) => b.conta === conta)?.valores[p] ?? 0;

  // RÉGUA COM ESCOPO (10/08/2026). O IBR sempre processa o LOTE do período —
  // BP e DRE juntos — então cobrar as cinco provas é justo. A porta lê UM
  // documento por vez: num DRE avulso não existe Ativo nem Passivo, `temDados`
  // era falso, TODO candidato ficava score 0 e a cascata pagava Haiku E Sonnet
  // para no fim descartar os dois (a troca exige score MAIOR). Com escopo, cada
  // documento é medido pelo que ele pode provar.
  //   "auto"   → o de sempre: 5 provas (comportamento do /process, intocado).
  //   "BP"     → 4 provas patrimoniais (a DRE não é assunto do documento).
  //   "DRE"    → 1 prova: a reconciliação contra os declarados do próprio doc,
  //              e aqui "não verificada" NÃO ganha ponto de graça.
  const escopo = opts.escopo ?? "auto";
  /**
   * PROVA NÃO VERIFICADA NÃO VALE PONTO (10/08/2026). Antes, `composicaoAtivo`
   * e `composicaoPassivo` comparavam AC+ANC com um "Ativo Total" que o próprio
   * fold definiu como AC+ANC — dois dos cinco pontos do portão eram de graça,
   * e a DRE sem declarados ganhava um terceiro (`!verificada || ok`).
   * Agora o TETO acompanha o que dá para provar: um documento que não imprime
   * total nenhum fecha "3/3" com honestidade, e a tela mostra quais provas
   * rodaram — em vez de fingir 5/5.
   */
  const provasDoEscopo = (v: ReturnType<typeof validateFinancialData>, cobertura: Cobertura): { score: number; max: number } => {
    const conta = (roda: boolean, passou: boolean): [number, number] => (roda ? [passou ? 1 : 0, 1] : [0, 0]);
    const somar = (...pares: Array<[number, number]>) => pares.reduce(
      (acc, [s, m]) => ({ score: acc.score + s, max: acc.max + m }), { score: 0, max: 0 },
    );
    const compA = conta(v.composicaoAtivoVerificada, v.composicaoAtivo);
    const compP = conta(v.composicaoPassivoVerificada, v.composicaoPassivo);
    const dre = conta(v.reconciliacaoDRE.verificada, v.reconciliacaoDRE.ok);
    // COBERTURA (11/08/2026) — a única prova de CONTAGEM. Todas as outras medem
    // SOMA e passam quando uma conta some dentro de um grupo, porque o total do
    // grupo não muda. Caso Move Farma: a leitura híbrida perdeu duas contas da
    // DRE e fechou 1/1 no escopo DRE. Vale nos três escopos: perder conta é
    // perder conta, seja no balanço, seja no resultado.
    const cob = conta(cobertura.verificavel, cobertura.ok);
    if (escopo === "BP") return somar([v.equacaoPatrimonial ? 1 : 0, 1], compA, compP, [v.detalheCompleto ? 1 : 0, 1], cob);
    if (escopo === "DRE") return somar(dre, cob);
    return somar([v.equacaoPatrimonial ? 1 : 0, 1], compA, compP, [v.detalheCompleto ? 1 : 0, 1], dre, cob);
  };

  // Normaliza/recalcula a DRE do candidato e roda a trava — base da decisão.
  // EXIGE DADOS REAIS: sem isso a validação marca equação=true VACUAMENTE e um
  // resultado VAZIO "fecharia". No escopo DRE o que prova vida é a própria DRE.
  /**
   * TOTAIS IMPRESSOS NO DOCUMENTO (10/08/2026). A captura já traz, em cada
   * período da árvore, o "Ativo Total"/"Passivo Total" que o contador imprimiu
   * — dado que estava morto no payload. Ele entra em `declarados` para virar a
   * PROVA CRUZADA de composição: montado × impresso, não montado × montado.
   */
  const comTotaisImpressos = (
    declarados: Record<string, Record<string, number>>,
    arvoreBP: unknown,
  ): Record<string, Record<string, number>> => {
    const out: Record<string, Record<string, number>> = { ...declarados };
    for (const [periodo, capa] of Object.entries((arvoreBP ?? {}) as Record<string, { totais?: Record<string, number> }>)) {
      const totais = capa?.totais;
      if (!totais) continue;
      for (const chave of ["Ativo Total", "Passivo Total"]) {
        const v = totais[chave];
        if (typeof v === "number" && v !== 0) (out[periodo] ??= { ...(declarados[periodo] ?? {}) })[chave] = v;
      }
    }
    return out;
  };

  /** Linhas que o parser determinístico leu no lote — testemunha da cobertura. */
  const linhasDoLote = parsedDocs.flatMap((d) => d.linhas);

  const avalia = (c: Omit<CandidatoCascata, "validacao" | "score" | "fecha" | "scoreMax" | "cobertura">): CandidatoCascata => {
    normalizeDRESigns(c.dre, c.periodos);
    recomputeDRESubtotals(c.dre, c.periodos, dreModel.extrasPorBloco);
    const v = validateFinancialData(c.bp, c.dre, c.periodos, comTotaisImpressos(c.declarados, c.arvoreBP));
    // A árvore do lote é BP + DRE: os dois lados juntos respondem por todas as
    // linhas que o parser viu (um documento só tem um dos dois, e aí o outro
    // está vazio e não atrapalha).
    const cobertura = provarCobertura(linhasDoLote, [c.arvoreBP, c.arvoreDRE]);
    const temBP = c.periodos.some((p) => totalBP(c.bp, "Ativo Total", p) !== 0 && totalBP(c.bp, "Passivo Total", p) !== 0);
    const temDRE = c.dre.some((d) => Object.values(d.valores).some((x) => Math.abs(x) > 0.5));
    const temDados = escopo === "DRE" ? temDRE : temBP;
    const { score: s, max } = provasDoEscopo(v, cobertura);
    const score = temDados ? s : 0;
    // `max === 0` significa que NENHUMA prova pôde rodar. Isso não é "fechou":
    // é "não provei nada" — e não pode encerrar a cascata nem pintar de verde.
    return { ...c, validacao: v, cobertura, score, scoreMax: max, fecha: temDados && max > 0 && score === max };
  };

  const declaradosDe = (dre: DRELineItem[], periodos: string[]) => {
    const decl: Record<string, Record<string, number>> = {};
    for (const p of periodos) for (const conta of ["Receita Líquida", "Lucro Bruto", "Lucro Líquido"]) {
      const v = dre.find((d) => d.conta === conta)?.valores[p] ?? 0;
      if (Math.abs(v) > 0.5) (decl[p] ??= {})[conta] = v;
    }
    return decl;
  };

  const naoMapeadosParaTela = paraTelaManual(bpModel);
  const temDadosIA = (r: { bp: BPLineItem[]; dre: DRELineItem[] }) =>
    r.bp.some((b) => Object.values(b.valores).some((v) => v)) || r.dre.some((d) => Object.values(d.valores).some((v) => v));

  // ── Nível 1 — PARSER determinístico (grátis) ──
  const rodaHeuristico = (): CandidatoCascata => {
    let bp: BPLineItem[] = [], dre: DRELineItem[] = [];
    const unm: UnmatchedAccount[] = [];
    for (const doc of parsedDocs) {
      const docType = detectDocType(doc);
      const tipoNorm = doc.tipo.toLowerCase();
      const querBP = docType === "BP" || docType === "BOTH" || (docType === "UNKNOWN" && doc.linhas.length > 0 && (tipoNorm.includes("balan") || tipoNorm.includes("balancete")));
      const querDRE = docType === "DRE" || docType === "BOTH" || (docType === "UNKNOWN" && doc.linhas.length > 0 && (tipoNorm.includes("dre") || tipoNorm.includes("resultado")));
      if (querBP) { const r = mapExtractedToBP(doc.linhas, dictForBP, bpModel); if (!bp.length) bp = r.items; else mergeItensPorConta(bp, r.items); unm.push(...r.unmatched); }
      if (querDRE) { const r = mapExtractedToDRE(doc.linhas, dictForDRE); if (!dre.length) dre = r.items; else mergeItensPorConta(dre, r.items); unm.push(...r.unmatched); }
    }
    const periodos = detectPeriodos(parsedDocs);
    const declarados = declaradosDe(dre, periodos);
    // unmatched do heurístico é folha profunda (N4+) → NUNCA vai p/ a tela.
    return avalia({ fonte: "heuristico", bp, dre, periodos, declarados, unmatched: [], arvoreBP: null, arvoreDRE: null, naoMapeados: [], alertasComposicao: [], custoUsd: 0 });
  };

  // ── Nível 2 — HÍBRIDO (parser → Haiku no texto → fold N3) ──
  const rodaHibrido = async (): Promise<CandidatoCascata | null> => {
    const aiDocs = parsedDocs.filter((d) => d.linhas.length > 0).map((d) => ({ raw: linhasToText(d.linhas), rawIndent: d.raw, linhas: d.linhas, tipo: d.tipo, periodos: d.periodos }));
    if (!aiDocs.length) return null;
    const r = await extractFinancialsWithAI(aiDocs, [], dictAll, bpModel, { dreModel });
    if (!temDadosIA(r)) return null;
    return avalia({ fonte: "hibrido", bp: r.bp, dre: r.dre, periodos: r.periodos, declarados: r.declarados, unmatched: naoMapeadosParaTela(r.naoMapeados as NaoMapeado[]), arvoreBP: r.arvoreOriginalBP, arvoreDRE: r.arvoreOriginalDRE, naoMapeados: r.naoMapeados, alertasComposicao: r.alertasComposicao, custoUsd: r.custo.usd });
  };

  // ── Nível 3 — VISÃO (Sonnet lê o PDF original). Caro: último recurso ──
  const rodaVisao = async (): Promise<CandidatoCascata | null> => {
    const visDocs: Array<{ buffer: Buffer; tipo: string; periodos: string[] }> = [];
    let ficouDeFora = false;
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i]!;
      if (d.pularVisao || !d.buffer) continue;
      // xlsx/csv derrubaria a chamada inteira (o buffer vai como PDF).
      if (!ehPDF(d.nome)) { ficouDeFora = true; continue; }
      visDocs.push({ buffer: await d.buffer(), tipo: d.tipo, periodos: parsedDocs[i]?.periodos ?? [] });
    }
    if (!visDocs.length) return null;
    // LOTE MISTO NÃO COMPETE (10/08/2026, revisão adversarial). A rota
    // MATERIALIZA o vencedor sem remesclar (`structuredBP = escolhido.bp`):
    // uma visão que leu só os PDFs venceria por score — inclusive ganhando o
    // ponto de graça da DRE "não verificada" — e a DRE que veio da planilha
    // sumiria em silêncio. Só compete quem viu o lote inteiro.
    if (ficouDeFora) return null;
    const r = await extractFinancialsWithAI(visDocs, [], dictAll, bpModel, { dreModel });
    if (!temDadosIA(r)) return null;
    return avalia({ fonte: "visao", bp: r.bp, dre: r.dre, periodos: r.periodos, declarados: r.declarados, unmatched: naoMapeadosParaTela(r.naoMapeados as NaoMapeado[]), arvoreBP: r.arvoreOriginalBP, arvoreDRE: r.arvoreOriginalDRE, naoMapeados: r.naoMapeados, alertasComposicao: r.alertasComposicao, custoUsd: r.custo.usd });
  };

  // QUEM PRECISA DE ÁRVORE (10/08/2026, revisão adversarial — achado crítico).
  // O nível heurístico mapeia direto para o modelo e NUNCA constrói a árvore
  // original. O /process não se importa (consome bp/dre; a árvore é auditoria),
  // mas a PORTA guarda a árvore — sem ela a leitura vira erro. Como a troca é
  // estrita (`score >` mantém o incumbente no empate), o heurístico sem árvore
  // vencia depois de a IA já ter pago e trazido árvore, e o documento virava
  // "não reconheceu a hierarquia". Com a flag, a porta declara que precisa.
  const temArvore = (c: CandidatoCascata): boolean =>
    Object.keys((c.arvoreBP ?? {}) as object).length > 0 || Object.keys((c.arvoreDRE ?? {}) as object).length > 0;
  const exigeArvore = opts.exigeArvore === true;
  /** Vence o novo? Com `exigeArvore`, ter árvore decide antes do score. */
  const superaOAtual = (novo: CandidatoCascata, atual: CandidatoCascata): boolean => {
    if (exigeArvore) {
      const a = temArvore(atual), n = temArvore(novo);
      if (n !== a) return n;
    }
    return novo.fecha || novo.score > atual.score;
  };
  /** Ainda vale escalar? Fechar sem árvore não serve a quem precisa dela. */
  const precisaEscalar = (c: CandidatoCascata): boolean => !c.fecha || (exigeArvore && !temArvore(c));

  const custos: Array<{ fonte: string; usd: number }> = [];
  let escolhido = rodaHeuristico();
  custos.push({ fonte: "parser", usd: 0 });
  // Escala enquanto NÃO fechar a integridade — 5/5 no lote, 4/4 no BP, 1/1 na DRE.
  if (precisaEscalar(escolhido) && hibridoAtivo) {
    try {
      const hib = await rodaHibrido();
      if (hib) { custos.push({ fonte: "hibrido", usd: hib.custoUsd }); if (superaOAtual(hib, escolhido)) escolhido = hib; }
    } catch (e) { console.error(`[${opts.origem ?? "cascata"}] híbrido falhou:`, e instanceof Error ? e.message : e); }
  }
  if (precisaEscalar(escolhido) && hibridoAtivo) {
    try {
      const vis = await rodaVisao();
      if (vis) { custos.push({ fonte: "visao", usd: vis.custoUsd }); if (superaOAtual(vis, escolhido)) escolhido = vis; }
    } catch (e) { console.error(`[${opts.origem ?? "cascata"}] visão falhou:`, e instanceof Error ? e.message : e); }
  }
  const custoTotalUsd = custos.reduce((s, c) => s + c.usd, 0);
  const vv = escolhido.validacao;
  console.log(`[${opts.origem ?? "cascata"}] cascata: venceu=${escolhido.fonte} fecha=${escolhido.fecha} score=${escolhido.score}/${escolhido.scoreMax} [eq=${vv.equacaoPatrimonial} cA=${vv.composicaoAtivo} cP=${vv.composicaoPassivo} det=${vv.detalheCompleto} dre=${JSON.stringify(vv.reconciliacaoDRE)} cob=${escolhido.cobertura.verificavel ? `${escolhido.cobertura.encontradas}/${escolhido.cobertura.totalDocumento}` : "n/v"}] | ${custos.map((c) => `${c.fonte}:$${c.usd.toFixed(4)}`).join(" ")} | total=$${custoTotalUsd.toFixed(4)}`);

  return { escolhido, custos, custoTotalUsd };
}
