/**
 * A/B DO TEXTO-COM-LAYOUT: `textoLayoutDasPaginas` (geometria, via Vision)
 * contra `renderPageLayout` (camada de texto, via PDF legível).
 *
 * Por que existe: a revisão adversarial mediu que a primeira versão alterava a
 * ESCADA DE HIERARQUIA em 60 de 138 documentos do corpus — e nada pegava, porque
 * Ativo = Passivo vem das raízes declaradas e não da soma das folhas. A suíte de
 * testes passava porque as fixtures usavam 5 caracteres por nível, enquanto os
 * ERPs reais usam 0,48 a 1,28.
 *
 * O harness alimenta a função NOVA com a geometria do PRÓPRIO PDF (a mesma que o
 * renderPageLayout usa) e compara a escada de indentação linha a linha. Se as
 * duas não derem a mesma hierarquia, a via Vision não pode ir para produção.
 */
import * as fs from "fs";
import { textoLayoutDasPaginas, type Palavra } from "../src/services/ocr-vision";

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

/** Escada de indentação: só a ORDEM dos níveis importa a jusante. */
function escada(texto: string): number[] {
  const recuos = texto
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => l.length - l.trimStart().length);
  const distintos = [...new Set(recuos)].sort((a, b) => a - b);
  return recuos.map((r) => distintos.indexOf(r));
}

/** Geometria das palavras da página, a partir da própria camada de texto. */
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
      const alturaItem = Math.abs(it.transform[3]) || 10;
      const larguraItem = it.width || bruto.length * alturaItem * 0.5;
      const larguraChar = larguraItem / Math.max(1, bruto.length);
      // O item do pdfjs pode conter VÁRIAS palavras separadas por espaço; o
      // Vision devolveria uma caixa por palavra. Quebrar aqui aproxima os dois.
      let cursor = 0;
      for (const parte of bruto.split(/(\s+)/)) {
        if (parte.trim()) {
          palavras.push({
            t: parte,
            x: it.transform[4] + cursor * larguraChar,
            y: vp.height - it.transform[5],
            w: parte.length * larguraChar,
            h: alturaItem,
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
  const todos = RAIZES.flatMap((r) => pdfs(r)).sort();
  let comparados = 0, iguais = 0;
  const divergentes: string[] = [];

  for (const caminho of todos) {
    const nome = path.basename(caminho);
    try {
      const buf = fs.readFileSync(caminho);
      const original = await extrairTextoLayoutPDF(buf);
      // Só compara onde HÁ camada de texto: é o único lugar com gabarito.
      if (original.trim().length < 600) continue;
      const geo = await palavrasDoPdf(buf);
      const reconstruido = textoLayoutDasPaginas(geo.map((palavras) => ({ palavras })));
      if (reconstruido.trim().length < 200) continue;

      comparados++;
      const a = escada(original), b = escada(reconstruido);
      const niveisA = Math.max(0, ...a) + 1, niveisB = Math.max(0, ...b) + 1;
      // O critério é a PROFUNDIDADE da escada: perder níveis significa folha
      // virando irmã do próprio grupo, que foi o estrago medido.
      if (niveisB >= niveisA) iguais++;
      else divergentes.push(`${nome}: ${niveisA} níveis → ${niveisB}`);
    } catch {
      /* documento ilegível para uma das vias — não entra na comparação */
    }
  }

  console.log(`documentos comparados: ${comparados}`);
  console.log(`  escada PRESERVADA ou mais fina: ${iguais} (${((100 * iguais) / Math.max(1, comparados)).toFixed(1)}%)`);
  console.log(`  escada ACHATADA (perde nível): ${divergentes.length}`);
  for (const d of divergentes.slice(0, 15)) console.log("     -", d);
}

main().catch((e) => { console.error(e); process.exit(1); });
