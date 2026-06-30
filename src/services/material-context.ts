/**
 * Materiais complementares (Input 4 da Análise Estratégica do IBR).
 *
 * Documentos NÃO contábeis que dão contexto qualitativo: notas de reunião (.docx),
 * apresentações da empresa (.pdf/.pptx), etc. Cada material é RESUMIDO por uma passada
 * de IA num bloco enxuto que entra no prompt de `generateAnalysis` — controla tokens e
 * ruído. O resumo é CACHEADO no próprio Document (dadosExtraidos) para não re-resumir
 * (e não re-cobrar) a cada regeneração; só materiais novos custam.
 *
 * Custo (regra [[registrar-custo-ia]]): soma dos tokens das passadas de resumo,
 * vinculado ao IBR em resultado.custoMateriais.
 */

import { prisma } from "../db/client";
import { downloadFile } from "./storage";
import { modeloAnaliseId, calcCusto, createWithRetry, type CustoIA } from "./ai-extraction";

/** Valor de Document.tipo que marca um material complementar (pula a extração financeira). */
export const MATERIAL_TIPO = "Material complementar";

const MAX_CHARS = 14000; // teto de texto enviado ao resumo (corta materiais gigantes)

export interface MaterialResumo {
  docId: string;
  nome: string;
  resumo: string;
}
export interface MateriaisContext {
  blocos: MaterialResumo[];
  /** custo agregado das passadas de resumo NESTA execução (0 se tudo veio do cache). */
  custo: CustoIA | null;
}

/** Extrai texto de docx/pptx/pdf (officeparser) ou txt. Vazio se não der. */
async function extrairTexto(buffer: Buffer, nome: string): Promise<string> {
  const ext = (nome.split(".").pop() ?? "").toLowerCase();
  try {
    if (ext === "txt" || ext === "md") return buffer.toString("utf8");
    // officeparser cobre docx, pptx, pdf, xlsx, odt, odp.
    const { parseOfficeAsync } = await import("officeparser");
    const txt = await parseOfficeAsync(buffer);
    return (txt ?? "").trim();
  } catch (e: any) {
    console.warn(`[materiais] extração de texto falhou (${nome}): ${e?.message ?? e}`);
    return "";
  }
}

function promptResumo(nome: string, texto: string): string {
  return `Você é analista de um Independent Business Review (IBR). Abaixo está o conteúdo de um MATERIAL COMPLEMENTAR enviado pelo analista (ex.: notas de reunião, apresentação da empresa). Resuma o que for ÚTIL para o diagnóstico estratégico do IBR.

Material: "${nome}"
---
${texto.slice(0, MAX_CHARS)}
---

Regras:
- NO MÁXIMO 130 palavras, em bullets começando com "- ".
- Foque em fatos sobre a empresa: estratégia, mercado/concorrência, operação, governança, planos, riscos e qualquer número citado.
- NÃO invente; se o material for irrelevante para o IBR, diga "Sem conteúdo relevante para o IBR.".
- Responda só o resumo, sem preâmbulo.`;
}

function somaCusto(a: CustoIA | null, b: CustoIA): CustoIA {
  if (!a) return b;
  return {
    modelo: a.modelo,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    usd: a.usd + b.usd,
  };
}

/**
 * Carrega os materiais complementares do IBR, resume os que ainda não têm resumo
 * cacheado e devolve os blocos + o custo das novas passadas. Null se não houver
 * material. Best-effort: um material que falha é pulado (não derruba a análise).
 */
export async function buildMateriaisContext(
  analysisId: string,
  modelKey?: string | null,
): Promise<MateriaisContext | null> {
  const docs = await prisma.document.findMany({
    where: { analysisId, tipo: MATERIAL_TIPO },
    orderBy: { createdAt: "asc" },
  });
  if (docs.length === 0) return null;

  const model = modeloAnaliseId(modelKey);
  const blocos: MaterialResumo[] = [];
  let custo: CustoIA | null = null;

  for (const doc of docs) {
    // Cache: resumo já gerado fica em dadosExtraidos.resumo.
    const cache = doc.dadosExtraidos as { resumo?: string } | null;
    if (cache?.resumo) {
      blocos.push({ docId: doc.id, nome: doc.nome, resumo: cache.resumo });
      continue;
    }
    if (!doc.storagePath) continue;

    try {
      const buffer = await downloadFile(doc.storagePath);
      const texto = await extrairTexto(buffer, doc.nome);
      if (!texto || texto.length < 20) {
        await prisma.document.update({
          where: { id: doc.id },
          data: { status: "Erro", dadosExtraidos: { erro: "Não foi possível extrair texto do material." } as object },
        });
        continue;
      }

      const msg = await createWithRetry({
        model,
        max_tokens: 600,
        messages: [{ role: "user", content: promptResumo(doc.nome, texto) }],
      });
      const resumo = (msg.content?.[0]?.type === "text" ? msg.content[0].text : "").trim();
      if (!resumo) continue;

      const c = calcCusto(model, msg.usage?.input_tokens ?? 0, msg.usage?.output_tokens ?? 0);
      custo = somaCusto(custo, c);

      await prisma.document.update({
        where: { id: doc.id },
        data: { status: "Processado", dadosExtraidos: { resumo, custo: c } as object },
      });
      blocos.push({ docId: doc.id, nome: doc.nome, resumo });
    } catch (e: any) {
      console.warn(`[materiais] resumo falhou (${doc.nome}): ${e?.message ?? e}`);
    }
  }

  if (blocos.length === 0) return null;
  return { blocos, custo };
}
