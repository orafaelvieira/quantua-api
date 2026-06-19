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
   * Jobs schedulado (node-cron in-process). Default desabilitado em dev pra
   * não disparar emails reais durante desenvolvimento. Em prod, setar
   * JOBS_ENABLED=true via .do/app.yaml.
   */
  jobs: {
    enabled: process.env.JOBS_ENABLED === "true",
    /** Timezone usado em todos os cron schedules. */
    timezone: process.env.JOBS_TZ ?? "America/Sao_Paulo",
  },
  /**
   * Token de trigger manual pros jobs via POST /admin/jobs/run/:jobName.
   * Default vazio = endpoint admin desabilitado. Setar via env em prod.
   */
  adminTriggerToken: process.env.ADMIN_TRIGGER_TOKEN ?? "",
};
