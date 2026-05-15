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
  },
  spaces: {
    endpoint: process.env.SPACES_ENDPOINT ?? "",
    region: process.env.SPACES_REGION ?? "nyc3",
    bucket: process.env.SPACES_BUCKET ?? "",
    key: process.env.SPACES_KEY ?? "",
    secret: process.env.SPACES_SECRET ?? "",
    enabled: !!process.env.SPACES_KEY,
  },
};
