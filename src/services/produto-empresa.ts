/**
 * PRODUTO DA EMPRESA (Workspace FP&A, W1) — regras puras do envelope de versões.
 *
 * Um produto ("Orçamento 2026", "Business Plan — Sementes") acumula VERSÕES:
 * registros inteiros de Analysis (IBR) ou FinancialModel (demais). As decisões
 * de 20/07/2026 que este módulo materializa:
 *
 *  - Versão é DECLARADA, nunca inferida por tipo+data (dois "Valuation 2026"
 *    podem ser trabalhos distintos — caso real da Move Farma).
 *  - Rótulo HÍBRIDO: prefixo do sistema + complemento livre (obrigatório no BP),
 *    com normalização anti-duplicata (mesmo padrão do normNomeConta do motor) —
 *    colisão vira a pergunta "nova versão de X?", nunca dois envelopes.
 *  - Vigência: IBR é DERIVADA (maior versão declarada com status Concluída) —
 *    automática ao concluir, SEM hook no fluxo do IBR (zero retrocesso). Nos
 *    demais produtos é ponteiro manual: "vigente" é decisão de negócio.
 *
 * Determinístico, sem I/O — as rotas fazem a persistência.
 */

export type TipoProduto = "ibr" | "valuation" | "orcamento" | "business-plan";

export const TIPOS_PRODUTO: TipoProduto[] = ["ibr", "valuation", "orcamento", "business-plan"];

/** Prefixo que o SISTEMA monta — o usuário só escolhe o complemento. */
export const PREFIXO_TIPO: Record<TipoProduto, string> = {
  ibr: "IBR",
  valuation: "Valuation",
  orcamento: "Orçamento",
  "business-plan": "Business Plan",
};

/** Uma versão dentro do envelope, na forma mínima que as regras precisam. */
export interface VersaoEnvelope {
  /** id do registro (Analysis ou FinancialModel). */
  id: string;
  produtoVersao: number;
  status: string;
}

/**
 * Normaliza rótulo para a trava anti-duplicata: sem acentos, caixa baixa,
 * espaços colapsados, travessão/hífen unificados. "Orçamento 2026" e
 * "Orcamento-2026" colidem de propósito.
 */
export function normalizarRotulo(s: string): string {
  return (s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[—–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Monta o rótulo híbrido. `periodo` é o ano/exercício quando fizer sentido
 * (orçamento/valuation); `complemento` é o texto livre do analista.
 * BP exige complemento — "Business Plan" sozinho não identifica nada.
 */
export function montarRotulo(
  tipo: TipoProduto,
  opts: { periodo?: string | null; complemento?: string | null } = {}
): { rotulo: string; erro?: string } {
  const prefixo = PREFIXO_TIPO[tipo];
  const periodo = opts.periodo?.trim() || "";
  const complemento = opts.complemento?.trim() || "";

  if (tipo === "business-plan" && !complemento) {
    return { rotulo: "", erro: "Business Plan precisa de um nome — ele identifica a iniciativa (ex.: “Sementes”, “Filial Sorriso”)." };
  }
  if (tipo === "orcamento" && !/^\d{4}$/.test(periodo)) {
    return { rotulo: "", erro: "Orçamento precisa do ano do exercício (ex.: 2026) — é ele que identifica o produto." };
  }

  // ANO SÓ NO ORÇAMENTO (decisão do usuário, 24/07/2026): o exercício É o
  // produto orçamentário — 2027 tem metas próprias, é outro produto. Em IBR e
  // Valuation o ano é atributo da VERSÃO (a data-base), não do produto: a
  // relação com a empresa é contínua e reavaliar em 2027 é v3, não outro
  // trabalho. No BP quem identifica é a iniciativa.
  let rotulo = prefixo;
  if (tipo === "orcamento") rotulo += ` ${periodo}`;
  if (complemento) rotulo += ` — ${complemento}`;
  return { rotulo };
}

const MESES_ABREV = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** (2025, 12) → "dez/25". Formato curto da data-base no nome do documento. */
export function mesAbreviado(ano: number, mes: number): string {
  if (!Number.isFinite(ano) || !Number.isFinite(mes) || mes < 1 || mes > 12) return "";
  return `${MESES_ABREV[mes - 1]}/${String(ano).slice(-2)}`;
}

/**
 * DATA-BASE DO MODELO: o fecho do mês ANTERIOR ao início da projeção — o
 * balanço que abre o estudo. "2026-07" → "jun/26" (é a mesma data-base que o
 * wizard já mostra no passo do horizonte).
 */
export function dataBaseDoModelo(mesInicial: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(mesInicial || "");
  if (!m) return "";
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  return mes === 1 ? mesAbreviado(ano - 1, 12) : mesAbreviado(ano, mes - 1);
}

/**
 * DATA-BASE DO IBR (regra do usuário, 24/07/2026): a data do ÚLTIMO documento
 * usado — ou seja, o fim do último período extraído. "31/12/2023 a 31/12/2024 a
 * 31/12/2025" → "dez/25"; "2023 · 2024 · 2025" → "dez/25" (exercício fechado).
 * A data de REALIZAÇÃO do IBR não entra no nome: fica no sistema, para controle.
 */
export function dataBaseDoIbr(periodo?: string | null, periodosExtraidos?: string[] | null): string {
  // FONTE PREFERIDA: os períodos EXTRAÍDOS — a data do último documento, que é
  // a definição da data-base. O campo `periodo` é texto de exibição e às vezes
  // chega sem o mês de fechamento ("2024 · 2025 · 2026-LTM"), caso em que ele
  // sozinho não diz quando a série termina.
  const lista = (periodosExtraidos ?? []).filter((s): s is string => typeof s === "string" && !!s.trim());
  const alvo = lista.length
    ? lista[lista.length - 1]!.trim()
    : ((periodo || "").split(/\s+a\s+|·|;|,/).map((s) => s.trim()).filter(Boolean).pop() ?? "");
  if (!alvo) return "";

  // dd/mm/aaaa — o dia não entra no nome; a data-base é o MÊS de fechamento.
  const dma = /(\d{2})\/(\d{2})\/(\d{4})/.exec(alvo);
  if (dma) return mesAbreviado(Number(dma[3]), Number(dma[2]));
  const anoMes = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(alvo);
  if (anoMes) return mesAbreviado(Number(anoMes[1]), Number(anoMes[2]));
  // Exercício fechado ("2025") encerra em dezembro.
  if (/^\d{4}$/.test(alvo)) return mesAbreviado(Number(alvo), 12);
  // "2026-LTM" e afins: o mês de fechamento não está declarado — não se inventa
  // data. Sem data-base, o nome sai sem ela.
  return "";
}

/**
 * NOME DO DOCUMENTO (padrão da casa, 24/07/2026): produto + empresa +
 * data-base (ou ano, no orçamento; ou a iniciativa, no BP) + versão.
 *
 * Versionar NÃO renomeia: todas as versões do produto carregam o mesmo nome,
 * mudando só o sufixo — antes, duas versões do mesmo valuation nasciam com o
 * nome idêntico e fora da pilha ninguém distinguia uma da outra.
 */
export function nomeDocumento(opts: {
  tipo: TipoProduto;
  empresa: string;
  /** BP: a iniciativa. IBR/Valuation: o complemento opcional do produto. */
  complemento?: string | null;
  /** "dez/25" — IBR e Valuation. */
  dataBase?: string | null;
  /** "2026" — só orçamento. */
  ano?: string | null;
  versao: number;
}): string {
  const empresa = (opts.empresa || "").trim();
  const complemento = opts.complemento?.trim() || "";
  const base = `${PREFIXO_TIPO[opts.tipo]}${empresa ? ` ${empresa}` : ""}`;
  const sufixo = ` · v${opts.versao}`;
  if (opts.tipo === "orcamento") {
    const ano = opts.ano?.trim() || "";
    return `${base}${ano ? ` ${ano}` : ""}${complemento ? ` — ${complemento}` : ""}${sufixo}`;
  }
  if (opts.tipo === "business-plan") {
    return `${base}${complemento ? ` — ${complemento}` : ""}${sufixo}`;
  }
  const dataBase = opts.dataBase?.trim() || "";
  return `${base}${complemento ? ` — ${complemento}` : ""}${dataBase ? ` · ${dataBase}` : ""}${sufixo}`;
}

/** Próxima versão do envelope: monotônica, nunca reaproveita número. */
export function proximaVersao(versoes: Array<Pick<VersaoEnvelope, "produtoVersao">>): number {
  return versoes.reduce((max, v) => Math.max(max, v.produtoVersao || 0), 0) + 1;
}

/** Status que tornam uma versão de IBR elegível a vigente. */
const STATUS_IBR_CONCLUIDO = new Set(["Concluída", "Concluido", "Concluído"]);

/**
 * Resolve a versão VIGENTE do envelope.
 *
 * IBR: derivada — a MAIOR versão declarada cujo status é Concluída. Derivar (em
 * vez de gravar ponteiro via hook no fluxo do IBR) é o que garante zero contato
 * com código protegido: concluir o IBR v3 o torna vigente sem que o fluxo dele
 * saiba que envelopes existem.
 *
 * Demais tipos: o ponteiro manual, validado contra o conteúdo do envelope
 * (ponteiro para registro que saiu do envelope = null, nunca um chute).
 */
export function vigenteDoEnvelope(
  tipo: TipoProduto,
  versaoVigenteId: string | null | undefined,
  versoes: VersaoEnvelope[]
): string | null {
  if (tipo === "ibr") {
    const concluidas = versoes
      .filter((v) => STATUS_IBR_CONCLUIDO.has(v.status))
      .sort((a, b) => b.produtoVersao - a.produtoVersao);
    return concluidas[0]?.id ?? null;
  }
  if (!versaoVigenteId) return null;
  return versoes.some((v) => v.id === versaoVigenteId) ? versaoVigenteId : null;
}

/**
 * Um registro pode entrar neste envelope?
 *  - IBR só aceita Analysis; os demais só FinancialModel.
 *  - O objetivo do modelo precisa casar com o tipo do envelope ("ambos" serve
 *    a valuation e a orçamento — é o que o nome diz).
 */
export function tipoCompativel(
  tipo: TipoProduto,
  origem: "analysis" | "model",
  objetivoModelo?: string | null
): { ok: boolean; erro?: string } {
  if (tipo === "ibr") {
    return origem === "analysis"
      ? { ok: true }
      : { ok: false, erro: "Um envelope de IBR só recebe IBRs." };
  }
  if (origem !== "model") {
    return { ok: false, erro: `Um envelope de ${PREFIXO_TIPO[tipo]} só recebe modelos financeiros.` };
  }
  const obj = objetivoModelo || "";
  const aceita =
    tipo === "valuation" ? obj === "valuation" || obj === "ambos"
    : tipo === "orcamento" ? obj === "orcamento" || obj === "ambos"
    : obj === "business-plan";
  return aceita
    ? { ok: true }
    : { ok: false, erro: `Este modelo é "${obj || "sem objetivo"}" — não entra num envelope de ${PREFIXO_TIPO[tipo]}.` };
}
