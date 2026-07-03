/**
 * PROVA DE CONCEITO — ingestão CVM ponta a ponta com dado real.
 *   npx tsx scripts/cvm-poc.ts "C:/Users/Emerson/Documents/Automação_B3/itr_cvm/itr_2026.zip"
 *
 * Lê o ZIP, monta statements de empresas de amostra e roda o MESMO calculateIndicators
 * do motor — imprime os indicadores-chave para validação de sanidade.
 */
import { parseCvmZip, buildStatements } from "../src/services/cvm-ingest";
import { calculateIndicators } from "../src/services/indicator-calculator";

const zipPath = process.argv[2];
if (!zipPath) { console.error("uso: tsx scripts/cvm-poc.ts <caminho-do-zip> [DENOM_FILTRO]"); process.exit(1); }
const filtro = (process.argv[3] ?? "AMBEV|WEG|LOJAS RENNER|MAGAZINE|TOTVS").toUpperCase();

console.log(`Lendo ${zipPath}…`);
const t0 = Date.now();
const empresas = parseCvmZip(zipPath);
console.log(`${empresas.size} empresas (não-financeiras) em ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const CHAVE = ["Receita Líquida", "Margem Bruta", "Margem EBITDA", "Margem Líquida", "Liquidez Corrente",
  "Prazo Médio Contas a Receber", "Prazo Médio Estoque", "Endividamento Geral", "ROE (Retorno sobre Patrimônio Líquido)",
  "Termômetro de Kanitz", "Altman Z-Score (EM)", "Situação de Liquidez (Fleuriet)"];

const re = new RegExp(filtro, "i");
let amostra = 0;
for (const emp of empresas.values()) {
  if (!re.test(emp.denom)) continue;
  const dts = Object.keys(emp.periodos).sort();
  const ultimo = dts[dts.length - 1];
  const { bp, dre, periodos } = buildStatements(emp, [ultimo]);
  if (bp.length < 5 || dre.length < 3) { console.log(`(pulei ${emp.denom} — dados incompletos: bp=${bp.length} dre=${dre.length})`); continue; }
  const inds = calculateIndicators(bp, dre, periodos);
  const p = periodos[0];
  console.log(`═══ ${emp.denom} · ${p} · contas BP=${bp.length} DRE=${dre.length} ═══`);
  for (const nome of CHAVE) {
    const i = inds.find((x) => x.nome === nome);
    const v = i?.valores[p];
    const fmt = typeof v === "number"
      ? (i!.tipoDado === "%" ? `${(v * 100).toFixed(1)}%` : i!.tipoDado === "R$" ? `R$ ${Math.round(v).toLocaleString("pt-BR")}` : i!.tipoDado === "Dias" ? `${v} dias` : v.toFixed(2))
      : String(v ?? "—");
    console.log(`  ${nome.padEnd(38)} ${fmt}`);
  }
  const fc = emp.periodos[ultimo].dfc;
  console.log(`  ${"FCO / FCI / FCF (DFC CVM)".padEnd(38)} ${[fc.fco, fc.fci, fc.fcf].map((x) => (x == null ? "—" : Math.round(x / 1e6) + "M")).join(" / ")}`);
  console.log();
  if (++amostra >= 5) break;
}
if (amostra === 0) console.log("Nenhuma empresa casou com o filtro:", filtro);
