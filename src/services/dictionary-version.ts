import { prisma } from "../db/client";

/**
 * Versão VIGENTE do dicionário = maior `versao` registrada (0 se nunca mudou).
 * Usada para carimbar cada análise com a versão de dicionário usada no fold (pinagem
 * de auditoria — controle interno, não vai pra relatório).
 */
export async function getCurrentDictionaryVersion(): Promise<number> {
  const last = await prisma.dictionaryVersion.findFirst({
    orderBy: { versao: "desc" },
    select: { versao: true },
  });
  return last?.versao ?? 0;
}

export interface DictionaryChange {
  acao: "add" | "edit" | "delete" | "classify" | "import" | "promover" | "reprovar";
  fonte?: "manual" | "autofeed" | "validacao";
  nomeOriginal?: string | null;
  contaDestino?: string | null;
  grupoConta?: string | null;
  tipo?: string | null;
  nota?: string | null;
  criadoPor?: string | null;
  analysisId?: string | null;
  /** Empresa dona da entrada (cascata por empresa) — proveniência no changelog. */
  companyId?: string | null;
}

/**
 * Incrementa a versão do dicionário e registra a mudança no changelog (uma linha por
 * mudança). Retorna a nova versão. Retry contra corrida no `versao @unique` (P2002):
 * em concorrência, recomputa max+1 e tenta de novo.
 */
export async function bumpDictionaryVersion(change: DictionaryChange): Promise<number> {
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const next = (await getCurrentDictionaryVersion()) + 1;
    try {
      await prisma.dictionaryVersion.create({
        data: {
          versao: next,
          acao: change.acao,
          fonte: change.fonte ?? "manual",
          nomeOriginal: change.nomeOriginal ?? null,
          contaDestino: change.contaDestino ?? null,
          grupoConta: change.grupoConta ?? null,
          tipo: change.tipo ?? null,
          nota: change.nota ?? null,
          criadoPor: change.criadoPor ?? null,
          analysisId: change.analysisId ?? null,
          companyId: change.companyId ?? null,
        },
      });
      return next;
    } catch (err: any) {
      if (err?.code === "P2002") continue; // colisão de versão concorrente → tenta de novo
      throw err;
    }
  }
  // Falha persistente: não bloqueia a operação principal (versionamento é controle interno).
  console.error("[dictionary-version] não foi possível registrar a versão após retries");
  return getCurrentDictionaryVersion();
}
