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
 * - SEED-IF-EMPTY ATÔMICO: o updateMany reavalia o "vazio" no mesmo statement
 *   do write — valor salvo pelo analista na janela entre o findMany e o update
 *   nunca é tocado (e o before=null da trilha é verdadeiro por construção).
 * - Auditabilidade obrigatória: cada preenchimento emite trilha com ator
 *   "Sistema (Receita/ECF)" (userId = dono do workspace, só para FK/escopo da
 *   tela Audit Trail) e fonte carimbada com a ressalva de RETRATO (o cnpjData
 *   é a última consulta gravada, não dado fresco — Reconsultar CNPJ atualiza).
 * - Teto de defasagem no automático: ECF mais velha que 3 anos-calendário não
 *   vira seed sem analista olhando (a ECF do ano N chega em meados de N+1).
 * - Falha em uma empresa não derruba as demais (try/catch por item, log final
 *   com contagem) — idempotente: o próximo boot completa o que faltou.
 */
import { prisma } from "../db/client";
import { registrarAuditoria } from "./audit-trail";
import { sugerirRegimeTributario } from "./regime-ecf";

export async function backfillRegimeEcf(): Promise<void> {
  const vazias = await prisma.company.findMany({
    where: { OR: [{ regimeTributario: null }, { regimeTributario: "" }] },
    select: { id: true, userId: true, cnpjData: true },
  });
  const anoMinimoEcf = new Date().getFullYear() - 3;
  let preenchidas = 0;
  let falhas = 0;
  for (const c of vazias) {
    if (!c.cnpjData) continue;
    const s = sugerirRegimeTributario(c.cnpjData, { anoMinimoEcf });
    if (!s) continue;
    try {
      const r = await prisma.company.updateMany({
        where: { id: c.id, OR: [{ regimeTributario: null }, { regimeTributario: "" }] },
        data: { regimeTributario: s.valor },
      });
      if (r.count !== 1) continue; // analista preencheu na janela — a escolha dele fica
      await registrarAuditoria({
        userId: c.userId,
        userName: "Sistema (Receita/ECF)",
        entity: "company",
        entityId: c.id,
        field: "regime tributário preenchido pela Receita (automático)",
        before: { regimeTributario: null },
        after: { regimeTributario: s.valor, fonte: `${s.fonte} — retrato da última consulta gravada; Reconsultar CNPJ atualiza` },
        source: "sistema",
        reason: "Backfill: a consulta de CNPJ já trazia o regime (flags Simples/MEI ou ECF) gravado em cnpjData; campo vazio preenchido — o analista pode sobrescrever no cadastro.",
      });
      preenchidas++;
    } catch (e) {
      falhas++;
      console.error(`[boot] backfill regime falhou na empresa ${c.id}:`, e instanceof Error ? e.message : e);
    }
  }
  if (preenchidas > 0 || falhas > 0) {
    console.log(`[boot] regime tributário pela Receita: ${preenchidas} preenchida(s), ${falhas} falha(s), ${vazias.length} candidata(s) (seed-if-empty, auditado)`);
  }
}
