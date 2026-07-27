/**
 * REPRO AOCP — espelho do /process de PRODUÇÃO (rodaHibrido):
 *   raw = linhasToText(linhas)  (limpo, contexto>conta — o que o LLM recebe em prod)
 *   rawIndent = doc.raw         (indentado — árvore determinística do BP)
 *   TODOS os 8 docs num único extractFinancialsWithAI (4 períodos), como no IBR real.
 *   bpModel/dreModel ativos do banco (bridge do editor), dicionário do seed.
 * Rodar: npx tsx scripts/repro-aocp-prod.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { parseDocument, type ExtractedRow } from "../src/services/parser";
import { extractFinancialsWithAI } from "../src/services/ai-extraction";
import { validateFinancialData } from "../src/services/validation";
import { loadActiveBPModel, loadActiveDREModel } from "../src/services/model-version";
import type { DictionaryEntry } from "../src/services/account-mapper";

const DIR = "C:/Users/Emerson/OneDrive/Desktop/Testes Quantua/AOCP";
const fmt = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
const linhasToText = (linhas: ExtractedRow[]) =>
  linhas.map((l) => `${l.contexto ? l.contexto + " > " : ""}${l.conta} = ${JSON.stringify(l.valores)}`).join("\n");

async function main() {
  const seed = JSON.parse(readFileSync(join(__dirname, "..", "prisma", "seed-data", "account-dictionary.json"), "utf8"));
  const dict: DictionaryEntry[] = seed.map((e: any) => ({ nomeOriginal: e.nomeOriginal, contaDestino: e.contaDestino, grupoConta: e.grupoConta }));
  const bpModel = await loadActiveBPModel(null);
  const dreModel = await loadActiveDREModel(null);

  const files: Array<[string, string]> = [];
  for (const ano of ["2022", "2023", "2024", "2025"]) {
    files.push([`1. Balanço Patrimonial ${ano}- AOCP.pdf`, "Balanço Patrimonial"]);
    files.push([`2. Demonstração de Resultado do Exercicio ${ano} - AOCP.pdf`, "DRE"]);
  }
  const aiDocs: Array<{ raw: string; rawIndent: string; linhas: ExtractedRow[]; tipo: string; periodos: string[] }> = [];
  for (const [f, tipo] of files) {
    const parsed = await parseDocument(readFileSync(`${DIR}/${f}`), f, tipo);
    if (!parsed.linhas.length) { console.log(`⚠ ${f}: 0 linhas no parser`); continue; }
    aiDocs.push({ raw: linhasToText(parsed.linhas), rawIndent: parsed.raw, linhas: parsed.linhas, tipo, periodos: parsed.periodos });
  }

  const r = await extractFinancialsWithAI(aiDocs, [], dict, bpModel, { dreModel });
  const v = validateFinancialData(r.bp, r.dre, r.periodos, r.declarados);
  console.log(`\nperíodos: ${r.periodos.join(", ")} · custo $${r.custo.usd.toFixed(4)}`);
  console.log(`validação: equação=${v.equacaoPatrimonial} dreRecon=${v.reconciliacaoDRE.verificada ? (v.reconciliacaoDRE.ok ? "OK" : "FALHA") : "n/v"}`);

  let falhas = 0;
  for (const p of r.periodos) {
    const ll = r.dre.find((l) => l.conta === "Lucro Líquido")?.valores?.[p] ?? 0;
    const llDecl = r.declarados[p]?.["Lucro Líquido"];
    const ok = llDecl === undefined || Math.abs(ll - llDecl) < 1;
    if (!ok) falhas++;
    console.log(`${p}: ${ok ? "✅" : "❌"} LL=${fmt(ll)}${llDecl !== undefined ? ` decl=${fmt(llDecl)}` : " (sem declarado)"}`);
  }
  for (const al of (v.alertas ?? []).filter((a: any) => a.area === "Reconciliação DRE").slice(0, 8)) console.log(`   ✗ ${al.mensagem}`);

  // Diagnóstico: a árvore DRE veio com hierarquia (filhos) ou achatada?
  const arv = r.arvoreOriginalDRE as Record<string, Array<{ nome: string; valor?: number; filhos?: any[] }>>;
  for (const [p, secoes] of Object.entries(arv ?? {})) {
    const comFilhos = secoes.filter((s) => s.filhos?.length).length;
    console.log(`arvoreDRE ${p}: ${secoes.length} seções, ${comFilhos} com filhos · topo: ${secoes.map((s) => s.nome).slice(0, 8).join(" | ")}`);
  }
  process.exit(falhas ? 1 : 0);
}
main().catch((e) => { console.error("ERRO:", e); process.exit(2); });
