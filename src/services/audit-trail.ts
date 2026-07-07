/**
 * TRILHA DE AUDITORIA — emissão pelo BACKEND (fonte da verdade).
 *
 * O frontend já emite eventos para edições numéricas (POST /audit), mas mutações de
 * CADASTRO (empresa, escopo do IBR, dores, exclusões) precisam de trilha garantida no
 * servidor — quem fez, quando, o que mudou (before/after) — independentemente da tela.
 *
 * Best-effort declarado: falha ao gravar auditoria NUNCA bloqueia a operação (loga e
 * segue) — auditoria é observabilidade, não trava.
 *
 * CUIDADO (aprendido no design): AuditEvent.analysis tem onDelete: Cascade — evento de
 * EXCLUSÃO de análise deve ir com analysisId NULL (e o id no entityId), senão a trilha
 * da exclusão é apagada junto com a análise que ela documenta.
 */
import { prisma } from "../db/client";

export async function registrarAuditoria(opts: {
  userId: string;
  analysisId?: string | null;
  entity: string;
  entityId?: string | null;
  field: string;
  before?: unknown;
  after?: unknown;
  source?: string;
  reason?: string;
}): Promise<void> {
  try {
    const user = await prisma.user.findUnique({ where: { id: opts.userId }, select: { name: true } });
    await prisma.auditEvent.create({
      data: {
        analysisId: opts.analysisId ?? null,
        userId: opts.userId,
        userName: user?.name ?? "Usuário",
        entity: opts.entity,
        entityId: opts.entityId ?? null,
        field: opts.field,
        before: (opts.before ?? undefined) as object | undefined,
        after: (opts.after ?? undefined) as object | undefined,
        source: opts.source ?? "manual",
        reason: opts.reason,
      },
    });
  } catch (e) {
    console.warn("[audit] falha ao registrar evento:", e instanceof Error ? e.message : e);
  }
}

/** Diff raso entre dois objetos: devolve { before, after } SÓ com as chaves que mudaram
 *  (comparação por JSON — suficiente para campos escalares de cadastro). */
export function diffCampos(
  antes: Record<string, unknown>,
  depois: Record<string, unknown>,
  campos: string[]
): { before: Record<string, unknown>; after: Record<string, unknown>; mudou: boolean } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const c of campos) {
    if (!(c in depois)) continue; // campo não enviado no update — não comparar
    const a = antes[c] ?? null;
    const d = depois[c] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(d)) { before[c] = a; after[c] = d; }
  }
  return { before, after, mudou: Object.keys(after).length > 0 };
}
