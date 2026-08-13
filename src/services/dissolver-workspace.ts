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

/**
 * DISSOLUÇÃO AUTOMÁTICA NO BOOT (13/08/2026 — "você não consegue fazer isso?").
 *
 * O dono não acessa o banco de produção e o padrão da casa é configurar
 * produção por código + push. Este job roda no startup, UMA firma por vez:
 * planeja, e SÓ aplica quando a prova fecha — 0 conflitos e mapa resolvido
 * idêntico em toda empresa da firma. Firma com conflito fica intacta e o
 * conflito vai para o log e para o changelog do dicionário, onde o dono vê
 * pela tela (Histórico de versões).
 *
 * É seguro rodar sempre: sem entradas de workspace vira no-op instantâneo, e
 * aplicar é cancelar (nunca deletar) + criar cópias já provadas.
 */
export async function dissolverWorkspaceNoBoot(prisma: {
  accountDictionary: any; user: any; company: any; dictionaryVersion: any; $transaction: any;
}): Promise<void> {
  const donos = await prisma.accountDictionary.findMany({
    where: { userId: { not: null }, companyId: null, OR: [{ revisao: null }, { revisao: { not: "cancelada" } }] },
    select: { userId: true },
    distinct: ["userId"],
  });
  if (donos.length === 0) return;
  console.log(`[dissolucao] ${donos.length} dono(s) de entradas de workspace — planejando por firma…`);

  // Agrupa por firma: membros do mesmo workspace compartilham escopo; usuário
  // sem workspace é escopo de si mesmo (mesma régua do resolverEscopoAcesso).
  const users = await prisma.user.findMany({
    where: { id: { in: donos.map((d: any) => d.userId) } },
    select: { id: true, workspaceId: true },
  });
  const firmas = new Map<string, string[]>();
  for (const u of users) {
    if (u.workspaceId) {
      if (!firmas.has(`ws:${u.workspaceId}`)) {
        const membros = await prisma.user.findMany({ where: { workspaceId: u.workspaceId }, select: { id: true } });
        firmas.set(`ws:${u.workspaceId}`, membros.map((m: any) => m.id));
      }
    } else {
      firmas.set(`solo:${u.id}`, [u.id]);
    }
  }

  for (const [rotulo, scopeUserIds] of firmas) {
    const empresas = (await prisma.company.findMany({ where: { userId: { in: scopeUserIds } }, select: { id: true } })).map((c: any) => c.id);
    const linhas = await prisma.accountDictionary.findMany({
      where: {
        OR: [
          { userId: null, companyId: null },
          { userId: { in: scopeUserIds }, companyId: null },
          ...(empresas.length ? [{ companyId: { in: empresas } }] : []),
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const plano = planejarDissolucaoWorkspace(linhas as LinhaDicionario[], empresas);
    if (plano.workspaceIds.length === 0) continue;
    if (!plano.aplicavel || plano.conflitos.length > 0) {
      console.warn(`[dissolucao] firma ${rotulo}: ${plano.workspaceIds.length} entrada(s), ${plano.conflitos.length} conflito(s) — NADA aplicado. Conflitos:`);
      for (const c of plano.conflitos.slice(0, 10)) console.warn(`  · ${c.chave}: ${c.motivo}`);
      continue;
    }

    await prisma.$transaction(async (tx: any) => {
      for (const c of plano.copias) {
        const jaExiste = await tx.accountDictionary.findFirst({
          where: { nomeOriginal: c.nomeOriginal, tipo: c.tipo, grupoConta: c.grupoConta ?? "", userId: c.userId, companyId: c.companyId },
          select: { id: true },
        });
        if (jaExiste) {
          await tx.accountDictionary.update({ where: { id: jaExiste.id }, data: { contaDestino: c.contaDestino, revisao: "local" } });
        } else {
          await tx.accountDictionary.create({
            data: {
              nomeOriginal: c.nomeOriginal, contaDestino: c.contaDestino, grupoConta: c.grupoConta ?? "",
              tipo: c.tipo, userId: c.userId, companyId: c.companyId,
              revisao: "local", grupoCaminho: c.grupoCaminho,
              revisaoMotivo: "Migrada da camada de workspace na dissolução automática — preserva o número que esta empresa já tinha.",
            },
          });
        }
      }
      await tx.accountDictionary.updateMany({
        where: { id: { in: plano.workspaceIds } },
        data: {
          revisao: "cancelada",
          revisaoMotivo: "Camada de workspace dissolvida (job de boot) — a regra agora vive nas empresas que a usavam.",
          revisadoPor: "Dissolução (deploy)",
          revisadoEm: new Date(),
        },
      });
    });
    const ultima = await prisma.dictionaryVersion.findFirst({ orderBy: { versao: "desc" }, select: { versao: true } });
    await prisma.dictionaryVersion.create({
      data: {
        versao: (ultima?.versao ?? 0) + 1,
        acao: "edit", fonte: "validacao", criadoPor: "Dissolução (deploy)",
        nota: `Camada de workspace dissolvida automaticamente: ${plano.workspaceIds.length} entrada(s) canceladas, ${plano.copias.length} cópia(s) em ${new Set(plano.copias.map((c) => c.companyId)).size} empresa(s). Prova: mapa resolvido idêntico em ${plano.provas.length} empresa(s).`,
      },
    });
    console.log(`[dissolucao] firma ${rotulo}: ${plano.workspaceIds.length} cancelada(s), ${plano.copias.length} cópia(s) — prova fechada.`);
  }
}

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
