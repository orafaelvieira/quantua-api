/**
 * A/B DO SINAL NO ENCERRAMENTO (19/08/2026 — caso Instituto AOCP).
 *
 * `provas-corpus.ts` mede se as provas do BALANÇO passaram; não mede o número
 * da DRE nem o veredito do P4, que é justamente o que esta mudança move. Este
 * instrumento roda a MESMA leitura da porta sobre o acervo e grava, por
 * documento: Ativo, Passivo, a soma da DRE, cada seção com seu sinal e o P4
 * inteiro (verificável, âncora, gap, veredito).
 *
 *   npx tsx scripts/ab-encerramento-sinal.ts --json depois.json
 *   npx tsx scripts/ab-encerramento-sinal.ts --diff antes.json depois.json
 *
 * CRITÉRIO DE ACEITE do diff (o que o modo --diff imprime e cobra):
 *  (i)   nenhum documento muda Ativo ou Passivo — a mudança é de DRE, não de BP;
 *  (ii)  nenhum documento FORA do encerramento muda a soma da DRE;
 *  (iii) toda mudança de veredito do P4 vem com o nome da âncora encontrada
 *        (ou a ausência dela declarada) — veredito que muda sem explicação é
 *        regressão até prova em contrário;
 *  (iv)  documento que passa a NÃO publicar a DRE aparece nomeado, com o motivo.
 *
 * Nenhuma linha de produção é tocada aqui.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, extname, basename } from "path";
import { lerBalanceteDeterministico } from "../src/services/leitura-porta";
import { converterBalancete } from "../src/services/balancete-conversao";
import { parseadoDaLeitura } from "../src/services/leitura-porta";

const RAIZES = [
  "C:/Users/Emerson/OneDrive/Desktop/DCTOS_TESTE_SISTEMA",
  "C:/Users/Emerson/OneDrive/Desktop/Testes Quantua",
];
const AVULSOS = [
  "C:/Users/Emerson/Downloads/BALANCETE 2023 - IAOCP.PDF",
  "C:/Users/Emerson/Downloads/BALANCETE ANALITICO 2023.pdf",
  "C:/Users/Emerson/Downloads/BALANCETE ANALITICO 2024.pdf",
  "C:/Users/Emerson/Downloads/BALANCETE FINAL ACUMULADO 2025.pdf",
];
const EXT_OK = new Set([".pdf", ".xlsx", ".xls", ".csv"]);

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const DIFF = args.includes("--diff") ? [args[args.indexOf("--diff") + 1], args[args.indexOf("--diff") + 2]] : null;

interface Linha {
  arquivo: string;
  erro: string | null;
  encerrado: boolean;
  periodo: string;
  ativo: number;
  passivo: number;
  somaDRE: number;
  secoes: Array<{ nome: string; valor: number }>;
  p4: { verificavel: boolean; ancora: string | null; declaradoPL: number; derivado: number; gap: number; limite: number; sinalUnico: boolean; ok: boolean } | null;
  publicaDRE: boolean;
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
        else if (EXT_OK.has(extname(f).toLowerCase()) && /balancete/i.test(f)) out.push(p);
      } catch { /* arquivo travado: fora do placar */ }
    }
  };
  anda(raiz, 0);
  return out;
}

const f = (n: number) => n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function medir(): Promise<Linha[]> {
  const arquivos = [...RAIZES.flatMap(listar), ...AVULSOS.filter((x) => existsSync(x))];
  console.log(`A/B DO SINAL — ${arquivos.length} balancete(s)\n`);
  const out: Linha[] = [];
  for (const caminho of arquivos) {
    const nome = basename(caminho);
    const base: Linha = { arquivo: caminho, erro: null, encerrado: false, periodo: "", ativo: 0, passivo: 0, somaDRE: 0, secoes: [], p4: null, publicaDRE: false };
    try {
      const leitura = await lerBalanceteDeterministico(readFileSync(caminho), nome, null);
      if (leitura.erro) { out.push({ ...base, erro: leitura.erro }); continue; }
      const c = converterBalancete(parseadoDaLeitura(leitura));
      // ÁRVORE INTEIRA ACHATADA, não só o nível 1 (revisão adversarial,
      // 19/08/2026): guardar apenas as seções de topo deixou o A/B CEGO para o
      // defeito que o próprio diff introduzia — no SABRINA a seção "DEDUÇÕES DA
      // RECEITA BRUTA" foi de −16.242,87 para −2.575,97 sem trocar de sinal,
      // porque duas folhas viraram, e nada disso aparecia no relatório.
      // O caminho completo é a chave: nome sozinho se repete.
      type No = { nome: string; valor: number; filhos?: No[] };
      const achatar = (itens: No[], caminho: string[], out: Array<{ nome: string; valor: number }>) => {
        itens.forEach((i, idx) => {
          const cam = [...caminho, `${idx}:${i.nome}`];
          out.push({ nome: cam.join(" > "), valor: Math.round(i.valor * 100) / 100 });
          if (i.filhos?.length) achatar(i.filhos, cam, out);
        });
        return out;
      };
      const topo = (c.arvoreDRE as Record<string, No[]>)[c.periodoBP] ?? [];
      const secoes = achatar(topo, [], []);
      const p4 = c.provas.dreEncerrada ?? null;
      out.push({
        arquivo: caminho, erro: null,
        encerrado: c.provas.exercicioEncerrado,
        periodo: c.periodoBP,
        ativo: Math.round(c.provas.fechamento.ativo * 100) / 100,
        passivo: Math.round(c.provas.fechamento.passivo * 100) / 100,
        somaDRE: Math.round(topo.reduce((s, x) => s + x.valor, 0) * 100) / 100,
        secoes,
        p4: p4 ? { ...p4 } : null,
        // a régua do consumidor (base-contabil): encerrado só publica com P4 ok
        publicaDRE: !c.provas.exercicioEncerrado || p4?.ok === true,
      });
    } catch (e) {
      out.push({ ...base, erro: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

function diff(a: Linha[], b: Linha[]): void {
  // CHAVE É O CAMINHO COMPLETO (revisão adversarial): o corpus tem o mesmo
  // arquivo em duas raízes; com Map por BASENAME, 101 lidos viravam 88
  // comparados e 13 caíam calados — silêncio que o operador lê como "não
  // mudou". O caminho é único por construção; colisão aqui vira erro, não
  // desaparecimento.
  const porNome = (l: Linha[]) => {
    const m = new Map<string, Linha>();
    for (const x of l) {
      if (m.has(x.arquivo)) { console.log(`  ! caminho repetido: ${x.arquivo} — o placar perderia um documento`); process.exitCode = 1; }
      m.set(x.arquivo, x);
    }
    return m;
  };
  const A = porNome(a), B = porNome(b);
  let violacoes = 0;
  const nomes = [...new Set([...A.keys(), ...B.keys()])].sort();
  console.log(`DIFF — ${nomes.length} documento(s)\n`);
  for (const n of nomes) {
    const x = A.get(n), y = B.get(n);
    if (!x || !y) { console.log(`  ! ${n}: presente em só um dos lados`); violacoes++; continue; }
    if (x.erro || y.erro) { if (x.erro !== y.erro) { console.log(`  ! ${n}: erro mudou "${x.erro}" → "${y.erro}"`); violacoes++; } continue; }
    const mudou: string[] = [];
    if (Math.abs(x.ativo - y.ativo) > 0.005) { mudou.push(`(i) ATIVO ${f(x.ativo)} → ${f(y.ativo)}`); violacoes++; }
    if (Math.abs(x.passivo - y.passivo) > 0.005) { mudou.push(`(i) PASSIVO ${f(x.passivo)} → ${f(y.passivo)}`); violacoes++; }
    const fora = !x.encerrado && !y.encerrado;
    if (Math.abs(x.somaDRE - y.somaDRE) > 0.005) {
      if (fora) violacoes++;
      mudou.push(`${fora ? "(ii) " : ""}DRE ${f(x.somaDRE)} → ${f(y.somaDRE)}${fora ? "  ← FORA do encerramento" : ""}`);
    }
    // (ii) na régua FORTE: fora do encerramento nem a soma nem NENHUMA linha
    // pode mexer. A régua fraca (só a soma) deixaria passar linha virada com o
    // total intacto — mudança silenciosa é o que esta bancada existe para pegar.
    //
    // COMPARAÇÃO POSICIONAL, nunca por nome. Chavear por nome custou uma caçada
    // inteira a um fantasma (19/08/2026): o OCEANDROP tem 17 nomes de seção
    // REPETIDOS ("EMPRÉSTIMOS E FINANCIAMENTOS", "Capital de Giro BB"…), o Map
    // guardava só a última ocorrência, e o comparador acusava 13 linhas mudadas
    // entre duas rodadas do MESMO código. Diferença posicional: zero.
    const mesmaOrdem = x.secoes.length === y.secoes.length
      && x.secoes.every((s, i) => s.nome === y.secoes[i].nome);
    const linhasMudadas = mesmaOrdem
      ? y.secoes.map((s, i) => ({ s, antes: x.secoes[i].valor })).filter((p) => Math.abs(p.antes - p.s.valor) > 0.005)
      : [];
    if (!mesmaOrdem) mudou.push(`estrutura da DRE mudou: ${x.secoes.length} → ${y.secoes.length} seção(ões)`);
    if (linhasMudadas.length || !mesmaOrdem) {
      if (fora) violacoes++;
      mudou.push(`${fora ? "(ii) " : ""}${linhasMudadas.length} linha(s) mudaram de valor${fora ? " FORA do encerramento" : ""}: ${linhasMudadas.slice(0, 8).map((p) => `${p.s.nome} ${f(p.antes)} → ${f(p.s.valor)}`).join(" · ")}`);
    }
    const vx = x.p4 ? (x.p4.ok ? "ok" : "reprova") : "ausente";
    const vy = y.p4 ? (y.p4.ok ? "ok" : "reprova") : "ausente";
    if (vx !== vy) {
      const motivo = y.p4
        ? (y.p4.sinalUnico ? "DRE de sinal único"
          : !y.p4.verificavel ? "sem âncora no PL (não-verificável)"
            : `âncora "${y.p4.ancora}" · declarado ${f(y.p4.declaradoPL)} × derivado ${f(y.p4.derivado)} · gap ${f(y.p4.gap)} / limite ${f(y.p4.limite)}`)
        : "prova não produzida";
      mudou.push(`(iii) P4 ${vx} → ${vy} — ${motivo}`);
    }
    if (x.publicaDRE !== y.publicaDRE) mudou.push(`(iv) publica DRE ${x.publicaDRE} → ${y.publicaDRE}`);
    const viradas = linhasMudadas.filter((p) => Math.sign(p.antes) !== Math.sign(p.s.valor) && Math.abs(p.s.valor) > 0.005);
    if (viradas.length) mudou.push(`seções que viraram de sinal: ${viradas.map((p) => `${p.s.nome} ${f(p.antes)} → ${f(p.s.valor)}`).join(" · ")}`);
    if (mudou.length) console.log(`  ${n}${y.encerrado ? " [encerramento]" : ""}\n      ${mudou.join("\n      ")}`);
  }
  console.log(`\nviolações do critério de aceite: ${violacoes}`);
  if (violacoes > 0) process.exitCode = 1;
}

(async () => {
  if (DIFF) {
    diff(JSON.parse(readFileSync(DIFF[0], "utf8")), JSON.parse(readFileSync(DIFF[1], "utf8")));
    return;
  }
  const linhas = await medir();
  for (const l of linhas) {
    if (l.erro) { console.log(`  ⚠ ${l.arquivo}: ${l.erro}`); continue; }
    const selo = !l.encerrado ? "  " : l.p4?.ok ? "✓ " : "✗ ";
    console.log(`${selo}${basename(l.arquivo)}${l.encerrado ? " [encerramento]" : ""}  A=${f(l.ativo)}  DRE=${f(l.somaDRE)}${l.p4 ? `  P4 ${l.p4.ok ? "ok" : "reprova"}${l.p4.verificavel ? ` (âncora "${l.p4.ancora}")` : " (não-verificável)"}` : ""}`);
  }
  if (JSON_OUT) { writeFileSync(JSON_OUT, JSON.stringify(linhas, null, 2), "utf8"); console.log(`\nplacar gravado em ${JSON_OUT}`); }
})();
