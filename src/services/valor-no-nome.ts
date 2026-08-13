import { limparNomeConta } from "./nome-conta";

/**
 * VALOR DENTRO DO NOME DA CONTA = LINHA LIDA ERRADA (13/08/2026, relato do dono:
 * "olha o que o analista que não sabe nada de contabilidade aceitou no
 * dicionário, gerando um monte de lixo no mesmo").
 *
 * O dicionário é indexado por NOME. Quando o valor do documento entra no nome,
 * cada valor diferente cria uma CHAVE NOVA: "RECUPERAÇÃO JUDICIAL R$
 * 2.187.051,35 R$" e "RECUPERAÇÃO JUDICIAL R$ 2.491.315,04 R$" são a MESMA
 * conta em duas chaves que nunca mais vão casar com documento nenhum — no ano
 * seguinte o valor muda e a conta volta para a fila do zero.
 *
 * ORIGEM PROVADA: o parser heurístico numa versão anterior, sobre o balanço da
 * AOCP, que imprime duas colunas de exercício cada uma prefixada por "R$"
 * ("RECUPERAÇÃO JUDICIAL   R$ 2.187.051,35   R$ 640.165,72"). A regra antiga
 * cortava o nome no ÚLTIMO valor e guardava o resto CRU. Hoje o parser está
 * limpo, mas a porta do dicionário continuava aceitando — e o nome pode chegar
 * de outros caminhos (leitura por IA, planilha, colagem do analista).
 *
 * POR QUE RECUSA, E NÃO LIMPA EM SILÊNCIO:
 *  1. limpar o nome NÃO casa a linha. O `normalize` do account-mapper limpa os
 *     dois lados, e nenhum dos dois tira valor — nome limpo não encontra a
 *     linha suja do documento. A "correção" seria cosmética.
 *  2. limpar CORROMPE dado correto: o nome limpo encontra a entrada boa
 *     homônima e sobrescreve o destino dela, zerando quem revisou e quando.
 *  3. valor no nome é sintoma de leitura errada — o NÚMERO daquela linha
 *     também é suspeito. Maquiar o nome esconde o sintoma.
 *
 * O QUE FICOU DE FORA, DE PROPÓSITO (é o preço da certeza — medido, não achado):
 *  · decimal solto de 2 casas sem marcador de moeda ("ADIANTAMENTO 220,00").
 *    É indistinguível de alíquota, que é como o plano de contas brasileiro
 *    escreve: "PIS 1,65 (NÃO CUMULATIVO)", "COFINS 7,60", "ISS 5,00 SOBRE
 *    SERVIÇOS", "TAXA SELIC 13,75 A.A." — 22 de 22 seriam recusadas. Também
 *    derrubaria referência a nota explicativa ("Imobilizado (Notas 10,11)"),
 *    que é linha canônica de DF publicada.
 *  · milhar agrupado SEM decimais ("1.495.929"): são números de contrato reais
 *    do acervo ("EMPRÉSTIMO CAIXA ECON. 1.495.929").
 */

/** Símbolo de moeda seguido de número: "R$ 20.362,43", "R$1.000", "US$ 1.500,00". */
const RE_SIMBOLO_VALOR = /(?:R|US|BRL|USD)?\$\s*-?\s*\d[\d.,]*/i;
/** Moeda pt-BR: milhar agrupado + 2 decimais. Dispensa o símbolo. */
const RE_MOEDA_PTBR = /(?<![\d.,])\d{1,3}(?:\.\d{3})+,\d{2}(?![\d%])/;
/** Idem en-US — o modelo de visão mistura os dois formatos na mesma leitura. */
const RE_MOEDA_ENUS = /(?<![\d.,])\d{1,3}(?:,\d{3})+\.\d{2}(?![\d%])/;

/**
 * Cifra LEGÍTIMA no nome: a demonstração declara a unidade em que está expressa
 * ("BALANÇO … - Em R$ 1", "(Em R$ 1.000)") ou a conta declara valor nominal
 * ("CAPITAL SOCIAL 100.000 AÇÕES VALOR NOMINAL R$ 1,00"). Testado contra o
 * texto que vem ANTES da cifra.
 */
const RE_CONTEXTO_LEGITIMO = /\b(em|valor\s+nominal|nominal|unidade|expresso\s+em|express[ao]\s+em|milhares?\s+de|mil)\s*(de\s+)?$/i;

/**
 * ESCALA DE UNIDADE: cifra REDONDA e SEM CENTAVOS — "R$ 1", "R$ 1.000",
 * "R$ 1.000.000". É como a demonstração declara em que unidade está
 * ("ATIVO CIRCULANTE (R$ 1.000)"), e a forma separa bem do valor lido errado:
 * valor de documento vem com centavos ("R$ 1.000,00"), unidade não.
 */
function ehEscalaDeUnidade(trecho: string): boolean {
  const num = trecho.replace(/^[^\d]*/, "");
  if (/[,]\d/.test(num)) return false;                 // tem centavos → é valor
  const digitos = num.replace(/[.\s]/g, "");
  return digitos === "1" || digitos === "1000" || digitos === "1000000";
}

export interface BloqueioValorNoNome {
  bloqueado: boolean;
  /** O trecho que denuncia a leitura errada — vai na mensagem, para o analista ver. */
  trecho?: string;
  motivo?: string;
}

/** O trecho de valor monetário achado no nome, ou null. */
export function valorMonetarioNoNome(nome: string): string | null {
  const s = limparNomeConta(String(nome ?? ""));
  for (const re of [RE_SIMBOLO_VALOR, RE_MOEDA_PTBR, RE_MOEDA_ENUS]) {
    const m = re.exec(s);
    if (!m) continue;
    const antes = s.slice(0, m.index).trimEnd();
    if (RE_CONTEXTO_LEGITIMO.test(antes)) continue;   // "… Em R$ 1", "valor nominal R$ 1,00"
    const trecho = m[0].trim().replace(/[.,]$/, "");
    if (ehEscalaDeUnidade(trecho)) continue;          // "(R$ 1.000)" — unidade, não valor
    return trecho;
  }
  return null;
}

export function avaliaValorNoNome(nomeOriginal: string): BloqueioValorNoNome {
  const trecho = valorMonetarioNoNome(nomeOriginal);
  if (!trecho) return { bloqueado: false };
  return {
    bloqueado: true,
    trecho,
    motivo:
      `A linha foi lida errada: o valor "${trecho}" entrou no NOME da conta ("${nomeOriginal}"). ` +
      `O dicionário é indexado por nome, então cada valor diferente vira uma chave nova que nunca mais casa com ` +
      `documento nenhum — e o número dessa linha também fica suspeito. Corrigir só o nome aqui não resolve, porque a ` +
      `linha do documento continua com o valor grudado e não casaria com a entrada. Use "Reprocessar" no topo do IBR ` +
      `para re-extrair; se a linha continuar assim, envie a demonstração em Excel/CSV ou marque a linha como ignorada.`,
  };
}
