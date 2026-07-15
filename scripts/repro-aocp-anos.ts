/**
 * REPRO AOCP — os 4 pares BP+DRE (2022..2025) pelo pipeline completo; prova:
 * LL calculado = declarado e equação patrimonial. Rodar: npx tsx scripts/repro-aocp-anos.ts
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
  let falhas = 0;

  for (const ano of ["2022", "2023", "2024", "2025"]) {
    const bpFile = `1. Balanço Patrimonial ${ano}- AOCP.pdf`;
    const dreFile = `2. Demonstração de Resultado do Exercicio ${ano} - AOCP.pdf`;
    const docs = [] as Array<{ raw: string; tipo: string; periodos: string[] }>;
    for (const [f, tipo] of [[bpFile, "Balanço Patrimonial"], [dreFile, "DRE"]] as const) {
      const parsed = await parseDocument(readFileSync(`${DIR}/${f}`), f, tipo);
      docs.push({ raw: parsed.raw, tipo, periodos: parsed.periodos });
    }
    const r = await extractFinancialsWithAI(docs, [], dict);
    const v = validateFinancialData(r.bp, r.dre, r.periodos, r.declarados);
    const p0 = r.periodos[0];
    const ll = r.dre.find((l) => l.conta === "Lucro Líquido")?.valores?.[p0] ?? 0;
    const llDecl = r.declarados[p0]?.["Lucro Líquido"];
    const dreOk = !v.reconciliacaoDRE.verificada || v.reconciliacaoDRE.ok;
    const ok = v.equacaoPatrimonial && dreOk && (llDecl === undefined || Math.abs(ll - llDecl) < 1);
    if (!ok) falhas++;
    console.log(`${ano} (${p0}): ${ok ? "✅" : "❌"} equação=${v.equacaoPatrimonial} dreRecon=${v.reconciliacaoDRE.verificada ? (v.reconciliacaoDRE.ok ? "OK" : "FALHA") : "n/v"} · LL=${fmt(ll)}${llDecl !== undefined ? ` decl=${fmt(llDecl)}` : ""} · âmbar=${r.naoMapeados.length} alertas=${r.alertasComposicao.length}`);
    for (const al of (v.alertas ?? []).filter((a: any) => a.area === "Reconciliação DRE").slice(0, 3)) console.log(`   ✗ ${al.mensagem}`);
  }
  console.log(falhas ? `\n${falhas} ano(s) com falha` : "\nTODOS os anos fecham");
  process.exit(falhas ? 1 : 0);
}
main().catch((e) => { console.error("ERRO:", e); process.exit(2); });
