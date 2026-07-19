import dotenv from "dotenv";
dotenv.config({ override: true });

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Variável de ambiente obrigatória não definida: ${key}`);
  return value;
}

function requiredIf(key: string, condition: boolean): string {
  const value = process.env[key];
  if (condition && !value) throw new Error(`Variável de ambiente obrigatória não definida: ${key}`);
  return value ?? "";
}

const emailProvider = (process.env.EMAIL_PROVIDER ?? "console") as "console" | "resend";

export const env = {
  port: parseInt(process.env.PORT ?? "3001"),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  frontendUrl: process.env.FRONTEND_URL ?? "http://localhost:5173",
  invitationSecret: process.env.INVITATION_SECRET ?? required("JWT_SECRET"),
  email: {
    provider: emailProvider,
    resendApiKey: requiredIf("RESEND_API_KEY", emailProvider === "resend"),
    from: process.env.EMAIL_FROM ?? "Quantua <onboarding@resend.dev>",
    /**
     * Caixa(s) do time que recebem notificação de cada form de entrada
     * (leads, contato, integração, agendar call, novo cadastro). Lista
     * separada por vírgula. Default = time fundador.
     */
    teamInbox: (
      process.env.TEAM_INBOX_EMAIL ??
      "emerson@valoo.com.br,giovanni@valoo.com.br,rafael@manzoti.com,jorge@valoo.com.br"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  spaces: {
    endpoint: process.env.SPACES_ENDPOINT ?? "",
    region: process.env.SPACES_REGION ?? "nyc3",
    bucket: process.env.SPACES_BUCKET ?? "",
    key: process.env.SPACES_KEY ?? "",
    secret: process.env.SPACES_SECRET ?? "",
    enabled: !!process.env.SPACES_KEY,
  },
  /**
   * Jobs schedulados (node-cron in-process).
   *
   * `JOBS_ENABLED` explícito continua mandando ("true"/"false"). Quando AUSENTE,
   * detectamos produção — porque depender só da env var deixou TODOS os crons
   * desligados em produção sem ninguém perceber (aviso semanal da CVM, varredura
   * de revisões, refresh de benchmarks): `JOBS_ENABLED=true` está no
   * `.do/app.yaml`, mas a spec do DigitalOcean só é aplicada por
   * `doctl apps update` — push no repositório NÃO a aplica, e não há acesso ao
   * painel para reaplicar. Diagnosticado em 19/07/2026 via /version
   * (jobs.enabled=false, nenhuma execução registrada em JobRun).
   *
   * Sinais de produção (ambos FALSOS na máquina de desenvolvimento, então o dev
   * continua sem disparar e-mail real): NODE_ENV=production ou o provedor de
   * e-mail real configurado. Para desligar em prod: JOBS_ENABLED=false.
   */
  jobs: {
    enabled:
      process.env.JOBS_ENABLED === "true" ? true
      : process.env.JOBS_ENABLED === "false" ? false
      : process.env.NODE_ENV === "production" || emailProvider === "resend",
    /** Timezone usado em todos os cron schedules. */
    timezone: process.env.JOBS_TZ ?? "America/Sao_Paulo",
  },
  /**
   * Token de trigger manual pros jobs via POST /admin/jobs/run/:jobName.
   * Default vazio = endpoint admin desabilitado. Setar via env em prod.
   */
  adminTriggerToken: process.env.ADMIN_TRIGGER_TOKEN ?? "",
  /**
   * Pipeline híbrido do IBR no /process (parser → IA Haiku nível 3 → fold).
   * LIGADO por padrão (opt-out): para desligar e voltar ao heurístico, setar
   * HIBRIDO_ATIVO=false. Mudado de opt-in→opt-out em jun/2026 porque o ambiente de
   * prod (DigitalOcean) não é acessível ao time p/ setar a env. Se a IA falhar/sem
   * crédito, o /process cai no heurístico (fallback do try/catch). A trava de
   * integridade protege (nunca mostra número errado como certo). Ver estado-atual-roadmap.
   */
  ibr: {
    hibridoAtivo: process.env.HIBRIDO_ATIVO !== "false",
  },
};
