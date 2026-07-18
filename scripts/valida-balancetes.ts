/**
 * VALIDAÇÃO LOCAL da linha de balancete contra o corpus real (NÃO commitado —
 * PDFs de clientes ficam fora do repo, LGPD). Roda com:
 *
 *   npx tsx scripts/valida-balancetes.ts [pasta]
 *
 * Para cada PDF: extrai texto layout, parseia, converte e imprime as provas
 * (P1 débitos=créditos · P2 fechamento ao centavo). Sai com código 1 se algum
 * documento legível falhar no fechamento.
 */
import fs from "fs";
import path from "path";
import { extrairTextoLayoutPDF } from "../src/services/parser";
import { parseBalanceteTexto } from "../src/services/balancete-parser";
import { converterBalancete } from "../src/services/balancete-conversao";

const PASTA = process.argv[2] ?? "C:/Users/Emerson/OneDrive/Desktop/Testes Quantua/Belagro";
// Escaneados (imagem) — OCR fora da F1
const IGNORAR = [/cahyva/i, /piu\s*max/i];

const fmt = (n: number): string => n.toLocaleString("pt-BR", { minimumFractionDigits: 2 });

function listarPDFs(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listarPDFs(p));
    else if (/\.pdf$/i.test(e.name)) out.push(p);
  }
  return out;
}

async function main(): Promise<void> {
  const pdfs = listarPDFs(PASTA);
  console.log(`Corpus: ${pdfs.length} PDFs em ${PASTA}\n`);
  let falhas = 0, ok = 0, pulados = 0;

  for (const arquivo of pdfs) {
    const nome = path.basename(arquivo);
    if (IGNORAR.some((re) => re.test(nome))) { console.log(`⏭  ${nome} — escaneado (OCR fora da F1)`); pulados++; continue; }

    try {
      const texto = await extrairTextoLayoutPDF(fs.readFileSync(arquivo));
      if (!texto || texto.length < 100) { console.log(`⏭  ${nome} — sem texto extraível (escaneado?)`); pulados++; continue; }

      const parseado = parseBalanceteTexto(texto);
      if (parseado.linhas.length < 10) {
        console.log(`❌ ${nome} — só ${parseado.linhas.length} linhas parseadas (${parseado.avisos.join(" | ")})\n`);
        falhas++;
        continue;
      }
      const conv = converterBalancete(parseado);
      const f = conv.provas.fechamento;
      const p1 = conv.provas.debitosCreditos;

      const status = f.ok ? "✅" : "❌";
      console.log(`${status} ${nome}`);
      console.log(`   período ${conv.periodoBPAnterior ?? "?"} → ${conv.periodoBP || "?"} · ${parseado.linhas.length} linhas · ordem ${parseado.ordemColunas}${conv.provas.exercicioEncerrado ? " · EXERCÍCIO ENCERRADO" : ""}`);
      console.log(`   P2 fechamento: Ativo ${fmt(f.ativo)} − Passivo ${fmt(f.passivo)} − Resultado ${fmt(f.resultadoAcumulado)} = Δ ${fmt(f.delta)}`);
      if (p1) console.log(`   P1 débitos=créditos: ${fmt(p1.debito)} vs ${fmt(p1.credito)} ${p1.ok ? "✅" : "❌"}`);
      for (const a of conv.avisos) console.log(`   ⚠ ${a}`);
      const nDRE = Object.values(conv.arvoreDRE)[0]?.length ?? 0;
      const nBP = Object.keys(Object.values(conv.arvoreBP)[0]?.grupos ?? {}).length;
      console.log(`   árvores: BP ${Object.keys(conv.arvoreBP).length} período(s) × ${nBP} grupos N2 · DRE ${nDRE} seções`);
      console.log("");
      if (f.ok) ok++; else falhas++;
    } catch (err) {
      console.log(`❌ ${nome} — ERRO: ${err instanceof Error ? err.message : String(err)}\n`);
      falhas++;
    }
  }

  console.log(`\n═══ RESULTADO: ${ok} fecham ao centavo · ${falhas} falham · ${pulados} pulados ═══`);
  process.exit(falhas > 0 ? 1 : 0);
}

main();
