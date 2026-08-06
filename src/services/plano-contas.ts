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
  /** "(+) soma"/"(−) reduz" — declara conta REDUTORA já na planilha. */
  sinal?: string | null;
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
  /** Texto CRU da coluna "Tipo" — a rota traduz em custo/despesa/financeira/
   *  capex (o modelo baixado leva o rótulo em português na volta). */
  tipoTexto: string | null;
  /** Texto CRU do "Sinal" — "(+) soma"/"(−) reduz" declara conta redutora. */
  sinalTexto: string | null;
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
  atualizar: Array<{
    id: string; nome: string; valores: Record<string, number>; janela: string[];
    /** DE-PARA DECLARADO na planilha para uma conta que JÁ existe (04/08/2026).
     *  Sem isto, preencher "Grupo de contas" numa conta existente e reimportar
     *  não fazia nada — e é justamente o gesto de quem já tem o orçamento
     *  montado e quer arrumar o de-para em lote. `null` = célula em branco, que
     *  quer dizer "não sei": o de-para atual fica como está. */
    destino: string | null;
    /** Texto CRU do "Tipo de Lcto" (05/08/2026) — a rota aplica CLASSE FISCAL
     *  em conta existente (set-only): marcar "Imposto sobre faturamento" na
     *  planilha reclassifica; célula vazia nunca apaga classe posta na grade. */
    tipoTexto: string | null;
    /** Texto CRU do "Sinal" — "(+) soma"/"(−) reduz". Set-only: em branco
     *  preserva o sinal do sistema (planilha antiga não pode desfazer). */
    sinalTexto: string | null;
  }>;
  /** Já existiam E vieram sem valores — nada a fazer. */
  ignoradas: string[];
  /** Traziam CC/unidade que não existe na estrutura — entraram sem lotação. */
  semLotacao: string[];
  /** LINHAS QUE CAÍRAM NA MESMA CONTA (30/07/2026): nome repetido na planilha
   *  sem código que as distinga. O mês vazio da primeira é preenchido pela
   *  repetida (nada se perde); mês com valor nas DUAS não é somado — dobraria a
   *  despesa — e volta aqui para o analista decidir. Antes esse caso ia para
   *  `ignoradas` como "já existia sem valores novos": o valor sumia em silêncio
   *  e ainda mentia sobre o motivo. */
  duplicadasNaPlanilha: Array<{
    nome: string;
    mesesAproveitados: string[];
    conflitos: Array<{ mes: string; ficou: number; ignorado: number }>;
  }>;
  /** O CONTRÁRIO do de cima: mesmo nome, códigos DIFERENTES → contas separadas
   *  (é o plano do cliente que manda). Volta listado porque a grade passa a
   *  mostrar duas linhas com o mesmo nome, e isso tem de ter explicação. */
  mesmoNomeContasDistintas: Array<{ nome: string; codigos: string[] }>;
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
  // `criada` só existe nos marcadores das contas nascidas NESTA importação — é
  // por ele que a linha repetida completa os meses em vez de perder o valor.
  type Candidato = LinhaExistente & { criada?: ContaPlanejada };
  const vistos = new Map<string, Candidato>();
  for (const l of existentes) {
    if (l.codigo) vistos.set(chaveCodigo(l.codigo), l);
    vistos.set(chaveNome(l.centroCustoId ?? l.unidadeId ?? null, l.nome), l);
  }

  const criar: ContaPlanejada[] = [];
  const atualizar: PlanoImportacao["atualizar"] = [];
  const ignoradas: string[] = [];
  const semLotacao: string[] = [];
  const duplicadasNaPlanilha: PlanoImportacao["duplicadasNaPlanilha"] = [];

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

    // NO PLANO DE CONTAS, O CÓDIGO É A IDENTIDADE (30/07/2026 — planilha do
    // MOVE FARMA): "Combustíveis" existe lá DUAS vezes de propósito, uma como
    // CUSTO (04.1.1.01.015) e uma como DESPESA (04.2.1.99.018). O dedupe por
    // NOME colapsava as duas na primeira (zerada) e o valor da segunda ia para
    // o lixo — jan/27 fechou 896.709,51 no sistema contra 912.109,51 na
    // planilha, exatamente os 15.400,00 dessa linha.
    //
    // Regra: dois lados que DECLARAM códigos e declaram códigos DIFERENTES são
    // contas diferentes — nome igual é coincidência. Quando um dos lados NÃO
    // tem código, o nome continua mandando: é assim que a conta cadastrada à
    // mão recebe o código do plano do cliente na reimportação (e é a trava que
    // impede o orçamento de dobrar — ver plano-contas.test.ts).
    //
    // EXCEÇÃO: folha é UMA por centro de custo (ver `chaveNome`) — decisão de
    // produto que vale mesmo com códigos diferentes.
    const candidatoPorNome = vistos.get(kNome);
    const codigosDivergem = !!kCod && !!candidatoPorNome?.codigo
      && chaveCodigo(candidatoPorNome.codigo) !== kCod && !ehNomeDeFolha(nome);
    const existente = (kCod ? vistos.get(kCod) : undefined)
      ?? (codigosDivergem ? undefined : candidatoPorNome);
    if (existente) {
      const temValor = Object.keys(valores).length > 0;
      if (existente.id && (temValor || janela.length > 0)) {
        atualizar.push({ id: existente.id, nome: existente.nome, valores, janela, destino: (c.destino ?? "").trim() || null, tipoTexto: (c.tipo ?? "").trim() || null, sinalTexto: (c.sinal ?? "").trim() || null });
        continue;
      }
      // Repetida DENTRO da planilha trazendo valor: completa os meses que a
      // primeira deixou vazios e denuncia o mês preenchido nas duas (somar
      // dobraria a despesa; escolher em silêncio esconderia o problema).
      if (existente.criada && temValor) {
        const mesesAproveitados: string[] = [];
        const conflitos: PlanoImportacao["duplicadasNaPlanilha"][number]["conflitos"] = [];
        for (const [mes, v] of Object.entries(valores)) {
          const atual = existente.criada.valores[mes];
          if (atual === undefined) { existente.criada.valores[mes] = v; mesesAproveitados.push(mes); }
          else if (atual !== v) conflitos.push({ mes, ficou: atual, ignorado: v });
        }
        if (mesesAproveitados.length > 0 || conflitos.length > 0) {
          duplicadasNaPlanilha.push({ nome, mesesAproveitados, conflitos });
          continue;
        }
      }
      ignoradas.push(codigo ? `${codigo} ${nome}` : nome);
      continue;
    }
    if ((alvoCc || alvoUn) && !centroCustoId && !unidadeId) semLotacao.push(`${nome} → "${alvoCc || alvoUn}"`);

    const destino = (c.destino ?? "").trim() || null;
    const nova: ContaPlanejada = {
      nome, codigo,
      ehCusto: (c.tipo ?? "").toLowerCase().startsWith("cust"),
      tipoTexto: (c.tipo ?? "").trim() || null,
      sinalTexto: (c.sinal ?? "").trim() || null,
      unidadeId, centroCustoId, destino, valores,
      lotacao: centroCustoId ? nomeDe(centroCustoId, centros) : unidadeId ? nomeDe(unidadeId, unidades) : "não atribuído",
    };
    criar.push(nova);
    const marcador: Candidato = { nome, codigo, centroCustoId, unidadeId, criada: nova };
    vistos.set(kNome, marcador);
    if (kCod) vistos.set(kCod, marcador);
  }

  // Mesmo nome em contas SEPARADAS (porque os códigos divergem): agrupa para a
  // tela poder dizer "são duas contas do seu plano, não uma duplicada".
  const porNomeCriado = new Map<string, string[]>();
  for (const c of criar) {
    const k = normContaGmd(c.nome);
    if (!porNomeCriado.has(k)) porNomeCriado.set(k, []);
    porNomeCriado.get(k)!.push(c.codigo ?? "—");
  }
  const mesmoNomeContasDistintas = criar
    .filter((c, i) => criar.findIndex((x) => normContaGmd(x.nome) === normContaGmd(c.nome)) === i)
    .filter((c) => (porNomeCriado.get(normContaGmd(c.nome)) ?? []).length > 1)
    .map((c) => ({ nome: c.nome, codigos: porNomeCriado.get(normContaGmd(c.nome))! }));

  return { criar, atualizar, ignoradas, semLotacao, duplicadasNaPlanilha, mesmoNomeContasDistintas };
}
