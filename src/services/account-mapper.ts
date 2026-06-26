import type { ExtractedRow } from "./parser";
import type { BPLineItem, DRELineItem, UnmatchedAccount } from "../types/financial";
import { BP_TEMPLATE, DRE_TEMPLATE, ACCOUNT_ALIASES } from "./financial-templates";

export interface DictionaryEntry {
  nomeOriginal: string;
  contaDestino: string;
  grupoConta?: string;  // High-level group: AC, ANC, PC, PNC, PL, or parent name
}

export interface BPMapResult {
  items: BPLineItem[];
  unmatched: UnmatchedAccount[];
}

export interface DREMapResult {
  items: DRELineItem[];
  unmatched: UnmatchedAccount[];
}

function normalize(s: string): string {
  return s.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[^a-z0-9 ]/g, " ")  // replace non-alphanumeric with space
    .replace(/\s+/g, " ")         // collapse whitespace
    .trim();
}

/** Remove common prefixes like (-), (–) and leading whitespace */
function cleanAccountName(name: string): string {
  return name
    .replace(/^\s*\(?[\-–]\)?\s*/, "")  // remove leading (-) or (-)
    .replace(/^\s*[\-–]\s*/, "")         // remove leading dash
    .trim();
}

/**
 * Map high-level grupo codes (AC, ANC, PC, PNC, PL) to the set of BP_TEMPLATE
 * classificacao codes that belong to the same section.
 * E.g., grupo "AC" matches classificacao AF, AO (both sub-groups of Ativo Circulante).
 */
const GRUPO_CLASSIF_MAP: Record<string, Set<string>> = {
  AC: new Set(["AC", "AF", "AO"]),
  ANC: new Set(["ANC"]),
  PC: new Set(["PC", "PO", "PF"]),
  PNC: new Set(["PNC"]),
  PL: new Set(["PL"]),
};

/** Check if a template account's classificacao is compatible with an extracted grupo */
function grupoMatchesClassificacao(grupo: string, classificacao: string): boolean {
  const allowed = GRUPO_CLASSIF_MAP[grupo];
  return allowed ? allowed.has(classificacao) : false;
}

/** Build a map from template conta name → classificacao for fast lookup */
const templateClassifMap = new Map<string, string>();
for (const item of BP_TEMPLATE) {
  templateClassifMap.set(item.conta, item.classificacao);
}

function findBestMatch(
  conta: string,
  candidates: string[],
  dictionaryEntries?: DictionaryEntry[],
  grupo?: string
): string | null {
  const cleaned = cleanAccountName(conta);
  const norm = normalize(cleaned);

  if (!norm || norm.length < 2) return null;

  // Helper: check if a candidate is compatible with the extracted grupo
  const isGrupoCompatible = (candidate: string): boolean => {
    if (!grupo) return true; // no grupo info → everything is compatible
    const classif = templateClassifMap.get(candidate);
    if (!classif) return true; // candidate not in template → allow
    return grupoMatchesClassificacao(grupo, classif);
  };

  // 0. Dictionary exact match (highest priority — user-defined mappings)
  if (dictionaryEntries && dictionaryEntries.length > 0) {
    // First pass: match by name + grupo
    if (grupo) {
      for (const entry of dictionaryEntries) {
        if (normalize(entry.nomeOriginal) === norm && candidates.includes(entry.contaDestino)) {
          // If dictionary entry has a grupoConta, require it to match
          if (entry.grupoConta && normalize(entry.grupoConta).includes(normalize(grupo))) {
            return entry.contaDestino;
          }
          // Also check if the entry's grupoConta matches the full grupo name
          const grupoNames: Record<string, string[]> = {
            AC: ["ativo circulante"],
            ANC: ["ativo nao circulante", "ativo não circulante"],
            PC: ["passivo circulante"],
            PNC: ["passivo nao circulante", "passivo não circulante"],
            PL: ["patrimonio liquido", "patrimônio líquido"],
          };
          const normGrupoConta = entry.grupoConta ? normalize(entry.grupoConta) : "";
          const grupoAliases = grupoNames[grupo] || [];
          if (grupoAliases.some(a => normalize(a) === normGrupoConta || normGrupoConta.includes(normalize(a)))) {
            return entry.contaDestino;
          }
        }
      }
    }
    // Second pass: match by name only (no grupo constraint — backward compatible)
    for (const entry of dictionaryEntries) {
      if (normalize(entry.nomeOriginal) === norm && candidates.includes(entry.contaDestino)) {
        if (isGrupoCompatible(entry.contaDestino)) {
          return entry.contaDestino;
        }
      }
    }
    // Third pass: name-only match ignoring grupo (last resort for dictionary)
    for (const entry of dictionaryEntries) {
      if (normalize(entry.nomeOriginal) === norm && candidates.includes(entry.contaDestino)) {
        return entry.contaDestino;
      }
    }
  }

  // 1. Exact match (case-insensitive, accent-insensitive) — prefer grupo-compatible
  for (const c of candidates) {
    if (normalize(c) === norm && isGrupoCompatible(c)) return c;
  }
  // Fallback exact match ignoring grupo
  for (const c of candidates) {
    if (normalize(c) === norm) return c;
  }

  // 2. Alias match — try both original and cleaned name, prefer grupo-compatible
  for (const name of [conta, cleaned, conta.trim()]) {
    const aliased = ACCOUNT_ALIASES[name];
    if (aliased && candidates.includes(aliased) && isGrupoCompatible(aliased)) return aliased;
  }
  for (const [alias, canonical] of Object.entries(ACCOUNT_ALIASES)) {
    if (normalize(alias) === norm && candidates.includes(canonical) && isGrupoCompatible(canonical)) return canonical;
  }
  // Alias fallback without grupo
  for (const name of [conta, cleaned, conta.trim()]) {
    const aliased = ACCOUNT_ALIASES[name];
    if (aliased && candidates.includes(aliased)) return aliased;
  }
  for (const [alias, canonical] of Object.entries(ACCOUNT_ALIASES)) {
    if (normalize(alias) === norm && candidates.includes(canonical)) return canonical;
  }

  // 3. Contains match — prefer grupo-compatible
  for (const c of candidates) {
    const normC = normalize(c);
    if (normC.length >= 4 && norm.length >= 4) {
      if ((norm.includes(normC) || normC.includes(norm)) && isGrupoCompatible(c)) return c;
    }
  }
  // Contains fallback
  for (const c of candidates) {
    const normC = normalize(c);
    if (normC.length >= 4 && norm.length >= 4) {
      if (norm.includes(normC) || normC.includes(norm)) return c;
    }
  }

  // 4. Keyword match — prefer grupo-compatible candidates
  const normWords = norm.split(/\s+/).filter(w => w.length > 2);
  let bestScore = 0;
  let bestCandidate: string | null = null;
  for (const c of candidates) {
    const cWords = normalize(c).split(/\s+/).filter(w => w.length > 2);
    if (cWords.length === 0) continue;
    const overlap = normWords.filter(w => cWords.includes(w)).length;
    const score = overlap / Math.max(cWords.length, 1);
    const reverseScore = overlap / Math.max(normWords.length, 1);
    let combinedScore = (score + reverseScore) / 2;

    // Boost score for grupo-compatible candidates
    if (grupo && isGrupoCompatible(c)) combinedScore += 0.1;

    if (combinedScore > bestScore && overlap >= 1) {
      if (overlap === 1 && score < 0.8) continue;
      bestScore = combinedScore;
      bestCandidate = c;
    }
  }

  if (bestScore >= 0.4 && bestCandidate) return bestCandidate;

  return null;
}

/**
 * Derive high-level grupo (AC, ANC, PC, PNC, PL) from hierarchical account code.
 * Used to pass to findBestMatch for group-aware disambiguation.
 */
function grupoFromExtractedCode(code: string): string | undefined {
  if (code.startsWith("1.01")) return "AC";
  if (code.startsWith("1.02")) return "ANC";
  if (code.startsWith("2.01")) return "PC";
  if (code.startsWith("2.02")) return "PNC";
  if (code.startsWith("2.03")) return "PL";
  return undefined;
}

/**
 * Derive BP classificacao from hierarchical account code.
 */
function classificacaoFromCode(code: string): string {
  if (code.startsWith("1.01")) return "AC";
  if (code.startsWith("1.02")) return "ANC";
  if (code.startsWith("1")) return "AT";
  if (code.startsWith("2.01")) return "PC";
  if (code.startsWith("2.02")) return "PNC";
  if (code.startsWith("2.03")) return "PL";
  if (code.startsWith("2")) return "PT";
  return "0";
}

export function mapExtractedToBP(
  linhas: ExtractedRow[],
  dictionaryEntries?: DictionaryEntry[]
): BPMapResult {
  const templateNames = BP_TEMPLATE.map(t => t.conta);
  const result: BPLineItem[] = BP_TEMPLATE.map(t => ({
    classificacao: t.classificacao,
    conta: t.conta,
    valores: {},
    nivel: t.nivel,
    editado: false,
  }));

  const unmatchedBP: BPLineItem[] = [];
  const unmatchedAccounts: UnmatchedAccount[] = [];
  const matched = new Set<string>();

  for (const linha of linhas) {
    // Skip accounts deeper than level 3 — detail-level accounts (e.g., "Banco do Brasil"
    // code 1.01.01.01) are discarded. Level 3 subtotals already contain the aggregated values.
    // The parser also filters depth > 3, but this is a safety net for data that bypasses it.
    if (linha.code) {
      const depth = linha.code.split(".").length;
      if (depth > 3) continue; // silently discard
    }

    // Pass extracted grupo to findBestMatch for group-aware disambiguation
    const extractedGrupo = linha.grupo || (linha.code ? grupoFromExtractedCode(linha.code) : undefined);
    const match = findBestMatch(linha.conta, templateNames, dictionaryEntries, extractedGrupo);
    if (match) {
      const idx = result.findIndex(r => r.conta === match);
      if (idx >= 0) {
        matched.add(match);
        // Merge values (don't overwrite existing non-zero values)
        for (const [periodo, valor] of Object.entries(linha.valores)) {
          if (result[idx].valores[periodo] === undefined || result[idx].valores[periodo] === 0) {
            result[idx].valores[periodo] = valor;
          }
        }
      }
    } else {
      // Unmatched — include for manual review, with proper nivel from code depth
      const depth = linha.code ? linha.code.split(".").length : 4;
      unmatchedBP.push({
        classificacao: linha.code ? classificacaoFromCode(linha.code) : "0",
        conta: linha.conta,
        valores: { ...linha.valores },
        nivel: Math.max(depth - 1, 2),
        editado: false,
      });
      unmatchedAccounts.push({ conta: linha.conta, valores: { ...linha.valores }, ...(linha.contexto ? { contexto: linha.contexto } : {}) });
    }
  }

  // Items = template + unmatched appended (preserves existing behavior for BP display)
  return {
    items: [...result, ...unmatchedBP],
    unmatched: unmatchedAccounts,
  };
}

// DRE totalizer names that should NOT be mapped via fuzzy matching.
// These are parent-level totals whose sub-items are individually mapped.
// They would otherwise fuzzy-match to specific sub-categories and pollute them.
const DRE_SKIP_TOTALS = new Set([
  "despesas operacionais",  // total of all operating expenses — sub-items mapped individually
]);

export function mapExtractedToDRE(
  linhas: ExtractedRow[],
  dictionaryEntries?: DictionaryEntry[]
): DREMapResult {
  const templateNames = DRE_TEMPLATE.map(t => t.conta);
  const result: DRELineItem[] = DRE_TEMPLATE.map(t => ({
    conta: t.conta,
    valores: {},
    subtotal: t.subtotal,
    editado: false,
  }));

  const unmatchedDRE: DRELineItem[] = [];
  const unmatchedAccounts: UnmatchedAccount[] = [];

  for (const linha of linhas) {
    // Skip known totalizer lines that would pollute sub-item mapping via fuzzy match
    const normConta = linha.conta.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    if (DRE_SKIP_TOTALS.has(normConta)) {
      unmatchedDRE.push({ conta: linha.conta, valores: { ...linha.valores }, subtotal: false, editado: false });
      unmatchedAccounts.push({ conta: linha.conta, valores: { ...linha.valores }, ...(linha.contexto ? { contexto: linha.contexto } : {}) });
      continue;
    }
    const match = findBestMatch(linha.conta, templateNames, dictionaryEntries);
    if (match) {
      const idx = result.findIndex(r => r.conta === match);
      if (idx >= 0) {
        for (const [periodo, valor] of Object.entries(linha.valores)) {
          if (result[idx].valores[periodo] === undefined || result[idx].valores[periodo] === 0) {
            result[idx].valores[periodo] = valor;
          }
        }
      }
    } else {
      unmatchedDRE.push({
        conta: linha.conta,
        valores: { ...linha.valores },
        subtotal: false,
        editado: false,
      });
      unmatchedAccounts.push({ conta: linha.conta, valores: { ...linha.valores }, ...(linha.contexto ? { contexto: linha.contexto } : {}) });
    }
  }

  return {
    items: [...result, ...unmatchedDRE],
    unmatched: unmatchedAccounts,
  };
}

// Linhas de input do DRE de natureza REDUTORA (devem ser negativas no modelo).
const DRE_LINHAS_REDUTORAS = new Set<string>([
  "Deduções da Receita Bruta",
  "Impostos s/ Faturamento",
  "Custo Operacional",
  "Despesas Gerais e Administrativas",
  "Despesas com Vendas",
  "Despesas com Marketing",
  "Despesas com P&D",
  "Outras Despesas Operacionais",
  "Depreciação e Amortização",
  "Despesas Financeiras",
  "Outras Despesas Não Operacionais",
  "IR e CSLL",
]);

// Linhas de input do DRE de natureza RECEITA (devem ser positivas no modelo).
const DRE_LINHAS_RECEITAS = new Set<string>([
  "Receita Bruta",
  "Outras Receitas Operacionais",
  "Receitas Financeiras",
  "Outras Receitas Não Operacionais",
]);
// "Equivalência Patrimonial" é bidirecional (lucro ou prejuízo) — preserva o sinal extraído.

/**
 * Normaliza os sinais das linhas de input do DRE pela NATUREZA da conta, antes da
 * cascata de subtotais. Muitos documentos trazem deduções/custos/despesas como
 * valores POSITIVOS (sem parênteses); sem isto a cascata somaria onde deveria
 * subtrair. Redutoras → −|valor|; receitas → +|valor|. Idempotente (não altera
 * sinais já corretos) e robusto a valor positivo, negativo ou entre parênteses.
 * Não toca subtotais (recalculados depois) nem linhas editadas manualmente.
 */
export function normalizeDRESigns(dre: DRELineItem[], periodos: string[]): void {
  for (const item of dre) {
    if (item.subtotal || item.editado) continue;
    const redutora = DRE_LINHAS_REDUTORAS.has(item.conta);
    const receita = DRE_LINHAS_RECEITAS.has(item.conta);
    if (!redutora && !receita) continue;
    for (const p of periodos) {
      const v = item.valores[p];
      if (v === undefined || v === 0) continue;
      item.valores[p] = redutora ? -Math.abs(v) : Math.abs(v);
    }
  }
}

/**
 * Recalcula os subtotais do DRE padrão (modelo gerencial — Modelo_DRE.xlsx) em
 * cascata, a partir das linhas de input, para cada período. Convenção de sinais:
 * receitas positivas; deduções/custos/despesas/IR negativos (mesma do resto do
 * sistema). Se uma linha de subtotal não tiver nenhum componente (todos zero),
 * preserva o valor já presente (ex.: documento que só trouxe o total líquido).
 *
 * Cascata:
 *   Receita Líquida           = Receita Bruta + Deduções + Impostos s/ Faturamento
 *   Lucro Bruto               = Receita Líquida + Custo Operacional
 *   EBITDA                    = Lucro Bruto + G&A + Vendas + Marketing + P&D + Outras Rec/Desp Op
 *   EBIT                      = EBITDA + Depreciação e Amortização + Equivalência Patrimonial
 *   Resultado Financeiro      = Receitas Financeiras + Despesas Financeiras
 *   Resultado Não Operacional = Outras Receitas Não Op + Outras Despesas Não Op
 *   Resultado Antes do IR     = EBIT + Resultado Financeiro + Resultado Não Operacional
 *   Lucro Líquido             = Resultado Antes do IR e CSLL + IR e CSLL
 */
export function recomputeDRESubtotals(dre: DRELineItem[], periodos: string[]): void {
  const get = (conta: string, p: string): number =>
    dre.find(d => d.conta === conta)?.valores[p] ?? 0;
  const set = (conta: string, p: string, val: number): void => {
    const item = dre.find(d => d.conta === conta);
    if (item) item.valores[p] = val;
  };
  // Mantém subtotal extraído se não houver componentes (soma === 0)
  const resolve = (comp: number, conta: string, p: string): number =>
    comp !== 0 ? comp : get(conta, p);

  for (const p of periodos) {
    const receitaLiquida = resolve(
      get("Receita Bruta", p) + get("Deduções da Receita Bruta", p) + get("Impostos s/ Faturamento", p),
      "Receita Líquida", p
    );
    set("Receita Líquida", p, receitaLiquida);

    const lucroBruto = resolve(receitaLiquida + get("Custo Operacional", p), "Lucro Bruto", p);
    set("Lucro Bruto", p, lucroBruto);

    const ebitda = resolve(
      lucroBruto + get("Despesas Gerais e Administrativas", p) + get("Despesas com Vendas", p) +
        get("Despesas com Marketing", p) + get("Despesas com P&D", p) +
        get("Outras Receitas Operacionais", p) + get("Outras Despesas Operacionais", p),
      "EBITDA", p
    );
    set("EBITDA", p, ebitda);

    const ebit = resolve(ebitda + get("Depreciação e Amortização", p) + get("Equivalência Patrimonial", p), "EBIT", p);
    set("EBIT", p, ebit);

    const resultadoFinanceiro = resolve(
      get("Receitas Financeiras", p) + get("Despesas Financeiras", p),
      "Resultado Financeiro", p
    );
    set("Resultado Financeiro", p, resultadoFinanceiro);

    const resultadoNaoOp = resolve(
      get("Outras Receitas Não Operacionais", p) + get("Outras Despesas Não Operacionais", p),
      "Resultado Não Operacional", p
    );
    set("Resultado Não Operacional", p, resultadoNaoOp);

    const resultadoAntesIR = resolve(
      ebit + resultadoFinanceiro + resultadoNaoOp,
      "Resultado Antes do IR e CSLL", p
    );
    set("Resultado Antes do IR e CSLL", p, resultadoAntesIR);

    set("Lucro Líquido", p, resolve(resultadoAntesIR + get("IR e CSLL", p), "Lucro Líquido", p));
  }
}

/**
 * Extract year from a period string.
 * "31/12/2023" → "2023", "2023" → "2023", "Jan/2024" → "2024"
 */
function extractYear(period: string): string | null {
  const match = period.match(/(20[1-3]\d)/);
  return match ? match[1] : null;
}

/**
 * Normalize periods across all parsed documents so that different representations
 * of the same year (e.g., "31/12/2023" and "2023") are unified into a single canonical form.
 *
 * Strategy: Group periods by year. For each year, prefer the most specific format
 * (DD/MM/YYYY > YYYY). Remap all valores keys in all linhas accordingly.
 */
export function normalizePeriods(parsedDocs: Array<{ periodos: string[]; linhas: ExtractedRow[] }>): void {
  // 1. Collect all periods and group by year
  const byYear = new Map<string, string[]>();
  for (const doc of parsedDocs) {
    for (const p of doc.periodos) {
      const year = extractYear(p);
      if (year) {
        if (!byYear.has(year)) byYear.set(year, []);
        const arr = byYear.get(year)!;
        if (!arr.includes(p)) arr.push(p);
      }
    }
  }

  // 2. Build normalization map: variant → canonical
  // Prefer DD/MM/YYYY format, then the longest representation
  const normMap = new Map<string, string>();
  for (const [_year, variants] of byYear) {
    if (variants.length <= 1) continue;
    // Pick canonical: prefer full date (DD/MM/YYYY)
    const fullDate = variants.find(v => /^\d{2}\/\d{2}\/\d{4}$/.test(v));
    const canonical = fullDate || variants.sort((a, b) => b.length - a.length)[0];
    for (const v of variants) {
      if (v !== canonical) normMap.set(v, canonical);
    }
  }

  if (normMap.size === 0) return; // nothing to normalize

  // 3. Remap periodos arrays and valores keys in all documents
  for (const doc of parsedDocs) {
    doc.periodos = doc.periodos.map(p => normMap.get(p) || p);
    // Deduplicate after remapping
    doc.periodos = [...new Set(doc.periodos)];

    for (const linha of doc.linhas) {
      const newValores: Record<string, number> = {};
      for (const [key, val] of Object.entries(linha.valores)) {
        const normKey = normMap.get(key) || key;
        // If key was remapped and target already exists, keep the first (don't overwrite)
        if (newValores[normKey] === undefined) {
          newValores[normKey] = val;
        }
      }
      linha.valores = newValores;
    }
  }
}

/** Detect all unique periods across extracted documents */
export function detectPeriodos(parsedDocs: Array<{ periodos: string[] }>): string[] {
  const set = new Set<string>();
  for (const doc of parsedDocs) {
    for (const p of doc.periodos) set.add(p);
  }
  // Sort: try numeric (years) first, then alphabetical
  return Array.from(set).sort((a, b) => {
    const na = parseFloat(a);
    const nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    // Sort dates by year
    const ya = a.match(/20\d{2}/)?.[0];
    const yb = b.match(/20\d{2}/)?.[0];
    if (ya && yb) return parseInt(ya) - parseInt(yb);
    return a.localeCompare(b);
  });
}
