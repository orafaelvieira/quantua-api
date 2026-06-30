import "dotenv/config";
import express from "express";
import cors from "cors";
import { env } from "./config/env";

import authRouter from "./routes/auth";
import onboardingRouter from "./routes/onboarding";
import companiesRouter from "./routes/companies";
import analysesRouter from "./routes/analyses";
import ibrRouter from "./routes/ibr";
import documentsRouter from "./routes/documents";
import dictionaryRouter from "./routes/dictionary";
import standardModelsRouter from "./routes/standard-models";
import auditRouter from "./routes/audit";
import engagementsRouter from "./routes/engagements";
import operationsRouter from "./routes/operations";
import clientPortalRouter from "./routes/client-portal";
import leadsRouter from "./routes/leads";
import inboxRouter from "./routes/inbox";
import billingRouter from "./routes/billing";
import teamRouter from "./routes/team";
import sectorsRouter from "./routes/sectors";
import adminRouter from "./routes/admin";
import peersRouter from "./routes/peers";
import { startJobs } from "./jobs";
import { prisma } from "./db/client";

const app = express();

app.use(cors({
  origin: [
    env.frontendUrl,
    "https://quantua.com.br",
    "https://www.quantua.com.br",
    "https://walrus-app-bizfv.ondigitalocean.app",
    "http://localhost:5173",
    "http://localhost:5174",
  ],
  credentials: true,
}));
app.use(express.json({ limit: "5mb" }));

// Request logger (dev) — drop in production once stable.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/onboarding", onboardingRouter);
app.use("/companies", companiesRouter);
// IBR routes nested under /analyses (stcf, scenarios, options, summary, review,
// sign, audit, time). Mounted before main analyses to share the same prefix.
app.use("/analyses", ibrRouter);
app.use("/analyses", analysesRouter);
app.use("/documents", documentsRouter);
app.use("/dictionary", dictionaryRouter);
app.use("/standard-models", standardModelsRouter);
app.use("/audit", auditRouter);
app.use("/engagements", engagementsRouter);
app.use("/operations", operationsRouter);
app.use("/client-portal", clientPortalRouter);
app.use("/leads", leadsRouter);
app.use("/inbox", inboxRouter);
app.use("/billing", billingRouter);
app.use("/team", teamRouter);
app.use("/sectors", sectorsRouter);
app.use("/admin", adminRouter);
app.use("/peers", peersRouter);

app.listen(env.port, () => {
  console.log(`Server running on port ${env.port}`);
  startJobs();
  // Recuperação de jobs órfãos: o /process é assíncrono (fire-and-forget). Se um restart/
  // deploy mata o servidor no meio do processamento, a análise ficaria presa em "Extraindo"/
  // "Gerando diagnóstico" girando o spinner pra sempre. No boot, marcamos essas como "Erro"
  // → o usuário vê o erro e pode reprocessar.
  prisma.analysis
    .updateMany({
      where: { status: { in: ["Extraindo", "Gerando diagnóstico"] } },
      data: { status: "Erro" },
    })
    .then((r) => { if (r.count > 0) console.log(`[boot] ${r.count} análise(s) presa(s) em processamento → "Erro" (reprocessável)`); })
    .catch((e) => console.error("[boot] recuperação de jobs órfãos falhou:", e?.message ?? e));
});
