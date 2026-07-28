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
  /** id da linha no bloco — é por ele que a REIMPORTAÇÃO atualiza valores. */
  id?: string;
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
  /** CONTA EXISTENTE + VALORES na planilha = atualização (28/07/2026): o
   *  round-trip "baixar modelo → preencher → importar" vive disso. `janela` é
   *  o conjunto de meses que a planilha COBRE — mês da janela sem valor é
   *  apagado (célula esvaziada fala), mês fora dela fica intocado. */
  atualizar: Array<{ id: string; nome: string; valores: Record<string, number>; janela: string[] }>;
  /** Já existiam E vieram sem valores — nada a fazer. */
  ignoradas: string[];
  /** Traziam CC/unidade que não existe na estrutura — entraram sem lotação. */
  semLotacao: string[];
}

const chaveCodigo = (c: string) => `c:${c.toLowerCase().trim()}`;

/** FOLHA É UMA POR CENTRO DE CUSTO (28/07/2026): "Salários e encargos" e
 *  "Salários e encargos (Comercial)" são a MESMA conta no mesmo CC. Sem isso, o
 *  esqueleto rodado duas vezes deixava as duas convivendo na grade — foi o que
 *  aconteceu ao renomear a conta com o sufixo do centro. */
const ehNomeDeFolha = (nome: string) => /^salarios? e encargos/.test(normContaGmd(nome));
const chaveNome = (lotacaoId: string | null, nome: string) =>
  ehNomeDeFolha(nome)
    ? `n:${lotacaoId ?? "-"}:__folha`
    : `n:${lotacaoId ?? "-"}:${normContaGmd(nome)}`;

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
  /** Meses cobertos pela planilha (cabeçalho) — define o alcance da atualização. */
  janela?: string[];
}): PlanoImportacao {
  const { contas, existentes, unidades, centros } = entrada;
  const janela = (entrada.janela ?? []).filter((m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m));
  const idxCentro = indexar(centros);
  const idxUnidade = indexar(unidades);
  const nomeDe = (id: string | null, lista: AlvoDimensional[]) => lista.find((x) => x.id === id)?.nome ?? "—";

  // Índice dos existentes POR IDENTIDADE (código, senão nome+lotação): é o que
  // torna a importação idempotente e imune a linha inserida/movida na planilha.
  const vistos = new Map<string, LinhaExistente>();
  for (const l of existentes) {
    if (l.codigo) vistos.set(chaveCodigo(l.codigo), l);
    vistos.set(chaveNome(l.centroCustoId ?? l.unidadeId ?? null, l.nome), l);
  }

  const criar: ContaPlanejada[] = [];
  const atualizar: PlanoImportacao["atualizar"] = [];
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

    // Valores saneados ANTES do dedupe: existente + valores = atualizar.
    const valores: Record<string, number> = {};
    for (const [mes, v] of Object.entries(c.valores ?? {})) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) continue;
      const n = Number(v);
      if (Number.isFinite(n) && n !== 0) valores[mes] = n;
    }

    const kCod = codigo ? chaveCodigo(codigo) : null;
    const kNome = chaveNome(centroCustoId ?? unidadeId, nome);
    const existente = (kCod ? vistos.get(kCod) : undefined) ?? vistos.get(kNome);
    if (existente) {
      const temValor = Object.keys(valores).length > 0;
      if (existente.id && (temValor || janela.length > 0)) {
        atualizar.push({ id: existente.id, nome: existente.nome, valores, janela });
      } else {
        ignoradas.push(codigo ? `${codigo} ${nome}` : nome);
      }
      continue;
    }
    if ((alvoCc || alvoUn) && !centroCustoId && !unidadeId) semLotacao.push(`${nome} → "${alvoCc || alvoUn}"`);

    const destino = (c.destino ?? "").trim() || null;
    criar.push({
      nome, codigo,
      ehCusto: (c.tipo ?? "").toLowerCase().startsWith("cust"),
      unidadeId, centroCustoId, destino, valores,
      lotacao: centroCustoId ? nomeDe(centroCustoId, centros) : unidadeId ? nomeDe(unidadeId, unidades) : "não atribuído",
    });
    const marcador: LinhaExistente = { nome, codigo, centroCustoId, unidadeId };
    vistos.set(kNome, marcador);
    if (kCod) vistos.set(kCod, marcador);
  }

  return { criar, atualizar, ignoradas, semLotacao };
}
