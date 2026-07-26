/**
 * SEED DA BELAGRO no ambiente local — carrega o Business Plan da planilha de
 * referência como um Modelo Financeiro do Quantua, para comparação lado a lado.
 *
 * Fonte dos números: `Business Plan - Belagro_mai.26.xlsm`, extraído por
 * `extrair_belagro.py` para um JSON (caminho no argumento ou BELAGRO_JSON).
 * Ver PLANO_BUSINESS_PLAN_BELAGRO.md.
 *
 * Idempotente: rodar de novo REFAZ o modelo da Belagro (apaga o anterior da
 * mesma empresa e recria). Só mexe em ambiente local — recusa rodar se a
 * DATABASE_URL não apontar para localhost.
 *
 * Uso:  node scripts/seed-belagro.mjs [caminho/para/belagro.json]
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const prisma = new PrismaClient();

// ── Trava de segurança: só ambiente local ──────────────────────────────────
const url = process.env.DATABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1/.test(url)) {
  console.error("Recusado: DATABASE_URL nao aponta para localhost. Este seed e' so' para ambiente de teste local.");
  process.exit(1);
}

const jsonPath = process.argv[2] ?? process.env.BELAGRO_JSON;
if (!jsonPath) {
  console.error("Informe o caminho do belagro.json (argumento ou BELAGRO_JSON).");
  process.exit(1);
}
const d = JSON.parse(readFileSync(jsonPath, "utf-8"));

const MESES = d.meses;
const mesesReais = Object.entries(d.flagRealizado).filter(([, v]) => v === "Realizado").map(([m]) => m);

/** Soma uma série num conjunto de meses. */
const soma = (serie, ms) => ms.reduce((a, m) => a + (serie[m] ?? 0), 0);
const anoDe = (ano) => MESES.filter((m) => m.startsWith(String(ano)));

/** Nó de série mensal explícita (os valores vêm da planilha, mês a mês). */
const noSerie = (id, nome, valores, unidade = "R$") => ({
  id, tipo: "serie", nome, unidade, params: { valores },
});

// ── Blocos ─────────────────────────────────────────────────────────────────

/** Receitas: 7 famílias (modo Agrupado da planilha) + grãos + serviços. */
function blocoReceitas() {
  const linhas = [];
  let ordem = 0;

  for (const f of d.agrupado.familias) {
    const raiz = `fam_${f.id}_receita`;
    linhas.push({
      id: `fam_${f.id}`, nome: f.nome, template: "agro_agrupado", nodeRaiz: raiz, ordem: ordem++,
      nodes: [
        { id: `fam_${f.id}_margem`, tipo: "taxa", nome: `Margem bruta — ${f.nome}`, unidade: "%", params: { valores: f.margem, max: 1 } },
        noSerie(raiz, `Memória de Cálculo — ${f.nome}`, f.receita),
      ],
    });
  }

  // Grãos: volume em kg e preço por saca de 60 kg, como na planilha.
  linhas.push({
    id: "grao_revenda", nome: "Grãos (revenda)", template: "agro_graos", nodeRaiz: "grao_revenda_receita", ordem: ordem++,
    nodes: [
      noSerie("grao_revenda_volume_kg", "Volume vendido (kg)", d.agrupado.graos.volumeKg, "#"),
      noSerie("grao_revenda_preco_saca", "Preço por saca (60 kg)", d.agrupado.graos.precoSaca, "R$/un"),
      { id: "grao_revenda_sacas", tipo: "formula", nome: "Sacas vendidas (60 kg por saca)", unidade: "#", params: { expr: "grao_revenda_volume_kg / 60" } },
      { id: "grao_revenda_receita", tipo: "formula", nome: "Memória de Cálculo — Grãos (revenda)", unidade: "R$", params: { expr: "grao_revenda_sacas * grao_revenda_preco_saca" } },
    ],
  });

  linhas.push({
    id: "servicos", nome: "Serviços prestados", template: "generico", nodeRaiz: "servicos_receita", ordem: ordem++,
    nodes: [noSerie("servicos_receita", "Memória de Cálculo — Serviços prestados", d.agrupado.servicos)],
  });

  return { linhasReceita: linhas };
}

/** Custos: custo por família + custo dos grãos + os três baldes de frete. */
function blocoCustos() {
  const linhas = [];
  let ordem = 0;
  for (const f of d.agrupado.familias) {
    linhas.push({ id: `custo_${f.id}`, nome: `Custo — ${f.nome}`, modo: "serie", valores: f.custo, ordem: ordem++ });
  }
  linhas.push({ id: "custo_graos", nome: "Custo — Grãos (compra)", modo: "serie", valores: d.agrupado.graos.custo, ordem: ordem++ });
  linhas.push({ id: "frete_insumos", nome: "Frete — Insumos", modo: "serie", valores: d.agrupado.fretes.insumos, ordem: ordem++ });
  linhas.push({ id: "frete_graos", nome: "Frete — Grãos", modo: "serie", valores: d.agrupado.fretes.graos, ordem: ordem++ });
  linhas.push({ id: "frete_despesas", nome: "Frete — Despesas", modo: "serie", valores: d.agrupado.fretes.despesas, ordem: ordem++ });
  return { linhasCusto: linhas };
}

/**
 * Dívida: os 11 contratos. A planilha zera o saldo antes da data-base e o
 * estampa nela — aqui isso vira uma CAPTAÇÃO no mês da data-base pelo saldo
 * devedor, amortizando pelo prazo restante (mesmo comportamento, explícito).
 */
function blocoDivida() {
  const dataBase = d.divida.dataBase.slice(0, 7); // "2025-10"
  const mesesEntre = (de, ate) => {
    const [y1, m1] = de.split("-").map(Number);
    const [y2, m2] = ate.split("-").map(Number);
    return (y2 * 12 + m2) - (y1 * 12 + m1);
  };
  return {
    contratos: d.divida.contratos.map((c, i) => {
      const venc = (c.vencimentoFinal ?? "").slice(0, 7);
      const prazo = venc ? Math.max(1, mesesEntre(dataBase, venc)) : (c.prazoMeses || 12);
      return {
        id: `div_${i + 1}`,
        nome: `${c.instituicao}${c.modalidade ? ` · ${c.modalidade}` : ""}`,
        sistema: "sac",
        principal: c.saldoDevedor,
        mesCaptacao: dataBase,
        prazoMeses: prazo,
        taxaAnual: c.taxaAnual,
        indexador: c.indexador || undefined,
        ordem: i,
      };
    }),
  };
}

/** Capital de giro: prazos médios ORÇADOS (os que a planilha projeta). */
function blocoGiro() {
  const primeiroProjetado = MESES.find((m) => d.flagRealizado[m] !== "Realizado") ?? MESES[0];
  const pm = (k) => Math.round((d.prazosOrcados[k]?.[primeiroProjetado] ?? 0) * 100) / 100;
  return {
    pmr: pm("pmr"),
    pme: pm("pme"),
    pmp: pm("pmp"),
    caixaInicial: d.realizadoBp.caixa.valores[MESES[0]] ?? 0,
  };
}

/** Realizado: os 29 meses fechados da planilha (jan/24 a mai/26). */
function realizado() {
  return {
    meses: mesesReais,
    porGrupo: {
      receita: Object.fromEntries(mesesReais.map((m) => [m, d.realizadoDre["receita-bruta"].valores[m] ?? 0])),
      custos: Object.fromEntries(mesesReais.map((m) => [m, d.realizadoDre["cmv"].valores[m] ?? 0])),
      despesas: Object.fromEntries(mesesReais.map((m) => [m, d.realizadoDre["despesas-operacionais"].valores[m] ?? 0])),
    },
    // Proveniência: de onde vieram estes números.
    fonte: {
      arquivo: "Business Plan - Belagro_mai.26.xlsm",
      abas: "Realizado (DRE mensal), Orçamento_Receita_Agrupado (orçamento), Endividamento (dívida)",
      carregadoEm: new Date().toISOString(),
    },
  };
}

// ── Execução ───────────────────────────────────────────────────────────────

const user = await prisma.user.findFirst({ where: { email: "partner@quantua-demo.test" } });
if (!user) { console.error("Usuario de demo nao encontrado. Rode: npm run db:seed:demo"); process.exit(1); }

let empresa = await prisma.company.findFirst({ where: { razaoSocial: { contains: "Belagro", mode: "insensitive" } } });
if (!empresa) {
  empresa = await prisma.company.create({
    data: {
      userId: user.id,
      razaoSocial: "Belagro Comércio de Insumos Agrícolas Ltda",
      nomeFantasia: "Belagro",
      setor: "Agropecuária",
      porte: "Média",
      status: "ativo",
    },
  });
  console.log(`empresa criada: ${empresa.nomeFantasia} [${empresa.id}]`);
} else {
  console.log(`empresa ja existia: ${empresa.nomeFantasia} [${empresa.id}]`);
}

// Refaz o modelo (idempotente).
const antigos = await prisma.financialModel.findMany({ where: { companyId: empresa.id }, select: { id: true } });
if (antigos.length) {
  await prisma.financialModel.deleteMany({ where: { companyId: empresa.id } });
  console.log(`modelo(s) anterior(es) removido(s): ${antigos.length}`);
}

const model = await prisma.financialModel.create({
  data: {
    companyId: empresa.id,
    userId: user.id,
    nome: "Business Plan Belagro — mai/26",
    objetivo: "business-plan",
    mesInicial: MESES[0],
    horizonteMeses: MESES.length,
    visao: "anual",
    status: "Em produção",
    realizado: realizado(),
    blocks: {
      create: [
        { tipo: "receitas", nome: "Receitas", ordem: 0, modo: "simples", config: blocoReceitas() },
        { tipo: "custos", nome: "Custos e despesas", ordem: 1, modo: "simples", config: blocoCustos() },
        { tipo: "giro", nome: "Capital de giro", ordem: 6, modo: "simples", config: blocoGiro() },
        { tipo: "divida", nome: "Dívida", ordem: 8, modo: "simples", config: blocoDivida() },
      ],
    },
    scenarios: { create: [{ nome: "Base", isBase: true, overrides: {} }] },
  },
  include: { scenarios: true },
});

await prisma.financialModel.update({
  where: { id: model.id },
  data: { cenarioAtivoId: model.scenarios[0].id },
});

console.log(`modelo criado: ${model.nome} [${model.id}]`);
console.log(`  ${MESES.length} meses (${MESES[0]} .. ${MESES[MESES.length - 1]}), ${mesesReais.length} realizados`);
console.log(`  contratos de divida: ${blocoDivida().contratos.length}`);

// ── Conferência contra a planilha ──────────────────────────────────────────
const rec2026 =
  d.agrupado.familias.reduce((a, f) => a + soma(f.receita, anoDe(2026)), 0) +
  soma(d.agrupado.graos.receita, anoDe(2026)) +
  soma(d.agrupado.servicos, anoDe(2026));

console.log("\nCONFERENCIA (planilha):");
console.log(`  Receita orcada 2026        : ${rec2026.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}  (Forecast!CF154 = 845.035.450,00)`);
console.log(`  Receita realizada 2025     : ${soma(d.realizadoDre["receita-bruta"].valores, anoDe(2025)).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`);
console.log(`  EBITDA realizado 2025      : ${soma(d.realizadoDre["ebitda"].valores, anoDe(2025)).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`);
console.log(`  Lucro liquido 2025         : ${soma(d.realizadoDre["lucro-liquido"].valores, anoDe(2025)).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`);

console.log(`\nAbra: http://localhost:5199/modelos/${model.id}`);

await prisma.$disconnect();
