/**
 * TESTE MEDIDO DO CLOUD VISION OCR sobre um balancete ESCANEADO.
 *
 * Roda no GitHub Actions, que autentica no GCP por Workload Identity Federation
 * (mesmo caminho do deploy) — não há credencial de GCP na máquina de ninguém.
 *
 * O documento é SINTÉTICO de propósito: mesmo layout, mesma densidade (~60
 * linhas/página) e mesma tipografia do balancete real, mas com valores
 * fabricados. Assim (a) nenhum dado de cliente sai da infraestrutura e (b) a
 * verdade é conhecida linha a linha, o que permite medir fidelidade EXATA em vez
 * de só "fecha a equação".
 *
 * Para não facilitar para o motor, a página é degradada como um escaneamento de
 * verdade: rotação leve, ruído e JPEG de qualidade baixa.
 */
import { createCanvas } from "@napi-rs/canvas";

// A4 a ~200 dpi — resolução de um escaneamento de escritório de verdade.
// 1309px (a primeira tentativa) deixava o papel sintético com MENOS resolução
// que o documento real do cliente, e o teste media o meu gerador, não o motor.
const LARGURA = 1700, ALTURA = 2338;
const COL = { cod: 77, red: 292, nome: 377, ant: 1000, deb: 1170, cre: 1325, atual: 1495 };

interface Linha { cod: string; nome: string; ant: number; deb: number; cre: number; atual: number }

const brl = (n: number) =>
  (n < 0 ? "-" : "") + Math.abs(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Gera linhas de balancete cuja equação SEMPRE fecha (anterior + D − C = atual). */
function gerarLinhas(n: number, semente: number): Linha[] {
  let s = semente;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const nomes = ["CAIXA GERAL", "BANCO ITAU S/A", "BANCO BRADESCO S/A", "CLIENTES DIVERSOS", "ADIANTAMENTO A FORNECEDORES",
    "TRIBUTOS A RECUPERAR", "ESTOQUE DE MATERIAIS", "IMOBILIZADO EM ANDAMENTO", "VEICULOS E CAMINHOES", "DEPRECIACAO ACUMULADA",
    "FORNECEDORES NACIONAIS", "SALARIOS A PAGAR", "ENCARGOS SOCIAIS A RECOLHER", "EMPRESTIMOS BANCARIOS", "RECEITA DE SERVICOS",
    "DEDUCOES DA RECEITA BRUTA", "CUSTO DOS SERVICOS PRESTADOS", "DESPESAS COM PESSOAL", "DESPESAS ADMINISTRATIVAS", "DESPESAS FINANCEIRAS"];
  const out: Linha[] = [];
  for (let i = 0; i < n; i++) {
    const ant = Math.round(rnd() * 9_000_000 * 100) / 100;
    const deb = Math.round(rnd() * 3_000_000 * 100) / 100;
    const cre = Math.round(rnd() * 3_000_000 * 100) / 100;
    out.push({
      cod: String(1101010000 + i * 7),
      nome: nomes[i % nomes.length],
      ant, deb, cre,
      atual: Math.round((ant + deb - cre) * 100) / 100,
    });
  }
  return out;
}

/** Desenha a página e devolve JPEG degradado (simula digitalização). */
function paginaEscaneada(linhas: Linha[]): Buffer {
  const cv = createCanvas(LARGURA, ALTURA);
  const c = cv.getContext("2d");
  c.fillStyle = "#ffffff"; c.fillRect(0, 0, LARGURA, ALTURA);

  // leve rotação, como papel torto no scanner
  c.save();
  c.translate(LARGURA / 2, ALTURA / 2); c.rotate((0.35 * Math.PI) / 180); c.translate(-LARGURA / 2, -ALTURA / 2);

  c.fillStyle = "#000000";
  c.font = "bold 19px Arial";
  c.fillText("EMPRESA DE TESTE LTDA", 77, 232);
  c.font = "bold 22px Arial";
  c.fillText("Balancete de Verificação", 675, 258);
  c.font = "17px Arial";
  c.fillText("Período:", 1078, 318); c.fillText("07/2015 a 07/2015", 1299, 318);
  c.font = "bold 17px Arial";
  c.fillText("Conta", 77, 379); c.fillText("Reduzida", 260, 379); c.fillText("Nome", 377, 379);
  const dir = (t: string, x: number, y: number) => { const w = c.measureText(t).width; c.fillText(t, x - w, y); };
  dir("Saldo Anterior", COL.ant, 379); dir("Débito", COL.deb, 379); dir("Crédito", COL.cre, 379); dir("Saldo Atual", COL.atual, 379);

  c.font = "17px Arial";
  let y = 420;
  for (const l of linhas) {
    c.fillText(l.cod, COL.cod, y);
    c.fillText(`${(parseInt(l.cod, 10) % 900) + 10}-${parseInt(l.cod, 10) % 9}`, COL.red, y);
    c.fillText(l.nome, COL.nome, y);
    dir(brl(l.ant), COL.ant, y); dir(brl(l.deb), COL.deb, y);
    dir(brl(l.cre), COL.cre, y); dir(brl(l.atual), COL.atual, y);
    y += 21; // mesmo passo relativo do documento real
  }
  c.restore();

  // RUÍDO DE DIGITALIZAÇÃO — calibrado (03/08/2026). Com ruído ±34 e JPEG 55 a
  // página sintética ficava PIOR que um escaneamento real: o OCR lia
  // "2_624.683.13" no lugar de "2.624.683,13". Um teste com papel mais sujo que
  // o do cliente não mede o motor, mede o meu gerador. Aferido contra o Budel
  // real, onde o mesmo pipeline reconstrói 96,9% das linhas fechando.
  const img = c.getImageData(0, 0, LARGURA, ALTURA);
  for (let i = 0; i < img.data.length; i += 4) {
    const r = (Math.random() - 0.5) * 12;
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + r));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + r));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + r));
  }
  c.putImageData(img, 0, 0);
  return cv.toBuffer("image/jpeg", 82); // JPEG de scanner de escritório, não de fax
}

interface Palavra { t: string; x: number; y: number; w: number }

async function vision(jpeg: Buffer, token: string): Promise<{ palavras: Palavra[]; ms: number; erro?: string }> {
  const t0 = Date.now();
  const r = await fetch("https://vision.googleapis.com/v1/images:annotate", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{
        image: { content: jpeg.toString("base64") },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
        imageContext: { languageHints: ["pt"] },
      }],
    }),
  });
  const ms = Date.now() - t0;
  const j: any = await r.json();
  if (!r.ok || j?.responses?.[0]?.error) {
    return { palavras: [], ms, erro: JSON.stringify(j?.error ?? j?.responses?.[0]?.error).slice(0, 400) };
  }
  // textAnnotations[0] é a página inteira; do [1] em diante vem palavra a palavra COM geometria.
  const anns: any[] = j.responses[0]?.textAnnotations ?? [];
  const palavras: Palavra[] = anns.slice(1).map((a) => {
    const v = a.boundingPoly.vertices;
    const xs = v.map((p: any) => p.x ?? 0), ys = v.map((p: any) => p.y ?? 0);
    return { t: a.description, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) };
  });
  return { palavras, ms };
}

// ── reconstrução determinística da tabela pela geometria ────────────────────
const ehNum = (s: string) => /^-?\d{1,3}(\.\d{3})*,\d{2}$/.test(s);
const num = (s: string) => parseFloat(s.replace(/\./g, "").replace(",", "."));

function agrupar(ps: Palavra[], tolY = 12): Palavra[][] {
  const ord = [...ps].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Palavra[][] = [];
  for (const p of ord) {
    const u = out[out.length - 1];
    if (u && Math.abs(u[0].y - p.y) <= tolY) u.push(p); else out.push([p]);
  }
  for (const l of out) l.sort((a, b) => a.x - b.x);
  return out;
}
/** Junta fragmentos vizinhos que só juntos formam número ("614." + "387,53"). */
function costurar(l: Palavra[]): Palavra[] {
  const out: Palavra[] = [];
  for (let i = 0; i < l.length; i++) {
    const a = l[i], b = l[i + 1];
    if (b && !ehNum(a.t) && /^-?\d{1,3}(\.\d{3})*\.?$/.test(a.t) && ehNum(a.t + b.t) && b.x - (a.x + a.w) < 14) {
      out.push({ t: a.t + b.t, x: a.x, y: a.y, w: b.x + b.w - a.x }); i++; continue;
    }
    out.push(a);
  }
  return out;
}
function reconstruir(ps: Palavra[]) {
  const out: Array<{ cod: string; v: number[] }> = [];
  for (const bruta of agrupar(ps)) {
    const l = costurar(bruta);
    if (!/^\d{9,11}$/.test(l[0]?.t ?? "")) continue;
    const nums = l.filter((p) => ehNum(p.t));
    if (nums.length < 4) continue;
    out.push({ cod: l[0].t, v: nums.slice(-4).map((p) => num(p.t)) });
  }
  return out;
}

async function main() {
  const token = process.env.GCP_TOKEN;
  // Modo local de PRÉ-VOO: sem token, só gera as páginas e grava o gabarito.
  // Serve para validar geração + reconstrução antes de gastar uma rodada no
  // Actions — o motor de OCR passa a ser a única variável nova lá.
  const salvarEm = process.env.SALVAR_EM;
  if (!token && !salvarEm) { console.error("SEM TOKEN: rode dentro do GitHub Actions com auth WIF (ou defina SALVAR_EM para pré-voo local)."); process.exit(1); }

  const PAGINAS = Number(process.env.PAGINAS ?? 3);
  const POR_PAGINA = 60;
  let totalLinhas = 0, exatas = 0, fecham = 0, reconstruidas = 0, msTotal = 0;
  const problemas: string[] = [];

  for (let p = 0; p < PAGINAS; p++) {
    const verdade = gerarLinhas(POR_PAGINA, 7919 + p * 104729);
    const jpeg = paginaEscaneada(verdade);
    if (salvarEm) {
      const fs = await import("fs");
      const n = String(p + 1).padStart(2, "0");
      fs.writeFileSync(`${salvarEm}/vt-${n}.jpg`, jpeg);
      fs.writeFileSync(`${salvarEm}/vt-${n}.json`, JSON.stringify(verdade));
      console.log(`  pagina ${p + 1}: gerada (${(jpeg.length / 1024).toFixed(0)} KB) -> ${salvarEm}/vt-${n}.jpg`);
      if (!token) continue;
    }
    const r = await vision(jpeg, token!);
    msTotal += r.ms;
    if (r.erro) { console.error(`PAGINA ${p + 1}: ERRO DO VISION -> ${r.erro}`); process.exit(2); }

    const lidas = reconstruir(r.palavras);
    const porCod = new Map(lidas.map((l) => [l.cod, l]));
    totalLinhas += verdade.length;
    reconstruidas += lidas.length;
    for (const v of verdade) {
      const l = porCod.get(v.cod);
      if (!l) { if (problemas.length < 8) problemas.push(`${v.cod}: nao reconstruida`); continue; }
      const esperado = [v.ant, v.deb, v.cre, v.atual];
      const ok = esperado.every((e, i) => Math.abs(e - l.v[i]) <= 0.02);
      if (ok) exatas++;
      else if (problemas.length < 8) problemas.push(`${v.cod}: leu ${l.v.map((x) => brl(x)).join(" | ")} | papel ${esperado.map(brl).join(" | ")}`);
      if (Math.abs(l.v[0] + l.v[1] - l.v[2] - l.v[3]) <= 0.02) fecham++;
    }
    console.log(`  pagina ${p + 1}/${PAGINAS}: ${r.palavras.length} palavras, ${lidas.length} linhas reconstruidas, ${r.ms} ms`);
  }

  const pct = (n: number) => `${((100 * n) / Math.max(1, totalLinhas)).toFixed(1)}%`;
  console.log("\n================= CLOUD VISION — RESULTADO MEDIDO =================");
  console.log(`paginas: ${PAGINAS} | linhas no papel: ${totalLinhas} | reconstruidas: ${reconstruidas}`);
  console.log(`VALORES EXATOS (4 colunas iguais ao papel): ${exatas}/${totalLinhas}  (${pct(exatas)})`);
  console.log(`linhas que fecham a propria equacao:        ${fecham}/${totalLinhas}  (${pct(fecham)})`);
  console.log(`tempo total: ${msTotal} ms  (${Math.round(msTotal / PAGINAS)} ms/pagina)`);
  console.log(`custo: ${PAGINAS} paginas x US$ 1,50/1000 = US$ ${((PAGINAS * 1.5) / 1000).toFixed(4)} (as 1000 primeiras/mes sao gratis)`);
  console.log("\nreferencia medida no MESMO tipo de documento:");
  console.log("  LLM de visao (Haiku 2pg): 35,6% das linhas NAO fecham, 4 valores alucinados, US$ 0,15/documento");
  if (problemas.length) { console.log("\nprimeiras divergencias:"); for (const p of problemas) console.log("   ", p); }
}

main().catch((e) => { console.error("FALHOU:", e?.stack ?? e); process.exit(1); });
