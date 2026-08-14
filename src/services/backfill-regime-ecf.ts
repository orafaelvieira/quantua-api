/**
 * BACKFILL RETROATIVO do regime tributário (14/08/2026).
 *
 * A consulta de CNPJ sempre gravou a resposta COMPLETA em Company.cnpjData — o
 * bloco `regime_tributario` da ECF (Lucro Real × Presumido) já está no banco
 * para as empresas cadastradas, mas o campo Company.regimeTributario ficou
 * vazio (na época, o mapeamento só cobria MEI/Simples). Sem o campo, o motor
 * assume "Lucro Presumido" como premissa-padrão de impostos (models.ts) — uma
 * empresa de Lucro Real ficava com premissa silenciosamente errada.
 *
 * Regras:
 * - SEED-IF-EMPTY: preenche SÓ quando regimeTributario está vazio — o valor
 *   escolhido pelo analista nunca é tocado (override dele vale mais).
 * - Auditabilidade obrigatória: cada preenchimento emite trilha (source
 *   "sistema"; autor = dono do workspace da empresa, para o evento aparecer na
 *   tela Audit Trail do workspace certo — o campo `field` deixa claro que foi
 *   automático, e `after.fonte` carimba Receita/ECF + ano-calendário).
 * - Idempotente: na passada seguinte não há mais vazios a preencher (roda a
 *   cada boot, instância única — sem corrida).
 */
import { prisma } from "../db/client";
import { registrarAuditoria } from "./audit-trail";
import { sugerirRegimeTributario } from "./regime-ecf";

export async function backfillRegimeEcf(): Promise<void> {
  const vazias = await prisma.company.findMany({
    where: { OR: [{ regimeTributario: null }, { regimeTributario: "" }] },
    select: { id: true, userId: true, regimeTributario: true, cnpjData: true },
  });
  let preenchidas = 0;
  for (const c of vazias) {
    if (!c.cnpjData) continue;
    const s = sugerirRegimeTributario(c.cnpjData);
    if (!s) continue;
    await prisma.company.update({ where: { id: c.id }, data: { regimeTributario: s.valor } });
    await registrarAuditoria({
      userId: c.userId,
      entity: "company",
      entityId: c.id,
      field: "regime tributário preenchido pela Receita (automático)",
      before: { regimeTributario: c.regimeTributario ?? null },
      after: { regimeTributario: s.valor, fonte: s.fonte },
      source: "sistema",
      reason: "Backfill: a consulta de CNPJ já trazia o regime (flags Simples/MEI ou ECF) gravado em cnpjData; campo vazio preenchido — o analista pode sobrescrever no cadastro.",
    });
    preenchidas++;
  }
  if (preenchidas > 0) console.log(`[boot] regime tributário preenchido pela Receita em ${preenchidas} empresa(s) (seed-if-empty, auditado)`);
}
