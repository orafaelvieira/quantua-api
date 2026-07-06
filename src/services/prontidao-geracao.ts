/**
 * PRONTIDÃO PARA GERAR A ANÁLISE — a régua única do gate ("verde só com prova").
 *
 * A análise com IA (a chamada mais cara do fluxo) SÓ roda quando a extração está
 * validada: os dois documentos presentes, equação patrimonial fechada, composição
 * conferida, zero contas não classificadas com valor e DRE reconciliada quando o
 * documento permite provar. Decisão do usuário (2026-07-06): "não vamos gerar o
 * documento sem tudo estar validado, para não perder tempo nem tokens".
 *
 * Usada em TRÊS lugares (mesma régua, sem divergência de caminho):
 *   1. /process — decide "Revisão necessária" vs "Pronta para gerar";
 *   2. POST /:id/generate — REJEITA (409 + pendências) quando não pronta;
 *   3. /refold — RECALCULA o status após classificar (classificou a última conta
 *      → o botão "Gerar análise" acende sozinho; sem beco sem saída).
 */

export interface ProntidaoGeracao {
  pronta: boolean;
  /** O que BLOQUEIA a geração — lista acionável exibida ao analista. */
  pendencias: string[];
  /** O que NÃO bloqueia mas o analista deve saber (ex.: DRE não-verificável). */
  avisos: string[];
}

interface LinhaValores { conta?: string; valores?: Record<string, number | null> }

/** true se alguma linha tem algum valor numérico ≠ 0 (documento realmente presente). */
function temValores(linhas: unknown): boolean {
  if (!Array.isArray(linhas)) return false;
  return (linhas as LinhaValores[]).some((l) =>
    Object.values(l?.valores ?? {}).some((v) => typeof v === "number" && v !== 0)
  );
}

export function avaliarProntidaoGeracao(dados: unknown): ProntidaoGeracao {
  const d = dados as any;
  const pendencias: string[] = [];
  const avisos: string[] = [];

  // Análise LEGADA (antes do shape v2/validação persistida): não travar o que já
  // existia — libera com aviso. A régua completa vale para extrações novas.
  if (!d || d.version !== 2 || !d.validacao) {
    return { pronta: true, pendencias: [], avisos: ["Extração antiga (sem validação persistida) — a régua de prontidão não pôde ser aplicada."] };
  }

  // 1) DOCUMENTOS PRESENTES — sem DRE ou sem BP a análise sai coxa e o usuário
  //    precisa SABER o porquê (flagrado: só BP importado e status "Pronta para gerar").
  const temBP = temValores(d.bp);
  const temDRE = temValores(d.dre);
  if (!temBP) pendencias.push("Nenhum Balanço Patrimonial foi importado — sem ele não há equação patrimonial, capital de giro nem fluxo de caixa. Suba o BP e reprocesse.");
  if (!temDRE) pendencias.push("Nenhuma DRE foi importada — a análise precisa do resultado (receita, margens, EBITDA, lucro). Suba a DRE e reprocesse.");

  const v = d.validacao as { equacaoPatrimonial?: boolean; composicaoAtivo?: boolean; composicaoPassivo?: boolean; reconciliacaoDRE?: { verificada?: boolean; ok?: boolean } };

  // 2) EQUAÇÃO PATRIMONIAL (Ativo = Passivo em todos os períodos)
  if (temBP && v.equacaoPatrimonial === false) {
    pendencias.push("O balanço não fecha (Ativo ≠ Passivo em pelo menos um período) — revise a extração na aba Histórico financeiro.");
  }

  // 3) COMPOSIÇÃO (subtotais declarados vs soma dos filhos)
  if (temBP && (v.composicaoAtivo === false || v.composicaoPassivo === false)) {
    pendencias.push("A composição do balanço não confere (subtotal declarado ≠ soma das contas) — veja os alertas de composição na auditoria.");
  }
  const alertasErro = Array.isArray(d.alertasComposicao)
    ? (d.alertasComposicao as Array<{ severidade?: string }>).filter((a) => a?.severidade === "erro").length
    : 0;
  if (alertasErro > 0) {
    pendencias.push(`${alertasErro} nó(s) com composição divergente (delta preservado em "Outros") — o alerta aponta o nó exato na auditoria.`);
  }

  // 4) CONTAS NÃO CLASSIFICADAS com valor (âmbar) — classifique ou ignore (grátis).
  //    Motor árvore usa `naoMapeados` (lista VIVA, atualizada pelo refold);
  //    fluxo legado usa `unmatchedAccounts` (valores por período).
  const nomes = new Set<string>();
  if (Array.isArray(d.naoMapeados)) {
    for (const n of d.naoMapeados as Array<{ nome?: string; valor?: number }>) {
      if (n?.nome && typeof n.valor === "number" && n.valor !== 0) nomes.add(n.nome);
    }
  } else if (Array.isArray(d.unmatchedAccounts)) {
    for (const u of d.unmatchedAccounts as Array<{ conta?: string; valores?: Record<string, number> }>) {
      if (u?.conta && Object.values(u.valores ?? {}).some((x) => typeof x === "number" && x !== 0)) nomes.add(u.conta);
    }
  }
  if (nomes.size > 0) {
    pendencias.push(`${nomes.size} conta(s) não classificada(s) com valor — classifique ou marque "ignorar" na tela de auditoria (grátis, sem IA).`);
  }

  // 5) DRE: se o documento DECLARA subtotais, a reconciliação tem que BATER.
  //    Sem declarados não há como provar — passa com AVISO (senão bloquearia p/ sempre).
  const rec = v.reconciliacaoDRE;
  if (temDRE && rec?.verificada === true && rec?.ok === false) {
    pendencias.push("A DRE diverge dos subtotais declarados no documento (Receita Líquida / Lucro Bruto / Lucro Líquido) — reconcilie antes de gerar.");
  }
  if (temDRE && rec?.verificada === false) {
    avisos.push("A DRE não traz subtotais declarados — não foi possível provar por reconciliação (confira a DRE na aba Histórico financeiro).");
  }

  return { pronta: pendencias.length === 0, pendencias, avisos };
}
