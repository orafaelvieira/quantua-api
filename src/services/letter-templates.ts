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

/* ───────────────────────────────────────────────────────────────────────────
 * Proposal HTML renderer — reusado por:
 *   1. GET /engagements/:id/proposal-html (preview no browser)
 *   2. POST /engagements/:id/generate-proposal (Puppeteer → PDF)
 *
 * Single source of truth pro layout. Mudanças visuais ficam aqui — uma vez —
 * e propagam pra preview + PDF oficial.
 * ────────────────────────────────────────────────────────────────────────── */

export interface SignatureRenderInput {
  /** Tipo de signatário (ex.: "partner" | "client"). */
  signerType: string;
  signerName: string;
  signerEmail: string;
  signerCpf?: string | null;
  signedAt: Date;
  /** Hash da carta no momento da assinatura. Comparado com contentHash atual. */
  contentHash: string;
  letterVersion: string;
  ipAddress: string;
}

export interface ProposalHtmlInput {
  letter: RenderedLetter;
  /**
   * Assinaturas já registradas. Se vazio ou ausente, renderiza placeholder
   * "Aguardando assinatura". Se hash da assinatura ≠ hash atual da carta,
   * marca "ASSINATURA INVÁLIDA — conteúdo alterado após assinatura".
   */
  signatures?: SignatureRenderInput[];
}

function escapeHtmlForProposal(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatSignedAt(d: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  }).format(d);
}

function renderSignatureSection(input: ProposalHtmlInput): string {
  const signatures = input.signatures ?? [];
  if (signatures.length === 0) {
    return `
  <section class="signature-block">
    <h2>Assinatura digital</h2>
    <p class="signature-placeholder">Aguardando assinatura do solicitante.</p>
  </section>`;
  }

  const cards = signatures
    .map((s) => {
      const invalid = s.contentHash !== input.letter.contentHash;
      const invalidBanner = invalid
        ? `<div class="signature-invalid">ASSINATURA INVÁLIDA — Conteúdo da carta foi alterado após a assinatura (hash divergente).</div>`
        : "";
      const roleLabel =
        s.signerType === "partner" ? "RT (Partner)" :
        s.signerType === "client" ? "Cliente" :
        s.signerType;
      const cpfLine = s.signerCpf ? `<div class="signature-meta">CPF: ${escapeHtmlForProposal(s.signerCpf)}</div>` : "";
      return `
    <div class="signature-card${invalid ? " signature-card--invalid" : ""}">
      ${invalidBanner}
      <div class="signature-role">${escapeHtmlForProposal(roleLabel)}</div>
      <div class="signature-name">${escapeHtmlForProposal(s.signerName)}</div>
      <div class="signature-meta">${escapeHtmlForProposal(s.signerEmail)}</div>
      ${cpfLine}
      <div class="signature-meta">Assinado em: ${escapeHtmlForProposal(formatSignedAt(s.signedAt))} · IP ${escapeHtmlForProposal(s.ipAddress)}</div>
      <div class="signature-meta">Hash: <code>${escapeHtmlForProposal(s.contentHash.slice(0, 16))}…</code> · Versão ${escapeHtmlForProposal(s.letterVersion)}</div>
    </div>`;
    })
    .join("");

  return `
  <section class="signature-block">
    <h2>Assinatura digital</h2>
    ${cards}
  </section>`;
}

/**
 * Renderiza HTML completo da proposta. Pronto pra:
 *   - servir como text/html (preview com print-CSS pra Cmd+P → PDF)
 *   - passar pro Puppeteer com `page.setContent(html)` e gerar PDF binário
 */
export function renderProposalHtml(input: ProposalHtmlInput): string {
  const { letter } = input;
  const sectionsHtml = letter.sections
    .map(
      (s) =>
        `<section><h2>${escapeHtmlForProposal(s.title)}</h2>${s.body
          .split("\n")
          .map((p) => `<p>${escapeHtmlForProposal(p)}</p>`)
          .join("")}</section>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Proposta · ${escapeHtmlForProposal(letter.meta.companyName)} · Quantua</title>
  <style>
    @media print { @page { margin: 28mm 22mm; } }
    body { font-family: Georgia, 'Times New Roman', serif; background: #F6F7F9; color: #0C2642; max-width: 720px; margin: 0 auto; padding: 48px 32px; line-height: 1.65; }
    h1 { font-size: 28px; font-weight: 500; letter-spacing: -0.02em; margin-bottom: 8px; }
    h2 { font-size: 16px; font-weight: 600; margin-top: 32px; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.08em; color: #55606E; }
    .ref { font-family: 'Courier New', 'Consolas', monospace; font-size: 11px; letter-spacing: 0.1em; color: #8A93A1; text-transform: uppercase; margin-bottom: 24px; }
    p { margin: 8px 0; font-size: 15px; }
    .meta { background: #EEF1F5; padding: 16px; margin-bottom: 32px; font-size: 13px; }
    .meta div { margin: 4px 0; }
    .signature-block { margin-top: 48px; border-top: 1px solid #0C26422A; padding-top: 32px; }
    .signature-placeholder { font-style: italic; color: #8A93A1; }
    .signature-card { background: #EEF1F5; border-left: 3px solid #3D6B47; padding: 16px; margin-top: 16px; }
    .signature-card--invalid { border-left-color: #A8351E; background: #F4E0DA; }
    .signature-invalid { font-family: 'Courier New', 'Consolas', monospace; font-size: 11px; font-weight: bold; letter-spacing: 0.08em; color: #A8351E; text-transform: uppercase; margin-bottom: 12px; }
    .signature-role { font-family: 'Courier New', 'Consolas', monospace; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: #55606E; margin-bottom: 4px; }
    .signature-name { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
    .signature-meta { font-size: 12px; color: #1E3A57; margin-top: 4px; }
    .signature-meta code { font-family: 'Courier New', 'Consolas', monospace; }
    .footer { margin-top: 48px; font-size: 11px; color: #8A93A1; text-align: center; }
  </style>
</head>
<body>
  <div class="ref">○ PROPOSTA QUANTUA · ${escapeHtmlForProposal(letter.meta.reference)}</div>
  <h1>${escapeHtmlForProposal(letter.meta.companyName)}</h1>
  <div class="meta">
    <div><strong>Solicitante:</strong> ${escapeHtmlForProposal(letter.meta.requesterLine)}</div>
    <div><strong>RT:</strong> ${escapeHtmlForProposal(letter.meta.rtLine)}</div>
    <div><strong>Prazo de entrega:</strong> ${escapeHtmlForProposal(letter.meta.deadlineFormatted)}</div>
    <div><strong>Honorários:</strong> ${escapeHtmlForProposal(letter.meta.feeFormatted)}</div>
  </div>
  ${sectionsHtml}
${renderSignatureSection(input)}
  <p class="footer">
    Quantua Serviços de Análise Ltda. · Versão ${escapeHtmlForProposal(letter.version)} · Hash ${escapeHtmlForProposal(letter.contentHash.slice(0, 12))}…
  </p>
</body>
</html>`;
}
