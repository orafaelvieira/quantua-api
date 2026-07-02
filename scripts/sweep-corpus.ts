/**
 * SWEEP do corpus (5 casos, PDF texto, BP+DRE) com o motor ÁRVORE — critério de
 * produção: validateFinancialData (score 5/5 = "fecha"). Reporta composição,
 * não-mapeadas, alertas e custo por caso. Rodar: npx tsx scripts/sweep-corpus.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { parseDocument } from "../src/services/parser";
import { normalizePeriods } from "../src/services/account-mapper";
import { extractFinancialsWithAI } from "../src/services/ai-extraction";
import { validateFinancialData } from "../src/services/validation";
import type { DictionaryEntry } from "../src/services/account-mapper";

const DIR = "C:/Users/Emerson/OneDrive/Desktop/DCTOS_TESTE_SISTEMA";
const CASOS: Array<[string, string[]]> = [
  ["AçãoCorretora 2022 (SPED)", ["AçãoCorretora_BP_2022_SPED.pdf", "AçãoCorretora_DRE_2022_SPED.pdf"]],
  ["Fibracabos 2022", ["Fibracabos_BP_2022.pdf", "Fibracabos_DRE_2022.pdf"]],
  ["PEDREIRA SJ 2022", ["PEDREIRA SJ_BP_2022.pdf", "PEDREIRA SJ_DRE_2022.pdf"]],
  ["OCEANDROP 2023", ["OCEANDROP - Balanço 2023 - Assinado.pdf", "OCEANDROP - DRE 2023 - Assinado.pdf"]],
  ["TECHWAY 2023", ["TECHWAY -- BALANÇO 2023.pdf", "TECHWAY -- DRE 2023.pdf"]],
];
const fmt = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 0 });

async function main() {
  const seed = JSON.parse(readFileSync(join(__dirname, "..", "prisma", "seed-data", "account-dictionary.json"), "utf8"));
  const dict: DictionaryEntry[] = seed.map((e: any) => ({ nomeOriginal: e.nomeOriginal, contaDestino: e.contaDestino, grupoConta: e.grupoConta }));
  let fecham = 0, custoTotal = 0;

  for (const [nome, files] of CASOS) {
    console.log(`\n════ ${nome} ════`);
    const parsedDocs: Array<{ parsed: Awaited<ReturnType<typeof parseDocument>>; tipo: string }> = [];
    const buffers: Buffer[] = [];
    for (const f of files) {
      const tipo = /balan|_bp_|\bbp\b/i.test(f) ? "Balanço Patrimonial" : "DRE";
      const buffer = readFileSync(join(DIR, f));
      buffers.push(buffer);
      parsedDocs.push({ parsed: await parseDocument(buffer, f, tipo), tipo });
    }
    const docs = parsedDocs.map((d) => ({ raw: d.parsed.raw, tipo: d.tipo, periodos: d.parsed.periodos }));
    let r = await extractFinancialsWithAI(docs, [], dict);
    custoTotal += r.custo.usd;
    let v = validateFinancialData(r.bp, r.dre, r.periodos, r.declarados);
    const scoreDe = (vv: any) => (vv.equacaoPatrimonial?1:0)+(vv.composicaoAtivo?1:0)+(vv.composicaoPassivo?1:0)+(vv.detalheCompleto?1:0)+((!vv.reconciliacaoDRE.verificada||vv.reconciliacaoDRE.ok)?1:0);
    let nivel = "híbrido (Haiku)";
    if (scoreDe(v) < 5) {
      // Nível 3 da cascata: VISÃO (Sonnet lê o PDF) — igual à produção quando não fecha.
      const visDocs = parsedDocs.map((d, i) => ({ buffer: buffers[i], tipo: d.tipo, periodos: d.parsed.periodos }));
      const rv = await extractFinancialsWithAI(visDocs, [], dict);
      custoTotal += rv.custo.usd;
      const vv = validateFinancialData(rv.bp, rv.dre, rv.periodos, rv.declarados);
      if (scoreDe(vv) > scoreDe(v)) { r = rv; v = vv; nivel = "VISÃO (Sonnet)"; }
      else nivel = `híbrido (visão não melhorou: ${scoreDe(vv)}/5)`;
    }
    console.log(`nível vencedor: ${nivel}`);
    const dreOk = !v.reconciliacaoDRE.verificada || v.reconciliacaoDRE.ok;
    const score = (v.equacaoPatrimonial ? 1 : 0) + (v.composicaoAtivo ? 1 : 0) + (v.composicaoPassivo ? 1 : 0) + (v.detalheCompleto ? 1 : 0) + (dreOk ? 1 : 0);
    if (score === 5) fecham++;

    const val = (conta: string, p: string) => r.bp.find((l) => l.conta === conta)?.valores?.[p] ?? 0;
    const p0 = r.periodos[0];
    const at = val("Ativo Total", p0), pt = val("Passivo Total", p0);
    const outros = ["Outros Ativos Circulantes", "Outros Ativos Não Circulantes", "Outros Passivos Circulantes", "Outros Passivos não Circulantes"]
      .reduce((s, c) => s + Math.abs(val(c, p0)), 0);
    const pctOutros = at ? (outros / Math.abs(at)) * 100 : 0;
    const ll = r.dre.find((l) => l.conta === "Lucro Líquido")?.valores?.[p0] ?? 0;
    const llDecl = r.declarados[p0]?.["Lucro Líquido"];

    console.log(`score: ${score}/5 ${score === 5 ? "✅ FECHA" : "⚠"} · equação=${v.equacaoPatrimonial} compAtivo=${v.composicaoAtivo} compPassivo=${v.composicaoPassivo} detalhe=${v.detalheCompleto} dreRecon=${v.reconciliacaoDRE.verificada ? (v.reconciliacaoDRE.ok ? "OK" : "FALHA") : "não verificada"}`);
    console.log(`períodos: ${r.periodos.join(", ")} · AT=${fmt(at)} PT=${fmt(pt)} · Outros=${fmt(outros)} (${pctOutros.toFixed(1)}% do AT)`);
    console.log(`LL calculado=${fmt(ll)}${llDecl !== undefined ? ` · declarado=${fmt(llDecl)} ${Math.abs(ll - llDecl) < Math.max(1, Math.abs(llDecl) * 0.01) ? "✓" : "✗"}` : " · (sem declarado)"}`);
    console.log(`não mapeadas: ${r.naoMapeados.length} · alertas composição: ${r.alertasComposicao.length} · custo $${r.custo.usd.toFixed(4)}`);
    for (const a of r.alertasComposicao.slice(0, 4)) console.log(`  ! ${a.periodo} ${a.grupo} "${a.caminho}": ${fmt(a.declarado)} vs filhos ${fmt(a.somaFilhos)} (Δ ${fmt(a.delta)})`);
    for (const al of v.alertas.filter((a: any) => a.area === "Reconciliação DRE").slice(0, 3)) console.log(`  ✗ ${al.mensagem}`);
    for (const nm of r.naoMapeados.slice(0, 6)) console.log(`  - [${nm.tipo}] "${nm.nome}" = ${fmt(nm.valor)} (${nm.grupo})`);
  }
  console.log(`\n══════ RESUMO: ${fecham}/${CASOS.length} fecham 5/5 · custo total $${custoTotal.toFixed(4)} ══════`);
}
main().catch((e) => { console.error("ERRO:", e); process.exit(2); });
