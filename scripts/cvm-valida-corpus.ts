/**
 * VALIDAÇÃO-CORPUS — base CVM (nosso motor, dos ZIPs) × planilha independente do
 * usuário, no corpus INTEIRO: todas as empresas casáveis × 2017–2025 × indicadores
 * comparáveis. Saída: convergência geral, por indicador, e os piores outliers.
 *
 *   npx tsx scripts/cvm-valida-corpus.ts "C:/Users/Emerson/Documents/Automação_B3/itr_cvm"
 *
 * Pares DEFINICIONAIS (medem coisas deliberadamente diferentes) são reportados à
 * parte, não como erro: Margem EBITDA/ICJ/DívLíq÷EBITDA (planilha usa EBIT; nós,
 * EBITDA real) e Liquidez Imediata (planilha soma aplicações financeiras ao caixa).
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import * as XLSX from "xlsx";
import { parseCvmZip } from "../src/services/cvm-ingest";
import { mesclaEmpresas, indicadoresDaEmpresa } from "../src/services/cvm-metrics";
import { PEER_INDICATOR_MAP } from "../src/services/peer-indicator-map";
import { baixarEmpresasB3 } from "../src/services/b3-empresas";

const ANOS = [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const DEFINICIONAIS = new Set(["Margem EBITDA", "Índice de Cobertura de Juros", "Dívida Líquida/EBITDA", "Liquidez Imediata"]);
const ALIASES = new Set(["Margem Operacional", "Dívida Líquida/Lucro Operacional"]);

const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
    .replace(/\b(S\.?\/?A\.?|CIA\.?|COMPANHIA|PARTICIPACOES|PART|HOLDING|ON|PN|NM|N1|N2|BRASIL|DO|DA|DE|E)\b/g, " ")
    .replace(/[^A-Z0-9]/g, " ").replace(/\s+/g, " ").trim();

async function main(): Promise<void> {
  const pasta = process.argv[2] ?? "C:/Users/Emerson/Documents/Automação_B3/itr_cvm";

  // ── Lado planilha ──
  const wb = XLSX.read(join(__dirname, "../prisma/seed-data/base_bovespa.xlsx"), { type: "file" });
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]);
  const planilha = new Map<string, number>(); // "PAPEL|CONTA|ANO" → valor
  const nomePorPapel = new Map<string, string>();
  for (const r of rows) {
    if (String(r["Documento"] ?? "") !== "INDICADOR") continue;
    const papel = String(r["Papel"] ?? "");
    const conta = String(r["Conta"] ?? "").trim().toUpperCase();
    nomePorPapel.set(papel, String(r["Empresa"] ?? ""));
    for (const ano of ANOS) {
      const v = r[String(ano)];
      if (typeof v === "number" && Number.isFinite(v) && v !== 0) planilha.set(`${papel}|${conta}|${ano}`, v);
    }
  }

  // ── Lado CVM (2016 entra só p/ médias/LTM de 2017) ──
  const mapas = [];
  for (let ano = 2016; ano <= 2025; ano++) {
    for (const tipo of ["itr", "dfp"]) {
      const c = join(pasta, `${tipo}_${ano}.zip`);
      if (existsSync(c)) mapas.push(await parseCvmZip(c));
    }
  }
  const cvm = mesclaEmpresas(mapas);
  console.log(`CVM: ${cvm.size} empresas · Planilha: ${nomePorPapel.size} papéis\n`);

  // ── Casamento por TICKER→CNPJ (exato, via API da B3) + fallback por nome ──
  const listadas = await baixarEmpresasB3();
  const cnpjPorCodigo = new Map(listadas.map((l) => [l.issuingCompany.toUpperCase(), l.cnpj]));
  const porNome = new Map<string, (typeof cvm extends Map<string, infer V> ? V : never)[]>();
  for (const emp of cvm.values()) {
    const n = norm(emp.denom);
    porNome.set(n, [...(porNome.get(n) ?? []), emp]);
  }
  const casados: Array<[string, (typeof cvm extends Map<string, infer V> ? V : never)]> = [];
  const semPar: string[] = [];
  for (const [papel, nome] of nomePorPapel) {
    const raiz = papel.replace(/\d+$/, "").toUpperCase();
    const cnpj = cnpjPorCodigo.get(raiz);
    const direto = cnpj ? cvm.get(cnpj) : undefined;
    if (direto) { casados.push([papel, direto]); continue; }
    const n = norm(nome);
    let cand = porNome.get(n);
    if (!cand) {
      const achados = [...porNome.entries()].filter(([k]) => k.startsWith(n) || n.startsWith(k)).flatMap(([, v]) => v);
      if (achados.length === 1) cand = achados;
    }
    if (cand && cand.length === 1) casados.push([papel, cand[0]]);
    else semPar.push(`${papel} (${nome})`);
  }
  console.log(`Casadas: ${casados.length} · sem par claro: ${semPar.length}\n`);

  // ── Comparação ──
  type Stat = { ok: number; total: number; piores: Array<[number, string]> };
  const porIndicador = new Map<string, Stat>();
  const registra = (ind: string, desvio: number, rotulo: string) => {
    const s = porIndicador.get(ind) ?? { ok: 0, total: 0, piores: [] };
    s.total++;
    if (Math.abs(desvio) <= 0.05) s.ok++;
    else { s.piores.push([Math.abs(desvio), rotulo]); s.piores.sort((a, b) => b[0] - a[0]); s.piores.length = Math.min(s.piores.length, 3); }
    porIndicador.set(ind, s);
  };

  for (const [papel, emp] of casados) {
    for (const ano of ANOS) {
      const dtFim = `${ano}-12-31`;
      if (!emp.periodos[dtFim]) continue;
      const visao = indicadoresDaEmpresa(emp, dtFim).find((v) => v.visao === "ANO");
      if (!visao) continue;
      const label = Object.keys(visao.indicadores[0]?.valores ?? {})[0];
      for (const [nosso, contaPlan] of Object.entries(PEER_INDICATOR_MAP)) {
        if (ALIASES.has(nosso)) continue;
        const vCvm = visao.indicadores.find((i) => i.nome === nosso)?.valores[label];
        const vPlan = planilha.get(`${papel}|${contaPlan}|${ano}`);
        if (typeof vCvm !== "number" || vPlan === undefined) continue;
        // prazos/ciclo: nosso motor arredonda p/ dias inteiros — ±1 dia é empate
        const eDias = /Prazo|Ciclo/.test(nosso);
        const desvio = eDias && Math.abs(vCvm - vPlan) <= 1 ? 0
          : Math.abs(vPlan) > 1e-9 ? (vCvm - vPlan) / Math.abs(vPlan)
          : Math.abs(vCvm) <= 1e-9 ? 0 : 1;
        registra(nosso, desvio, `${papel} ${ano}: CVM=${vCvm.toFixed(3)} plan=${vPlan.toFixed(3)}`);
      }
    }
  }

  // ── Relatório ──
  let okEstr = 0, totEstr = 0, okDef = 0, totDef = 0;
  console.log(`${"Indicador".padEnd(40)} ${"dentro ±5%".padStart(12)} ${"n".padStart(7)}  piores desvios`);
  const linhas = [...porIndicador.entries()].sort((a, b) => (a[1].ok / a[1].total) - (b[1].ok / b[1].total));
  for (const [ind, s] of linhas) {
    const tag = DEFINICIONAIS.has(ind) ? " [DEFINICIONAL]" : "";
    if (DEFINICIONAIS.has(ind)) { okDef += s.ok; totDef += s.total; } else { okEstr += s.ok; totEstr += s.total; }
    console.log(`${(ind + tag).padEnd(40)} ${((s.ok / s.total) * 100).toFixed(1).padStart(11)}% ${String(s.total).padStart(7)}  ${s.piores.map(([d, r]) => `${r} (${(d * 100).toFixed(0)}%)`).join(" · ")}`);
  }
  console.log(`\n════ ESTRUTURAIS: ${okEstr}/${totEstr} = ${((okEstr / totEstr) * 100).toFixed(1)}% dentro de ±5% ════`);
  console.log(`════ DEFINICIONAIS (esperado divergir): ${okDef}/${totDef} = ${((okDef / totDef) * 100).toFixed(1)}% ════`);
  if (semPar.length) console.log(`\nSem par claro (${semPar.length}): ${semPar.slice(0, 15).join(" · ")}${semPar.length > 15 ? " …" : ""}`);
}
void main();
