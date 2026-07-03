/**
 * PROVA DE CONCEITO — pares CVM nas TRÊS VISÕES (TRI · ANO · LTM) com dado real.
 *   npx tsx scripts/cvm-poc.ts "C:/Users/Emerson/Documents/Automação_B3/itr_cvm" AMBEV
 * (1º arg: pasta com itr_2025.zip/itr_2026.zip/dfp_2025.zip · 2º: filtro de empresa)
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { parseCvmZip } from "../src/services/cvm-ingest";
import { mesclaEmpresas, indicadoresDaEmpresa, dreLtm, dreTrimestre } from "../src/services/cvm-metrics";

const pasta = process.argv[2] ?? "C:/Users/Emerson/Documents/Automação_B3/itr_cvm";
const filtro = new RegExp(process.argv[3] ?? "AMBEV", "i");

const CHAVE = ["Receita Líquida", "Margem Bruta", "Margem EBITDA", "Margem Líquida", "Liquidez Corrente",
  "Prazo Médio Contas a Receber", "ROE (Retorno sobre Patrimônio Líquido)", "ROA (Retorno sobre Ativos)",
  "Dívida Líquida/EBITDA", "Termômetro de Kanitz", "Altman Z-Score (EM)", "Situação de Liquidez (Fleuriet)"];

async function main(): Promise<void> {
const fontes = ["itr_2025.zip", "itr_2026.zip", "dfp_2025.zip"].map((f) => join(pasta, f)).filter(existsSync);
console.log("Fontes:", fontes.map((f) => f.split(/[\\/]/).pop()).join(", "));
const t0 = Date.now();
const empresas = mesclaEmpresas(await Promise.all(fontes.map((f) => parseCvmZip(f))));
console.log(`${empresas.size} empresas em ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

for (const emp of empresas.values()) {
  if (!filtro.test(emp.denom)) continue;
  const dts = Object.keys(emp.periodos).sort();
  console.log(`═══ ${emp.denom} · períodos disponíveis: ${dts.join(", ")} ═══\n`);
  const alvo = dts[dts.length - 1]; // 1T26
  console.log(`— Sanidade da montagem (dtFim ${alvo}) —`);
  const tri = dreTrimestre(emp, alvo);
  const ltm = dreLtm(emp, alvo);
  const rb = (d: Record<string, number> | null) => (d ? Math.round((d["Receita Bruta"] ?? 0) / 1e6) : null);
  console.log(`  Receita: TRI=${rb(tri)}M · LTM=${rb(ltm)}M · ANO25(DFP)=${rb(emp.periodos["2025-12-31"]?.dreYtd ?? null)}M`);
  console.log(`  (prova: LTM deve = ANO25 − 1T25 + 1T26 = ${rb(emp.periodos["2025-12-31"]?.dreYtd ?? null)! - rb(emp.periodos["2025-03-31"]?.dreTri ?? null)! + rb(tri)!}M)\n`);

  for (const dtFim of [alvo, "2025-12-31"]) {
    for (const visao of indicadoresDaEmpresa(emp, dtFim)) {
      console.log(`── ${visao.visao} @ ${dtFim} ──`);
      const p = Object.keys(visao.indicadores[0]?.valores ?? {})[0];
      for (const nome of CHAVE) {
        const i = visao.indicadores.find((x) => x.nome === nome);
        const v = i?.valores[p];
        const fmt = typeof v === "number"
          ? (i!.tipoDado === "%" ? `${(v * 100).toFixed(1)}%` : i!.tipoDado === "R$" ? `R$ ${(v / 1e6).toFixed(0)}M` : i!.tipoDado === "Dias" ? `${v} dias` : v.toFixed(2))
          : String(v ?? "—");
        const nota = i?.formula.includes("LTM sobre") ? `  [${i.formula.split("—").pop()?.trim()}]` : "";
        console.log(`   ${nome.padEnd(38)} ${fmt}${nota}`);
      }
      console.log();
    }
  }
  break;
}
}
void main();
