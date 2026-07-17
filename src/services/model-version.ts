import { prisma } from "../db/client";
import { buildBPModel, DEFAULT_BP_MODEL, type BPModel } from "./account-mapper";
import { DRE_TEMPLATE } from "./financial-templates";

/**
 * Carrega o modelo de BP VIGENTE do banco como BPModel (estrutura + nomes + classif).
 * É o "bridge": o cálculo passa a usar o modelo editável do banco em vez do template
 * do código. Se não houver modelo no banco, cai no DEFAULT (template do código).
 */
/**
 * Cascata por EMPRESA (2026-07-17): se a empresa tem modelo próprio ativo
 * (copy-on-write a partir do global), ele vence; senão vale o global.
 * Sem companyId, comporta-se exatamente como antes (só global).
 */
async function findActiveModel(tipo: "BP" | "DRE", companyId?: string | null) {
  if (companyId) {
    const daEmpresa = await prisma.standardModel.findFirst({
      where: { tipo, ativo: true, companyId },
      include: { linhas: { orderBy: { ordem: "asc" } } },
    });
    if (daEmpresa && daEmpresa.linhas.length > 0) return daEmpresa;
  }
  return prisma.standardModel.findFirst({
    where: { tipo, ativo: true, companyId: null },
    include: { linhas: { orderBy: { ordem: "asc" } } },
  });
}

export async function loadActiveBPModel(companyId?: string | null): Promise<BPModel> {
  const m = await findActiveModel("BP", companyId);
  if (!m || m.linhas.length === 0) return DEFAULT_BP_MODEL;
  return buildBPModel(m.linhas.map((l) => ({
    classificacao: l.grupo, conta: l.nome, nivel: l.nivel,
    tipo: (l.tipo === "subtotal" || l.tipo === "total" ? l.tipo : "input") as "input" | "subtotal" | "total",
  })));
}

/**
 * Modelo de DRE VIGENTE do banco — o "bridge" da DRE (espelho do loadActiveBPModel).
 * `lines` na ordem do editor; `inputs` = contas não-subtotais (alvos válidos de
 * classificação); `extrasPorBloco` = contas ADICIONADAS pelo usuário (fora do template
 * do código) ancoradas ao SUBTOTAL do bloco onde foram posicionadas — assim entram na
 * cascata do Lucro Líquido sem reescrever as fórmulas.
 */
export interface DREModel {
  lines: Array<{ conta: string; subtotal: boolean }>;
  inputs: Set<string>;
  extrasPorBloco: Record<string, string[]>;
}
export function buildDREModel(lines: Array<{ conta: string; subtotal: boolean }>): DREModel {
  const conhecidas = new Set(DRE_TEMPLATE.map((t) => t.conta));
  const extrasPorBloco: Record<string, string[]> = {};
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.subtotal || conhecidas.has(l.conta)) continue;
    // Bloco = próximo SUBTOTAL abaixo. Exceção: "Resultado Financeiro" e "Resultado Não
    // Operacional" listam o subtotal ANTES dos inputs — se o subtotal imediatamente
    // ACIMA é um deles, a conta pertence a ele.
    let acima: string | null = null;
    for (let j = i - 1; j >= 0; j--) if (lines[j].subtotal) { acima = lines[j].conta; break; }
    let bloco: string | null = null;
    if (acima === "Resultado Financeiro" || acima === "Resultado Não Operacional") bloco = acima;
    else for (let j = i + 1; j < lines.length; j++) if (lines[j].subtotal) { bloco = lines[j].conta; break; }
    // Rede de segurança: conta posicionada DEPOIS do último subtotal (fim do modelo)
    // ancora no subtotal acima (Lucro Líquido) — o valor NUNCA fica fora da cascata.
    if (!bloco) bloco = acima;
    if (bloco) (extrasPorBloco[bloco] ??= []).push(l.conta);
  }
  return { lines, inputs: new Set(lines.filter((l) => !l.subtotal).map((l) => l.conta)), extrasPorBloco };
}
export const DEFAULT_DRE_MODEL: DREModel = buildDREModel(DRE_TEMPLATE.map((t) => ({ conta: t.conta, subtotal: t.subtotal })));

export async function loadActiveDREModel(companyId?: string | null): Promise<DREModel> {
  const m = await findActiveModel("DRE", companyId);
  if (!m || m.linhas.length === 0) return DEFAULT_DRE_MODEL;
  return buildDREModel(m.linhas.map((l) => ({ conta: l.nome, subtotal: l.tipo === "subtotal" || l.tipo === "total" })));
}

/**
 * Versões VIGENTES dos modelos padrão (BP/DRE) no momento da chamada, com o
 * ESCOPO de onde cada uma veio (global ou empresa) — pinagem de proveniência.
 * Mudanças futuras no modelo não alteram análises já processadas.
 */
export async function getActiveModelVersions(companyId?: string | null): Promise<{
  bp: number | null; dre: number | null;
  bpEscopo: "global" | "empresa" | null; dreEscopo: "global" | "empresa" | null;
}> {
  const models = await prisma.standardModel.findMany({
    where: { ativo: true, OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])] },
    select: { tipo: true, versao: true, companyId: true },
  });
  const de = (tipo: string) => {
    const daEmpresa = companyId ? models.find((m) => m.tipo === tipo && m.companyId === companyId) : undefined;
    const global = models.find((m) => m.tipo === tipo && m.companyId === null);
    const usado = daEmpresa ?? global;
    return { versao: usado?.versao ?? null, escopo: usado ? (usado.companyId ? "empresa" as const : "global" as const) : null };
  };
  const bp = de("BP"); const dre = de("DRE");
  return { bp: bp.versao, dre: dre.versao, bpEscopo: bp.escopo, dreEscopo: dre.escopo };
}
