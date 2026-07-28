/**
 * PLANO DE CONTAS DO CLIENTE → contas do orçamento (27/07/2026).
 *
 * A empresa orça na língua dela: código próprio ("4.1.02.001"), nome próprio e
 * o centro de custo dela. Este serviço decide, de forma PURA, o que entra:
 *
 *  - casa o centro de custo/unidade por CÓDIGO ou por NOME normalizado;
 *  - o que não casar entra "não atribuído" E volta listado (nada some, nada
 *    inventa lotação);
 *  - dedupe em duas réguas — o CÓDIGO do cliente e o par NOME + LOTAÇÃO.
 *    "Viagens" no Comercial e no TI são contas diferentes; "Viagens" duas vezes
 *    no Comercial é a mesma conta. Sem essa segunda régua, reimportar a planilha
 *    com códigos novos DOBRAVA a despesa no orçamento em silêncio.
 */

import { normContaGmd } from "./gmd-matricial";

export interface ContaImportada {
  codigo?: string | null;
  nome: string;
  /** "custo" (acima do Lucro Bruto) | qualquer outra coisa = despesa. */
  tipo?: string | null;
  centroCusto?: string | null;
  unidade?: string | null;
  /** Conta canônica da DRE em que esta conta soma (o de-para do roll-up). */
  destino?: string | null;
  /** ORÇAMENTO PRONTO: valores por mês ("2026-01": 15000). Quando a planilha
   *  do cliente já traz os números (contas nas linhas, meses nas colunas), a
   *  conta nasce preenchida em vez de vazia. */
  valores?: Record<string, number> | null;
}

export interface AlvoDimensional { id: string; nome: string; codigo?: string | null }

/** Linha que já existe no modelo — só o que o dedupe precisa enxergar. */
export interface LinhaExistente {
  nome: string;
  codigo?: string | null;
  unidadeId?: string | null;
  centroCustoId?: string | null;
}

export interface ContaPlanejada {
  nome: string;
  codigo: string | null;
  ehCusto: boolean;
  unidadeId: string | null;
  centroCustoId: string | null;
  destino: string | null;
  /** Nome do CC/unidade onde a conta ficou (ou "não atribuído") — para o resumo. */
  lotacao: string;
  /** Série mensal saneada (só "YYYY-MM" com número finito); {} quando a
   *  planilha traz só a estrutura de contas. */
  valores: Record<string, number>;
}

export interface PlanoImportacao {
  criar: ContaPlanejada[];
  /** Já existiam (por código ou por nome+lotação). */
  ignoradas: string[];
  /** Traziam CC/unidade que não existe na estrutura — entraram sem lotação. */
  semLotacao: string[];
}

const chaveCodigo = (c: string) => `c:${c.toLowerCase().trim()}`;
const chaveNome = (lotacaoId: string | null, nome: string) => `n:${lotacaoId ?? "-"}:${normContaGmd(nome)}`;

/** Índice de casamento de um alvo dimensional: por código e por nome normalizado. */
function indexar(alvos: AlvoDimensional[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const a of alvos) {
    if (a.codigo) idx.set(chaveCodigo(a.codigo), a.id);
    idx.set(`n:${normContaGmd(a.nome)}`, a.id);
  }
  return idx;
}

export function planejarImportacaoPlanoContas(entrada: {
  contas: ContaImportada[];
  existentes: LinhaExistente[];
  unidades: AlvoDimensional[];
  centros: AlvoDimensional[];
}): PlanoImportacao {
  const { contas, existentes, unidades, centros } = entrada;
  const idxCentro = indexar(centros);
  const idxUnidade = indexar(unidades);
  const nomeDe = (id: string | null, lista: AlvoDimensional[]) => lista.find((x) => x.id === id)?.nome ?? "—";

  const vistos = new Set<string>();
  for (const l of existentes) {
    if (l.codigo) vistos.add(chaveCodigo(l.codigo));
    vistos.add(chaveNome(l.centroCustoId ?? l.unidadeId ?? null, l.nome));
  }

  const criar: ContaPlanejada[] = [];
  const ignoradas: string[] = [];
  const semLotacao: string[] = [];

  for (const c of contas) {
    const nome = (c.nome ?? "").trim().slice(0, 160);
    if (!nome) continue;
    const codigo = c.codigo === undefined || c.codigo === null ? null : String(c.codigo).trim().slice(0, 40) || null;

    // Lotação primeiro: a chave de dedupe por nome depende dela.
    const alvoCc = (c.centroCusto ?? "").trim();
    const alvoUn = (c.unidade ?? "").trim();
    const centroCustoId = alvoCc
      ? idxCentro.get(chaveCodigo(alvoCc)) ?? idxCentro.get(`n:${normContaGmd(alvoCc)}`) ?? null
      : null;
    const unidadeId = !centroCustoId && alvoUn
      ? idxUnidade.get(chaveCodigo(alvoUn)) ?? idxUnidade.get(`n:${normContaGmd(alvoUn)}`) ?? null
      : null;

    const kCod = codigo ? chaveCodigo(codigo) : null;
    const kNome = chaveNome(centroCustoId ?? unidadeId, nome);
    if ((kCod && vistos.has(kCod)) || vistos.has(kNome)) {
      ignoradas.push(codigo ? `${codigo} ${nome}` : nome);
      continue;
    }
    if ((alvoCc || alvoUn) && !centroCustoId && !unidadeId) semLotacao.push(`${nome} → "${alvoCc || alvoUn}"`);

    const destino = (c.destino ?? "").trim() || null;
    // Série do orçamento pronto: só mês válido e número finito entram.
    const valores: Record<string, number> = {};
    for (const [mes, v] of Object.entries(c.valores ?? {})) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) continue;
      const n = Number(v);
      if (Number.isFinite(n) && n !== 0) valores[mes] = n;
    }
    criar.push({
      nome, codigo,
      ehCusto: (c.tipo ?? "").toLowerCase().startsWith("cust"),
      unidadeId, centroCustoId, destino, valores,
      lotacao: centroCustoId ? nomeDe(centroCustoId, centros) : unidadeId ? nomeDe(unidadeId, unidades) : "não atribuído",
    });
    vistos.add(kNome);
    if (kCod) vistos.add(kCod);
  }

  return { criar, ignoradas, semLotacao };
}
