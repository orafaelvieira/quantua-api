/**
 * CURADORIA ASSISTIDA no upload da Data room (pedido do usuário, 20/07/2026):
 * tipo e competência do documento não ficam só a cargo do analista — o
 * CONTEÚDO decide (o analista pode errar e poluir a Data room, que é a fonte
 * única dos produtos).
 *
 * Determinístico e best-effort — sem IA, sem custo. Regras:
 *  - Balancete tem assinatura estrutural (pareceBalancete) e o período no
 *    cabeçalho → competência MENSAL ("YYYY-MM").
 *  - BP/DRE são reconhecidos pelas mesmas palavras-assinatura do /process;
 *    períodos anuais (anos puros ou fins de exercício em dezembro) →
 *    competência de ANO FECHADO ("YYYY", exercício).
 *  - Quando o conteúdo não sustenta afirmação nenhuma, devolve null —
 *    ausência de dado nunca vira afirmação (regra da casa).
 */
import { parseDocument, extrairTextoLayoutPDF } from "./parser";
import { pareceBalancete } from "./balancete-parser";

export interface Curadoria {
  tipo: "Balancete" | "DRE" | "Balanço Patrimonial" | null;
  /** "YYYY-MM" (mensal) ou "YYYY" (exercício/ano fechado). */
  competencia: string | null;
  evidencias: string[];
}

const VAZIA: Curadoria = { tipo: null, competencia: null, evidencias: [] };

/**
 * Período declarado no cabeçalho ("Período: 01/2026 a 05/2026" ·
 * "de 01/01/2024 a 31/12/2024"). `anualVira` colapsa jan..dez do mesmo ano em
 * ano fechado (BP/DRE); balancete é artefato mensal — dezembro fica "YYYY-12".
 */
export function competenciaDoCabecalho(texto: string, anualVira: boolean): string | null {
  const cab = texto.slice(0, 3000);
  let m = cab.match(/(\d{2})\/(\d{2})\/(\d{4})\s*(?:a|à|-|ate|até)\s*\d{2}\/(\d{2})\/(\d{4})/i);
  let iniMes: number | null = null, fimMes: number | null = null, iniAno: number | null = null, fimAno: number | null = null;
  if (m) {
    iniMes = +m[2]; iniAno = +m[3]; fimMes = +m[4]; fimAno = +m[5];
  } else {
    m = cab.match(/(\d{2})\/(\d{4})\s*(?:a|à|-)\s*(\d{2})\/(\d{4})/);
    if (m) { iniMes = +m[1]; iniAno = +m[2]; fimMes = +m[3]; fimAno = +m[4]; }
  }
  if (fimMes === null || fimAno === null || fimMes < 1 || fimMes > 12) return null;
  if (anualVira && iniMes === 1 && fimMes === 12 && iniAno === fimAno) return String(fimAno);
  return `${fimAno}-${String(fimMes).padStart(2, "0")}`;
}

/** Normaliza um período do parser ("2023" · "31/12/2023" · "12/2023" · "2023-12"). */
function anoMes(p: string): { ano: number; mes: number | null } | null {
  let m = p.trim().match(/^(\d{4})$/);
  if (m) return { ano: +m[1], mes: null };
  m = p.trim().match(/^(\d{2})\/(\d{4})$/);
  if (m) return { ano: +m[2], mes: +m[1] };
  m = p.trim().match(/^\d{2}\/(\d{2})\/(\d{4})$/);
  if (m) return { ano: +m[2], mes: +m[1] };
  m = p.trim().match(/^(\d{4})-(\d{2})$/);
  if (m) return { ano: +m[1], mes: +m[2] };
  return null;
}

/**
 * Competência sugerida pelos PERÍODOS extraídos (BP/DRE tabular):
 * todos anuais (ano puro ou dezembro) → ano fechado do MAIOR ano;
 * exatamente um período mensal → aquele mês; mistura ambígua → nada.
 */
export function competenciaDosPeriodos(periodos: string[]): string | null {
  const norm = periodos.map(anoMes).filter((p): p is NonNullable<ReturnType<typeof anoMes>> => p !== null && (p.mes === null || (p.mes >= 1 && p.mes <= 12)));
  if (norm.length === 0) return null;
  if (norm.every((p) => p.mes === null || p.mes === 12)) return String(Math.max(...norm.map((p) => p.ano)));
  const mensais = norm.filter((p) => p.mes !== null && p.mes !== 12);
  if (norm.length === 1 && mensais.length === 1) {
    return `${mensais[0]!.ano}-${String(mensais[0]!.mes).padStart(2, "0")}`;
  }
  return null;
}

/** BP × DRE pelas palavras-assinatura (mesma lista content-first do /process). */
export function tipoPorKeywords(raw: string): "DRE" | "Balanço Patrimonial" | null {
  const t = raw.toLowerCase();
  const temBP = t.includes("ativo circulante") || t.includes("passivo circulante") || t.includes("a t i v o");
  const temDRE = t.includes("receita bruta") || t.includes("resultado liquido") ||
    t.includes("custo operacional") || t.includes("custo produtos vendidos") ||
    t.includes("demonstrativo de resultado") || t.includes("demonstração do resultado") ||
    t.includes("receita de vendas") || t.includes("deducoes da receita") ||
    t.includes("deduções da receita") || t.includes("despesas com vendas") ||
    t.includes("receita operacional líquida") || t.includes("custo das mercadorias");
  if (temBP && temDRE) return null; // documento composto — não se afirma um tipo só
  if (temBP) return "Balanço Patrimonial";
  if (temDRE) return "DRE";
  return null;
}

/** Núcleo PURO da curadoria: decide por texto + períodos já extraídos. */
export function curarConteudo(texto: string, periodos: string[] = []): Curadoria {
  if (!texto || texto.length < 100) return VAZIA;
  const det = pareceBalancete(texto);
  if (det.balancete) {
    return { tipo: "Balancete", competencia: competenciaDoCabecalho(texto, false), evidencias: det.evidencias };
  }
  const tipo = tipoPorKeywords(texto);
  if (!tipo) return VAZIA;
  const competencia = competenciaDosPeriodos(periodos) ?? competenciaDoCabecalho(texto, true);
  return { tipo, competencia, evidencias: [`assinatura de ${tipo} no conteúdo`] };
}

/** Wrapper de I/O: extrai o texto conforme o formato e delega ao núcleo puro. */
export async function curarUpload(buffer: Buffer, nome: string): Promise<Curadoria> {
  if (/\.pdf$/i.test(nome)) {
    const texto = await extrairTextoLayoutPDF(buffer);
    if (!texto || texto.length < 300) return VAZIA; // escaneado/sem texto
    return curarConteudo(texto);
  }
  // Planilha/CSV: o parser tabular leve dá o texto bruto e os períodos.
  const parsed = await parseDocument(buffer, nome, "Outro");
  return curarConteudo(parsed.raw, parsed.periodos);
}
