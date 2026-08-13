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

import { limparCodigoDoNome } from "./nome-conta";

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

/**
 * A CHAVE IGNORA O CÓDIGO DO PLANO (13/08/2026). Desde que o `normalize` do
 * account-mapper limpa os dois lados da comparação, a entrada VELHA
 * ("4.03.02.01 PROCESSO …") e a NOVA ("PROCESSO …") casam as duas com a mesma
 * conta do documento — e, em chaves diferentes, as duas sobreviviam à cascata.
 * Quem ganhava passava a depender da ORDEM em que o banco devolveu as linhas:
 * o mesmo IBR refoldado duas vezes podia trocar de destino. Colapsando na mesma
 * chave, a cascata volta a decidir — e decide sempre igual.
 */
const chaveDe = (e: { nomeOriginal: string; grupoConta: string | null }): string =>
  `${limparCodigoDoNome(e.nomeOriginal).toLowerCase()}|${(e.grupoConta ?? "").toLowerCase()}`;

/** Entre duas entradas do MESMO escopo, vence a que já está no formato limpo. */
const nomeLimpo = (e: { nomeOriginal: string }): boolean =>
  limparCodigoDoNome(e.nomeOriginal) === e.nomeOriginal.trim();

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
    if (!atual) { vencedores.set(chave, e); continue; }
    const p = prioridadeEscopo(e), pa = prioridadeEscopo(atual);
    // Escopo maior vence sempre. NO EMPATE, vence o nome já limpo — critério do
    // próprio dado, não da ordem do array (que vinha de findMany sem orderBy).
    if (p > pa || (p === pa && (nomeLimpo(e) || !nomeLimpo(atual)))) vencedores.set(chave, e);
  }
  let lista = [...vencedores.values()];

  // "IGNORAR" É VETO — e veto de escopo MENOR não sobrevive a uma classificação
  // mais específica (11/08/2026, caso Dunamys: "classifiquei a conta mas o ✗ não
  // sumiu"). No BP a chave inclui o `grupoConta` de propósito (a mesma conta em
  // PC e PNC são contas distintas), então a entrada GLOBAL de ignorar e a
  // classificação da EMPRESA ficavam em chaves diferentes e as duas sobreviviam;
  // `isContaIgnorada` casa só pelo NOME, então o veto continuava valendo e a
  // conta seguia fora do balanço, sem caminho de volta pela tela.
  // Regra: classificação explícita vence o veto de escopo igual ou menor.
  const IGNORAR = "__IGNORAR__";
  const escopoClassificado = new Map<string, number>();
  for (const e of lista) {
    if (e.contaDestino === IGNORAR) continue;
    const n = e.nomeOriginal.toLowerCase();
    const p = prioridadeEscopo(e);
    if (p > (escopoClassificado.get(n) ?? -1)) escopoClassificado.set(n, p);
  }
  lista = lista.filter((e) =>
    e.contaDestino !== IGNORAR ||
    prioridadeEscopo(e) > (escopoClassificado.get(e.nomeOriginal.toLowerCase()) ?? -1));

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

export type SituacaoEntrada = {
  /** Esta entrada é a que o fold usa para esse (nome, grupo, tipo)? */
  emUso: boolean;
  /** Quando não está em uso: o escopo que a sobrepõe ("Usuário", "Empresa"…). */
  sobrepostaPor: string | null;
  /**
   * Está em uso, mas há entrada de escopo MENOR com o MESMO destino — ou seja,
   * apagá-la não mudaria número nenhum.
   */
  redundante: boolean;
};

const NOME_ESCOPO = ["Sistema", "Usuário", "Empresa"];

/**
 * QUEM VALE E QUEM É SOMBRA (13/08/2026, pergunta do dono: "parece que o
 * dicionário global está duplicando contas").
 *
 * Não estava duplicando: a tela lista as CAMADAS cruas (global + workspace +
 * empresa) e o fold usa só a vencedora da cascata. "Autônomos" aparecia duas
 * vezes — uma "Sistema", uma "Usuário" — com o MESMO destino, e nada na tela
 * dizia qual das duas manda. Duas linhas iguais sem hierarquia visível leem-se
 * como erro de base, e o operador que "arruma" apagando a errada mexe no que
 * vale.
 *
 * Aqui a cascata é a MESMA de `resolverCascataDicionario` (uma régua só) — esta
 * função apenas conta quem venceu, para a tela poder dizer.
 *
 * `cancelada` fica fora do jogo: o fold não a lê (whereCascataDicionarioAtiva),
 * então ela nem sombreia nem é sombreada.
 */
export function situacaoDaCascata<T extends EntradaDicionarioEscopo & { id: string; revisao?: string | null }>(
  entradas: T[]
): Map<string, SituacaoEntrada> {
  const ativas = entradas.filter((e) => e.revisao !== "cancelada");
  const tipos = [...new Set(ativas.map((e) => e.tipo ?? "BP"))];
  const vencedoras = new Set<string>();
  for (const t of tipos) for (const v of resolverCascataDicionario(ativas, t)) vencedoras.add(v.id);

  // Índice por chave (nome|grupo|tipo) para achar quem sombreia quem.
  const porChave = new Map<string, T[]>();
  // ...e por NOME|tipo, porque na DRE o `grupoConta` espelha o destino: lá quem
  // sobrepõe está numa chave diferente e sem este índice a tela diria "sem
  // efeito" sem conseguir apontar o culpado.
  const porNome = new Map<string, T[]>();
  for (const e of ativas) {
    const k = `${chaveDe(e)}|${e.tipo ?? "BP"}`;
    (porChave.get(k) ?? porChave.set(k, []).get(k)!).push(e);
    const kn = `${e.nomeOriginal.toLowerCase()}|${e.tipo ?? "BP"}`;
    (porNome.get(kn) ?? porNome.set(kn, []).get(kn)!).push(e);
  }

  const out = new Map<string, SituacaoEntrada>();
  for (const e of entradas) {
    if (e.revisao === "cancelada") {
      out.set(e.id, { emUso: false, sobrepostaPor: null, redundante: false });
      continue;
    }
    const irmas = porChave.get(`${chaveDe(e)}|${e.tipo ?? "BP"}`) ?? [e];
    const emUso = vencedoras.has(e.id);
    if (emUso) {
      const menorIgual = irmas.some(
        (o) => o.id !== e.id && prioridadeEscopo(o) < prioridadeEscopo(e) && o.contaDestino === e.contaDestino
      );
      out.set(e.id, { emUso: true, sobrepostaPor: null, redundante: menorIgual });
    } else {
      const porNomeMesmo = porNome.get(`${e.nomeOriginal.toLowerCase()}|${e.tipo ?? "BP"}`) ?? [];
      const vencedora = irmas.find((o) => o.id !== e.id && vencedoras.has(o.id))
        ?? porNomeMesmo.find((o) => o.id !== e.id && vencedoras.has(o.id));
      out.set(e.id, {
        emUso: false,
        sobrepostaPor: vencedora ? (NOME_ESCOPO[prioridadeEscopo(vencedora)] ?? null) : null,
        redundante: false,
      });
    }
  }
  return out;
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
