// ── TRAVA DE DUPLICIDADE NA DATA ROOM (pedido do usuário, 27/07/2026) ──
// A Data room é fonte única: o MESMO arquivo (SHA-256 idêntico) entrando duas
// vezes cria linhas-fantasma — dois "documentos" que são um só, competências em
// dobro e produtos fundamentados em cópias. O upload recusa com 409 e aponta a
// linha existente; correção de conteúdo é SUBSTITUIÇÃO (versão nova, com trilha),
// nunca reenvio.
//
// Fixações (fase B) ficam de fora da busca: são a LENTE de um IBR sobre um
// documento que já está no pool (mesmo hash POR CONSTRUÇÃO) — não são cópias.

import { prisma } from "../db/client";

export interface DocDuplicado {
  id: string;
  nome: string;
  tipo: string;
  competencia: string | null;
  versao: number;
  /** null = linha do pool (Data room da empresa); string = pertence a um IBR */
  analysisId: string | null;
}

/** Procura, na empresa, um documento VIVO (não-substituído, não-fixação) com o
 *  mesmo SHA-256. Linha de pool tem prioridade na resposta (é a fonte única). */
export async function acharDuplicadoPorHash(companyId: string, hash: string, ignorarIds: string[] = []): Promise<DocDuplicado | null> {
  const vivos = await prisma.document.findMany({
    where: {
      companyId,
      hash,
      status: { not: "Substituído" },
      fixadoDeId: null,
      ...(ignorarIds.length ? { id: { notIn: ignorarIds } } : {}),
    },
    select: { id: true, nome: true, tipo: true, competencia: true, versao: true, analysisId: true },
    orderBy: { createdAt: "asc" },
  });
  if (!vivos.length) return null;
  return vivos.find((d) => d.analysisId === null) ?? vivos[0];
}

/** Mensagem 409 padrão — diz ONDE o documento já está e qual é o caminho certo. */
export function mensagemDuplicado(dup: DocDuplicado): string {
  const onde = dup.analysisId ? "em um IBR desta empresa" : "na Data room da empresa";
  const comp = dup.competencia ? `, competência ${dup.competencia}` : "";
  return (
    `Este arquivo já existe ${onde}: "${dup.nome}" (${dup.tipo}${comp}${dup.versao > 1 ? `, v${dup.versao}` : ""}). ` +
    `Conteúdo idêntico byte a byte (SHA-256). Se a intenção é corrigir o documento, use "Substituição" — a versão antiga fica preservada como evidência.`
  );
}

// ── PRODUTOS VINCULADOS a um documento (substituição informada) ──
// Substituir um insumo que fundamenta produtos exige o analista SABER: IBR
// aberto reprocessa; IBR concluído é imutável e pede "Nova versão…" do produto.

export interface ProdutoVinculado {
  id: string;
  nome: string;
  status: string;
  produto: "IBR" | "Modelo financeiro";
}

/** IBRs (e modelos financeiros semeados por eles) que usam o documento: o dono
 *  direto (analysisId), as fixações vivas do documento e — quando o documento é
 *  ele próprio uma fixação — as fixações-irmãs da mesma linha do pool. */
export async function produtosQueUsamDocumento(doc: { id: string; analysisId: string | null; fixadoDeId: string | null }): Promise<ProdutoVinculado[]> {
  const analysisIds = new Set<string>();
  if (doc.analysisId) analysisIds.add(doc.analysisId);
  const fixacoes = await prisma.document.findMany({
    where: {
      OR: [{ fixadoDeId: doc.id }, ...(doc.fixadoDeId ? [{ fixadoDeId: doc.fixadoDeId }] : [])],
      status: { not: "Substituído" },
      analysisId: { not: null },
    },
    select: { analysisId: true },
  });
  for (const f of fixacoes) if (f.analysisId) analysisIds.add(f.analysisId);
  if (!analysisIds.size) return [];

  const ids = [...analysisIds];
  const [analises, modelos] = await Promise.all([
    prisma.analysis.findMany({ where: { id: { in: ids } }, select: { id: true, nome: true, status: true } }),
    prisma.financialModel.findMany({ where: { analysisSeedId: { in: ids } }, select: { id: true, nome: true } }),
  ]);
  return [
    ...analises.map((a): ProdutoVinculado => ({ id: a.id, nome: a.nome, status: a.status, produto: "IBR" })),
    ...modelos.map((m): ProdutoVinculado => ({ id: m.id, nome: m.nome, status: "—", produto: "Modelo financeiro" })),
  ];
}

/** Aviso pronto para a resposta da substituição (null quando não há vínculo). */
export function avisoProdutosVinculados(produtos: ProdutoVinculado[]): string | null {
  if (!produtos.length) return null;
  const lista = produtos.map((p) => `${p.produto} "${p.nome}"${p.status !== "—" ? ` (${p.status})` : ""}`).join(" · ");
  return (
    `A versão substituída fundamenta ${produtos.length} produto(s): ${lista}. ` +
    `IBR aberto deve ser REPROCESSADO para usar a versão nova; IBR concluído é imutável — gere uma NOVA VERSÃO do produto (workspace → Nova versão…).`
  );
}
