import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";
import { DRE_TEMPLATE } from "./financial-templates";
import type { BPLineItem, DRELineItem } from "../types/financial";
import { normalizeDRESigns, recomputeDRESubtotals, mapAccountToBPGroup, mapAccountToDRE, DEFAULT_BP_MODEL, type BPModel, type DictionaryEntry } from "./account-mapper";

const client = new Anthropic({ apiKey: env.anthropicApiKey });
const AI_MODEL = "claude-sonnet-4-6";        // visão (lê o PDF) — caro
const AI_MODEL_FAST = "claude-haiku-4-5-20251001"; // estrutura texto do parser — barato
const dreInputs = DRE_TEMPLATE.filter((t) => !t.subtotal).map((t) => t.conta);
const dreInputsSet = new Set(dreInputs);

export interface DRESecaoItem { nome: string; valor: number; destino?: string }
export type ArvoreOriginalDRE = Record<string, DRESecaoItem[]>;

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
  /** seções originais da DRE — fiel ao documento, para auditoria */
  arvoreOriginalDRE: ArvoreOriginalDRE;
  /** contas N3/seções que o de-para não reconheceu (foram p/ "Outros" ou sinalizadas) */
  naoMapeados: NaoMapeado[];
}

const yearOf = (p: string): string | null => (p.match(/(20[0-3]\d)/) || [])[1] ?? null;
function canonicalPeriod(returned: string, canonicos: string[]): string {
  if (canonicos.includes(returned)) return returned;
  const y = yearOf(returned);
  if (y) {
    const m = canonicos.find((c) => yearOf(c) === y);
    if (m) return m;
    return y; // sem canônico → colapsa para o ANO, alinhando BP ("31/12/2022") e DRE ("2022") do mesmo ano
  }
  return returned;
}
function periodKeyInstruction(periodos: string[]): string {
  if (!periodos.length) return "Use o(s) período(s) do documento como chave (ex.: o ano).";
  return `Use EXATAMENTE estas chaves de período: ${JSON.stringify(periodos)} (mapeie pelo ano).`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// input: ou um PDF (visão, caro) ou texto já extraído pelo parser (barato).
async function ask(input: { buffer?: Buffer; text?: string }, prompt: string, model: string = AI_MODEL, attempt = 0): Promise<any> {
  const content: any[] = input.text
    ? [{ type: "text", text: `${prompt}\n\nCONTEÚDO EXTRAÍDO DO DOCUMENTO:\n${input.text}` }]
    : [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: input.buffer!.toString("base64") } },
        { type: "text", text: prompt },
      ];
  let msg;
  try {
    msg = await client.messages.create({ model, max_tokens: 4000, messages: [{ role: "user", content }] });
  } catch (e: any) {
    // 429 (rate limit) ou 529 (overloaded): espera e tenta de novo (uploads multi-doc)
    if ((e?.status === 429 || e?.status === 529) && attempt < 4) {
      await sleep(7000 * (attempt + 1));
      return ask(input, prompt, model, attempt + 1);
    }
    throw e;
  }
  let txt = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
  if (txt.startsWith("```")) txt = txt.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  try { return JSON.parse(txt); } catch { return {}; }
}

// ───────────────────────── DRE (captura de seções = árvore original) ─────────────────────────
function dreSecoesPrompt(periodos: string[]): string {
  return `Você é especialista em contabilidade brasileira. Extraia a DRE deste PDF até as SEÇÕES DE INPUT (primeira quebra real), com o NOME ORIGINAL EXATO + VALOR LÍQUIDO.
- Para o bloco de DESPESAS OPERACIONAIS, retorne suas SUBCATEGORIAS (ex.: De Vendas, Administrativas, Com Veículos, Despesas Financeiras, Receitas Financeiras, Despesas Tributárias) — NÃO as folhas (salários, fgts, etc.).
- Para Receita/Deduções/Custos, o total da seção basta (ou subseções como "Impostos Incidentes sobre Vendas").
- NÃO retorne subtotais calculados (Receita Líquida, Lucro Bruto, EBITDA, EBIT, Resultado/Lucro/Prejuízo Líquido).
- Sinais: RECEITAS positivas; DEDUÇÕES, CUSTOS, DESPESAS e IR/CSLL NEGATIVOS.
- ${periodKeyInstruction(periodos)}
Retorne APENAS JSON: { "secoes": { "<periodo>": [ {"nome":"<original>","valor":<n>} ] }, "declarados": { "<periodo>": { "Receita Líquida": <exibido>, "Lucro Bruto": <exibido>, "Lucro Líquido": <exibido> } } }`;
}

const normNome = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Seções que são SUBTOTAIS/pais na DRE. Se vierem na captura, seus filhos também
 *  vêm — então NÃO podem ser somadas na cascata (dupla contagem). */
const DRE_SUBTOTAIS = new Set([
  "despesas operacionais", "receitas e despesas operacionais", "despesas e receitas operacionais",
  "despesas operacionais liquidas", "total das despesas operacionais", "total despesas operacionais",
  "despesas e receitas operacionais liquidas", "outras receitas e despesas operacionais",
  "resultado operacional", "lucro operacional", "prejuizo operacional",
  "resultado antes do resultado financeiro", "lucro antes do resultado financeiro",
].map(normNome));
/** destinos que compõem o bloco operacional/financeiro — candidatos a "filhos" de um
 *  subtotal "Despesas Operacionais". Usados para decidir POR VALOR se o pai é redundante. */
const DESP_OP_DESTINOS = new Set([
  "Despesas com Vendas", "Despesas Gerais e Administrativas", "Despesas com Marketing",
  "Despesas com P&D", "Outras Despesas Operacionais", "Outras Receitas Operacionais",
  "Receitas Financeiras", "Despesas Financeiras",
]);

export function foldDRE(arvore: ArvoreOriginalDRE, periodos: string[], dict?: DictionaryEntry[]): { dre: DRELineItem[]; naoMapeados: NaoMapeado[] } {
  const acc: Record<string, Record<string, number>> = {};
  const naoMapeados: NaoMapeado[] = [];
  for (const p of periodos) {
    const secoes = arvore[p] ?? [];
    const subtotais = secoes.filter((it) => DRE_SUBTOTAIS.has(normNome(it.nome)));
    const inputs = secoes.filter((it) => !DRE_SUBTOTAIS.has(normNome(it.nome)));
    for (const it of inputs) {
      if (typeof it.valor !== "number" || it.valor === 0) continue;
      let dest = mapAccountToDRE(it.nome, dict);
      if (!dest || !dreInputsSet.has(dest)) {
        dest = it.valor < 0 ? "Outras Despesas Operacionais" : "Outras Receitas Operacionais";
        naoMapeados.push({ nome: it.nome, grupo: "DRE", destino: dest, valor: it.valor, periodo: p });
      }
      it.destino = dest;
      (acc[dest] ??= {})[p] = (acc[dest][p] ?? 0) + it.valor;
    }
    // Subtotais estruturais (pais) — descarte POR VALOR, não por nome: só é pai se os
    // filhos capturados (bloco operacional/financeiro) SOMAREM ≈ o valor dele. Senão é
    // um INPUT real (ex.: Fibracabos "Despesas Operacionais" 1.434.351 ≠ filhos 822.330)
    // e precisa entrar na cascata — descartá-lo perderia o valor e quebraria o Lucro Líquido.
    const childSum = inputs
      .filter((it) => it.destino && DESP_OP_DESTINOS.has(it.destino))
      .reduce((s, it) => s + (it.valor || 0), 0);
    for (const st of subtotais) {
      if (typeof st.valor !== "number" || st.valor === 0) { st.destino = "(subtotal)"; continue; }
      const cobre = Math.abs(childSum) > 1 &&
        Math.abs(Math.abs(childSum) - Math.abs(st.valor)) / Math.abs(st.valor) < 0.12;
      if (cobre) { st.destino = "(subtotal — filhos já contabilizados)"; continue; }
      const dest = st.valor < 0 ? "Outras Despesas Operacionais" : "Outras Receitas Operacionais";
      st.destino = dest;
      naoMapeados.push({ nome: st.nome, grupo: "DRE", destino: dest, valor: st.valor, periodo: p });
      (acc[dest] ??= {})[p] = (acc[dest][p] ?? 0) + st.valor;
    }
  }
  const dre: DRELineItem[] = DRE_TEMPLATE.map((t) => ({
    conta: t.conta, valores: t.subtotal ? {} : (acc[t.conta] ?? {}), subtotal: t.subtotal, editado: false,
  }));
  normalizeDRESigns(dre, periodos);
  recomputeDRESubtotals(dre, periodos);
  return { dre, naoMapeados };
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
// Contas de COMPENSAÇÃO (memorando): aparecem dos dois lados com o mesmo valor para se
// anular — não são bens/dívidas reais. Excluídas do BP para não inflar Ativo e Passivo.
const isCompensacao = (nome: string): boolean => /compensa[çc][aã]o/i.test(nome);
const OUTROS_GRUPO: Record<string, string | null> = {
  AC: "Outros Ativos Circulantes", PC: "Outros Passivos Circulantes",
  ANC: "Outros Ativos Não Circulantes", PNC: "Outros Passivos não Circulantes",
  PL: null, // PL sem balde limpo → vira gap sinalizado (integridade)
};

export function foldBP(arvore: ArvoreOriginalBP, periodos: string[], dict?: DictionaryEntry[], model: BPModel = DEFAULT_BP_MODEL): { bp: BPLineItem[]; naoMapeados: NaoMapeado[] } {
  const detalhe: Record<string, Record<string, number>> = {}; // conta → periodo → valor
  const subtotal: Record<string, Record<string, number>> = {}; // grupoCode → periodo → valor
  const naoMapeados: NaoMapeado[] = [];
  const add = (acc: Record<string, Record<string, number>>, k: string, p: string, v: number) => { (acc[k] ??= {})[p] = (acc[k][p] ?? 0) + v; };

  for (const p of periodos) {
    const cap = arvore[p]; if (!cap) continue;

    // Detecta a convenção CRÉDITO-NEGATIVO (SPED): Ativo positivo, Passivo+PL negativos
    // (somam zero). Só vira o sinal do lado do Passivo quando o TOTAL dele é negativo —
    // assim PL negativo por prejuízo acumulado (com Passivo Total positivo) NÃO é afetado.
    let ativoRaw = 0, passivoRaw = 0;
    for (const [grupoNome, itens] of Object.entries(cap.grupos ?? {})) {
      const g = GRP[grupoNome]; if (!g) continue;
      for (const it of itens) {
        if (typeof it.valor !== "number" || isCompensacao(it.nome)) continue;
        if (g === "AC" || g === "ANC") ativoRaw += it.valor; else passivoRaw += it.valor;
      }
    }
    const flipPassivo = passivoRaw < 0 && ativoRaw > 0;

    for (const [grupoNome, itens] of Object.entries(cap.grupos ?? {})) {
      const g = GRP[grupoNome]; if (!g) continue;
      const fator = flipPassivo && (g === "PC" || g === "PNC" || g === "PL") ? -1 : 1;
      for (const it of itens) {
        if (typeof it.valor !== "number") continue;
        if (isCompensacao(it.nome)) { it.destino = "(compensação — excluída)"; continue; }
        const v = it.valor * fator;
        add(subtotal, g, p, v);
        const dest = mapAccountToBPGroup(it.nome, g, dict, model);
        if (dest) {
          add(detalhe, dest, p, v);
          it.destino = dest; // anota a trilha original → padrão
        } else {
          const balde = OUTROS_GRUPO[g];
          if (balde) add(detalhe, balde, p, v);
          it.destino = balde ?? "(não classificado)";
          naoMapeados.push({ nome: it.nome, grupo: grupoNome, destino: it.destino, valor: v, periodo: p });
        }
      }
    }
  }

  // Estrutura por TIPO + CLASSIFICAÇÃO (códigos estáveis), não por nome — robusto a
  // renomeação do modelo. Subtotal = soma do grupo; total = soma dos subtotais.
  const bp: BPLineItem[] = model.lines.map((t) => {
    let valores: Record<string, number> = {};
    if (t.tipo === "total") {
      if (t.classificacao === "AT") for (const p of periodos) valores[p] = (subtotal.AC?.[p] ?? 0) + (subtotal.ANC?.[p] ?? 0);
      else if (t.classificacao === "PT") for (const p of periodos) valores[p] = (subtotal.PC?.[p] ?? 0) + (subtotal.PNC?.[p] ?? 0) + (subtotal.PL?.[p] ?? 0);
    } else if (t.tipo === "subtotal") {
      valores = subtotal[t.classificacao] ?? {};
    } else {
      valores = detalhe[t.conta] ?? {};
    }
    return { classificacao: t.classificacao, conta: t.conta, valores, nivel: t.nivel, editado: false };
  });
  return { bp, naoMapeados };
}

export async function extractFinancialsWithAI(
  docs: Array<{ buffer?: Buffer; raw?: string; tipo: string }>,
  periodos: string[],
  dict?: DictionaryEntry[],
  bpModel: BPModel = DEFAULT_BP_MODEL,
  opts: { model?: string } = {}
): Promise<AIExtractionResult> {
  // Texto do parser → Haiku (barato); PDF → Sonnet visão (caro). Default: visão.
  const model = opts.model ?? (docs.some((d) => d.raw) ? AI_MODEL_FAST : AI_MODEL);
  const taskThunks = docs.flatMap((doc) => {
    const t = doc.tipo.toLowerCase();
    const isDRE = /dre|resultado|demonstra/.test(t);
    const isBP = /balan|patrimonial|\bbp\b/.test(t);
    const input = { buffer: doc.buffer, text: doc.raw };
    const out: Array<() => Promise<{ kind: "dre" | "bp"; data: any }>> = [];
    if (isDRE || !isBP) out.push(() => ask(input, dreSecoesPrompt(periodos), model).then((data) => ({ kind: "dre" as const, data })));
    if (isBP || (!isDRE && !isBP)) out.push(() => ask(input, bpN3Prompt(periodos), model).then((data) => ({ kind: "bp" as const, data })));
    return out;
  });
  // Sequencial (não paralelo) para respeitar o rate limit da API em uploads multi-documento.
  const results: Array<{ kind: "dre" | "bp"; data: any }> = [];
  for (const thunk of taskThunks) results.push(await thunk());

  const declarados: Record<string, Record<string, number>> = {};
  const arvoreOriginalBP: ArvoreOriginalBP = {};
  const arvoreOriginalDRE: ArvoreOriginalDRE = {};
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

  // merge DRE captures (seções originais), canonicalizando períodos
  const mergeDRE = (raw: any) => {
    for (const [pRaw, secoes] of Object.entries(raw?.secoes ?? {})) {
      if (!Array.isArray(secoes)) continue;
      const p = canonicalPeriod(pRaw, periodos); periodSet.add(p);
      (arvoreOriginalDRE[p] ??= []).push(...(secoes as DRESecaoItem[]));
    }
  };

  for (const r of results) {
    if (r.kind === "bp") mergeBP(r.data);
    else { mergeDRE(r.data); storeDeclarados(r.data?.declarados); }
  }

  const allPeriodos = Array.from(periodSet);
  const { bp, naoMapeados: naoMapBP } = foldBP(arvoreOriginalBP, allPeriodos, dict, bpModel);
  const { dre, naoMapeados: naoMapDRE } = foldDRE(arvoreOriginalDRE, allPeriodos, dict);

  return {
    bp, dre, periodos: allPeriodos, declarados,
    arvoreOriginalBP, arvoreOriginalDRE,
    naoMapeados: [...naoMapBP, ...naoMapDRE],
  };
}
