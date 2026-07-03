/**
 * INGESTÃO CVM (DFP/ITR) — Fase 1 da atualização automática de pares.
 *
 * Lê os ZIPs de dados abertos da CVM (itr_cia_aberta_AAAA.zip / dfp_cia_aberta_AAAA.zip),
 * monta BP/DRE/DFC por empresa/período usando o plano de contas PADRONIZADO (cvm-map)
 * e produz BPLineItem/DRELineItem no formato do motor — os pares passam pelo MESMO
 * `calculateIndicators` da empresa do IBR. Determinístico, sem IA.
 *
 * Regras (herdadas do estudo Automatizacao_ITRs_Bovespa validado pelo usuário):
 * - Consolidado preferido; individual como fallback por empresa/demonstrativo.
 * - ORDEM_EXERC = ÚLTIMO (pega reapresentações automaticamente).
 * - ESCALA_MOEDA MIL → valores gravados em R$ (×1000), mesma unidade do motor.
 * - D&A: não existe na DRE da CVM (embutida no custo) — extraída do DFC_MI (adição
 *   não-caixa sob 6.01 com descrição de depreciação/amortização).
 */
import AdmZip from "adm-zip";
import type { BPLineItem, DRELineItem } from "../types/financial";
import { CVM_BP_MAP, CVM_BP_CLASSIF, CVM_BP_NIVEL, CVM_DRE_MAP, CVM_DFC_MAP, CVM_EXCLUIR_DENOM } from "./cvm-map";

export interface CvmPeriodo {
  bp: Record<string, number>;   // conta do modelo → R$
  dre: Record<string, number>;
  dfc: { fco?: number; fci?: number; fcf?: number };
}
export interface CvmEmpresa {
  cnpj: string;
  denom: string;
  cdCvm: string;
  periodos: Record<string, CvmPeriodo>; // DT_FIM_EXERC (AAAA-MM-DD) → dados
}

const normCnpj = (s: string) => s.replace(/[^\d]/g, "");

function parseCsv(texto: string): Array<Record<string, string>> {
  // CSV da CVM: latin-1, ';' como separador, sem aspas aninhadas relevantes.
  const linhas = texto.split("\n").filter((l) => l.trim());
  if (linhas.length < 2) return [];
  const cab = linhas[0].split(";").map((c) => c.trim());
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < linhas.length; i++) {
    const partes = linhas[i].split(";");
    const r: Record<string, string> = {};
    for (let j = 0; j < cab.length; j++) r[cab[j]] = (partes[j] ?? "").trim();
    out.push(r);
  }
  return out;
}

interface LinhaCvm { cnpj: string; denom: string; cdCvm: string; dtFim: string; cd: string; ds: string; valor: number }

function extraiLinhas(zip: AdmZip, nomeArquivo: string): LinhaCvm[] {
  const entry = zip.getEntry(nomeArquivo);
  if (!entry) return [];
  const rows = parseCsv(entry.getData().toString("latin1"));
  const out: LinhaCvm[] = [];
  for (const r of rows) {
    const ordem = (r.ORDEM_EXERC ?? "").toUpperCase();
    if (!ordem.includes("LTIMO") || ordem.includes("PEN")) continue; // só ÚLTIMO
    const vl = parseFloat((r.VL_CONTA ?? "").replace(",", "."));
    if (!Number.isFinite(vl)) continue;
    const escala = (r.ESCALA_MOEDA ?? "").toUpperCase().includes("MIL") ? 1000 : 1;
    out.push({
      cnpj: normCnpj(r.CNPJ_CIA ?? ""),
      denom: r.DENOM_CIA ?? "",
      cdCvm: r.CD_CVM ?? "",
      dtFim: r.DT_FIM_EXERC ?? "",
      cd: (r.CD_CONTA ?? "").trim(),
      ds: r.DS_CONTA ?? "",
      valor: vl * escala,
    });
  }
  return out;
}

/** Lê um ZIP da CVM e monta o mapa empresa → períodos → contas do modelo Quantua. */
export function parseCvmZip(zipPath: string, opts?: { incluirFinanceiras?: boolean }): Map<string, CvmEmpresa> {
  const zip = new AdmZip(zipPath);
  const nomes = zip.getEntries().map((e) => e.entryName);
  const prefixo = nomes.some((n) => n.startsWith("dfp_")) ? "dfp_cia_aberta" : "itr_cia_aberta";
  const ano = (nomes[0]?.match(/(\d{4})\.csv$/) ?? [])[1] ?? "";

  const empresas = new Map<string, CvmEmpresa>();
  const garante = (l: LinhaCvm): CvmEmpresa => {
    let e = empresas.get(l.cnpj);
    if (!e) { e = { cnpj: l.cnpj, denom: l.denom, cdCvm: l.cdCvm, periodos: {} }; empresas.set(l.cnpj, e); }
    if (!e.periodos[l.dtFim]) e.periodos[l.dtFim] = { bp: {}, dre: {}, dfc: {} };
    return e;
  };

  // Consolidado primeiro; individual só preenche empresa/demonstrativo ausente no con.
  for (const dem of ["BPA", "BPP", "DRE", "DFC_MI"]) {
    const con = extraiLinhas(zip, `${prefixo}_${dem}_con_${ano}.csv`);
    const ind = extraiLinhas(zip, `${prefixo}_${dem}_ind_${ano}.csv`);
    const temCon = new Set(con.map((l) => l.cnpj));
    const linhas = [...con, ...ind.filter((l) => !temCon.has(l.cnpj))];

    for (const l of linhas) {
      if (!opts?.incluirFinanceiras && CVM_EXCLUIR_DENOM.test(l.denom)) continue;
      const per = garante(l).periodos[l.dtFim];
      if (dem === "BPA" || dem === "BPP") {
        const conta = CVM_BP_MAP[l.cd];
        if (conta) per.bp[conta] = l.valor;
      } else if (dem === "DRE") {
        const conta = CVM_DRE_MAP[l.cd];
        if (conta) per.dre[conta] = l.valor;
      } else if (dem === "DFC_MI") {
        const fluxo = CVM_DFC_MAP[l.cd];
        if (fluxo) per.dfc[fluxo] = l.valor;
        // D&A: adição não-caixa sob 6.01.* — pela DESCRIÇÃO (o CD varia entre empresas).
        if (l.cd.startsWith("6.01") && /deprecia|amortiza/i.test(l.ds) && per.dre["Depreciação e Amortização"] === undefined) {
          per.dre["Depreciação e Amortização"] = -Math.abs(l.valor); // convenção do motor: redutora negativa
        }
      }
    }
  }
  return empresas;
}

/** Converte um período CVM em BPLineItem/DRELineItem no formato do motor. */
export function buildStatements(empresa: CvmEmpresa, dtsFim: string[]): { bp: BPLineItem[]; dre: DRELineItem[]; periodos: string[] } {
  const periodos = dtsFim.filter((d) => empresa.periodos[d]);
  // "31/12/2025" no formato do motor (diasDoPeriodo entende dd/mm/aaaa)
  const rotulo = (d: string) => { const [a, m, dd] = d.split("-"); return `${dd}/${m}/${a}`; };
  const rot = periodos.map(rotulo);

  const contasBP = new Set<string>();
  const contasDRE = new Set<string>();
  for (const d of periodos) {
    for (const c of Object.keys(empresa.periodos[d].bp)) contasBP.add(c);
    for (const c of Object.keys(empresa.periodos[d].dre)) contasDRE.add(c);
  }

  const bp: BPLineItem[] = [...contasBP].map((conta) => ({
    conta,
    classificacao: CVM_BP_CLASSIF[conta] ?? "AF",
    nivel: CVM_BP_NIVEL[conta] ?? 2,
    editado: false,
    valores: Object.fromEntries(periodos.map((d, i) => [rot[i], empresa.periodos[d].bp[conta] ?? 0])),
  }));
  const dre: DRELineItem[] = [...contasDRE].map((conta) => ({
    conta,
    subtotal: false,
    editado: false,
    valores: Object.fromEntries(periodos.map((d, i) => [rot[i], empresa.periodos[d].dre[conta] ?? 0])),
  }));
  return { bp, dre, periodos: rot };
}
