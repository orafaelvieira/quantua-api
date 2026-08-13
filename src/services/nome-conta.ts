/**
 * NOME DE CONTA LIMPO — uma régua só (13/08/2026, pergunta do dono: "por que
 * algumas contas vão para o dicionário no formato da primeira e segunda
 * linha?", mostrando "4.03.02.01 PROCESSO 000014.0316758/2020" e
 * "3.02.01.02 ( - ) ABATIMENTOS E DEVOLUÇÕES SOBRE VENDAS").
 *
 * Nesses PDFs o CÓDIGO do plano de contas é impresso no MESMO fluxo de texto do
 * nome, então ele ficava grudado — e o dicionário é indexado por NOME. Código é
 * da EMPRESA: "4.03.02.01" na Alfa é outra conta na Beta. Cada empresa criava
 * sua própria entrada, o global inchava com chaves que nunca casariam de novo e
 * a regra aprendida não valia para ninguém. O código na frente ainda BLOQUEAVA a
 * limpeza do sinal — daí o "( - )" sobrevivendo no meio do nome.
 *
 * Medido no corpus: 5.506 de 35.967 linhas (15%) em 39 dos 534 documentos. Os
 * VALORES não passam por aqui — a assinatura numérica do corpus é idêntica antes
 * e depois.
 *
 * Módulo próprio, sem dependências, porque a régua vale nos DOIS lados: o parser
 * limpa o que entra e o `normalize` do account-mapper limpa a entrada ANTIGA do
 * dicionário na hora de comparar. Sem isso, todo dicionário já gravado com
 * código deixaria de casar no dia do deploy — a conta ficaria "não mapeada" num
 * IBR que estava fechado.
 */

/** Prefixo de código: "4.03.02.01 ", "2.03.01 - ", "1.1.1.01.0001 ". */
const RE_CODIGO_PREFIXO = /^\d{1,4}(?:\.\d{1,5}){1,7}(?:\s*[-–—]\s*|\s+|\s*\)\s*)/;
/** Prefixo de sinal, inclusive duplicado: "(-) (-) ", "( - ) ", "(=) ". */
const RE_SINAL_PREFIXO = /^(\s*\(?\s*[=\-+]\s*\)?\s*)+/;

/**
 * Ordem importa: código, sinal, código de novo (há documento com "(-) 3.02.01").
 * Se sobrar vazio, o nome ORIGINAL fica: conta que é só código continua
 * rastreável, e perder a linha seria pior que exibir o código.
 */
/**
 * SÓ O CÓDIGO SAI — O SINAL FICA (13/08/2026, regressão que eu mesmo introduzi e
 * a revisão adversarial pegou no mesmo dia).
 *
 * O sinal "(-)" não é sujeira: é CONTA REDUTORA. No dicionário oficial convivem
 * "(-) Móveis E Utensílios" → "(-) Depreciação" e "Móveis e Utensílios" →
 * "Imobilizado". Ao usar `limparNomeConta` (que tira o sinal) como chave da
 * cascata, as duas colapsaram numa chave só, a redutora foi DESCARTADA e a
 * depreciação passaria a valer como ativo positivo no BP. Medido: 2 trocas de
 * destino em 1.412 entradas globais.
 *
 * Onde a régua é de IDENTIDADE (chave de cascata, comparação entre entradas),
 * use esta. Onde a régua é de LIMPEZA do que veio do documento (o parser), use
 * `limparNomeConta`.
 */
export function limparCodigoDoNome(s: string): string {
  const t = s.trim().replace(RE_CODIGO_PREFIXO, "").replace(/\s*R\$\s*$/, "").trim();
  return t.length >= 2 ? t : s.trim();
}

export function limparNomeConta(s: string): string {
  let t = s.trim();
  for (let i = 0; i < 3; i++) {
    const antes = t;
    t = t.replace(RE_CODIGO_PREFIXO, "").replace(RE_SINAL_PREFIXO, "").trim();
    if (t === antes) break;
  }
  t = t.replace(/\s*R\$\s*$/, "").trim();
  return t.length >= 2 ? t : s.replace(/\s*R\$\s*$/, "").trim();
}
