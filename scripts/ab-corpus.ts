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

/**
 * A ASSINATURA TEM DE ENXERGAR O QUE A MUDANÇA MEXE (03/08/2026 — a revisão
 * adversarial barrou o plano dos grupos-espelho justamente aqui). Antes, a
 * assinatura só gravava fechamento + P3: uma mudança que reorganiza a ÁRVORE
 * DA DRE, troca `exercicioEncerrado` (que muda a DRE de saldo para movimento)
 * ou mexe na linha "Resultado do Período" do PL passava com assinatura
 * byte-idêntica. "Não mudou, logo nada regrediu" só vale se a régua mede.
 */
function achatar(itens: any[], prof = 0): string[] {
  const out: string[] = [];
  for (const i of itens ?? []) {
    out.push(`${"·".repeat(prof)}${String(i?.nome ?? "?").trim()}=${f(Number(i?.valor ?? 0))}`);
    if (Array.isArray(i?.filhos) && i.filhos.length) out.push(...achatar(i.filhos, prof + 1));
  }
  return out;
}
/** Composição da DRE por período: nome, valor e hierarquia de cada seção. */
function assinaturaDRE(c: any): string {
  const arv = c?.arvoreDRE ?? {};
  const partes: string[] = [];
  for (const periodo of Object.keys(arv).sort()) {
    const v: any = (arv as any)[periodo];
    partes.push(`${periodo}[${achatar(Array.isArray(v) ? v : (v?.secoes ?? [])).join(";")}]`);
  }
  return `dre{${partes.join("|")}}`;
}
/** Composição do BP por período (inclui a linha de Resultado do Período no PL). */
function assinaturaBP(c: any): string {
  const arv = c?.arvoreBP ?? {};
  const partes: string[] = [];
  for (const periodo of Object.keys(arv).sort()) {
    const v: any = (arv as any)[periodo];
    // ArvoreOriginalBP é Record<periodo, { grupos: Record<nomeGrupo, BPN3Item[]> }>:
    // sem descer em `.grupos` a assinatura virava a constante "grupos=0.00" e
    // dois balanços completamente diferentes davam a MESMA string.
    const grupos = Array.isArray(v)
      ? v
      : Object.entries((v as any)?.grupos ?? {}).map(([g, itens]) => ({ nome: g, valor: 0, filhos: itens }));
    partes.push(`${periodo}[${achatar(grupos as any[]).join(";")}]`);
  }
  return `bp{${partes.join("|")}}`;
}
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
        linhas.push(`${nome}|${p.linhas.length}|${c.periodoBP}|${f(pr.fechamento.ativo)}|${f(pr.fechamento.passivo)}|${f(pr.fechamento.resultadoAcumulado)}|${f(pr.fechamento.delta)}|${pr.linhas.coerentes}/${pr.linhas.total}|${assinaturaDRE(c)}|${assinaturaBP(c)}|enc=${c.provas?.exercicioEncerrado === true ? 1 : 0}`);
      } catch (e: any) { linhas.push(`${nome}|ERRO:${e?.message ?? e}`); }
    }
  }
  const saida = linhas.join("\n");
  console.log(saida);
  console.log("\n--- assinatura:", require("crypto").createHash("md5").update(saida).digest("hex"));
}
main().catch((e) => { console.error(e); process.exit(1); });
