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
  /** subtotais como DECLARADOS nos PDFs (para reconciliação) — por período */
  declarados: Record<string, Record<string, number>>;
}

const yearOf = (p: string): string | null => (p.match(/(20[0-3]\d)/) || [])[1] ?? null;

function periodKeyInstruction(periodos: string[]): string {
  if (!periodos.length) return "Use o(s) período(s) do documento como chave (ex.: o ano).";
  return `Use EXATAMENTE estas chaves de período no JSON: ${JSON.stringify(periodos)}. Mapeie o período do documento para a chave de mesmo ano.`;
}

function drePrompt(periodos: string[]): string {
  return `Você é especialista em contabilidade brasileira. Extraia a DRE deste PDF e mapeie para o MODELO PADRÃO.
REGRAS:
- Respeite a HIERARQUIA visual (indentação/negrito): contas indentadas são FILHAS de um total. Use os TOTAIS de cada seção e NÃO some um total com seus próprios filhos.
- Sinais: RECEITAS positivas; DEDUÇÕES, CUSTOS, DESPESAS e IR/CSLL NEGATIVOS.
- ${periodKeyInstruction(periodos)}
Contas de input (subtotais NÃO — serão calculados):
${dreInputs.map((c) => "- " + c).join("\n")}
Retorne APENAS JSON, sem markdown:
{ "inputs": { "<periodo>": { "<conta>": <num>, ... } },
  "declarados": { "<periodo>": { "Receita Líquida": <valor exibido no PDF>, "Lucro Bruto": <valor exibido>, "Lucro Líquido": <valor exibido> } } }`;
}

function bpPrompt(periodos: string[]): string {
  return `Você é especialista em contabilidade brasileira. Extraia o BALANÇO PATRIMONIAL deste PDF e mapeie para o MODELO PADRÃO.
REGRAS:
- Respeite a HIERARQUIA visual: use os TOTAIS de cada grupo; não some um total com seus filhos. Mapeie cada conta detalhada para a conta-padrão correta (não deixe nenhuma de fora — agregue em "Outros..." quando não houver correspondência exata).
- Ativo positivo. Ativo Total DEVE igualar Passivo Total. Preencha também os subtotais (Ativo Total, Ativo Circulante, Passivo Total, Passivo Circulante, Patrimônio Líquido, etc.).
- ${periodKeyInstruction(periodos)}
Contas do BP:
${bpContas.map((c) => "- " + c).join("\n")}
Retorne APENAS JSON, sem markdown: { "<periodo>": { "<conta>": <num>, ... }, ... }`;
}

async function ask(buffer: Buffer, prompt: string): Promise<any> {
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

function canonicalPeriod(returned: string, canonicos: string[]): string {
  if (canonicos.includes(returned)) return returned;
  const y = yearOf(returned);
  if (y) { const m = canonicos.find((c) => yearOf(c) === y); if (m) return m; }
  return returned;
}

/**
 * Extrai BP + DRE de documentos (PDF) via Claude com visão (PDF nativo), com
 * prompts FOCADOS por tipo e em PARALELO. A própria IA devolve os subtotais
 * declarados (sem reparse heurístico). Fallback acionado pelo analista.
 */
export async function extractFinancialsWithAI(
  docs: Array<{ buffer: Buffer; tipo: string }>,
  periodos: string[]
): Promise<AIExtractionResult> {
  // Dispara todas as chamadas em paralelo
  const tasks = docs.flatMap((doc) => {
    const t = doc.tipo.toLowerCase();
    const isDRE = /dre|resultado|demonstra/.test(t);
    const isBP = /balan|patrimonial|\bbp\b/.test(t);
    const out: Array<Promise<{ kind: "dre" | "bp"; data: any }>> = [];
    if (isDRE || !isBP) out.push(ask(doc.buffer, drePrompt(periodos)).then((data) => ({ kind: "dre" as const, data })));
    if (isBP || (!isDRE && !isBP)) out.push(ask(doc.buffer, bpPrompt(periodos)).then((data) => ({ kind: "bp" as const, data })));
    return out;
  });
  const results = await Promise.all(tasks);

  const bpAcc: Record<string, Record<string, number>> = {};
  const dreAcc: Record<string, Record<string, number>> = {};
  const declarados: Record<string, Record<string, number>> = {};
  const periodSet = new Set<string>(periodos);

  const store = (acc: Record<string, Record<string, number>>, raw: Record<string, Record<string, number>>) => {
    for (const [pRaw, contas] of Object.entries(raw ?? {})) {
      if (!contas || typeof contas !== "object") continue;
      const p = canonicalPeriod(pRaw, periodos); periodSet.add(p);
      for (const [conta, valor] of Object.entries(contas)) {
        if (typeof valor === "number" && valor !== 0) (acc[conta] ??= {})[p] = valor;
      }
    }
  };

  // declarados é período→conta→valor (diferente de store, que é conta→período).
  // Aceita aninhado { "2023": {...} } ou achatado { "Lucro Bruto": n }.
  const setDecl = (p: string, conta: string, valor: unknown) => {
    if (typeof valor === "number" && valor !== 0) (declarados[p] ??= {})[conta] = valor;
  };
  const storeDeclarados = (raw: any) => {
    if (!raw || typeof raw !== "object") return;
    const aninhado = Object.values(raw).some((v) => v && typeof v === "object");
    if (aninhado) {
      for (const [pRaw, contas] of Object.entries(raw)) {
        if (!contas || typeof contas !== "object") continue;
        const p = canonicalPeriod(pRaw, periodos); periodSet.add(p);
        for (const [conta, valor] of Object.entries(contas as any)) setDecl(p, conta, valor);
      }
    } else {
      const p = periodos[0] ?? Array.from(periodSet)[0] ?? "0";
      for (const [conta, valor] of Object.entries(raw)) setDecl(p, conta, valor);
    }
  };

  for (const r of results) {
    if (r.kind === "bp") store(bpAcc, r.data);
    else { store(dreAcc, r.data?.inputs); storeDeclarados(r.data?.declarados); }
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

  return { bp, dre, periodos: allPeriodos, declarados };
}
