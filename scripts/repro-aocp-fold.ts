/**
 * REPRO AOCP — estágio 2: pipeline completo (parser → fold árvore → validação),
 * igual à produção. Rodar: npx tsx scripts/repro-aocp-fold.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { parseDocument } from "../src/services/parser";
import { extractFinancialsWithAI } from "../src/services/ai-extraction";
import { validateFinancialData } from "../src/services/validation";
import type { DictionaryEntry } from "../src/services/account-mapper";

const DIR = "C:/Users/Emerson/OneDrive/Desktop/Testes Quantua/AOCP";
const fmt = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 2 });

async function main() {
  const seed = JSON.parse(readFileSync(join(__dirname, "..", "prisma", "seed-data", "account-dictionary.json"), "utf8"));
  const dict: DictionaryEntry[] = seed.map((e: any) => ({ nomeOriginal: e.nomeOriginal, contaDestino: e.contaDestino, grupoConta: e.grupoConta }));

  const files: Array<[string, string]> = [
    ["1. Balanço Patrimonial 2025- AOCP.pdf", "Balanço Patrimonial"],
    ["2. Demonstração de Resultado do Exercicio 2025 - AOCP.pdf", "DRE"],
  ];
  const docs = [] as Array<{ raw: string; tipo: string; periodos: string[] }>;
  for (const [f, tipo] of files) {
    const parsed = await parseDocument(readFileSync(`${DIR}/${f}`), f, tipo);
    docs.push({ raw: parsed.raw, tipo, periodos: parsed.periodos });
  }

  const r = await extractFinancialsWithAI(docs, [], dict);
  const v = validateFinancialData(r.bp, r.dre, r.periodos, r.declarados);
  const p0 = r.periodos[0];

  console.log(`\nperíodos: ${r.periodos.join(", ")} · custo $${r.custo.usd.toFixed(4)} (${r.custo.fonte ?? "?"})`);
  console.log(`validação: equação=${v.equacaoPatrimonial} compAtivo=${v.composicaoAtivo} compPassivo=${v.composicaoPassivo} detalhe=${v.detalheCompleto} dreRecon=${v.reconciliacaoDRE.verificada ? (v.reconciliacaoDRE.ok ? "OK" : "FALHA") : "não verificada"}`);

  console.log(`\n── BP canônico (≠0) ──`);
  for (const l of r.bp) {
    const val = l.valores?.[p0];
    if (val) console.log(`  ${l.conta.padEnd(46)} ${fmt(val).padStart(16)}`);
  }
  console.log(`\n── DRE canônica (≠0) ──`);
  for (const l of r.dre) {
    const val = l.valores?.[p0];
    if (val) console.log(`  ${l.conta.padEnd(46)} ${fmt(val).padStart(16)}`);
  }
  console.log(`\nnão mapeadas: ${r.naoMapeados.length}`);
  for (const nm of r.naoMapeados) console.log(`  - [${nm.tipo}] "${nm.nome}" = ${fmt(nm.valor)} (${nm.grupo})`);
  console.log(`alertas composição: ${r.alertasComposicao.length}`);
  for (const a of r.alertasComposicao) console.log(`  ! ${a.periodo} ${a.grupo} "${a.caminho}": ${fmt(a.declarado)} vs filhos ${fmt(a.somaFilhos)} (Δ ${fmt(a.delta)})`);
}
main().catch((e) => { console.error("ERRO:", e); process.exit(2); });
