/**
 * VALIDAÇÃO DA REFORMA (motor árvore) com os documentos REAIS da Maniacs.
 *
 * Roda o pipeline de produção — parser (texto) → IA (Haiku, bpTreePrompt) → foldBP v2 —
 * sobre os 6 PDFs originais (3 BP + 3 DRE) e confere a COMPOSIÇÃO contra os valores
 * lidos manualmente do balanço. Dicionário = seed oficial (fonte da verdade), sem DB.
 *
 * Rodar: npx tsx scripts/validate-maniacs.ts
 * Custo: ~6 chamadas Haiku sobre texto (centavos). NÃO toca produção nem banco.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parseDocument } from "../src/services/parser";
import { extractFinancialsWithAI } from "../src/services/ai-extraction";
import type { DictionaryEntry } from "../src/services/account-mapper";

const DIR = "G:/.shortcut-targets-by-id/1MjI3vozC1bfAlnMj4J0YG4pcYH4cHLjs/00 ENCERRADOS/MANIACS/FINANCIALS";

// Valores lidos MANUALMENTE dos PDFs originais (verdade de referência).
const ESPERADO: Record<string, Record<string, number>> = {
  "2020": {
    "Passivo Circulante": 9568396.99,
    "Obrigações Tributárias - CP": 2143932.09,
    "Obrigações Trabalhistas - CP": 480539.43,
    "Fornecedores - CP": 3810318.43,
    "Empréstimos e Financiamentos - CP": 784747.13,
    "Passivo Não Circulante": 1864848.59,
    "Obrigações Tributárias - LP": 701005.6,
  },
  "2021": {
    "Passivo Circulante": 8635875.56,
    "Obrigações Tributárias - CP": 2185481.67,
    "Obrigações Trabalhistas - CP": 859532.43,
    "Fornecedores - CP": 3009156.3,
    "Empréstimos e Financiamentos - CP": 785975.94,
    "Passivo Não Circulante": 3169774.73,
    "Obrigações Tributárias - LP": 853705.43,
    "Empréstimos e Financiamentos - LP": 1158515.97,
  },
};

// DRE: Receita Bruta 2021 = Vendas Produtos 7.370.478,49 + Mercadorias 4.260.869,95
// + Serviços 58.207,00 (folhas vistas na captura) — antes caíam em "Outras Receitas".
const ESPERADO_DRE: Record<string, Record<string, number>> = {
  "2021": { "Receita Bruta": 11689555.44 },
};

const fmt = (n: number) => n.toLocaleString("pt-BR", { minimumFractionDigits: 2 });

async function main() {
  // Dicionário oficial (o mesmo que o sync instala no banco).
  const seed = JSON.parse(readFileSync(join(__dirname, "..", "prisma", "seed-data", "account-dictionary.json"), "utf8"));
  const dict: DictionaryEntry[] = seed.map((e: any) => ({ nomeOriginal: e.nomeOriginal, contaDestino: e.contaDestino, grupoConta: e.grupoConta }));
  console.log(`Dicionário: ${dict.length} entradas (seed oficial)\n`);

  // Parser sobre os 6 PDFs (mesmo caminho da produção).
  const files = readdirSync(DIR).filter((f) => /\.(pdf)$/i.test(f) && !/balancete/i.test(f));
  const docs: Array<{ raw?: string; buffer?: Buffer; tipo: string; periodos?: string[] }> = [];
  for (const f of files) {
    const buffer = readFileSync(join(DIR, f));
    const tipo = /balan/i.test(f) ? "Balanço Patrimonial" : "DRE";
    try {
      const parsed = await parseDocument(buffer, f, tipo);
      const temTexto = (parsed.raw ?? "").trim().length > 200;
      docs.push(temTexto ? { raw: parsed.raw, tipo, periodos: parsed.periodos } : { buffer, tipo, periodos: parsed.periodos });
      console.log(`parse: ${f} → ${parsed.linhas.length} linhas, períodos=${JSON.stringify(parsed.periodos)}, via ${temTexto ? "TEXTO (Haiku)" : "PDF (visão)"}`);
    } catch (e: any) {
      console.log(`parse FALHOU: ${f} → ${e?.message} — usando PDF (visão)`);
      docs.push({ buffer, tipo });
    }
  }

  console.log("\nExtraindo com IA (árvore completa)…");
  const r = await extractFinancialsWithAI(docs, [], dict);
  console.log(`arvoreBP keys: ${JSON.stringify(Object.keys(r.arvoreOriginalBP))} | arvoreDRE keys: ${JSON.stringify(Object.keys(r.arvoreOriginalDRE))} | periodos: ${JSON.stringify(r.periodos)}`);
  console.log(`custo: $${r.custo.usd.toFixed(4)} (${r.custo.modelo}; ${r.custo.inputTokens}+${r.custo.outputTokens} tk)\n`);

  // Profundidade da árvore capturada (prova de que a hierarquia veio).
  const prof = (itens: any[]): number => itens.reduce((m, it) => Math.max(m, 1 + (it.filhos?.length ? prof(it.filhos) : 0)), 0);
  for (const [p, cap] of Object.entries(r.arvoreOriginalBP)) {
    const grupos = Object.entries((cap as any).grupos ?? {});
    console.log(`árvore ${p}: ${grupos.map(([g, its]: any) => `${g}=${its.length} nós/prof.${prof(its)}`).join(" · ")}`);
  }

  // Composição vs esperado.
  let falhas = 0;
  const val = (conta: string, p: string) => r.bp.find((l) => l.conta === conta)?.valores?.[p] ?? 0;
  console.log("\n── COMPOSIÇÃO vs DOCUMENTO ──");
  for (const [p, contas] of Object.entries(ESPERADO)) {
    const periodo = r.periodos.find((x) => x.includes(p));
    if (!periodo) { console.log(`✗ período ${p} NÃO encontrado (períodos: ${r.periodos.join(", ")})`); falhas++; continue; }
    for (const [conta, esperado] of Object.entries(contas)) {
      const obtido = val(conta, periodo);
      const ok = Math.abs(obtido - esperado) <= Math.max(1, esperado * 0.001);
      if (!ok) falhas++;
      console.log(`${ok ? "✓" : "✗"} ${p} ${conta}: obtido ${fmt(obtido)} | esperado ${fmt(esperado)}`);
    }
    const outrosPC = val("Outros Passivos Circulantes", periodo);
    const outrosPNC = val("Outros Passivos não Circulantes", periodo);
    console.log(`  (info) ${p} Outros PC = ${fmt(outrosPC)} · Outros PNC = ${fmt(outrosPNC)}`);
  }

  console.log("\n── DRE vs DOCUMENTO ──");
  const valDRE = (conta: string, p: string) => r.dre.find((l) => l.conta === conta)?.valores?.[p] ?? 0;
  for (const [p, contas] of Object.entries(ESPERADO_DRE)) {
    const periodo = r.periodos.find((x) => x.includes(p));
    if (!periodo) { console.log(`✗ período ${p} (DRE) não encontrado`); falhas++; continue; }
    for (const [conta, esperado] of Object.entries(contas)) {
      const obtido = valDRE(conta, periodo);
      const ok = Math.abs(obtido - esperado) <= Math.max(1, esperado * 0.001);
      if (!ok) falhas++;
      console.log(`${ok ? "✓" : "✗"} ${p} ${conta}: obtido ${fmt(obtido)} | esperado ${fmt(esperado)}`);
    }
    console.log(`  (info) ${p} Outras Receitas Op. = ${fmt(valDRE("Outras Receitas Operacionais", periodo))} · Lucro Líquido = ${fmt(valDRE("Lucro Líquido", periodo))} · declarado LL = ${fmt(r.declarados[periodo]?.["Lucro Líquido"] ?? 0)}`);
  }

  console.log(`\nnão mapeadas: ${r.naoMapeados.length}`);
  for (const nm of r.naoMapeados.slice(0, 15)) console.log(`  - [${nm.tipo}] ${nm.periodo} ${nm.grupo}: "${nm.nome}" = ${fmt(nm.valor)} → ${nm.destino}`);
  console.log(`alertas de composição: ${r.alertasComposicao.length}`);
  for (const a of r.alertasComposicao) console.log(`  ! ${a.periodo} ${a.grupo} "${a.caminho}": declarado ${fmt(a.declarado)} vs filhos ${fmt(a.somaFilhos)} (delta ${fmt(a.delta)})`);

  console.log(`\n${falhas === 0 ? "✅ TODAS as verificações passaram" : `❌ ${falhas} verificação(ões) FALHARAM`}`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((e) => { console.error("ERRO:", e); process.exit(2); });
