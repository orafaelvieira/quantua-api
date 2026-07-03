/**
 * VALIDAÇÃO CRUZADA 2025 — base CVM (nosso motor, a partir dos ZIPs) × planilha do
 * usuário (indicadores calculados de forma INDEPENDENTE, seed-data/base_bovespa.xlsx).
 * Mesma empresa, mesmo ano (2025), mesmos indicadores (PEER_INDICATOR_MAP).
 * Convergência = prova de mapeamento correto; divergência = alerta antes da fase 4.
 */
import { join } from "node:path";
import * as XLSX from "xlsx";
import { parseCvmZip } from "../src/services/cvm-ingest";
import { mesclaEmpresas, indicadoresDaEmpresa } from "../src/services/cvm-metrics";
import { PEER_INDICATOR_MAP } from "../src/services/peer-indicator-map";

// Papel na planilha → regex do DENOM_CIA na CVM (amostra diversificada de setores)
const AMOSTRA: Array<[string, RegExp]> = [
  ["ABEV3", /^AMBEV/i],
  ["VALE3", /^VALE S\.?A/i],
  ["PETR4", /PETROLEO BRASILEIRO/i],
  ["TOTS3", /^TOTVS/i],
  ["WEGE3", /^WEG S/i],
  ["MGLU3", /^MAGAZINE LUIZA/i],
  ["LREN3", /LOJAS RENNER/i],
  ["SUZB3", /^SUZANO S/i],
];

async function main(): Promise<void> {
  // Lado planilha: valores 2025 (data-base 31/12/25) por Papel × Conta INDICADOR
  const wb = XLSX.read(join(__dirname, "../prisma/seed-data/base_bovespa.xlsx"), { type: "file" });
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]);
  const planilha = new Map<string, number>(); // "PAPEL|CONTA" → valor 2025
  for (const r of rows) {
    if (String(r["Documento"] ?? "") !== "INDICADOR") continue;
    const papel = String(r["Papel"] ?? "");
    const conta = String(r["Conta"] ?? "").trim().toUpperCase();
    const v = r["2025"];
    if (typeof v === "number" && Number.isFinite(v) && v !== 0) planilha.set(`${papel}|${conta}`, v);
  }

  // Lado CVM: mesmo motor do servidor, visão ANO @ 2025-12-31 (com LTM-only replicado)
  const pasta = "C:/Users/Emerson/Documents/Automação_B3/itr_cvm";
  const mapas = [];
  for (const f of ["itr_2024.zip", "dfp_2024.zip", "itr_2025.zip", "dfp_2025.zip"]) {
    mapas.push(await parseCvmZip(join(pasta, f)));
  }
  const cvm = mesclaEmpresas(mapas);

  let comparados = 0;
  let ok = 0;
  const desvios: string[] = [];
  for (const [papel, re] of AMOSTRA) {
    const emp = [...cvm.values()].find((e) => re.test(e.denom));
    if (!emp || !emp.periodos["2025-12-31"]) { console.log(`${papel}: NÃO ENCONTRADA na CVM`); continue; }
    const ano = indicadoresDaEmpresa(emp, "2025-12-31").find((v) => v.visao === "ANO");
    if (!ano) { console.log(`${papel}: sem visão ANO`); continue; }
    const label = Object.keys(ano.indicadores[0]?.valores ?? {})[0];

    console.log(`\n═══ ${papel} · ${emp.denom} · ANO 2025 ═══`);
    console.log(`${"Indicador".padEnd(34)} ${"CVM(motor)".padStart(12)} ${"Planilha".padStart(12)} ${"Δ%".padStart(8)}`);
    for (const [nosso, contaPlan] of Object.entries(PEER_INDICATOR_MAP)) {
      if (nosso === "Margem Operacional" || nosso === "Dívida Líquida/Lucro Operacional") continue; // aliases
      const ind = ano.indicadores.find((i) => i.nome === nosso);
      const vCvm = ind?.valores[label];
      const vPlan = planilha.get(`${papel}|${contaPlan}`);
      if (typeof vCvm !== "number" || vPlan === undefined) continue;
      comparados++;
      const desvio = vPlan !== 0 ? (vCvm - vPlan) / Math.abs(vPlan) : (vCvm === 0 ? 0 : 1);
      const bate = Math.abs(desvio) <= 0.05; // 5% de tolerância (arredondamentos/base de dias)
      if (bate) ok++;
      else desvios.push(`${papel} · ${nosso}: CVM=${vCvm.toFixed(3)} vs plan=${vPlan.toFixed(3)} (Δ ${(desvio * 100).toFixed(0)}%)`);
      console.log(
        `${(bate ? "✓ " : "✗ ") + nosso.padEnd(32)} ${vCvm.toFixed(3).padStart(12)} ${vPlan.toFixed(3).padStart(12)} ${(desvio * 100).toFixed(1).padStart(7)}%`,
      );
    }
  }
  console.log(`\n════ RESULTADO: ${ok}/${comparados} dentro de ±5% ════`);
  if (desvios.length) { console.log("\nDesvios p/ investigar:"); desvios.forEach((d) => console.log("  " + d)); }
}
void main();
