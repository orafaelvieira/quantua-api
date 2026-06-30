import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import * as XLSX from "xlsx";

const prisma = new PrismaClient();
const FILE = join(__dirname, "seed-data", "base_bovespa.xlsx");
const MARKER_KEY = "peers-b3";

const norm = (s: unknown) =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/**
 * Importa a base de PARES B3 (prisma/seed-data/base_bovespa.xlsx) para PeerCompany + PeerLine.
 * Idempotente por HASH do arquivo (SeedMarker): se o .xlsx não mudou, pula (boot rápido).
 * Quando muda, faz CARGA LIMPA (wipe + createMany em lote) — a base é um snapshot.
 * Roda no boot via `start` (db:seed:peers).
 */
async function main() {
  const buf = readFileSync(FILE);
  const hash = createHash("sha256").update(buf).digest("hex");
  const marker = await prisma.seedMarker.findUnique({ where: { key: MARKER_KEY } });
  if (marker?.hash === hash) {
    console.log("[import-peers] base B3 inalterada — pulando.");
    return;
  }

  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, raw: true });
  const H: string[] = (rows[0] as any[]).map((x) => String(x));
  const find = (target: string) => H.findIndex((h) => norm(h) === target);
  const cPapel = find("papel"), cEmp = find("empresa"), cClass = find("classificacao"),
        cSetor = find("setor"), cSub = find("subsetor"), cDoc = find("documento"), cConta = find("conta");
  const years = H.map((h, i) => ({ y: h, i })).filter((x) => /^\d{4}$/.test(x.y));

  if ([cPapel, cClass, cSetor, cDoc, cConta].some((i) => i < 0)) {
    throw new Error(`[import-peers] colunas esperadas não encontradas. Header: ${H.join(", ")}`);
  }

  const companies = new Map<string, { papel: string; nome: string; classificacao: string; setor: string; subsetor: string | null }>();
  const lines: { papel: string; documento: string; conta: string; year: number; value: number }[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] as any[];
    const papel = row[cPapel] ? String(row[cPapel]).trim() : "";
    if (!papel) continue;
    if (!companies.has(papel)) {
      companies.set(papel, {
        papel,
        nome: String(row[cEmp] ?? papel).trim(),
        classificacao: String(row[cClass] ?? "").trim(),
        setor: String(row[cSetor] ?? "").trim(),
        subsetor: row[cSub] != null && String(row[cSub]).trim() ? String(row[cSub]).trim() : null,
      });
    }
    const documento = String(row[cDoc] ?? "").trim();
    const conta = String(row[cConta] ?? "").trim();
    if (!documento || !conta) continue;
    for (const { y, i } of years) {
      const v = row[i];
      if (v === null || v === undefined || v === "") continue;
      const fv = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(fv) || fv === 0) continue;
      lines.push({ papel, documento, conta, year: Number(y), value: fv });
    }
  }

  // Trava de segurança: nunca zera a base por um arquivo de atualização truncado/corrompido.
  const MIN_EMPRESAS = 50;
  if (companies.size < MIN_EMPRESAS) {
    throw new Error(`[import-peers] SEGURANÇA: arquivo com só ${companies.size} empresas (< ${MIN_EMPRESAS}) — abortado para não zerar a base de pares.`);
  }

  console.log(`[import-peers] ${companies.size} empresas, ${lines.length} linhas — recarregando (carga limpa)...`);
  await prisma.peerLine.deleteMany({});
  await prisma.peerCompany.deleteMany({});
  await prisma.peerCompany.createMany({ data: [...companies.values()] });
  const BATCH = 5000;
  for (let i = 0; i < lines.length; i += BATCH) {
    await prisma.peerLine.createMany({ data: lines.slice(i, i + BATCH), skipDuplicates: true });
  }
  await prisma.seedMarker.upsert({ where: { key: MARKER_KEY }, update: { hash }, create: { key: MARKER_KEY, hash } });
  console.log(`[import-peers] OK: ${companies.size} empresas, ${lines.length} linhas importadas.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
