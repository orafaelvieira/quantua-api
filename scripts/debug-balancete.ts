/** Debug local: npx tsx scripts/debug-balancete.ts "<pdf>" [--texto|--linhas|--raizes|--grupos <raiz>] */
import fs from "fs";
import { extrairTextoLayoutPDF } from "../src/services/parser";
import { parseBalanceteTexto } from "../src/services/balancete-parser";
import { prepararArvore, folhasDe, convencaoImpressao, type No } from "../src/services/balancete-conversao";

async function main(): Promise<void> {
  const arquivo = process.argv[2];
  const modo = process.argv[3] ?? "--raizes";
  const texto = await extrairTextoLayoutPDF(fs.readFileSync(arquivo));

  if (modo === "--texto") {
    console.log(texto.slice(0, Number(process.argv[4] ?? 6000)));
    return;
  }

  const p = parseBalanceteTexto(texto);
  console.log(`período: ${p.periodoInicio} → ${p.periodoFim} · ordem ${p.ordemColunas} · ${p.linhas.length} linhas · totais ${JSON.stringify(p.totais)}`);
  console.log(`avisos: ${p.avisos.join(" | ") || "-"}`);

  if (modo === "--linhas") {
    const de = Number(process.argv[4] ?? 0), ate = Number(process.argv[5] ?? 40);
    for (const l of p.linhas.slice(de, ate)) {
      console.log(`n${l.nivel} [${l.classificacao}] ${l.nome}${l.sintetica ? " (S)" : ""} | ant ${l.saldoAnterior}${l.naturezaAnterior ?? ""} d ${l.debito} c ${l.credito} atual ${l.saldoAtual}${l.naturezaAtual ?? ""}`);
    }
    return;
  }

  if (modo === "--grupos" || modo === "--check") {
    const alvo = process.argv[4];
    const { grupos, naturezas } = prepararArvore(p);
    const real = (l: (typeof p.linhas)[number]): number =>
      (naturezas.get(l) === "C" ? 1 : -1) * Math.abs(l.saldoAtual);
    for (const g of grupos) {
      const folhas = folhasDe(g.no);
      const soma = folhas.reduce((s, f) => s + real(f), 0);
      console.log(`RAIZ [${g.no.linha.classificacao}] ${g.no.linha.nome} (${g.tipo}): saldoRaiz ${g.no.linha.saldoAtual}${g.no.linha.naturezaAtual ?? ""} · Σfolhas(assinado DRE) ${soma.toFixed(2)} · ${folhas.length} folhas`);
      if (modo === "--check") {
        // localiza pais cuja soma dos filhos diverge do saldo impresso
        const walk = (no: No): void => {
          if (!no.filhos.length) return;
          const alvoPai = real(no.linha);
          const somaF = no.filhos.reduce((s, f) => s + folhasDe(f).reduce((x, l) => x + real(l), 0), 0);
          if (Math.abs(somaF - alvoPai) > 0.05) {
            console.log(`   DIVERGE [${no.linha.classificacao}] ${no.linha.nome}: pai ${alvoPai.toFixed(2)} vs Σfilhos ${somaF.toFixed(2)} (Δ ${(somaF - alvoPai).toFixed(2)})`);
          }
          no.filhos.forEach(walk);
        };
        walk(g.no);
      }
      if (modo === "--grupos" && alvo && g.no.linha.classificacao === alvo) {
        for (const f of folhas) {
          console.log(`   [${f.classificacao}] ${f.nome} | ant ${f.saldoAnterior}${f.naturezaAnterior ?? ""} d ${f.debito} c ${f.credito} atual ${f.saldoAtual}${f.naturezaAtual ?? ""} → eq ${convencaoImpressao(f) ?? "?"} nat ${naturezas.get(f)}`);
        }
      }
    }
    return;
  }

  // --raizes: linhas de nível 1 e 2
  for (const l of p.linhas.filter((x) => x.nivel <= 2)) {
    console.log(`n${l.nivel} [${l.classificacao}] ${l.nome} | ant ${l.saldoAnterior}${l.naturezaAnterior ?? ""} atual ${l.saldoAtual}${l.naturezaAtual ?? ""}`);
  }
}

main();
