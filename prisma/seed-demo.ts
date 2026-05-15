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

  // Identifica demo users pelo email pattern (cobre órfãos sem workspace)
  const demoUsers = await prisma.user.findMany({
    where: { email: { endsWith: DEMO_EMAIL_DOMAIN } },
  });
  const userIds = demoUsers.map((u) => u.id);

  if (userIds.length > 0) {
    console.log(`  ${userIds.length} user(s) demo encontrados`);

    // 1. Engagements (e suas dependências)
    const engagements = await prisma.engagement.findMany({
      where: { OR: [{ userId: { in: userIds } }, { rtId: { in: userIds } }] },
    });
    const engagementIds = engagements.map((e) => e.id);
    if (engagementIds.length > 0) {
      await prisma.invoice.deleteMany({ where: { engagementId: { in: engagementIds } } });
      await prisma.engagementSignature.deleteMany({ where: { engagementId: { in: engagementIds } } });
      await prisma.clientInvitation.deleteMany({ where: { engagementId: { in: engagementIds } } });
      await prisma.engagement.deleteMany({ where: { id: { in: engagementIds } } });
    }

    // 2. Analyses (cascade: documents, audit, time, allocations, covenants)
    await prisma.analysis.deleteMany({ where: { userId: { in: userIds } } });

    // 3. Companies (cascade: documents)
    await prisma.company.deleteMany({ where: { userId: { in: userIds } } });

    // 4. Audit events restantes (analysisId=null) — bloqueariam o delete user
    await prisma.auditEvent.deleteMany({ where: { userId: { in: userIds } } });

    // 5. Time entries restantes
    await prisma.timeEntry.deleteMany({ where: { userId: { in: userIds } } });

    // 6. Allocations restantes
    await prisma.allocation.deleteMany({ where: { userId: { in: userIds } } });

    // 7. Team invites criados por demo users
    await prisma.teamInvite.deleteMany({ where: { invitedById: { in: userIds } } });

    // 8. Users
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    console.log("  users + dados relacionados deletados em cascata manual");
  } else {
    console.log("  nenhum user demo prévio");
  }

  // 9. Workspace (apenas pelo CNPJ sentinela)
  const ws = await prisma.workspace.findFirst({ where: { cnpj: DEMO_CNPJ } });
  if (ws) {
    await prisma.workspace.delete({ where: { id: ws.id } });
    console.log("  workspace removido");
  }

  // 10. Leads de demo (pelo email pattern — independente de workspace)
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

  // 5a. Frigorífico Pampa — IBR HEADLINE (engagement em curso; análise já consolidada)
  const ibrFrigorifico = await prisma.analysis.create({
    data: {
      companyId: frigorifico.id,
      userId: partner.id,
      nome: "IBR Frigorífico Pampa · Jun/2026",
      periodo: "2024 · 2025 · 2026-LTM",
      tipo: "Completa",
      status: "Concluída",
      kind: "ibr",
      ibrType: "full",
      reviewState: "in_review",
      confianca: 87,
      resultado: {
        kpis: {
          receita: { valor: 62000000, status: "critico", variacao: -20.5 },
          margemBruta: { valor: 9.2, status: "critico", variacao: -4.3 },
          ebitda: { valor: -4800000, status: "critico", variacao: -169 },
          margemEbitda: { valor: -7.7, status: "critico", variacao: -6.0 },
          liquidezCorrente: { valor: 0.74, status: "critico", variacao: -0.12 },
          endividamento: { valor: 124, status: "critico", variacao: 19 },
          roe: { valor: 0, status: "critico", variacao: 0 },
          roa: { valor: -29, status: "critico", variacao: -15 },
        },
        semaforo: [
          {
            area: "Liquidez",
            status: "critico",
            descricao: "Caixa em R$ 850k contra covenant de R$ 1M (BREACH). Runway operacional ~6 semanas sem novo fôlego.",
          },
          {
            area: "Rentabilidade",
            status: "critico",
            descricao: "EBITDA negativo nos últimos 12 meses (-R$ 4.8M LTM vs R$ 6.5M em 2024). Tendência de deterioração.",
          },
          {
            area: "Endividamento",
            status: "critico",
            descricao: "Patrimônio Líquido negativo (-R$ 12.1M) configura insolvência técnica. Alavancagem total em 124% do ativo.",
          },
          {
            area: "Working capital",
            status: "atencao",
            descricao: "Ciclo de caixa quase dobrou: 30 dias (2024) → 58 dias (LTM). DSO 59d · DPO 64d · DIO 63d.",
          },
          {
            area: "Operacional",
            status: "critico",
            descricao: "Receita -35% em 2 anos (R$ 95M → R$ 62M) por perda do cliente principal (Carrefour, -22% do faturamento).",
          },
          {
            area: "Cumprimento de covenants",
            status: "critico",
            descricao: "4 de 4 covenants em BREACH: Dívida Líq./EBITDA 9.8x (limite 3.0x); DSCR 0.4x (1.2x); Liquidez 0.74 (1.0); Caixa mínimo R$ 850k (R$ 1M).",
          },
        ],
        destaques: [
          "Receita Líquida em queda de 35% em 2 anos (R$ 95M → R$ 62M) por perda do cliente Carrefour (-22% do faturamento) e ajuste regulatório do SISBI.",
          "EBITDA negativo nos últimos 12 meses (-R$ 4.8M LTM vs +R$ 6.5M em 2024). Margem EBITDA: 6.8% → -7.7%.",
          "Patrimônio Líquido negativo: -R$ 12.1M (insolvência técnica configurada pelo art. 1.066 da Lei 6.404).",
          "Ciclo de caixa quase dobrou: 30 dias (2024) → 58 dias (LTM) — sinal forte de stress de capital de giro.",
          "Todos os 4 covenants em BREACH desde Q4/2025: Dívida Líq./EBITDA · DSCR · Current ratio · Cash mínimo.",
          "Concentração de clientes elevada: top-3 = 62% do faturamento. Risco de morte súbita por evento adverso isolado.",
        ],
        recomendacoes: [
          {
            titulo: "Reperfilamento de dívida + waiver dos covenants",
            descricao:
              "Negociar com sindicato bancário (4 credores, Banco Beta líder): converter ~R$ 22M de empréstimos de curto prazo em longo prazo, prazo 5 anos, custo 6% am. Solicitar waiver formal dos covenants até dez/2027 condicional à execução do plano operacional.",
            prioridade: "P0",
            impacto: "Alto — economia de R$ 7.2M/ano em serviço de dívida no curto prazo, libera ~12 meses de runway",
            esforco: "Alto",
            horizonte: "1-3 meses",
          },
          {
            titulo: "Redução de custos fixos R$ 4M/ano",
            descricao:
              "Fechamento da unidade de Bagé (operando a 35% da capacidade, EBITDA negativo de R$ 1.8M/ano). Renegociação dos contratos com 3 frigoríficos terceirizados eliminando cláusulas take-or-pay. Corte de 18 posições administrativas em duplicidade.",
            prioridade: "P0",
            impacto: "Recuperação direta de EBITDA em ~R$ 4M/ano (margem +6 p.p.)",
            esforco: "Médio",
            horizonte: "3-6 meses",
          },
          {
            titulo: "Venda da unidade não-core de Curitiba",
            descricao:
              "Unidade secundária operando 35% da capacidade, fora da estratégia core (carne bovina sul). Sondagem inicial via Suzano Advisors indica interesse de 2 players regionais. Estimativa de venda: R$ 8-12M líquido.",
            prioridade: "P1",
            impacto: "Aporte de caixa R$ 8-12M + remoção de drag operacional de R$ 600k/ano",
            esforco: "Alto",
            horizonte: "6-12 meses",
          },
          {
            titulo: "Aporte de equity (founders + fundo PE regional)",
            descricao:
              "Discussões iniciais com Hércules Capital indicam apetite por aporte de R$ 15M em troca de 30% do equity + 2 assentos no board. Founders concordam com diluição contra recapitalização.",
            prioridade: "P1",
            impacto: "Recapitalização total, reverte PL negativo, sinaliza confiança ao mercado",
            esforco: "Alto",
            horizonte: "6-9 meses",
          },
        ],
        swot: {
          forcas: [
            "Marca tradicional regional (28 anos), reconhecida no Sul",
            "Planta principal em Santa Maria/RS com licença SISBI completa + selo SIF para exportação",
            "Time operacional experiente (turnover < 8%/ano)",
            "Contratos de longo prazo com 2 redes de varejo regionais",
          ],
          fraquezas: [
            "Patrimônio Líquido negativo (-R$ 12M)",
            "EBITDA recorrentemente negativo nos últimos 12 meses",
            "Alta concentração de clientes (top-3 = 62%)",
            "Capital de giro insuficiente para o ciclo operacional",
            "Dependência crítica de financiamento bancário (alavancagem 124%)",
          ],
          oportunidades: [
            "Consolidação setorial em curso — vários frigoríficos pequenos saindo do mercado",
            "Demanda crescente por carne premium (Wagyu/Angus) e exportação Halal",
            "Possibilidade de exportar via parceiros licenciados (China + países árabes)",
            "Programa BNDES de subsídio à modernização do parque frigorífico",
          ],
          riscos: [
            "Inflação contínua de bovinos (~+18% em 12 meses)",
            "Perda de qualquer cliente do top-3 → impacto irrecuperável no curto prazo",
            "RJ de fornecedor estratégico (3 produtores rurais representam 28% das compras)",
            "Pressão ESG crescente sobre o setor (greenwashing risk)",
            "Risco de protesto trabalhista (R$ 4.2M em ações em curso)",
          ],
        },
        dreData: [
          { mes: "Jan/26", receita: 5800, custos: -4900, lucroBruto: 900, despesas: -1200, ebitda: -300 },
          { mes: "Fev/26", receita: 5300, custos: -4600, lucroBruto: 700, despesas: -1180, ebitda: -480 },
          { mes: "Mar/26", receita: 5100, custos: -4500, lucroBruto: 600, despesas: -1150, ebitda: -550 },
          { mes: "Abr/26", receita: 4900, custos: -4400, lucroBruto: 500, despesas: -1100, ebitda: -600 },
          { mes: "Mai/26", receita: 5200, custos: -4600, lucroBruto: 600, despesas: -1120, ebitda: -520 },
          { mes: "Jun/26", receita: 5400, custos: -4700, lucroBruto: 700, despesas: -1110, ebitda: -410 },
        ],
      },
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
      status: "Concluída",
      kind: "ibr",
      ibrType: "full",
      reviewState: "signed",
      confianca: 92,
      resultado: {
        kpis: {
          receita: { valor: 45200000, status: "atencao", variacao: -3.5 },
          margemBruta: { valor: 22.4, status: "ok", variacao: 1.8 },
          ebitda: { valor: 4900000, status: "ok", variacao: 12.0 },
          margemEbitda: { valor: 10.8, status: "ok", variacao: 1.4 },
          liquidezCorrente: { valor: 1.18, status: "ok", variacao: 0.08 },
          endividamento: { valor: 71, status: "atencao", variacao: -4 },
          roe: { valor: 14.2, status: "ok", variacao: 2.1 },
          roa: { valor: 5.8, status: "ok", variacao: 0.9 },
        },
        semaforo: [
          {
            area: "Rentabilidade",
            status: "ok",
            descricao: "Margem EBITDA estável em 10.8%, recuperação confirmada após reperfilamento de Mar/2026.",
          },
          {
            area: "Liquidez",
            status: "ok",
            descricao: "Liquidez corrente em 1.18, headroom de 18% sobre o covenant de 1.0.",
          },
          {
            area: "Endividamento",
            status: "atencao",
            descricao: "Alavancagem total ainda em 71%, dentro do limite mas com pouco headroom.",
          },
          {
            area: "Concentração",
            status: "atencao",
            descricao: "Top-5 clientes = 47% da receita. Risco moderado de evento de cliente isolado.",
          },
        ],
        destaques: [
          "Reperfilamento de dívida concluído em Mar/2026 — sindicato bancário de 4 credores converteu R$ 22M de CP para LP, prazo 5 anos.",
          "Margem EBITDA recuperada para 10.8% (vs 8.4% em 2024), com viabilidade operacional confirmada.",
          "Linha de tinturaria (não-core, EBITDA -R$ 2.8M/ano) descontinuada em Jan/2026.",
          "Investimento de R$ 1.8M em ETE provisionado para conclusão até dez/2026.",
          "Hedge cambial em curso cobre 60% da exposição a insumos importados (~22% do CMV).",
        ],
        recomendacoes: [
          {
            titulo: "Monitoramento trimestral dos covenants",
            descricao:
              "Manter relatório mensal de aderência aos covenants pactuados no acordo de reperfilamento (Dívida/EBITDA <= 3.5x, Liquidez >= 1.0, DSCR >= 1.2).",
            prioridade: "P0",
            impacto: "Detecção precoce de eventual deterioração",
            esforco: "Baixo",
            horizonte: "Recorrente",
          },
          {
            titulo: "Programa de diversificação de clientes",
            descricao:
              "Prospecção ativa de varejo regional (Pernambuco e Bahia) para reduzir concentração top-5 abaixo de 40%.",
            prioridade: "P1",
            impacto: "Médio — redução de risco sistêmico",
            esforco: "Médio",
            horizonte: "12-18 meses",
          },
        ],
        swot: {
          forcas: ["Marca consolidada no segmento de algodão", "Time técnico experiente", "Reperfilamento recente libera fôlego"],
          fraquezas: ["Concentração de clientes top-5 = 47%", "Exposição cambial em insumos"],
          oportunidades: ["Expansão para Nordeste", "Linhas premium de algodão orgânico"],
          riscos: ["Inflação de algodão", "Pressão ESG"],
        },
      },
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
