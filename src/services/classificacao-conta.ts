/**
 * CLASSIFICAÇÃO E CÓDIGO DA CONTA DO ORÇAMENTO (29/07/2026).
 *
 * O usuário pediu duas coisas que andam juntas na grade:
 *   1. o analista declara O QUE A CONTA É (custo, despesa, despesa financeira,
 *      capex; receita operacional, financeira ou outras) — não é o sistema que
 *      adivinha pelo bloco em que a conta caiu;
 *   2. toda conta tem um CÓDIGO INTERNO no estilo plano de contas, único, para
 *      o PROCV do Excel achar a linha.
 *
 * O tipo não é rótulo: ele diz em QUE BLOCO do motor a linha mora — e é o bloco
 * que decide se o valor entra acima do Lucro Bruto, abaixo do EBITDA ou fora do
 * resultado (capex). Por isso o prefixo do código vem do tipo: mudar o tipo de
 * uma conta sem código gera o código da família certa.
 */

/** Os tipos que o analista escolhe no dropdown da grade. */
export const TIPOS_CONTA = [
  { tipo: "custo", rotulo: "Custo", bloco: "custos", prefixo: "4.1", ajuda: "acima do Lucro Bruto — custo da operação/produção" },
  { tipo: "despesa", rotulo: "Despesa", bloco: "despesas", prefixo: "4.2", ajuda: "abaixo do Lucro Bruto — despesa operacional (pesa no EBITDA)" },
  { tipo: "despesaFinanceira", rotulo: "Despesa financeira", bloco: "despesasNaoOp", prefixo: "4.3", ajuda: "abaixo do EBITDA — juros, tarifas, IOF (não pesa no EBITDA)" },
  { tipo: "capex", rotulo: "Capex (investimento)", bloco: "capex", prefixo: "1.2", ajuda: "não é resultado: vira ativo e desce como depreciação" },
  // CLASSE FISCAL (05/08/2026) — o valor sai do EBITDA e vai para o ponto certo
  // da cascata. A conta CONTINUA no bloco em que o cliente a cadastrou (imposto
  // é conta de despesa no plano dele); quem muda de lugar é o VALOR. Por isso
  // estes tipos declaram `classe` em vez de um bloco próprio: sem migração de
  // schema, e a conta não some do grupo onde o analista a procura.
  { tipo: "impostoReceita", rotulo: "Imposto sobre faturamento", bloco: "despesas", classe: "impostoReceita", prefixo: "4.6", ajuda: "ICMS/PIS/COFINS/ISS — deduz a receita bruta, ACIMA da Receita Líquida (não pesa no EBITDA)" },
  { tipo: "impostoResultado", rotulo: "IRPJ/CSLL", bloco: "despesas", classe: "impostoResultado", prefixo: "4.7", ajuda: "provisão de IR e contribuição — entra DEPOIS do resultado (não pesa no EBITDA)" },
  { tipo: "deducaoReceita", rotulo: "Dedução da receita", bloco: "receitas", classe: "deducaoReceita", prefixo: "3.5", ajuda: "devolução, cancelamento e abatimento — reduz a receita bruta e a base fiscal" },
  { tipo: "receitaOperacional", rotulo: "Receita operacional", bloco: "receitas", prefixo: "3.1", ajuda: "receita do negócio — base da Receita Líquida" },
  { tipo: "receitaFinanceira", rotulo: "Receita financeira", bloco: "receitasNaoOp", prefixo: "3.2", ajuda: "abaixo do EBITDA — rendimento de aplicação, juros recebidos" },
  { tipo: "outrasReceitas", rotulo: "Outras receitas", bloco: "receitasNaoOp", prefixo: "3.9", ajuda: "abaixo do EBITDA — venda de ativo, aluguel recebido, indenização" },
] as const;

export type TipoConta = (typeof TIPOS_CONTA)[number]["tipo"];

const POR_TIPO = new Map(TIPOS_CONTA.map((t) => [t.tipo, t]));

export const ehTipoConta = (v: unknown): v is TipoConta => typeof v === "string" && POR_TIPO.has(v as TipoConta);

/** Bloco do motor em que uma conta daquele tipo mora. */
export function blocoDoTipo(tipo: TipoConta): string {
  return POR_TIPO.get(tipo)!.bloco;
}

/** Classe fiscal do tipo (imposto/dedução) — `undefined` para os tipos comuns.
 *  É ela que o motor lê para tirar o valor do EBITDA e levá-lo para a cascata. */
export function classeDoTipo(tipo: TipoConta): string | undefined {
  return (POR_TIPO.get(tipo) as { classe?: string } | undefined)?.classe;
}

/**
 * Tipo de uma linha a partir do bloco em que ela está hoje. `receitasNaoOp`
 * hospeda duas famílias (financeira × outras) — o código, quando existe, desempata;
 * senão o nome decide, e o default é "outras receitas".
 */
export function tipoDaLinha(blocoTipo: string, linha: { codigo?: string | null; nome?: string; destino?: { conta?: string } | null; classe?: string | null }): TipoConta {
  // A CLASSE MANDA (05/08/2026): imposto e dedução moram no bloco de despesa/
  // receita como qualquer conta, então o bloco não os distingue. A classe é
  // declaração explícita do analista — vem antes de qualquer heurística.
  const porClasse = TIPOS_CONTA.find((t) => (t as { classe?: string }).classe && (t as { classe?: string }).classe === linha.classe);
  if (porClasse) return porClasse.tipo;
  if (blocoTipo === "custos") return "custo";
  if (blocoTipo === "despesas") return "despesa";
  if (blocoTipo === "despesasNaoOp") return "despesaFinanceira";
  if (blocoTipo === "capex") return "capex";
  if (blocoTipo === "receitas") return "receitaOperacional";
  if (blocoTipo === "receitasNaoOp") {
    if ((linha.codigo ?? "").startsWith("3.2")) return "receitaFinanceira";
    const alvo = `${linha.nome ?? ""} ${linha.destino?.conta ?? ""}`;
    return /financeir|juros|aplicac|rendiment/i.test(alvo) ? "receitaFinanceira" : "outrasReceitas";
  }
  return "despesa";
}

/**
 * Tipo a partir do TEXTO da coluna "Tipo" da planilha (o modelo baixado leva os
 * rótulos em português; a planilha do cliente escreve como quiser). Sem texto
 * reconhecível, vale o palpite do parser (custo × despesa pela posição/nome) —
 * nunca se inventa capex a partir de nada.
 */
export function tipoDoTextoDaPlanilha(texto: string | null | undefined, fallbackEhCusto: boolean): TipoConta {
  const s = (texto ?? "").normalize("NFD").replace(new RegExp("[\\u0300-\\u036f]", "g"), "").toLowerCase().trim();
  if (!s) return fallbackEhCusto ? "custo" : "despesa";
  // CLASSES FISCAIS (05/08/2026) — casamento ESTRITO com os rótulos do
  // dropdown, e não regex solto. A primeira versão usava /imposto|tributo|.../
  // e a revisão adversarial mostrou o estrago: esta coluna também recebe a
  // "Natureza"/"Grupo" da planilha DO CLIENTE (NOMES_TIPO casa esses
  // cabeçalhos), e um grupo gerencial "Impostos e Taxas" — que carrega
  // IPTU/IPVA/alvará, despesa operacional comum — reclassificaria o grupo
  // inteiro para fora do EBITDA, mudando a DRE de importação antiga refeita,
  // sem aviso. Classe fiscal move dinheiro de lugar: só entra por DECLARAÇÃO
  // inequívoca, nunca por semelhança.
  if (/^imposto(s)? (sobre|s\/|s) faturamento$/.test(s) || s === "imposto sobre a receita") return "impostoReceita";
  if (/^irpj\s*\/?\s*csll$/.test(s) || s === "irpj e csll") return "impostoResultado";
  if (/^deducao (da|de) receita$/.test(s) || s === "deducoes da receita") return "deducaoReceita";
  if (/capex|investiment|imobiliz|ativo fixo/.test(s)) return "capex";
  if (/financeir/.test(s)) return "despesaFinanceira";
  if (/^cust/.test(s)) return "custo";
  // "Despesa" explícita VENCE o fallback (05/08/2026): numa aba de centro de
  // custo o fallback é "custo", e a escolha do dropdown era ignorada — o
  // analista marcava Despesa e a conta voltava custo, sem aviso.
  if (/^despes/.test(s)) return "despesa";
  return fallbackEhCusto ? "custo" : "despesa";
}

/** Só os dígitos do código, para comparar "4.2.007" com "4.2.7" sem falso negativo. */
const chaveCodigo = (c: string) => (c || "").trim().toLowerCase();

/**
 * PRÓXIMO CÓDIGO LIVRE da família do tipo — "4.2.001", "4.2.002"…
 * `usados` traz TODOS os códigos já em uso no modelo (de qualquer família): o
 * código é identificador, então nunca se repete, nem entre famílias.
 */
export function proximoCodigo(tipo: TipoConta, usados: Iterable<string>): string {
  const prefixo = POR_TIPO.get(tipo)!.prefixo;
  const emUso = new Set([...usados].map(chaveCodigo));
  // Retoma da maior sequência da família (não do total): apagar a conta 003 não
  // faz a próxima nascer 003 e colidir com um Excel antigo do analista.
  let maior = 0;
  for (const c of emUso) {
    const m = new RegExp(`^${prefixo.replace(".", "\\.")}\\.(\\d+)$`).exec(c);
    if (m) maior = Math.max(maior, Number(m[1]));
  }
  let n = maior + 1;
  let candidato = `${prefixo}.${String(n).padStart(3, "0")}`;
  while (emUso.has(chaveCodigo(candidato))) {
    n += 1;
    candidato = `${prefixo}.${String(n).padStart(3, "0")}`;
  }
  return candidato;
}

export interface LinhaParaCodificar {
  id: string;
  codigo?: string | null;
  tipo: TipoConta;
}

/**
 * Preenche o código de quem não tem e RESOLVE DUPLICATAS (a segunda conta com o
 * mesmo código ganha o próximo livre — código repetido quebra o PROCV, que é o
 * motivo de existir do campo). Devolve só o que mudou.
 */
export function codificarLinhas(linhas: LinhaParaCodificar[]): Array<{ id: string; codigo: string; motivo: "vazio" | "duplicado" }> {
  const usados = new Set<string>();
  const mudancas: Array<{ id: string; codigo: string; motivo: "vazio" | "duplicado" }> = [];
  // 1ª passada: quem já tem código único fica exatamente como está.
  for (const l of linhas) {
    const c = (l.codigo ?? "").trim();
    if (c && !usados.has(chaveCodigo(c))) usados.add(chaveCodigo(c));
  }
  // 2ª passada: vazios e duplicados recebem código da família do tipo.
  const vistos = new Set<string>();
  for (const l of linhas) {
    const c = (l.codigo ?? "").trim();
    if (!c) {
      const novo = proximoCodigo(l.tipo, usados);
      usados.add(chaveCodigo(novo));
      mudancas.push({ id: l.id, codigo: novo, motivo: "vazio" });
      continue;
    }
    if (vistos.has(chaveCodigo(c))) {
      const novo = proximoCodigo(l.tipo, usados);
      usados.add(chaveCodigo(novo));
      mudancas.push({ id: l.id, codigo: novo, motivo: "duplicado" });
      continue;
    }
    vistos.add(chaveCodigo(c));
  }
  return mudancas;
}
