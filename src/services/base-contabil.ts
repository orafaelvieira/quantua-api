/**
 * BASE CONTÁBIL DA EMPRESA — a montagem única.
 *
 * ESTE É O CORAÇÃO (regra do dono, 11/08/2026): "o processo de extração e
 * conciliação contábil para montar as DFs é o coração da Quantua, erro zero
 * aqui". Tudo que consome número contábil — a aba Conciliação contábil, a aba
 * DFs, e daqui para frente o IBR e os indicadores — precisa ler DA MESMA
 * montagem. Duas montagens paralelas seriam duas verdades, e a segunda a ser
 * corrigida ficaria mentindo até alguém notar.
 *
 * O que ela faz, em ordem:
 *   1. junta os documentos do pool da empresa (balancetes + BP/DRE anuais);
 *   2. lê cada um pela leitura da porta (determinística; IA só na cascata do
 *      upload) e roda as PROVAS CRUZADAS de cada documento;
 *   3. dobra tudo nos modelos vigentes de BP e DRE, com o dicionário resolvido
 *      na cascata global → workspace → empresa;
 *   4. deriva o Fluxo de Caixa indireto do BP/DRE dobrados;
 *   5. devolve, junto com os números, TUDO que prova (ou desmente) o resultado:
 *      relatório por documento, prova patrimonial por coluna, conservação de
 *      valor, pendências de classificação com sugestão, e o veredito de
 *      conciliação por documento.
 *
 * Extraída de routes/fechamento.ts em 11/08/2026 SEM mudança de comportamento
 * (A/B byte a byte do payload nas 6 empresas do banco local) — o objetivo era
 * exatamente ter uma função chamável pelo IBR, não só por uma rota HTTP.
 */
import { gravarLeituraPorta, parseadoDaLeitura, VERSAO_LEITOR_DEMONSTRATIVO, type LeituraPortaConteudo, type LeituraDemonstrativoConteudo } from "./leitura-porta";
import { prisma } from "../db/client";
import { converterBalancete, ehNomeDeApuracao, periodosQueAcumulam } from "./balancete-conversao";
import { foldBP, foldDRE, type NaoMapeado, type BPN3Item } from "./ai-extraction";
import { sugerirConta, GRUPO_CLASSIF_MAP, ordPeriodo } from "./account-mapper";
import { sugerirContaCanonica } from "./sugerir-conta-canonica";
import { getActiveModelVersions, loadActiveBPModel, loadActiveDREModel } from "./model-version";
import { resolverCascataDicionario, whereCascataDicionarioAtiva } from "./dicionario-escopo";
import { buildIndirectCashFlow } from "./cash-flow-indirect";
import type { BPLineItem, DRELineItem } from "../types/financial";

const fmtBRL = (v: number): string => {
  const abs = Math.abs(v);
  if (abs >= 1e6) return `R$ ${(v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (abs >= 1e3) return `R$ ${(v / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
  return `R$ ${v.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}`;
};

/**
 * VERSÃO DO CONTRATO DA BASE. Sobe quando a MONTAGEM muda de resultado (não
 * quando só se acrescenta campo): entra na marca do cache, então subir aqui
 * invalida tudo que estava guardado — é como um conserto chega a quem já
 * tinha o número velho na tela.
 */
export const VERSAO_BASE = 1;

/** Insumos + impressão digital deles. Separado da montagem de propósito: a
 *  marca é BARATA (ids/hashes/agregados) e serve para o cache decidir se
 *  precisa pagar o fold, que é caro. */
export type InsumosBase = {
  docs: Awaited<ReturnType<typeof buscarDocs>>;
  versoesAtivas: Awaited<ReturnType<typeof getActiveModelVersions>>;
  marca: string;
};

const buscarDocs = (companyId: string, documentIds?: string[] | null) => prisma.document.findMany({
  where: {
    companyId, analysisId: null, status: { not: "Substituído" },
    ...(documentIds && documentIds.length ? { id: { in: documentIds } } : {}),
  },
  include: { leituraPorta: { select: { conteudo: true, hashArquivo: true, criadoEm: true } } },
  orderBy: { createdAt: "asc" },
});

/**
 * @param documentIds SELEÇÃO do produto (IBR): monta a base só com estes
 *   documentos. `null`/vazio = pool inteiro da empresa (a aba Conciliação
 *   contábil, que mostra tudo). O filtro mora aqui, e não na montagem, para a
 *   MARCA do cache já carregar a seleção — duas seleções diferentes da mesma
 *   empresa são duas bases diferentes e não podem compartilhar cache.
 */
export async function insumosDaBase(companyId: string, scopeUserIds: string[], documentIds?: string[] | null): Promise<InsumosBase> {
  const docs = await buscarDocs(companyId, documentIds);
  // Impressão digital dos insumos — barata: ids/hashes já vieram na query
  // acima; dicionário por agregado; modelos por versão ativa.
  const dictAgg = await prisma.accountDictionary.aggregate({
    where: whereCascataDicionarioAtiva(scopeUserIds, companyId),
    // ORDEM DETERMINÍSTICA (13/08/2026): sem isto o empate entre duas linhas
    // da MESMA camada é decidido pela ordem física do heap do Postgres — o mesmo
    // IBR, refoldado duas vezes sem mudar insumo, podia trocar de destino.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    _count: { _all: true },
    _max: { updatedAt: true },
  });
  const versoesAtivas = await getActiveModelVersions(companyId);
  const marca = JSON.stringify([
    VERSAO_BASE,
    documentIds && documentIds.length ? [...documentIds].sort() : null,
    docs.map((d) => [d.id, d.hash, d.status, d.leituraPorta?.hashArquivo ?? null, d.leituraPorta?.criadoEm ?? null]),
    dictAgg._count._all, dictAgg._max.updatedAt,
    versoesAtivas,
  ]);
  return { docs, versoesAtivas, marca };
}

/**
 * O QUE MUDOU ENTRE DUAS MARCAS.
 *
 * A marca é uma impressão digital, e impressão digital só responde "sim/não".
 * Isso não basta para o analista: "a base mudou" sem dizer O QUE mudou é um
 * aviso que ele não consegue conferir — foi exatamente a reclamação de
 * 12/08/2026 ("não localizei esta mudança"). Aqui a marca é DESMONTADA e a
 * diferença sai com nome de documento e natureza da mudança.
 *
 * O formato da marca é definido em `insumosDaBase` — as duas funções andam
 * juntas de propósito: mudou o formato lá, o leitor aqui acompanha.
 */
export function diferencasDaMarca(
  gravada: string,
  atual: string,
  nomePorId: Record<string, string>,
): string[] {
  const parse = (m: string) => {
    try {
      const [versao, selecao, docs, dictCount, dictMax, modelos] = JSON.parse(m) as [
        number, string[] | null, Array<[string, string | null, string, string | null, string | null]>, number, string | null, unknown,
      ];
      return { versao, selecao, docs, dictCount, dictMax, modelos };
    } catch { return null; }
  };
  const a = parse(gravada), b = parse(atual);
  if (!a || !b) return ["a impressão digital dos insumos mudou de formato (o motor foi atualizado) — reprocesse para alinhar"];

  const fora: string[] = [];
  const nome = (id: string) => nomePorId[id] ?? `documento ${id.slice(0, 8)}`;
  const porId = (docs: typeof a.docs) => new Map(docs.map((d) => [d[0], d]));
  const antes = porId(a.docs), agora = porId(b.docs);

  for (const [id] of agora) if (!antes.has(id)) fora.push(`"${nome(id)}" entrou na base depois desta extração`);
  for (const [id] of antes) if (!agora.has(id)) fora.push(`"${nome(id)}" saiu da base (substituído ou removido) depois desta extração`);
  for (const [id, d] of agora) {
    const v = antes.get(id);
    if (!v) continue;
    if (v[1] !== d[1]) fora.push(`"${nome(id)}" teve o ARQUIVO trocado (hash diferente)`);
    else if (v[3] !== d[3] || v[4] !== d[4]) fora.push(`"${nome(id)}" foi LIDO de novo na Data room (leitura refeita)`);
    else if (v[2] !== d[2]) fora.push(`"${nome(id)}" mudou de status (${v[2]} → ${d[2]})`);
  }
  if (a.dictCount !== b.dictCount || a.dictMax !== b.dictMax) {
    const delta = b.dictCount - a.dictCount;
    fora.push(delta > 0
      ? `o dicionário da empresa ganhou ${delta} classificação(ões) — contas que estavam em "Outros" podem ter destino agora`
      : "o dicionário da empresa mudou depois desta extração");
  }
  if (JSON.stringify(a.modelos) !== JSON.stringify(b.modelos)) fora.push("o modelo padrão de BP/DRE mudou de versão depois desta extração");
  if (JSON.stringify(a.selecao) !== JSON.stringify(b.selecao)) fora.push("a seleção de documentos deste IBR mudou depois da extração");
  return fora.length ? fora : ["algum insumo da base mudou depois desta extração"];
}

export type BaseContabil = Awaited<ReturnType<typeof montarBaseContabilSemCache>>;

/** Monta a base. Recebe os insumos já buscados (o cache os usa para decidir). */
/**
 * CACHE DA MONTAGEM — mora aqui, e não em quem chama.
 *
 * O fold custa 20s+ de CPU numa instância ÚNICA e a mesma base é pedida por
 * três lugares diferentes: a aba Conciliação contábil, o seletor de documentos
 * do IBR (a cada clique de checkbox!) e o próprio /process. Cache em um só
 * chamador deixaria os outros dois pagando o preço inteiro.
 *
 * A chave separa o que produz resultado diferente: empresa, ESCOPO DE ACESSO
 * (o dicionário resolvido muda com ele — cache sem isso vaza entre escritórios),
 * seleção de documentos e o modo `paraProduto`. A `marca` dos insumos decide se
 * o que está guardado ainda vale.
 */
const memo = new Map<string, { marca: string; payload: unknown }>();
const emVoo = new Map<string, Promise<unknown>>();
const TETO_MEMO = 40;

/** Espera a montagem em curso, com TETO: bug que impeça a liberação não pode
 *  virar espera eterna — passado o teto, cada um monta a sua. */
const esperarComTeto = async (p: Promise<unknown>, ms = 60_000): Promise<void> => {
  let t: NodeJS.Timeout | undefined;
  await Promise.race([p.catch(() => {}), new Promise<void>((r) => { t = setTimeout(r, ms); })]);
  if (t) clearTimeout(t);
};

/**
 * @param paraProduto quando true, o retorno carrega também o CONTRATO DO
 *   PRODUTO (árvores mensais por documento, provas por balancete, subtotais
 *   declarados, alertas de composição). São dados pesados — as árvores já
 *   viajam em `arvoreOriginal*` para a tela — e só o IBR precisa deles; a aba
 *   Conciliação contábil não pagaria por isso à toa (o payload da Belagro já
 *   tem 287 KB).
 */
export async function montarBaseContabil(
  companyId: string,
  scopeUserIds: string[],
  insumos: InsumosBase,
  opcoes: { paraProduto?: boolean } = {},
): Promise<BaseContabil> {
  const chave = [
    companyId,
    [...scopeUserIds].sort().join(","),
    opcoes.paraProduto ? "produto" : "tela",
    insumos.docs.map((d) => d.id).sort().join(","),
  ].join("|");

  const guardado = memo.get(chave);
  if (guardado && guardado.marca === insumos.marca) return guardado.payload as BaseContabil;

  // SINGLE-FLIGHT: quem chega no meio de uma montagem espera a dela em vez de
  // começar outra (a tela abre, o analista recarrega, o wizard consulta).
  const emAndamento = emVoo.get(chave);
  if (emAndamento) {
    await esperarComTeto(emAndamento);
    const pronto = memo.get(chave);
    if (pronto && pronto.marca === insumos.marca) return pronto.payload as BaseContabil;
  }

  const promessa = montarBaseContabilSemCache(companyId, scopeUserIds, insumos, opcoes);
  emVoo.set(chave, promessa);
  try {
    const payload = await promessa;
    if (memo.size >= TETO_MEMO) memo.delete(memo.keys().next().value!);
    memo.set(chave, { marca: insumos.marca, payload });
    return payload;
  } finally {
    if (emVoo.get(chave) === promessa) emVoo.delete(chave);
  }
}

async function montarBaseContabilSemCache(
  companyId: string,
  scopeUserIds: string[],
  insumos: InsumosBase,
  opcoes: { paraProduto?: boolean } = {},
) {
  const { docs, versoesAtivas } = insumos;
  const avisos: string[] = [];
  const fontes: Array<{ id: string; nome: string; conteudo: LeituraPortaConteudo }> = [];
  // RELATÓRIO DE VALIDAÇÃO por documento (09/08/2026, pedido do dono: o
  // quadro do IBR não aparecia no workspace): leitura + provas aritméticas,
  // um check por documento — a tela marca ✓/✗ cruzando com as pendências.
  const relatorio: Array<{ documentId: string; nome: string; contas: number; periodo: string | null; lido: boolean; fechamentoOk: boolean | null; erro: string | null }> = [];
  // DEMONSTRATIVOS ANUAIS (10/08/2026, pedido do dono: "não é apenas balancete
  // — também balanço patrimonial e DRE"): entram pela MESMA linha determinística
  // do IBR (árvore do BP por indentação; árvore da DRE com prova de partição —
  // funções puras, o fluxo do IBR não muda). SEM IA: documento que a linha
  // determinística não lê fica declarado no relatório.
  const docsDemonstrativos = docs.filter((d) => /^(dre|balan[çc]o patrimonial)$/i.test(d.tipo.trim()));
  for (const d of docs) {
    if (!/balancete/i.test(d.tipo)) continue;
    const lp = d.leituraPorta;
    const c = lp?.conteudo as unknown as LeituraPortaConteudo | undefined;
    if (!lp || (d.hash && lp.hashArquivo !== d.hash) || !c) {
      avisos.push(`${d.nome}: ainda sem leitura da porta (abra a Data room — a leitura roda sozinha).`);
      relatorio.push({ documentId: d.id, nome: d.nome, contas: 0, periodo: null, lido: false, fechamentoOk: null, erro: "ainda sem leitura da porta" });
      continue;
    }
    if (c.erro) {
      avisos.push(`${d.nome}: ${c.erro}`);
      relatorio.push({ documentId: d.id, nome: d.nome, contas: 0, periodo: null, lido: false, fechamentoOk: null, erro: c.erro });
      continue;
    }
    // P0 — PARTIDA DOBRADA (10/08/2026): Σ débitos = Σ créditos nas linhas que
    // o sistema LEU. É a prova cruzada que não depende de total impresso e que
    // pega linha perdida no parse. Ela vale para o selo do documento e o motivo
    // vai junto — no corpus, 9 documentos que passavam verdes reprovaram aqui.
    const pd = c.provas?.partidaDobrada;
    const partidaOk = pd?.verificavel ? pd.ok : true;
    if (pd?.verificavel && !pd.ok) {
      avisos.push(
        `${d.nome}: a leitura não fecha em partida dobrada — débitos ${fmtBRL(pd.debitos)} × créditos ${fmtBRL(pd.creditos)} (diferença ${fmtBRL(pd.delta)}) em ${pd.folhas} conta(s). Alguma linha ficou de fora ou foi lida torta.`,
      );
    }
    relatorio.push({
      documentId: d.id, nome: d.nome, contas: c.totalContas,
      periodo: c.periodoInicio && c.periodoFim ? `${c.periodoInicio} a ${c.periodoFim}` : null,
      lido: true,
      fechamentoOk: c.provas ? !!(c.provas.fechamento.ok && c.provas.linhas.ok && partidaOk && (c.provas.resumoDeclarado?.ok ?? true)) : null,
      erro: pd?.verificavel && !pd.ok
        ? `partida dobrada não fecha: diferença de ${fmtBRL(pd.delta)} entre débitos e créditos lidos`
        : null,
    });
    fontes.push({ id: d.id, nome: d.nome, conteudo: c });
  }

  // Dicionário na CASCATA (global → workspace → empresa), resolvido POR TIPO —
  // a mesma régua do /refold do IBR.
  const dictRowsBrutos = await prisma.accountDictionary.findMany({
    where: whereCascataDicionarioAtiva(scopeUserIds, companyId),
    // ORDEM DETERMINÍSTICA (13/08/2026): sem isto o empate entre duas linhas
    // da MESMA camada é decidido pela ordem física do heap do Postgres — o mesmo
    // IBR, refoldado duas vezes sem mudar insumo, podia trocar de destino.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { nomeOriginal: true, contaDestino: true, grupoConta: true, userId: true, companyId: true, tipo: true },
  });
  const dictRows = [...resolverCascataDicionario(dictRowsBrutos, "BP"), ...resolverCascataDicionario(dictRowsBrutos, "DRE")];
  const bpModel = await loadActiveBPModel(companyId);
  const dreModel = await loadActiveDREModel(companyId);

  // Os itens carregam TUDO que o fold devolve (nivel, classificacao…) — o
  // Fluxo de Caixa indireto lê nivel/classificacao do BP; só os `valores`
  // são mesclados entre períodos.
  type Item = { conta: string; valores: Record<string, number> } & Record<string, unknown>;
  const bp: Item[] = [];
  const dre: Item[] = [];
  const mergeItens = (alvo: Item[], novos: Item[]) => {
    for (const n of novos) {
      const ex = alvo.find((x) => x.conta === n.conta);
      if (!ex) { alvo.push({ ...n, valores: { ...n.valores } }); continue; }
      for (const [pk, v] of Object.entries(n.valores)) ex.valores[pk] = v;
    }
  };
  /**
   * PENDÊNCIA TEM DONO (12/08/2026 — varredura adversarial).
   *
   * `naoMapeados` era consolidado só por PERÍODO, e o veredito do documento
   * somava tudo que caísse na mesma coluna. Um BP anual com todas as contas
   * classificadas ficava "✗ 5 contas sem classificação" porque a DRE do MESMO
   * ANO tinha cinco — e o analista via vermelho num documento sem defeito, com
   * o checkbox travado. Agora cada pendência sai carimbada com o documento que
   * a produziu, e o selo de cada um julga só o que é dele.
   */
  const naoMapeados: Array<NaoMapeado & { docId?: string }> = [];
  const comDono = (ns: NaoMapeado[], docId: string) => ns.map((n) => ({ ...n, docId }));
  // AUDITORIA (09/08/2026, pedido do dono: "verificar o que foi feito"): o
  // fold carimba `destino` em cada nó da árvore ORIGINAL — devolvemos as
  // árvores no shape que o OriginalTreeView do IBR já lê (mesma tela).
  const arvoreOriginalBP: Record<string, unknown> = {};
  const arvoreOriginalDRE: Record<string, unknown> = {};
  const periodos: string[] = [];
  /** Períodos de balancete que publicaram DRE — um encerramento reprovado no P4 fica fora. */
  const periodosComDRE: string[] = [];
  const origemPorPeriodo: Record<string, string> = {};
  /** Como rotular cada coluna: "mes" → 05/2026 · "exercicio" → 2026. */
  const tipoPorPeriodo: Record<string, "mes" | "exercicio"> = {};
  /** CONSERVAÇÃO DE VALOR por coluna: o que entrou do documento × o que saiu
   *  para as linhas. Quando não bate, a conta onde o dinheiro ficou vem junto. */
  const conservacaoPorPeriodo: Record<string, { entrou: number; saiu: number; diferenca: number; ok: boolean; vazamentos: Array<{ conta: string; grupo: string; valor: number; motivo: string }> }> = {};
  const provasPorPeriodo: Record<string, unknown> = {};
  /**
   * INTERVALO COBERTO POR DOCUMENTO (11/08/2026). A regra da SÉRIE CONTÍNUA
   * (services/serie-periodos.ts) se mede por intervalo, não por rótulo de
   * coluna: um balancete de junho é ACUMULADO e cobre desde 1º de janeiro.
   * Quem sabe o intervalo é a leitura do documento — então ele viaja daqui.
   */
  const intervaloPorDocumento: Record<string, { inicio: string; fim: string; tipo: "mes" | "exercicio" }> = {};
  /** Documento cujas colunas já vinham de outra fonte — não entrou na montagem. */
  const coberturaDuplicada = new Map<string, string[]>();
  // ── CONTRATO PARA O PRODUTO (11/08/2026) ──
  // O IBR precisa de mais do que a tela: as árvores MENSAIS por documento (o
  // /refold as re-dobra quando o dicionário muda, e os prazos médios YTD saem
  // dos períodos delas), os subtotais DECLARADOS no documento (a validação
  // reconcilia a DRE montada contra eles) e os alertas de composição do fold.
  // Sem estes campos o plug do IBR na base seria retrocesso: o produto perderia
  // provas que hoje ele tem.
  const arvoresBalancete: Array<{ docId: string; nome: string; periodo: string; arvoreBP: unknown; arvoreDRE: unknown }> = [];
  const balancetes: Array<{ docId: string; nome: string; periodo: string; provas: unknown; gruposExcluidos: unknown; avisos: string[] }> = [];
  const declarados: Record<string, Record<string, number>> = {};
  const alertasComposicao: unknown[] = [];
  for (const f of fontes) {
    // A instância do Cloud Run é ÚNICA: 20s+ de fold síncrono travariam todas
    // as requisições — devolve o event loop entre documentos.
    await new Promise((r) => setImmediate(r));
    try {
      // A ponte é `parseadoDaLeitura` (leitura-porta.ts), NUNCA um objeto montado
      // à mão aqui: é AQUI que a base é montada, então é aqui que a duplicação
      // simétrica tem de ser pega — e ela só é pega com o rodapé do documento
      // (`totais` e `resumo`), que a montagem manual deixava de fora em silêncio.
      const conv = converterBalancete(parseadoDaLeitura(f.conteudo));
      const periodo = conv.periodoBP;
      if (periodos.includes(periodo)) {
        avisos.push(`${f.nome}: período ${periodo} já coberto por outro balancete — este ficou de fora (remova a duplicidade na Data room).`);
        continue;
      }
      periodos.push(periodo);
      origemPorPeriodo[periodo] = f.nome;
      provasPorPeriodo[periodo] = conv.provas;
      // P4 (10/08/2026, caso Belagro 2023): DRE de exercício ENCERRADO só é
      // verde se reconciliar com o resultado que o próprio PL registra. As
      // provas vêm da conversão FRESCA daqui (a leitura gravada é anterior a
      // esta prova e não a carrega).
      const p4 = conv.provas.dreEncerrada;
      /**
       * DRE REPROVADA NÃO É PUBLICADA (17/08/2026, caso Belagro 2023).
       *
       * Até aqui a DRE do encerramento entrava na base mesmo reprovando o P4 —
       * o aviso ficava na tela e o número ia para as DFs, os indicadores, o
       * Dashboard e a análise. No Belagro 2023 isso significava um prejuízo de
       * R$ 85,9 mi num ano em que a empresa apurou R$ 6,8 mi de lucro.
       *
       * Pior: `cobertoDRE` nascia com TODOS os períodos de balancete, então a
       * DRE OFICIAL de 2023, se o analista a subisse, seria recusada com "já
       * coberto por outra fonte de DRE". O número falso trancava a porta do
       * número certo.
       *
       * Agora o documento contribui só com o BP (que fecha ao centavo e tem a
       * prova do rodapé) e a coluna de DRE fica ABERTA para a fonte correta.
       * Suprimir sem prova é proibido; aqui a prova de que o número não é fato
       * é o próprio P4, medido contra o PL do documento.
       */
      const dreReprovada = !!(p4 && !p4.ok);
      if (dreReprovada && p4) {
        avisos.push(
          `${f.nome}: balancete de ENCERRAMENTO — a DRE derivada do movimento (${fmtBRL(p4.derivado)}) não reconcilia com o resultado que o próprio PL registra no ano (${fmtBRL(p4.declaradoPL)}). ` +
          `Transferência interna entre contas de resultado infla os dois lados, então esta DRE NÃO foi publicada: o documento entrou só com o balanço patrimonial (que fecha) e a coluna de resultado deste exercício segue em aberto. ` +
          `Para preenchê-la, suba a demonstração oficial do exercício ou um balancete de dezembro ANTES do encerramento.`,
        );
        const linha = relatorio.find((r) => r.documentId === f.id);
        if (linha) {
          linha.fechamentoOk = false;
          linha.erro = `DRE do encerramento não reconcilia com o PL (${fmtBRL(p4.derivado)} × ${fmtBRL(p4.declaradoPL)}) — não publicada`;
        }
      }
      // P5 (17/08/2026, caso Belagro 12/2025): o RESUMO do rodapé é o número que
      // o contador escreveu — a única prova que enxerga duplicação SIMÉTRICA, que
      // passa por P0/P2/P3 sem arranhão. Vem da conversão FRESCA por dois motivos:
      // a leitura gravada pode ser de leitor anterior a esta prova, e o selo tem
      // de reprovar hoje, não na próxima releitura.
      const p5 = conv.provas.resumoDeclarado;
      if (p5 && !p5.ok) {
        const falhos = p5.itens.filter((x) => !x.ok);
        for (const x of falhos) {
          avisos.push(
            `${f.nome}: ${x.o} montado em ${fmtBRL(x.montado)}, mas o resumo do próprio documento declara ${fmtBRL(x.declarado)} (diferença de ${fmtBRL(x.gap)}). Enquanto os dois não coincidirem, este número não é fato.`,
          );
        }
        const linha = relatorio.find((r) => r.documentId === f.id);
        if (linha) {
          linha.fechamentoOk = false;
          linha.erro = `${falhos.map((x) => x.o).join(", ")} ${falhos.length > 1 ? "divergem" : "diverge"} do resumo declarado no documento (${falhos.map((x) => `${fmtBRL(x.montado)} × ${fmtBRL(x.declarado)}`).join(" · ")})`;
        }
      }
      // Balancete que cobre o exercício INTEIRO (01/01 a 31/12) é exercício; o
      // resto é mês — a tela rotula "2025" × "05/2026" a partir daqui.
      tipoPorPeriodo[periodo] = /^01\/01\//.test(f.conteudo.periodoInicio ?? "") && /^31\/12\//.test(f.conteudo.periodoFim ?? "")
        ? "exercicio" : "mes";
      // A ÁRVORE REPROVADA NÃO VIAJA. `arvoresBalancete` é o que o IBR re-dobra
      // no /refold: deixar a DRE do encerramento aqui a faria RESSUSCITAR na
      // primeira reclassificação de conta — a tela da base sem a coluna e o IBR
      // com ela, o pior dos dois mundos. O BP continua indo (é ele que fecha).
      arvoresBalancete.push({
        docId: f.id, nome: f.nome, periodo,
        arvoreBP: conv.arvoreBP,
        arvoreDRE: dreReprovada ? {} : conv.arvoreDRE,
      });
      if (f.conteudo.periodoInicio && f.conteudo.periodoFim) {
        intervaloPorDocumento[f.id] = {
          inicio: f.conteudo.periodoInicio, fim: f.conteudo.periodoFim,
          tipo: tipoPorPeriodo[periodo] ?? "mes",
        };
      }
      balancetes.push({ docId: f.id, nome: f.nome, periodo, provas: conv.provas, gruposExcluidos: conv.gruposExcluidos, avisos: conv.avisos });
      const rBP = foldBP(conv.arvoreBP, [periodo], dictRows, bpModel);
      alertasComposicao.push(...rBP.alertasComposicao);
      for (const k of rBP.conservacao) conservacaoPorPeriodo[k.periodo] = k;
      mergeItens(bp, rBP.bp as unknown as Item[]);
      naoMapeados.push(...comDono(rBP.naoMapeados, f.id));
      if (!dreReprovada) {
        periodosComDRE.push(periodo);
        const rDRE = foldDRE(conv.arvoreDRE, [periodo], dictRows, dreModel);
        alertasComposicao.push(...rDRE.alertasComposicao);
        mergeItens(dre, rDRE.dre as unknown as Item[]);
        naoMapeados.push(...comDono(rDRE.naoMapeados, f.id));
      }
      // O fold MUTA as árvores carimbando destino/absorvido — é a auditoria.
      // SÓ a chave do PERÍODO DOBRADO viaja (09/08/2026, coluna em branco na
      // Belagro): a conversão devolve também o período de ABERTURA (saldo
      // anterior — o acumulado de 2024 carrega 31/12/2023 cru), e o assign
      // completo SOBRESCREVIA a árvore dobrada de um documento pela abertura
      // não-dobrada do documento seguinte — destino sumia da auditoria.
      if ((conv.arvoreBP as Record<string, unknown>)[periodo]) arvoreOriginalBP[periodo] = (conv.arvoreBP as Record<string, unknown>)[periodo];
      if ((conv.arvoreDRE as Record<string, unknown>)[periodo]) arvoreOriginalDRE[periodo] = (conv.arvoreDRE as Record<string, unknown>)[periodo];
    } catch (e) {
      avisos.push(`${f.nome}: conversão falhou (${e instanceof Error ? e.message : String(e)}).`);
    }
  }

  // ── DEMONSTRATIVOS (DRE / Balanço Patrimonial) ──
  // Balancete manda: período já coberto por balancete (ou por outro
  // demonstrativo do mesmo lado) fica de fora com aviso — nunca se soma duas
  // fontes na mesma coluna. Cobertura é POR LADO: um BP anual e uma DRE anual
  // do mesmo ano se completam.
  const cobertoBP = new Set(periodos);
  // A cobertura de DRE é só dos períodos que REALMENTE publicaram uma DRE. Um
  // encerramento reprovado no P4 entra no BP e deixa a coluna de resultado
  // aberta — senão o número que o motor recusou trancaria a porta do número
  // certo (a demonstração oficial do exercício).
  const cobertoDRE = new Set(periodosComDRE);
  // A árvore de auditoria da DRE segue a mesma régua: o que não foi publicado
  // não aparece como se tivesse sido.
  for (const p of periodos) if (!periodosComDRE.includes(p)) delete arvoreOriginalDRE[p];
  const canonico = (p: string) => (/^\d{4}$/.test(p.trim()) ? `31/12/${p.trim()}` : p.trim());
  const registraPeriodo = (p: string, nomeDoc: string) => {
    if (!periodos.includes(p)) periodos.push(p);
    origemPorPeriodo[p] = origemPorPeriodo[p] ? `${origemPorPeriodo[p]} · ${nomeDoc}` : nomeDoc;
    // Demonstrativo anual é EXERCÍCIO; se o mesmo período já veio de balancete
    // mensal, o mensal continua mandando (não vira "2026" o que é maio/26).
    tipoPorPeriodo[p] ??= "exercicio";
  };
  for (const d of docsDemonstrativos) {
    await new Promise((r) => setImmediate(r));
    const ehBP = /balan/i.test(d.tipo);
    const lp = d.leituraPorta;
    const c = lp?.conteudo as unknown as (LeituraDemonstrativoConteudo | undefined);
    // Avisos da leitura (ex.: competência declarada ≠ período lido) na tela.
    // O aviso ALARMISTA da cobertura ficou GRAVADO nas leituras da v5 antes de
    // 12/08/2026 ("a leitura perdeu N de M contas… alguma linha foi absorvida").
    // Parar de gerá-lo não apaga o que já está no banco, e re-ler todo o acervo
    // só por causa de uma frase seria pagar IA à toa: filtra-se na saída. A
    // frase honesta sobre o mesmo fato é emitida adiante, com a aritmética na mão.
    const RE_COBERTURA_ANTIGA = /^a leitura perdeu \d+ de \d+ conta/i;
    for (const a of c?.avisos ?? []) {
      if (RE_COBERTURA_ANTIGA.test(a.trim())) continue;
      avisos.push(`${d.nome}: ${a}`);
    }
    if (!lp || (d.hash && lp.hashArquivo !== d.hash) || !c || c.tipoLeitura !== "demonstrativo" || c.versaoLeitor !== VERSAO_LEITOR_DEMONSTRATIVO) {
      // Sem leitura ainda (documento legado, recém-substituído ou de leitor
      // ANTIGO): dispara em background e declara — a marca recalcula ao chegar.
      void gravarLeituraPorta(d.id);
      avisos.push(`${d.nome}: leitura em andamento (com IA quando a determinística não alcança) — recarregue em instantes.`);
      relatorio.push({ documentId: d.id, nome: d.nome, contas: 0, periodo: null, lido: false, fechamentoOk: null, erro: "leitura em andamento — recarregue em instantes" });
      continue;
    }
    if (c.erro) {
      avisos.push(`${d.nome}: ${c.erro}`);
      relatorio.push({ documentId: d.id, nome: d.nome, contas: c.totalContas, periodo: null, lido: false, fechamentoOk: null, erro: c.erro });
      continue;
    }
    try {
      const arvore = (ehBP ? c.arvoreBP : c.arvoreDRE) as Record<string, unknown> | undefined;
      const coberto = ehBP ? cobertoBP : cobertoDRE;
      const arvCanon: Record<string, unknown> = {};
      for (const [pRaw, dadosP] of Object.entries(arvore ?? {})) {
        const p = canonico(pRaw);
        if (coberto.has(p)) { avisos.push(`${d.nome}: ${p} já coberto por outra fonte de ${ehBP ? "BP" : "DRE"} — esta coluna ficou de fora.`); continue; }
        arvCanon[p] = dadosP;
      }
      const aceitos = Object.keys(arvCanon);
      // COLUNA JÁ COBERTA POR OUTRA FONTE (12/08/2026 — varredura adversarial).
      // Quando todas as colunas do documento já vieram de outro (balancete do
      // mesmo ano, por exemplo), ele não entra na montagem — e saía com selo
      // VERDE em silêncio, porque sem coluna não há prova para reprovar. Verde
      // por ausência de prova é o oposto da regra da casa.
      if (aceitos.length === 0) coberturaDuplicada.set(d.id, Object.keys(arvore ?? {}).map(canonico));
      if (aceitos.length) {
        // Demonstrativo ANUAL cobre o exercício: do 1º de janeiro do primeiro
        // período aceito ao último dia do último.
        const ordenados = [...aceitos].sort((x, y) => ordPeriodo(x) - ordPeriodo(y));
        const primeiro = ordenados[0]!, ultimo = ordenados[ordenados.length - 1]!;
        intervaloPorDocumento[d.id] = {
          inicio: `01/01/${primeiro.slice(-4)}`, fim: ultimo, tipo: "exercicio",
        };
      }
      // Subtotais IMPRESSOS no documento (Receita Líquida, Lucro Bruto, Ativo
      // Total…) — a chave do período segue a MESMA canonicalização das colunas.
      for (const [pRaw, decl] of Object.entries(c.declarados ?? {})) {
        const p = canonico(pRaw);
        if (aceitos.includes(p)) declarados[p] = { ...(declarados[p] ?? {}), ...decl };
      }
      if (aceitos.length) {
        if (ehBP) {
          const r2 = foldBP(arvCanon as Parameters<typeof foldBP>[0], aceitos, dictRows, bpModel);
          alertasComposicao.push(...r2.alertasComposicao);
          for (const k of r2.conservacao) conservacaoPorPeriodo[k.periodo] = k;
          mergeItens(bp, r2.bp as unknown as Item[]);
          naoMapeados.push(...comDono(r2.naoMapeados, d.id));
          for (const p of aceitos) { cobertoBP.add(p); registraPeriodo(p, d.nome); arvoreOriginalBP[p] = arvCanon[p]; }
        } else {
          const r2 = foldDRE(arvCanon as Parameters<typeof foldDRE>[0], aceitos, dictRows, dreModel);
          alertasComposicao.push(...r2.alertasComposicao);
          mergeItens(dre, r2.dre as unknown as Item[]);
          naoMapeados.push(...comDono(r2.naoMapeados, d.id));
          for (const p of aceitos) { cobertoDRE.add(p); registraPeriodo(p, d.nome); arvoreOriginalDRE[p] = arvCanon[p]; }
        }
      }
      // "Verde só com prova": competência declarada FORA dos períodos lidos é
      // ✗ na validação (10/08/2026, caso "BP 2022.pdf → 31/12/2021") — a coluna
      // entra, mas ninguém chama de conferida o que diverge do declarado.
      const anoDeclarado = d.competencia && /^\d{4}$/.test(d.competencia.trim()) ? d.competencia.trim() : null;
      const divergeDoDeclarado = !!anoDeclarado && c.periodos.length > 0
        && !c.periodos.some((p) => p.trim().slice(-4) === anoDeclarado);
      // BALANÇO INCOMPLETO (10/08/2026, caso Move Farma/Dunamys): a leitura do
      // BP anual trouxe o ativo e o PL e NENHUMA conta de passivo — Ativo ≠
      // Passivo. A conferência mora aqui, no documento que originou a coluna.
      let desbalanceado: string | null = null;
      if (ehBP) {
        const grupos = Object.entries(c.arvoreBP ?? {})
          .flatMap(([, capa]) => Object.entries((capa as { grupos?: Record<string, unknown[]> })?.grupos ?? {}));
        const contasDe = (re: RegExp) => grupos.filter(([g]) => re.test(g)).reduce((s, [, itens]) => s + (itens?.length ?? 0), 0);
        const nPassivo = contasDe(/passivo/i);
        const nAtivo = contasDe(/ativo/i);
        if (nAtivo > 0 && nPassivo === 0) {
          desbalanceado = "a leitura não reconheceu NENHUMA conta de passivo (balanço em duas colunas costuma perder o lado direito) — o Ativo não fecha com o Passivo e o Fluxo de Caixa desta coluna não pode fechar";
        }
      }
      // A CASCATA JÁ SE JULGOU (10/08/2026): a leitura carrega o score de
      // integridade do nível vencedor (equação + composição + detalhe + DRE).
      // Não fechou 5/5 mesmo após heurístico → Haiku → visão? Então é ✗ aqui,
      // com o motivo — o analista não descobre isso adiante, na conta errada.
      const integ = c.integridade;
      const cobFalhou = !!(integ?.cobertura?.verificavel && !integ.cobertura.ok);
      // COBERTURA AVISA, NÃO REPROVA (12/08/2026, caso Dunamys — três balanços
      // corretos ficaram ✗ da noite para o dia).
      //
      // A cobertura compara NOMES entre dois leitores, e nome é frágil de um
      // jeito que soma não é: o parser lê "Bradesco Invest Fácil 18000-9" e a
      // visão lê "…16000-9" — um dígito de diferença vira "conta perdida" sem
      // que nada tenha se perdido. Enquanto a aritmética do documento fecha
      // (equação patrimonial e composição dos dois lados), reprovar é mentir
      // sobre o documento E travar o analista, que não tem ação nenhuma
      // disponível: quem perdeu a linha foi o leitor, não ele.
      //
      // Ela CONTINUA valendo onde tem consequência boa e nenhum custo: dentro
      // da cascata, derrubando o portão para o motor escalar (Haiku → visão) e
      // tentar de novo. E continua aparecendo, com o nome das contas, para
      // quem quiser conferir no papel.
      // A COBERTURA NÃO FALA COM O ANALISTA (12/08/2026, pergunta do dono:
      // "qual o objetivo da msg? alguma coisa vai mudar na conciliação?").
      // Não muda nada, e essa é a resposta: a aritmética do documento fecha, as
      // contas não entram na fila de classificação (nada se perdeu na montagem)
      // e o analista não tem ação nenhuma disponível — quem nomeou a linha
      // diferente foi o leitor. Um aviso sem ação é ruído, e ruído numa tela de
      // conferência custa atenção que devia ir para o que importa.
      //
      // Ela continua trabalhando onde tem consequência: DENTRO da cascata,
      // derrubando o portão para o motor escalar (foi assim que apareceu o
      // parser que comia "Horas Extras e DSR"). O detalhe fica no payload, em
      // `integridade.cobertura`, para diagnóstico.
      const soFaltouCobertura = cobFalhou && integ!.score === integ!.scoreMax - 1;
      if (!desbalanceado && integ && !integ.fecha && !soFaltouCobertura) {
        const cob = integ.cobertura;
        const faltas = [
          !integ.equacaoPatrimonial ? "Ativo ≠ Passivo + PL" : null,
          !integ.composicaoAtivo ? "composição do ativo não soma" : null,
          !integ.composicaoPassivo ? "composição do passivo não soma" : null,
          // COBERTURA: aqui o motivo precisa NOMEAR as contas — "5/5" não diz ao
          // analista o que conferir no papel (regra da casa: verde só com prova,
          // e vermelho só com endereço).
          cob && cob.verificavel && !cob.ok
            ? `a leitura perdeu ${cob.total - cob.encontradas} conta(s) que o documento imprime (${cob.faltantes.slice(0, 3).map((f) => `"${f}"`).join(", ")}${cob.faltantes.length > 3 ? "…" : ""})`
            : null,
        ].filter(Boolean).join(" · ");
        desbalanceado = `a extração não fechou a integridade (${integ.score}/${integ.scoreMax}${faltas ? ` — ${faltas}` : ""}) mesmo depois da cascata completa (parser → IA texto → IA visão)`;
      }
      relatorio.push({
        documentId: d.id, nome: d.nome, contas: c.totalContas,
        periodo: aceitos.join(" · ") || null, lido: true,
        fechamentoOk: divergeDoDeclarado || desbalanceado ? false : null,
        erro: divergeDoDeclarado
          ? `competência declarada ${anoDeclarado}, mas a leitura trouxe ${c.periodos.join(" · ")} — confira o arquivo (num balanço comparativo, a coluna do exercício pode ter sido trocada pela do ano anterior)`
          : desbalanceado,
      });
      if (desbalanceado) avisos.push(`${d.nome}: ${desbalanceado}.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      avisos.push(`${d.nome}: fold falhou (${msg}).`);
      relatorio.push({ documentId: d.id, nome: d.nome, contas: c.totalContas, periodo: null, lido: false, fechamentoOk: null, erro: `fold falhou (${msg})` });
    }
  }
  periodos.sort((a2, b2) => ordPeriodo(a2) - ordPeriodo(b2));

  // Pendências CONSOLIDADAS por conta (a mesma conta em N períodos é UMA pendência).
  const pendMap = new Map<string, { nome: string; tipo: "BP" | "DRE"; grupo: string; periodos: string[]; valorUltimo: number }>();
  for (const nm of naoMapeados) {
    const k = `${nm.tipo}|${nm.nome.toLowerCase()}`;
    const atual = pendMap.get(k) ?? { nome: nm.nome, tipo: nm.tipo, grupo: nm.grupo, periodos: [], valorUltimo: 0 };
    if (!atual.periodos.includes(nm.periodo)) atual.periodos.push(nm.periodo);
    atual.valorUltimo = nm.valor;
    pendMap.set(k, atual);
  }

  // ── PROVA PATRIMONIAL DE CADA COLUNA (10/08/2026, "por que o fluxo de caixa
  // não bate com o valor do BP?") ──
  // O FC indireto é DERIVADO do balanço: a identidade FCO+FCI+FCF = ΔCaixa
  // fecha algebricamente sempre que Ativo = Passivo nos dois períodos. Quando
  // não fecha, a causa está no balanço — e ela precisa aparecer NA COLUNA, não
  // só no fim da cadeia. Caso real (Move Farma): o BP anual lido do PDF veio
  // SEM O LADO DO PASSIVO (Passivo Circulante e Não Circulante com zero
  // contas), Ativo 8,3 mi × Passivo 3,6 mi — e o FC "não fechava" sem dizer
  // por quê. O balancete, que tem a própria prova, fecha ao centavo.
  // Contas que o fold marcou como IGNORADAS, por período — a árvore carimba o
  // destino "(ignorada pelo analista)" em cada nó. É a primeira suspeita quando
  // o balanço não fecha: ignorar tira da montagem sem tirar do documento.
  const ignoradasPorPeriodo = new Map<string, Array<{ nome: string; valor: number }>>();
  for (const [per, capa] of Object.entries(arvoreOriginalBP)) {
    const achadas: Array<{ nome: string; valor: number }> = [];
    const anda = (itens: unknown): void => {
      if (!Array.isArray(itens)) return;
      for (const it of itens as Array<{ nome?: string; valor?: number; destino?: string; filhos?: unknown }>) {
        if (typeof it?.destino === "string" && it.destino.includes("ignorada") && typeof it.valor === "number" && it.valor !== 0) {
          achadas.push({ nome: String(it.nome ?? "?"), valor: it.valor });
        }
        if (it?.filhos) anda(it.filhos);
      }
    };
    for (const itens of Object.values((capa as { grupos?: Record<string, unknown> })?.grupos ?? {})) anda(itens);
    if (achadas.length) ignoradasPorPeriodo.set(per, achadas);
  }

  const valorEm = (conta: string, p: string): number =>
    (bp.find((x) => x.conta === conta)?.valores as Record<string, number> | undefined)?.[p] ?? 0;
  /** Mesmo rótulo curto da tela: "2024" (exercício) · "05/2026" (mês). */
  const rotuloDaColuna = (p: string): string => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(p.trim());
    if (!m) return p;
    return tipoPorPeriodo[p] === "mes" ? `${m[2]}/${m[3]}` : m[3]!;
  };
  const provaPatrimonial: Record<string, { ativo: number; passivo: number; gap: number; ok: boolean }> = {};
  for (const p of periodos) {
    const ativo = valorEm("Ativo Total", p);
    const passivo = valorEm("Passivo Total", p);
    if (Math.abs(ativo) < 0.5 && Math.abs(passivo) < 0.5) continue; // coluna só de DRE
    const gap = Math.round((ativo - passivo) * 100) / 100;
    const ok = Math.abs(gap) <= Math.max(1, Math.abs(ativo) * 0.0001);
    provaPatrimonial[p] = { ativo, passivo, gap, ok };
    if (!ok) {
      // A CAUSA ANTES DA CULPA (10/08/2026, caso Dunamys): quando há conta
      // MARCADA COMO IGNORADA na coluna, ela é a primeira suspeita — ignorar
      // tira o valor da montagem sem tirar do documento. Dizer "a extração não
      // fechou" aí é mentira: a leitura estava certa ao centavo.
      const ignoradas = ignoradasPorPeriodo.get(p) ?? [];
      const somaIgnorada = ignoradas.reduce((s2, x) => s2 + Math.abs(x.valor), 0);
      if (ignoradas.length > 0 && Math.abs(Math.abs(gap) - somaIgnorada) <= Math.max(1, Math.abs(gap) * 0.01)) {
        avisos.push(
          `${rotuloDaColuna(p)}: o balanço não fecha por causa de conta MARCADA COMO IGNORADA — ${ignoradas.map((x) => `"${x.nome}" (${fmtBRL(x.valor)})`).join(", ")}. ` +
          `A diferença (${fmtBRL(gap)}) é exatamente esse valor: a leitura do documento está correta; o que tirou a conta da montagem foi a marcação de ignorar. ` +
          `Desfaça o ignorar na auditoria abaixo (ou classifique a conta) e o balanço volta a fechar.`,
        );
        continue;
      }
      avisos.push(
        `${rotuloDaColuna(p)}: o balanço lido não fecha — Ativo ${fmtBRL(ativo)} × Passivo + PL ${fmtBRL(passivo)} (diferença de ${fmtBRL(gap)}). ` +
        `Origem: ${origemPorPeriodo[p] ?? "documento"}. Enquanto isso o Fluxo de Caixa desta coluna não pode fechar — ele é derivado do balanço.`,
      );
    }
  }

  // O dinheiro que entrou do documento saiu todo para as linhas? Quando não,
  // a coluna nomeia a conta — é o diagnóstico do "FC não bate com o BP".
  for (const [p, k] of Object.entries(conservacaoPorPeriodo)) {
    if (k.ok) continue;
    const v = k.vazamentos[0];
    avisos.push(
      `${rotuloDaColuna(p)}: conservação de valor não fecha — entrou ${fmtBRL(k.entrou)} do documento e saiu ${fmtBRL(k.saiu)} nas linhas (diferença ${fmtBRL(k.diferenca)})` +
      (v ? `. O dinheiro ficou em "${v.conta}" (${fmtBRL(v.valor)}): ${v.motivo}.` : ".") +
      ` Enquanto isso o Fluxo de Caixa desta coluna não pode fechar.`,
    );
  }

  // FLUXO DE CAIXA INDIRETO (pedido do dono, 08/08: "faltou o Fluxo de
  // Caixa"): o MESMO serviço do IBR, sobre o BP/DRE dobrados acima. Null com
  // menos de 2 períodos — sem variação não há método indireto.
  const fc = periodos.length >= 2
    ? buildIndirectCashFlow(
        bp as unknown as BPLineItem[], dre as unknown as DRELineItem[], periodos,
        // So' as colunas que REALMENTE acumulam: encerramento usa movimento,
        // janeiro nao acumula e DRE reprovada nao foi publicada (valor 0).
        periodosQueAcumulam({ dre: dre as never, balancetes, arvoresBalancete }),
      )
    : null;
  if (periodos.length === 1) avisos.push("Fluxo de Caixa precisa de pelo menos 2 períodos lidos (método indireto compara balanços).");

  // SUGESTÃO DE CADASTRO por pendência (08/08/2026, pedido do dono): a mesma
  // heurística determinística do IBR (sugerirConta) contra as contas do
  // MODELO DA EMPRESA — pré-preenche o select da tela; o analista confirma e
  // a entrada nasce no escopo da EMPRESA ("pendente" → fila global da Quantua).
  const candidatosDRE = dreModel.lines.filter((l) => !l.subtotal).map((l) => l.conta);
  const candidatosBP = bpModel.names;
  type Sugestao = { sugestao: string; justificativa: string; confianca: string; verificar?: string };

  /**
   * CANDIDATAS VÁLIDAS PARA ESTA LINHA (10/08/2026 — "isso é fundamental, não
   * pode ter erro"). A dica era calculada contra o modelo INTEIRO e saía
   * inválida: "Perdas em operações NDF" (despesa) recebia "Receitas
   * Financeiras"; "Empréstimos a terceiros" (ativo) recebia "Empréstimos e
   * Financiamentos - CP" (passivo). A tela então SUPRIMIA a dica inválida — e
   * o analista via "umas contas trazem dica, outras não".
   *
   * O servidor passa a usar a MESMA régua do dropdown:
   *  - DRE: natureza pelo SINAL do valor (entrada só oferece receita; saída,
   *    nunca) — igual a `dreGroupsPorNatureza` no OriginalTreeView;
   *  - BP: só contas do MESMO grupo patrimonial da linha (AC/ANC/PC/PNC/PL) —
   *    igual a `gruposDo`.
   * Sem candidata válida, nenhuma dica: melhor silêncio que dica impossível.
   */
  const ehContaDeReceita = (conta: string) => /^(receitas?\b|outras receitas)/i.test(conta.trim());
  const candidatosDREPara = (valor: number): string[] =>
    valor === 0 ? candidatosDRE : candidatosDRE.filter((c) => ehContaDeReceita(c) === valor > 0);
  const CODIGO_DO_GRUPO: Record<string, string> = {
    "ativo circulante": "AC", "ativo nao circulante": "ANC",
    "passivo circulante": "PC", "passivo nao circulante": "PNC", "patrimonio liquido": "PL",
  };
  const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const candidatosBPPara = (grupo: string): string[] => {
    const code = CODIGO_DO_GRUPO[semAcento(raizGrupo(grupo))];
    if (!code) return candidatosBP;
    // O modelo usa SUBclassificações (AF/AO dentro de AC; PO/PF dentro de PC) —
    // é o mesmo mapa que o mapeamento de contas usa. Só linhas de INPUT: a
    // linha-subtotal "Ativo Circulante" não é destino de classificação.
    const aceitas = GRUPO_CLASSIF_MAP[code] ?? new Set([code]);
    const doGrupo = bpModel.lines
      .filter((l) => aceitas.has(l.classificacao) && l.tipo === "input")
      .map((l) => l.conta);
    return doGrupo.length ? doGrupo : candidatosBP;
  };
  // 💡 na ÁRVORE (09/08/2026, "não está vindo a sugestão"): o workspace não
  // paga IA — a sugestão é a DETERMINÍSTICA (similaridade de nome contra o
  // modelo da empresa), no MESMO shape que o OriginalTreeView já lê
  // (chave BP = `BP|grupo|nome`; DRE = `DRE|DRE|nome`). Honesta no rótulo.
  // Para DRE, o VOCABULÁRIO CONTÁBIL vem antes da similaridade de nome
  // (10/08/2026, "porque uns trazem dicas outros não?"): "Uniformes"/"EPI"/
  // "Aviso prévio" não se PARECEM com "Despesas com Pessoas" em texto, mas o
  // classificador do orçamento já SABE que são pessoal — e a similaridade
  // sozinha ainda errava por token ("Ajuda de Custo" → "Custo Operacional").
  const sugerirDre = (nome: string, valor: number): Sugestao | null => {
    // 1º o CONTEXTO do documento (irmã/consenso) — ver visitaDoc; 2º o
    // vocabulário contábil; 3º a similaridade com o modelo. Sempre contra as
    // candidatas VÁLIDAS para a natureza da linha.
    const validas = candidatosDREPara(valor);
    const ctx = contextoDRE.get(`DRE|DRE|${nome}`);
    if (ctx && validas.includes(ctx.sugestao)) return ctx;
    const porRegra = sugerirContaCanonica(nome, validas);
    if (porRegra) {
      return {
        sugestao: porRegra.conta,
        justificativa: `${porRegra.porque} (determinística, sem IA)`,
        confianca: porRegra.base === "similaridade" ? "média" : "alta",
      };
    }
    const porNome = sugerirConta(nome, validas);
    return porNome ? { sugestao: porNome, justificativa: "similaridade de nome com a conta do modelo (determinística, sem IA)", confianca: "média" } : null;
  };
  // A chave da tela usa o grupo-RAIZ (OriginalTreeView: raizG) — conta aninhada
  // carrega "Ativo Circulante > ADIANTAMENTO..." no naoMapeado e a dica nunca
  // era encontrada (10/08/2026, "continua sem as dicas").
  const raizGrupo = (g: string) => g.split(">")[0]!.trim();

  // LINHA DE FECHAMENTO/APURAÇÃO (10/08/2026, "imagem 1, não sugeriu"): a
  // família "RESULTADO LÍQUIDO DO EXERCÍCIO" não é conta de input — classificar
  // a folha em qualquer conta distorce a DRE; a ação certa é IGNORAR. Quando a
  // raiz ≈ ± soma das outras raízes (espelho PROVADO), a dica sai com confiança
  // alta; quando o valor NÃO bate (conta de apuração/zeramento com saldo
  // próprio, caso Belagro 2023: −577,0 mi vs −85,9 mi), a dica ainda sai, mas
  // com ⚠ de conferência — "verde só com prova".
  type NoDre = { nome: string; valor?: number; filhos?: NoDre[] };
  // MESMA régua conservadora da conversão (10/08/2026): o regex largo daqui
  // casava "RESULTADO FINANCEIRO LÍQUIDO" — uma linha legítima da DRE — e
  // oferecia "ignorar esta linha" para ela. Sugerir que o analista jogue fora
  // o resultado financeiro é pior do que não sugerir nada.
  const ehNomeResultado = (s: string) => ehNomeDeApuracao(s);
  const espelhoDre = new Map<string, { provado: boolean; valor: number; somaOutras: number }>();
  for (const arv of Object.values(arvoreOriginalDRE)) {
    const roots = arv as NoDre[];
    if (!Array.isArray(roots) || roots.length < 2) continue;
    for (const r of roots) {
      const vr = r.valor ?? 0;
      if (Math.abs(vr) < 0.005 || !ehNomeResultado(r.nome)) continue;
      const somaOutras = roots.filter((o) => o !== r).reduce((s, o) => s + (o.valor ?? 0), 0);
      const tol = Math.max(1, Math.abs(vr) * 0.001);
      const provado = Math.abs(somaOutras - vr) <= tol || Math.abs(somaOutras + vr) <= tol;
      // Marca só os nós da subárvore com o MESMO valor da raiz (a corrente do
      // fechamento) — um filho de valor próprio não ganha a dica de ignorar.
      const marca = (n: NoDre): void => {
        if (Math.abs((n.valor ?? 0) - vr) <= tol || Math.abs((n.valor ?? 0) + vr) <= tol) {
          if (!espelhoDre.get(n.nome)?.provado) espelhoDre.set(n.nome, { provado, valor: vr, somaOutras });
        }
        (n.filhos ?? []).forEach(marca);
      };
      marca(r);
    }
  }
  // SUGESTÃO PELO CONTEXTO DO DOCUMENTO (BP): conta de BP raramente se parece
  // com a do modelo em texto ("G Belusso Transportes") — mas as IRMÃS do mesmo
  // grupo do documento já têm destino carimbado pelo fold. Consenso das irmãs
  // (≥60%) vem antes da similaridade; sem irmãs, o NOME DO PAI desempata.
  const candidatosBPSet = new Set(candidatosBP);
  const pendentesBP = new Set(naoMapeados.filter((n) => n.tipo === "BP").map((n) => n.nome));
  const contextoBP = new Map<string, { sugestao: string; justificativa: string; confianca: string }>();
  const destinoRealDe = (d?: string): string | null => {
    if (!d) return null;
    const m = /^\(absorvido em (.+)\)$/.exec(d);
    const nome = m ? m[1]! : d;
    return !nome.startsWith("(") && candidatosBPSet.has(nome) ? nome : null;
  };
  // Tokens do nome, para medir parentesco entre IRMÃS do documento.
  const tokensDe = (s: string) =>
    new Set(s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  const parentesco = (a: string, b: string): number => {
    const ta = tokensDe(a), tb = tokensDe(b);
    if (!ta.size || !tb.size) return 0;
    let comuns = 0;
    for (const t of ta) if (tb.has(t)) comuns++;
    return comuns / new Set([...ta, ...tb]).size;
  };

  type NoDoc = { nome: string; destino?: string; filhos?: NoDoc[] };
  /**
   * CONTEXTO DO DOCUMENTO — vale para BP e DRE (10/08/2026, "contas que não
   * aparecem sugestão"). Ordem, da mais forte para a mais fraca:
   *   1. IRMÃ QUASE IGUAL (≥60% de tokens em comum) já classificada — "Perdas
   *      NDF - Contratos realizados" herda de "Perdas NDF - Contratos em
   *      aberto". É o sinal mais forte: o plano de contas nomeia famílias.
   *   2. CONSENSO das irmãs (≥60% no mesmo destino).
   *   3. NOME DO PAI parecido com uma conta do modelo.
   * O contexto vence o vocabulário genérico de propósito: "Vale transporte"
   * dentro de "CUSTOS COM PESSOAL (MOD)" é CUSTO, não despesa — quem sabe
   * disso é o documento, não a regra.
   */
  const visitaDoc = (
    itens: NoDoc[],
    ctx: { tipo: "BP" | "DRE"; grupoRaiz: string; pai: string | null; candidatos: Set<string>; lista: string[]; pendentes: Set<string>; destino: Map<string, Sugestao> },
  ): void => {
    const destinoReal = (d?: string): string | null => {
      if (!d) return null;
      const m = /^\(absorvido em (.+)\)$/.exec(d);
      const nome = m ? m[1]! : d;
      return !nome.startsWith("(") && ctx.candidatos.has(nome) ? nome : null;
    };
    const classificadas = itens
      .filter((i) => !ctx.pendentes.has(i.nome))
      .map((i) => ({ nome: i.nome, destino: destinoReal(i.destino) }))
      .filter((x): x is { nome: string; destino: string } => x.destino !== null);
    let consenso: Sugestao | null = null;
    if (classificadas.length) {
      const cont = new Map<string, number>();
      for (const c2 of classificadas) cont.set(c2.destino, (cont.get(c2.destino) ?? 0) + 1);
      const [top, n] = [...cont.entries()].sort((a, b) => b[1] - a[1])[0]!;
      if (n / classificadas.length >= 0.6) {
        consenso = {
          sugestao: top,
          justificativa: `as contas irmãs${ctx.pai ? ` de "${ctx.pai}"` : ""} no documento foram para esta conta (determinística, sem IA)`,
          confianca: "alta",
        };
      }
    }
    for (const it of itens) {
      if (ctx.pendentes.has(it.nome)) {
        const chave = `${ctx.tipo}|${ctx.grupoRaiz}|${it.nome}`;
        if (!ctx.destino.has(chave)) {
          const irma = classificadas
            .map((c2) => ({ ...c2, score: parentesco(it.nome, c2.nome) }))
            .sort((a, b) => b.score - a.score)[0];
          const porPai = ctx.pai ? sugerirConta(ctx.pai, ctx.lista) : null;
          const escolha: Sugestao | null = irma && irma.score >= 0.6
            ? { sugestao: irma.destino, justificativa: `a conta irmã "${irma.nome}" do mesmo grupo do documento foi para esta conta (determinística, sem IA)`, confianca: "alta" }
            : consenso ?? (porPai
              ? { sugestao: porPai, justificativa: `o grupo do documento ("${ctx.pai}") se parece com esta conta do modelo (determinística, sem IA)`, confianca: "média" }
              : null);
          if (escolha) ctx.destino.set(chave, escolha);
        }
      }
      if (it.filhos?.length) visitaDoc(it.filhos, { ...ctx, pai: it.nome });
    }
  };
  for (const arv of Object.values(arvoreOriginalBP)) {
    const grupos = (arv as { grupos?: Record<string, BPN3Item[]> })?.grupos ?? {};
    for (const [gn, itens] of Object.entries(grupos)) {
      visitaDoc(itens as NoDoc[], { tipo: "BP", grupoRaiz: gn, pai: null, candidatos: candidatosBPSet, lista: candidatosBP, pendentes: pendentesBP, destino: contextoBP });
    }
  }
  // DRE: as seções do documento são as raízes; a mesma régua de contexto.
  const candidatosDRESet = new Set(candidatosDRE);
  const pendentesDRE = new Set(naoMapeados.filter((n) => n.tipo === "DRE").map((n) => n.nome));
  const contextoDRE = new Map<string, Sugestao>();
  for (const arv of Object.values(arvoreOriginalDRE)) {
    const secoes = (arv as NoDoc[]) ?? [];
    if (!Array.isArray(secoes)) continue;
    visitaDoc(secoes, { tipo: "DRE", grupoRaiz: "DRE", pai: null, candidatos: candidatosDRESet, lista: candidatosDRE, pendentes: pendentesDRE, destino: contextoDRE });
  }

  const sugestaoBP = (grupo: string, nome: string): Sugestao | null => {
    const validas = candidatosBPPara(grupo);
    const ctx = contextoBP.get(`BP|${raizGrupo(grupo)}|${nome}`);
    if (ctx && validas.includes(ctx.sugestao)) return ctx;
    const porNome = sugerirConta(nome, validas);
    return porNome ? { sugestao: porNome, justificativa: "similaridade de nome com a conta do modelo (determinística, sem IA)", confianca: "média" } : null;
  };
  const fmtMi = (v: number) => `${(v / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  const sugestaoIgnorar = (esp: { provado: boolean; valor: number; somaOutras: number }) => ({
    sugestao: "__IGNORAR__",
    justificativa: esp.provado
      ? "linha de fechamento do resultado — o valor é o espelho das demais seções do documento (prova aritmética); classificá-la dobraria a DRE"
      : "linha de apuração/fechamento do resultado — não é conta de movimento; o resultado já está nas demais seções",
    confianca: esp.provado ? "alta" : "média",
    ...(esp.provado ? {} : {
      verificar: `o valor da linha (${fmtMi(esp.valor)}) difere do resultado somado das demais seções (${fmtMi(esp.somaOutras)}) — confirme no documento que é conta de apuração/zeramento antes de ignorar`,
    }),
  });
  /**
   * ÚLTIMO DEGRAU (10/08/2026): sem irmã, sem vocabulário e sem similaridade,
   * a dica honesta é o BALDE onde o fold JÁ está jogando a linha — a conta
   * "Outras Despesas/Receitas Operacionais" ou "Outros Ativos/Passivos" que o
   * destino do não-mapeado carrega. Confiança BAIXA e justificativa explícita:
   * o analista confirma (vira regra no dicionário) ou escolhe a conta certa,
   * mas nunca fica sem saber para onde o dinheiro foi.
   */
  const sugestaoBalde = (nm: NaoMapeado, candidatos: Set<string>): Sugestao | null => {
    const destino = (nm.destino ?? "").trim();
    if (!destino || destino.startsWith("(") || !candidatos.has(destino)) return null;
    return {
      sugestao: destino,
      justificativa: `sem conta equivalente no modelo: é onde esta linha já está sendo somada hoje (seção "${raizGrupo(nm.grupo)}" do documento) — confirme ou escolha a conta certa`,
      confianca: "baixa",
    };
  };
  const sugestoesIA: Record<string, Sugestao> = {};
  for (const nm of naoMapeados) {
    // A MESMA conta troca de natureza entre períodos (caso real Belagro:
    // "Perdas NDF - Contratos em aberto" é +124.802 em set/25 e −1.395.434 em
    // jan/26; "Bonificação e Brindes" idem). Uma chave só por nome fazia a dica
    // da primeira ocorrência valer para todas — e ficar INVÁLIDA na de sinal
    // oposto, que a tela então suprimia. A chave da DRE carrega o sinal; a
    // chave sem sinal continua gravada para quem lê no formato antigo.
    const sinal = nm.tipo === "DRE" ? (nm.valor > 0 ? "|+" : "|-") : "";
    const chaveBase = nm.tipo === "BP" ? `BP|${raizGrupo(nm.grupo)}|${nm.nome}` : `DRE|DRE|${nm.nome}`;
    const chave = `${chaveBase}${sinal}`;
    if (sugestoesIA[chave]) continue;
    const esp = nm.tipo === "DRE" ? espelhoDre.get(nm.nome) : undefined;
    const sug = nm.tipo === "DRE"
      ? (esp ? sugestaoIgnorar(esp) : sugerirDre(nm.nome, nm.valor) ?? sugestaoBalde(nm, new Set(candidatosDREPara(nm.valor))))
      : sugestaoBP(nm.grupo, nm.nome) ?? sugestaoBalde(nm, new Set(candidatosBPPara(nm.grupo)));
    if (sug) {
      sugestoesIA[chave] = sug;
      sugestoesIA[chaveBase] ??= sug;
    }
  }
  const pendencias = [...pendMap.values()]
    .sort((x, y) => Math.abs(y.valorUltimo) - Math.abs(x.valorUltimo))
    .map((pd) => ({
      ...pd,
      // MESMA cascata da árvore (inclusive o balde): o quadro não pode dizer
      // "sem sugestão" para uma linha que a árvore ao lado sugere.
      sugestao: pd.tipo === "DRE"
        ? (espelhoDre.has(pd.nome) ? null : (sugestoesIA[`DRE|DRE|${pd.nome}`]?.sugestao ?? null))
        : (sugestoesIA[`BP|${raizGrupo(pd.grupo)}|${pd.nome}`]?.sugestao ?? null),
    }));

  // ── CONCILIAÇÃO POR DOCUMENTO (10/08/2026, garantia 6 do dono: "documento
  // que ainda não foi conciliado 100% não pode ser usado em IBR") ──
  // UM lugar decide, e a mesma resposta serve à tela de Conciliação e ao
  // wizard do IBR. Conciliado = leitura sem erro + TODAS as provas que rodaram
  // passaram + nenhuma conta do documento pendente de classificação.
  // Contagem POR DOCUMENTO (o dono da pendência). A contagem por período fica
  // como reserva para leituras antigas, sem docId carimbado.
  const pendPorDocumento = new Map<string, Set<string>>();
  const pendPorPeriodo = new Map<string, number>();
  for (const nm of naoMapeados) {
    pendPorPeriodo.set(nm.periodo, (pendPorPeriodo.get(nm.periodo) ?? 0) + 1);
    if (!nm.docId) continue;
    const set = pendPorDocumento.get(nm.docId) ?? new Set<string>();
    set.add(`${nm.tipo}|${nm.nome.toLowerCase()}`);
    pendPorDocumento.set(nm.docId, set);
  }
  const temDono = naoMapeados.some((nm) => nm.docId);
  const fimDoIntervalo = (per: string | null): string[] => {
    if (!per) return [];
    return per.split(" · ").flatMap((t) => {
      const partes = t.split(" a ");
      return [(partes[partes.length - 1] ?? "").trim()].filter(Boolean);
    });
  };
  /**
   * AVISOS DO DOCUMENTO (12/08/2026, princípio do dono: "todo problema ligado
   * aos documentos contábeis se resolve na conciliação do workspace").
   *
   * Diferente dos MOTIVOS: motivo derruba o selo (o documento não entra em
   * IBR); aviso é fato conhecido que NÃO invalida o número — composição de um
   * nó cujo delta foi preservado em "Outros" é atribuição de detalhe, não erro
   * de valor. Antes esse fato só aparecia lá na frente, bloqueando a geração
   * do IBR, depois de a tela ter dito "tudo conciliado". Agora nasce aqui, com
   * o nó e a diferença, onde dá para agir.
   */
  const avisosPorDocumento = new Map<string, string[]>();
  for (const a of alertasComposicao as Array<{ periodo: string; caminho: string; declarado: number; somaFilhos: number; delta: number; severidade: string }>) {
    if (a.severidade !== "erro") continue;
    for (const r of relatorio) {
      if (!fimDoIntervalo(r.periodo).includes(a.periodo)) continue;
      const lista = avisosPorDocumento.get(r.documentId) ?? [];
      // A diferença vem com CENTAVO, não abreviada: numa seção de R$ 3,3 mi os
      // dois totais arredondados saem idênticos na tela ("R$ -3,3 mi × R$ -3,3
      // mi") e a frase parece errada. O que o analista precisa é do delta exato.
      const exato = a.delta.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      lista.push(
        `"${a.caminho}" (${rotuloDaColuna(a.periodo)}): a soma das contas desta seção difere do subtotal impresso em R$ ${exato}. ` +
        `A diferença foi preservada em "Outros" — nenhum valor se perdeu e os totais continuam certos, mas esse pedaço do detalhe ficou num balde. ` +
        `Classifique as contas da seção na auditoria abaixo para o dinheiro voltar para a linha certa.`,
      );
      avisosPorDocumento.set(r.documentId, lista);
    }
  }

  const conciliacaoPorDocumento: Record<string, { ok: boolean; motivos: string[]; avisos: string[] }> = {};
  for (const r of relatorio) {
    const motivos: string[] = [];
    const avisosDoDoc: string[] = [...(avisosPorDocumento.get(r.documentId) ?? [])];
    if (!r.lido) motivos.push(r.erro ?? "documento ainda não lido");
    else {
      if (r.fechamentoOk === false) motivos.push(r.erro ?? "as provas do documento não fecham");
      const pend = temDono
        ? (pendPorDocumento.get(r.documentId)?.size ?? 0)
        : fimDoIntervalo(r.periodo).reduce((s2, p) => s2 + (pendPorPeriodo.get(p) ?? 0), 0);
      if (pend > 0) motivos.push(`${pend} conta(s) sem classificação`);
      const prova = fimDoIntervalo(r.periodo).map((p) => provaPatrimonial[p]).find((x) => x && !x.ok);
      if (prova) motivos.push(`o balanço da coluna não fecha (diferença de ${fmtBRL(prova.gap)})`);
      const cons = fimDoIntervalo(r.periodo).map((p) => conservacaoPorPeriodo[p]).find((x) => x && !x.ok);
      if (cons) motivos.push(`conservação de valor não fecha (diferença de ${fmtBRL(cons.diferenca)})`);
      const dup = coberturaDuplicada.get(r.documentId);
      if (dup?.length) {
        avisosDoDoc.push(
          `não entrou na montagem: ${dup.map(rotuloDaColuna).join(" · ")} já vinha de outra fonte (${dup.map((p) => origemPorPeriodo[p]).filter(Boolean).join(" · ") || "outro documento"}). ` +
          `Ele não está errado — está redundante; se quiser que ele mande na coluna, remova a outra fonte da Data room.`,
        );
      }
    }
    conciliacaoPorDocumento[r.documentId] = { ok: motivos.length === 0, motivos, avisos: avisosDoDoc };
  }

  const payload = {
    periodos,
    conciliacaoPorDocumento,
    fc,
    arvoreOriginalBP,
    arvoreOriginalDRE,
    naoMapeadosDetalhe: naoMapeados,
    origemPorPeriodo,
    tipoPorPeriodo,
    provasPorPeriodo,
    provaPatrimonial,
    conservacaoPorPeriodo,
    bp,
    dre,
    pendencias,
    relatorio,
    sugestoesIA,
    opcoes: { dre: candidatosDRE, bp: candidatosBP },
    avisos,
    // Fontes LIDAS de qualquer tipo (10/08/2026: só balancete zerava o contador
    // numa empresa com BP/DRE e a tela mostrava "nenhum documento lido").
    fontes: relatorio.filter((r) => r.lido).length,
    modelos: versoesAtivas,
    versaoBase: VERSAO_BASE,
    documentosUsados: relatorio.map((r) => r.documentId),
    intervaloPorDocumento,
    // Alertas de composição viajam SEMPRE (array curto): o seletor de documentos
    // precisa deles para avisar ANTES da montagem. A conciliação julga documento
    // a documento; estes alertas são do MODELO montado, e é justamente essa
    // diferença que produzia a incoerência "tudo conciliado → revisão necessária".
    alertasComposicao,
    // ── contrato do produto (só quando pedido; ver `paraProduto`) ──
    ...(opcoes.paraProduto ? { arvoresBalancete, balancetes, declarados } : {}),
  };
  return payload;
}
