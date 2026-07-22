/**
 * Seed determinístico do Modelo Financeiro a partir do HISTÓRICO já extraído
 * (Analysis.dadosEstruturados: { periodos, dre: [{conta, valores}], bp }).
 *
 * Deriva as âncoras que a planilha da casa deriva do realizado: receita mensal
 * base, crescimento, % custos e % despesas sobre a receita. Zero IA.
 */

interface LinhaDados {
  conta?: string;
  valores?: Record<string, number>;
}

export interface SeedDerivado {
  receitaMensal: number;
  crescimentoAnual: number;
  pctCustos: number;
  pctDespesas: number;
  /** Deduções da receita (vendas canceladas/abatimentos) ÷ receita BRUTA. */
  deducoesPct: number;
  /** Prova legível para a trilha/tela: de onde cada âncora veio. */
  memoria: string[];
}

function achar(linhas: LinhaDados[], conta: string): LinhaDados | undefined {
  const alvo = conta.trim().toLowerCase();
  return linhas.find((l) => l.conta?.trim().toLowerCase() === alvo);
}

function valorEm(l: LinhaDados | undefined, periodo: string): number {
  const v = l?.valores?.[periodo];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Histórico ANUAL da DRE extraída — vira as colunas "hist" da Demonstração
 *  (realizado ao lado do projetado, como no modelo Quantua de Valuation). */
export interface HistoricoAnual {
  periodos: string[];
  linhas: {
    /** Receita BRUTA (consistente com a abertura por linha, que é bruta). */
    receita: Record<string, number>;
    /** Deduções COMERCIAIS: vendas canceladas, devoluções e abatimentos. */
    deducoes: Record<string, number>;
    /** Impostos sobre o faturamento HISTÓRICOS (quando a extração separa). */
    impostosFat: Record<string, number>;
    receitaLiquida: Record<string, number>;
    custos: Record<string, number>;
    lucroBruto: Record<string, number>;
    despesas: Record<string, number>;
    ebitda: Record<string, number>;
    /** Abaixo do EBITDA (estrutura do modelo padrão do IBR, 2026-07-16):
     *  a Demonstração vai até o Lucro Líquido com o realizado ao lado. */
    depreciacao: Record<string, number>;
    ebit: Record<string, number>;
    despesasFinanceiras: Record<string, number>;
    resultadoAntesIr: Record<string, number>;
    irCsll: Record<string, number>;
    lucroLiquido: Record<string, number>;
  };
  /** Histórico POR LINHA DE RECEITA do modelo ({linhaId: {período: valor}}) —
   *  preenchido quando o seed traz a abertura da DRE (uma linha por conta). */
  receitaPorLinha?: Record<string, Record<string, number>>;
  /** Histórico POR LINHA DE CUSTO/DESPESA ({linhaId: {período: valor ABS}}) —
   *  preenchido quando o seed abre custos/despesas por conta original do
   *  documento. Travado: é a referência de tendência ao lado da projeção. */
  custoPorLinha?: Record<string, Record<string, number>>;
}

/** Abertura de RECEITA do histórico: as contas de receita da DRE extraída
 *  (detalhe, não só o consolidado).
 *
 *  Fonte primária: `arvoreOriginalDRE` — fiel ao documento contábil do cliente,
 *  então as linhas do modelo nascem com os NOMES EXATOS do documento (regra da
 *  casa). Cada item da árvore carrega o `destino` canônico em que foi dobrado;
 *  os itens que dobraram em conta de receita são a abertura — e, quando o item
 *  é o próprio agregado do documento (tem filhos com valor), a abertura são os
 *  filhos.
 *
 *  Fallback (capturas sem árvore): heurística sobre a DRE canônica — linhas
 *  POSITIVAS antes da "Receita Líquida"; se a "Receita Bruta" for o subtotal
 *  das demais (soma bate), ela sai e fica só o detalhe. */
export interface LinhaReceitaHist {
  conta: string;
  valores: Record<string, number>;
  /** Valores COM O SINAL do documento (a linha pode ser REDUTORA do bloco —
   *  créditos/devoluções dentro dos custos). Sem isso, projetar tudo em ABS
   *  soma as redutoras como custo e infla o bloco (caso Move Farma: custos
   *  projetados a 88% da receita contra 63% no histórico). */
  valoresAssinados?: Record<string, number>;
  /** Linha canônica em que a conta original foi dobrada pelo fold (abertura de
   *  custos/despesas: separa bloco Custos × Despesas no seed do modelo). */
  destino?: string;
  /** Bloco do modelo em que a linha entra — decidido pela POSIÇÃO do destino na
   *  DRE extraída (antes do Lucro Bruto = custo; depois = despesa). */
  bloco?: "custo" | "despesa";
}

interface ItemArvoreDRE { nome?: string; valor?: number; destino?: string; filhos?: ItemArvoreDRE[] }

const tolLinhas = (v: number) => Math.max(0.05, Math.abs(v) * 0.001);

/** Achata o SUBTREE de um nó da árvore original em LINHAS do documento.
 *  Nó sem filhos-com-valor é linha. Nó cujo valor ≈ soma PROFUNDA das linhas
 *  dos filhos é subtotal impresso — as linhas são os filhos. Nó cujo valor NÃO
 *  fecha com os filhos é linha própria E os filhos são linhas também: captura
 *  de IA às vezes aninha contas irmãs sob a primeira (Move Farma 2023: 7
 *  contas de custo viraram "filhas" do CMV), e descer só um nível zerava as
 *  netas — a abertura deixava de fechar com o total do bloco. */
function achatarLinhasArvore(no: ItemArvoreDRE): { linhas: ItemArvoreDRE[]; soma: number } {
  const filhosComValor = (no.filhos ?? []).filter((f) => typeof f.valor === "number" && Number.isFinite(f.valor) && f.valor !== 0);
  const v = typeof no.valor === "number" && Number.isFinite(no.valor) ? no.valor : null;
  if (!filhosComValor.length) return v !== null && v !== 0 ? { linhas: [no], soma: v } : { linhas: [], soma: 0 };
  const sub = filhosComValor.map(achatarLinhasArvore);
  const linhas = sub.flatMap((s) => s.linhas);
  const soma = sub.reduce((s, x) => s + x.soma, 0);
  if (v !== null && v !== 0 && Math.abs(soma - v) > tolLinhas(v)) {
    return { linhas: [no, ...linhas], soma: soma + v };
  }
  return { linhas, soma };
}

/** Abertura de um GRUPO mapeado (nó cujo destino casou): as linhas achatadas do
 *  subtree — mas SÓ se elas fecharem com o valor declarado do grupo. Quando não
 *  fecham (o documento imprime um total que os filhos capturados não explicam —
 *  ex.: receita bruta da matriz Move Farma com transferências netadas fora do
 *  texto), o próprio grupo vira a linha única: exatamente o valor que o fold
 *  contabilizou, nada inventado nem duplicado. */
function aberturaDoGrupo(no: ItemArvoreDRE): ItemArvoreDRE[] {
  const filhosComValor = (no.filhos ?? []).filter((f) => typeof f.valor === "number" && Number.isFinite(f.valor) && f.valor !== 0);
  if (!filhosComValor.length) return [no];
  const sub = filhosComValor.map(achatarLinhasArvore);
  const linhas = sub.flatMap((s) => s.linhas);
  const soma = sub.reduce((s, x) => s + x.soma, 0);
  const v = typeof no.valor === "number" && Number.isFinite(no.valor) ? no.valor : null;
  if (v !== null && v !== 0 && Math.abs(soma - v) > tolLinhas(v)) return [no];
  return linhas;
}

export function derivarAberturaReceita(dadosEstruturados: unknown): LinhaReceitaHist[] {
  const de = (dadosEstruturados ?? {}) as {
    periodos?: string[];
    dre?: LinhaDados[];
    arvoreOriginalDRE?: Record<string, ItemArvoreDRE[]>;
  };
  const dre = de.dre ?? [];
  const periodos = de.periodos ?? [];
  const idxLiquida = dre.findIndex((l) => l.conta?.trim().toLowerCase() === "receita líquida");
  if (idxLiquida < 0) return [];

  // Último período com receita — referência para separar receita de dedução.
  const receitaLiq = dre[idxLiquida];
  let ultimo: string | null = null;
  for (let i = periodos.length - 1; i >= 0; i--) {
    if (Math.abs(valorEm(receitaLiq, periodos[i])) > 0) { ultimo = periodos[i]; break; }
  }
  if (!ultimo) return [];

  // Contas canônicas que SÃO receita: linhas positivas antes da Receita Líquida
  // (Receita Bruta + contas de receita adicionadas ao modelo padrão).
  const candidatas = dre.slice(0, idxLiquida).filter((l) => valorEm(l, ultimo!) > 0);
  if (!candidatas.length) return [];
  const destinosReceita = new Set(candidatas.map((l) => l.conta?.trim()).filter(Boolean) as string[]);

  // ── Caminho 1: árvore original — nomes exatos do documento do cliente ──
  const arvore = de.arvoreOriginalDRE;
  if (arvore) {
    const porNome = new Map<string, Record<string, number>>();
    const add = (nome: string | undefined, p: string, v: number | undefined) => {
      const chave = (nome ?? "").trim();
      if (!chave || typeof v !== "number" || !Number.isFinite(v) || v === 0) return;
      const vals = porNome.get(chave) ?? {};
      vals[p] = (vals[p] ?? 0) + v;
      porNome.set(chave, vals);
    };
    for (const p of periodos) {
      const visita = (it: ItemArvoreDRE): void => {
        if (it.destino && destinosReceita.has(it.destino)) {
          // O item é o agregado do documento → a abertura são as LINHAS do
          // subtree inteiro (achatamento recursivo; netas mal aninhadas entram).
          for (const l of aberturaDoGrupo(it)) add(l.nome, p, l.valor);
          return;
        }
        (it.filhos ?? []).forEach(visita);
      };
      (arvore[p] ?? []).forEach(visita);
    }
    const linhasArvore = [...porNome.entries()]
      .filter(([, vals]) => (vals[ultimo!] ?? 0) > 0) // fonte extinta não vira projeção
      .map(([conta, vals]) => ({
        conta,
        valores: Object.fromEntries(periodos.map((p) => [p, vals[p] ?? 0])),
      }));
    if (linhasArvore.length) return linhasArvore;
  }

  // ── Fallback: DRE canônica (capturas legadas sem árvore) ──
  const bruta = candidatas.find((l) => l.conta?.trim().toLowerCase() === "receita bruta");
  const demais = candidatas.filter((l) => l !== bruta);
  let linhas = candidatas;
  if (bruta && demais.length) {
    const somaDemais = demais.reduce((s, l) => s + valorEm(l, ultimo!), 0);
    const vBruta = valorEm(bruta, ultimo!);
    // Bruta ≈ soma do detalhe → é subtotal; fica só o detalhe.
    if (vBruta > 0 && Math.abs(somaDemais - vBruta) / vBruta < 0.02) linhas = demais;
  }
  return linhas.map((l) => ({
    conta: l.conta ?? "Receita",
    valores: Object.fromEntries(periodos.map((p) => [p, valorEm(l, p)])),
  }));
}

/** Abertura de CUSTOS/DESPESAS do histórico (contas entre a Receita Líquida e o
 *  EBITDA): mesma mecânica da receita — nomes EXATOS do documento via árvore
 *  original, fallback na DRE canônica. Valores devolvidos em ABS (a DRE guarda
 *  custos negativos; para ancorar premissa o analista lê o custo positivo). */
export function derivarAberturaCustos(dadosEstruturados: unknown): LinhaReceitaHist[] {
  const de = (dadosEstruturados ?? {}) as {
    periodos?: string[];
    dre?: Array<LinhaDados & { subtotal?: boolean }>;
    arvoreOriginalDRE?: Record<string, ItemArvoreDRE[]>;
  };
  const dre = de.dre ?? [];
  const periodos = de.periodos ?? [];
  const idxLiquida = dre.findIndex((l) => l.conta?.trim().toLowerCase() === "receita líquida");
  if (idxLiquida < 0) return [];
  const idxEbitda = dre.findIndex((l) => l.conta?.trim().toLowerCase() === "ebitda");
  const fim = idxEbitda > idxLiquida ? idxEbitda : dre.length;

  // Último período com receita — mesma referência da abertura de receita.
  const receitaLiq = dre[idxLiquida];
  let ultimo: string | null = null;
  for (let i = periodos.length - 1; i >= 0; i--) {
    if (Math.abs(valorEm(receitaLiq, periodos[i])) > 0) { ultimo = periodos[i]; break; }
  }
  if (!ultimo) return [];

  const candidatas = dre.slice(idxLiquida + 1, fim).filter((l) => !l.subtotal && valorEm(l, ultimo!) < 0);
  if (!candidatas.length) return [];
  const destinos = new Set(candidatas.map((l) => l.conta?.trim()).filter(Boolean) as string[]);
  // Bloco por POSIÇÃO da conta canônica na DRE: antes do Lucro Bruto = CUSTO;
  // depois = DESPESA. Vale para o modelo padrão e para modelos DRE editados
  // (linhas custom de custo ficam acima do LB por construção da cascata).
  const idxLucroBruto = dre.findIndex((l) => l.conta?.trim().toLowerCase() === "lucro bruto");
  const contasCusto = new Set(
    (idxLucroBruto > idxLiquida ? dre.slice(idxLiquida + 1, idxLucroBruto) : [])
      .map((l) => l.conta?.trim())
      .filter(Boolean) as string[]
  );
  const blocoDe = (destino: string): "custo" | "despesa" =>
    contasCusto.has(destino) || destino === "Custo Operacional" ? "custo" : "despesa";

  // Caminho 1: árvore original — nomes exatos do documento do cliente. A chave
  // agrega por (nome, destino): o DESTINO canônico do fold acompanha cada linha
  // para o seed separar bloco Custos × Despesas sem re-classificar nada.
  const arvore = de.arvoreOriginalDRE;
  if (arvore) {
    const porChave = new Map<string, { conta: string; destino: string; vals: Record<string, number> }>();
    const add = (nome: string | undefined, destino: string, p: string, v: number | undefined) => {
      const conta = (nome ?? "").trim();
      if (!conta || typeof v !== "number" || !Number.isFinite(v) || v === 0) return;
      const chave = `${conta}${destino}`;
      const ent = porChave.get(chave) ?? { conta, destino, vals: {} };
      ent.vals[p] = (ent.vals[p] ?? 0) + v;
      porChave.set(chave, ent);
    };
    for (const p of periodos) {
      const visita = (it: ItemArvoreDRE): void => {
        if (it.destino && destinos.has(it.destino)) {
          // Linhas do subtree inteiro (achatamento recursivo; netas mal
          // aninhadas entram), com o destino do pai (foi onde o fold as somou).
          for (const l of aberturaDoGrupo(it)) add(l.nome, it.destino!, p, l.valor);
          return;
        }
        (it.filhos ?? []).forEach(visita);
      };
      (arvore[p] ?? []).forEach(visita);
    }
    const linhasArvore = [...porChave.values()]
      .filter(({ vals }) => Math.abs(vals[ultimo!] ?? 0) > 0)
      .map(({ conta, destino, vals }) => ({
        conta,
        destino,
        bloco: blocoDe(destino),
        valores: Object.fromEntries(periodos.map((p) => [p, Math.abs(vals[p] ?? 0)])),
        valoresAssinados: Object.fromEntries(periodos.map((p) => [p, vals[p] ?? 0])),
      }));
    if (linhasArvore.length) return linhasArvore;
  }

  // Fallback: contas canônicas (capturas legadas sem árvore) — destino = a própria conta.
  return candidatas.map((l) => ({
    conta: l.conta ?? "Custo",
    destino: l.conta ?? "Custo",
    bloco: blocoDe(l.conta?.trim() ?? ""),
    valores: Object.fromEntries(periodos.map((p) => [p, Math.abs(valorEm(l, p))])),
    valoresAssinados: Object.fromEntries(periodos.map((p) => [p, valorEm(l, p)])),
  }));
}

/** Abertura CANÔNICA de custos/despesas (decisão 2026-07-16): as VARIÁVEIS de
 *  projeção do valuation são as contas do MODELO PADRÃO de DRE do IBR — o
 *  de-para documento→padrão já foi feito pelo fold; as contas originais do
 *  cliente ficam na aba "DFs de origem". Linha POSITIVA dentro do bloco (ex.:
 *  Outras Receitas Operacionais) entra como REDUTORA (contribuição negativa). */
export function derivarAberturaCustosCanonica(dadosEstruturados: unknown): LinhaReceitaHist[] {
  const de = (dadosEstruturados ?? {}) as { periodos?: string[]; dre?: Array<LinhaDados & { subtotal?: boolean }> };
  const dre = de.dre ?? [];
  const periodos = de.periodos ?? [];
  const idxLiquida = dre.findIndex((l) => l.conta?.trim().toLowerCase() === "receita líquida");
  if (idxLiquida < 0) return [];
  const idxEbitda = dre.findIndex((l) => l.conta?.trim().toLowerCase() === "ebitda");
  const fim = idxEbitda > idxLiquida ? idxEbitda : dre.length;

  // Último período com receita — mesma referência das demais aberturas.
  const receitaLiq = dre[idxLiquida];
  let ultimo: string | null = null;
  for (let i = periodos.length - 1; i >= 0; i--) {
    if (Math.abs(valorEm(receitaLiq, periodos[i])) > 0) { ultimo = periodos[i]; break; }
  }
  if (!ultimo) return [];

  const idxLucroBruto = dre.findIndex((l) => l.conta?.trim().toLowerCase() === "lucro bruto");
  const candidatas = dre.slice(idxLiquida + 1, fim).filter((l) => !l.subtotal && Math.abs(valorEm(l, ultimo!)) > 0);
  return candidatas.map((l) => {
    const pos = dre.indexOf(l);
    const conta = l.conta ?? "Custo";
    const bloco: "custo" | "despesa" =
      (idxLucroBruto > idxLiquida ? pos < idxLucroBruto : conta === "Custo Operacional") ? "custo" : "despesa";
    return {
      conta,
      destino: conta,
      bloco,
      valores: Object.fromEntries(periodos.map((p) => [p, Math.abs(valorEm(l, p))])),
      valoresAssinados: Object.fromEntries(periodos.map((p) => [p, valorEm(l, p)])),
    };
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
 * REGRA DE PROJEÇÃO POR CONTA (decisão do usuário, 22/07/2026)
 *
 * Antes, o modo de cada conta era escolhido por evidência estatística (a série
 * mais estável em R$ virava fixo; a mais estável como % virava % da receita).
 * O usuário determinou regras FIXAS por conta, com uma razão de fundo: estas
 * despesas são CUSTO FIXO — não acompanham o faturamento, então "% da receita"
 * projeta errado por construção. Todas viram `fixoReajuste` (valor do último
 * período ÷ 12) e o que muda é COMO o valor cresce ao longo do horizonte:
 *
 *  (a) CAGR PRÓPRIO — a conta cresce na média composta do próprio histórico.
 *      Cascata quando esse número "não faz sentido" (palavras do usuário):
 *        1. CAGR computável, ≥ 0 e dentro do teto → usa o CAGR;
 *        2. senão → último crescimento anual POSITIVO observado (mesmo teto);
 *        3. senão → IPCA (a conta ao menos acompanha a inflação, nunca encolhe).
 *  (b) IPCA — aluguel/condomínio/IPTU e terceiros são contratos indexados:
 *      último período corrigido pelo índice oficial, sem opinião de crescimento.
 *
 * Determinístico e sem I/O; cada decisão vira prova na memória do seed.
 * ────────────────────────────────────────────────────────────────────────── */

/** Teto de sanidade do crescimento derivado (a.a.). Uma despesa fixa crescendo
 *  mais que isso ao ano por todo o horizonte não é trajetória plausível — é
 *  ruído de base pequena ou período atípico. Estourou o teto = "não faz
 *  sentido", e a cascata segue para o próximo degrau. */
export const TETO_CRESCIMENTO_CONTA = 0.5;

/** Contas projetadas pelo CAGR do próprio histórico (custos fixos). */
export const CONTAS_CRESCIMENTO_PROPRIO = [
  "Despesas Gerais e Administrativas",
  "Despesas com Pessoas",
  "Despesas com Energia, Água, Telefone e Internet",
  "Despesas com Limpeza, Manutenção e Reparos",
  "Despesas com Veículos",
  "Outras Receitas Operacionais",
  "Outras Despesas Operacionais",
];

/** Contas indexadas: último período corrigido por IPCA (contratos). */
export const CONTAS_INDEXADAS_IPCA = [
  "Despesas com Aluguel, Condomínio e IPTU",
  "Despesas com Terceiros",
];

/** Marcas de acento (combining diacritical marks) — construída a partir de
 *  string para o fonte ficar 100% ASCII: caractere combinante solto no código
 *  é invisível no editor e já corrompeu este arquivo uma vez. */
const DIACRITICOS = new RegExp("[\\u0300-\\u036f]", "g");

/** Normaliza nome de conta para casar sem depender de acento/caixa/espaço. */
export function normConta(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(DIACRITICOS, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const SET_CRESCIMENTO = new Set(CONTAS_CRESCIMENTO_PROPRIO.map(normConta));
const SET_IPCA = new Set(CONTAS_INDEXADAS_IPCA.map(normConta));

/** CAGR de uma série anual: (último/primeiro)^(1/(n-1)) − 1.
 *  null quando não é computável (menos de 2 pontos, ou base não positiva). */
export function cagrDaSerie(valores: number[]): number | null {
  const xs = valores.filter((v) => Number.isFinite(v));
  if (xs.length < 2) return null;
  const primeiro = xs[0]!;
  const ultimo = xs[xs.length - 1]!;
  if (primeiro <= 0 || ultimo <= 0) return null;
  const anos = xs.length - 1;
  const c = Math.pow(ultimo / primeiro, 1 / anos) - 1;
  return Number.isFinite(c) ? c : null;
}

/** Último crescimento ano-a-ano POSITIVO da série (o degrau 2 da cascata). */
export function ultimoCrescimentoPositivo(valores: number[]): number | null {
  const xs = valores.filter((v) => Number.isFinite(v));
  for (let i = xs.length - 1; i > 0; i--) {
    const ant = xs[i - 1]!;
    const atual = xs[i]!;
    if (ant > 0 && atual > 0) {
      const g = atual / ant - 1;
      if (g > 0) return g;
    }
  }
  return null;
}

export interface RegraProjecaoConta {
  modo: "fixoReajuste";
  /** Crescimento a.a. derivado do histórico; ausente quando a regra é IPCA. */
  reajusteAnual?: number;
  /** Índice oficial — manda sobre reajusteAnual quando presente. */
  reajusteIndice?: "ipca";
  /** Prova legível da decisão (vai para a memória do seed). */
  prova: string;
}

/**
 * Regra de projeção de UMA conta, ou null quando a conta não está nas listas
 * (aí vale a heurística estatística de sempre).
 * `contribPorAno` = contribuição anual da conta, do período mais antigo ao mais
 * recente, já com o sinal do bloco (positivo = gasto).
 */
export function regraDaConta(nome: string, contribPorAno: number[]): RegraProjecaoConta | null {
  const n = normConta(nome);

  if (SET_IPCA.has(n)) {
    return { modo: "fixoReajuste", reajusteIndice: "ipca", prova: "contrato indexado — último período corrigido por IPCA" };
  }
  if (!SET_CRESCIMENTO.has(n)) return null;

  const pct = (x: number) => `${(x * 100).toFixed(1).replace(".", ",")}%`;
  const dentroDoTeto = (g: number) => g >= 0 && g <= TETO_CRESCIMENTO_CONTA;

  const cagr = cagrDaSerie(contribPorAno);
  if (cagr !== null && dentroDoTeto(cagr)) {
    return { modo: "fixoReajuste", reajusteAnual: cagr, prova: `CAGR próprio de ${pct(cagr)} a.a. (${contribPorAno.length} períodos)` };
  }

  const ultimo = ultimoCrescimentoPositivo(contribPorAno);
  if (ultimo !== null && dentroDoTeto(ultimo)) {
    const porque = cagr === null ? "CAGR não computável" : cagr < 0 ? `CAGR negativo (${pct(cagr)})` : `CAGR acima do teto (${pct(cagr)})`;
    return { modo: "fixoReajuste", reajusteAnual: ultimo, prova: `${porque} — usou o último crescimento positivo, ${pct(ultimo)} a.a.` };
  }

  const porque = cagr === null ? "sem CAGR computável" : cagr < 0 ? `CAGR negativo (${pct(cagr)})` : `CAGR fora do teto (${pct(cagr)})`;
  return { modo: "fixoReajuste", reajusteIndice: "ipca", prova: `${porque} e sem crescimento positivo no histórico — projetada por IPCA` };
}

/** Ativos de LONGO PRAZO do BP extraído (Imobilizado, Intangível, Ativos
 *  Biológicos/cultura em formação) no último período com valor — âncora dos
 *  "ativos existentes" do bloco de investimentos. Sempre LÍQUIDOS: com a
 *  segregação (2026-07-16) o BP traz o BRUTO e as redutoras "(-) Depreciação"/
 *  "(-) Amortização" (negativas) em linha própria — o item soma bruto+redutora;
 *  extração antiga (sem as linhas) segue como era (fold já compensava). */
export function derivarImobilizadoHistorico(dadosEstruturados: unknown): { periodo: string | null; itens: Array<{ conta: string; valor: number }> } {
  const de = (dadosEstruturados ?? {}) as { periodos?: string[]; bp?: Array<LinhaDados & { subtotal?: boolean }> };
  const bp = de.bp ?? [];
  const periodos = de.periodos ?? [];
  // Cada item: conta BRUTA + redutoras que a levam ao líquido.
  const ITENS: Array<{ conta: string; redutoras: string[] }> = [
    { conta: "Imobilizado", redutoras: ["(-) Depreciação"] },
    { conta: "Intangível", redutoras: ["(-) Amortização"] },
    { conta: "Ativos Biológicos - CP", redutoras: [] },
    { conta: "Ativos Biológicos - LP", redutoras: [] },
  ];
  const achaLinha = (c: string) => bp.find((l) => l.conta?.trim().toLowerCase() === c.toLowerCase());
  const itensBP = ITENS
    .map((it) => ({ ...it, linha: achaLinha(it.conta), linhasRedutoras: it.redutoras.map(achaLinha).filter((l): l is LinhaDados => !!l) }))
    .filter((it) => !!it.linha);
  if (!itensBP.length) return { periodo: null, itens: [] };
  // Último período em que ALGUMA dessas contas tem valor.
  let ultimo: string | null = null;
  for (let i = periodos.length - 1; i >= 0; i--) {
    if (itensBP.some((it) => Math.abs(valorEm(it.linha, periodos[i])) > 0)) { ultimo = periodos[i]; break; }
  }
  if (!ultimo) return { periodo: null, itens: [] };
  return {
    periodo: ultimo,
    itens: itensBP
      .map((it) => {
        const liquido = valorEm(it.linha, ultimo!) + it.linhasRedutoras.reduce((s, l) => s + valorEm(l, ultimo!), 0);
        return { conta: it.conta, valor: Math.max(0, liquido) };
      })
      .filter((x) => x.valor > 0),
  };
}

/** DÍVIDA do histórico: saldos de Empréstimos e Financiamentos (CP + LP) no
 *  último período do balanço com valor — âncora para o contrato "dívida que
 *  já existe" do B8 (o saldo vem daqui; prazo/taxa o analista informa). */
export function derivarDividaHistorico(dadosEstruturados: unknown): { periodo: string | null; itens: Array<{ conta: string; valor: number }>; total: number } {
  const de = (dadosEstruturados ?? {}) as { periodos?: string[]; bp?: LinhaDados[] };
  const bp = de.bp ?? [];
  const periodos = de.periodos ?? [];
  const CONTAS = ["Empréstimos e Financiamentos - CP", "Empréstimos e Financiamentos - LP"];
  const linhas = CONTAS
    .map((c) => bp.find((l) => l.conta?.trim().toLowerCase() === c.toLowerCase()))
    .filter((l): l is LinhaDados => !!l);
  if (!linhas.length) return { periodo: null, itens: [], total: 0 };
  let ultimo: string | null = null;
  for (let i = periodos.length - 1; i >= 0; i--) {
    if (linhas.some((l) => Math.abs(valorEm(l, periodos[i])) > 0)) { ultimo = periodos[i]; break; }
  }
  if (!ultimo) return { periodo: null, itens: [], total: 0 };
  const itens = linhas
    .map((l) => ({ conta: l.conta ?? "Empréstimos", valor: Math.abs(valorEm(l, ultimo!)) }))
    .filter((x) => x.valor > 0);
  return { periodo: ultimo, itens, total: itens.reduce((s, x) => s + x.valor, 0) };
}

/** CAIXA do histórico: saldo de Caixa e Equivalentes no último período do
 *  balanço com valor — âncora do caixa da data-base da ponte EV→Equity (e do
 *  caixa inicial da projeção). Mesma régua da dívida: BP do fecho anterior. */
export function derivarCaixaHistorico(dadosEstruturados: unknown): { periodo: string | null; valor: number } {
  const de = (dadosEstruturados ?? {}) as { periodos?: string[]; bp?: LinhaDados[] };
  const linha = (de.bp ?? []).find((l) => l.conta?.trim().toLowerCase() === "caixa e equivalentes de caixa");
  if (!linha) return { periodo: null, valor: 0 };
  const periodos = de.periodos ?? [];
  for (let i = periodos.length - 1; i >= 0; i--) {
    const v = Math.abs(valorEm(linha, periodos[i]));
    if (v > 0) return { periodo: periodos[i], valor: v };
  }
  return { periodo: null, valor: 0 };
}

/** OUTRAS contas do BP histórico (fora de caixa/giro/imobilizado/dívida/PL):
 *  âncora do bloco "Outros itens do balanço" — mútuos, antecipações, impostos
 *  e pessoal a pagar etc. Classificação SUGERIDA pelo sufixo CP/LP (circulante)
 *  e por palavras-chave (lado ativo/passivo) — o analista confirma na tela. */
export function derivarOutrosBalanco(dadosEstruturados: unknown): {
  periodo: string | null;
  itens: Array<{ conta: string; valor: number; classificacao: "ac" | "anc" | "pc" | "pnc"; ladoIncerto: boolean }>;
} {
  const de = (dadosEstruturados ?? {}) as { periodos?: string[]; bp?: LinhaDados[] };
  const bp = de.bp ?? [];
  const periodos = de.periodos ?? [];
  const JA_MODELADAS = [
    "caixa", "equivalentes", "disponibilidades", "aplicações financeiras", "aplicacoes financeiras",
    "contas a receber", "estoques", "fornecedores", "empréstimos e financiamentos", "emprestimos e financiamentos",
    "imobilizado", "intangível", "intangivel", "biológicos", "biologicos",
    "capital social", "reservas", "lucros acumulados", "prejuízos acumulados", "prejuizos acumulados", "patrimônio", "patrimonio", "ajustes de avaliação",
  ];
  const PASSIVO_KEYS = ["a pagar", "obrigaç", "obrigac", "provis", "adiantamento de cliente", "adiantamentos de cliente", "dividendos", "salários", "salarios", "pessoal", "encargos", "débitos", "debitos", "parcelament"];
  const ATIVO_KEYS = ["a receber", "recuperar", "adiantamento a fornecedor", "adiantamentos a fornecedor", "crédito", "credito", "despesas antecipadas", "depósitos judiciais", "depositos judiciais"];

  const candidatas = bp.filter((l) => {
    const nome = (l.conta ?? "").trim();
    const lower = nome.toLowerCase();
    const ehFolha = / - (cp|lp)$/i.test(nome); // só contas-folha do modelo canônico
    return ehFolha && !JA_MODELADAS.some((k) => lower.includes(k));
  });
  let ultimo: string | null = null;
  for (let i = periodos.length - 1; i >= 0; i--) {
    if (candidatas.some((l) => Math.abs(valorEm(l, periodos[i])) > 0)) { ultimo = periodos[i]; break; }
  }
  if (!ultimo) return { periodo: null, itens: [] };

  const itens = candidatas
    .map((l) => {
      const nome = (l.conta ?? "").trim();
      const lower = nome.toLowerCase();
      const valor = Math.abs(valorEm(l, ultimo!));
      const circulante = / - cp$/i.test(nome);
      const ehPassivo = PASSIVO_KEYS.some((k) => lower.includes(k));
      const ehAtivo = ATIVO_KEYS.some((k) => lower.includes(k));
      const lado: "ativo" | "passivo" = ehPassivo && !ehAtivo ? "passivo" : "ativo";
      const classificacao = (lado === "ativo" ? (circulante ? "ac" : "anc") : (circulante ? "pc" : "pnc")) as "ac" | "anc" | "pc" | "pnc";
      return { conta: nome, valor, classificacao, ladoIncerto: ehPassivo === ehAtivo };
    })
    .filter((x) => x.valor > 0);
  return { periodo: ultimo, itens };
}

/** DIAS DE GIRO do histórico (mesma régua dos indicadores do IBR, base anual):
 *  PMR = Contas a Receber CP × 365 ÷ Receita Líquida · PME/PMP = conta × 365 ÷
 *  Custo Operacional. Último período com receita; arredondado a dias inteiros. */
export function derivarGiroHistorico(dadosEstruturados: unknown): { periodo: string | null; pmr: number | null; pme: number | null; pmp: number | null; porPeriodo: Array<{ periodo: string; pmr: number | null; pme: number | null; pmp: number | null }> } {
  const de = (dadosEstruturados ?? {}) as { periodos?: string[]; bp?: LinhaDados[]; dre?: LinhaDados[] };
  const bp = de.bp ?? [];
  const dre = de.dre ?? [];
  const periodos = de.periodos ?? [];
  const receitaLinha = achar(dre, "Receita Líquida") ?? achar(dre, "Receita Bruta");
  const custoLinha = achar(dre, "Custo Operacional");
  let ultimo: string | null = null;
  for (let i = periodos.length - 1; i >= 0; i--) {
    if (Math.abs(valorEm(receitaLinha, periodos[i])) > 0) { ultimo = periodos[i]; break; }
  }
  if (!ultimo) return { periodo: null, pmr: null, pme: null, pmp: null, porPeriodo: [] };
  const dias = (saldo: number, base: number): number | null =>
    base > 0 && saldo > 0 ? Math.round((saldo * 365) / base) : null;
  // TODOS os períodos com receita (2026-07-16): a tela mostra o histórico
  // completo travado na mesma linha da projeção, não só o último ano.
  const porPeriodo = periodos
    .filter((p) => Math.abs(valorEm(receitaLinha, p)) > 0)
    .map((p) => {
      const receitaP = Math.abs(valorEm(receitaLinha, p));
      const custoP = Math.abs(valorEm(custoLinha, p));
      const contaP = (nome: string) => Math.abs(valorEm(achar(bp, nome), p));
      return {
        periodo: p,
        pmr: dias(contaP("Contas a Receber - CP"), receitaP),
        pme: dias(contaP("Estoques - CP"), custoP),
        pmp: dias(contaP("Fornecedores - CP"), custoP),
      };
    });
  const doUltimo = porPeriodo[porPeriodo.length - 1];
  return {
    periodo: ultimo,
    pmr: doUltimo?.pmr ?? null,
    pme: doUltimo?.pme ?? null,
    pmp: doUltimo?.pmp ?? null,
    porPeriodo,
  };
}

export function derivarHistoricoAnual(dadosEstruturados: unknown, excluirPeriodos: string[] = []): HistoricoAnual | null {
  const de = (dadosEstruturados ?? {}) as { periodos?: string[]; dre?: LinhaDados[] };
  const dre = de.dre ?? [];
  // A referência do TOPO é a receita BRUTA — a mesma base da abertura por
  // linha (que traz as contas brutas do documento). Sem bruta na extração,
  // a líquida assume as duas pontas (deduções ficam zero).
  const brutaLinha = achar(dre, "Receita Bruta");
  const liquidaLinha = achar(dre, "Receita Líquida");
  const receitaLinha = brutaLinha ?? liquidaLinha;
  // Deduções: "Deduções da Receita Bruta" (vendas canceladas/abatimentos) e
  // "Impostos s/ Faturamento" quando a extração os separa.
  const deducoesLinha = achar(dre, "Deduções da Receita Bruta");
  const impostosFatLinha = achar(dre, "Impostos s/ Faturamento");
  const lbLinha = achar(dre, "Lucro Bruto");
  const ebitdaLinha = achar(dre, "EBITDA");
  // Abaixo do EBITDA (modelo padrão do IBR): a Demonstração mostra o realizado
  // ao lado da projeção até o Lucro Líquido.
  const depreciacaoLinha = achar(dre, "Depreciação e Amortização");
  const ebitLinha = achar(dre, "EBIT");
  const despFinLinha = achar(dre, "Despesas Financeiras");
  const lairLinha = achar(dre, "Resultado Antes do IR e CSLL");
  const irLinha = achar(dre, "IR e CSLL");
  const llLinha = achar(dre, "Lucro Líquido");
  if (!receitaLinha) return null;

  const linhas: HistoricoAnual["linhas"] = { receita: {}, deducoes: {}, impostosFat: {}, receitaLiquida: {}, custos: {}, lucroBruto: {}, despesas: {}, ebitda: {}, depreciacao: {}, ebit: {}, despesasFinanceiras: {}, resultadoAntesIr: {}, irCsll: {}, lucroLiquido: {} };
  const periodos: string[] = [];
  for (const p of de.periodos ?? []) {
    if (excluirPeriodos.includes(p)) continue; // absorvido pelo horizonte (realizado parcial)
    const bruta = Math.abs(valorEm(receitaLinha, p));
    if (bruta <= 0) continue; // período vazio/parcial sem receita não vira coluna
    // A VERDADE do período é o GAP bruta − líquida declarada (independe dos
    // nomes das linhas intermediárias); as linhas nomeadas o DECOMPÕEM em
    // deduções comerciais × impostos s/ faturamento. Sem nomeadas, o gap
    // inteiro vai para deduções (aproximação declarada).
    const liquidaDeclarada = Math.abs(valorEm(liquidaLinha, p));
    const deducoesNomeadas = Math.abs(valorEm(deducoesLinha, p));
    const impostosFatNomeados = Math.abs(valorEm(impostosFatLinha, p));
    const gap = liquidaDeclarada > 0 ? Math.max(0, bruta - liquidaDeclarada) : deducoesNomeadas + impostosFatNomeados;
    const impostosFat = Math.min(gap, impostosFatNomeados);
    const deducoes = gap - impostosFat;
    const liquida = liquidaDeclarada > 0 ? liquidaDeclarada : bruta - gap;
    const lb = valorEm(lbLinha, p);
    const ebitda = valorEm(ebitdaLinha, p);
    periodos.push(p);
    linhas.receita[p] = bruta;
    linhas.deducoes[p] = deducoes;
    linhas.impostosFat[p] = impostosFat;
    linhas.receitaLiquida[p] = liquida;
    linhas.lucroBruto[p] = lb;
    // Custos = líquida − lucro bruto (o lucro bruto da extração parte da líquida)
    linhas.custos[p] = liquida - lb;
    linhas.despesas[p] = lb - ebitda;
    linhas.ebitda[p] = ebitda;
    // Abaixo do EBITDA: gastos em ABS (o sinal fica no rótulo "(−)" da linha),
    // resultados com o sinal do canônico.
    linhas.depreciacao[p] = Math.abs(valorEm(depreciacaoLinha, p));
    linhas.ebit[p] = valorEm(ebitLinha, p);
    linhas.despesasFinanceiras[p] = Math.abs(valorEm(despFinLinha, p));
    linhas.resultadoAntesIr[p] = valorEm(lairLinha, p);
    linhas.irCsll[p] = Math.abs(valorEm(irLinha, p));
    linhas.lucroLiquido[p] = valorEm(llLinha, p);
  }
  return periodos.length ? { periodos, linhas } : null;
}

/** Realizado PARCIAL do ano corrente (ex.: balancete até 30/06/2026): vira meses
 *  "reais" DENTRO do horizonte — o ano deixa de ser um vale de 6 meses e fecha
 *  inteiro (realizado + projetado), como o valuation exige. Sem abertura mensal
 *  na fonte, o acumulado é distribuído por igual entre os meses (aproximação
 *  declarada; o balancete mensal refina isso nas próximas fases). */
export interface RealizadoParcial {
  ano: string;
  fimMes: number; // último mês realizado (1-12)
  periodoFonte: string; // rótulo do período na extração ("30/06/2026")
  meses: string[];
  porGrupo: { receita: Record<string, number>; custos: Record<string, number>; despesas: Record<string, number> };
  memoria: string[];
}

export function derivarRealizadoParcial(dadosEstruturados: unknown, ano: string): RealizadoParcial | null {
  const de = (dadosEstruturados ?? {}) as { periodos?: string[]; dre?: LinhaDados[] };
  const dre = de.dre ?? [];
  const receitaLinha = achar(dre, "Receita Líquida") ?? achar(dre, "Receita Bruta");
  if (!receitaLinha) return null;

  // Período parcial do ano: "DD/MM/AAAA" com AAAA = ano e MM < 12.
  let periodoFonte: string | null = null;
  let fimMes = 0;
  for (const p of de.periodos ?? []) {
    const m = p.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m && m[3] === ano && Number(m[2]) < 12 && Math.abs(valorEm(receitaLinha, p)) > 0) {
      if (Number(m[2]) > fimMes) { fimMes = Number(m[2]); periodoFonte = p; }
    }
  }
  if (!periodoFonte || fimMes < 1) return null;

  const receita = Math.abs(valorEm(receitaLinha, periodoFonte));
  const lb = valorEm(achar(dre, "Lucro Bruto"), periodoFonte);
  const ebitda = valorEm(achar(dre, "EBITDA"), periodoFonte);
  const custosTot = receita - lb;
  const despesasTot = lb - ebitda;

  const meses: string[] = [];
  const porGrupo: RealizadoParcial["porGrupo"] = { receita: {}, custos: {}, despesas: {} };
  for (let m = 1; m <= fimMes; m++) {
    const mes = `${ano}-${String(m).padStart(2, "0")}`;
    meses.push(mes);
    porGrupo.receita[mes] = receita / fimMes;
    porGrupo.custos[mes] = custosTot / fimMes;
    porGrupo.despesas[mes] = despesasTot / fimMes;
  }
  return {
    ano, fimMes, periodoFonte, meses, porGrupo,
    memoria: [
      `Realizado parcial de ${ano}: período "${periodoFonte}" (receita ${receita.toFixed(2)}, EBITDA ${ebitda.toFixed(2)}), distribuído por igual entre ${fimMes} meses (sem abertura mensal na fonte).`,
    ],
  };
}

export function derivarSeed(dadosEstruturados: unknown): SeedDerivado {
  const de = (dadosEstruturados ?? {}) as { periodos?: string[]; dre?: LinhaDados[] };
  const periodos = de.periodos ?? [];
  const dre = de.dre ?? [];
  const memoria: string[] = [];

  // Base do modelo = receita BRUTA (a mesma da abertura por linha); as
  // deduções (vendas canceladas/abatimentos) viram % próprio do modelo.
  const brutaLinha = achar(dre, "Receita Bruta");
  const liquidaLinha = achar(dre, "Receita Líquida");
  const receitaLinha = brutaLinha ?? liquidaLinha;
  const deducoesLinha = achar(dre, "Deduções da Receita Bruta");
  const impostosFatLinha = achar(dre, "Impostos s/ Faturamento");
  const lucroBrutoLinha = achar(dre, "Lucro Bruto");
  const ebitdaLinha = achar(dre, "EBITDA");

  // Último período com receita > 0 (períodos parciais/zerados não ancoram nada).
  let ultimo: string | null = null;
  for (let i = periodos.length - 1; i >= 0; i--) {
    if (Math.abs(valorEm(receitaLinha, periodos[i])) > 0) { ultimo = periodos[i]; break; }
  }

  if (!ultimo) {
    return { receitaMensal: 0, crescimentoAnual: 0.1, pctCustos: 0, pctDespesas: 0, deducoesPct: 0, memoria: ["Histórico sem receita — modelo parte de valores neutros para o analista preencher."] };
  }

  const receitaAnual = Math.abs(valorEm(receitaLinha, ultimo));
  const receitaMensal = receitaAnual / 12;
  memoria.push(`Receita base: ${ultimo} = ${receitaAnual.toFixed(2)} (÷12 por mês), linha "${receitaLinha?.conta}".`);

  // Deduções COMERCIAIS (vendas canceladas/devoluções/abatimentos) como % da
  // bruta: gap bruta − líquida MENOS os impostos s/ faturamento nomeados (que
  // o bloco Impostos do modelo projeta por conta própria — sem dupla contagem).
  const liquidaDeclarada = Math.abs(valorEm(liquidaLinha, ultimo));
  const deducoesNomeadas = Math.abs(valorEm(deducoesLinha, ultimo));
  const impostosFatUlt = Math.abs(valorEm(impostosFatLinha, ultimo));
  const gapUlt = liquidaDeclarada > 0 ? Math.max(0, receitaAnual - liquidaDeclarada) : deducoesNomeadas + impostosFatUlt;
  const deducoesUlt = Math.max(0, gapUlt - Math.min(gapUlt, impostosFatUlt));
  const deducoesPct = brutaLinha && receitaAnual > 0 ? Math.max(0, Math.min(0.9, deducoesUlt / receitaAnual)) : 0;
  if (deducoesPct > 0) {
    memoria.push(`Deduções da receita: ${ultimo} = ${deducoesUlt.toFixed(2)} ÷ receita bruta = ${(deducoesPct * 100).toFixed(2)}% (vendas canceladas/abatimentos; impostos s/ faturamento ficam com o bloco Impostos).`);
  }
  const receitaLiquidaUlt = liquidaDeclarada > 0 ? liquidaDeclarada : receitaAnual - gapUlt;

  // Crescimento: variação da receita entre os dois últimos períodos com valor.
  let crescimentoAnual = 0.1;
  const idxUlt = periodos.indexOf(ultimo);
  for (let i = idxUlt - 1; i >= 0; i--) {
    const ant = Math.abs(valorEm(receitaLinha, periodos[i]));
    if (ant > 0) {
      // Trava de sanidade: −50%..+100% a.a. — fora disso a âncora vira ruído.
      crescimentoAnual = Math.max(-0.5, Math.min(1, receitaAnual / ant - 1));
      memoria.push(`Crescimento: ${periodos[i]} → ${ultimo} = ${(crescimentoAnual * 100).toFixed(1)}% a.a. (trava −50%..+100%).`);
      break;
    }
  }

  // Custos = Receita Líquida − Lucro Bruto; Despesas (OpEx) = Lucro Bruto − EBITDA.
  // Os %s dividem pela BRUTA porque é sobre ela que as linhas % do motor aplicam.
  const lucroBruto = valorEm(lucroBrutoLinha, ultimo);
  const ebitda = valorEm(ebitdaLinha, ultimo);
  let pctCustos = 0;
  let pctDespesas = 0;
  if (receitaAnual > 0 && lucroBrutoLinha) {
    pctCustos = Math.max(0, Math.min(1, (receitaLiquidaUlt - lucroBruto) / receitaAnual));
    memoria.push(`Custos: (Receita Líquida − Lucro Bruto) ÷ Receita Bruta = ${(pctCustos * 100).toFixed(1)}%.`);
  }
  if (receitaAnual > 0 && lucroBrutoLinha && ebitdaLinha) {
    pctDespesas = Math.max(0, Math.min(1, (lucroBruto - ebitda) / receitaAnual));
    memoria.push(`Despesas: (Lucro Bruto − EBITDA) ÷ Receita Bruta = ${(pctDespesas * 100).toFixed(1)}%.`);
  }

  return { receitaMensal, crescimentoAnual, pctCustos, pctDespesas, deducoesPct, memoria };
}
