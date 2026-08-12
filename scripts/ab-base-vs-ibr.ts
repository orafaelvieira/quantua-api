/**
 * A/B — BASE DO WORKSPACE × EXTRAÇÃO DO IBR.
 *
 * Antes de fazer o IBR ler a base contábil da empresa (pedido do dono,
 * 11/08/2026), é preciso PROVAR que a base entrega o mesmo número que a
 * extração própria do IBR entrega hoje. "Sem retrocesso" não se garante com
 * boa intenção: se a base perder uma conta, uma coluna ou um centavo, o
 * produto piora e ninguém percebe até o cliente perceber.
 *
 * Este script roda OFFLINE (nenhum custo em produção): para cada IBR que fixou
 * documentos do pool, monta a base restrita aos MESMOS documentos e compara,
 * em quatro níveis:
 *
 *   1. PERÍODOS   — as colunas são as mesmas?
 *   2. CONTAS     — as linhas de BP e DRE são as mesmas?
 *   3. VALORES    — conta a conta, coluna a coluna, ao centavo.
 *   4. PROVAS     — pendências de classificação e árvores de auditoria.
 *
 * Cada achado cai em um de três baldes: IDÊNTICO, DIFERENÇA EXPLICADA (causa
 * conhecida e aceitável, ex.: coluna que só a base tem porque o pool cobre
 * mais período) e DIVERGÊNCIA REAL (o que precisa ser consertado antes do
 * plug). Só o terceiro balde importa para a decisão.
 *
 * Uso:  npx tsx scripts/ab-base-vs-ibr.ts [analysisId ...]
 */
import { prisma } from "../src/db/client";
import { insumosDaBase, montarBaseContabil } from "../src/services/base-contabil";
import { resolveScopeUserIds } from "../src/middleware/auth";
import { resolverCascataDicionario, whereCascataDicionarioAtiva } from "../src/services/dicionario-escopo";
import { loadActiveBPModel, loadActiveDREModel } from "../src/services/model-version";
import { foldBP, foldDRE } from "../src/services/ai-extraction";
import { ordPeriodo } from "../src/services/account-mapper";

type Item = { conta: string; valores: Record<string, number> };

const CENTAVO = 0.005;

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const fmt = (v: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function diffLinhas(rotulo: string, doIBR: Item[], daBase: Item[], periodos: string[]) {
  const mapa = (xs: Item[]) => new Map(xs.map((x) => [norm(x.conta), x]));
  const mIBR = mapa(doIBR), mBase = mapa(daBase);
  const soIBR = [...mIBR.keys()].filter((k) => !mBase.has(k));
  const soBase = [...mBase.keys()].filter((k) => !mIBR.has(k));
  const valores: string[] = [];
  for (const [k, a] of mIBR) {
    const b = mBase.get(k);
    if (!b) continue;
    for (const p of periodos) {
      const va = a.valores?.[p] ?? 0, vb = b.valores?.[p] ?? 0;
      if (Math.abs(va - vb) > CENTAVO) valores.push(`${rotulo} · ${a.conta} · ${p}: IBR ${fmt(va)} × base ${fmt(vb)} (Δ ${fmt(vb - va)})`);
    }
  }
  return { soIBR: soIBR.map((k) => mIBR.get(k)!.conta), soBase: soBase.map((k) => mBase.get(k)!.conta), valores };
}

(async () => {
  const alvo = process.argv.slice(2);
  const analises = await prisma.analysis.findMany({
    where: {
      dadosEstruturados: { not: null },
      ...(alvo.length ? { id: { in: alvo } } : {}),
      documents: { some: { fixadoDeId: { not: null } } },
    },
    select: { id: true, nome: true, userId: true, companyId: true, dadosEstruturados: true,
      documents: { select: { id: true, fixadoDeId: true, tipo: true, status: true } } },
  });

  if (!analises.length) { console.log("Nenhum IBR com documentos fixados do pool — nada a comparar."); return; }

  let reais = 0;
  for (const a of analises) {
    const poolIds = a.documents.filter((d) => d.fixadoDeId && d.status !== "Substituído").map((d) => d.fixadoDeId!);
    const dados = a.dadosEstruturados as unknown as {
      bp?: Item[]; dre?: Item[]; periodos?: string[]; naoMapeados?: unknown[];
    };
    const scope = await resolveScopeUserIds(a.userId);
    const insumos = await insumosDaBase(a.companyId, scope, poolIds);
    const base = await montarBaseContabil(a.companyId, scope, insumos, { paraProduto: true });

    // ── IBR "FRESCO" (mesma mecânica do /refold) ──
    // Comparar com o dadosEstruturados GRAVADO responderia a pergunta errada:
    // ele foi dobrado com o dicionário e os modelos de quando a extração
    // rodou, e desde então o analista classificou contas e os modelos
    // evoluíram. A pergunta que importa é OUTRA: com o MESMO dicionário e os
    // MESMOS modelos de hoje, a base lê os documentos tão bem quanto o IBR?
    // Então re-dobramos as árvores guardadas do IBR aqui, em memória, e é
    // ESSA coluna que vale contra a base.
    const brutos = await prisma.accountDictionary.findMany({
      where: whereCascataDicionarioAtiva(scope, a.companyId),
      select: { nomeOriginal: true, contaDestino: true, grupoConta: true, userId: true, companyId: true, tipo: true },
    });
    const dictRows = [...resolverCascataDicionario(brutos, "BP"), ...resolverCascataDicionario(brutos, "DRE")];
    const bpModel = await loadActiveBPModel(a.companyId);
    const dreModel = await loadActiveDREModel(a.companyId);
    const dadosRef = a.dadosEstruturados as unknown as { arvoreOriginalBP?: unknown; arvoreOriginalDRE?: unknown; arvoresBalancete?: Array<{ periodo?: string; arvoreBP?: unknown; arvoreDRE?: unknown }>; periodos?: string[] };
    const periodosRef = [...(dadosRef.periodos ?? [])].sort((x, y) => ordPeriodo(x) - ordPeriodo(y));
    const bpFresco: Item[] = [], dreFresco: Item[] = [];
    const mergeItens = (alvo: Item[], novos: Item[]) => {
      for (const n of novos) {
        const ex = alvo.find((x) => x.conta === n.conta);
        if (!ex) { alvo.push({ ...n, valores: { ...n.valores } }); continue; }
        for (const [pk, v] of Object.entries(n.valores)) ex.valores[pk] = v;
      }
    };
    let pendFresco = 0;
    if (dadosRef.arvoreOriginalBP) { const r = foldBP(dadosRef.arvoreOriginalBP as never, periodosRef, dictRows, bpModel); mergeItens(bpFresco, r.bp as unknown as Item[]); pendFresco += r.naoMapeados.length; }
    if (dadosRef.arvoreOriginalDRE) { const r = foldDRE(dadosRef.arvoreOriginalDRE as never, periodosRef, dictRows, dreModel); mergeItens(dreFresco, r.dre as unknown as Item[]); pendFresco += r.naoMapeados.length; }
    for (const ab of dadosRef.arvoresBalancete ?? []) {
      if (!ab?.periodo) continue;
      if (ab.arvoreBP) { const r = foldBP(ab.arvoreBP as never, [ab.periodo], dictRows, bpModel); mergeItens(bpFresco, r.bp as unknown as Item[]); pendFresco += r.naoMapeados.length; }
      if (ab.arvoreDRE) { const r = foldDRE(ab.arvoreDRE as never, [ab.periodo], dictRows, dreModel); mergeItens(dreFresco, r.dre as unknown as Item[]); pendFresco += r.naoMapeados.length; }
    }

    const pIBR = dados.periodos ?? [];
    const pBase = base.periodos;
    const soIBR = pIBR.filter((p) => !pBase.includes(p));
    const soBase = pBase.filter((p) => !pIBR.includes(p));
    const comuns = pIBR.filter((p) => pBase.includes(p));

    console.log(`\n══ ${a.nome} (${a.id}) — ${poolIds.length} documento(s) do pool`);
    console.log(`   períodos: IBR [${pIBR.join(", ")}] × base [${pBase.join(", ")}]`);
    if (soIBR.length) { console.log(`   ✗ coluna(s) que a BASE perdeu: ${soIBR.join(", ")}`); reais += soIBR.length; }
    if (soBase.length) console.log(`   • coluna(s) só na base (a explicar): ${soBase.join(", ")}`);

    for (const [rotulo, ibr, bse] of [["BP", bpFresco, base.bp], ["DRE", dreFresco, base.dre]] as const) {
      const d = diffLinhas(rotulo, ibr as Item[], bse as unknown as Item[], comuns);
      if (d.soIBR.length) { console.log(`   ✗ ${rotulo}: ${d.soIBR.length} conta(s) que a base perdeu → ${d.soIBR.slice(0, 6).join(" | ")}`); reais += d.soIBR.length; }
      if (d.soBase.length) console.log(`   • ${rotulo}: ${d.soBase.length} conta(s) só na base → ${d.soBase.slice(0, 6).join(" | ")}`);
      if (d.valores.length) { console.log(`   ✗ ${rotulo}: ${d.valores.length} valor(es) divergente(s):`); for (const v of d.valores.slice(0, 12)) console.log(`       ${v}`); reais += d.valores.length; }
      if (!d.soIBR.length && !d.soBase.length && !d.valores.length) console.log(`   ✓ ${rotulo} idêntico (${(ibr as Item[]).length} contas × ${comuns.length} colunas)`);
    }
    console.log(`   pendências: IBR gravado ${(dados.naoMapeados ?? []).length} · IBR refold ${pendFresco} · base ${base.naoMapeadosDetalhe.length}`);
  }

  console.log(`\n${reais === 0 ? "✓ PARIDADE" : `✗ ${reais} DIVERGÊNCIA(S) REAL(IS)`} — ${analises.length} IBR(s) comparado(s).`);
  await prisma.$disconnect();
  process.exit(reais === 0 ? 0 : 1);
})();
