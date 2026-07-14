/**
 * REPRO AOCP (SPED viewer PDFs): estágio 1 — o que o parser determinístico produz.
 * Rodar: npx tsx scripts/repro-aocp.ts
 */
import { readFileSync } from "fs";
import { parseDocument } from "../src/services/parser";

const DIR = "C:/Users/Emerson/OneDrive/Desktop/Testes Quantua/AOCP";
const FILES: Array<[string, string]> = [
  ["1. Balanço Patrimonial 2025- AOCP.pdf", "Balanço Patrimonial"],
  ["2. Demonstração de Resultado do Exercicio 2025 - AOCP.pdf", "DRE"],
];

async function main() {
  for (const [f, tipo] of FILES) {
    const buffer = readFileSync(`${DIR}/${f}`);
    const parsed = await parseDocument(buffer, f, tipo);
    console.log(`\n════ ${tipo} — ${f}`);
    console.log(`períodos: [${parsed.periodos.join(", ")}] · linhas: ${parsed.linhas.length}`);
    for (const l of parsed.linhas) {
      const vals = Object.entries(l.valores).map(([k, v]) => `${k}=${v.toLocaleString("pt-BR")}`).join(" · ");
      console.log(`  [ind=${String(l.indent ?? "-").padStart(2)}] ${l.conta}  →  ${vals}${l.contexto ? `   (ctx: ${l.contexto})` : ""}`);
    }
    console.log(`--- raw (primeiros 1200 chars) ---`);
    console.log(parsed.raw.slice(0, 1200));
  }
}
main().catch((e) => { console.error("ERRO:", e); process.exit(2); });
