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
import * as XLSX from "xlsx";
import { parseDocument, extrairTextoLayoutPDF } from "./parser";
import { parseBalanceteTabular, ehArquivoTabular } from "./balancete-tabular";
import { pareceBalancete } from "./balancete-parser";

export interface Curadoria {
  tipo: "Balancete" | "DRE" | "Balanço Patrimonial" | null;
  /** "YYYY-MM" (mensal) ou "YYYY" (exercício/ano fechado). */
  competencia: string | null;
  /** true = a competência veio do PERÍODO DECLARADO NO DOCUMENTO (cabeçalho
   *  de balancete) — evidência forte: o upload CORRIGE a declarada divergente
   *  (com aviso), em vez de só avisar (08/08/2026, caso Belagro: CSV de
   *  01/01/2025 a 30/11/2025 subiu como 2026 e ninguém barrou). */
  competenciaForte?: boolean;
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
/** COMPETÊNCIA REAL DO BALANCETE pelo período extraído do cabeçalho
 *  (30/07/2026 — caso Belagro: "Balancete Consolidado de 01/01/2025 a
 *  30/09/2025" subiu declarado como ano fechado 2025 e o sistema aceitou).
 *  O DOCUMENTO manda: devolve "YYYY" (01/01→dez do mesmo ano), "YYYY-MM"
 *  (um mês só) ou "YYYY-MM..YYYY-MM" (ACUMULADO — mais de um mês sem fechar
 *  o ano). Datas em dd/mm/aaaa, como o parser entrega. */
export function competenciaDoPeriodoBalancete(inicio: string | null, fim: string | null): string | null {
  const pi = (inicio ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const pf = (fim ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!pf) return null;
  const anoF = pf[3]!;
  const mesF = pf[2]!;
  if (!pi) return `${anoF}-${mesF}`; // sem data inicial: o fim é o mês de competência
  const anoI = pi[3]!;
  const mesI = pi[2]!;
  if (anoI === anoF && mesI === "01" && mesF === "12") return anoF; // exercício completo
  if (anoI === anoF && mesI === mesF) return `${anoF}-${mesF}`; // um mês só
  return `${anoI}-${mesI}..${anoF}-${mesF}`; // acumulado (parcial)
}

const MESES_ROTULO = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** Competência legível: "2025" → "ano fechado 2025" · "2025-09" → "set/2025" ·
 *  "2025-01..2025-09" → "acumulado jan–set/2025" (anos diferentes aparecem). */
export function rotuloCompetencia(comp: string | null | undefined): string {
  if (!comp) return "sem competência";
  if (/^\d{4}$/.test(comp)) return `ano fechado ${comp}`;
  let m = comp.match(/^(\d{4})-(\d{2})$/);
  if (m) return `${MESES_ROTULO[+m[2]! - 1] ?? m[2]}/${m[1]}`;
  m = comp.match(/^(\d{4})-(\d{2})\.\.(\d{4})-(\d{2})$/);
  if (m) {
    const [, anoI, mesI, anoF, mesF] = m;
    const de = `${MESES_ROTULO[+mesI! - 1] ?? mesI}${anoI !== anoF ? `/${anoI}` : ""}`;
    return `acumulado ${de}–${MESES_ROTULO[+mesF! - 1] ?? mesF}/${anoF}`;
  }
  return comp;
}

/** O formato de competência é válido? (ano · mês · acumulado de..até) */
export function competenciaValida(comp: string): boolean {
  if (/^\d{4}$/.test(comp) || /^\d{4}-(0[1-9]|1[0-2])$/.test(comp)) return true;
  const m = comp.match(/^(\d{4})-(0[1-9]|1[0-2])\.\.(\d{4})-(0[1-9]|1[0-2])$/);
  if (!m) return false;
  // acumulado precisa ir para a FRENTE (de ≤ até) e ter mais de um mês
  return `${m[1]}-${m[2]}` < `${m[3]}-${m[4]}`;
}

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

/** BP × DRE pelas palavras-assinatura (mesma lista content-first do /process).
 *  Acentos são NORMALIZADOS antes do match — "Demonstração", "Dedução" e afins
 *  casam com ou sem acento (o visualizador SPED imprime "DEMONSTRAÇÃO DE
 *  RESULTADO", com "DE", que escapava da lista antiga — caso AOCP). */
export function tipoPorKeywords(raw: string): "DRE" | "Balanço Patrimonial" | null {
  const t = raw.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const temBP = t.includes("ativo circulante") || t.includes("passivo circulante") || t.includes("a t i v o");
  const temDRE = t.includes("receita bruta") || t.includes("resultado liquido") ||
    t.includes("custo operacional") || t.includes("custo produtos vendidos") ||
    t.includes("demonstrativo de resultado") || t.includes("demonstrativo do resultado") ||
    t.includes("demonstracao do resultado") || t.includes("demonstracao de resultado") ||
    t.includes("receita de vendas") || t.includes("deducoes da receita") ||
    t.includes("despesas com vendas") ||
    t.includes("receita operacional liquida") || t.includes("custo das mercadorias");
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

/** Wrapper de I/O: extrai o texto conforme o formato e delega ao núcleo puro.
 *  Devolve também o TEXTO extraído — a validação de empresa (trava de upload
 *  na empresa errada) reusa a mesma extração, sem parse duplo. */
export async function curarUpload(buffer: Buffer, nome: string): Promise<Curadoria & { texto: string }> {
  if (/\.pdf$/i.test(nome)) {
    const texto = await extrairTextoLayoutPDF(buffer);
    if (!texto || texto.length < 300) return { ...VAZIA, texto: texto ?? "" }; // escaneado/sem texto
    return { ...curarConteudo(texto), texto };
  }
  // BALANCETE TABULAR PRIMEIRO (08/08/2026, caso Belagro): o parseDocument
  // devolve a TABELA reconhecida e perde o cabeçalho onde mora o período
  // ("Balancete Consolidado de 01/01/2025 a 30/11/2025") — o CSV subiu
  // declarado como 2026 e nada barrou. O parser determinístico do balancete
  // lê o período direto; a competência dele é EVIDÊNCIA FORTE (documento manda).
  try {
    if (ehArquivoTabular(nome)) {
      const p = parseBalanceteTabular(buffer, nome, null);
      if (p.linhas.length >= 10 && !p.periodoAssumido) {
        const comp = competenciaDoPeriodoBalancete(p.periodoInicio, p.periodoFim);
        if (comp) {
          return {
            tipo: "Balancete", competencia: comp, competenciaForte: true,
            evidencias: [`balancete tabular: ${p.linhas.length} contas · período ${p.periodoInicio} a ${p.periodoFim}`],
            texto: textoBrutoPlanilha(buffer, nome),
          };
        }
      }
    }
  } catch { /* não é balancete tabular — segue o caminho genérico */ }
  // Planilha/CSV: o parser tabular dá tipo/período, mas seu `raw` já é a TABELA
  // reconhecida — o cabeçalho (onde mora o nome da empresa) fica de fora. Para
  // a validação de empresa devolvemos o texto BRUTO da planilha inteira.
  const parsed = await parseDocument(buffer, nome, "Outro");
  return { ...curarConteudo(parsed.raw, parsed.periodos), texto: textoBrutoPlanilha(buffer, nome) || parsed.raw };
}

/** Texto integral de uma planilha/CSV (todas as abas, cabeçalhos inclusos). */
function textoBrutoPlanilha(buffer: Buffer, nome: string): string {
  try {
    if (/\.(csv|txt|md)$/i.test(nome)) return buffer.toString("utf8");
    const wb = XLSX.read(buffer, { type: "buffer" });
    return wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n]!)).join("\n");
  } catch {
    return ""; // formato ilegível: a validação de empresa simplesmente não opina
  }
}

// ── TRAVA DE EMPRESA ERRADA (pedido do usuário, 21/07/2026) ─────────────────
// A Data room é POR EMPRESA: um balancete da Belagro subido na Move Farma
// envenena períodos, cadência e extração. Validação determinística pelo NOME:
// se o conteúdo cita OUTRA empresa cadastrada e NÃO cita a do workspace, o
// upload exige confirmação explícita (auditada). Citar as duas vira aviso.

/** Normaliza para comparação: caixa alta, sem acentos, espaços colapsados.
 *  NFD separa o acento da letra e o filtro não-ASCII o REMOVE (nunca troca por
 *  espaço — senão "FRIGORÍFICO" viraria "FRIGORI FICO" e a empresa escaparia
 *  da trava; bug pego por teste). Só depois a pontuação vira espaço. */
function normalizarTexto(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[^\x00-\x7F]/g, "") // marcas combinantes e demais não-ASCII: fora
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/** Nome DISTINTIVO da empresa: fantasia, ou razão social sem o sufixo legal
 *  (LTDA, S.A., EIRELI, ME, EPP…). Nomes curtos (<4) não valem — falso positivo. */
export function nomeDistintivo(e: { razaoSocial: string; nomeFantasia?: string | null }): string | null {
  const candidatos = [e.nomeFantasia, e.razaoSocial]
    .filter((n): n is string => !!n && n.trim().length > 0)
    .map((n) => normalizarTexto(n).replace(/\b(LTDA|EIRELI|EPP|ME|SA|S A)\b/g, " ").replace(/\s+/g, " ").trim());
  const melhor = candidatos.find((c) => c.length >= 4);
  return melhor ?? null;
}

export interface ValidacaoEmpresa {
  /** O nome da empresa do workspace aparece no documento? */
  alvoNoDoc: boolean;
  /** OUTRA empresa cadastrada citada no documento (a primeira encontrada). */
  outraDetectada: { id: string; nome: string } | null;
}

export function validarEmpresaDoDocumento(
  texto: string,
  alvo: { razaoSocial: string; nomeFantasia?: string | null },
  outras: Array<{ id: string; razaoSocial: string; nomeFantasia?: string | null }>,
): ValidacaoEmpresa {
  const corpo = normalizarTexto(texto);
  if (!corpo) return { alvoNoDoc: false, outraDetectada: null };
  const nomeAlvo = nomeDistintivo(alvo);
  const alvoNoDoc = !!nomeAlvo && corpo.includes(nomeAlvo);
  let outraDetectada: ValidacaoEmpresa["outraDetectada"] = null;
  for (const e of outras) {
    const nome = nomeDistintivo(e);
    if (!nome || (nomeAlvo && nome === nomeAlvo)) continue;
    if (corpo.includes(nome)) {
      outraDetectada = { id: e.id, nome: e.nomeFantasia || e.razaoSocial };
      break;
    }
  }
  return { alvoNoDoc, outraDetectada };
}
