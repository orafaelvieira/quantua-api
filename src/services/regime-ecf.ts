/**
 * REGIME DE TRIBUTAÇÃO pela ECF — dados abertos da Receita Federal.
 *
 * A BrasilAPI e a minhareceita (1ª e 2ª pernas da consulta de CNPJ) devolvem
 * `regime_tributario`: uma linha por ano-calendário declarado na ECF, ex.
 * `{ ano: 2024, forma_de_tributacao: "LUCRO REAL", quantidade_de_escrituracoes: 1 }`.
 * A ReceitaWS (3ª perna) NÃO traz o campo — aqui devolve null e nada é inventado.
 *
 * Regras de leitura:
 * - Vale o ANO-CALENDÁRIO MAIS RECENTE (o regime pode mudar de ano para ano; a
 *   ECF chega com defasagem — o rótulo exibido sempre carrega o ano).
 * - Só LUCRO REAL e LUCRO PRESUMIDO viram sugestão para `Company.regimeTributario`
 *   (valores do select). LUCRO ARBITRADO/IMUNE aparecem na ficha, sem pré-marcar.
 * - As flags ATUAIS de MEI/Simples têm precedência sobre a ECF (histórico):
 *   empresa que migrou para o Simples aparece na ECF de anos antigos.
 * - A sugestão NUNCA sobrescreve valor já escolhido pelo analista — quem garante
 *   isso são os chamadores (seed-if-empty); aqui só se calcula.
 */

export interface RegimeEcf {
  ano: number;
  forma: string; // como veio da ECF, normalizado para maiúsculas ("LUCRO REAL")
  sugerido: string | null; // valor pronto p/ Company.regimeTributario, ou null
}

const FORMA_PARA_CADASTRO: Record<string, string> = {
  "LUCRO REAL": "Lucro Real",
  "LUCRO PRESUMIDO": "Lucro Presumido",
};

/** Lê o bloco `regime_tributario` de um cnpjData cru; null quando ausente/vazio. */
export function regimeEcfDoCnpjData(cnpjData: unknown): RegimeEcf | null {
  const arr = (cnpjData as { regime_tributario?: unknown } | null | undefined)?.regime_tributario;
  if (!Array.isArray(arr)) return null;
  let melhor: { ano: number; forma: string } | null = null;
  for (const item of arr) {
    const o = item as { ano?: unknown; forma_de_tributacao?: unknown } | null;
    const ano = Number(o?.ano);
    const forma = typeof o?.forma_de_tributacao === "string" ? o.forma_de_tributacao.trim().toUpperCase() : "";
    if (!Number.isInteger(ano) || ano < 2000 || !forma) continue;
    if (!melhor || ano > melhor.ano) melhor = { ano, forma };
  }
  if (!melhor) return null;
  return { ...melhor, sugerido: FORMA_PARA_CADASTRO[melhor.forma] ?? null };
}

/**
 * Sugestão completa para `Company.regimeTributario` a partir do cnpjData:
 * MEI/Simples (flags atuais) > ECF Real/Presumido (ano mais recente) > null.
 * Devolve também a FONTE para o carimbo da trilha de auditoria.
 */
export function sugerirRegimeTributario(cnpjData: unknown): { valor: string; fonte: string } | null {
  const o = cnpjData as { opcao_pelo_mei?: unknown; opcao_pelo_simples?: unknown } | null | undefined;
  if (o?.opcao_pelo_mei === true) return { valor: "MEI", fonte: "Receita Federal (cadastro CNPJ)" };
  if (o?.opcao_pelo_simples === true) return { valor: "Simples Nacional", fonte: "Receita Federal (cadastro CNPJ)" };
  const ecf = regimeEcfDoCnpjData(cnpjData);
  if (ecf?.sugerido) return { valor: ecf.sugerido, fonte: `Receita Federal/ECF, ano-calendário ${ecf.ano}` };
  return null;
}
