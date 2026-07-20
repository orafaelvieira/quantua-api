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

  let rotulo = prefixo;
  if (periodo) rotulo += ` ${periodo}`;
  if (complemento) rotulo += ` — ${complemento}`;
  return { rotulo };
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
