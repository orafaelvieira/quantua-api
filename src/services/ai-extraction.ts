import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";
import { BP_TEMPLATE, DRE_TEMPLATE } from "./financial-templates";
import type { BPLineItem, DRELineItem } from "../types/financial";
import { normalizeDRESigns, recomputeDRESubtotals, mapAccountToBPGroup, type DictionaryEntry } from "./account-mapper";

const client = new Anthropic({ apiKey: env.anthropicApiKey });
const AI_MODEL = "claude-sonnet-4-6";
const dreInputs = DRE_TEMPLATE.filter((t) => !t.subtotal).map((t) => t.conta);

// ── Tipos da árvore N3 do BP ──
export interface BPN3Item { nome: string; valor: number; destino?: string }
export interface BPN3Periodo { grupos: Record<string, BPN3Item[]>; totais?: Record<string, number> }
/** Árvore original do BP até o nível 3, por período (auditoria). */
export type ArvoreOriginalBP = Record<string, BPN3Periodo>;

export interface NaoMapeado { nome: string; grupo: string; destino: string; valor: number; periodo: string }

export interface AIExtractionResult {
  bp: BPLineItem[];
  dre: DRELineItem[];
  periodos: string[];
  declarados: Record<string, Record<string, number>>;
  /** árvore original do BP (nível 3) — fiel ao documento, para auditoria */
  arvoreOriginalBP: ArvoreOriginalBP;
  /** contas N3 que o de-para não reconheceu (foram p/ "Outros" ou sinalizadas) */
  naoMapeados: NaoMapeado[];
}

const yearOf = (p: string): string | null => (p.match(/(20[0-3]\d)/) || [])[1] ?? null;
function canonicalPeriod(returned: string, canonicos: string[]): string {
  if (canonicos.includes(returned)) return returned;
  const y = yearOf(returned);
  if (y) { const m = canonicos.find((c) => yearOf(c) === y); if (m) return m; }
  return returned;
}
function periodKeyInstruction(periodos: string[]): string {
  if (!periodos.length) return "Use o(s) período(s) do documento como chave (ex.: o ano).";
  return `Use EXATAMENTE estas chaves de período: ${JSON.stringify(periodos)} (mapeie pelo ano).`;
}

async function ask(buffer: Buffer, prompt: string): Promise<any> {
  const msg = await client.messages.create({
    model: AI_MODEL, max_tokens: 4000,
    messages: [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") } } as any,
      { type: "text", text: prompt },
    ] }],
  });
  let txt = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
  if (txt.startsWith("```")) txt = txt.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  try { return JSON.parse(txt); } catch { return {}; }
}

// ───────────────────────── DRE (mantém abordagem por inputs) ─────────────────────────
function drePrompt(periodos: string[]): string {
  return `Você é especialista em contabilidade brasileira. Extraia a DRE deste PDF e mapeie para o MODELO PADRÃO.
- HIERARQUIA: contas indentadas são FILHAS de um total; use os TOTAIS de cada seção e NÃO some pai+filhos.
- Sinais: RECEITAS positivas; DEDUÇÕES, CUSTOS, DESPESAS e IR/CSLL NEGATIVOS.
- ${periodKeyInstruction(periodos)}
Contas de input (subtotais NÃO):
${dreInputs.map((c) => "- " + c).join("\n")}
Retorne APENAS JSON: { "inputs": { "<periodo>": { "<conta>": <num> } }, "declarados": { "<periodo>": { "Receita Líquida": <exibido>, "Lucro Bruto": <exibido>, "Lucro Líquido": <exibido> } } }`;
}

// ───────────────────────── BP (captura N3 = árvore original) ─────────────────────────
function bpN3Prompt(periodos: string[]): string {
  return `Você é especialista em contabilidade brasileira. Extraia o BALANÇO PATRIMONIAL deste PDF até o NÍVEL 3 SEMÂNTICO.
Para cada um dos 5 grupos, liste as contas da PRIMEIRA QUEBRA REAL (ex.: Fornecedores, Empréstimos, Obrigações Tributárias, Disponível, Clientes…), com o NOME ORIGINAL EXATO do documento e o VALOR LÍQUIDO (filhos já somados).
- PULE wrappers redundantes (valor = subtotal do grupo, ex.: "Exigível a Curto Prazo").
- NÃO desça para contas individuais (bancos, empréstimos específicos, parcelamentos).
- Negativos negativos.
- ${periodKeyInstruction(periodos)}
Grupos: "Ativo Circulante", "Ativo Não Circulante", "Passivo Circulante", "Passivo Não Circulante", "Patrimônio Líquido".
Retorne APENAS JSON: { "<periodo>": { "grupos": { "Ativo Circulante": [ {"nome":"<original>","valor":<n>} ], ... }, "totais": { "Ativo Total": <n>, "Passivo Total": <n> } } }`;
}

const GRP: Record<string, string> = {
  "Ativo Circulante": "AC", "Ativo Não Circulante": "ANC",
  "Passivo Circulante": "PC", "Passivo Não Circulante": "PNC", "Patrimônio Líquido": "PL",
};
const SUBTOTAL_CONTA: Record<string, string> = {
  AC: "Ativo Circulante", ANC: "Ativo Não Circulante",
  PC: "Passivo Circulante", PNC: "Passivo Não Circulante", PL: "Patrimônio Líquido",
};
const OUTROS_GRUPO: Record<string, string | null> = {
  AC: "Outros Ativos Circulantes", PC: "Outros Passivos Circulantes",
  ANC: null, PNC: null, PL: null, // sem balde limpo → vira gap sinalizado (integridade)
};

function foldBP(arvore: ArvoreOriginalBP, periodos: string[], dict?: DictionaryEntry[]): { bp: BPLineItem[]; naoMapeados: NaoMapeado[] } {
  const detalhe: Record<string, Record<string, number>> = {}; // conta → periodo → valor
  const subtotal: Record<string, Record<string, number>> = {}; // grupoCode → periodo → valor
  const naoMapeados: NaoMapeado[] = [];
  const add = (acc: Record<string, Record<string, number>>, k: string, p: string, v: number) => { (acc[k] ??= {})[p] = (acc[k][p] ?? 0) + v; };

  for (const p of periodos) {
    const cap = arvore[p]; if (!cap) continue;
    for (const [grupoNome, itens] of Object.entries(cap.grupos ?? {})) {
      const g = GRP[grupoNome]; if (!g) continue;
      for (const it of itens) {
        if (typeof it.valor !== "number") continue;
        add(subtotal, g, p, it.valor);
        const dest = mapAccountToBPGroup(it.nome, g, dict);
        if (dest) {
          add(detalhe, dest, p, it.valor);
          it.destino = dest; // anota a trilha original → padrão
        } else {
          const balde = OUTROS_GRUPO[g];
          if (balde) add(detalhe, balde, p, it.valor);
          it.destino = balde ?? "(não classificado)";
          naoMapeados.push({ nome: it.nome, grupo: grupoNome, destino: it.destino, valor: it.valor, periodo: p });
        }
      }
    }
  }

  const bp: BPLineItem[] = BP_TEMPLATE.map((t) => {
    let valores: Record<string, number> = {};
    if (t.conta === "Ativo Total") for (const p of periodos) valores[p] = (subtotal.AC?.[p] ?? 0) + (subtotal.ANC?.[p] ?? 0);
    else if (t.conta === "Passivo Total") for (const p of periodos) valores[p] = (subtotal.PC?.[p] ?? 0) + (subtotal.PNC?.[p] ?? 0) + (subtotal.PL?.[p] ?? 0);
    else { const g = Object.entries(SUBTOTAL_CONTA).find(([, c]) => c === t.conta)?.[0]; valores = g ? (subtotal[g] ?? {}) : (detalhe[t.conta] ?? {}); }
    return { classificacao: t.classificacao, conta: t.conta, valores, nivel: t.nivel, editado: false };
  });
  return { bp, naoMapeados };
}

const store = (acc: Record<string, Record<string, number>>, raw: any, periodos: string[], periodSet: Set<string>) => {
  for (const [pRaw, contas] of Object.entries(raw ?? {})) {
    if (!contas || typeof contas !== "object") continue;
    const p = canonicalPeriod(pRaw, periodos); periodSet.add(p);
    for (const [conta, valor] of Object.entries(contas as any)) if (typeof valor === "number" && valor !== 0) (acc[conta] ??= {})[p] = valor;
  }
};

export async function extractFinancialsWithAI(
  docs: Array<{ buffer: Buffer; tipo: string }>,
  periodos: string[],
  dict?: DictionaryEntry[]
): Promise<AIExtractionResult> {
  const tasks = docs.flatMap((doc) => {
    const t = doc.tipo.toLowerCase();
    const isDRE = /dre|resultado|demonstra/.test(t);
    const isBP = /balan|patrimonial|\bbp\b/.test(t);
    const out: Array<Promise<{ kind: "dre" | "bp"; data: any }>> = [];
    if (isDRE || !isBP) out.push(ask(doc.buffer, drePrompt(periodos)).then((data) => ({ kind: "dre" as const, data })));
    if (isBP || (!isDRE && !isBP)) out.push(ask(doc.buffer, bpN3Prompt(periodos)).then((data) => ({ kind: "bp" as const, data })));
    return out;
  });
  const results = await Promise.all(tasks);

  const dreAcc: Record<string, Record<string, number>> = {};
  const declarados: Record<string, Record<string, number>> = {};
  const arvoreOriginalBP: ArvoreOriginalBP = {};
  const periodSet = new Set<string>(periodos);

  const setDecl = (p: string, conta: string, valor: unknown) => { if (typeof valor === "number" && valor !== 0) (declarados[p] ??= {})[conta] = valor; };
  const storeDeclarados = (raw: any) => {
    if (!raw || typeof raw !== "object") return;
    const aninhado = Object.values(raw).some((v) => v && typeof v === "object");
    if (aninhado) for (const [pRaw, contas] of Object.entries(raw)) {
      if (!contas || typeof contas !== "object") continue;
      const p = canonicalPeriod(pRaw, periodos); periodSet.add(p);
      for (const [c, v] of Object.entries(contas as any)) setDecl(p, c, v);
    } else { const p = periodos[0] ?? Array.from(periodSet)[0] ?? "0"; for (const [c, v] of Object.entries(raw)) setDecl(p, c, v); }
  };
  // merge BP captures (árvore original), canonicalizando períodos
  const mergeBP = (raw: any) => {
    for (const [pRaw, cap] of Object.entries(raw ?? {})) {
      if (!cap || typeof cap !== "object") continue;
      const p = canonicalPeriod(pRaw, periodos); periodSet.add(p);
      const c = cap as BPN3Periodo;
      const dest = (arvoreOriginalBP[p] ??= { grupos: {}, totais: {} });
      for (const [g, itens] of Object.entries(c.grupos ?? {})) (dest.grupos[g] ??= []).push(...(itens as BPN3Item[]));
      if (c.totais) dest.totais = { ...dest.totais, ...c.totais };
    }
  };

  for (const r of results) {
    if (r.kind === "bp") mergeBP(r.data);
    else { store(dreAcc, r.data?.inputs, periodos, periodSet); storeDeclarados(r.data?.declarados); }
  }

  const allPeriodos = Array.from(periodSet);
  const { bp, naoMapeados } = foldBP(arvoreOriginalBP, allPeriodos, dict);

  const dre: DRELineItem[] = DRE_TEMPLATE.map((t) => ({
    conta: t.conta, valores: t.subtotal ? {} : (dreAcc[t.conta] ?? {}), subtotal: t.subtotal, editado: false,
  }));
  normalizeDRESigns(dre, allPeriodos);
  recomputeDRESubtotals(dre, allPeriodos);

  return { bp, dre, periodos: allPeriodos, declarados, arvoreOriginalBP, naoMapeados };
}
