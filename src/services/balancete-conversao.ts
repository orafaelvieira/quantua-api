/**
 * CONVERSÃO DO BALANCETE (F1, 2026-07-18) — determinística, ZERO IA.
 *
 * Recebe o BalanceteParseado e produz as árvores que o fold JÁ consome
 * (ArvoreOriginalBP / ArvoreOriginalDRE) + as PROVAS de integridade:
 *
 *  P1 · débitos = créditos (quando o documento declara os totais);
 *  P2 · FECHAMENTO: Ativo − Passivo = Σ resultado assinado (ao centavo) —
 *       ou Ativo = Passivo quando o exercício está ENCERRADO (apurado).
 *
 * REGRA-MESTRA (corpus de 7 sistemas): o sinal de cada conta vem da NATUREZA
 * CONTÁBIL da própria conta — nunca do rótulo do grupo (há sistemas com
 * receitas e despesas no MESMO grupo). A natureza é resolvida, nesta ordem:
 *  1. EQUAÇÃO DO PRÓPRIO DOCUMENTO — devedora: atual = anterior + D − C ·
 *     credora: atual = anterior + C − D (com o sinal do saldo invertendo a
 *     natureza efetiva: devedora com saldo negativo está credora);
 *  2. sufixo D/C declarado na coluna de saldo;
 *  3. HERANÇA da convenção de impressão do pai × sinal do saldo — cobre as
 *     contas SEM movimento no período (Belagro: "Descontos Obtidos" +54.131,14
 *     no grupo credor; "(-) ICMS sobre compras" −577.416,75 no grupo devedor);
 *  4. direção do movimento; 5. nome.
 *
 * HIERARQUIA por PREFIXO da classificação (não por contagem de segmentos) —
 * cobre o Protheus, onde "1.1.11 CAIXA" é FILHO de "1.1.1 DISPONIVEL" — com
 * REPARO DE DUPLA CONTAGEM verificado pela identidade contábil: no Protheus,
 * "3.2.15 (-) Impostos sobre venda" é pai real de "3.2.21.xx" (sem prefixo
 * comum); os filhos ficam soltos no nível acima e a folha 3.2.15 duplicaria a
 * soma. O reparo re-aninha a cauda de irmãos cuja soma bate ao centavo com a
 * última folha da subárvore anterior E que zera a divergência do pai.
 *
 * BP: grupos patrimoniais pelo Saldo atual, com o AJUSTE-CHAVE — o resultado
 * acumulado do período entra como linha do PL ("Resultado do Período") para o
 * balanço fechar: Ativo = Passivo ajustado, ao centavo.
 * DRE: acumulada YTD (saldo atual assinado); exercício encerrado → movimento.
 */

import type { BalanceteParseado, LinhaBalancete } from "./balancete-parser";
import type { ArvoreOriginalBP, ArvoreOriginalDRE, BPN3Item, DRESecaoItem } from "./ai-extraction";

const TOLERANCIA = 0.05; // centavos de arredondamento entre sistemas

export interface ProvasBalancete {
  /** P1 — só quando o doc declara totais. */
  debitosCreditos?: { debito: number; credito: number; ok: boolean };
  /** P2 — fechamento patrimonial. */
  fechamento: { ativo: number; passivo: number; resultadoAcumulado: number; delta: number; ok: boolean };
  /**
   * P3 — COERÊNCIA DE CADA LINHA (31/07/2026). P1 e P2 olham só a coluna do
   * SALDO ATUAL: um saldo anterior corrompido passava com selo verde de 100%
   * (caso real Belagro — 310 milhões inflados por um valor colado ao nome).
   * Esta prova cobre as QUATRO colunas de cada conta: saldo atual = saldo
   * anterior + débito − crédito (devedora) ou + crédito − débito (credora).
   */
  linhas: { total: number; coerentes: number; ok: boolean; incoerentes: Array<{ classificacao: string; nome: string; anterior: number; debito: number; credito: number; atual: number }> };
  exercicioEncerrado: boolean;
  /**
   * P4 — RECONCILIAÇÃO DA DRE DO EXERCÍCIO ENCERRADO (10/08/2026).
   *
   * No balancete de encerramento as contas de resultado estão ZERADAS (o
   * lançamento de encerramento as transferiu), então a DRE é derivada do
   * MOVIMENTO — uma heurística: receita = crédito acumulado, gasto = débito
   * acumulado. Transferência interna entre contas de resultado infla os dois
   * lados e ninguém percebe. A única âncora do próprio documento é a variação
   * do resultado no PL: se a DRE derivada não bate com ela, o número não é
   * fato — e não pode receber selo verde ("verde só com prova").
   *
   * Só existe quando `exercicioEncerrado` (no balancete corrente a DRE vem do
   * SALDO das contas de resultado, que é prova direta).
   */
  dreEncerrada?: { derivado: number; declaradoPL: number; gap: number; limite: number; ok: boolean };
}

export interface ConversaoBalancete {
  /** Período do retrato principal (fim do balancete): "31/05/2026". */
  periodoBP: string;
  /** Retrato de abertura (dia anterior ao início): "30/04/2026" — grátis no doc. */
  periodoBPAnterior: string | null;
  arvoreBP: ArvoreOriginalBP;
  arvoreDRE: ArvoreOriginalDRE;
  resultadoAcumulado: number;
  provas: ProvasBalancete;
  /**
   * Raízes de CIRCUITO FECHADO deixadas de fora das demonstrações (espelho de
   * centro de custos). Estruturado, não só texto: a tela precisa mostrar QUE
   * dinheiro saiu, e um aviso perdido num array que ninguém lê não é auditoria.
   */
  gruposExcluidos: Array<{ nome: string; contas: number; movimento: number }>;
  avisos: string[];
}

// ── classificação dos grupos de nível 1 ──────────────────────────────────────

/**
 * "espelho" = raiz de CIRCUITO FECHADO (centro de custos que devolve tudo por
 * uma contrapartida). Não é ativo, não é passivo e não é demonstração: fica
 * fora do BP e da DRE. Detectado por ARITMÉTICA em converterBalancete, nunca
 * por nome — ver o bloco de quatro condições lá.
 */
export type TipoGrupo = "ativo" | "passivo" | "resultado" | "apuracao" | "espelho";

const normalizar = (s: string): string =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();

/**
 * NOME DA FAMÍLIA DE APURAÇÃO/ENCERRAMENTO (10/08/2026 — bug crítico Belagro).
 *
 * Uma seção chamada "Resultado (líquido) do exercício/período" NÃO é componente
 * do resultado: ela É o resultado, transferido pelo lançamento de encerramento.
 * Somá-la à DRE é dupla contagem — no balancete de 2023 da Belagro a conta
 * [05] tinha débito = crédito = R$ 576.963.484 (puro contra-lançamento) e caía
 * em "Outras Despesas Operacionais", levando o Lucro Líquido a −687,9 milhões.
 *
 * A régua anterior procurava a substring "RESULTADO DO EXERC" e não casava com
 * "RESULTADO LÍQUIDO DO EXERCÍCIO" (o "LÍQUIDO" no meio) — daí o vazamento.
 *
 * CONSERVADORA de propósito: só casa quando "resultado" vem grudado em
 * "exercício/período" (com "líquido" opcional). NÃO casa — e não pode casar —
 * com contas legítimas da DRE: "Resultado de Equivalência Patrimonial",
 * "Resultado Financeiro", "Resultado de Posições de Mercado", "Resultado
 * Operacional do Exercício" (tem palavra própria no meio).
 */
export function ehNomeDeApuracao(nome: string): boolean {
  const n = normalizar(nome);
  // PALAVRA "APURAÇÃO", não o radical: "LUCROS APURADOS" é conta de PL, não
  // encerramento (revisão adversarial, 10/08/2026).
  if (/\bAPURACAO\b|\bENCERRAMENTO\b|\bZERAMENTO\b/.test(n)) return true;
  return /\bRESULTADO\s+(LIQUIDO\s+)?(DO\s+|DE\s+)?(EXERCICIO|PERIODO)\b/.test(n);
}

function tipoDoGrupo(nome: string, folhas: LinhaBalancete[]): TipoGrupo {
  const n = normalizar(nome);
  if (n.startsWith("ATIVO")) return "ativo";
  if (n.startsWith("PASSIVO")) return "passivo";
  // Apuração: grupo de encerramento técnico — nunca vira linha de DRE.
  // Casos reais: "CONTAS DE APURAÇÃO" (Domínio), "RESULTADO LÍQUIDO DO
  // EXERCÍCIO" (Belagro) e grupo "RESULTADO" cujas folhas são todas de
  // encerramento (Phonetrack).
  //
  // VETO DA ECONOMIA PRÓPRIA (10/08/2026, caso EXTRAMED achado na revisão
  // adversarial): o nome do grupo NÃO basta. "CONTAS DE DESTINAÇÃO/APURAÇÃO DE
  // RESULTADO" carrega IRPJ 1.929.304,98 e CSLL 720.481,33 — despesa de
  // verdade. Se QUALQUER folha com valor próprio tem nome fora da família de
  // encerramento, o grupo tem conteúdo econômico e continua na DRE; do
  // contrário o IR/CSLL sumiria da demonstração e o lucro sairia inflado.
  // DESTINAÇÃO do lucro (distribuição, dividendo, JCP, reserva) NÃO é economia
  // própria: é uso do resultado depois de apurado e não pode virar despesa da
  // DRE. Fica de fora do veto — o grupo segue como apuração/destinação.
  const ehNomeDeDestinacao = (nome: string): boolean =>
    /\bDISTRIBUIC\w*\s+(DE\s+)?(LUCRO|RESULTADO)|\bDIVIDENDO|\bJCP\b|JUROS\s+SOBRE\s+(O\s+)?CAPITAL|\bRESERVA\s+(LEGAL|DE\s+LUCRO)/.test(normalizar(nome));
  const temEconomiaPropria = folhas.some(
    (f) => Math.abs(f.saldoAtual ?? 0) > TOLERANCIA && !ehNomeDeApuracao(f.nome) && !ehNomeDeDestinacao(f.nome),
  );
  if (temEconomiaPropria) return "resultado";
  if (ehNomeDeApuracao(n)) return "apuracao";
  const folhasSaoApuracao = folhas.length > 0 && folhas.every((f) => ehNomeDeApuracao(f.nome));
  if (folhasSaoApuracao) return "apuracao";
  return "resultado";
}

// ── natureza contábil pela equação do documento ─────────────────────────────

/** "D" = impressa como devedora · "C" = credora · null = indeterminada. */
export function convencaoImpressao(l: LinhaBalancete): "D" | "C" | null {
  const mov = l.debito - l.credito;
  if (Math.abs(mov) <= TOLERANCIA) return null; // sem movimento líquido: ambígua
  const devedora = Math.abs(l.saldoAnterior + mov - l.saldoAtual) <= TOLERANCIA;
  const credora = Math.abs(l.saldoAnterior - mov - l.saldoAtual) <= TOLERANCIA;
  if (devedora && !credora) return "D";
  if (credora && !devedora) return "C";
  return null;
}

const opor = (n: "D" | "C"): "D" | "C" => (n === "D" ? "C" : "D");

// ── árvore com naturezas resolvidas ──────────────────────────────────────────

export interface No { linha: LinhaBalancete; filhos: No[] }

export interface ArvoreBalancete {
  grupos: Array<{ no: No; tipo: TipoGrupo }>;
  /** Natureza EFETIVA do saldo atual de cada linha (D = devedor, C = credor). */
  naturezas: Map<LinhaBalancete, "D" | "C">;
  /** Natureza efetiva do saldo ANTERIOR (pode divergir se o saldo trocou de lado). */
  naturezasAnterior: Map<LinhaBalancete, "D" | "C">;
}

/**
 * Floresta por prefixo: um nó é filho do último nó anterior cuja classificação
 * é PREFIXO da sua ("1.1" ⊂ "1.1.2"; Protheus "1.1.1" ⊂ "1.1.11"; corrida
 * "11211" ⊂ "11211001"). Documentos reais imprimem pais antes dos filhos.
 */
export function montarArvore(linhas: LinhaBalancete[]): No[] {
  const raizes: No[] = [];
  const pilha: No[] = [];
  for (const linha of linhas) {
    const no: No = { linha, filhos: [] };
    while (
      pilha.length &&
      !(linha.classificacao.length > pilha[pilha.length - 1].linha.classificacao.length &&
        linha.classificacao.startsWith(pilha[pilha.length - 1].linha.classificacao))
    ) {
      pilha.pop();
    }
    if (pilha.length === 0) raizes.push(no);
    else pilha[pilha.length - 1].filhos.push(no);
    pilha.push(no);
  }
  return raizes;
}

export function folhasDe(no: No): LinhaBalancete[] {
  if (no.filhos.length === 0) return [no.linha];
  return no.filhos.flatMap(folhasDe);
}

function ultimaFolhaNo(no: No): No {
  return no.filhos.length ? ultimaFolhaNo(no.filhos[no.filhos.length - 1]) : no;
}

/** Monta a floresta, resolve naturezas (equação→sufixo→herança) e repara dupla contagem. */
export function prepararArvore(b: BalanceteParseado): ArvoreBalancete {
  const raizes = montarArvore(b.linhas);
  const grupos = raizes.map((r) => ({ no: r, tipo: tipoDoGrupo(r.linha.nome, folhasDe(r)) }));

  const naturezas = new Map<LinhaBalancete, "D" | "C">();
  const naturezasAnterior = new Map<LinhaBalancete, "D" | "C">();

  const resolver = (l: LinhaBalancete, herdada: "D" | "C", campo: "saldoAtual" | "saldoAnterior"): { natureza: "D" | "C"; convencao: "D" | "C" } => {
    const saldo = l[campo];
    const sufixo = campo === "saldoAtual" ? l.naturezaAtual : l.naturezaAnterior;
    const eq = convencaoImpressao(l);
    if (eq) return { natureza: saldo < 0 ? opor(eq) : eq, convencao: eq };
    if (sufixo) return { natureza: sufixo, convencao: saldo < 0 ? opor(sufixo) : sufixo };
    // herança da convenção de impressão do pai × sinal do saldo
    const saldoRef = Math.abs(saldo) > TOLERANCIA ? saldo : (campo === "saldoAtual" ? l.saldoAnterior : l.saldoAtual);
    if (Math.abs(saldoRef) > TOLERANCIA || l.debito === l.credito) {
      return { natureza: saldoRef < 0 ? opor(herdada) : herdada, convencao: herdada };
    }
    // último recurso: direção do movimento
    return { natureza: l.credito > l.debito ? "C" : "D", convencao: herdada };
  };

  const atribuir = (no: No, herdada: "D" | "C"): void => {
    const atual = resolver(no.linha, herdada, "saldoAtual");
    naturezas.set(no.linha, atual.natureza);
    naturezasAnterior.set(no.linha, resolver(no.linha, herdada, "saldoAnterior").natureza);
    for (const f of no.filhos) atribuir(f, atual.convencao);
  };
  for (const g of grupos) {
    const n = normalizar(g.no.linha.nome);
    const semente: "D" | "C" =
      g.tipo === "ativo" ? "D" :
      g.tipo === "passivo" ? "C" :
      /RECEITA|RENDIMENTO|FATURAMENTO/.test(n) ? "C" : "D";
    atribuir(g.no, semente);
  }

  // saldo real assinado (devedor positivo) — base da identidade pai = Σ filhos
  const real = (l: LinhaBalancete): number =>
    (naturezas.get(l) === "D" ? 1 : -1) * Math.abs(l.saldoAtual);

  // Reparo de dupla contagem (Protheus): cauda de irmãos soltos cuja soma
  // bate ao centavo com a última folha da subárvore do irmão anterior E que
  // zera a divergência do pai → re-aninha sob aquela folha.
  const reparar = (no: No): void => {
    for (const f of no.filhos) reparar(f);
    if (no.filhos.length < 2 || no.filhos.length > 300) return;
    const alvo = real(no.linha);
    const soma = no.filhos.reduce((s, f) => s + folhasDe(f).reduce((x, l) => x + real(l), 0), 0);
    if (Math.abs(soma - alvo) <= TOLERANCIA) return;
    for (let i = 1; i < no.filhos.length; i++) {
      const hospedeiro = ultimaFolhaNo(no.filhos[i - 1]);
      if (hospedeiro.filhos.length) continue;
      let somaRun = 0;
      for (let j = i; j < no.filhos.length; j++) {
        somaRun += folhasDe(no.filhos[j]).reduce((x, l) => x + real(l), 0);
        if (
          Math.abs(somaRun - real(hospedeiro.linha)) <= TOLERANCIA &&
          Math.abs(soma - somaRun - alvo) <= TOLERANCIA
        ) {
          hospedeiro.filhos.push(...no.filhos.slice(i, j + 1));
          no.filhos.splice(i, j - i + 1);
          return;
        }
      }
    }
  };
  for (const g of grupos) reparar(g.no);

  return { grupos, naturezas, naturezasAnterior };
}

// ── datas ────────────────────────────────────────────────────────────────────

function diaAnterior(ddmmaaaa: string): string | null {
  const m = ddmmaaaa.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  d.setDate(d.getDate() - 1);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

/**
 * MESCLA NA LEITURA (2026-07-18): as árvores dos balancetes ficam em
 * `arvoresBalancete` (lista própria, para o /refold re-dobrar cada mês). Quem
 * CONSOME a árvore original — auditoria do IBR e "Documento original da empresa"
 * do Valuation — lê `arvoreOriginalBP/DRE`. Este helper une as duas visões SEM
 * persistir (persistir faria o refold dobrar os meses duas vezes).
 *
 * Helper ÚNICO porque a mescla já precisou existir em dois endpoints e divergiu:
 * o Valuation lia direto do banco e mostrava a aba vazia para IBR de balancete.
 */
export function mesclarArvoresBalancete<
  T extends { arvoreOriginalBP?: unknown; arvoreOriginalDRE?: unknown; arvoresBalancete?: unknown },
>(dados: T): T {
  const arv = Array.isArray(dados?.arvoresBalancete) ? (dados.arvoresBalancete as Array<Record<string, any>>) : [];
  if (arv.length === 0) return dados;
  const bp: Record<string, unknown> = { ...((dados.arvoreOriginalBP as Record<string, unknown>) ?? {}) };
  const dre: Record<string, unknown> = { ...((dados.arvoreOriginalDRE as Record<string, unknown>) ?? {}) };
  // A FOTO PRÓPRIA MANDA (31/07/2026): cada balancete produz DUAS fotos — o mês
  // corrente (saldoAtual) e o mês ANTERIOR (saldoAnterior). Sem esta ordem, a
  // foto "anterior" de um mês posterior podia OCUPAR a chave de um mês que tem
  // documento próprio (o primeiro a chegar vencia) — e a auditoria mostrava o
  // mês inteiro sem destino, porque só a foto corrente é dobrada (caso Belagro:
  // fevereiro exibido a partir do saldo anterior do balancete de março).
  // As árvores ANUAIS (BP/DRE) seguem intocadas — elas mandam sobre o balancete.
  const anuaisBP = new Set(Object.keys(bp));
  const anuaisDRE = new Set(Object.keys(dre));
  for (const ab of arv) {
    const proprio = String(ab?.periodo ?? "");
    if (!proprio) continue;
    for (const [p, v] of Object.entries(ab?.arvoreBP ?? {})) if (p === proprio && !anuaisBP.has(p)) bp[p] = v;
    for (const [p, v] of Object.entries(ab?.arvoreDRE ?? {})) if (p === proprio && !anuaisDRE.has(p)) dre[p] = v;
  }
  // Só então o saldo anterior preenche os meses ÓRFÃOS (sem documento próprio) —
  // ex.: o mês de abertura da série, que só existe como coluna do mês seguinte.
  for (const ab of arv) {
    for (const [p, v] of Object.entries(ab?.arvoreBP ?? {})) if (!bp[p]) bp[p] = v;
    for (const [p, v] of Object.entries(ab?.arvoreDRE ?? {})) if (!dre[p]) dre[p] = v;
  }
  if (Object.keys(bp).length) (dados as { arvoreOriginalBP?: unknown }).arvoreOriginalBP = bp;
  if (Object.keys(dre).length) (dados as { arvoreOriginalDRE?: unknown }).arvoreOriginalDRE = dre;
  return dados;
}

/**
 * DRE MENSALIZADA NA LEITURA (01/08/2026 — pedido do usuário: "no balancete a
 * DRE é acumulada do ano e a tela precisa do resultado do mês").
 *
 * O mês vindo de balancete carrega a DRE ACUMULADA do exercício (YTD, período
 * "01/01 a fim do mês") — é fiel ao documento e continua sendo o que fica
 * GRAVADO. O mês ISOLADO é derivado aqui, na leitura: YTD(mês) − YTD(mês
 * anterior), quando o mês anterior do MESMO exercício existe na série (também
 * vindo de balancete). Janeiro (ou o 1º mês da janela do doc) já é o próprio
 * mês. Sem o mês anterior, não há como isolar — o período fica marcado como
 * acumulado e a tela mostra o rótulo.
 *
 * Mesmo padrão do mesclarArvoresBalancete: derivado a cada GET, nunca
 * persistido (o refold/process re-dobra as árvores e o derivado acompanha).
 */
export interface DREMensal {
  /** Por período ACUMULADO (dd/mm/aaaa): desde quando acumula e se o mês pôde ser isolado. */
  periodos: Record<string, { desde: string; mesIsolado: boolean; anterior?: string }>;
  /** conta → período → valor DO MÊS (só para períodos com mesIsolado). */
  valores: Record<string, Record<string, number>>;
}

export function derivarDREMensal(dados: {
  dre?: Array<{ conta: string; valores?: Record<string, number> }>;
  balancetes?: unknown;
  arvoresBalancete?: unknown;
}): DREMensal | null {
  // DUAS fontes para a lista de meses-de-balancete, unidas: `balancetes`
  // (traz periodoInicio quando o cache o tem) e `arvoresBalancete` (sempre
  // presente quando há mês de balancete — é dela que a auditoria vive). Cache
  // antigo pode ter a primeira incompleta; a segunda garante os meses.
  const bals = Array.isArray(dados?.balancetes) ? [...(dados.balancetes as Array<Record<string, any>>)] : [];
  const arvores = Array.isArray(dados?.arvoresBalancete) ? (dados.arvoresBalancete as Array<Record<string, any>>) : [];
  for (const ab of arvores) {
    const p = String(ab?.periodo ?? "");
    if (p && !bals.some((b) => String(b?.periodo ?? "") === p)) bals.push({ periodo: p });
  }
  const dre = Array.isArray(dados?.dre) ? dados.dre : [];
  if (bals.length === 0 || dre.length === 0) return null;

  const dataDe = (s: string): Date | null => {
    const m = (s ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
  };
  const fmtData = (d: Date): string =>
    `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

  // TODOS os meses de balancete entram no encadeamento. O critério de
  // "acumulado" é CONTÁBIL, não a janela declarada no cabeçalho: conta de
  // RESULTADO carrega saldo acumulado do exercício até o encerramento anual —
  // o balancete "01/05 a 31/05" (caso real Belagro) descreve a janela do
  // MOVIMENTO (débitos/créditos), mas a coluna de saldo das contas de
  // resultado é YTD desde 01/01 do mesmo jeito. É o mesmo conceito que os
  // indicadores sempre usaram (periodosYTD, sem olhar a janela). Logo: DRE de
  // mês de balancete acumula desde 01/01 do exercício, SEMPRE; janeiro é o
  // único mês em que YTD = mês (nada a derivar).
  const mesesBalancete = new Map<string, { desde: string; inicio: Date; fim: Date; acumula: boolean }>();
  for (const b of bals) {
    if (b?.erro || !b?.periodo) continue;
    const fim = dataDe(String(b.periodo));
    if (!fim) continue;
    // EXERCÍCIO ENCERRADO NÃO É YTD (03/08/2026 — caça de regressão). No mês de
    // encerramento a apuração ZERA as contas de resultado e a conversão passa a
    // usar o MOVIMENTO da janela (ver `paraDREItem`, ramo `encerrado`): o valor
    // já é do período, não acumulado. Subtrair o YTD do mês anterior dava
    // resultado NEGATIVO na tela (dezembro 1.000 − novembro 11.000 = −10.000)
    // com o selo dizendo "provado ao centavo".
    if (b?.provas?.exercicioEncerrado === true) {
      const inicioDecl = b.periodoInicio ? dataDe(String(b.periodoInicio)) : null;
      const desdeDecl = b.periodoInicio ? String(b.periodoInicio) : `01/01/${fim.getFullYear()}`;
      mesesBalancete.set(String(b.periodo), { desde: desdeDecl, inicio: inicioDecl ?? dataDe(`01/01/${fim.getFullYear()}`)!, fim, acumula: false });
      continue;
    }
    const desde = `01/01/${fim.getFullYear()}`;
    const inicio = dataDe(desde)!;
    mesesBalancete.set(String(b.periodo), { desde, inicio, fim, acumula: fim.getMonth() > 0 });
  }
  const acumulados = [...mesesBalancete.entries()].filter(([, v]) => v.acumula);
  if (acumulados.length === 0) return null;

  const out: DREMensal = { periodos: {}, valores: {} };
  for (const [periodo, info] of acumulados) {
    // Mês anterior DO MESMO exercício acumulado: último dia do mês anterior ao
    // fim, presente na série como mês de balancete com o MESMO início de
    // janela (o YTD dele é o minuendo da subtração).
    const fimAnterior = new Date(info.fim.getFullYear(), info.fim.getMonth(), 0);
    const chaveAnterior = fmtData(fimAnterior);
    const anterior = mesesBalancete.get(chaveAnterior);
    const encadeia = !!anterior && anterior.desde === info.desde;
    if (!encadeia || fimAnterior < info.inicio) {
      out.periodos[periodo] = { desde: info.desde, mesIsolado: false };
      continue;
    }
    out.periodos[periodo] = { desde: info.desde, mesIsolado: true, anterior: chaveAnterior };
    for (const linha of dre) {
      const ytd = linha?.valores?.[periodo];
      const ytdAnt = linha?.valores?.[chaveAnterior];
      if (typeof ytd !== "number" && typeof ytdAnt !== "number") continue;
      const mes = Math.round(((ytd ?? 0) - (ytdAnt ?? 0)) * 100) / 100;
      (out.valores[linha.conta] ??= {})[periodo] = mes;
    }
  }
  return Object.keys(out.periodos).length ? out : null;
}

// ── conversão principal ──────────────────────────────────────────────────────

export function converterBalancete(b: BalanceteParseado): ConversaoBalancete {
  const avisos = [...b.avisos];
  const periodoBP = b.periodoFim ?? "";
  const periodoBPAnterior = b.periodoInicio ? diaAnterior(b.periodoInicio) : null;

  const { grupos, naturezas, naturezasAnterior } = prepararArvore(b);

  const naturezaDe = (l: LinhaBalancete, campo: "saldoAtual" | "saldoAnterior"): "D" | "C" =>
    (campo === "saldoAtual" ? naturezas.get(l) : naturezasAnterior.get(l)) ?? "D";

  /** Saldo assinado para a DRE: receita (C) positiva, custo/despesa (D) negativa. */
  const assinadoDRE = (l: LinhaBalancete, campo: "saldoAtual" | "saldoAnterior"): number =>
    (naturezaDe(l, campo) === "C" ? 1 : -1) * Math.abs(l[campo]);

  /** Saldo assinado PATRIMONIAL: no lado natural positivo, redutora negativa. */
  const assinadoBP = (l: LinhaBalancete, ladoAtivo: boolean, campo: "saldoAtual" | "saldoAnterior"): number =>
    (naturezaDe(l, campo) === (ladoAtivo ? "D" : "C") ? 1 : -1) * Math.abs(l[campo]);

  // ── GRUPO-ESPELHO: raiz que é CIRCUITO FECHADO, não demonstração ──────────
  // Caso Budel (03/08/2026). O plano de contas traz uma raiz "4 CENTRO DE
  // CUSTOS" que espelha os custos operacionais e devolve tudo por uma
  // contrapartida ("TRANSFERÊNCIAS"). O total da raiz é zero nos dois retratos,
  // então ela não move resultado nenhum — mas, foldada, DOBRA o custo da DRE e
  // inventa uma receita do tamanho da contrapartida: no Budel, R$ 34.497.458,97
  // apareceram como "Outras Receitas Operacionais" (a verdade do grupo 33 é
  // R$ 7.015,20). O fechamento PASSAVA e a análise mentia.
  //
  // A regra sai da ARITMÉTICA, nunca do nome — "TRANSFERÊNCIAS" varia por
  // sistema contábil. São QUATRO condições, e cada uma existe por um
  // contraexemplo medido em documento real:
  //   1) a raiz zera no saldo ATUAL e no ANTERIOR;
  //   2) há movimento de verdade dentro dela — senão um período sem lançamento
  //      zeraria tudo e o grupo inteiro sumiria;
  //   3) restam ≥2 contas VIVAS **que carregam o movimento do grupo** — o saldo
  //      vivo tem de ser fração material do que passou por lá. É isto que separa
  //      espelho de EXERCÍCIO ENCERRADO. "Ter 2 contas vivas" sozinho NÃO basta:
  //      a revisão adversarial mediu que em "Balancete de encerramento 2023.xlsx"
  //      bastaria uma reclassificação de R$ 0,06 entre duas contas irmãs para a
  //      raiz "3 CONTAS DE RESULTADO" (544 folhas, R$ 834 milhões de DRE) virar
  //      "espelho" e a DRE inteira sumir COM SELO VERDE. No encerramento as 542
  //      folhas mortas carregam todo o movimento e as vivas carregam centavos
  //      (razão ~7e-11); no espelho as folhas vivas SÃO as que movimentam
  //      (razão ~1). 31 raízes do corpus passam nas outras condições e só
  //      escapam por aqui;
  //   4) a soma ASSINADA das folhas também é zero. Raiz que zera com folhas que
  //      NÃO zeram é DEFEITO DE LEITURA, não espelho — e tem de continuar dentro
  //      da prova de fechamento para o motor recusar o selo em vez de esconder
  //      o erro. É esta condição que garante que excluir o grupo NÃO enfraquece
  //      P2: o que sai soma zero, então resultadoAcumulado e delta não se movem.
  const gruposExcluidos: Array<{ nome: string; contas: number; movimento: number }> = [];
  for (const g of grupos) {
    if (g.tipo !== "resultado") continue;
    if (Math.abs(g.no.linha.saldoAtual) > TOLERANCIA) continue;
    if (Math.abs(g.no.linha.saldoAnterior) > TOLERANCIA) continue;
    const folhas = folhasDe(g.no);
    const movimento = folhas.reduce((s, f) => s + Math.abs(f.debito) + Math.abs(f.credito), 0);
    if (movimento <= TOLERANCIA) continue;
    const vivas = folhas.filter((f) => Math.abs(f.saldoAtual) > TOLERANCIA);
    if (vivas.length < 2) continue;
    // As contas vivas têm de CARREGAR o movimento (ver condição 3): no espelho
    // a razão é ~1; num exercício encerrado com resíduo de centavos, ~1e-11.
    const saldoVivo = vivas.reduce((s, f) => s + Math.abs(f.saldoAtual), 0);
    if (saldoVivo < 0.05 * movimento) continue;
    if (Math.abs(arred(folhas.reduce((s, f) => s + assinadoDRE(f, "saldoAtual"), 0))) > TOLERANCIA) continue;
    g.tipo = "espelho";
    gruposExcluidos.push({ nome: g.no.linha.nome, contas: folhas.length, movimento: arred(movimento) });
  }

  const ativos = grupos.filter((g) => g.tipo === "ativo");
  const passivos = grupos.filter((g) => g.tipo === "passivo");
  const resultados = grupos.filter((g) => g.tipo === "resultado");
  const espelhos = grupos.filter((g) => g.tipo === "espelho");
  if (ativos.length === 0 || passivos.length === 0) {
    avisos.push("Grupos ATIVO/PASSIVO não identificados no nível 1 — verifique a extração.");
  }
  for (const e of gruposExcluidos) {
    avisos.push(
      `"${e.nome}" é um CIRCUITO FECHADO (${e.contas} contas, ${fmt(e.movimento)} de movimento): o saldo da raiz é zero no início e no fim do período e as contas dentro dela se cancelam ao centavo. É espelho gerencial de centro de custos, não demonstração — ficou FORA da DRE, senão o custo apareceria dobrado e a contrapartida viraria receita. Nenhum total mudou: o que saiu soma zero.`,
    );
  }

  // ── resultado acumulado (assinado, só folhas, sem apuração) ──
  const folhasResultado = resultados.flatMap((g) => folhasDe(g.no));
  let resultadoAcumulado = arred(folhasResultado.reduce((s, f) => s + assinadoDRE(f, "saldoAtual"), 0));

  // ── exercício encerrado: resultado zerado (apurado) e A=P ──
  const ativoAtual = arred(ativos.reduce((s, g) => s + Math.abs(g.no.linha.saldoAtual), 0));
  const passivoAtual = arred(passivos.reduce((s, g) => s + Math.abs(g.no.linha.saldoAtual), 0));
  // EXERCÍCIO ENCERRADO OLHA TODAS AS FOLHAS DE RESULTADO, ESPELHO INCLUÍDO:
  // um espelho tem contas VIVAS que se cancelam; se ele saísse desta conta, um
  // documento com espelho e resultado zerado pareceria encerrado e a DRE
  // inteira trocaria de regime (saldo → movimento, e `derivarDREMensal` junto).
  const folhasResultadoTodas = [...folhasResultado, ...espelhos.flatMap((g) => folhasDe(g.no))];
  const saldosResultadoZerados = folhasResultadoTodas.every((f) => Math.abs(f.saldoAtual) < TOLERANCIA);
  const exercicioEncerrado = saldosResultadoZerados && Math.abs(ativoAtual - passivoAtual) <= TOLERANCIA;

  // ── P2: fechamento ──
  let delta = arred(ativoAtual - passivoAtual - (exercicioEncerrado ? 0 : resultadoAcumulado));

  // DESTINAÇÃO DE RESULTADO com saldo vivo (caso EXTRAMED, 01/08/2026): nos
  // sistemas do corpus original o grupo de apuração é DUPLICATA do resultado
  // (só usado no encerramento) e excluí-lo fecha o balanço. Mas há plano de
  // contas em que "CONTAS DE DESTINAÇÃO/APURAÇÃO DE RESULTADO" carrega saldo
  // pelo ano (distribuições) — aí a identidade do documento é A − P =
  // resultado + destinação(assinada). Quem decide é a EQUAÇÃO: só integra a
  // apuração quando SEM ela não fecha e COM ela fecha ao centavo.
  let apuracaoIntegrada = false;
  const apuracoes = grupos.filter((g) => g.tipo === "apuracao");
  if (!exercicioEncerrado && Math.abs(delta) > TOLERANCIA && apuracoes.length > 0) {
    const folhasApuracao = apuracoes.flatMap((g) => folhasDe(g.no));
    const apuracaoAssinada = arred(folhasApuracao.reduce((s, f) => s + assinadoDRE(f, "saldoAtual"), 0));
    const resultadoCom = arred(resultadoAcumulado + apuracaoAssinada);
    const deltaCom = arred(ativoAtual - passivoAtual - resultadoCom);
    if (Math.abs(apuracaoAssinada) > TOLERANCIA && Math.abs(deltaCom) <= TOLERANCIA) {
      resultadoAcumulado = resultadoCom;
      delta = deltaCom;
      apuracaoIntegrada = true;
      avisos.push(
        `Grupo de destinação/apuração de resultado (${fmt(apuracaoAssinada)}) integrado ao resultado acumulado — é o que fecha o balanço ao centavo neste plano de contas.`,
      );
    }
  }

  // ── P3: coerência de CADA linha (cobre as 4 colunas, não só o saldo atual) ──
  // CONTAR SEMPRE, GUARDAR ALGUMAS (03/08/2026). Antes o `push` parava em 20 e
  // `coerentes` era `total − incoerentes.length`: num documento com 234 linhas
  // quebradas a PRÓPRIA PROVA declarava "635 de 655 coerentes" e o aviso dizia
  // "20 conta(s)". O teto da amostra não pode ser a contagem — o selo e o
  // analista passam a acreditar num número que ninguém mediu.
  const incoerentes: ProvasBalancete["linhas"]["incoerentes"] = [];
  const AMOSTRA_INCOERENTES = 20;
  let totalIncoerentes = 0;
  for (const l of b.linhas) {
    const d = Math.abs(l.debito), c = Math.abs(l.credito);
    let coerente: boolean;
    if (l.naturezaAnterior && l.naturezaAtual) {
      // Natureza DECLARADA nos dois retratos: equação ÚNICA assinada (débito
      // soma). Cobre a conta que VIRA de natureza no período — começa credora
      // e termina devedora (caso EXTRAMED: −2.485.223,60 + 58.450.567,81 −
      // 54.300.432,64 = +1.664.911,57 D ✓), que as duas equações sem sinal
      // reprovariam.
      const antS = (l.naturezaAnterior === "C" ? -1 : 1) * Math.abs(l.saldoAnterior);
      const atualS = (l.naturezaAtual === "C" ? -1 : 1) * Math.abs(l.saldoAtual);
      coerente = Math.abs(antS + d - c - atualS) <= TOLERANCIA;
    } else {
      const devedora = Math.abs(l.saldoAnterior + d - c - l.saldoAtual) <= TOLERANCIA;
      const credora = Math.abs(l.saldoAnterior + c - d - l.saldoAtual) <= TOLERANCIA;
      coerente = devedora || credora;
    }
    if (coerente) continue;
    totalIncoerentes++;
    if (incoerentes.length < AMOSTRA_INCOERENTES) {
      incoerentes.push({ classificacao: l.classificacao, nome: l.nome, anterior: l.saldoAnterior, debito: l.debito, credito: l.credito, atual: l.saldoAtual });
    }
  }

  const provas: ProvasBalancete = {
    fechamento: { ativo: ativoAtual, passivo: passivoAtual, resultadoAcumulado, delta, ok: Math.abs(delta) <= TOLERANCIA },
    linhas: { total: b.linhas.length, coerentes: b.linhas.length - totalIncoerentes, ok: totalIncoerentes === 0, incoerentes },
    exercicioEncerrado,
    ...(b.totais
      ? { debitosCreditos: { ...b.totais, ok: Math.abs(b.totais.debito - b.totais.credito) <= TOLERANCIA } }
      : {}),
  };
  if (!provas.fechamento.ok) {
    avisos.push(`Fechamento não bate: Ativo ${fmt(ativoAtual)} − Passivo ${fmt(passivoAtual)} − Resultado ${fmt(resultadoAcumulado)} = ${fmt(delta)}.`);
  }
  if (!provas.linhas.ok) {
    const ex = incoerentes[0];
    avisos.push(
      `${totalIncoerentes} de ${b.linhas.length} conta(s) não fecham na própria equação (saldo anterior + débito − crédito = saldo atual). ` +
      `Ex.: "${ex.nome}" — ${fmt(ex.anterior)} + ${fmt(ex.debito)} − ${fmt(ex.credito)} ≠ ${fmt(ex.atual)}.` +
      (totalIncoerentes > AMOSTRA_INCOERENTES ? ` (listadas as ${AMOSTRA_INCOERENTES} primeiras)` : ""),
    );
  }

  // ── BP: árvore original nos 5 GRUPOS CANÔNICOS que o fold consome ──
  // (foldBP só lê as chaves "Ativo Circulante"/"Ativo Não Circulante"/"Passivo
  // Circulante"/"Passivo Não Circulante"/"Patrimônio Líquido" — o N2 do
  // documento é classificado por nome no balde certo e entra como SUBÁRVORE:
  // o fold desce estruturalmente e classifica as folhas com o dicionário.)
  const paraBPItem = (no: No, ladoAtivo: boolean, campo: "saldoAtual" | "saldoAnterior"): BPN3Item => ({
    nome: no.linha.nome,
    valor: arred(assinadoBP(no.linha, ladoAtivo, campo)),
    ...(no.filhos.length ? { filhos: no.filhos.map((f) => paraBPItem(f, ladoAtivo, campo)) } : {}),
  });

  const baldeBP = (nome: string, ladoAtivo: boolean): string => {
    const n = normalizar(nome);
    if (!ladoAtivo && (n.includes("PATRIMONIO") || n === "PL" || /^CAPITAL|^RESERVA|LUCROS? ACUM|PREJUIZOS? ACUM/.test(n))) {
      return "Patrimônio Líquido";
    }
    const naoCirculante = /NAO[ -]?CIRCULANTE|LONGO PRAZO|PERMANENTE|IMOBILIZAD|INTANGIVE|INVESTIMENT|DIFERIDO|REALIZAVEL A LONGO|EXIGIVEL A LONGO/.test(n);
    if (naoCirculante) return ladoAtivo ? "Ativo Não Circulante" : "Passivo Não Circulante";
    return ladoAtivo ? "Ativo Circulante" : "Passivo Circulante";
  };

  const arvoreBP: ArvoreOriginalBP = {};
  const montarBPPeriodo = (campo: "saldoAtual" | "saldoAnterior", periodo: string): void => {
    const gruposBP: Record<string, BPN3Item[]> = {};
    for (const g of [...ativos, ...passivos]) {
      const ladoAtivo = g.tipo === "ativo";
      const n2s = g.no.filhos.length ? g.no.filhos : [g.no];
      for (const n2 of n2s) {
        (gruposBP[baldeBP(n2.linha.nome, ladoAtivo)] ??= []).push(paraBPItem(n2, ladoAtivo, campo));
      }
    }
    // AJUSTE-CHAVE: resultado do período entra no PL para o balanço fechar.
    // Com a destinação integrada (EXTRAMED), ela entra nos DOIS retratos — a
    // identidade vale igualmente na coluna do saldo anterior.
    const folhasDoResultado = apuracaoIntegrada
      ? [...folhasResultado, ...apuracoes.flatMap((g) => folhasDe(g.no))]
      : folhasResultado;
    const resultadoDoCampo = campo === "saldoAtual"
      ? resultadoAcumulado
      : arred(folhasDoResultado.reduce((s, f) => s + assinadoDRE(f, "saldoAnterior"), 0));
    if (!exercicioEncerrado && Math.abs(resultadoDoCampo) > TOLERANCIA) {
      (gruposBP["Patrimônio Líquido"] ??= []).push({
        nome: "Resultado do Período (apuração do balancete)",
        valor: resultadoDoCampo,
      });
    }
    arvoreBP[periodo] = { grupos: gruposBP };
  };
  if (periodoBP) montarBPPeriodo("saldoAtual", periodoBP);
  if (periodoBPAnterior && temSaldosAnteriores(b.linhas)) montarBPPeriodo("saldoAnterior", periodoBPAnterior);

  // ── DRE: acumulada YTD (encerrado → movimento), seções nível 2 ──
  const paraDREItem = (no: No, encerrado: boolean): DRESecaoItem => {
    const valorDe = (l: LinhaBalancete): number => {
      if (!encerrado) return assinadoDRE(l, "saldoAtual");
      // exercício encerrado: o lançamento de ENCERRAMENTO entra no movimento da
      // própria conta (débito na receita = saldo YTD transferido à apuração),
      // então c−d ≈ 0. O lado OPERACIONAL é a coluna da natureza: receita =
      // crédito acumulado, despesa = débito acumulado.
      return naturezaDe(l, "saldoAtual") === "C" ? l.credito : -l.debito;
    };
    const filhos = no.filhos
      .map((f) => paraDREItem(f, encerrado))
      .filter((f) => Math.abs(f.valor) > 0.004 || (f.filhos?.length ?? 0) > 0);
    const valor = no.filhos.length
      ? arred(filhos.reduce((s, f) => s + f.valor, 0))
      : arred(valorDe(no.linha));
    return { nome: no.linha.nome, valor, ...(filhos.length ? { filhos } : {}) };
  };

  const arvoreDRE: ArvoreOriginalDRE = {};
  if (periodoBP) {
    const secoes: DRESecaoItem[] = [];
    for (const g of resultados) {
      const base = g.no.filhos.length ? g.no.filhos : [g.no];
      for (const n2 of base) {
        const item = paraDREItem(n2, exercicioEncerrado);
        if (Math.abs(item.valor) > 0.004 || (item.filhos?.length ?? 0) > 0) secoes.push(item);
      }
    }
    arvoreDRE[periodoBP] = secoes;

    // P4 — a DRE derivada do MOVIMENTO reconcilia com o que o PL declara?
    // Âncora: variação das contas de resultado do PL (Resultado do Exercício /
    // Lucros ou Prejuízos Acumulados) entre os dois retratos do documento.
    // Distribuição de lucro no ano mexe nessas contas sem passar pela DRE — daí
    // o limite generoso (10% da receita): a prova existe para pegar DIVERGÊNCIA
    // GROSSA (caso Belagro 2023: derivado −85,9 mi × PL +1,3 mi), não ruído.
    if (exercicioEncerrado && temSaldosAnteriores(b.linhas)) {
      const derivado = arred(secoes.reduce((s, x) => s + x.valor, 0));
      const contasResultadoPL = [...ativos, ...passivos]
        .flatMap((g) => folhasDe(g.no))
        .filter((l) => {
          const n = normalizar(l.nome);
          return ehNomeDeApuracao(n) || /\bLUCROS?\b.*\bACUMULADOS?\b|\bPREJUIZOS?\b.*\bACUMULADOS?\b|\bRESULTADO\b.*\bACUMULADO\b/.test(n);
        });
      // Lucro no PL é CREDOR: usa a régua patrimonial do lado passivo, para o
      // lucro sair positivo e o prejuízo negativo.
      const declaradoPL = arred(contasResultadoPL.reduce(
        (s, l) => s + (assinadoBP(l, false, "saldoAtual") - assinadoBP(l, false, "saldoAnterior")), 0));
      const receita = arred(secoes.filter((x) => x.valor > 0).reduce((s, x) => s + x.valor, 0));
      const gap = Math.abs(arred(derivado - declaradoPL));
      const limite = Math.max(5_000, receita * 0.1);
      const ok = contasResultadoPL.length === 0 ? true : gap <= limite;
      provas.dreEncerrada = { derivado, declaradoPL, gap, limite, ok };
      if (!ok) {
        avisos.push(
          `Balancete de ENCERRAMENTO: as contas de resultado estão zeradas e a DRE foi derivada do movimento — ela dá ${fmt(derivado)}, mas o resultado que o próprio PL registra no ano é ${fmt(declaradoPL)} (diferença de ${fmt(gap)}). ` +
          `Transferência interna entre contas de resultado infla os dois lados: confira a DRE deste exercício contra a demonstração oficial antes de usar os números.`,
        );
      }
    }
  }

  return { periodoBP, periodoBPAnterior, arvoreBP, arvoreDRE, resultadoAcumulado, provas, gruposExcluidos, avisos };
}

function temSaldosAnteriores(linhas: LinhaBalancete[]): boolean {
  return linhas.some((l) => Math.abs(l.saldoAnterior) > TOLERANCIA);
}

const arred = (n: number): number => Math.round(n * 100) / 100;
const fmt = (n: number): string => n.toLocaleString("pt-BR", { minimumFractionDigits: 2 });
