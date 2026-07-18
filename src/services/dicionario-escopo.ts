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
  const lista = [...vencedores.values()];

  // DRE: o `grupoConta` ESPELHA o destino (convenção da tela de classificação),
  // então NÃO é discriminador de contexto — a mesma conta na empresa e no global
  // vira duas chaves e as duas sobreviviam. A blindagem contextual
  // (mapAccountToDRE) então podia preferir a GLOBAL pelo bloco e DESCARTAR a
  // correção explícita da empresa ("alterei e não respeitou"). Aqui a prioridade
  // de escopo volta a valer: por NOME, só as entradas do MAIOR escopo seguem
  // (variantes de contexto dentro do MESMO escopo continuam coexistindo).
  // BP fica como está: lá o grupo é o grupo REAL do documento — a mesma conta em
  // PC e PNC são contas distintas e um override da empresa no PC não pode
  // derrubar a entrada global do PNC.
  if (tipo === "DRE") {
    const maiorEscopoPorNome = new Map<string, number>();
    for (const e of lista) {
      const n = e.nomeOriginal.toLowerCase();
      const p = prioridadeEscopo(e);
      if (p > (maiorEscopoPorNome.get(n) ?? -1)) maiorEscopoPorNome.set(n, p);
    }
    return lista.filter((e) => prioridadeEscopo(e) === maiorEscopoPorNome.get(e.nomeOriginal.toLowerCase()));
  }
  return lista;
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

/**
 * Cascata ATIVA — a dos FOLDS: exclui entradas "cancelada" (inclusão errada,
 * cancelada pelo time — global cancelada não é herdada por empresa nenhuma;
 * entrada de empresa cancelada sai das próximas análises). O classify continua
 * usando a cascata completa: re-classificar a mesma conta REVIVE a entrada.
 * OR explícito com null: `not` do Prisma exclui NULL silenciosamente.
 */
export function whereCascataDicionarioAtiva(scopeUserIds: string[], companyId?: string | null): {
  AND: Array<Record<string, unknown>>;
} {
  return {
    AND: [
      whereCascataDicionario(scopeUserIds, companyId),
      { OR: [{ revisao: null }, { revisao: { not: "cancelada" } }] },
    ],
  };
}
