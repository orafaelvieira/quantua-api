/**
 * Cascata de escopo do dicionário de contas (2026-07-17):
 *
 *   GLOBAL (userId null, companyId null — seed Quantua)
 *     ↑ sobrescrito por WORKSPACE (userId preenchido, companyId null — manual/legado)
 *       ↑ sobrescrito por EMPRESA (companyId preenchido — autofeed do IBR)
 *
 * A entrada de EMPRESA vale SOMENTE para os IBRs daquela empresa — é o que
 * impede uma classificação feita no calor de um IBR de "sujar" o dicionário
 * dos demais clientes. A promoção ao global é humana (tela Validação de
 * contas), nunca automática.
 */

export interface EntradaDicionarioEscopo {
  nomeOriginal: string;
  contaDestino: string;
  grupoConta: string | null;
  tipo?: string;
  userId: string | null;
  companyId: string | null;
}

/** 0 = global · 1 = workspace · 2 = empresa (maior vence). */
export function prioridadeEscopo(e: { userId: string | null; companyId: string | null }): number {
  if (e.companyId !== null) return 2;
  if (e.userId !== null) return 1;
  return 0;
}

const chaveDe = (e: { nomeOriginal: string; grupoConta: string | null }): string =>
  `${e.nomeOriginal.toLowerCase()}|${(e.grupoConta ?? "").toLowerCase()}`;

/**
 * Resolve a cascata: para cada (nomeOriginal, grupoConta) devolve UMA entrada —
 * a de maior prioridade de escopo. A ordem de entrada não importa.
 * `tipo` (opcional) filtra antes de resolver (BP e DRE têm dicionários próprios).
 */
export function resolverCascataDicionario<T extends EntradaDicionarioEscopo>(
  entradas: T[],
  tipo?: string
): T[] {
  const vencedores = new Map<string, T>();
  for (const e of entradas) {
    if (tipo !== undefined && (e.tipo ?? "BP") !== tipo) continue;
    const chave = chaveDe(e);
    const atual = vencedores.get(chave);
    if (!atual || prioridadeEscopo(e) >= prioridadeEscopo(atual)) vencedores.set(chave, e);
  }
  return [...vencedores.values()];
}

/**
 * Filtro Prisma padrão da cascata: global + workspace + (se houver) a empresa.
 * Entradas de OUTRAS empresas nunca entram — isolamento por cliente.
 */
export function whereCascataDicionario(scopeUserIds: string[], companyId?: string | null): {
  OR: Array<Record<string, unknown>>;
} {
  return {
    OR: [
      { userId: null, companyId: null },
      { userId: { in: scopeUserIds }, companyId: null },
      ...(companyId ? [{ companyId }] : []),
    ],
  };
}
