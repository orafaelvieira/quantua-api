/**
 * CONCILIAÇÃO DE UM DOCUMENTO (10/08/2026) — a régua única.
 *
 * Garantia do dono: "documentos que ainda não foram conciliados 100% não podem
 * ser usados em IBR". Para isso valer, "conciliado" precisa ter UMA definição —
 * senão a tela bloqueia e a API aceita (ou o contrário), e a regra vira sorte.
 *
 * Conciliado = as três coisas ao mesmo tempo:
 *   1. a leitura da porta existe, é do arquivo vigente e não tem erro;
 *   2. TODAS as provas que rodaram sobre o documento passaram (partida dobrada,
 *      fechamento patrimonial, coerência linha a linha, DRE de encerramento,
 *      integridade da cascata para DRE/Balanço);
 *   3. nenhuma conta do documento ficou sem classificação no dicionário DESTA
 *      empresa — dobrando a árvore com os modelos vigentes, sem IA e sem custo.
 *
 * "Não verificável" nunca conta como aprovado: documento sem prova nenhuma não
 * é conciliado, é desconhecido.
 */
import { prisma } from "../db/client";
import { foldBP, foldDRE } from "./ai-extraction";
import { converterBalancete } from "./balancete-conversao";
import { resolverCascataDicionario, whereCascataDicionarioAtiva } from "./dicionario-escopo";
import { resolverEscopoAcesso } from "./escopo-acesso";
import { loadActiveBPModel, loadActiveDREModel } from "./model-version";
import type { LeituraPortaConteudo, LeituraDemonstrativoConteudo } from "./leitura-porta";
import type { ProvasBalancete } from "./balancete-conversao";
import type { LinhaBalancete } from "./balancete-parser";

/** Forma comum das duas leituras (balancete e demonstrativo) — a interseção
 *  dos tipos colapsa `provas` para never (um exige objeto, o outro null). */
interface ConteudoLido {
  erro?: string;
  provas?: ProvasBalancete | null;
  integridade?: LeituraDemonstrativoConteudo["integridade"];
  linhas?: LinhaBalancete[];
  periodoInicio?: string | null;
  periodoFim?: string | null;
  arvoreBP?: unknown;
  arvoreDRE?: unknown;
}

export interface ConciliacaoDocumento {
  ok: boolean;
  /** Vazio quando ok. Um motivo por problema, em linguagem de analista. */
  motivos: string[];
}

const brl = (v: number): string =>
  `R$ ${Math.abs(v) >= 1e6 ? `${(v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi` : v.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}`;

/**
 * Avalia UM documento do pool. Devolve `null` quando o documento não é
 * contábil (material complementar) — nada a conciliar, nada a bloquear.
 */
export async function conciliacaoDoDocumento(documentId: string): Promise<ConciliacaoDocumento | null> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, nome: true, tipo: true, hash: true, companyId: true, leituraPorta: { select: { conteudo: true, hashArquivo: true } } },
  });
  if (!doc) return null;
  const ehBalancete = /balancete/i.test(doc.tipo);
  const ehDemonstrativo = /^(dre|balan[çc]o patrimonial)$/i.test(doc.tipo.trim());
  if (!ehBalancete && !ehDemonstrativo) return null;

  const motivos: string[] = [];
  const lp = doc.leituraPorta;
  if (!lp || (doc.hash && lp.hashArquivo !== doc.hash)) {
    return { ok: false, motivos: ["a leitura ainda não rodou para esta versão do arquivo — abra a Data room da empresa e aguarde"] };
  }
  const conteudo = lp.conteudo as unknown as ConteudoLido;
  if (conteudo.erro) return { ok: false, motivos: [conteudo.erro] };

  // ── 2. provas do próprio documento ──
  const provas = conteudo.provas;
  if (ehBalancete) {
    if (!provas) motivos.push("as provas aritméticas do balancete não foram calculadas");
    else {
      const pd = provas.partidaDobrada;
      if (pd?.verificavel && !pd.ok) motivos.push(`partida dobrada não fecha (diferença de ${brl(pd.delta)} entre débitos e créditos lidos)`);
      if (!provas.fechamento.ok) motivos.push(`o fechamento patrimonial não bate (diferença de ${brl(provas.fechamento.delta)})`);
      if (!provas.linhas.ok) motivos.push(`${provas.linhas.total - provas.linhas.coerentes} conta(s) não fecham a própria equação`);
      if (provas.dreEncerrada && !provas.dreEncerrada.ok) motivos.push("a DRE do encerramento não reconcilia com o resultado do PL");
    }
  } else {
    const integridade = conteudo.integridade;
    if (!integridade) motivos.push("a leitura não registrou as provas de integridade");
    else if (!integridade.fecha) {
      const falhou = [
        !integridade.equacaoPatrimonial ? "Ativo ≠ Passivo" : null,
        !integridade.composicaoAtivo ? "composição do ativo" : null,
        !integridade.composicaoPassivo ? "composição do passivo" : null,
      ].filter(Boolean);
      motivos.push(`a leitura não fechou a integridade (${integridade.score}/${integridade.scoreMax}${falhou.length ? ` — ${falhou.join(", ")}` : ""})`);
    }
  }

  // ── 3. contas sem classificação no dicionário DESTA empresa ──
  try {
    const naoMapeados = await contarNaoMapeados(doc.companyId, conteudo, ehBalancete);
    if (naoMapeados > 0) motivos.push(`${naoMapeados} conta(s) sem classificação no dicionário da empresa`);
  } catch (e) {
    motivos.push(`não foi possível conferir a classificação das contas (${e instanceof Error ? e.message : String(e)})`);
  }

  return { ok: motivos.length === 0, motivos };
}

/** Dobra a árvore do documento com o dicionário/modelos da empresa e conta o
 *  que sobrou sem destino. Determinístico — não paga IA nem grava nada. */
async function contarNaoMapeados(
  companyId: string,
  conteudo: ConteudoLido,
  ehBalancete: boolean,
): Promise<number> {
  const empresa = await prisma.company.findUnique({ where: { id: companyId }, select: { userId: true } });
  if (!empresa) return 0;
  const escopo = await resolverEscopoAcesso(empresa.userId);
  const entradas = await prisma.accountDictionary.findMany({
    where: whereCascataDicionarioAtiva(escopo.scopeUserIds, companyId),
    select: { nomeOriginal: true, contaDestino: true, grupoConta: true, userId: true, companyId: true, tipo: true },
  });
  const dict = [...resolverCascataDicionario(entradas, "BP"), ...resolverCascataDicionario(entradas, "DRE")]
    .map((e) => ({ nomeOriginal: e.nomeOriginal.toLowerCase(), contaDestino: e.contaDestino, grupoConta: e.grupoConta || "" }));
  const [bpModel, dreModel] = await Promise.all([loadActiveBPModel(companyId), loadActiveDREModel(companyId)]);

  if (ehBalancete) {
    const conv = converterBalancete({
      periodoInicio: conteudo.periodoInicio ?? null, periodoFim: conteudo.periodoFim ?? null,
      ordemColunas: "ant-d-c-atual", linhas: conteudo.linhas ?? [], avisos: [],
    });
    const p = conv.periodoBP;
    const rBP = foldBP(conv.arvoreBP, [p], dict, bpModel);
    const rDRE = foldDRE(conv.arvoreDRE, [p], dict, dreModel);
    return rBP.naoMapeados.length + rDRE.naoMapeados.length;
  }
  let total = 0;
  const arvBP = conteudo.arvoreBP as Parameters<typeof foldBP>[0] | undefined;
  if (arvBP && Object.keys(arvBP).length) total += foldBP(arvBP, Object.keys(arvBP), dict, bpModel).naoMapeados.length;
  const arvDRE = conteudo.arvoreDRE as Parameters<typeof foldDRE>[0] | undefined;
  if (arvDRE && Object.keys(arvDRE).length) total += foldDRE(arvDRE, Object.keys(arvDRE), dict, dreModel).naoMapeados.length;
  return total;
}
