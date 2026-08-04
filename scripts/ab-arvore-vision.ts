/**
 * A/B DA ÁRVORE — o critério de aceite correto para ligar o Vision no BP/DRE.
 *
 * A primeira tentativa comparava a CONTAGEM DE RECUOS entre o texto original e o
 * reconstruído, e isso não é o que importa. O que importa é a ÁRVORE que
 * `construirArvoreBPporIndentacao` monta: é ela que vira o Balanço na tela.
 *
 * Aqui, para cada PDF do corpus COM camada de texto:
 *   A) monta a árvore a partir do texto original (gabarito);
 *   B) monta a árvore a partir do texto reconstruído da GEOMETRIA (o que o
 *      Vision entregaria num documento escaneado);
 * e compara as duas. Se divergirem, ligar o Vision no BP/DRE é regressão.
 */
import * as fs from "fs";
import { textoLayoutDasPaginas, type Palavra } from "../src/services/ocr-vision";
import { construirArvoreBPporIndentacao } from "../src/services/bp-tree-indent";
import type { ParsedDocument } from "../src/services/parser";

const path = require("path") as typeof import("path");
const RAIZES = [
  "C:/Users/Emerson/OneDrive/Desktop/DCTOS_TESTE_SISTEMA",
  "C:/Users/Emerson/OneDrive/Desktop/Testes Quantua",
];

function pdfs(dir: string, prof = 0): string[] {
  if (prof > 3 || !fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...pdfs(p, prof + 1));
    else if (/\.pdf$/i.test(e.name)) out.push(p);
  }
  return out;
}

/** Assinatura da árvore: nome + valor + profundidade, em ordem. */
function assinatura(arvore: any): string {
  const partes: string[] = [];
  const anda = (itens: any[], prof: number): void => {
    for (const i of itens ?? []) {
      partes.push(`${prof}|${String(i?.nome ?? "").trim()}|${Number(i?.valor ?? 0).toFixed(2)}`);
      if (Array.isArray(i?.filhos)) anda(i.filhos, prof + 1);
    }
  };
  for (const periodo of Object.keys(arvore ?? {}).sort()) {
    const v: any = (arvore as any)[periodo];
    const grupos = Array.isArray(v) ? v : Object.values(v?.grupos ?? {}).flat();
    partes.push(`[${periodo}]`);
    anda(grupos as any[], 0);
  }
  return partes.join("\n");
}

async function palavrasDoPdf(buffer: Buffer): Promise<Palavra[][]> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const paginas: Palavra[][] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const pg = await doc.getPage(n);
    const vp = pg.getViewport({ scale: 1 });
    const c = await pg.getTextContent();
    const palavras: Palavra[] = [];
    for (const it of c.items as any[]) {
      const bruto = String(it?.str ?? "");
      if (!bruto.trim() || !it?.transform) continue;
      const altura = Math.abs(it.transform[3]) || 10;
      const largura = it.width || bruto.length * altura * 0.5;
      const larguraChar = largura / Math.max(1, bruto.length);
      // O item do pdfjs pode trazer VÁRIAS palavras; o Vision devolveria uma
      // caixa por palavra. Quebrar aqui aproxima as duas fontes.
      let cursor = 0;
      for (const parte of bruto.split(/(\s+)/)) {
        if (parte.trim()) {
          palavras.push({
            t: parte,
            x: it.transform[4] + cursor * larguraChar,
            y: vp.height - it.transform[5],
            w: parte.length * larguraChar,
            h: altura,
          });
        }
        cursor += parte.length;
      }
    }
    paginas.push(palavras);
  }
  return paginas;
}

async function main() {
  const { extrairTextoLayoutPDF } = await import("../src/services/parser");
  const P = ["31/12/2024"];
  let comparados = 0, identicas = 0, ambasNulas = 0;
  const divergentes: string[] = [];
  const perdidas: string[] = [];

  for (const caminho of RAIZES.flatMap((r) => pdfs(r)).sort()) {
    const nome = path.basename(caminho);
    try {
      const buf = fs.readFileSync(caminho);
      const original = await extrairTextoLayoutPDF(buf);
      if (original.trim().length < 600) continue;

      const arvoreA = construirArvoreBPporIndentacao({ raw: original } as ParsedDocument, P);
      if (!arvoreA) continue; // sem árvore no gabarito: nada a comparar

      const geo = await palavrasDoPdf(buf);
      const reconstruido = textoLayoutDasPaginas(geo.map((palavras) => ({ palavras })));
      const arvoreB = construirArvoreBPporIndentacao({ raw: reconstruido } as ParsedDocument, P);

      comparados++;
      if (!arvoreB) { perdidas.push(nome); continue; }
      if (assinatura(arvoreA) === assinatura(arvoreB)) identicas++;
      else divergentes.push(nome);
    } catch {
      /* ilegível por uma das vias — fora da comparação */
    }
  }

  console.log(`documentos com árvore de BP no gabarito: ${comparados}`);
  console.log(`  árvore IDÊNTICA pela geometria: ${identicas} (${((100 * identicas) / Math.max(1, comparados)).toFixed(1)}%)`);
  console.log(`  árvore DIVERGENTE: ${divergentes.length}`);
  console.log(`  árvore PERDIDA (não monta): ${perdidas.length}`);
  for (const d of perdidas.slice(0, 8)) console.log("     perdida -", d);
  for (const d of divergentes.slice(0, 8)) console.log("     diverge -", d);
  if (ambasNulas) console.log(`  (ambas nulas: ${ambasNulas})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
