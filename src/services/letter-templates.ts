import crypto from "crypto";

export const CURRENT_LETTER_VERSION = "v1.0";

export interface LetterRenderInput {
  engagementId: string;
  companyName: string;
  cnpj?: string | null;
  requestedBy: string;
  requestedByType: string;
  scope: string;
  feeAmount?: number | null;
  feeCurrency?: string | null;
  deadline?: Date | null;
  rtName?: string | null;
  rtRegistration?: string | null;
}

export interface RenderedLetter {
  text: string;
  contentHash: string;
  version: string;
  sections: LetterSection[];
  meta: LetterMeta;
}

export interface LetterSection {
  title: string;
  body: string;
}

export interface LetterMeta {
  reference: string;
  companyName: string;
  cnpj?: string | null;
  requesterLine: string;
  rtLine: string;
  feeFormatted: string;
  deadlineFormatted: string;
}

const REQUESTER_TYPE_LABEL: Record<string, string> = {
  lender: "Mesa de Reestruturação",
  investor: "Investidor / Fundo de crédito",
  advisor: "Advisor / RJ",
  other: "Outro",
};

function formatBRL(amount: number | null | undefined, currency: string | null | undefined): string {
  if (!amount) return "Conforme proposta separada";
  const fmt = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: currency ?? "BRL",
    minimumFractionDigits: 2,
  }).format(amount);
  return fmt;
}

function formatDeadline(d: Date | null | undefined): string {
  if (!d) return "10 (dez) dias úteis a contar da assinatura";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(d);
}

export function renderLetter(input: LetterRenderInput): RenderedLetter {
  const requesterLabel = REQUESTER_TYPE_LABEL[input.requestedByType] ?? "Solicitante";
  const requesterLine = `${input.requestedBy} · ${requesterLabel}`;
  const rtLine = input.rtName
    ? `${input.rtName}${input.rtRegistration ? " · " + input.rtRegistration : ""}`
    : "Partner técnico responsável a ser designado";
  const feeFormatted = formatBRL(input.feeAmount, input.feeCurrency);
  const deadlineFormatted = formatDeadline(input.deadline);
  const reference = `IBR-${input.engagementId.slice(0, 8).toUpperCase()}`;

  const meta: LetterMeta = {
    reference,
    companyName: input.companyName,
    cnpj: input.cnpj,
    requesterLine,
    rtLine,
    feeFormatted,
    deadlineFormatted,
  };

  const cnpjLine = input.cnpj ? ` (CNPJ ${input.cnpj})` : "";
  const scopeLine = input.scope?.trim() ? input.scope.trim() : "IBR Full · escopo padrão Quantua";

  const sections: LetterSection[] = [
    {
      title: "1. Objeto",
      body:
        "Quantua, na qualidade de terceiro independente, conduzirá Independent Business Review da empresa-alvo, com objetivo de subsidiar o Solicitante na decisão de continuidade, reestruturação ou aceleração da posição creditícia.",
    },
    {
      title: "2. Escopo & entregável",
      body:
        `${scopeLine}. O entregável padrão Quantua inclui: sumário executivo com recomendação ao credor, ` +
        "histórico financeiro (últimos 3 anos), working capital review, fluxo de caixa de 13 semanas (STCF), " +
        "projeções, análise de sensibilidade em três cenários (Base/Downside/Severo), opções estratégicas em quatro pilares, " +
        "covenants & KPIs e anexos com hash SHA-256 dos documentos-fonte.",
    },
    {
      title: "3. Prazo",
      body: `${deadlineFormatted} (entrega assinada pelo RT em até 10 dias úteis).`,
    },
    {
      title: "4. Honorários",
      body: `${feeFormatted}, faturados 50% à assinatura desta carta e 50% à entrega assinada (NF emitida na conclusão).`,
    },
    {
      title: "5. Independência & confidencialidade",
      body:
        "Quantua declara não possuir vínculo societário, comercial ou pessoal com a Empresa-alvo que comprometa a independência exigida. " +
        "Toda informação trocada está sob NDA implícito; o data room permanece disponível por 24 meses para auditoria.",
    },
  ];

  const headerText = [
    "QUANTUA SERVIÇOS DE ANÁLISE LTDA. · CONFIDENCIAL",
    "",
    "Carta de contratação · Independent Business Review",
    "",
    `Solicitante: ${requesterLine}`,
    `Empresa-alvo: ${input.companyName}${cnpjLine}`,
    `Referência: ${reference}`,
    `Responsável técnico: ${rtLine}`,
    "",
  ].join("\n");

  const text =
    headerText +
    sections.map((s) => `${s.title}\n${s.body}\n`).join("\n");

  const contentHash = crypto
    .createHash("sha256")
    .update(text + "|" + CURRENT_LETTER_VERSION)
    .digest("hex");

  return {
    text,
    contentHash,
    version: CURRENT_LETTER_VERSION,
    sections,
    meta,
  };
}
