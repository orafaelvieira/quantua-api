/**
 * Demo content seed — Quantua Demo Advisory.
 *
 * Cria um workspace de demonstração com time, pipeline de leads, engagements
 * em estados diferentes do lifecycle e 3 IBRs (1 em curso, 1 completed, 1 won).
 *
 * Idempotente: detecta o workspace de demo via CNPJ sentinela e re-cria do zero
 * a cada execução (cascateia delete dos users → companies → analyses → docs etc.).
 *
 * Não toca em dados não-demo. Leads de demo são identificados pelo sufixo
 * `@quantua-demo.test` no contactEmail.
 *
 * Como rodar:
 *   npm run db:seed:demo
 *
 * Credenciais geradas:
 *   partner@quantua-demo.test  / demo1234  (Rafael Vieira RT — partner)
 *   reviewer@quantua-demo.test / demo1234  (Mariana Costa — reviewer)
 *   operator@quantua-demo.test / demo1234  (João Pereira — operator)
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const DEMO_CNPJ = "00.000.001/0001-91";
const DEMO_EMAIL_DOMAIN = "@quantua-demo.test";
const DEMO_PASSWORD = "demo1234";

async function clean() {
  console.log("→ Limpando dados de demo anteriores…");

  const ws = await prisma.workspace.findFirst({ where: { cnpj: DEMO_CNPJ } });
  if (ws) {
    // Find users in this workspace
    const users = await prisma.user.findMany({ where: { workspaceId: ws.id } });
    console.log(`  ${users.length} user(s) demo encontrados — cascateando delete`);
    for (const u of users) {
      // Deleting user cascades: companies → analyses → documents → audit/time/etc.
      await prisma.user.delete({ where: { id: u.id } }).catch((e) => {
        console.warn(`  falhou delete user ${u.email}: ${e.message}`);
      });
    }
    await prisma.workspace.delete({ where: { id: ws.id } });
    console.log("  workspace removido");
  } else {
    console.log("  nenhum workspace demo prévio");
  }

  // Demo leads (independentes de workspace — limpa pelo email pattern)
  const leadCount = await prisma.lead.deleteMany({
    where: { contactEmail: { endsWith: DEMO_EMAIL_DOMAIN } },
  });
  console.log(`  ${leadCount.count} lead(s) demo removidos`);
}

async function seed() {
  console.log("→ Criando workspace de demo…");
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const now = new Date();

  // 1. Workspace
  const workspace = await prisma.workspace.create({
    data: {
      type: "consultoria",
      cnpj: DEMO_CNPJ,
      razaoSocial: "Quantua Demo Advisory Ltda.",
      nomeFantasia: "Quantua Demo Restructuring",
      setor: "Restructuring & Special Situations",
      porte: "pequena",
      defaultCurrency: "BRL",
      fiscalYearStart: "january",
      auditLogsOn: true,
    },
  });
  console.log(`  workspace ${workspace.id}`);

  // 2. Users
  console.log("→ Criando time…");
  const partner = await prisma.user.create({
    data: {
      email: `partner${DEMO_EMAIL_DOMAIN}`,
      name: "Rafael Vieira",
      passwordHash,
      workspaceType: "consultoria",
      role: "partner",
      professionalRegistration: "CRC/SP-1RJ-12345",
      cargo: "Sócio · Responsável Técnico (RT)",
      phone: "+55 11 99999-0001",
      onboardedAt: now,
      workspaceId: workspace.id,
    },
  });
  const reviewer = await prisma.user.create({
    data: {
      email: `reviewer${DEMO_EMAIL_DOMAIN}`,
      name: "Mariana Costa",
      passwordHash,
      workspaceType: "consultoria",
      role: "reviewer",
      cargo: "Diretora · Revisora Técnica",
      phone: "+55 11 99999-0002",
      onboardedAt: now,
      workspaceId: workspace.id,
    },
  });
  const operator = await prisma.user.create({
    data: {
      email: `operator${DEMO_EMAIL_DOMAIN}`,
      name: "João Pereira",
      passwordHash,
      workspaceType: "consultoria",
      role: "operator",
      cargo: "Analista Sênior",
      phone: "+55 11 99999-0003",
      onboardedAt: now,
      workspaceId: workspace.id,
    },
  });
  console.log(`  partner ${partner.email} | reviewer ${reviewer.email} | operator ${operator.email}`);

  // 3. Companies (empresas-alvo dos engagements)
  console.log("→ Criando empresas-alvo…");
  const frigorifico = await prisma.company.create({
    data: {
      userId: partner.id,
      razaoSocial: "Frigorífico Pampa Ltda.",
      nomeFantasia: "Pampa Carnes",
      cnpj: "12.345.678/0001-01",
      setor: "Frigorífico · Carne Bovina",
      porte: "média",
      uf: "RS",
      status: "ativo",
    },
  });
  const textil = await prisma.company.create({
    data: {
      userId: partner.id,
      razaoSocial: "Têxtil Sul Mineiro S.A.",
      nomeFantasia: "TSM Têxtil",
      cnpj: "23.456.789/0001-02",
      setor: "Indústria Têxtil · Algodão",
      porte: "pequena",
      uf: "MG",
      status: "ativo",
    },
  });
  const logistica = await prisma.company.create({
    data: {
      userId: partner.id,
      razaoSocial: "Logística Centro-Oeste S.A.",
      nomeFantasia: "Centro-Oeste Cargas",
      cnpj: "34.567.890/0001-03",
      setor: "Transporte Rodoviário de Carga",
      porte: "média",
      uf: "GO",
      status: "ativo",
    },
  });
  console.log(`  ${frigorifico.razaoSocial} | ${textil.razaoSocial} | ${logistica.razaoSocial}`);

  // 4. Leads (pipeline)
  console.log("→ Criando pipeline de leads…");
  const leads = [
    {
      targetCompany: "Indústria Calçadista Vale do Sinos S.A.",
      reason: "refinancing",
      debtVolume: "R$ 35-50M",
      contactName: "Carlos Henrique Schneider",
      contactEmail: `calcadista${DEMO_EMAIL_DOMAIN}`,
      notes: "Bridge loan vencendo em 90d. Banco principal pediu IBR antes do reperfilamento.",
      status: "new",
    },
    {
      targetCompany: "Construtora Águas Claras Ltda.",
      reason: "judicial_recovery",
      debtVolume: "R$ 80-120M",
      contactName: "Beatriz Almeida (advisor)",
      contactEmail: `aguasclaras${DEMO_EMAIL_DOMAIN}`,
      notes: "RJ iminente. Credores debenturistas pedindo IBR independente antes da AGC.",
      status: "new",
    },
    {
      targetCompany: "Distribuidora Norte Pará S.A.",
      reason: "due_diligence",
      debtVolume: "R$ 15-25M",
      contactName: "Ricardo Tanaka (fundo de PE)",
      contactEmail: `nortepara${DEMO_EMAIL_DOMAIN}`,
      notes: "Aquisição em curso. Buyer-side DD pelo lado financeiro.",
      status: "contacted",
    },
    {
      targetCompany: "Hospital Cardiocenter Sul Ltda.",
      reason: "refinancing",
      debtVolume: "R$ 25-40M",
      contactName: "Dr. Paulo Henriques",
      contactEmail: `cardio${DEMO_EMAIL_DOMAIN}`,
      notes: "Pre-call agendada. Tendência ao engagement — credit committee pediu IBR.",
      status: "qualified",
    },
    {
      targetCompany: "Brasil Foods Mineiros Ltda.",
      reason: "monitoring",
      debtVolume: "R$ 60-90M",
      contactName: "Sérgio Mendes (CFO)",
      contactEmail: `bfm${DEMO_EMAIL_DOMAIN}`,
      notes: "Optou por concorrente. Manter relacionamento.",
      status: "lost",
    },
  ];
  for (const lead of leads) {
    await prisma.lead.create({ data: { ...lead, desiredDeadline: null } });
  }
  console.log(`  ${leads.length} leads no pipeline`);

  // 5. Analyses + Engagements
  console.log("→ Criando engagements + IBRs…");

  // 5a. Frigorífico Pampa — IBR em curso (kicked_off, dia 7/10)
  const ibrFrigorifico = await prisma.analysis.create({
    data: {
      companyId: frigorifico.id,
      userId: partner.id,
      nome: "IBR Frigorífico Pampa · Jun/2026",
      periodo: "2024 · 2025 · 2026-LTM",
      tipo: "Completa",
      status: "Em andamento",
      kind: "ibr",
      ibrType: "full",
      reviewState: "draft",
      confianca: 87,
    },
  });
  const engFrigorifico = await prisma.engagement.create({
    data: {
      analysisId: ibrFrigorifico.id,
      userId: partner.id,
      rtId: partner.id,
      companyName: frigorifico.razaoSocial,
      requestedBy: "Banco Beta · Mesa de Reestruturação",
      requestedByType: "lender",
      scope:
        "IBR completo para suportar decisão de reperfilamento da dívida bruta de R$ 47M. Análise focal em sustentabilidade operacional, ciclo de caixa e cenários de stress.",
      state: "kicked_off",
      deadline: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000), // +3 dias
      feeAmount: 90000,
      feeCurrency: "BRL",
      signedAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), // -7 dias
      letterAcceptedAt: new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000),
      letterContentHash: "sha256:demo-frigorifico-v1",
      letterVersion: "v1.0",
      notes: "Cliente colaborativo. Data room 80% completo. Stress test severo a entregar até dia +3.",
    },
  });

  // 5b. Têxtil Sul Mineiro — IBR completed (entregue há 3 semanas, assinado)
  const ibrTextil = await prisma.analysis.create({
    data: {
      companyId: textil.id,
      userId: partner.id,
      nome: "IBR Têxtil Sul Mineiro · Abr/2026",
      periodo: "2023 · 2024 · 2025",
      tipo: "Completa",
      status: "Concluído",
      kind: "ibr",
      ibrType: "full",
      reviewState: "signed",
      confianca: 92,
      executiveSummary: {
        recommendationToLender: "restructure",
        rationale:
          "Operação core do segmento de algodão tem viabilidade clara após reperfilamento. " +
          "Margem EBITDA recuperável para 11-13% em 18 meses condicional a: " +
          "(i) reperfilamento de R$ 22M de CP para LP em 5 anos, " +
          "(ii) descontinuação da linha de tinturaria (não-core, EBITDA negativo de R$ 2.8M/ano) e " +
          "(iii) renegociação de contratos com 3 fornecedores estratégicos.",
        keyRisks: [
          "Exposição a oscilação cambial via insumos importados (~22% do CMV)",
          "Concentração de clientes (top-5 = 47% da receita)",
          "Pressão regulatória na cadeia têxtil (compliance ambiental)",
        ],
        keyMitigations: [
          "Hedge cambial parcial via NDF (já em curso)",
          "Programa de prospecção de novos clientes (varejo regional)",
          "Investimento de R$ 1.8M em ETE até 12/2026 (já provisionado)",
        ],
        liquidityRunwayWeeks: 38,
        covenantHeadroom: 0.18,
      },
      signature: {
        signedAt: new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000).toISOString(),
        signedBy: partner.name,
        professionalRegistration: partner.professionalRegistration,
        contentHash: "sha256:demo-textil-final-v1",
      },
    },
  });
  const engTextil = await prisma.engagement.create({
    data: {
      analysisId: ibrTextil.id,
      userId: partner.id,
      rtId: partner.id,
      companyName: textil.razaoSocial,
      requestedBy: "Sindicato Bancário · Liderado por Banco Alfa",
      requestedByType: "lender",
      scope:
        "IBR para suportar negociação de reperfilamento de dívida sindicalizada de R$ 38M com 4 bancos credores.",
      state: "completed",
      deadline: new Date(now.getTime() - 18 * 24 * 60 * 60 * 1000),
      feeAmount: 65000,
      feeCurrency: "BRL",
      signedAt: new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000),
      letterAcceptedAt: new Date(now.getTime() - 34 * 24 * 60 * 60 * 1000),
      letterContentHash: "sha256:demo-textil-v1",
      letterVersion: "v1.0",
      notes: "IBR entregue e assinado. Reperfilamento aprovado pelos 4 bancos. Engagement encerrado.",
    },
  });

  // 5c. Logística Centro-Oeste — won (kickoff em 3 dias)
  const ibrLogistica = await prisma.analysis.create({
    data: {
      companyId: logistica.id,
      userId: partner.id,
      nome: "IBR Logística Centro-Oeste · Pré-kickoff",
      periodo: "2024 · 2025 · 2026-LTM",
      tipo: "Completa",
      status: "Rascunho",
      kind: "ibr",
      ibrType: "full",
      reviewState: "draft",
    },
  });
  const engLogistica = await prisma.engagement.create({
    data: {
      analysisId: ibrLogistica.id,
      userId: partner.id,
      rtId: partner.id,
      companyName: logistica.razaoSocial,
      requestedBy: "Hércules Capital · Mid-market fund (buyer-side)",
      requestedByType: "investor",
      scope:
        "Independent Business Review para aquisição majoritária. Foco em qualidade da receita, working capital ajustado e EBITDA recorrente vs. one-offs.",
      state: "won",
      deadline: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
      feeAmount: 110000,
      feeCurrency: "BRL",
      signedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      letterAcceptedAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
      letterContentHash: "sha256:demo-logistica-v1",
      letterVersion: "v1.0",
      notes: "Engagement letter assinada. Kickoff agendado em +3 dias. Data room sendo provisionado pelo seller.",
    },
  });

  console.log(`  3 engagements: kicked_off (Frigorífico Pampa), completed (Têxtil), won (Logística)`);

  // 6. Time entries no engagement ativo (Frigorífico Pampa)
  console.log("→ Criando time entries para o IBR em curso…");
  const phases = ["engagement", "collection", "analysis", "review"];
  const teamHours = [
    { user: partner, phase: "engagement", hours: 4, daysAgo: 7 },
    { user: partner, phase: "engagement", hours: 2, daysAgo: 6 },
    { user: operator, phase: "collection", hours: 6, daysAgo: 6 },
    { user: operator, phase: "collection", hours: 7, daysAgo: 5 },
    { user: operator, phase: "collection", hours: 5, daysAgo: 4 },
    { user: operator, phase: "analysis", hours: 7, daysAgo: 3 },
    { user: operator, phase: "analysis", hours: 8, daysAgo: 2 },
    { user: operator, phase: "analysis", hours: 6, daysAgo: 1 },
    { user: reviewer, phase: "review", hours: 3, daysAgo: 1 },
    { user: partner, phase: "review", hours: 2, daysAgo: 0 },
  ];
  for (const entry of teamHours) {
    await prisma.timeEntry.create({
      data: {
        analysisId: ibrFrigorifico.id,
        userId: entry.user.id,
        phase: entry.phase,
        date: new Date(now.getTime() - entry.daysAgo * 24 * 60 * 60 * 1000),
        hours: entry.hours,
        notes: `Fase ${entry.phase} — IBR Frigorífico Pampa`,
      },
    });
  }
  console.log(`  ${teamHours.length} time entries`);

  // 7. Covenants para o IBR em curso (todos breaching — empresa em distress)
  console.log("→ Criando covenants (em breach)…");
  const covenants = [
    {
      name: "Dívida Líquida / EBITDA",
      metric: "netDebtEbitda",
      operator: "<=",
      threshold: 3.0,
      periodicity: "quarterly",
      notes: "Pactuado em 3.0x. Atual ~9.8x — BREACH severo.",
    },
    {
      name: "DSCR (Debt Service Coverage Ratio)",
      metric: "dscr",
      operator: ">=",
      threshold: 1.2,
      periodicity: "quarterly",
      notes: "Mínimo 1.20x. Atual ~0.4x — BREACH.",
    },
    {
      name: "Liquidez Corrente",
      metric: "currentRatio",
      operator: ">=",
      threshold: 1.0,
      periodicity: "annual",
      notes: "Mínimo 1.0. Atual 0.74 — BREACH.",
    },
    {
      name: "Caixa Mínimo",
      metric: "minCash",
      operator: ">=",
      threshold: 1000000,
      periodicity: "monthly",
      notes: "R$ 1M mínimo. Atual R$ 850k — BREACH.",
    },
  ];
  for (const cov of covenants) {
    await prisma.covenant.create({
      data: { analysisId: ibrFrigorifico.id, ...cov },
    });
  }
  console.log(`  ${covenants.length} covenants (todos breaching)`);

  // 8. Documents no data room (Frigorífico Pampa)
  console.log("→ Criando docs no data room…");
  const docs = [
    { nome: "Balanço Patrimonial 2024 (Auditado).pdf", tipo: "BP", competencia: "2024-12", status: "Processado" },
    { nome: "Balanço Patrimonial 2025 (Auditado).pdf", tipo: "BP", competencia: "2025-12", status: "Processado" },
    { nome: "BP Mensal 2026 (jan-jun).xlsx", tipo: "BP", competencia: "2026-06", status: "Processado" },
    { nome: "DRE 2024 (Auditado).pdf", tipo: "DRE", competencia: "2024-12", status: "Processado" },
    { nome: "DRE 2025 (Auditado).pdf", tipo: "DRE", competencia: "2025-12", status: "Processado" },
    { nome: "DRE Mensal 2026 (jan-jun).xlsx", tipo: "DRE", competencia: "2026-06", status: "Processado" },
    { nome: "Contratos de Empréstimo (4 bancos).zip", tipo: "Contrato", competencia: null, status: "Pendente" },
    { nome: "Razão Contábil 2025-2026.pdf", tipo: "Razão", competencia: null, status: "Processado" },
    { nome: "Cap Table + Estrutura Societária.xlsx", tipo: "Societário", competencia: null, status: "Processado" },
    { nome: "Plano de Reestruturação Operacional v2.pdf", tipo: "Outro", competencia: null, status: "Processado" },
  ];
  for (const doc of docs) {
    await prisma.document.create({
      data: {
        analysisId: ibrFrigorifico.id,
        companyId: frigorifico.id,
        nome: doc.nome,
        tipo: doc.tipo,
        competencia: doc.competencia,
        moeda: "BRL",
        status: doc.status,
        confianca: doc.status === "Processado" ? 90 : null,
        hash: `sha256:demo-${doc.nome.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
        tamanho: `${Math.floor(Math.random() * 8 + 1)}.${Math.floor(Math.random() * 9)}MB`,
      },
    });
  }
  console.log(`  ${docs.length} documentos`);

  // 9. Audit events (alguns para mostrar a aba audit trail)
  console.log("→ Criando audit trail…");
  const auditEvents = [
    {
      entity: "engagement",
      field: "state",
      before: "won",
      after: "kicked_off",
      userId: partner.id,
      userName: partner.name,
      reason: "Kickoff oficial com cliente",
      daysAgo: 7,
    },
    {
      entity: "bp",
      field: "Caixa e Equivalentes",
      before: { "2026-06": 1200000 },
      after: { "2026-06": 850000 },
      userId: operator.id,
      userName: operator.name,
      reason: "Atualização após razão contábil de jun/26",
      daysAgo: 2,
    },
    {
      entity: "indicador",
      field: "DSO",
      before: { "2026-06": 52 },
      after: { "2026-06": 59 },
      userId: operator.id,
      userName: operator.name,
      source: "formula",
      reason: "Recalculado após atualização de Contas a Receber",
      daysAgo: 2,
    },
    {
      entity: "scenario",
      field: "downside.revenueMultiplier",
      before: 0.9,
      after: 0.85,
      userId: reviewer.id,
      userName: reviewer.name,
      reason: "Revisão do reviewer — premissa de queda revisada para -15% com base em curva setorial",
      daysAgo: 1,
    },
  ];
  for (const ev of auditEvents) {
    await prisma.auditEvent.create({
      data: {
        analysisId: ibrFrigorifico.id,
        userId: ev.userId,
        userName: ev.userName,
        entity: ev.entity,
        field: ev.field,
        before: ev.before as never,
        after: ev.after as never,
        source: (ev as any).source ?? "manual",
        reason: ev.reason,
        timestamp: new Date(now.getTime() - ev.daysAgo * 24 * 60 * 60 * 1000),
      },
    });
  }
  console.log(`  ${auditEvents.length} eventos`);

  // 10. Invoices (Frigorífico em curso → entry_50 pago; Têxtil completed → ambos pagos)
  console.log("→ Criando faturas…");
  await prisma.invoice.create({
    data: {
      engagementId: engFrigorifico.id,
      milestone: "entry_50",
      amount: 45000,
      currency: "BRL",
      status: "paid",
      issuedAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      dueDate: new Date(now.getTime() - 0 * 24 * 60 * 60 * 1000),
      paidAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
      invoiceNumber: "DEMO-2026-001",
    },
  });
  await prisma.invoice.create({
    data: {
      engagementId: engFrigorifico.id,
      milestone: "final_50",
      amount: 45000,
      currency: "BRL",
      status: "draft",
      invoiceNumber: "DEMO-2026-002",
      notes: "Emitir no D-Day da entrega",
    },
  });
  await prisma.invoice.create({
    data: {
      engagementId: engTextil.id,
      milestone: "entry_50",
      amount: 32500,
      currency: "BRL",
      status: "paid",
      issuedAt: new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000),
      paidAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      invoiceNumber: "DEMO-2026-T01",
    },
  });
  await prisma.invoice.create({
    data: {
      engagementId: engTextil.id,
      milestone: "final_50",
      amount: 32500,
      currency: "BRL",
      status: "paid",
      issuedAt: new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000),
      paidAt: new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000),
      invoiceNumber: "DEMO-2026-T02",
    },
  });
  await prisma.invoice.create({
    data: {
      engagementId: engLogistica.id,
      milestone: "entry_50",
      amount: 55000,
      currency: "BRL",
      status: "issued",
      issuedAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
      dueDate: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
      invoiceNumber: "DEMO-2026-L01",
    },
  });
  console.log("  5 faturas (mix paid/issued/draft)");

  // Resumo final
  console.log("\n✓ Seed demo concluído.\n");
  console.log("  Login URL:    https://quantua.com.br/login");
  console.log("  Credenciais:");
  console.log("    partner@quantua-demo.test  / demo1234");
  console.log("    reviewer@quantua-demo.test / demo1234");
  console.log("    operator@quantua-demo.test / demo1234");
  console.log("\n  Pra remover tudo: rode `npm run db:seed:demo` de novo (idempotente).");
  console.log("  Pra remover sem recriar: DELETE FROM workspaces WHERE cnpj = '" + DEMO_CNPJ + "';");
}

async function main() {
  try {
    await clean();
    await seed();
  } catch (err) {
    console.error("Erro:", err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
