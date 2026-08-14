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
  let melhorAno = -1;
  let formas = new Set<string>();
  for (const item of arr) {
    const o = item as { ano?: unknown; forma_de_tributacao?: unknown; cnpj_da_scp?: unknown } | null;
    // Escrituração de SCP = regime de OUTRA entidade (o sócio ostensivo entrega a
    // ECF da SCP em nome próprio, com cnpj_da_scp preenchido) — não é da empresa.
    if (o?.cnpj_da_scp) continue;
    const ano = Number(o?.ano);
    const forma = typeof o?.forma_de_tributacao === "string" ? o.forma_de_tributacao.trim().toUpperCase() : "";
    if (!Number.isInteger(ano) || ano < 2000 || !forma) continue;
    if (ano > melhorAno) { melhorAno = ano; formas = new Set([forma]); }
    else if (ano === melhorAno) formas.add(forma);
  }
  if (melhorAno < 0) return null;
  // Formas DIFERENTES no mesmo ano-calendário: ambíguo — nada é inventado.
  if (formas.size !== 1) return null;
  const forma = [...formas][0]!;
  return { ano: melhorAno, forma, sugerido: FORMA_PARA_CADASTRO[forma] ?? null };
}

/**
 * Sugestão completa para `Company.regimeTributario` a partir do cnpjData:
 * MEI/Simples (flags atuais) > ECF Real/Presumido (ano mais recente) > null.
 * Devolve também a FONTE para o carimbo da trilha de auditoria.
 *
 * `anoMinimoEcf`: teto de defasagem para caminhos AUTOMÁTICOS (backfill) — ECF
 * mais velha que isso não vira seed sem analista olhando; nas telas o analista
 * vê o ano na legenda e decide, então lá o teto não se aplica.
 */
export function sugerirRegimeTributario(cnpjData: unknown, opts?: { anoMinimoEcf?: number }): { valor: string; fonte: string } | null {
  const o = cnpjData as { opcao_pelo_mei?: unknown; opcao_pelo_simples?: unknown } | null | undefined;
  if (o?.opcao_pelo_mei === true) return { valor: "MEI", fonte: "Receita Federal (cadastro CNPJ)" };
  if (o?.opcao_pelo_simples === true) return { valor: "Simples Nacional", fonte: "Receita Federal (cadastro CNPJ)" };
  const ecf = regimeEcfDoCnpjData(cnpjData);
  if (ecf?.sugerido && (opts?.anoMinimoEcf === undefined || ecf.ano >= opts.anoMinimoEcf)) {
    return { valor: ecf.sugerido, fonte: `Receita Federal/ECF, ano-calendário ${ecf.ano}` };
  }
  return null;
}
