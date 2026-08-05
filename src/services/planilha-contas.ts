/**
 * LEITURA DA PLANILHA DO CLIENTE (27/07/2026) — plano de contas OU orçamento
 * pronto, do jeito que a empresa manda.
 *
 * Motivo (feedback do usuário): a primeira versão lia só a LINHA 1 e exigia uma
 * coluna "Conta". Planilha de orçamento real quase nunca é assim — tem título,
 * linha em branco, cabeçalho lá na quarta linha e os meses abertos em colunas
 * ("jan/26", "Janeiro", uma data). O resultado era "A planilha precisa de uma
 * coluna Conta" numa planilha perfeitamente boa.
 *
 * O cliente lê o arquivo (xlsx no navegador) e manda a MATRIZ; a interpretação
 * — onde está o cabeçalho, o que é mês, como o número está escrito — mora aqui,
 * com testes.
 */

export interface ContaDaPlanilha {
  codigo: string;
  nome: string;
  centroCusto: string;
  unidade: string;
  tipo: string;
  destino: string;
  /** "YYYY-MM" → valor. Vazio quando a planilha traz só a estrutura. */
  valores: Record<string, number>;
}

export interface LeituraPlanilha {
  contas: ContaDaPlanilha[];
  /** Cabeçalho reconhecido — a mensagem de erro mostra o que foi lido. */
  cabecalho: string[];
  /** Linha (1-based) onde o cabeçalho foi encontrado. */
  linhaCabecalho: number;
  /** Meses reconhecidos, em ordem de coluna. */
  meses: string[];
  /** true quando a coluna de conta não foi encontrada (o resto vem preenchido
   *  para a UI explicar o que leu). */
  semColunaConta: boolean;
  /** Linhas de TOTAL/SUBTOTAL que ficaram de fora — se entrassem como conta, o
   *  orçamento contaria a mesma despesa duas vezes. Volta listado. */
  totaisIgnorados: string[];
}

/** Linha de fechamento da planilha, não conta ("Total", "Subtotal Comercial"). */
export function ehLinhaDeTotal(nome: string): boolean {
  const s = norm(nome);
  if (!s) return false;
  if (["total", "totais", "subtotal", "subtotais", "soma", "somatorio", "total geral", "resultado"].includes(s)) return true;
  return /^(total|subtotal|soma)\b/.test(s);
}

const RE_DIACRITICOS = new RegExp("[\\u0300-\\u036f]", "g");
export const norm = (v: unknown): string =>
  String(v ?? "").normalize("NFD").replace(RE_DIACRITICOS, "").toLowerCase().replace(/\s+/g, " ").trim();

const MESES_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const MESES_EXTENSO = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

const NOMES_CONTA = ["conta", "contas", "nome", "nome da conta", "descricao", "historico", "rubrica", "item", "despesa", "natureza da despesa", "descricao da conta"];
const NOMES_CODIGO = ["codigo", "cod", "cod.", "conta contabil", "classificacao", "codigo da conta", "codigo contabil", "reduzido"];
const NOMES_CC = ["centro de custo", "centro custo", "cc", "c custo", "departamento", "depto", "setor", "area"];
const NOMES_UNIDADE = ["unidade", "filial", "estabelecimento", "loja", "empresa"];
// "tipo de lcto" é o cabeçalho do modelo desde 04/08/2026 (o dono renomeou
// "Tipo" para deixar claro que é o tipo do LANÇAMENTO, não o grupo). O "tipo"
// seco fica na lista para sempre: planilha antiga tem de continuar voltando.
// A comparação é EXATA (ver `casa`), então cada grafia precisa estar aqui.
const NOMES_TIPO = ["tipo", "tipo de lcto", "tipo lcto", "tipo de lancamento", "tipo do lancamento", "natureza", "grupo", "classificacao gerencial"];
// "grupo de contas" é o de-para para o plano canônico da empresa. Cuidado ao
// mexer: NOMES_TIPO tem o "grupo" seco, e só o casamento EXATO impede que a
// coluna nova seja lida como se fosse a de tipo.
const NOMES_DESTINO = ["conta canonica", "destino", "conta gerencial", "de para", "de-para", "depara", "conta dre", "grupo de contas", "grupo de conta"];

/** Rótulo de mês → número (1-12) + ano quando o rótulo traz. */
export function lerMes(rotulo: unknown): { mes: number; ano?: number } | null {
  if (rotulo instanceof Date && !Number.isNaN(rotulo.getTime())) {
    return { mes: rotulo.getMonth() + 1, ano: rotulo.getFullYear() };
  }
  const bruto = String(rotulo ?? "").trim();
  // Data que virou string ISO no caminho navegador → JSON → API.
  const iso = bruto.match(/^(\d{4})-(\d{2})-\d{2}T/);
  if (iso) return { mes: Number(iso[2]), ano: Number(iso[1]) };

  const s = norm(rotulo);
  if (!s) return null;
  // Número puro não é mês: "12" numa célula de valor viraria dezembro.
  if (/^\d+([.,]\d+)?$/.test(s)) return null;

  let m = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m) { const mes = Number(m[2]); return mes >= 1 && mes <= 12 ? { mes, ano: Number(m[1]) } : null; }
  m = s.match(/^(\d{1,2})[-/](\d{4})$/);
  if (m) { const mes = Number(m[1]); return mes >= 1 && mes <= 12 ? { mes, ano: Number(m[2]) } : null; }

  // "jan", "jan/26", "jan-2026", "janeiro", "janeiro de 2026", "jan 26"
  const semAno = s.replace(/\s*(de\s*)?[/\-\s.]*\d{2,4}$/, "").replace(/\.$/, "").trim();
  const anoTxt = s.match(/(\d{2,4})$/)?.[1];
  const ano = anoTxt ? (anoTxt.length === 2 ? 2000 + Number(anoTxt) : Number(anoTxt)) : undefined;
  const iExt = MESES_EXTENSO.indexOf(semAno);
  if (iExt >= 0) return { mes: iExt + 1, ...(ano ? { ano } : {}) };
  const i3 = MESES_PT.indexOf(semAno.slice(0, 3));
  if (i3 >= 0 && MESES_EXTENSO[i3]!.startsWith(semAno)) return { mes: i3 + 1, ...(ano ? { ano } : {}) };
  return null;
}

/** Número como a planilha brasileira escreve: "1.234,56", "R$ 1.234,56",
 *  "(1.234)" (negativo contábil) — e também o formato americano. */
export function numeroPlanilha(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  let s = String(v ?? "").trim();
  if (!s) return 0;
  const negativo = /^\(.*\)$/.test(s) || s.endsWith("-");
  s = s.replace(/[()]/g, "").replace(/r\$/i, "").replace(/\s/g, "").replace(/-$/, "");
  const ultVirgula = s.lastIndexOf(",");
  const ultPonto = s.lastIndexOf(".");
  if (ultVirgula >= 0 && ultVirgula > ultPonto) s = s.replace(/\./g, "").replace(",", ".");
  else if (ultPonto >= 0 && ultPonto > ultVirgula) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return negativo ? -Math.abs(n) : n;
}

/**
 * @param linhas matriz da planilha (no cliente: sheet_to_json com header:1)
 * @param anoExercicio ano usado quando o rótulo do mês não traz o ano
 */
export function lerPlanilhaDeContas(linhas: unknown[][], anoExercicio: string): LeituraPlanilha {
  const casa = (celula: unknown, nomes: string[]) => nomes.includes(norm(celula));

  // 1) O cabeçalho: primeira linha (das 30 primeiras) com a coluna de conta OU
  //    com pelo menos 3 colunas de mês — planilha real tem título antes.
  let idxCab = -1;
  for (let i = 0; i < Math.min(linhas.length, 30); i++) {
    const linha = linhas[i] ?? [];
    const temConta = linha.some((c) => casa(c, NOMES_CONTA));
    const qtdMeses = linha.filter((c) => lerMes(c) !== null).length;
    if (temConta || qtdMeses >= 3) { idxCab = i; break; }
  }
  if (idxCab < 0) idxCab = 0;

  const original = linhas[idxCab] ?? [];
  const cab = original.map((c) => (c instanceof Date ? c.toISOString().slice(0, 7) : String(c ?? "").trim())).filter(Boolean);
  const acha = (nomes: string[]) => original.findIndex((c) => casa(c, nomes));
  let cNome = acha(NOMES_CONTA);
  const cCodigo = acha(NOMES_CODIGO);
  const cCc = acha(NOMES_CC);
  let cUnidade = acha(NOMES_UNIDADE);
  const cTipo = acha(NOMES_TIPO);
  const cDestino = acha(NOMES_DESTINO);

  // "Unidade" nem sempre é filial: em planilha de DRE a coluna costuma ser a
  // UNIDADE DE MEDIDA ("[R$]", "%"). Se o conteúdo é isso, não é dimensão —
  // tratá-la como filial jogaria toda conta em "sem lotação" (28/07/2026).
  if (cUnidade >= 0) {
    const amostra = linhas.slice(idxCab + 1, idxCab + 40)
      .map((l) => String((l ?? [])[cUnidade] ?? "").trim()).filter(Boolean);
    const medida = amostra.filter((v) => /^\[?\s*(r\$|reais|%|#|un|und|kg|ton)\s*\]?$/i.test(v)).length;
    if (amostra.length > 0 && medida / amostra.length > 0.5) cUnidade = -1;
  }

  // 2) Colunas de mês (ano do rótulo quando houver; senão o exercício).
  const colunasMes: Array<{ col: number; ym: string }> = [];
  original.forEach((celula, col) => {
    if (col === cNome || col === cCodigo || col === cCc || col === cUnidade) return;
    const m = lerMes(celula);
    if (!m) return;
    const ano = m.ano ?? Number(anoExercicio);
    // Data-lixo do Excel (serial 0/1900) vira 1905 e sujaria a série inteira.
    if (!Number.isFinite(ano) || ano < 2000 || ano > 2100) return;
    colunasMes.push({ col, ym: `${ano}-${String(m.mes).padStart(2, "0")}` });
  });

  // A coluna do NOME nem sempre tem rótulo reconhecível — na planilha real do
  // usuário ela se chamava "Demonstração de Resultados" (28/07/2026). Quando o
  // rótulo não entrega, a FORMA DOS DADOS entrega: entre as colunas que sobram,
  // a de nome de conta é a que tem mais texto e texto mais longo.
  // …mas só quando o RESTO do formato confirma que é plano de contas (tem
  // código contábil ou colunas de mês). Sem esse guarda, qualquer planilha —
  // "Produto | Preço | Qtd" — viraria plano de contas, e o sistema perderia a
  // capacidade de dizer "não entendi esta planilha", que vale mais.
  if (cNome < 0 && (cCodigo >= 0 || colunasMes.length >= 3)) {
    const usadas = new Set([cCodigo, cCc, cUnidade, cTipo, cDestino, ...colunasMes.map((c) => c.col)]);
    const corpo = linhas.slice(idxCab + 1, idxCab + 200);
    let melhor = { col: -1, pontos: 0 };
    const largura = Math.max(...corpo.map((l) => (l ?? []).length), original.length);
    for (let col = 0; col < largura; col++) {
      if (usadas.has(col)) continue;
      let textos = 0;
      let soma = 0;
      for (const l of corpo) {
        const v = (l ?? [])[col];
        if (v instanceof Date || typeof v === "number") continue;
        const t = String(v ?? "").trim();
        if (t.length < 4) continue;
        if (/^\d[\d.,\-/]*$/.test(t)) continue;  // código puro não é nome
        textos++; soma += Math.min(t.length, 60);
      }
      // Pontuação: quantidade de textos × comprimento médio (nome de conta é
      // texto frequente e longo; unidade/marcador é curto e raro).
      const pontos = textos === 0 ? 0 : textos * (soma / textos);
      if (pontos > melhor.pontos) melhor = { col, pontos };
    }
    if (melhor.col >= 0 && melhor.pontos > 0) cNome = melhor.col;
  }

  const base = { cabecalho: cab, linhaCabecalho: idxCab + 1, meses: colunasMes.map((c) => c.ym) };
  if (cNome < 0) return { ...base, contas: [], semColunaConta: true, totaisIgnorados: [] };

  // 3) Contas. Fora: linha sem nome (branco, rodapé) e linha de TOTAL — que
  //    contaria a mesma despesa de novo se virasse conta.
  const contas: ContaDaPlanilha[] = [];
  const totaisIgnorados: string[] = [];
  for (let i = idxCab + 1; i < linhas.length; i++) {
    const linha = linhas[i] ?? [];
    const nome = String(linha[cNome] ?? "").trim();
    if (!nome) continue;
    const codigoDaLinha = cCodigo >= 0 ? String(linha[cCodigo] ?? "").trim() : "";
    // SUBTOTAL DA CASCATA: "(+) Receita Bruta", "(=) Lucro Bruto". Na planilha
    // real do usuário eles vinham SEM código contábil, ao lado de contas
    // analíticas que têm — e importá-los somaria a mesma receita duas vezes
    // (28/07/2026). Só é subtotal quando NÃO tem código: conta analítica de
    // verdade pode legitimamente começar com "(-)".
    const marcadorCascata = /^[(\[]?\s*[+=\-−]\s*[)\]]/.test(nome);
    // A LINHA DE DEDUÇÕES DA RECEITA (30/07/2026) é NOSSA: o modelo baixado a
    // leva como "(-) Deduções da receita" sem código — o prefixo a fazia cair
    // aqui como subtotal e a volta perdia os valores em silêncio. Ela PASSA;
    // quem importa a direciona para a linha própria do bloco (nunca vira conta).
    const ehDeducaoReceita = /^deducoes?\b.*receita/.test(norm(nome).replace(/^[(\[]?\s*[+=\-−]\s*[)\]]\s*/, ""));
    if (ehLinhaDeTotal(nome) || (!codigoDaLinha && marcadorCascata && !ehDeducaoReceita)) {
      totaisIgnorados.push(nome);
      continue;
    }
    const valores: Record<string, number> = {};
    for (const { col, ym } of colunasMes) {
      const v = numeroPlanilha(linha[col]);
      if (v) valores[ym] = v;
    }
    const txt = (c: number) => (c >= 0 ? String(linha[c] ?? "").trim() : "");
    contas.push({
      nome, codigo: codigoDaLinha, centroCusto: txt(cCc), unidade: txt(cUnidade),
      tipo: txt(cTipo), destino: txt(cDestino), valores,
    });
  }

  return { ...base, contas, semColunaConta: false, totaisIgnorados };
}
