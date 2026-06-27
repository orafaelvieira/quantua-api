import { prisma } from "../db/client";
import { buildBPModel, DEFAULT_BP_MODEL, type BPModel } from "./account-mapper";

/**
 * Carrega o modelo de BP VIGENTE do banco como BPModel (estrutura + nomes + classif).
 * É o "bridge": o cálculo passa a usar o modelo editável do banco em vez do template
 * do código. Se não houver modelo no banco, cai no DEFAULT (template do código).
 */
export async function loadActiveBPModel(): Promise<BPModel> {
  const m = await prisma.standardModel.findFirst({
    where: { tipo: "BP", ativo: true },
    include: { linhas: { orderBy: { ordem: "asc" } } },
  });
  if (!m || m.linhas.length === 0) return DEFAULT_BP_MODEL;
  return buildBPModel(m.linhas.map((l) => ({
    classificacao: l.grupo, conta: l.nome, nivel: l.nivel,
    tipo: (l.tipo === "subtotal" || l.tipo === "total" ? l.tipo : "input") as "input" | "subtotal" | "total",
  })));
}

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
