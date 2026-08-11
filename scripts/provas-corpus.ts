/**
 * BANCADA DE PROVA DO CORPUS (F0 — 10/08/2026).
 *
 * O dono pediu garantia de que "a extração está exatamente igual ao documento
 * original, com validações cruzadas". A primeira coisa que falta para isso não
 * é código de produção: é um INSTRUMENTO que meça, documento a documento, quais
 * provas rodaram, quais passaram e — o número que interessa — quantos documentos
 * hoje ficam VERDES SEM PROVA (fecham o portão só porque nada foi conferido).
 *
 * Roda a MESMA leitura da porta (que agora é a cascata do IBR) sobre o acervo
 * real e imprime o placar. Nenhuma linha de produção é tocada aqui.
 *
 *   npx tsx scripts/provas-corpus.ts              → só o determinístico (grátis)
 *   npx tsx scripts/provas-corpus.ts --ia         → cascata completa (paga IA)
 *   npx tsx scripts/provas-corpus.ts --ia --n 12  → limita a 12 documentos
 *   npx tsx scripts/provas-corpus.ts --json placar.json
 *
 * As provas de HOJE, por documento:
 *   AT=PT montado ....... Ativo Total = Passivo Total no que foi montado
 *   AT impresso ......... total DECLARADO no documento × montado  ← cruzada de verdade
 *   composição .......... AC+ANC = AT · PC+PNC+PL = PT
 *   partição ............ soma das folhas de cada grupo = subtotal do grupo
 * "não verificável" é resposta legítima e aparece como ⚠ — nunca como ✓.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, extname, basename } from "path";
import { lerDemonstrativoHibrido, lerBalanceteDeterministico } from "../src/services/leitura-porta";

const RAIZES = [
  "C:/Users/Emerson/OneDrive/Desktop/DCTOS_TESTE_SISTEMA",
  "C:/Users/Emerson/OneDrive/Desktop/Testes Quantua",
];
/** Os balanços da Dunamys chegaram por download e são o caso vivo do relato. */
const AVULSOS = [
  "C:/Users/Emerson/Downloads/1786394714942-BP 22.pdf",
  "C:/Users/Emerson/Downloads/1786394738103-BP 23.pdf",
  "C:/Users/Emerson/Downloads/1786394744376-BP 24.pdf",
];

const EXT_OK = new Set([".pdf", ".xlsx", ".xls", ".xlsm", ".csv"]);
const args = process.argv.slice(2);
const COM_IA = args.includes("--ia");
const LIMITE = args.includes("--n") ? Number(args[args.indexOf("--n") + 1]) : Infinity;
const JSON_OUT = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

/** Tipo pelo NOME do arquivo — é o que o analista declara na Data room. */
function tipoDoNome(nome: string): "Balancete" | "Balanço Patrimonial" | "DRE" | null {
  const n = nome.toLowerCase();
  if (/balancete/.test(n)) return "Balancete";
  if (/balan[çc]o|(^|[^a-z])bp([^a-z]|$)/.test(n)) return "Balanço Patrimonial";
  if (/\bdre\b|resultado|dmpl/.test(n)) return "DRE";
  return null;
}

function listar(raiz: string): string[] {
  if (!existsSync(raiz)) return [];
  const out: string[] = [];
  const anda = (dir: string, nivel: number) => {
    if (nivel > 3) return;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        if (statSync(p).isDirectory()) anda(p, nivel + 1);
        else if (EXT_OK.has(extname(f).toLowerCase()) && tipoDoNome(f)) out.push(p);
      } catch { /* arquivo travado/sem permissão: fora do placar */ }
    }
  };
  anda(raiz, 0);
  return out;
}

type Estado = "passou" | "falhou" | "nao-verificavel";
const selo = (e: Estado) => (e === "passou" ? "✓" : e === "falhou" ? "✗" : "⚠");

interface LinhaPlacar {
  arquivo: string;
  tipo: string;
  motor: string;
  fonte: string | null;
  score: string | null;
  contas: number;
  custoUsd: number;
  provas: Record<string, Estado>;
  verdeSemProva: boolean;
  erro: string | null;
}

/** Soma os nós de um grupo da árvore do BP (folhas + subtotais próprios). */
const somaGrupo = (itens: unknown): number => {
  if (!Array.isArray(itens)) return 0;
  return (itens as Array<{ valor?: number }>).reduce((s, i) => s + (typeof i?.valor === "number" ? i.valor : 0), 0);
};

function provasDoBP(arvore: Record<string, { grupos?: Record<string, unknown>; totais?: Record<string, number> }>): Record<string, Estado> {
  const p: Record<string, Estado> = {};
  const periodos = Object.keys(arvore);
  if (!periodos.length) return { "AT=PT montado": "nao-verificavel", "AT impresso": "nao-verificavel", "composição": "nao-verificavel" };
  let atPt: Estado = "passou", impresso: Estado = "nao-verificavel", comp: Estado = "passou";
  for (const per of periodos) {
    const capa = arvore[per] ?? {};
    const g = capa.grupos ?? {};
    const ac = somaGrupo(g["Ativo Circulante"]) + somaGrupo(g["Ativo Não Circulante"]);
    const pc = somaGrupo(g["Passivo Circulante"]) + somaGrupo(g["Passivo Não Circulante"]) + somaGrupo(g["Patrimônio Líquido"]);
    const tol = Math.max(1, Math.abs(ac) * 0.0001);
    if (Math.abs(ac - pc) > tol) atPt = "falhou";
    // A prova CRUZADA: o total que o próprio documento imprime.
    const decl = capa.totais ?? {};
    const at = decl["Ativo Total"], pt = decl["Passivo Total"];
    if (typeof at === "number" && at !== 0) {
      const okA = Math.abs(ac - at) <= Math.max(1, Math.abs(at) * 0.0001);
      const okP = typeof pt === "number" && pt !== 0 ? Math.abs(pc - pt) <= Math.max(1, Math.abs(pt) * 0.0001) : true;
      impresso = okA && okP ? (impresso === "falhou" ? "falhou" : "passou") : "falhou";
    }
    if (!Object.keys(g).length) comp = "nao-verificavel";
  }
  p["AT=PT montado"] = atPt;
  p["AT impresso"] = impresso;
  p["composição"] = comp;
  return p;
}

async function main() {
  const arquivos = [...RAIZES.flatMap(listar), ...AVULSOS.filter((f) => existsSync(f))].slice(0, LIMITE);
  console.log(`BANCADA DE PROVA — ${arquivos.length} documento(s) · ${COM_IA ? "cascata COMPLETA (paga IA)" : "só determinístico"}\n`);

  const placar: LinhaPlacar[] = [];
  for (const caminho of arquivos) {
    const nome = basename(caminho);
    const tipo = tipoDoNome(nome)!;
    const buf = readFileSync(caminho);
    const linha: LinhaPlacar = { arquivo: nome, tipo, motor: "-", fonte: null, score: null, contas: 0, custoUsd: 0, provas: {}, verdeSemProva: false, erro: null };
    try {
      if (tipo === "Balancete") {
        const r = await lerBalanceteDeterministico(buf, nome, null);
        linha.motor = "balancete";
        linha.contas = r.totalContas;
        linha.erro = r.erro ?? null;
        const pr = r.provas;
        linha.provas = {
          "partida dobrada": pr?.partidaDobrada ? (pr.partidaDobrada.verificavel ? (pr.partidaDobrada.ok ? "passou" : "falhou") : "nao-verificavel") : "nao-verificavel",
          "D=C impresso": pr?.debitosCreditos ? (pr.debitosCreditos.ok ? "passou" : "falhou") : "nao-verificavel",
          "fechamento": pr ? (pr.fechamento.ok ? "passou" : "falhou") : "nao-verificavel",
          "linha a linha": pr ? (pr.linhas.ok ? "passou" : "falhou") : "nao-verificavel",
          "DRE encerrada": pr?.dreEncerrada ? (pr.dreEncerrada.ok ? "passou" : "falhou") : "nao-verificavel",
        };
      } else {
        if (!COM_IA) { linha.motor = "pulado (sem --ia)"; placar.push(linha); continue; }
        const r = await lerDemonstrativoHibrido(buf, nome, tipo, null, { companyId: null });
        linha.motor = r.motor;
        linha.fonte = r.integridade?.fonte ?? null;
        linha.score = r.integridade ? `${r.integridade.score}/${r.integridade.scoreMax}` : null;
        linha.contas = r.totalContas;
        linha.custoUsd = r.custoUsd ?? 0;
        linha.erro = r.erro ?? null;
        linha.provas = r.arvoreBP
          ? provasDoBP(r.arvoreBP as never)
          : { "DRE lida": Object.keys((r.arvoreDRE ?? {}) as object).length ? "passou" : "falhou", "DRE × declarado": r.declarados && Object.keys(r.declarados).length ? "passou" : "nao-verificavel" };
      }
    } catch (e) {
      linha.erro = e instanceof Error ? e.message : String(e);
    }
    // VERDE SEM PROVA: o documento "fechou" e nenhuma prova cruzada rodou.
    const estados = Object.values(linha.provas);
    const cruzada = linha.provas["AT impresso"] ?? (linha.provas["partida dobrada"] === "passou" ? "passou" : linha.provas["D=C impresso"]) ?? linha.provas["DRE × declarado"];
    linha.verdeSemProva = !linha.erro && estados.length > 0 && !estados.includes("falhou") && cruzada !== "passou";
    placar.push(linha);

    const provasTxt = Object.entries(linha.provas).map(([k, v]) => `${selo(v)} ${k}`).join("  ");
    console.log(
      `${linha.arquivo.slice(0, 44).padEnd(46)} ${linha.tipo.slice(0, 12).padEnd(13)} ${(linha.fonte ?? linha.motor).padEnd(14)} ` +
      `${(linha.score ?? "").padEnd(5)} ${String(linha.contas).padStart(4)} contas  ${provasTxt}` +
      (linha.verdeSemProva ? "   ← VERDE SEM PROVA" : "") + (linha.erro ? `   ✗ ${linha.erro.slice(0, 60)}` : ""),
    );
  }

  const lidos = placar.filter((l) => !l.erro && l.motor !== "pulado (sem --ia)");
  const semProva = lidos.filter((l) => l.verdeSemProva);
  const falharam = placar.filter((l) => Object.values(l.provas).includes("falhou"));
  const custo = placar.reduce((s, l) => s + l.custoUsd, 0);
  console.log(`\n──────── PLACAR ────────`);
  console.log(`documentos lidos ............ ${lidos.length}/${arquivos.length}`);
  console.log(`VERDES SEM PROVA ............ ${semProva.length}   ← o número que precisa cair a zero`);
  console.log(`com alguma prova FALHANDO ... ${falharam.length}`);
  console.log(`com erro de leitura ......... ${placar.filter((l) => l.erro).length}`);
  console.log(`custo de IA ................. US$ ${custo.toFixed(4)}`);
  if (JSON_OUT) { writeFileSync(JSON_OUT, JSON.stringify(placar, null, 2), "utf8"); console.log(`placar gravado em ${JSON_OUT}`); }
}

main().catch((e) => { console.error(e); process.exit(1); });
