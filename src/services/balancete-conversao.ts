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
  exercicioEncerrado: boolean;
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
  avisos: string[];
}

// ── classificação dos grupos de nível 1 ──────────────────────────────────────

export type TipoGrupo = "ativo" | "passivo" | "resultado" | "apuracao";

const normalizar = (s: string): string =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();

function tipoDoGrupo(nome: string, folhas: LinhaBalancete[]): TipoGrupo {
  const n = normalizar(nome);
  if (n.startsWith("ATIVO")) return "ativo";
  if (n.startsWith("PASSIVO")) return "passivo";
  // Apuração: grupo de encerramento técnico — nunca vira linha de DRE.
  // Casos reais: "CONTAS DE APURAÇÃO" (Domínio) e grupo "RESULTADO" cujas
  // folhas são todas "RESULTADO DO EXERCÍCIO/APURAÇÃO" (Phonetrack).
  if (n.includes("APURA")) return "apuracao";
  const folhasSaoApuracao = folhas.length > 0 && folhas.every((f) => {
    const fn = normalizar(f.nome);
    return fn.includes("APURA") || fn.includes("RESULTADO DO EXERC") || fn.includes("ENCERRAMENTO");
  });
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

  const ativos = grupos.filter((g) => g.tipo === "ativo");
  const passivos = grupos.filter((g) => g.tipo === "passivo");
  const resultados = grupos.filter((g) => g.tipo === "resultado");
  if (ativos.length === 0 || passivos.length === 0) {
    avisos.push("Grupos ATIVO/PASSIVO não identificados no nível 1 — verifique a extração.");
  }

  // ── resultado acumulado (assinado, só folhas, sem apuração) ──
  const folhasResultado = resultados.flatMap((g) => folhasDe(g.no));
  const resultadoAcumulado = arred(folhasResultado.reduce((s, f) => s + assinadoDRE(f, "saldoAtual"), 0));

  // ── exercício encerrado: resultado zerado (apurado) e A=P ──
  const ativoAtual = arred(ativos.reduce((s, g) => s + Math.abs(g.no.linha.saldoAtual), 0));
  const passivoAtual = arred(passivos.reduce((s, g) => s + Math.abs(g.no.linha.saldoAtual), 0));
  const saldosResultadoZerados = folhasResultado.every((f) => Math.abs(f.saldoAtual) < TOLERANCIA);
  const exercicioEncerrado = saldosResultadoZerados && Math.abs(ativoAtual - passivoAtual) <= TOLERANCIA;

  // ── P2: fechamento ──
  const delta = arred(ativoAtual - passivoAtual - (exercicioEncerrado ? 0 : resultadoAcumulado));
  const provas: ProvasBalancete = {
    fechamento: { ativo: ativoAtual, passivo: passivoAtual, resultadoAcumulado, delta, ok: Math.abs(delta) <= TOLERANCIA },
    exercicioEncerrado,
    ...(b.totais
      ? { debitosCreditos: { ...b.totais, ok: Math.abs(b.totais.debito - b.totais.credito) <= TOLERANCIA } }
      : {}),
  };
  if (!provas.fechamento.ok) {
    avisos.push(`Fechamento não bate: Ativo ${fmt(ativoAtual)} − Passivo ${fmt(passivoAtual)} − Resultado ${fmt(resultadoAcumulado)} = ${fmt(delta)}.`);
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
    const resultadoDoCampo = campo === "saldoAtual"
      ? resultadoAcumulado
      : arred(folhasResultado.reduce((s, f) => s + assinadoDRE(f, "saldoAnterior"), 0));
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
  }

  return { periodoBP, periodoBPAnterior, arvoreBP, arvoreDRE, resultadoAcumulado, provas, avisos };
}

function temSaldosAnteriores(linhas: LinhaBalancete[]): boolean {
  return linhas.some((l) => Math.abs(l.saldoAnterior) > TOLERANCIA);
}

const arred = (n: number): number => Math.round(n * 100) / 100;
const fmt = (n: number): string => n.toLocaleString("pt-BR", { minimumFractionDigits: 2 });
