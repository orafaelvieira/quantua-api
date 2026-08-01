/**
 * LEITOR BIFF MÍNIMO (fallback) — 2026-08-01.
 *
 * Caso real (CADMO/CAHYVA): .xls BIFF8 íntegro — sem criptografia, com
 * LabelSst/Number/Row no stream — que o SheetJS 0.18.5 abre e devolve VAZIO
 * (aba sem `!ref`, zero células). Em vez de depender de upgrade da lib, este
 * leitor decodifica direto os registros que importam para uma MATRIZ de texto:
 *   SST (0x00FC/CONTINUE) · LabelSst (0x00FD) · Number (0x0203) · RK (0x027E)
 *   · MulRk (0x00BD) · Label (0x0204).
 * Números saem como valor CRU ("1234.56", ponto decimal) — o mesmo contrato do
 * leitor XLSX (imune a locale). Usado SÓ quando a lib devolve tudo vazio.
 */
import * as XLSX from "xlsx";
import type { Matriz } from "./balancete-tabular";

/** Lê os registros BIFF [tipo·tam·dados] de um stream Workbook. */
function* registros(wb: Buffer): Generator<{ tipo: number; off: number; dados: Buffer }> {
  let off = 0;
  while (off + 4 <= wb.length) {
    const tipo = wb.readUInt16LE(off);
    const n = wb.readUInt16LE(off + 2);
    yield { tipo, off, dados: wb.subarray(off + 4, off + 4 + n) };
    off += 4 + n;
  }
}

/** SST: strings compartilhadas, com strings ATRAVESSANDO registros CONTINUE
 *  (na fronteira, um grbit NOVO rege o restante — praxe do formato). */
function lerSST(blocos: Buffer[]): string[] {
  const strings: string[] = [];
  if (blocos.length === 0) return strings;
  let bi = 0, off = 8; // pula cstTotal/cstUnique do primeiro bloco
  const restante = (): number => blocos[bi].length - off;
  const pulaParaProximoBloco = (): boolean => { bi++; off = 0; return bi < blocos.length; };
  const u8 = (): number => { if (restante() < 1 && !pulaParaProximoBloco()) return -1; return blocos[bi].readUInt8(off++); };
  const u16 = (): number => { if (restante() < 2 && !pulaParaProximoBloco()) return -1; const v = blocos[bi].readUInt16LE(off); off += 2; return v; };
  const u32 = (): number => { if (restante() < 4 && !pulaParaProximoBloco()) return -1; const v = blocos[bi].readUInt32LE(off); off += 4; return v; };

  while (bi < blocos.length) {
    if (restante() <= 0 && !pulaParaProximoBloco()) break;
    const cch = u16();
    if (cch < 0) break;
    let grbit = u8();
    if (grbit < 0) break;
    const rich = (grbit & 0x08) !== 0, ext = (grbit & 0x04) !== 0;
    const cRun = rich ? u16() : 0;
    const cbExt = ext ? u32() : 0;
    let s = "";
    let faltam = cch;
    let wide = (grbit & 0x01) !== 0;
    while (faltam > 0) {
      if (restante() <= 0) {
        if (!pulaParaProximoBloco()) break;
        grbit = u8(); // fronteira de CONTINUE: novo flag para o restante
        wide = (grbit & 0x01) !== 0;
      }
      const bytesPorChar = wide ? 2 : 1;
      const cabem = Math.min(faltam, Math.floor(restante() / bytesPorChar));
      if (cabem <= 0) { if (!pulaParaProximoBloco()) break; continue; }
      const fatia = blocos[bi].subarray(off, off + cabem * bytesPorChar);
      s += wide ? fatia.toString("utf16le") : fatia.toString("latin1");
      off += cabem * bytesPorChar;
      faltam -= cabem;
    }
    // pula formatação rica e dados estendidos (podem cruzar CONTINUEs)
    let pular = cRun * 4 + cbExt;
    while (pular > 0) {
      if (restante() <= 0 && !pulaParaProximoBloco()) break;
      const salto = Math.min(pular, restante());
      off += salto; pular -= salto;
    }
    strings.push(s);
  }
  return strings;
}

const decodeRK = (rk: number): number => {
  const fX100 = (rk & 0x01) !== 0, fInt = (rk & 0x02) !== 0;
  let v: number;
  if (fInt) v = rk >> 2;
  else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    v = b.readDoubleLE(0);
  }
  return fX100 ? v / 100 : v;
};

/** Formata número como o leitor XLSX faz (valor cru, ponto decimal). */
const numTexto = (v: number): string => String(Math.round(v * 10000) / 10000);

/**
 * CFB `.xls` → matriz da PRIMEIRA planilha com células. `null` quando o buffer
 * não é CFB/BIFF legível (aí vale o comportamento normal da lib).
 */
export function biffParaMatriz(buffer: Buffer): Matriz | null {
  let wb: Buffer | null = null;
  try {
    const cfb = XLSX.CFB.read(buffer as any, { type: "buffer" });
    const stream = cfb.FileIndex.find((f: any) => f.name === "Workbook" || f.name === "Book");
    wb = stream?.content ? Buffer.from(stream.content as any) : null;
  } catch { return null; }
  if (!wb) return null;

  // SST fica nos globals; células ficam no substream da planilha (após o 2º BOF).
  const blocosSST: Buffer[] = [];
  let coletandoSST = false;
  let bofs = 0;
  const celulas: Array<{ r: number; c: number; t: string }> = [];
  let idxSST: Array<{ r: number; c: number; i: number }> = [];
  for (const reg of registros(wb)) {
    if (reg.tipo === 0x0809) { bofs++; coletandoSST = false; continue; }
    if (reg.tipo === 0x00fc) { blocosSST.push(reg.dados); coletandoSST = true; continue; }
    if (reg.tipo === 0x003c && coletandoSST) { blocosSST.push(reg.dados); continue; }
    if (reg.tipo !== 0x003c) coletandoSST = false;
    if (bofs < 2) continue; // ainda nos globals
    const d = reg.dados;
    try {
      if (reg.tipo === 0x00fd && d.length >= 10) {
        idxSST.push({ r: d.readUInt16LE(0), c: d.readUInt16LE(2), i: d.readUInt32LE(6) });
      } else if (reg.tipo === 0x0203 && d.length >= 14) {
        celulas.push({ r: d.readUInt16LE(0), c: d.readUInt16LE(2), t: numTexto(d.readDoubleLE(6)) });
      } else if (reg.tipo === 0x027e && d.length >= 10) {
        celulas.push({ r: d.readUInt16LE(0), c: d.readUInt16LE(2), t: numTexto(decodeRK(d.readUInt32LE(6))) });
      } else if (reg.tipo === 0x00bd && d.length >= 12) {
        const r = d.readUInt16LE(0), colFirst = d.readUInt16LE(2);
        const n = (d.length - 6) / 6;
        for (let k = 0; k < n; k++) celulas.push({ r, c: colFirst + k, t: numTexto(decodeRK(d.readUInt32LE(4 + k * 6 + 2))) });
      } else if (reg.tipo === 0x0204 && d.length >= 9) {
        // Label inline (BIFF8): cch + grbit + chars
        const cch = d.readUInt16LE(6), grbit = d.readUInt8(8);
        const wide = (grbit & 0x01) !== 0;
        const fatia = d.subarray(9, 9 + cch * (wide ? 2 : 1));
        celulas.push({ r: d.readUInt16LE(0), c: d.readUInt16LE(2), t: wide ? fatia.toString("utf16le") : fatia.toString("latin1") });
      }
    } catch { /* registro malformado — segue para o próximo */ }
  }

  const sst = lerSST(blocosSST);
  for (const s of idxSST) celulas.push({ r: s.r, c: s.c, t: sst[s.i] ?? "" });
  if (celulas.length === 0) return null;

  const maxR = Math.max(...celulas.map((x) => x.r));
  const maxC = Math.max(...celulas.map((x) => x.c));
  const m: Matriz = Array.from({ length: maxR + 1 }, () => Array.from({ length: maxC + 1 }, () => ""));
  for (const cel of celulas) m[cel.r][cel.c] = (cel.t ?? "").toString().trim();
  return m;
}
