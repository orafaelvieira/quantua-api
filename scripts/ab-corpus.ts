/** A/B: assinatura numérica de todo o corpus real. Rodar antes e depois de
 *  qualquer mudança no motor — divergência = regressão. */
import * as fs from "fs";
import { extrairTextoLayoutPDF } from "../src/services/parser";
import { parseBalanceteTexto } from "../src/services/balancete-parser";
import { parseBalanceteTabular } from "../src/services/balancete-tabular";
import { converterBalancete } from "../src/services/balancete-conversao";
const RAIZES = ["C:/Users/Emerson/OneDrive/Desktop/DCTOS_TESTE_SISTEMA", "C:/Users/Emerson/OneDrive/Desktop/Testes Quantua"];
const path = require("path") as typeof import("path");
function arquivos(dir: string, prof = 0): string[] {
  if (prof > 3 || !fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...arquivos(p, prof + 1));
    else if (/\.(pdf|csv|xlsx?|xlsm)$/i.test(e.name) && /balanc/i.test(e.name)) out.push(p);
  }
  return out;
}
const f = (n: number) => n.toFixed(2);
async function main() {
  const linhas: string[] = [];
  const todos = RAIZES.flatMap((r) => arquivos(r)).sort();
  {
    for (const caminho of todos) {
      const nome = path.basename(caminho);
      try {
        const buf = fs.readFileSync(caminho);
        const ano = nome.match(/(20\d{2})/)?.[1] ?? null;
        const p = /\.pdf$/i.test(nome)
          ? parseBalanceteTexto(await extrairTextoLayoutPDF(buf))
          : parseBalanceteTabular(buf, nome, ano);
        if (p.linhas.length === 0) { linhas.push(`${nome}|SEM_LINHAS`); continue; }
        const c: any = converterBalancete(p);
        const pr = c.provas;
        linhas.push(`${nome}|${p.linhas.length}|${c.periodoBP}|${f(pr.fechamento.ativo)}|${f(pr.fechamento.passivo)}|${f(pr.fechamento.resultadoAcumulado)}|${f(pr.fechamento.delta)}|${pr.linhas.coerentes}/${pr.linhas.total}`);
      } catch (e: any) { linhas.push(`${nome}|ERRO:${e?.message ?? e}`); }
    }
  }
  const saida = linhas.join("\n");
  console.log(saida);
  console.log("\n--- assinatura:", require("crypto").createHash("md5").update(saida).digest("hex"));
}
main().catch((e) => { console.error(e); process.exit(1); });
