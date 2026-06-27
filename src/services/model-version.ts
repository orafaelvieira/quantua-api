import { prisma } from "../db/client";

/**
 * Versões VIGENTES dos modelos padrão (BP/DRE) no momento da chamada.
 * Usado para "carimbar" cada análise com a versão de modelo usada (pinagem):
 * mudanças futuras no modelo não alteram análises já processadas.
 */
export async function getActiveModelVersions(): Promise<{ bp: number | null; dre: number | null }> {
  const models = await prisma.standardModel.findMany({
    where: { ativo: true },
    select: { tipo: true, versao: true },
  });
  return {
    bp: models.find((m) => m.tipo === "BP")?.versao ?? null,
    dre: models.find((m) => m.tipo === "DRE")?.versao ?? null,
  };
}
