/**
 * A/B do CÓDIGO COLADO NO NOME (13/08/2026, pergunta do dono: "por que algumas
 * contas vão para o dicionário no formato da primeira e segunda linha?").
 *
 * Roda o parser sobre TODO o corpus e imprime, por documento, quantos nomes de
 * conta chegam com o código contábil grudado ("4.03.02.01 PROCESSO …") e a
 * assinatura numérica (nome=valor). Rodar antes e depois da mudança: os VALORES
 * têm de ficar idênticos; só os nomes mudam.
 */
import * as fs from "fs";
import { parsePDF, parseExcel } from "../src/services/parser";
const path = require("path") as typeof import("path");

const RAIZES = ["C:/Users/Emerson/OneDrive/Desktop/DCTOS_TESTE_SISTEMA", "C:/Users/Emerson/OneDrive/Desktop/Testes Quantua"];
const RE_CODIGO = /^\d+(\.\d+)+\s+\S/;

function arquivos(dir: string, prof = 0): string[] {
  if (prof > 3 || !fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...arquivos(p, prof + 1));
    else if (/\.(pdf|xlsx?|xlsm)$/i.test(e.name)) out.push(p);
  }
  return out;
}

(async () => {
  const arqs = arquivos(RAIZES[0]).concat(arquivos(RAIZES[1]));
  let comCodigo = 0, total = 0, docsAfetados = 0;
  const linhas: string[] = [];
  for (const a of arqs) {
    let doc: { linhas?: Array<{ conta: string; valores: Record<string, number> }> } | null = null;
    try {
      const buf = fs.readFileSync(a);
      const tipo = /dre|resultado/i.test(path.basename(a)) ? "DRE" : "BP";
      doc = /\.pdf$/i.test(a) ? await parsePDF(buf, tipo, path.basename(a)) : parseExcel(buf, tipo);
    } catch { continue; }
    const rows = (doc as any)?.linhas ?? [];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const nCod = rows.filter((r: any) => RE_CODIGO.test(String(r.conta ?? "").trim())).length;
    total += rows.length;
    comCodigo += nCod;
    if (nCod > 0) docsAfetados++;
    for (const r of rows) {
      const soma = Object.values(r.valores ?? {}).reduce((s: number, v) => s + Number(v ?? 0), 0);
      linhas.push(`${path.basename(a)}|${String(r.conta).trim()}|${soma.toFixed(2)}`);
    }
  }
  console.log(`documentos lidos: ${arqs.length} · linhas: ${total}`);
  console.log(`nomes com código colado: ${comCodigo} em ${docsAfetados} documento(s)`);
  fs.writeFileSync(process.argv[2] ?? "assinatura-codigo.txt", linhas.join("\n"), "utf-8");
  console.log(`assinatura gravada em ${process.argv[2] ?? "assinatura-codigo.txt"}`);
})();
