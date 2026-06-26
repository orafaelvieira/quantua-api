import { env } from "../config/env";

interface SendOpts {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
}

interface EmailAdapter {
  send(opts: SendOpts): Promise<void>;
}

class ConsoleAdapter implements EmailAdapter {
  async send(opts: SendOpts): Promise<void> {
    console.log("\n[EMAIL · console adapter]");
    console.log(`  TO:      ${Array.isArray(opts.to) ? opts.to.join(", ") : opts.to}`);
    console.log(`  FROM:    ${env.email.from}`);
    console.log(`  SUBJECT: ${opts.subject}`);
    console.log(`  ---`);
    console.log(opts.text.split("\n").map((l) => `  ${l}`).join("\n"));
    console.log("[/EMAIL]\n");
  }
}

class ResendAdapter implements EmailAdapter {
  async send(opts: SendOpts): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.email.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.email.from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Resend error ${response.status}: ${body}`);
    }
  }
}

let adapter: EmailAdapter | null = null;
function getAdapter(): EmailAdapter {
  if (adapter) return adapter;
  adapter = env.email.provider === "resend" ? new ResendAdapter() : new ConsoleAdapter();
  return adapter;
}

async function sendSafe(opts: SendOpts): Promise<{ ok: boolean; error?: string }> {
  try {
    await getAdapter().send(opts);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[EMAIL] send failed:", message);
    return { ok: false, error: message };
  }
}

// ─── Design system (identidade visual Quantua, marca navy/gold) ──────────────
// Paleta navy/gold espelhando src/styles/theme.css do frontend. E-mail usa
// layout table-based (robusto em Outlook/Gmail) e fontes com fallback porque
// webfonts não carregam na maioria dos clientes.
const C = {
  paper: "#F6F7F9",
  paper2: "#EEF1F5",
  paper3: "#E3E8EF",
  ink: "#0C2642",
  ink2: "#1E3A57",
  ink3: "#55606E",
  ink4: "#8A93A1",
  accent: "#BC9544",
  accentPaper: "#FBF6EC",
  green: "#3D6B47",
  red: "#A8351E",
  amber: "#B07A1B",
  rule: "#0C26420F",
  rule2: "#0C264222",
};
const FONT_DISPLAY = `'Sora', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif`;
const FONT_MONO = `'JetBrains Mono', 'SFMono-Regular', Consolas, monospace`;
const FONT_BODY = `'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif`;
const DEFAULT_FOOTER = "Quantua Serviços de Análise Ltda. · IBR em 10 dias úteis";
// Logo da marca hospedada no front (servida em produção). Imagem PNG porque
// clientes de email bloqueiam SVG e data-URIs; `alt` cobre imagens bloqueadas.
const LOGO_URL = "https://quantua.com.br/email-logo.png";

/**
 * Envelope visual padrão Quantua: canvas → card centralizado com barra de
 * acento, header (wordmark + tagline), chip de eyebrow, corpo e rodapé.
 */
function renderShell(o: { eyebrow: string; body: string; footer?: string; accent?: string }): string {
  const accent = o.accent ?? C.accent;
  const chipBg = accent === C.accent ? C.accentPaper : C.paper3;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.paper3}; margin:0; padding:0;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px; background:${C.paper}; border:1px solid ${C.rule2};">
        <tr><td style="height:4px; background:${accent}; font-size:0; line-height:0;">&nbsp;</td></tr>
        <tr>
          <td style="padding:32px 40px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="vertical-align:middle;"><img src="${LOGO_URL}" alt="Quantua" width="103" height="30" style="display:block; border:0; height:30px; width:103px;"></td>
                <td align="right" style="vertical-align:middle; font-family:${FONT_MONO}; font-size:9px; letter-spacing:0.14em; color:${C.ink4}; text-transform:uppercase;">IBR · 10 dias úteis</td>
              </tr>
            </table>
            <div style="margin-top:26px;">
              <span style="display:inline-block; background:${chipBg}; color:${accent}; font-family:${FONT_MONO}; font-size:10px; letter-spacing:0.16em; text-transform:uppercase; padding:7px 11px;">${o.eyebrow}</span>
            </div>
          </td>
        </tr>
        <tr><td style="padding:18px 40px 36px;">${o.body}</td></tr>
        <tr>
          <td style="padding:22px 40px; background:${C.paper2}; border-top:1px solid ${C.rule};">
            <div style="font-family:${FONT_MONO}; font-size:10px; letter-spacing:0.12em; color:${C.ink4}; text-transform:uppercase; line-height:1.7;">${o.footer ?? DEFAULT_FOOTER}</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

function renderHeading(text: string): string {
  return `<h1 style="margin:0 0 12px; font-family:${FONT_DISPLAY}; font-size:23px; line-height:1.25; font-weight:600; letter-spacing:-0.02em; color:${C.ink};">${text}</h1>`;
}

function renderLede(html: string): string {
  return `<p style="margin:0 0 6px; font-family:${FONT_BODY}; font-size:15px; line-height:1.65; color:${C.ink2};">${html}</p>`;
}

function renderButton(href: string, label: string): string {
  // Botão "bulletproof": table com bgcolor para Outlook + <a> interno.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 4px;">
  <tr>
    <td bgcolor="${C.accent}" style="background:${C.accent};">
      <a href="${href}" style="display:inline-block; padding:14px 28px; font-family:${FONT_DISPLAY}; font-size:14px; font-weight:600; letter-spacing:0.01em; color:${C.paper}; text-decoration:none;">${label}</a>
    </td>
  </tr>
</table>`;
}

/**
 * Tabela key/value editorial (zebra striping) para os resumos enviados ao time.
 * Aceita pares [label, valor]; ignora pares com valor vazio/undefined.
 */
function renderDataRows(rows: Array<[string, string | null | undefined]>): string {
  const body = rows
    .filter(([, value]) => value != null && String(value).trim() !== "")
    .map(([label, value], i) => {
      const bg = i % 2 === 0 ? C.paper2 : C.paper;
      return `<tr>
      <td style="background:${bg}; font-family:${FONT_MONO}; font-size:10px; letter-spacing:0.10em; text-transform:uppercase; color:${C.ink3}; padding:11px 14px; vertical-align:top; white-space:nowrap; border-bottom:1px solid ${C.rule};">${label}</td>
      <td style="background:${bg}; font-family:${FONT_BODY}; font-size:14px; line-height:1.5; color:${C.ink}; padding:11px 16px; border-bottom:1px solid ${C.rule};">${value}</td>
    </tr>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse; margin:20px 0 4px; border:1px solid ${C.rule2};">${body}</table>`;
}

export interface InviteEmailVars {
  to: string;
  contactName?: string;
  companyName: string;
  rtName: string;
  magicLink: string;
  expiresAt: Date;
}

export async function sendInviteEmail(v: InviteEmailVars): Promise<{ ok: boolean; error?: string }> {
  const greeting = v.contactName ? `${v.contactName},` : "Olá,";
  const expiresFmt = v.expiresAt.toLocaleDateString("pt-BR", { day: "2-digit", month: "long" });
  const subject = `Convite Quantua · Independent Business Review · ${v.companyName}`;
  const text = `${greeting}

${v.rtName} convidou você para acompanhar o Independent Business Review da ${v.companyName} no portal Quantua.

Clique no link abaixo para revisar a carta de contratação e acessar o portal:

${v.magicLink}

Este convite expira em ${expiresFmt}. O link é de uso único — se algo der errado, peça um novo ao seu RT.

Equipe Quantua`;
  const body =
    renderHeading(`${v.rtName} convidou você para o portal de ${v.companyName}.`) +
    renderLede(
      `${greeting} no portal você revisa a carta de contratação, acompanha as fases do IBR em tempo real e envia documentos auditáveis com hash SHA-256.`,
    ) +
    renderButton(v.magicLink, "Acessar portal →");
  const html = renderShell({
    eyebrow: "Convite Quantua",
    body,
    footer: `Convite expira em ${expiresFmt} · Uso único · ${DEFAULT_FOOTER}`,
  });
  return sendSafe({ to: v.to, subject, html, text });
}

export interface EngagementSignedVars {
  to: string;
  rtName: string;
  clientName: string;
  companyName: string;
  signedAt: Date;
  engagementUrl: string;
}

export async function sendEngagementSignedEmail(v: EngagementSignedVars): Promise<{ ok: boolean; error?: string }> {
  const subject = `Carta aceita · ${v.companyName} · ${v.clientName}`;
  const signedFmt = v.signedAt.toLocaleString("pt-BR");
  const text = `${v.rtName},

${v.clientName} aceitou a carta de contratação de ${v.companyName} em ${signedFmt}.

Engagement: ${v.engagementUrl}

Equipe Quantua`;
  const body =
    renderHeading(`${v.clientName} aceitou a carta de ${v.companyName}.`) +
    renderLede(
      `Aceite registrado em <strong>${signedFmt}</strong> com IP e user-agent auditados. O cliente já pode acessar o portal e iniciar a coleta de documentos.`,
    ) +
    renderButton(v.engagementUrl, "Abrir engagement →");
  const html = renderShell({ eyebrow: "Carta aceita", body, accent: C.green });
  return sendSafe({ to: v.to, subject, html, text });
}

export interface DueReviewVars {
  to: string;
  rtName: string;
  companyName: string;
  analysisName: string;
  nextReviewAt: Date;
  overdueDays: number;
  inboxUrl: string;
}

export async function sendDueReviewEmail(v: DueReviewVars): Promise<{ ok: boolean; error?: string }> {
  const dueFmt = v.nextReviewAt.toLocaleDateString("pt-BR", { day: "2-digit", month: "long" });
  const overdueText =
    v.overdueDays > 0
      ? `vencida há ${v.overdueDays} dia${v.overdueDays === 1 ? "" : "s"}`
      : v.overdueDays === 0
      ? "vence hoje"
      : `vence em ${Math.abs(v.overdueDays)} dia${Math.abs(v.overdueDays) === 1 ? "" : "s"}`;
  const subject =
    v.overdueDays > 0
      ? `[Atrasada] Revisão mensal · ${v.companyName}`
      : `Revisão mensal · ${v.companyName} · ${dueFmt}`;
  const text = `${v.rtName},

A revisão recorrente de ${v.companyName} (${v.analysisName}) está ${overdueText} (data programada: ${dueFmt}).

Abra o Inbox para iniciar a próxima rodada ou adiar 7 dias:
${v.inboxUrl}

Equipe Quantua`;
  const accent = v.overdueDays > 0 ? C.red : C.amber;
  const body =
    renderHeading(`${v.companyName} — revisão ${overdueText}.`) +
    renderLede(
      `A próxima rodada do diagnóstico mensal de <strong>${v.analysisName}</strong> está programada para <strong>${dueFmt}</strong>. Você pode iniciar a coleta agora ou adiar 7 dias se ainda não tem documentos novos.`,
    ) +
    renderButton(v.inboxUrl, "Abrir Inbox →");
  const html = renderShell({
    eyebrow: "Revisão recorrente",
    body,
    accent,
    footer: `Notificação automática · cadência mensal · ${DEFAULT_FOOTER}`,
  });
  return sendSafe({ to: v.to, subject, html, text });
}

export interface TeamInviteVars {
  to: string;
  workspaceName: string;
  invitedByName: string;
  role: string; // "operator" | "reviewer" | "partner"
  magicLink: string;
  expiresAt: Date;
}

const ROLE_LABEL: Record<string, string> = {
  operator: "Analista",
  reviewer: "Revisor",
  partner: "Partner",
};

export async function sendTeamInviteEmail(v: TeamInviteVars): Promise<{ ok: boolean; error?: string }> {
  const expiresFmt = v.expiresAt.toLocaleDateString("pt-BR", { day: "2-digit", month: "long" });
  const roleLabel = ROLE_LABEL[v.role] ?? v.role;
  const subject = `Convite Quantua · ${v.workspaceName} · ${roleLabel}`;
  const text = `Olá,

${v.invitedByName} convidou você para integrar a equipe da ${v.workspaceName} no Quantua como ${roleLabel}.

Clique no link abaixo para criar sua senha e acessar o workspace:

${v.magicLink}

Este convite expira em ${expiresFmt}. O link é de uso único.

Equipe Quantua`;
  const body =
    renderHeading(`${v.invitedByName} convidou você para a equipe da ${v.workspaceName}.`) +
    renderLede(
      `Você foi adicionado como <strong>${roleLabel}</strong>. Crie sua senha para acessar o workspace e começar a colaborar nos Independent Business Reviews.`,
    ) +
    renderButton(v.magicLink, "Aceitar convite →");
  const html = renderShell({
    eyebrow: "Convite de equipe",
    body,
    footer: `Convite expira em ${expiresFmt} · Uso único · ${DEFAULT_FOOTER}`,
  });
  return sendSafe({ to: v.to, subject, html, text });
}

export interface LeadConfirmationVars {
  to: string;
  contactName?: string;
  targetCompany: string;
}

export interface PasswordResetVars {
  to: string;
  name: string;
  resetLink: string;
  expiresAt: Date;
}

export async function sendPasswordResetEmail(v: PasswordResetVars): Promise<{ ok: boolean; error?: string }> {
  const expiresFmt = v.expiresAt.toLocaleString("pt-BR", { day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" });
  const subject = `Redefinição de senha · Quantua`;
  const text = `${v.name},

Recebemos um pedido para redefinir sua senha no Quantua.

Clique no link abaixo para criar uma nova senha:

${v.resetLink}

Este link expira em ${expiresFmt}. Se você não solicitou a redefinição, ignore este e-mail — sua senha continua a mesma.

Equipe Quantua`;
  const body =
    renderHeading(`${v.name}, redefina sua senha`) +
    renderLede(
      `Clique no botão abaixo para criar uma nova senha. Se você não solicitou esta redefinição, pode ignorar este e-mail — sua senha continua a mesma.`,
    ) +
    renderButton(v.resetLink, "Redefinir senha →");
  const html = renderShell({
    eyebrow: "Redefinição de senha",
    body,
    footer: `Link expira em ${expiresFmt} · Uso único · ${DEFAULT_FOOTER}`,
  });
  return sendSafe({ to: v.to, subject, html, text });
}

export interface EmailConfirmationVars {
  to: string;
  name: string;
  confirmLink: string;
  expiresAt: Date;
}

export async function sendEmailConfirmationEmail(v: EmailConfirmationVars): Promise<{ ok: boolean; error?: string }> {
  const expiresFmt = v.expiresAt.toLocaleString("pt-BR", { day: "2-digit", month: "long" });
  const subject = `Confirme seu e-mail · Quantua`;
  const text = `${v.name},

Para ativar sua conta no Quantua, confirme seu endereço de e-mail clicando no link abaixo:

${v.confirmLink}

Este link expira em ${expiresFmt}.

Equipe Quantua`;
  const body =
    renderHeading(`${v.name}, confirme seu e-mail`) +
    renderLede(
      `Para ativar sua conta e começar a usar o Quantua, clique no botão abaixo para confirmar seu e-mail.`,
    ) +
    renderButton(v.confirmLink, "Confirmar e-mail →");
  const html = renderShell({
    eyebrow: "Confirmação de e-mail",
    body,
    footer: `Link expira em ${expiresFmt} · ${DEFAULT_FOOTER}`,
  });
  return sendSafe({ to: v.to, subject, html, text });
}

export async function sendLeadConfirmationEmail(v: LeadConfirmationVars): Promise<{ ok: boolean; error?: string }> {
  const subject = `Recebemos sua solicitação · IBR · ${v.targetCompany}`;
  const greeting = v.contactName ? `${v.contactName},` : "Olá,";
  const text = `${greeting}

Recebemos sua solicitação de Independent Business Review para ${v.targetCompany}.

Um dos responsáveis técnicos da Quantua vai retornar em até 24h úteis com proposta e próximos passos.

Equipe Quantua`;
  const body =
    renderHeading(`Sua solicitação para ${v.targetCompany} chegou.`) +
    renderLede(
      `${greeting} um dos partners RT da Quantua vai retornar em até <strong>24h úteis</strong> com proposta e cronograma. Você não precisa fazer nada agora.`,
    );
  const html = renderShell({ eyebrow: "Solicitação recebida", body });
  return sendSafe({ to: v.to, subject, html, text });
}

// ─── Notificações ao time (cada form de entrada do site) ────────────────────

/** Labels legíveis para os enums do Lead (espelham leads.ts). */
const REASON_LABEL: Record<string, string> = {
  credit_approval: "Aprovação de crédito",
  judicial_recovery: "Recuperação judicial",
  refinancing: "Refinanciamento",
  due_diligence: "Due diligence",
  monitoring: "Monitoramento",
  contabilidade_consultiva: "Contabilidade consultiva",
  bpo_financeiro: "BPO financeiro",
  cfoaas: "CFO as a Service",
  contabilidade_tradicional: "Contabilidade tradicional",
  contact: "Contato geral",
  integration_interest: "Interesse em integração",
};
const FIRM_TYPE_LABEL: Record<string, string> = {
  contabilidade_consultiva: "Contabilidade consultiva",
  bpo_financeiro: "BPO financeiro",
  cfoaas: "CFO as a Service",
  contabilidade_tradicional: "Contabilidade tradicional",
};
const PORTFOLIO_SIZE_LABEL: Record<string, string> = {
  lt30: "< 30 clientes",
  "30_80": "30–80 clientes",
  "80_200": "80–200 clientes",
  gt200: "> 200 clientes",
};
const MID_MARKET_LABEL: Record<string, string> = {
  lt30: "< 30%",
  "30_50": "30–50%",
  gt50: "> 50%",
  nao_sei: "Não sei",
};
const TEAM_SIZE_LABEL: Record<string, string> = {
  lt5: "< 5 pessoas",
  "5_15": "5–15 pessoas",
  "15_50": "15–50 pessoas",
  gt50: "> 50 pessoas",
};
const PRICING_MODEL_LABEL: Record<string, string> = {
  incluido_fee_fiscal: "Incluído no fee fiscal",
  hora_baseado: "Por hora",
  produto_separado: "Produto separado",
  nao_cobramos: "Não cobramos",
};
const CONTACT_ROLE_LABEL: Record<string, string> = {
  socio: "Sócio",
  gerente_carteira: "Gerente de carteira",
  analista: "Analista",
  outro: "Outro",
};
const WORKSPACE_TYPE_LABEL: Record<string, string> = {
  empresa: "Empresa",
  consultoria: "Consultoria",
};
const PARTNER_PROFILE_LABEL: Record<string, string> = {
  contabilidade: "Contabilidade",
  bpo: "BPO",
  cfo: "CFO as a Service",
};

/** Formato compacto pro corpo em texto puro: só os pares preenchidos. */
function textRows(rows: Array<[string, string | null | undefined]>): string {
  return rows
    .filter(([, value]) => value != null && String(value).trim() !== "")
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
}

export interface LeadNotificationLead {
  targetCompany: string;
  reason: string;
  contactName?: string | null;
  contactEmail?: string | null;
  contactRole?: string | null;
  contactPhone?: string | null;
  firmType?: string | null;
  portfolioSize?: string | null;
  portfolioMidMarketPct?: string | null;
  teamSize?: string | null;
  consultingPricingModel?: string | null;
  weeklyAvailability?: boolean | null;
  debtVolume?: string | null;
  notes?: string | null;
}

export interface LeadNotificationVars {
  to: string | string[];
  lead: LeadNotificationLead;
  inboxUrl: string;
}

export async function sendLeadNotificationEmail(v: LeadNotificationVars): Promise<{ ok: boolean; error?: string }> {
  const { lead } = v;
  const reasonLabel = REASON_LABEL[lead.reason] ?? lead.reason;
  const subject = `Novo lead · ${lead.targetCompany} · ${reasonLabel}`;
  const rows: Array<[string, string | null | undefined]> = [
    ["Empresa", lead.targetCompany],
    ["Motivo", reasonLabel],
    ["Contato", lead.contactName],
    ["E-mail", lead.contactEmail],
    ["Telefone", lead.contactPhone],
    ["Cargo", lead.contactRole ? CONTACT_ROLE_LABEL[lead.contactRole] ?? lead.contactRole : null],
    ["Tipo de firma", lead.firmType ? FIRM_TYPE_LABEL[lead.firmType] ?? lead.firmType : null],
    ["Carteira", lead.portfolioSize ? PORTFOLIO_SIZE_LABEL[lead.portfolioSize] ?? lead.portfolioSize : null],
    ["% mid-market", lead.portfolioMidMarketPct ? MID_MARKET_LABEL[lead.portfolioMidMarketPct] ?? lead.portfolioMidMarketPct : null],
    ["Equipe", lead.teamSize ? TEAM_SIZE_LABEL[lead.teamSize] ?? lead.teamSize : null],
    ["Modelo de preço", lead.consultingPricingModel ? PRICING_MODEL_LABEL[lead.consultingPricingModel] ?? lead.consultingPricingModel : null],
    ["Disponibilidade semanal", lead.weeklyAvailability == null ? null : lead.weeklyAvailability ? "Sim" : "Não"],
    ["Volume de dívida", lead.debtVolume],
    ["Observações", lead.notes],
  ];
  const text = `Novo lead recebido pelo site.

${textRows(rows)}

Abra o Inbox para triar:
${v.inboxUrl}

Quantua`;
  const body =
    renderHeading(`Novo lead · ${lead.targetCompany}`) +
    renderLede(`Chegou uma nova solicitação pelo site. Resumo abaixo — abra o Inbox para triar.`) +
    renderDataRows(rows) +
    renderButton(v.inboxUrl, "Abrir Inbox →");
  const html = renderShell({ eyebrow: "Novo lead", body });
  return sendSafe({ to: v.to, subject, html, text });
}

export interface ScheduleCallNotificationVars {
  to: string | string[];
  clientName: string;
  companyName: string;
  preferredDate: string;
  altDate?: string | null;
  notes?: string | null;
  portalUrl: string;
}

export async function sendScheduleCallNotificationEmail(v: ScheduleCallNotificationVars): Promise<{ ok: boolean; error?: string }> {
  const subject = `Cliente pediu call · ${v.companyName}`;
  const rows: Array<[string, string | null | undefined]> = [
    ["Cliente", v.clientName],
    ["Empresa", v.companyName],
    ["Data preferida", v.preferredDate],
    ["Data alternativa", v.altDate],
    ["Observações", v.notes],
  ];
  const text = `${v.clientName} (${v.companyName}) solicitou uma call de revisão.

${textRows(rows)}

Abra o engagement:
${v.portalUrl}

Quantua`;
  const body =
    renderHeading(`${v.clientName} pediu uma call · ${v.companyName}`) +
    renderLede(`O cliente solicitou uma call de revisão pelo portal. Combine o horário e responda.`) +
    renderDataRows(rows) +
    renderButton(v.portalUrl, "Abrir engagement →");
  const html = renderShell({ eyebrow: "Solicitação de call", body });
  return sendSafe({ to: v.to, subject, html, text });
}

export interface NewSignupNotificationVars {
  to: string | string[];
  name: string;
  email: string;
  workspaceType: string;
  partnerProfile?: string | null;
}

export async function sendNewSignupNotificationEmail(v: NewSignupNotificationVars): Promise<{ ok: boolean; error?: string }> {
  const wsLabel = WORKSPACE_TYPE_LABEL[v.workspaceType] ?? v.workspaceType;
  const subject = `Novo cadastro · ${wsLabel} · ${v.name}`;
  const rows: Array<[string, string | null | undefined]> = [
    ["Nome", v.name],
    ["E-mail", v.email],
    ["Tipo de workspace", wsLabel],
    ["Perfil ICP", v.partnerProfile ? PARTNER_PROFILE_LABEL[v.partnerProfile] ?? v.partnerProfile : null],
  ];
  const text = `Novo cadastro no Quantua.

${textRows(rows)}

Quantua`;
  const body =
    renderHeading(`Novo cadastro · ${v.name}`) +
    renderLede(`Uma nova conta foi criada pelo site.`) +
    renderDataRows(rows);
  const html = renderShell({ eyebrow: "Novo cadastro", body, accent: C.green });
  return sendSafe({ to: v.to, subject, html, text });
}
