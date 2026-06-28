import * as XLSX from "xlsx";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";

export interface ExtractedRow {
  conta: string;
  valores: Record<string, number>; // { "Jan/2025": 1000000, "Fev/2025": 950000, ... }
  code?: string;    // Código hierárquico do plano de contas (ex: "1.01.01")
  indent?: number;  // Nível de indentação no PDF original
  grupo?: string;   // Grupo pai detectado: "AC" | "ANC" | "PC" | "PNC" | "PL" | undefined
  contexto?: string; // Hierarquia de linhas-pai (ex: "ATIVO > CIRCULANTE")
}

export interface ParsedDocument {
  tipo: string;
  linhas: ExtractedRow[];
  periodos: string[]; // colunas de período detectadas
  raw: string;        // representação textual para o Claude
}

// ─── Hierarchy Context Builder ────────────────────────────────────────
// Adds `contexto` field to each ExtractedRow with up to 2 ancestor names
// from the document hierarchy, e.g. "ATIVO > CIRCULANTE"

function buildHierarchyContext(linhas: ExtractedRow[]): void {
  if (linhas.length === 0) return;

  const hasCodes = linhas.some(l => l.code);
  const uniqueIndents = new Set(linhas.map(l => l.indent ?? 0));
  const hasIndentHierarchy = uniqueIndents.size >= 3;

  if (hasCodes) {
    buildContextFromCodes(linhas);
  } else if (hasIndentHierarchy) {
    buildContextFromIndents(linhas);
  } else {
    buildContextFromSectionHeaders(linhas);
  }
}

/** Strategy 1: Code-based (e.g., 1.01.01 → parent 1.01 → grandparent 1) */
function buildContextFromCodes(linhas: ExtractedRow[]): void {
  const codeToName = new Map<string, string>();
  for (const l of linhas) {
    if (l.code) codeToName.set(l.code, l.conta);
  }

  for (const l of linhas) {
    if (!l.code) continue;
    const ancestors: string[] = [];
    let code = l.code;

    // Walk up removing last segment: "1.01.01" → "1.01" → "1"
    while (ancestors.length < 2) {
      const lastDot = code.lastIndexOf(".");
      if (lastDot <= 0) break;
      code = code.substring(0, lastDot);
      const parentName = codeToName.get(code);
      if (parentName) ancestors.unshift(parentName); // prepend for top-down order
    }

    if (ancestors.length > 0) {
      l.contexto = ancestors.join(" > ");
    }
  }
}

/** Strategy 2: Indent-based — walk backward to find lines with less indentation */
function buildContextFromIndents(linhas: ExtractedRow[]): void {
  for (let i = 0; i < linhas.length; i++) {
    const myIndent = linhas[i].indent ?? 0;
    if (myIndent === 0) continue; // top-level, no parent

    const ancestors: string[] = [];
    let targetIndent = myIndent;

    // Walk backward, find parent (less indent), then grandparent
    for (let j = i - 1; j >= 0 && ancestors.length < 2; j--) {
      const jIndent = linhas[j].indent ?? 0;
      if (jIndent < targetIndent) {
        ancestors.unshift(linhas[j].conta); // prepend for top-down order
        targetIndent = jIndent;
        if (jIndent === 0) break; // reached top level
      }
    }

    if (ancestors.length > 0) {
      linhas[i].contexto = ancestors.join(" > ");
    }
  }
}

/** Strategy 3: Section-header fallback — detect ATIVO/PASSIVO/CIRCULANTE headers */
function buildContextFromSectionHeaders(linhas: ExtractedRow[]): void {
  const topLevelPatterns = [
    /^A\s*T\s*I\s*V\s*O$/i,
    /^P\s*A\s*S\s*S\s*I\s*V\s*O$/i,
    /^ATIVO\s*(TOTAL)?$/i,
    /^PASSIVO\s*(TOTAL)?$/i,
    /^ATIVO\b/i,
    /^PASSIVO\b/i,
  ];

  const midLevelPatterns = [
    /^CIRCULANTE$/i,
    /^N[AÃ]O\s*CIRCULANTE$/i,
    /^ATIVO\s*CIRCULANTE$/i,
    /^ATIVO\s*N[AÃ]O\s*CIRCULANTE$/i,
    /^PASSIVO\s*CIRCULANTE$/i,
    /^PASSIVO\s*N[AÃ]O\s*CIRCULANTE$/i,
    /^PATRIM[OÔ]NIO\s*L[IÍ]QUIDO$/i,
    /^REALIZ[AÁ]VEL\s*A?\s*LONGO\s*PRAZO$/i,
  ];

  const sectionStack: string[] = [];

  for (const l of linhas) {
    const name = l.conta.replace(/\s*R\$\s*$/, "").trim();
    const isTopLevel = topLevelPatterns.some(p => p.test(name));
    const isMidLevel = midLevelPatterns.some(p => p.test(name));

    if (isTopLevel) {
      sectionStack.length = 0;
      sectionStack.push(name);
    } else if (isMidLevel) {
      // Keep top-level parent, replace mid-level
      if (sectionStack.length > 1) sectionStack.length = 1;
      sectionStack.push(name);
    } else if (sectionStack.length > 0) {
      l.contexto = sectionStack.join(" > ");
    }
  }
}

function cleanValue(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === "number") return val;
  const raw = String(val).trim();
  // Negativo contábil entre parênteses: "(1.234,56)" / "(1.234,56 )" (células de
  // balancete/Excel). Detecta antes de remover os parênteses na limpeza abaixo.
  const isNeg = raw.startsWith("(") || raw.endsWith(")");
  const str = raw
    .replace(/\./g, "")   // remove separador de milhar BR
    .replace(",", ".")    // converte decimal BR
    .replace(/[^0-9.\-]/g, "");
  const num = parseFloat(str);
  if (isNaN(num)) return null;
  return isNeg ? -Math.abs(num) : num;
}

export function parseExcel(buffer: Buffer, tipo: string): ParsedDocument {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    blankrows: false,
  });

  // Detecta a linha de cabeçalho (que contém os períodos/meses)
  // Suporta variações de ERPs: TOTVS, SAP, Omie, Conta Azul, etc.
  let headerRowIdx = -1;
  let periodos: string[] = [];
  let contaColIdx = 0; // Coluna onde estão os nomes das contas
  let codeColIdx = -1; // Coluna com código hierárquico (ex: "1.01.01")

  // Padrão para detectar coluna de código hierárquico no header
  const codeHeaderPattern = /^(c[oó]digo|code|cod\.?|cta\.?|conta\s*cont[aá]bil|classif\.?|reduzido)$/i;
  // Padrão para detectar conteúdo de código hierárquico em células de dados
  const codeContentPattern = /^\d+(\.\d+)+$/; // "1.01", "1.01.01", "2.03.01"

  // Padrões de período: meses abreviados, datas completas, trimestres, anos, "Saldo"
  const periodPattern = /jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez|20\d\d|q[1-4]|trim|semest|\d{2}\/\d{2}\/\d{4}|\d{2}\/\d{4}|saldo|acumulado|realizado|orçado|orcado|budget|forecast|anterior|atual/i;

  // Padrões para detectar coluna de nome de conta
  const contaHeaderPattern = /^(conta|descri[çc][ãa]o|nome|rubrica|item|classifica[çc][ãa]o|plano\s*de\s*contas)$/i;

  // Scan first 20 rows (some ERPs have metadata before header)
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    const row = rows[i] as unknown[];
    if (!row || row.length < 2) continue;

    // Count how many cells match period patterns
    const periodCells: { idx: number; val: string }[] = [];
    for (let j = 0; j < row.length; j++) {
      const cell = row[j];
      if (cell && periodPattern.test(String(cell))) {
        periodCells.push({ idx: j, val: String(cell) });
      }
    }

    // Also check for "Conta"/"Descrição" header to identify conta column
    // and "Código" header to identify code column
    for (let j = 0; j < row.length; j++) {
      const cell = row[j];
      if (!cell) continue;
      const cellStr = String(cell).trim();
      if (contaHeaderPattern.test(cellStr)) {
        contaColIdx = j;
      }
      if (codeHeaderPattern.test(cellStr)) {
        codeColIdx = j;
      }
    }

    // Need at least 1 period match (some files have single period)
    if (periodCells.length >= 1) {
      // If we found 2+, we're confident this is the header
      // If only 1, check if the row also has a "conta" type header
      if (periodCells.length >= 2 || (periodCells.length === 1 && row.length <= 4)) {
        headerRowIdx = i;
        // Build periodos from all cells, excluding conta and code columns
        periodos = [];
        for (let j = 0; j < row.length; j++) {
          if (j === contaColIdx || j === codeColIdx) continue;
          const cell = row[j];
          if (cell) {
            const str = String(cell).trim();
            if (str) periodos.push(str);
          }
        }
        break;
      }
    }

    // Fallback: detect header rows that have serial date numbers (Excel date format)
    // Excel stores dates as numbers (e.g., 45292 = 2024-01-01)
    const numericCells = row.slice(1).filter(
      (v) => typeof v === "number" && v > 40000 && v < 50000
    );
    if (numericCells.length >= 2) {
      headerRowIdx = i;
      periodos = row.slice(contaColIdx + 1).map((v) => {
        if (typeof v === "number" && v > 40000 && v < 50000) {
          // Convert Excel serial date to readable period
          const date = new Date((v - 25569) * 86400 * 1000);
          const month = date.toLocaleString("pt-BR", { month: "short" });
          const year = date.getFullYear();
          return `${month}/${year}`;
        }
        return v ? String(v) : "";
      }).filter(Boolean);
      break;
    }
  }

  // If no header found via pattern matching, try fallback: first row with text in col 0 and numbers in col 1+
  if (headerRowIdx === -1) {
    headerRowIdx = 0;
    // Use generic period labels
    if (rows.length > 0) {
      const firstRow = rows[0] as unknown[];
      periodos = firstRow.slice(1).map((v, i) => v ? String(v) : `P${i + 1}`).filter(Boolean);
    }
  }

  // Auto-detect code column from data content if not found in header
  // Scan a few data rows to see if any column consistently has hierarchical codes
  if (codeColIdx === -1 && headerRowIdx >= 0) {
    const sampleEnd = Math.min(headerRowIdx + 10, rows.length);
    const codeHits: Record<number, number> = {};
    for (let i = headerRowIdx + 1; i < sampleEnd; i++) {
      const row = rows[i] as unknown[];
      if (!row) continue;
      for (let j = 0; j < Math.min(row.length, 3); j++) { // only check first 3 columns
        const cell = row[j];
        if (cell && codeContentPattern.test(String(cell).trim())) {
          codeHits[j] = (codeHits[j] || 0) + 1;
        }
      }
    }
    // If a column has 3+ code-like values, it's the code column
    for (const [col, count] of Object.entries(codeHits)) {
      if (count >= 3) {
        codeColIdx = parseInt(col);
        break;
      }
    }
  }

  // Section group detection patterns for BP documents
  const sectionGroupPatterns: Array<{ pattern: RegExp; grupo: string }> = [
    { pattern: /^ativo\s*circulante$/i, grupo: "AC" },
    { pattern: /^a\s*t\s*i\s*v\s*o\s+c\s*i\s*r\s*c\s*u\s*l\s*a\s*n\s*t\s*e$/i, grupo: "AC" },
    { pattern: /^ativo\s*n[aã]o\s*circulante$/i, grupo: "ANC" },
    { pattern: /^ativo\s*permanente$/i, grupo: "ANC" },
    { pattern: /^realiz[aá]vel\s*a?\s*longo\s*prazo$/i, grupo: "ANC" },
    { pattern: /^passivo\s*circulante$/i, grupo: "PC" },
    { pattern: /^p\s*a\s*s\s*s\s*i\s*v\s*o\s+c\s*i\s*r\s*c\s*u\s*l\s*a\s*n\s*t\s*e$/i, grupo: "PC" },
    { pattern: /^passivo\s*n[aã]o\s*circulante$/i, grupo: "PNC" },
    { pattern: /^exig[ií]vel\s*a?\s*longo\s*prazo$/i, grupo: "PNC" },
    { pattern: /^passivo\s*exig[ií]vel\s*a?\s*longo\s*prazo$/i, grupo: "PNC" },
    { pattern: /^patrim[oô]nio\s*l[ií]quido$/i, grupo: "PL" },
  ];

  function detectGrupoFromName(name: string): string | undefined {
    const trimmed = name.trim();
    for (const { pattern, grupo } of sectionGroupPatterns) {
      if (pattern.test(trimmed)) return grupo;
    }
    return undefined;
  }

  function grupoFromCode(code: string): string | undefined {
    if (code.startsWith("1.01")) return "AC";
    if (code.startsWith("1.02")) return "ANC";
    if (code.startsWith("1")) return undefined; // AT — too broad
    if (code.startsWith("2.01")) return "PC";
    if (code.startsWith("2.02")) return "PNC";
    if (code.startsWith("2.03")) return "PL";
    return undefined;
  }

  const linhas: ExtractedRow[] = [];
  let currentGrupo: string | undefined = undefined;

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i] as unknown[];
    if (!row || row.length === 0) continue;

    const conta = String(row[contaColIdx] ?? "").trim();
    if (!conta || conta.length < 2) continue;
    // Skip pure numeric "conta" names (likely row numbers or codes without names)
    if (/^\d+$/.test(conta)) continue;

    // Extract hierarchical code if code column was detected
    let code: string | undefined;
    if (codeColIdx >= 0) {
      const codeCell = row[codeColIdx];
      if (codeCell && codeContentPattern.test(String(codeCell).trim())) {
        code = String(codeCell).trim();
      }
    }

    // Detect section group: from code first, then from account name
    const grupoFromCodeVal = code ? grupoFromCode(code) : undefined;
    const detectedGrupo = grupoFromCodeVal || detectGrupoFromName(conta);
    if (detectedGrupo) {
      currentGrupo = detectedGrupo;
    }

    // Skip accounts deeper than level 3 when code is available
    if (code) {
      const depth = code.split(".").length;
      if (depth > 3) continue;
    }

    const valores: Record<string, number> = {};
    let valIdx = 0;
    for (let j = 0; j < row.length; j++) {
      if (j === contaColIdx || j === codeColIdx) continue; // skip conta and code columns
      const periodo = periodos[valIdx];
      const num = cleanValue(row[j]);
      if (periodo && num !== null) valores[periodo] = num;
      valIdx++;
    }

    if (Object.keys(valores).length > 0) {
      linhas.push({ conta, valores, code, grupo: currentGrupo });
    }
  }

  // Gera representação textual para o Claude
  const header = ["Conta", ...periodos].join(" | ");
  const separator = "---";
  const dataRows = linhas.map((l) => {
    const vals = periodos.map((p) => {
      const v = l.valores[p];
      return v !== undefined ? v.toLocaleString("pt-BR") : "-";
    });
    return [l.conta, ...vals].join(" | ");
  });
  const raw = [tipo, header, separator, ...dataRows].join("\n");

  buildHierarchyContext(linhas);
  return { tipo, linhas, periodos, raw };
}

/**
 * Remove detail (child) rows from extracted data by detecting parent-child
 * relationships via value sums. If row[i]'s value equals the sum of the next
 * N consecutive rows, those N rows are children and are removed.
 *
 * Multi-pass: each pass removes one level of children. Repeats until stable.
 * This handles nested hierarchies (e.g., level 5 children removed in pass 1,
 * level 4 children removed in pass 2, leaving only levels 1-3).
 *
 * Used for PDFs without hierarchical account codes, where indentation is not
 * preserved by the PDF parser.
 */
function removeChildRowsByValueSum(rows: ExtractedRow[], periodos: string[]): ExtractedRow[] {
  // Use the first period's value for sum comparison
  const periodo = periodos[0];
  if (!periodo) return rows;

  // Limit passes to 2: each pass removes one level of children.
  // With 2 passes we collapse levels 5→4 then 4→3, keeping levels 1-3.
  // More passes would over-filter, removing level 2-3 accounts too.
  const MAX_PASSES = 2;

  let current = rows;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    const kept: ExtractedRow[] = [];
    let i = 0;

    while (i < current.length) {
      const parentVal = current[i].valores[periodo];
      if (parentVal === undefined || parentVal === 0) {
        kept.push(current[i]);
        i++;
        continue;
      }

      // Try to find consecutive children whose sum equals this row's value
      let sum = 0;
      let childEnd = -1;
      for (let j = i + 1; j < current.length; j++) {
        const childVal = current[j].valores[periodo];
        if (childVal === undefined) break; // gap in data → stop
        sum += childVal;

        // Check if sum matches parent (tolerance: 0.5% or 1.0, whichever is larger)
        const tolerance = Math.max(Math.abs(parentVal) * 0.005, 1.0);
        if (Math.abs(sum - parentVal) < tolerance) {
          childEnd = j;
          break;
        }

        // If sum far exceeds parent, stop looking
        if (Math.abs(sum) > Math.abs(parentVal) * 2) break;
      }

      if (childEnd >= 0 && childEnd > i) {
        // Keep parent, skip children
        kept.push(current[i]);
        i = childEnd + 1;
        changed = true;
      } else {
        kept.push(current[i]);
        i++;
      }
    }

    current = kept;
    if (!changed) break; // stable — no more children to remove
  }

  return current;
}

/**
 * OCR fallback for PDFs where text is rendered as vector paths (not as text objects).
 * Uses Claude's document vision API to read the PDF content.
 * Returns the text as Claude sees it, suitable for feeding into the extraction pipeline.
 */
async function ocrPDFWithClaude(buffer: Buffer, tipo: string): Promise<string> {
  const client = new Anthropic({ apiKey: env.anthropicApiKey });
  const base64 = buffer.toString("base64");

  const tipoLabel = tipo.toLowerCase().includes("dre") || tipo.toLowerCase().includes("demonstra")
    ? "Demonstração do Resultado do Exercício (DRE)"
    : tipo.toLowerCase().includes("balan")
      ? "Balanço Patrimonial"
      : tipo;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 8192,
    messages: [{
      role: "user",
      content: [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: base64,
          },
        },
        {
          type: "text",
          text: `Transcreva TODOS os dados numéricos desta ${tipoLabel}.

FORMATO OBRIGATÓRIO — uma linha por conta:
NOME DA CONTA    123.456.789,01

REGRAS CRÍTICAS:
1. Preserve a indentação/hierarquia do documento original usando espaços iniciais
2. Remova prefixos como (=), (-), (+) antes do nome da conta
3. TODAS as contas que possuem valor numérico devem aparecer, sem exceção
4. Use formato brasileiro: 1.234.567,89 (ponto = milhar, vírgula = decimal)
5. Valores negativos entre parênteses: (1.234,56)
6. Na PRIMEIRA linha, escreva o período encontrado no documento, ex: "Período: 01/01/2024 a 31/12/2024"
7. NÃO adicione explicações, cabeçalhos extras, linhas em branco, ou markdown
8. NÃO omita nenhuma conta — transcreva ABSOLUTAMENTE TODAS as linhas com valores`,
        },
      ],
    }],
  });

  return message.content[0].type === "text" ? message.content[0].text : "";
}

export async function parsePDF(buffer: Buffer, tipo: string, filename?: string): Promise<ParsedDocument> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse");

  // Custom page renderer that preserves real x-coordinates as indentation.
  // pdf-parse's default renderer strips all whitespace/positioning,
  // making it impossible to detect account hierarchy from indentation.
  // By using pdfjs-dist's getTextContent() API, we extract each text item's
  // x-coordinate (transform[4]) and convert it to leading spaces.
  const renderPage = async (pageData: any) => {
    const content = await pageData.getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false,
    });
    const items = content.items as Array<{ str: string; transform: number[]; width?: number }>;
    if (!items || items.length === 0) return "";

    // Group text items by y-coordinate (same visual line).
    // Round y to nearest 4 units (±2 tolerance) to merge items on the same line.
    // Store width for gap-based joining.
    const lineMap = new Map<number, Array<{ str: string; x: number; width: number }>>();
    for (const item of items) {
      if (!item.str || !item.str.trim()) continue;
      if (!item.transform || item.transform.length < 6) continue;
      const x = Math.round(item.transform[4]);
      const y = Math.round(item.transform[5]);
      const yKey = Math.round(y / 4) * 4;
      if (!lineMap.has(yKey)) lineMap.set(yKey, []);
      lineMap.get(yKey)!.push({ str: item.str, x, width: item.width || 0 });
    }

    // Find minimum x across all text items (= left margin of this page)
    let minPageX = Infinity;
    for (const lineItems of lineMap.values()) {
      for (const item of lineItems) {
        if (item.x < minPageX) minPageX = item.x;
      }
    }
    if (minPageX === Infinity) minPageX = 0;

    // Estimate average character width from all items on the page
    let totalWidth = 0;
    let totalChars = 0;
    for (const lineItems of lineMap.values()) {
      for (const item of lineItems) {
        if (item.width > 0 && item.str.length > 0) {
          totalWidth += item.width;
          totalChars += item.str.length;
        }
      }
    }
    const avgCharWidth = totalChars > 0 ? totalWidth / totalChars : 5;

    // Sort lines top-to-bottom (descending y in PDF coordinate system)
    const sortedLines = [...lineMap.entries()].sort((a, b) => b[0] - a[0]);

    const textLines: string[] = [];
    for (const [, lineItems] of sortedLines) {
      lineItems.sort((a, b) => a.x - b.x);

      // Gap-based joining: only add spaces when there's a real visual gap
      // between text items. For monospace PDFs where each character is a
      // separate item, this prevents "C I R C U L A N T E" artifacts.
      let lineText = "";
      for (let idx = 0; idx < lineItems.length; idx++) {
        if (idx > 0) {
          const prev = lineItems[idx - 1];
          const prevCharW = prev.width > 0 && prev.str.length > 0
            ? prev.width / prev.str.length
            : avgCharWidth;
          const prevEnd = prev.x + (prev.width > 0 ? prev.width : prev.str.length * prevCharW);
          const gap = lineItems[idx].x - prevEnd;

          if (gap > prevCharW * 1.5) {
            // Real visual gap — add proportional spaces
            const numSpaces = Math.max(1, Math.round(gap / prevCharW));
            lineText += " ".repeat(numSpaces);
          }
          // Small or no gap: items are touching — join directly without space
        }
        lineText += lineItems[idx].str;
      }

      // Leading indent based on first item's x-offset from page margin
      const relativeX = Math.max(0, lineItems[0].x - minPageX);
      const indentSpaces = Math.round(relativeX / Math.max(avgCharWidth, 1));
      textLines.push(" ".repeat(indentSpaces) + lineText);
    }

    return textLines.join("\n");
  };

  // --- Triple rendering strategy ---
  // 1. Try custom renderer (preserves indentation for depth filtering)
  // 2. If custom fails, try default pdf-parse renderer
  // 3. If both return empty text (vector-path PDFs), use Claude OCR
  const customData = await pdfParse(buffer, { pagerender: renderPage });
  const customText = customData.text as string;

  // Validate: count BR numbers (e.g. "316.245.714,23") in custom text
  const brNumberCount = (customText.match(/\d[\d.]*,\d{2}/g) || []).length;

  let text: string;
  if (brNumberCount >= 3) {
    text = customText;
  } else {
    // Custom renderer failed — try default
    const defaultData = await pdfParse(buffer);
    const defaultText = (defaultData.text as string).trim();

    if (defaultText.length >= 20) {
      text = defaultText;
    } else {
      // Both renderers returned empty/minimal text.
      // PDF likely uses vector paths instead of text objects (common in some
      // Brazilian accounting software). Fall back to Claude vision OCR.
      text = await ocrPDFWithClaude(buffer, tipo);
    }
  }

  // Detect periods from text (com o nome do arquivo como dica autoritativa no fallback)
  const periodos = detectPeriodsFromPDF(text, filename);

  // --- Extraction pipeline ---
  // Try structured extraction first (multi-column PDF with separated names/values)
  let linhas = extractMultiColumnPDF(text, periodos);

  // If multi-column extraction didn't work well, fall back to single-line extraction
  if (linhas.length === 0) {
    linhas = extractInlinePDF(text, periodos);
  }

  // Fall back to legacy single-value extraction
  if (linhas.length === 0) {
    linhas = extractStructuredLines(text);
    // Assign period
    const periodo = periodos[0] || "";
    if (periodo && linhas.length > 0) {
      for (const l of linhas) {
        const keys = Object.keys(l.valores);
        if (keys.length === 1 && keys[0] === "_val") {
          l.valores[periodo] = l.valores["_val"];
          delete l.valores["_val"];
        }
      }
    }
  }

  // Fall back to block correlation (multi-column PDFs without account codes, e.g. DRE)
  if (linhas.length === 0) {
    linhas = extractBlockCorrelation(text, periodos);
  }

  // Fallback for PDFs without hierarchical codes AND where indent detection
  // didn't produce a hierarchy (e.g., all items at same x-coordinate):
  // use value-sum parent-child detection to remove detail rows.
  // IMPORTANT: Only apply to Balance Sheet (BP), NOT to DRE/Income Statement.
  // DRE sub-accounts (Receita Bruta, Deduções, etc.) legitimately sum to
  // parent totals but are NOT redundant — they're all needed for analysis.
  const isDRE = tipo.toLowerCase().includes("dre") ||
    tipo.toLowerCase().includes("demonstra") ||
    tipo.toLowerCase().includes("resultado");
  const hasAnyCodes = linhas.some(l => l.code);
  const hasIndentHierarchy = (() => {
    const uniqueIndents = new Set(linhas.map(l => l.indent ?? 0));
    return uniqueIndents.size >= 3;
  })();
  if (!isDRE && !hasAnyCodes && !hasIndentHierarchy && linhas.length > 3) {
    linhas = removeChildRowsByValueSum(linhas, periodos);
  }

  // Gera raw text — sempre inclui o texto original para o Claude
  const raw = `${tipo}\n${text.slice(0, 8000)}`;

  // Colapsa abertura+fechamento (ECF/ECD/SPED) para o saldo de FECHAMENTO.
  const periodosFinal = collapseOpeningClosing(periodos, linhas);

  buildHierarchyContext(linhas);
  return { tipo, linhas, periodos: periodosFinal, raw };
}

/**
 * Detect financial periods from PDF text. Returns sorted period strings.
 * Prioritizes authoritative patterns ("Encerrado em", "Saldo período")
 * and excludes print/generation dates ("Data:", "Hora:").
 */
/** Ano do nome do arquivo (ex.: "B&You_DRE_2018.pdf" → "2018"), só quando inequívoco
 *  (exatamente um ano plausível). É o sinal mais confiável quando o texto não traz
 *  uma data autoritativa — DREs/PDFs combinados costumam não declarar o período. */
export function yearFromFilename(filename?: string): string | null {
  if (!filename) return null;
  const base = filename.replace(/\.[^.]+$/, "");
  const distinct = [...new Set([...base.matchAll(/(?:19|20)\d{2}/g)].map((m) => m[0]))]
    .filter((y) => { const n = parseInt(y); return n >= 2000 && n <= 2035; });
  return distinct.length === 1 ? distinct[0] : null;
}

export function detectPeriodsFromPDF(text: string, filename?: string): string[] {
  const periods = new Set<string>();
  const fy = yearFromFilename(filename);

  // 1. Priority: "Encerrado em DD/MM/YYYY" — authoritative period marker
  const encerradoMatches = text.matchAll(/[Ee]ncerrad[oa]\s+em[:\s]+(\d{2}\/\d{2}\/\d{4})/g);
  for (const m of encerradoMatches) {
    periods.add(m[1]);
  }

  // 2. "Saldo período DD/MM/YYYY" — column header pattern
  const saldoMatches = text.matchAll(/[Ss]aldo\s+per[ií]odo\s*[\n\s]*(\d{2}\/\d{2}\/\d{4})/g);
  for (const m of saldoMatches) {
    periods.add(m[1]);
  }

  if (periods.size >= 1) {
    return sortPeriods(periods);
  }

  // 2.5. Written dates: "31 DE DEZEMBRO DE 2024", "31 de dezembro de 2024"
  // Common in Brazilian ERP-generated PDFs (Domínio, Alterdata, etc.)
  const monthMap: Record<string, string> = {
    janeiro: "01", fevereiro: "02", marco: "03", "março": "03",
    abril: "04", maio: "05", junho: "06",
    julho: "07", agosto: "08", setembro: "09",
    outubro: "10", novembro: "11", dezembro: "12",
  };
  const writtenDatePattern = /(\d{1,2})\s+[Dd][Ee]\s+([A-Za-zÀ-ú]+)\s+[Dd][Ee]\s+(\d{4})/g;
  for (const m of text.matchAll(writtenDatePattern)) {
    const month = monthMap[m[2].toLowerCase()];
    if (month) {
      periods.add(`${m[1].padStart(2, "0")}/${month}/${m[3]}`);
    }
  }
  if (periods.size >= 1) {
    return sortPeriods(periods);
  }

  // 3. Fallback FRACO: datas/anos soltos. Aqui o texto é pouco confiável (datas de
  //    leis/parcelamentos/print confundem), então o ANO DO NOME DO ARQUIVO, quando
  //    existir, é autoritativo NESTE nível — nunca sobre "Encerrado em"/"Saldo período"
  //    (que retornaram acima). Resolve DRE/PDF combinado sem período declarado.
  const candidates: string[] = [];
  for (const m of text.matchAll(/(\d{2}\/\d{2}\/(20\d{2}))/g)) candidates.push(m[1]);

  // Exclui datas de impressão/geração (Data:, Gerado, Impresso, Hora)
  const printDates = new Set<string>();
  for (const m of text.matchAll(/(?:Data|Gerado|Impresso|Hora)[:\s]*\d{2}\/\d{2}\/\d{4}/gi)) {
    const d = m[0].match(/(\d{2}\/\d{2}\/\d{4})/);
    if (d) printDates.add(d[1]);
  }
  for (const d of candidates) if (!printDates.has(d)) periods.add(d);

  // Sem data cheia → anos soltos. Faixa 2000-2039 (antes 20[2-3]\d ignorava 2016-2019).
  if (periods.size === 0) {
    for (const m of text.matchAll(/\b(20[0-3]\d)\b/g)) periods.add(m[1]);
  }

  const yearOfPeriod = (p: string) => (p.match(/(20\d{2})/) || [])[1] ?? null;

  // Ano do nome do arquivo manda no fallback: alinha às datas do texto que batem com
  // ele; se nenhuma bate (ou o texto está vazio), o nome vence o ano espúrio.
  if (fy) {
    const matchFy = [...periods].filter((p) => yearOfPeriod(p) === fy);
    if (matchFy.length) return sortPeriods(new Set(matchFy));
    return [fy];
  }

  // Sem filename: prefere fim de ano quando há ambiguidade
  if (periods.size > 1) {
    const yearEnd = new Set([...periods].filter((p) => p.startsWith("31/12/") || p.startsWith("30/12/")));
    if (yearEnd.size >= 1) return sortPeriods(yearEnd);
  }
  return periods.size ? sortPeriods(periods) : [];
}

function sortPeriods(periods: Set<string>): string[] {
  return Array.from(periods).sort((a, b) => {
    const ya = parseInt(a.slice(-4));
    const yb = parseInt(b.slice(-4));
    if (ya !== yb) return ya - yb;
    return a.localeCompare(b);
  });
}

/**
 * Saldo de ABERTURA + FECHAMENTO (ECF/ECD/SPED): docs com "Período da Escrituração
 * 01/01/AAAA a 31/12/AAAA" trazem 2 colunas (Saldo Inicial | Saldo Final) e o parser
 * detecta 2 períodos do MESMO ano. A análise usa o FECHAMENTO (data maior):
 * - BP: valor nas 2 colunas → preferimos o fechamento (saldo final real);
 * - DRE: o resultado do ano vem só na 1ª chave (abertura) → movemos pro fechamento.
 * Colapsa os 2 períodos em 1 (o de data maior). Gate: exatamente 2 datas cheias, mesmo
 * ano, e a menor com dia "01" (início de período) — evita colapsar comparativo real
 * (ex.: 30/06 vs 31/12) ou anos diferentes (31/12/2021 vs 31/12/2022).
 */
export function collapseOpeningClosing(periodos: string[], linhas: ExtractedRow[]): string[] {
  if (periodos.length !== 2) return periodos;
  const isFullDate = (p: string) => /^\d{2}\/\d{2}\/\d{4}$/.test(p);
  if (!periodos.every(isFullDate)) return periodos;
  if (periodos[0].slice(-4) !== periodos[1].slice(-4)) return periodos; // anos diferentes = comparativo
  const toNum = (p: string) => { const [d, m, y] = p.split("/"); return +`${y}${m}${d}`; };
  const [opening, closing] = [...periodos].sort((a, b) => toNum(a) - toNum(b));
  if (opening === closing || opening.slice(0, 2) !== "01") return periodos; // abertura = início de período
  for (const l of linhas) {
    const v = l.valores[closing] !== undefined ? l.valores[closing] : l.valores[opening];
    const novo: Record<string, number> = {};
    for (const [k, val] of Object.entries(l.valores)) if (k !== opening && k !== closing) novo[k] = val;
    if (v !== undefined) novo[closing] = v;
    l.valores = novo;
  }
  return [closing];
}

/**
 * Parse Brazilian number format: "1.234.567,89" or "(1.234.567,89)" for negative
 */
export function parseBRNumber(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;

  // Negativo entre parênteses: "(1.234,56)" ou "(1.234,56 )". Basta UM parêntese
  // (abertura OU fechamento) — convenção contábil. Robusto a captura imperfeita quando
  // há espaço interno, evitando ler um valor negativo (ex.: PL/prejuízos) como positivo.
  const isNeg = trimmed.startsWith("(") || trimmed.endsWith(")");
  const clean = trimmed
    .replace(/[()]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const num = parseFloat(clean);
  if (isNaN(num)) return null;
  return isNeg ? -num : num;
}

/**
 * Extract data from multi-column PDFs where account names and values
 * are in separate blocks (common in Brazilian accounting software PDFs).
 *
 * These PDFs have structure like:
 * Page 1: Values block (just numbers), then Names block (code + name)
 * Header somewhere with "Saldo período 31/12/2023" etc.
 */
function extractMultiColumnPDF(text: string, periodos: string[]): ExtractedRow[] {
  const lines = text.split("\n");
  if (periodos.length < 1) return [];

  // Detect if this is a multi-column PDF by looking for the pattern:
  // Lines with ONLY numbers (value pairs) followed by lines with account codes
  const accountCodeRegex = /^\s*\d+\s+[\d.]+\s+(.+)$/; // e.g., "1067 1.02.03 IMOBILIZADO"
  const valueLineRegex = /^[\s(]*-?[\d.]+,\d{2}/; // starts with a BR number

  const valueLines: string[] = [];
  const nameLines: Array<{ code: string; name: string; indent: number }> = [];
  let hasCodeLines = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check if it's an account code line (e.g., "1067 1.02.03 IMOBILIZADO")
    const codeMatch = trimmed.match(/^\s*(\d+)\s+([\d.]+)\s+(.+)$/);
    if (codeMatch) {
      hasCodeLines = true;
      const indent = line.length - line.trimStart().length;
      nameLines.push({
        code: codeMatch[2],
        name: codeMatch[3].trim(),
        indent,
      });
    } else {
      // Also match "NNNN TEXT" format without hierarchical code (e.g., "1000 A T I V O", "2000 P A S S I V O")
      const simpleCodeMatch = trimmed.match(/^\s*(\d{3,5})\s+([A-ZÀ-Ú][A-ZÀ-Ú\s]+)$/);
      if (simpleCodeMatch) {
        hasCodeLines = true;
        const rawId = parseInt(simpleCodeMatch[1]);
        // Synthesize hierarchical code from raw ID: 1000 → "1", 2000 → "2"
        const syntheticCode = String(Math.floor(rawId / 1000));
        const indent = line.length - line.trimStart().length;
        nameLines.push({
          code: syntheticCode,
          name: simpleCodeMatch[2].trim(),
          indent,
        });
      }
    }
  }

  if (!hasCodeLines || nameLines.length < 5) return [];

  // This IS a multi-column PDF. Now we need to collect value blocks and correlate.
  // The approach: find value-only lines between headers and name blocks,
  // then reverse-map to names based on the hierarchical order.

  // The names come in REVERSE order in the PDF (bottom-to-top within each page).
  // We need to reverse them to get top-to-bottom order.
  // But they're also grouped by page, so we need to handle page breaks.

  // Simpler approach: Parse account hierarchy from code numbers and build the structure.
  // The code numbers tell us the hierarchy (1.01 > 1.01.01 > 1.01.01.01).
  // Sort by code number to get the correct order.
  nameLines.sort((a, b) => {
    const aParts = a.code.split(".").map(Number);
    const bParts = b.code.split(".").map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const av = aParts[i] ?? 0;
      const bv = bParts[i] ?? 0;
      if (av !== bv) return av - bv;
    }
    return 0;
  });

  // Now collect all value-pair lines (lines with 2+ BR numbers and no letters)
  // These are blocks of pure numbers between page headers
  type ValuePair = number[];
  const allValueBlocks: ValuePair[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip non-value lines
    if (/[a-zA-ZÀ-ú]/.test(trimmed)) continue;

    // Extract all BR numbers from this line
    const numbers: number[] = [];
    // Match: optional negative sign or parens, digits with dots, comma, 2 decimal digits
    const numMatches = trimmed.matchAll(/(\(?\-?[\d.]+,\d{2}\)?)/g);
    for (const m of numMatches) {
      const n = parseBRNumber(m[1]);
      if (n !== null) numbers.push(n);
    }

    if (numbers.length >= 1) {
      allValueBlocks.push(numbers);
    }
  }

  // Now we need to correlate value blocks with name lines.
  // In multi-column PDFs, the number of value lines per page should match
  // the number of name lines. But names may span multiple pages.
  // The simplest heuristic: if nameLines.length == allValueBlocks.length, direct mapping.

  if (nameLines.length === 0 || allValueBlocks.length === 0) return [];

  // If counts match (or close), map 1:1
  const result: ExtractedRow[] = [];

  if (Math.abs(nameLines.length - allValueBlocks.length) <= 3) {
    // Direct 1:1 mapping
    const count = Math.min(nameLines.length, allValueBlocks.length);
    for (let i = 0; i < count; i++) {
      const name = nameLines[i];
      const vals = allValueBlocks[i];

      // Skip accounts deeper than level 3
      const depth = name.code.split(".").length;
      if (depth > 3) continue;

      const valores: Record<string, number> = {};

      // Map values to periods
      for (let j = 0; j < Math.min(vals.length, periodos.length); j++) {
        valores[periodos[j]] = vals[j];
      }

      if (Object.keys(valores).length > 0) {
        // Derive grupo from hierarchical code
        let grupo: string | undefined;
        if (name.code.startsWith("1.01")) grupo = "AC";
        else if (name.code.startsWith("1.02")) grupo = "ANC";
        else if (name.code.startsWith("2.01")) grupo = "PC";
        else if (name.code.startsWith("2.02")) grupo = "PNC";
        else if (name.code.startsWith("2.03")) grupo = "PL";
        result.push({ conta: name.name, valores, code: name.code, indent: name.indent, grupo });
      }
    }
  } else {
    // Counts don't match — this is common when value blocks include subtotals
    // that don't have corresponding name lines, or vice versa.
    // Fall back to inline extraction.
    return [];
  }

  return result;
}

/**
 * Extract data from PDFs where account name and values are on the same line,
 * but concatenated without spaces.
 * Example: "RECEITA BRUTA DE VENDAS E SERVIÇOS105.491.499,80109.689.157,06"
 */
function extractInlinePDF(text: string, periodos: string[]): ExtractedRow[] {
  const lines = text.split("\n");
  const rawRows: Array<{ conta: string; valores: Record<string, number>; indent: number }> = [];

  // Skip patterns
  const skipPatterns = /^(FOLHA|Data|Hora|Consolidação|Grau|Reconhecemos|CPF|CRC|ADMINISTRADOR|TÉCNICO|ANTONIO|JOSE CARLOS|ROBERTO|MARCO|Diretor|Contador|INSCR|LACTOBOM|DEMONSTRATIVO|BALANCO|Conta\d|ContaSaldo)/i;

  // BR number pattern: optional parens/negative, digits with dots, comma, 2 decimals.
  // `\s*` antes do `\)?` porque alguns balancetes escrevem o negativo como "(1.234,56 )"
  // — com espaço antes do parêntese de fechamento. Sem isso o ")" não era capturado e
  // o valor (ex.: PL negativo) era lido como POSITIVO (ver parseBRNumber).
  const brNumPattern = /\(?-?[\d.]+,\d{2}\s*\)?/g;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 3) continue;
    if (skipPatterns.test(trimmed)) continue;

    // Capture indentation (leading spaces) for hierarchy detection
    const indent = line.length - line.trimStart().length;

    // Find all BR numbers in the line
    const numMatches = [...trimmed.matchAll(brNumPattern)];
    if (numMatches.length === 0) continue;

    // Extract account name: everything before the first number
    const firstNumIdx = numMatches[0].index!;
    let conta = trimmed.slice(0, firstNumIdx).trim();

    // Remove DRE prefix markers: (=), (-), (+), (-)  etc.
    conta = conta.replace(/^\s*\(?[=\-+]\)?\s*/, "").trim();

    // Skip lines that are just numbers (no account name)
    if (!conta || conta.length < 2) continue;
    // Skip lines where "conta" is itself a number-like string
    if (/^[\d.,\-()]+$/.test(conta)) continue;
    // Skip header/footer lines
    if (/^(CNPJ|Toledo|72\.\d)/i.test(conta)) continue;

    // Parse all numbers from the line
    const values: number[] = [];
    for (const m of numMatches) {
      const n = parseBRNumber(m[0]);
      if (n !== null) values.push(n);
    }

    if (values.length === 0) continue;

    // Map values to periods
    const valores: Record<string, number> = {};
    if (values.length >= 2 && periodos.length >= 2) {
      // Multi-period: map each value to its period
      for (let i = 0; i < Math.min(values.length, periodos.length); i++) {
        valores[periodos[i]] = values[i];
      }
    } else if (values.length === 1 && periodos.length >= 1) {
      // Single value: assign to first period
      valores[periodos[0]] = values[0];
    } else if (values.length === 1) {
      // No detected period, use placeholder
      valores["_val"] = values[0];
    } else if (values.length >= 2 && periodos.length === 1) {
      // Multiple values but only one period known — use first value
      valores[periodos[0]] = values[0];
    } else {
      // Multiple values but no period info — use index
      values.forEach((v, i) => {
        valores[`P${i + 1}`] = v;
      });
    }

    rawRows.push({ conta, valores, indent });
  }

  // Derive hierarchy depth from indentation levels.
  // PDFs without account codes use indentation to express hierarchy:
  //   Level 1: "A T I V O" (minimal indent)
  //   Level 2: "ATIVO CIRCULANTE" (slight indent)
  //   Level 3: "DISPONIBILIDADES" (more indent)
  //   Level 4: "CAIXA" (even more)
  //   Level 5: "CAIXA MATRIZ" (most indent)
  // We collect all unique indent values, sort them, and assign depth levels.
  const uniqueIndents = [...new Set(rawRows.map(r => r.indent))].sort((a, b) => a - b);

  // Only apply indent-based filtering if we have enough distinct levels (3+)
  // This avoids false filtering on PDFs with uniform indentation.
  const hasHierarchy = uniqueIndents.length >= 3;
  const indentToDepth = new Map<number, number>();
  if (hasHierarchy) {
    for (let i = 0; i < uniqueIndents.length; i++) {
      indentToDepth.set(uniqueIndents[i], i + 1); // depth starts at 1
    }
  }

  const result: ExtractedRow[] = [];
  for (const row of rawRows) {
    const depth = indentToDepth.get(row.indent);
    // Filter out depth > 3 when hierarchy is detected
    if (hasHierarchy && depth && depth > 3) continue;

    result.push({ conta: row.conta, valores: row.valores, indent: row.indent });
  }

  return result;
}

/**
 * Legacy: Extrai linhas estruturadas de um PDF financeiro brasileiro.
 * Formato esperado: CONTA_NAME    VALOR (ex: "ATIVO CIRCULANTE    488.441,31")
 * Retorna ExtractedRow[] com chave temporária "_val" para o valor.
 */
function extractStructuredLines(text: string): ExtractedRow[] {
  const lines = text.split("\n");
  const rawRows: Array<{ conta: string; valores: Record<string, number>; indent: number }> = [];

  // Regex para valor brasileiro no final da linha: -?123.456,78
  const valorRegex = /(-?[\d.]+,\d{2})\s*$/;

  // Linhas a ignorar (cabeçalhos, rodapés, totais de conferência)
  const skipPatterns = /^(FOLHA|Data|Hora|Consolidação|Grau|Reconhecemos|CPF|CRC|ADMINISTRADOR|TÉCNICO|ANTONIO|JOSE CARLOS)/i;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 3) continue;
    if (skipPatterns.test(trimmed)) continue;

    const match = trimmed.match(valorRegex);
    if (!match) continue;

    const indent = line.length - line.trimStart().length;

    // Extrai o nome da conta (tudo antes do valor)
    const valorStr = match[1];
    const conta = trimmed.slice(0, trimmed.lastIndexOf(valorStr)).trim();

    if (!conta || conta.length < 2) continue;
    // Ignora linhas que parecem ser apenas números
    if (/^[\d.,\-()]+$/.test(conta)) continue;
    // Ignora linhas que parecem ser "Contabilidade Balanço Patrimonial" etc
    if (/^Contabilidade\b/i.test(conta)) continue;

    // Converte valor BR para número
    const num = parseFloat(valorStr.replace(/\./g, "").replace(",", "."));
    if (isNaN(num)) continue;

    rawRows.push({ conta, valores: { "_val": num }, indent });
  }

  // Apply indent-based depth filtering (same logic as extractInlinePDF)
  const uniqueIndents = [...new Set(rawRows.map(r => r.indent))].sort((a, b) => a - b);
  const hasHierarchy = uniqueIndents.length >= 3;
  const indentToDepth = new Map<number, number>();
  if (hasHierarchy) {
    for (let i = 0; i < uniqueIndents.length; i++) {
      indentToDepth.set(uniqueIndents[i], i + 1);
    }
  }

  const result: ExtractedRow[] = [];
  for (const row of rawRows) {
    const depth = indentToDepth.get(row.indent);
    if (hasHierarchy && depth && depth > 3) continue;
    result.push({ conta: row.conta, valores: row.valores, indent: row.indent });
  }

  return result;
}

/**
 * Extract data from multi-column PDFs where names and values are in separate
 * text blocks but WITHOUT account codes (e.g., DRE documents).
 * Falls back to correlating pure-name lines with pure-value lines by document order.
 */
function extractBlockCorrelation(text: string, periodos: string[]): ExtractedRow[] {
  const lines = text.split("\n");
  if (periodos.length < 1) return [];

  const brNumPattern = /\(?-?[\d.]+,\d{2}\)?/g;
  const skipPatterns = /^(FOLHA|Data|Hora|Consolidação|Grau|Reconhecemos|CPF|CRC|ADMINISTRADOR|TÉCNICO|ANTONIO|JOSE CARLOS|ROBERTO|MARCO|Diretor|Contador|INSCR|LACTOBOM|DEMONSTRATIVO|DEMONSTRAÇÃO|BALANCO|BALANÇO|Conta\b|ContaSaldo|CNPJ|Toledo|Assinado|72\.\d|Dados:|STENZEL|BOMBARDELLI)/i;

  // Also skip lines that look like CNPJ, CPF, CRC, or dates
  const skipExtra = /^\d{2}\.\d{3}[\.\-\/]|^CRC\b|^\d{2}\/\d{2}\/\d{4}/i;

  const nameLines: string[] = [];
  const valueBlocks: number[][] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 3) continue;
    if (skipPatterns.test(trimmed)) continue;
    if (skipExtra.test(trimmed)) continue;

    // Check if line has BR numbers
    const numMatches = [...trimmed.matchAll(brNumPattern)];
    const hasLetters = /[a-zA-ZÀ-ú]/.test(trimmed);

    if (numMatches.length >= 1 && !hasLetters) {
      // Pure value line — no letters, just numbers
      const values = numMatches.map(m => parseBRNumber(m[0])).filter((n): n is number => n !== null);
      if (values.length > 0) valueBlocks.push(values);
    } else if (hasLetters && numMatches.length === 0) {
      // Pure name line — letters but no BR numbers
      let name = trimmed;
      // Strip leading account code if present (e.g., "3001 RECEITA..." → "RECEITA...")
      name = name.replace(/^\s*\d+\s+/, "").trim();
      if (name.length >= 3 && !/^[\d.,\-()\/]+$/.test(name)) {
        nameLines.push(name);
      }
    }
    // Mixed lines (name+value on same line) are handled by extractInlinePDF — skip here
  }

  // Need enough lines to correlate and counts must roughly match
  if (nameLines.length < 3 || valueBlocks.length < 3) return [];
  if (Math.abs(nameLines.length - valueBlocks.length) > Math.max(5, Math.floor(nameLines.length * 0.2))) return [];

  const result: ExtractedRow[] = [];
  const count = Math.min(nameLines.length, valueBlocks.length);

  for (let i = 0; i < count; i++) {
    const conta = nameLines[i];
    const vals = valueBlocks[i];
    const valores: Record<string, number> = {};

    for (let j = 0; j < Math.min(vals.length, periodos.length); j++) {
      valores[periodos[j]] = vals[j];
    }

    if (Object.keys(valores).length > 0) {
      result.push({ conta, valores });
    }
  }

  return result;
}

/**
 * Converte ExtractedRow[] + periodos de volta para o formato texto
 * pipe-delimited que o Claude espera. Usado quando dados foram
 * editados manualmente e precisam ser reprocessados.
 */
export function dadosExtraidosToRaw(
  tipo: string,
  linhas: ExtractedRow[],
  periodos: string[]
): string {
  if (linhas.length === 0) return `${tipo}\n(sem dados estruturados)`;
  const header = ["Conta", ...periodos].join(" | ");
  const separator = "---";
  const dataRows = linhas.map((l) => {
    const vals = periodos.map((p) => {
      const v = l.valores[p];
      return v !== undefined ? v.toLocaleString("pt-BR") : "-";
    });
    return [l.conta, ...vals].join(" | ");
  });
  return [tipo, header, separator, ...dataRows].join("\n");
}

export async function parseDocument(
  buffer: Buffer,
  filename: string,
  tipo: string
): Promise<ParsedDocument> {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return parsePDF(buffer, tipo, filename);
  return parseExcel(buffer, tipo);
}
