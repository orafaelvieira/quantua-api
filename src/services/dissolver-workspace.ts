import {
  EntradaDicionarioEscopo,
  resolverCascataDicionario,
  chaveDe,
} from "./dicionario-escopo";

/**
 * DISSOLUÇÃO DA CAMADA WORKSPACE (13/08/2026 — invariante I4 do dono:
 * "alterações nos dicionários do workspace devem impactar apenas a empresa,
 * nunca o global").
 *
 * A camada do meio (userId preenchido, companyId null) vale para TODAS as
 * empresas da firma de uma vez — não é "apenas a empresa" nem é o global. Foi
 * ela que produziu os pares duplicados da tela e que fazia a aprovação do sócio
 * não valer nada (o workspace vence o global, calado). A auditoria não achou um
 * único caso de uso que ela entregue e a camada EMPRESA não entregasse.
 *
 * O plano é POR EMPRESA, nunca agregado — a revisão adversarial derrubou a
 * versão agregada com medição: a régua cega a empresa cancelava linha que 5 de
 * 6 empresas usavam. Para cada empresa da firma:
 *
 *   resolve(universo da empresa COM a camada workspace)   ← o número de hoje
 *   resolve(universo da empresa SEM a camada workspace)   ← o número depois
 *
 * Onde os mapas diferem, a entrada de workspace que MANDAVA naquela chave vira
 * CÓPIA de escopo EMPRESA — para aquela empresa, e só para ela. O veto
 * __IGNORAR__ não precisa de caso especial: ele aparece no mapa resolvido como
 * destino, então a simulação o enxerga (a versão anterior o perdia porque
 * procurava a conta na base contábil — e conta vetada, por construção, nunca
 * está lá).
 *
 * No fim, a função PROVA: resolve(universo SEM workspace MAIS as cópias) tem de
 * ser idêntico ao mapa de hoje, empresa por empresa, chave por chave. Empresa
 * que não fecha vira CONFLITO e NADA dela é aplicado — decisão humana.
 *
 * A camada workspace é então CANCELADA (nunca deletada — política da casa), com
 * motivo e trilha — e só quando TODAS as empresas da firma provaram.
 */

export interface LinhaDicionario extends EntradaDicionarioEscopo {
  id: string;
  revisao?: string | null;
  grupoCaminho?: string | null;
}

export interface CopiaPlanejada {
  deId: string;
  companyId: string;
  nomeOriginal: string;
  contaDestino: string;
  grupoConta: string | null;
  tipo: string;
  /** userId da entrada de workspace original — mantém a autoria. */
  userId: string;
  grupoCaminho: string | null;
}

export interface PlanoDissolucao {
  /** Entradas de workspace vivas — canceladas no aplicar SE tudo provar. */
  workspaceIds: string[];
  copias: CopiaPlanejada[];
  conflitos: Array<{ companyId: string; chave: string; motivo: string }>;
  provas: Array<{ companyId: string; chaves: number; copias: number; identico: boolean }>;
  /** true = toda empresa provou; o aplicar só roda inteiro. */
  aplicavel: boolean;
}

const TIPOS = ["BP", "DRE"];

/** Mapa chave→entrada VENCEDORA — a mesma régua do fold, com o dono junto. */
function mapaComDono<T extends LinhaDicionario>(rows: T[]): Map<string, T> {
  const m = new Map<string, T>();
  const ativas = rows.filter((e) => e.revisao !== "cancelada");
  for (const t of TIPOS) {
    for (const v of resolverCascataDicionario(ativas, t)) m.set(`${t}|${chaveDe(v)}`, v);
  }
  return m;
}

export function planejarDissolucaoWorkspace<T extends LinhaDicionario>(
  linhas: T[],
  empresaIds: string[],
): PlanoDissolucao {
  const workspace = linhas.filter((e) => e.userId !== null && e.companyId === null && e.revisao !== "cancelada");
  const plano: PlanoDissolucao = { workspaceIds: workspace.map((w) => w.id), copias: [], conflitos: [], provas: [], aplicavel: true };
  if (workspace.length === 0) return plano;
  const idsWorkspace = new Set(plano.workspaceIds);

  for (const companyId of empresaIds) {
    const universo = linhas.filter((e) => e.companyId === null || e.companyId === companyId);
    const semWorkspace = universo.filter((e) => !idsWorkspace.has(e.id));

    const hoje = mapaComDono(universo);
    const depoisSem = mapaComDono(semWorkspace);

    // Onde o número mudaria, a dona da chave (workspace) vira cópia da empresa.
    const copiasDaEmpresa = new Map<string, CopiaPlanejada>();
    let conflito = false;
    for (const [chave, dona] of hoje) {
      if (depoisSem.get(chave)?.contaDestino === dona.contaDestino) continue;
      if (!idsWorkspace.has(dona.id)) {
        // A chave muda sem que uma linha de workspace seja a dona — efeito
        // colateral do filtro de veto/DRE. Copiar a dona não resolve por
        // construção: decisão humana.
        plano.conflitos.push({ companyId, chave, motivo: `A chave resolveria diferente sem a camada de workspace, mas quem manda nela hoje não é uma entrada de workspace ("${dona.nomeOriginal}" → ${dona.contaDestino}).` });
        conflito = true;
        continue;
      }
      copiasDaEmpresa.set(dona.id, {
        deId: dona.id,
        companyId,
        nomeOriginal: dona.nomeOriginal,
        contaDestino: dona.contaDestino,
        grupoConta: dona.grupoConta ?? null,
        tipo: dona.tipo ?? "BP",
        userId: dona.userId!,
        grupoCaminho: (dona as LinhaDicionario).grupoCaminho ?? null,
      });
    }

    // PROVA por simulação: com as cópias no lugar, o mapa tem de bater chave a chave.
    const copiasComoLinhas = [...copiasDaEmpresa.values()].map((c, i) => ({
      id: `copia-${companyId}-${i}`,
      nomeOriginal: c.nomeOriginal,
      contaDestino: c.contaDestino,
      grupoConta: c.grupoConta,
      tipo: c.tipo,
      userId: c.userId,
      companyId: c.companyId,
      revisao: null,
    })) as unknown as T[];
    const depoisCom = mapaComDono([...semWorkspace, ...copiasComoLinhas]);
    let identico = depoisCom.size === hoje.size;
    if (identico) {
      for (const [k, v] of hoje) {
        if (depoisCom.get(k)?.contaDestino !== v.contaDestino) { identico = false; break; }
      }
    }

    plano.provas.push({ companyId, chaves: hoje.size, copias: copiasDaEmpresa.size, identico });
    if (identico && !conflito) {
      plano.copias.push(...copiasDaEmpresa.values());
    } else {
      plano.aplicavel = false;
      if (!conflito) {
        plano.conflitos.push({ companyId, chave: "(prova)", motivo: "A simulação com as cópias não reproduz o mapa de hoje — nada será aplicado." });
      }
    }
  }

  return plano;
}
