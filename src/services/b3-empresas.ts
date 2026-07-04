/**
 * SETOR B3 NAS EMPRESAS CVM — join por CHAVES EXATAS (zero casamento por nome):
 *   ClassifSetorial oficial (código emissor → SETOR/SUBSETOR/SEGMENTO, xlsx versionado
 *   em seed-data) + API de listadas da B3 (código emissor → CNPJ) → CvmCompany.
 *
 * Semântica dos campos (igual à PeerCompany, vinda da planilha do usuário):
 *   classificacao = SETOR B3 (11) · setor = SUBSETOR (44) · subsetor = SEGMENTO (90).
 * Empresa CVM sem registro na B3 (capital aberto não listado) fica sem taxonomia —
 * é excluída dos estudos setoriais, nunca chutada.
 */
import { join } from "node:path";
import * as XLSX from "xlsx";
import { prisma } from "../db/client";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";
const B3_LISTADAS = (pagina: number) => {
  const b64 = Buffer.from(JSON.stringify({ language: "pt-br", pageNumber: pagina, pageSize: 120 })).toString("base64");
  return `https://sistemaswebb3-listados.b3.com.br/listedCompaniesProxy/CompanyCall/GetInitialCompanies/${b64}`;
};

interface EmpresaB3 { issuingCompany: string; cnpj: string; tradingName: string }

/** API de listadas da B3, paginada — código emissor → CNPJ. */
export async function baixarEmpresasB3(): Promise<EmpresaB3[]> {
  const out: EmpresaB3[] = [];
  let pagina = 1;
  let totalPaginas = 1;
  do {
    const res = await fetch(B3_LISTADAS(pagina), { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`B3 listadas p.${pagina}: HTTP ${res.status}`);
    const json = (await res.json()) as { page: { totalPages: number }; results: EmpresaB3[] };
    totalPaginas = json.page.totalPages;
    for (const r of json.results) {
      const cnpj = String(r.cnpj ?? "").replace(/[^\d]/g, "");
      if (cnpj.length === 14 && r.issuingCompany) out.push({ issuingCompany: r.issuingCompany.trim(), cnpj, tradingName: r.tradingName ?? "" });
    }
    pagina++;
    await new Promise((r) => setTimeout(r, 300)); // educado com a B3
  } while (pagina <= totalPaginas);
  return out;
}

interface LinhaClassif { codigo: string; pregao: string; classificacao: string; setor: string; subsetor: string }

/** ClassifSetorial oficial (xlsx versionado): código → taxonomia (com fill-down). */
export function lerClassifSetorial(): Map<string, LinhaClassif> {
  const wb = XLSX.read(join(__dirname, "../../prisma/seed-data/ClassifSetorial-B3-oficial.xlsx"), { type: "file" });
  const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  const out = new Map<string, LinhaClassif>();
  let setorB3 = "", subsetorB3 = "", segmentoB3 = "";
  for (const r of rows.slice(2)) {
    const [c0, c1, c2, pregao, codigo] = [r[0], r[1], r[2], r[3], r[4]].map((v) => String(v ?? "").trim());
    if (c0) setorB3 = c0;
    if (c1) subsetorB3 = c1;
    if (c2) segmentoB3 = c2;
    if (!codigo || codigo.length !== 4 || !pregao) continue; // linhas de grupo/rodapé
    out.set(codigo.toUpperCase(), {
      codigo: codigo.toUpperCase(), pregao,
      classificacao: setorB3, setor: subsetorB3, subsetor: segmentoB3,
    });
  }
  return out;
}

export interface ResultadoSetores { listadasB3: number; comTaxonomia: number; cvmTotal: number; atualizadas: number; semB3: number }

/** Enriquece CvmCompany com ticker + taxonomia B3 (join código↔CNPJ, exato). */
export async function atualizarSetoresCvm(): Promise<ResultadoSetores> {
  const [listadas, classif, cvm] = await Promise.all([
    baixarEmpresasB3(),
    Promise.resolve(lerClassifSetorial()),
    prisma.cvmCompany.findMany({ select: { cnpj: true } }),
  ]);
  const porCnpj = new Map<string, { ticker: string; tradingName: string }>();
  for (const l of listadas) {
    // um CNPJ pode ter mais de um registro (raro) — o primeiro com taxonomia vence
    if (!porCnpj.has(l.cnpj) || classif.has(l.issuingCompany.toUpperCase())) {
      porCnpj.set(l.cnpj, { ticker: l.issuingCompany.toUpperCase(), tradingName: l.tradingName });
    }
  }
  let atualizadas = 0;
  for (const { cnpj } of cvm) {
    const b3 = porCnpj.get(cnpj);
    if (!b3) continue;
    const tax = classif.get(b3.ticker);
    await prisma.cvmCompany.update({
      where: { cnpj },
      data: {
        ticker: b3.ticker,
        pregao: tax?.pregao ?? b3.tradingName,
        classificacao: tax?.classificacao ?? null,
        setor: tax?.setor ?? null,
        subsetor: tax?.subsetor ?? null,
      },
    });
    atualizadas++;
  }
  const semB3 = cvm.length - atualizadas;
  console.log(`[b3-empresas] ${listadas.length} listadas · ${classif.size} com taxonomia · CVM ${cvm.length}: ${atualizadas} enriquecidas · ${semB3} sem B3`);
  return { listadasB3: listadas.length, comTaxonomia: classif.size, cvmTotal: cvm.length, atualizadas, semB3 };
}
