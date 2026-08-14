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

import { ehContaDePatrimonio } from "./nome-conta";

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

/** R$ curto para caber na frase da pendencia (o valor exato esta na auditoria). */
const fmtBRLCurto = (v: number): string => {
  const abs = Math.abs(v);
  if (abs >= 1e6) return `R$ ${(v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (abs >= 1e3) return `R$ ${(v / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 0 })} mil`;
  return `R$ ${v.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}`;
};

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
  // A ACAO PRECISA EXISTIR NA TELA (12/08/2026 - varredura). "Suba o BP e
  // reprocesse" apontava para um botao que nao existe aqui: documento novo so
  // entra pela Data room da empresa, e a escolha de quais entram no IBR e a aba
  // Escopo. A frase agora diz o caminho real.
  if (!temBP) pendencias.push("Nenhum Balanço Patrimonial entrou na montagem — sem ele não há equação patrimonial, capital de giro nem fluxo de caixa. selecione na aba Escopo o documento que traz esse demonstrativo (ou envie-o pela Data room da empresa, se ele ainda não estiver lá).");
  if (!temDRE) pendencias.push("Nenhuma DRE entrou na montagem — a análise precisa do resultado (receita, margens, EBITDA, lucro). selecione na aba Escopo o documento que traz esse demonstrativo (ou envie-o pela Data room da empresa, se ele ainda não estiver lá).");

  const v = d.validacao as {
    equacaoPatrimonial?: boolean; composicaoAtivo?: boolean; composicaoPassivo?: boolean;
    reconciliacaoDRE?: { verificada?: boolean; ok?: boolean };
    // A PROVA COM NUMERO JA ESTAVA AQUI e era ignorada por construcao: o tipo
    // declarado nem listava `alertas`. Cada pendencia abaixo passa a citar o
    // periodo e a diferenca que a validacao ja calculou (regra da casa:
    // vermelho so com endereco).
    alertas?: Array<{ tipo: string; area: string; mensagem: string; detalhes?: string }>;
  };
  const alertaDe = (area: string) => (v.alertas ?? []).filter((a) => a.area === area && a.tipo === "erro");
  const citar = (as: Array<{ mensagem: string; detalhes?: string }>, max = 3) =>
    as.slice(0, max).map((a) => `${a.mensagem}${a.detalhes ? ` — ${a.detalhes}` : ""}`).join(" · ")
    + (as.length > max ? ` (e mais ${as.length - max})` : "");

  // 1b) CONTA DE PATRIMÔNIO DENTRO DA DRE — pendência DURA (13/08/2026, caso
  //     Clorofila): o IBR concluiu com "Capital Subscrito" como receita não
  //     operacional e lucros acumulados como receita — o "lucro líquido" do
  //     relatório era o PL total. Toda prova aritmética passou; o que faltava
  //     era esta régua SEMÂNTICA. Capital, reservas e lucros acumulados são
  //     BALANÇO: aparecerem na DRE significa leitura errada na origem, e
  //     geração fica travada até a leitura ser corrigida.
  {
    const contasPL = (Array.isArray(d.dre) ? d.dre : [])
      .filter((l: any) => l && !l.subtotal && Object.values((l.valores ?? {}) as Record<string, number>).some((x) => Math.abs(Number(x) || 0) > 0.005) && ehContaDePatrimonio(String(l.conta ?? "")))
      .map((l: any) => `"${l.conta}"`);
    if (contasPL.length > 0) {
      pendencias.push(
        `A DRE contém ${contasPL.length} conta(s) de PATRIMÔNIO (${contasPL.slice(0, 3).join(", ")}${contasPL.length > 3 ? ", …" : ""}) — capital, reservas e lucros acumulados são contas de balanço; na DRE isso significa leitura errada do documento. Reprocesse a extração ou corrija a classificação na auditoria antes de gerar.`,
      );
    }
  }

  // 2) EQUAÇÃO PATRIMONIAL (Ativo = Passivo em todos os períodos)
  if (temBP && v.equacaoPatrimonial === false) {
    const quais = alertaDe("Equação Patrimonial");
    pendencias.push(
      quais.length
        ? `O balanço não fecha: ${citar(quais)}. Confira a coluna na aba Histórico financeiro (a prova por documento está na Conciliação contábil da empresa).`
        : "O balanço não fecha (Ativo ≠ Passivo em pelo menos um período) — revise a extração na aba Histórico financeiro.",
    );
  }

  // 3) COMPOSIÇÃO (subtotais declarados vs soma dos filhos)
  if (temBP && (v.composicaoAtivo === false || v.composicaoPassivo === false)) {
    // NOME PROPRIO (12/08/2026 - varredura). Esta prova e do TOPO do balanco:
    // AC+ANC contra o "Ativo Total" IMPRESSO no documento. Ela tinha a mesma
    // redacao da prova de NO (que hoje so avisa) e mandava "ver os alertas de
    // composicao na auditoria" - outra prova, outra tela. Duas coisas
    // diferentes com o mesmo nome e o jeito mais rapido de perder o analista.
    const quais = alertaDe("Composição");
    const lado = v.composicaoAtivo === false && v.composicaoPassivo === false ? "do ativo e do passivo"
      : v.composicaoAtivo === false ? "do ativo" : "do passivo";
    pendencias.push(
      `A soma dos grupos ${lado} não reproduz o TOTAL impresso no documento` +
      (quais.length ? `: ${citar(quais)}` : "") +
      ". Confira a coluna na aba Histórico financeiro.",
    );
  }
  const alertasErro = Array.isArray(d.alertasComposicao)
    ? (d.alertasComposicao as Array<{ severidade?: string }>).filter((a) => a?.severidade === "erro").length
    : 0;
  if (alertasErro > 0) {
    // AVISO, NÃO PENDÊNCIA (12/08/2026, princípio do dono: "todo problema
    // ligado aos documentos contábeis se resolve na conciliação do workspace;
    // a geração do IBR não pode ter atrito").
    //
    // O delta foi PRESERVADO em "Outros": nenhum valor se perdeu, os totais
    // continuam certos. É um problema de ATRIBUIÇÃO de detalhe, não de valor —
    // e é um fato do DOCUMENTO, que agora aparece na aba Conciliação contábil,
    // com o nó e a diferença, onde o analista trabalha. Bloquear a geração aqui
    // significava descobrir o problema duas telas depois de a tela anterior ter
    // dito "tudo conciliado", e sem ação disponível naquele ponto.
    avisos.push(`${alertasErro} nó(s) com composição divergente (delta preservado em "Outros") — veja o nó exato na aba Conciliação contábil da empresa.`);
  }

  // 4) CONTAS NÃO CLASSIFICADAS com valor (âmbar) — classifique ou ignore (grátis).
  //    Motor árvore usa `naoMapeados` (lista VIVA, atualizada pelo refold);
  //    fluxo legado usa `unmatchedAccounts` (valores por período).
  const nomes = new Set<string>();
  /** nome -> maior valor absoluto visto (para nomear as MAIORES na mensagem). */
  const maiores = new Map<string, number>();
  const anota = (nome: string, valor: number) => {
    nomes.add(nome);
    if (Math.abs(valor) > Math.abs(maiores.get(nome) ?? 0)) maiores.set(nome, valor);
  };
  if (Array.isArray(d.naoMapeados)) {
    for (const n of d.naoMapeados as Array<{ nome?: string; valor?: number }>) {
      if (n?.nome && typeof n.valor === "number" && n.valor !== 0) anota(n.nome, n.valor);
    }
  } else if (Array.isArray(d.unmatchedAccounts)) {
    for (const u of d.unmatchedAccounts as Array<{ conta?: string; valores?: Record<string, number> }>) {
      const vals = Object.values(u?.valores ?? {}).filter((x): x is number => typeof x === "number" && x !== 0);
      if (u?.conta && vals.length) anota(u.conta, vals.sort((a, b) => Math.abs(b) - Math.abs(a))[0]!);
    }
  }
  if (nomes.size > 0) {
    // NOMEAR AS MAIORES (12/08/2026 - varredura). A lista de nomes existia na
    // propria funcao e era jogada fora: publicava-se so o TAMANHO. O analista
    // nao conseguia conferir a contagem nem achar as contas - e e a pendencia
    // que bloqueia a chamada mais cara do fluxo.
    const porValor = [...maiores.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4);
    const amostra = porValor.map(([n, val]) => `"${n}"${val ? ` (${fmtBRLCurto(val)})` : ""}`).join(", ");
    pendencias.push(
      `${nomes.size} conta(s) não classificada(s) com valor` +
      (amostra ? `, entre elas ${amostra}` : "") +
      `. Classifique (ou marque "ignorar") na aba Histórico financeiro, no quadro "Original do documento → modelo padrão" — é grátis, sem IA.`,
    );
  }

  // 5) DRE: se o documento DECLARA subtotais, a reconciliação tem que BATER.
  //    Sem declarados não há como provar — passa com AVISO (senão bloquearia p/ sempre).
  const rec = v.reconciliacaoDRE;
  if (temDRE && rec?.verificada === true && rec?.ok === false) {
    // A MENSAGEM PRECISA CASAR COM O DOCUMENTO (03/08/2026 — flagrado em
    // produção no IBR Budel). Num IBR feito só de BALANCETE não existem
    // "subtotais declarados" (Receita Líquida / Lucro Bruto / Lucro Líquido) —
    // a prova de lá é o fechamento Ativo − Passivo = resultado acumulado. Mandar
    // o analista "reconciliar subtotais" que o documento não tem é enviá-lo
    // procurar o que não existe.
    const bals = Array.isArray((d as any)?.balancetes) ? (d as any).balancetes : [];
    const declarados = (d as any)?.declarados;
    // "Sem subtotais declarados" cobre ausente E lista vazia — o balancete não
    // declara Receita Líquida/Lucro Bruto/Lucro Líquido em lugar nenhum.
    const semDeclarados = !Array.isArray(declarados) || declarados.length === 0;
    const soBalancete = bals.length > 0 && semDeclarados;
    const ocr = bals.some((b: any) => b?.fonte === "ocr");
    if (soBalancete) {
      pendencias.push(
        ocr
          ? "O balancete não fecha (Ativo − Passivo ≠ resultado do período) e foi lido por OCR — a leitura do documento escaneado saiu com valores errados. Reprocesse; se persistir, peça o balancete em CSV/Excel ao cliente (a leitura de planilha é exata)."
          : "O balancete não fecha (Ativo − Passivo ≠ resultado do período) — revise a extração na aba Histórico financeiro antes de gerar.",
      );
    } else {
      pendencias.push("A DRE diverge dos subtotais declarados no documento (Receita Líquida / Lucro Bruto / Lucro Líquido) — reconcilie antes de gerar.");
    }
  }
  if (temDRE && rec?.verificada === false) {
    avisos.push("A DRE não traz subtotais declarados — não foi possível provar por reconciliação (confira a DRE na aba Histórico financeiro).");
  }

  return { pronta: pendencias.length === 0, pendencias, avisos };
}
