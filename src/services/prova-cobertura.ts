/**
 * PROVA DE COBERTURA — "toda conta do documento chegou na árvore?"
 *
 * A prova que faltava, e a que expôs o defeito mais perigoso do motor
 * (11/08/2026). Todas as provas que existiam medem SOMA: equação patrimonial,
 * composição, conservação de valor, reconciliação da DRE contra os subtotais
 * impressos. Todas passam quando uma conta some DENTRO de um grupo — porque o
 * total do grupo continua igual.
 *
 * Caso real (Move Farma, DRE 2025): a leitura híbrida promoveu "Locação de
 * Máquinas e Equipamentos" a PAI e engoliu "Entidades e Associações" e "Horas
 * Extras e DSR". O grupo ADMINISTRATIVAS fechou em −1.436.958,77 nas duas
 * leituras, nenhuma prova reprovou, e o documento foi publicado como conferido
 * com DUAS CONTAS A MENOS. A leitura por visão do mesmo PDF tinha as duas.
 *
 * A cobertura é a prova de CONTAGEM: o parser determinístico vê o texto do
 * documento e sabe quais linhas de conta existem lá; a árvore diz quais
 * chegaram. Conta que o parser leu e a árvore não tem é conta perdida — e isso
 * derruba o portão de integridade, forçando a cascata a escalar.
 *
 * Por que o parser serve de juiz: ele é DETERMINÍSTICO e literal — não
 * interpreta, não resume, não agrupa. Pode ler de menos num PDF torto, e aí a
 * prova simplesmente não acusa nada (comportamento seguro), mas não inventa
 * linha que não está no papel.
 *
 * O QUE NÃO SE COBRA, e por quê (medido no acervo antes de ligar: sem estes
 * dois filtros, 7 de 7 documentos reprovavam e a cascata escalaria tudo para a
 * visão sem ganho nenhum):
 *   1. LINHA-PAI do documento (a seguinte está mais indentada). O valor dela já
 *      está nos filhos; a árvore pode guardá-la como grupo em vez de nó.
 *   2. CABEÇALHO e SUBTOTAL CALCULADO — "ATIVO", "LUCRO BRUTO", "RESULTADO
 *      ANTES DA CS E IR". Por decisão de projeto os subtotais da DRE vão para
 *      `declarados` e os cabeçalhos do BP viram chave de grupo, nunca nó.
 */

/** Nome comparável entre leitores. O mesmo documento sai "(-) ICMS" de um
 *  leitor e "ICMS" de outro; "Impostos, Taxas  e Contribuições" (dois espaços)
 *  e "Impostos, Taxas e Contribuições" são a mesma conta. Sem esta canônica a
 *  prova acusaria diferença de tipografia como conta perdida. */
export function nomeComparavel(s: string): string {
  return s
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/^[\s(+-]*[+-][\s)]*/, " ")     // "(-) ", "(+)", "- " no início
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

/** Cabeçalho de grupo, total ou subtotal CALCULADO — ver o cabeçalho do arquivo. */
export function ehLinhaEstrutural(nome: string): boolean {
  const n = nomeComparavel(nome);
  if (!n) return true;
  if (/^(total|subtotal|soma)\b/.test(n)) return true;
  if (/^(ativo|passivo)( total| circulante| nao circulante)?$/.test(n)) return true;
  // LINHA DE FECHAMENTO DO BALANÇO, em todas as grafias que o acervo usa:
  // "PASSIVO + PATRIMÔNIO LÍQUIDO" (o "+" some na canônica), "PASSIVO E
  // PATRIMONIO LIQUIDO", "TOTAL DO PASSIVO E PL". Caso Dunamys (12/08/2026):
  // sem isto, o total geral do balanço era cobrado como se fosse conta e os
  // três BPs viravam ✗ — a tela ficou vermelha num documento correto.
  if (/^(ativo|passivo)( e)? (patrimonio liquido|pl)$/.test(n)) return true;
  if (/^(circulante|nao circulante|realizavel a longo prazo|permanente|resultado de exercicios futuros)$/.test(n)) return true;
  if (/^patrimonio liquido$/.test(n)) return true;
  if (/^receitas? (operacional |bruta$|liquida$)/.test(n)) return true;
  if (/^receita operacional (bruta|liquida)/.test(n)) return true;
  if (/^lucro bruto$/.test(n)) return true;
  // "LUCRO OPERACIONAL ANTES DO RESULTADO FINANCEIRO", "RESULTADO ANTES DA CS E
  // IR", "LUCRO LIQUIDO DO EXERCICIO", "PREJUIZO DO PERIODO"…
  if (/^(lucro|prejuizo|resultado)\b/.test(n) && /\b(antes|liquido|bruto|operacional|do exercicio|do periodo|acumulado)\b/.test(n)) return true;
  if (/^ebitda?\b/.test(n)) return true;
  if (/^margem\b/.test(n)) return true;
  return false;
}

export type LinhaDoDocumento = { conta: string; valores: Record<string, number>; indent?: number };

export type Cobertura = {
  /** false = não havia como conferir (parser não leu o bastante, ou não há árvore). */
  verificavel: boolean;
  ok: boolean;
  /** Contas cobráveis que o parser encontrou no documento. */
  totalDocumento: number;
  /** Dessas, quantas aparecem na árvore montada. */
  encontradas: number;
  /** As que faltam, com o valor que o parser leu (maiores primeiro). */
  faltantes: Array<{ nome: string; valor: number }>;
};

type NoQualquer = { nome?: string; filhos?: unknown; [k: string]: unknown };

/** Todos os nomes de uma árvore de DRE (lista de seções) ou de BP (períodos →
 *  grupos → itens). Aceita as duas formas para servir aos dois escopos. */
export function nomesDaArvore(arvore: unknown): Set<string> {
  const nomes = new Set<string>();
  const anda = (n: unknown): void => {
    if (Array.isArray(n)) { for (const x of n) anda(x); return; }
    if (!n || typeof n !== "object") return;
    const o = n as NoQualquer;
    if (typeof o.nome === "string" && o.nome.trim()) nomes.add(nomeComparavel(o.nome));
    if (o.filhos) anda(o.filhos);
    // capa de período do BP: { grupos: { "Ativo Circulante": [...] } }
    const grupos = (o as { grupos?: Record<string, unknown> }).grupos;
    if (grupos && typeof grupos === "object") {
      for (const [g, itens] of Object.entries(grupos)) { nomes.add(nomeComparavel(g)); anda(itens); }
    }
    // Record<periodo, ...> (a árvore inteira): desce em cada valor.
    if (!o.nome && !o.filhos && !grupos) for (const v of Object.values(o)) anda(v);
  };
  anda(arvore);
  return nomes;
}

/**
 * Linha é PAI quando o valor dela é a SOMA do bloco indentado logo abaixo.
 *
 * A versão ingênua — "é pai se a próxima está mais indentada" — foi medida e
 * reprovada: na DRE da Move Farma ela descartou 18 das 86 contas, inclusive as
 * duas que a leitura híbrida tinha perdido de verdade, e a prova passou a
 * dizer "68 de 68, tudo certo" justamente no documento defeituoso. Indentação
 * sozinha não distingue subtotal de conta que por acaso vem antes de uma linha
 * mais funda; a ARITMÉTICA distingue.
 *
 * Sem indentação em lugar nenhum (csv/xlsx plano), ninguém é pai e vale só o
 * filtro de nome.
 */
export function marcarPais(linhas: LinhaDoDocumento[]): boolean[] {
  const pais = linhas.map(() => false);
  if (!linhas.some((l) => typeof l.indent === "number")) return pais;
  const somaDe = (l: LinhaDoDocumento, p: string) => l.valores?.[p] ?? 0;
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i]!;
    if (typeof l.indent !== "number") continue;
    const filhos: LinhaDoDocumento[] = [];
    for (let j = i + 1; j < linhas.length; j++) {
      const f = linhas[j]!;
      if (typeof f.indent !== "number" || f.indent <= l.indent) break;
      filhos.push(f);
    }
    if (!filhos.length) continue;
    // Confere no período de MAIOR magnitude da linha (o mais informativo);
    // tolerância de 1% cobre arredondamento de centavo em documento impresso.
    const periodos = Object.keys(l.valores ?? {});
    const p = periodos.sort((a, b) => Math.abs(l.valores[b] ?? 0) - Math.abs(l.valores[a] ?? 0))[0];
    if (!p) continue;
    const meu = l.valores[p] ?? 0;
    if (Math.abs(meu) < 0.005) continue;
    const soma = filhos.reduce((s, f) => s + somaDe(f, p), 0);
    const tol = Math.max(0.02, Math.abs(meu) * 0.01);
    // Documento com sinal invertido entre pai e filhos (despesa positiva no
    // detalhe e negativa no subtotal) também é pai — compara o módulo.
    if (Math.abs(meu - soma) <= tol || Math.abs(Math.abs(meu) - Math.abs(soma)) <= tol) pais[i] = true;
  }
  return pais;
}

/**
 * NOME QUEBRADO EM DUAS LINHAS. O PDF imprime
 *   "(-) DEPRECIAÇÃO/AMORTIZAÇÃO/EXAUSTÃO      (218.593,23)"
 *   "ACUMULADA"
 * e cada leitor resolve de um jeito: o parser fica com o pedaço da linha do
 * valor, a visão junta as duas. Sem esta regra a prova acusaria conta perdida
 * onde só houve quebra de linha — medido: era a única falha restante nos três
 * balanços da Move Farma.
 *
 * Só vale para nome LONGO (≥ 15 caracteres): "CUSTO" não pode casar com
 * "CUSTO DE MERCADORIAS VENDIDAS" — aí seriam contas diferentes de verdade.
 */
const MIN_PREFIXO = 15;
function cobertaPorPrefixo(nomeDoc: string, daArvore: string[]): boolean {
  if (nomeDoc.length < MIN_PREFIXO) return false;
  return daArvore.some((n) =>
    (n.length >= MIN_PREFIXO) && (n.startsWith(`${nomeDoc} `) || nomeDoc.startsWith(`${n} `)),
  );
}

/**
 * Compara as contas que o parser leu no documento com os nomes que chegaram na
 * árvore.
 *
 * @param linhas linhas do parser determinístico (nome + valores + indentação)
 * @param arvore árvore original produzida pelo nível da cascata em julgamento
 * @param minimoDeLinhas abaixo disto o parser não é testemunha confiável
 *   (documento escaneado, PDF de imagem): a prova se declara não verificável em
 *   vez de reprovar todo mundo.
 */
export function provarCobertura(
  linhas: LinhaDoDocumento[],
  arvore: unknown,
  minimoDeLinhas = 5,
): Cobertura {
  const pais = marcarPais(linhas);
  const cobraveis = linhas.filter(
    (l, i) => !pais[i]
      && !ehLinhaEstrutural(l.conta)
      && Object.values(l.valores ?? {}).some((v) => typeof v === "number" && Math.abs(v) > 0.005),
  );
  const nomes = nomesDaArvore(arvore);
  if (cobraveis.length < minimoDeLinhas || nomes.size === 0) {
    return { verificavel: false, ok: true, totalDocumento: cobraveis.length, encontradas: 0, faltantes: [] };
  }
  // A mesma conta pode aparecer em períodos diferentes — conta uma vez só (a
  // árvore guarda a conta, não a ocorrência).
  const doDocumento = new Map<string, number>();
  for (const l of cobraveis) {
    const k = nomeComparavel(l.conta);
    if (!k) continue;
    const maior = Math.max(...Object.values(l.valores).map((v) => Math.abs(v) || 0));
    doDocumento.set(k, Math.max(doDocumento.get(k) ?? 0, maior));
  }
  const faltantes: Array<{ nome: string; valor: number }> = [];
  const jaVistas = new Set<string>();
  const listaArvore = [...nomes];
  for (const l of cobraveis) {
    const k = nomeComparavel(l.conta);
    if (!k || nomes.has(k) || jaVistas.has(k)) continue;
    jaVistas.add(k);
    if (cobertaPorPrefixo(k, listaArvore)) continue;
    faltantes.push({ nome: l.conta, valor: doDocumento.get(k) ?? 0 });
  }
  faltantes.sort((a, b) => Math.abs(b.valor) - Math.abs(a.valor));
  const total = doDocumento.size;
  return { verificavel: true, ok: faltantes.length === 0, totalDocumento: total, encontradas: total - faltantes.length, faltantes };
}

/** Frase para o analista — sempre nomeia as contas perdidas, porque "cobertura
 *  92%" não diz a ninguém o que conferir no papel. */
export function motivoDaCobertura(c: Cobertura, nomeDoc?: string): string | null {
  if (!c.verificavel || c.ok) return null;
  const amostra = c.faltantes.slice(0, 4).map((f) => `"${f.nome}"`).join(", ");
  const resto = c.faltantes.length > 4 ? ` e mais ${c.faltantes.length - 4}` : "";
  return `${nomeDoc ? `${nomeDoc}: ` : ""}a leitura perdeu ${c.faltantes.length} de ${c.totalDocumento} conta(s) que o documento imprime — ${amostra}${resto}. ` +
    `O total do grupo continua fechando (por isso as outras provas passam), mas o detalhe some: alguma linha foi absorvida por outra na montagem da hierarquia.`;
}
