import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";
import { BP_TEMPLATE, DRE_TEMPLATE } from "./financial-templates";
import type { BPLineItem, DRELineItem } from "../types/financial";
import { normalizeDRESigns, recomputeDRESubtotals } from "./account-mapper";

const client = new Anthropic({ apiKey: env.anthropicApiKey });

// Modelo usado no fallback acionado por humano (precisão > custo, roda na minoria).
const AI_MODEL = "claude-sonnet-4-6";

const bpContas = BP_TEMPLATE.map((t) => t.conta);
const dreInputs = DRE_TEMPLATE.filter((t) => !t.subtotal).map((t) => t.conta);

export interface AIExtractionResult {
  bp: BPLineItem[];
  dre: DRELineItem[];
  periodos: string[];
}

const yearOf = (p: string): string | null => (p.match(/(20[0-3]\d)/) || [])[1] ?? null;

function periodKeyInstruction(periodos: string[]): string {
  if (!periodos.length) return "Use o(s) período(s) do documento como chave (ex.: o ano).";
  return `Use EXATAMENTE estas chaves de período no JSON: ${JSON.stringify(periodos)}. Mapeie o(s) período(s) do documento para a chave de mesmo ano.`;
}

function drerompt(periodos: string[]): string {
  return `Você é especialista em contabilidade brasileira. Extraia a DRE deste PDF e mapeie para o MODELO PADRÃO.
REGRAS:
- Respeite a HIERARQUIA visual (indentação/negrito): contas indentadas são FILHAS de um total. Use os TOTAIS de cada seção e NÃO some um total com seus próprios filhos (dupla contagem).
- Sinais: RECEITAS positivas; DEDUÇÕES, CUSTOS, DESPESAS e IR/CSLL NEGATIVOS.
- ${periodKeyInstruction(periodos)}
- Use 0 quando a conta não existir.
Contas de input da DRE (os subtotais serão calculados pelo sistema — não os retorne):
${dreInputs.map((c) => "- " + c).join("\n")}
Retorne APENAS JSON: { "<periodo>": { "<conta>": <numero>, ... }, ... }. Sem markdown.`;
}

function bprompt(periodos: string[]): string {
  return `Você é especialista em contabilidade brasileira. Extraia o BALANÇO PATRIMONIAL deste PDF e mapeie para o MODELO PADRÃO.
REGRAS:
- Respeite a HIERARQUIA visual (indentação/negrito): use os TOTAIS de cada grupo; não some um total com seus filhos.
- Ativo positivo. Ativo Total DEVE igualar Passivo Total. Preencha também os subtotais (Ativo Total, Ativo Circulante, Passivo Total, Passivo Circulante, Patrimônio Líquido, etc.).
- ${periodKeyInstruction(periodos)}
- Use 0 quando a conta não existir.
Contas do BP:
${bpContas.map((c) => "- " + c).join("\n")}
Retorne APENAS JSON: { "<periodo>": { "<conta>": <numero>, ... }, ... }. Sem markdown.`;
}

async function askJson(buffer: Buffer, prompt: string): Promise<Record<string, Record<string, number>>> {
  const msg = await client.messages.create({
    model: AI_MODEL,
    max_tokens: 3000,
    messages: [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") } } as any,
      { type: "text", text: prompt },
    ] }],
  });
  let txt = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
  if (txt.startsWith("```")) txt = txt.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  try { return JSON.parse(txt); } catch { return {}; }
}

/** Mapeia uma chave de período retornada pela IA para a chave canônica (mesmo ano). */
function canonicalPeriod(returned: string, canonicos: string[]): string {
  if (canonicos.includes(returned)) return returned;
  const y = yearOf(returned);
  if (y) { const match = canonicos.find((c) => yearOf(c) === y); if (match) return match; }
  return returned;
}

/**
 * Extrai BP + DRE de documentos (PDF) usando Claude com visão (PDF nativo),
 * mapeando direto ao modelo padrão. Prompts FOCADOS por tipo de documento.
 * Fallback acionado pelo analista quando o parser heurístico não reconcilia.
 */
export async function extractFinancialsWithAI(
  docs: Array<{ buffer: Buffer; tipo: string }>,
  periodos: string[]
): Promise<AIExtractionResult> {
  const bpAcc: Record<string, Record<string, number>> = {};
  const dreAcc: Record<string, Record<string, number>> = {};
  const periodSet = new Set<string>(periodos);

  const store = (acc: Record<string, Record<string, number>>, raw: Record<string, Record<string, number>>) => {
    for (const [pRaw, contas] of Object.entries(raw)) {
      const p = canonicalPeriod(pRaw, periodos);
      periodSet.add(p);
      for (const [conta, valor] of Object.entries(contas)) {
        if (typeof valor === "number" && valor !== 0) { (acc[conta] ??= {})[p] = valor; }
      }
    }
  };

  for (const doc of docs) {
    const t = doc.tipo.toLowerCase();
    const isDRE = /dre|resultado|demonstra/.test(t);
    const isBP = /balan|patrimonial|\bbp\b/.test(t);
    if (isDRE || !isBP) store(dreAcc, await askJson(doc.buffer, drerompt(periodos)));
    if (isBP || (!isDRE && !isBP)) store(bpAcc, await askJson(doc.buffer, bprompt(periodos)));
  }

  const allPeriodos = Array.from(periodSet);

  const bp: BPLineItem[] = BP_TEMPLATE.map((t) => ({
    classificacao: t.classificacao, conta: t.conta, valores: bpAcc[t.conta] ?? {}, nivel: t.nivel, editado: false,
  }));
  const dre: DRELineItem[] = DRE_TEMPLATE.map((t) => ({
    conta: t.conta, valores: t.subtotal ? {} : (dreAcc[t.conta] ?? {}), subtotal: t.subtotal, editado: false,
  }));
  normalizeDRESigns(dre, allPeriodos);
  recomputeDRESubtotals(dre, allPeriodos);

  return { bp, dre, periodos: allPeriodos };
}
