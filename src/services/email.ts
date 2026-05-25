import { env } from "../config/env";

interface SendOpts {
  to: string;
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
    console.log(`  TO:      ${opts.to}`);
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

const baseStyle = `
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #F5F2EC; color: #161513; max-width: 560px; margin: 0 auto; padding: 32px;
`;
const buttonStyle = `
  display: inline-block; background: #B8531C; color: #F5F2EC;
  padding: 12px 24px; text-decoration: none; font-weight: 500;
  letter-spacing: -0.01em; margin: 16px 0;
`;
const labelStyle = `font-family: 'JetBrains Mono', monospace; font-size: 11px;
  letter-spacing: 0.12em; color: #5A554C; text-transform: uppercase;`;

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
  const html = `<div style="${baseStyle}">
  <div style="${labelStyle}">○ CONVITE QUANTUA</div>
  <h1 style="font-size: 24px; font-weight: 500; letter-spacing: -0.02em; margin: 16px 0 12px;">
    ${v.rtName} convidou você para o portal de ${v.companyName}.
  </h1>
  <p style="font-family: Georgia, serif; line-height: 1.6; font-size: 15px;">
    ${greeting} no portal você revisa a carta de contratação, acompanha as fases do IBR
    em tempo real e envia documentos auditáveis com hash SHA-256.
  </p>
  <a href="${v.magicLink}" style="${buttonStyle}">Acessar portal →</a>
  <p style="${labelStyle} margin-top: 24px;">
    Convite expira em ${expiresFmt} · Uso único · Quantua Serviços de Análise Ltda.
  </p>
</div>`;
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
  const html = `<div style="${baseStyle}">
  <div style="${labelStyle}">✓ ENGAGEMENT LETTER ACEITA</div>
  <h1 style="font-size: 22px; font-weight: 500; margin: 16px 0 12px;">
    ${v.clientName} aceitou a carta de ${v.companyName}.
  </h1>
  <p style="font-family: Georgia, serif; line-height: 1.6; font-size: 15px;">
    Aceite registrado em ${signedFmt} com IP e user-agent auditados. O cliente já
    pode acessar o portal e iniciar a coleta de documentos.
  </p>
  <a href="${v.engagementUrl}" style="${buttonStyle}">Abrir engagement →</a>
</div>`;
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
  const accentColor = v.overdueDays > 0 ? "#A8351E" : "#B07A1B";
  const html = `<div style="${baseStyle}">
  <div style="${labelStyle} color: ${accentColor};">○ REVISÃO RECORRENTE</div>
  <h1 style="font-size: 22px; font-weight: 500; letter-spacing: -0.02em; margin: 16px 0 12px;">
    ${v.companyName} — revisão ${overdueText}.
  </h1>
  <p style="font-family: Georgia, serif; line-height: 1.6; font-size: 15px;">
    A próxima rodada do diagnóstico mensal de <strong>${v.analysisName}</strong> está programada
    para <strong>${dueFmt}</strong>. Você pode iniciar a coleta agora ou adiar 7 dias se ainda
    não tem documentos novos.
  </p>
  <a href="${v.inboxUrl}" style="${buttonStyle}">Abrir Inbox →</a>
  <p style="${labelStyle} margin-top: 24px;">
    Notificação automática · cadência mensal · Quantua Serviços de Análise Ltda.
  </p>
</div>`;
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
  const html = `<div style="${baseStyle}">
  <div style="${labelStyle}">○ CONVITE DE EQUIPE</div>
  <h1 style="font-size: 24px; font-weight: 500; letter-spacing: -0.02em; margin: 16px 0 12px;">
    ${v.invitedByName} convidou você para a equipe da ${v.workspaceName}.
  </h1>
  <p style="font-family: Georgia, serif; line-height: 1.6; font-size: 15px;">
    Você foi adicionado como <strong>${roleLabel}</strong>. Crie sua senha para acessar o workspace
    e começar a colaborar nos Independent Business Reviews.
  </p>
  <a href="${v.magicLink}" style="${buttonStyle}">Aceitar convite →</a>
  <p style="${labelStyle} margin-top: 24px;">
    Convite expira em ${expiresFmt} · Uso único · Quantua Serviços de Análise Ltda.
  </p>
</div>`;
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
  const html = `<div style="${baseStyle}">
  <div style="${labelStyle}">○ REDEFINIÇÃO DE SENHA</div>
  <h1 style="font-size: 22px; font-weight: 500; letter-spacing: -0.02em; margin: 16px 0 12px;">
    ${v.name}, redefina sua senha
  </h1>
  <p style="font-family: Georgia, serif; line-height: 1.6; font-size: 15px;">
    Clique no botão abaixo para criar uma nova senha. Se você não solicitou esta redefinição,
    pode ignorar este e-mail — sua senha continua a mesma.
  </p>
  <a href="${v.resetLink}" style="${buttonStyle}">Redefinir senha →</a>
  <p style="${labelStyle} margin-top: 24px;">
    Link expira em ${expiresFmt} · Uso único · Quantua Serviços de Análise Ltda.
  </p>
</div>`;
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
  const html = `<div style="${baseStyle}">
  <div style="${labelStyle}">○ CONFIRMAÇÃO DE E-MAIL</div>
  <h1 style="font-size: 22px; font-weight: 500; letter-spacing: -0.02em; margin: 16px 0 12px;">
    ${v.name}, confirme seu e-mail
  </h1>
  <p style="font-family: Georgia, serif; line-height: 1.6; font-size: 15px;">
    Para ativar sua conta e começar a usar o Quantua, clique no botão abaixo para confirmar seu e-mail.
  </p>
  <a href="${v.confirmLink}" style="${buttonStyle}">Confirmar e-mail →</a>
  <p style="${labelStyle} margin-top: 24px;">
    Link expira em ${expiresFmt} · Quantua Serviços de Análise Ltda.
  </p>
</div>`;
  return sendSafe({ to: v.to, subject, html, text });
}

export async function sendLeadConfirmationEmail(v: LeadConfirmationVars): Promise<{ ok: boolean; error?: string }> {
  const subject = `Recebemos sua solicitação · IBR · ${v.targetCompany}`;
  const greeting = v.contactName ? `${v.contactName},` : "Olá,";
  const text = `${greeting}

Recebemos sua solicitação de Independent Business Review para ${v.targetCompany}.

Um dos responsáveis técnicos da Quantua vai retornar em até 24h úteis com proposta e próximos passos.

Equipe Quantua`;
  const html = `<div style="${baseStyle}">
  <div style="${labelStyle}">○ SOLICITAÇÃO RECEBIDA</div>
  <h1 style="font-size: 22px; font-weight: 500; margin: 16px 0 12px;">
    Sua solicitação para ${v.targetCompany} chegou.
  </h1>
  <p style="font-family: Georgia, serif; line-height: 1.6; font-size: 15px;">
    ${greeting} um dos partners RT da Quantua vai retornar em até <strong>24h úteis</strong>
    com proposta e cronograma. Você não precisa fazer nada agora.
  </p>
  <p style="${labelStyle} margin-top: 24px;">
    Quantua Serviços de Análise Ltda. · IBR em 10 dias úteis
  </p>
</div>`;
  return sendSafe({ to: v.to, subject, html, text });
}
