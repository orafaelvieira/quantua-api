/**
 * Onde a limpeza do nome cria COLISÃO dentro do mesmo documento — duas contas
 * virando uma chave só. Roda a função de produção sobre a assinatura do corpus.
 */
import * as fs from "fs";
import { limparNomeConta } from "../src/services/nome-conta";

const arq = process.argv[2];
const linhas = fs.readFileSync(arq, "utf-8").split("\n").filter(Boolean).map((l) => {
  const i = l.indexOf("|"), j = l.lastIndexOf("|");
  return { doc: l.slice(0, i), nome: l.slice(i + 1, j), val: l.slice(j + 1) };
});

const porDoc = new Map<string, typeof linhas>();
for (const r of linhas) (porDoc.get(r.doc) ?? porDoc.set(r.doc, []).get(r.doc)!).push(r);

let mud = 0, colTotal = 0;
const relatorio: string[] = [];
for (const [doc, rs] of porDoc) {
  const antes = new Map<string, number>(), depois = new Map<string, { q: number; vals: string[] }>();
  let mudDoc = 0;
  for (const r of rs) {
    antes.set(r.nome, (antes.get(r.nome) ?? 0) + 1);
    const c = limparNomeConta(r.nome);
    if (c !== r.nome) mudDoc++;
    const d = depois.get(c) ?? { q: 0, vals: [] };
    d.q++; d.vals.push(r.val); depois.set(c, d);
  }
  mud += mudDoc;
  const novas = [...depois].filter(([n, d]) => d.q > 1 && d.q > (antes.get(n) ?? 0));
  // PERIGOSA = valores DIFERENTES e algum diferente de zero: aí a colisão
  // esconde dinheiro. Valores iguais (pai/filho único) ou zerados não movem nada.
  const perigosas = novas.filter(([, d]) => new Set(d.vals).size > 1 && d.vals.some((v) => Math.abs(Number(v)) > 0.005));
  if (perigosas.length) {
    console.log(`!! PERIGOSA em ${doc}`);
    for (const [n, d] of perigosas) console.log(`     "${n}" -> ${d.vals.join(" / ")}`);
  }
  colTotal += novas.length;
  if (novas.length) {
    relatorio.push(`\n== ${doc}  (${rs.length} linhas · ${mudDoc} nomes limpos · ${novas.length} colisões)`);
    for (const [n, d] of novas.slice(0, 8)) relatorio.push(`   "${n}" x${d.q}  valores: ${d.vals.join(" / ")}`);
  }
}
console.log(`linhas ${linhas.length} · nomes limpos ${mud} · documentos com colisão nova ${relatorio.filter((r) => r.startsWith("\n==")).length} · colisões ${colTotal}`);
console.log(relatorio.join("\n"));
