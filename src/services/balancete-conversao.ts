/**
 * CONVERSÃO DO BALANCETE (F1, 2026-07-18) — determinística, ZERO IA.
 *
 * Recebe o BalanceteParseado e produz as árvores que o fold JÁ consome
 * (ArvoreOriginalBP / ArvoreOriginalDRE) + as PROVAS de integridade:
 *
 *  P1 · débitos = créditos (quando o documento declara os totais);
 *  P2 · FECHAMENTO: Ativo − Passivo = Σ resultado assinado (ao centavo) —
 *       ou Ativo = Passivo quando o exercício está ENCERRADO (apurado).
 *
 * REGRA-MESTRA (corpus de 7 sistemas): o sinal de cada conta vem da NATUREZA
 * CONTÁBIL da própria conta — nunca do rótulo do grupo (há sistemas com
 * receitas e despesas no MESMO grupo). A natureza é resolvida, nesta ordem:
 *  1. EQUAÇÃO DO PRÓPRIO DOCUMENTO — devedora: atual = anterior + D − C ·
 *     credora: atual = anterior + C − D (com o sinal do saldo invertendo a
 *     natureza efetiva: devedora com saldo negativo está credora);
 *  2. sufixo D/C declarado na coluna de saldo;
 *  3. NOME DA PRÓPRIA CONTA (`naturezaPeloNome`) — SÓ na conta ENCERRADA
 *     (saldo zerado nos dois retratos E débito == crédito) e SÓ dentro de grupo
 *     de resultado: é o único estado em que os degraus 1, 2 e 4 são todos
 *     cegos por construção (caso Instituto AOCP, 19/08/2026);
 *  4. HERANÇA da convenção de impressão do pai × sinal do saldo — cobre as
 *     contas SEM movimento no período (Belagro: "Descontos Obtidos" +54.131,14
 *     no grupo credor; "(-) ICMS sobre compras" −577.416,75 no grupo devedor);
 *  5. direção do movimento.
 *
 * HIERARQUIA por PREFIXO da classificação (não por contagem de segmentos) —
 * cobre o Protheus, onde "1.1.11 CAIXA" é FILHO de "1.1.1 DISPONIVEL" — com
 * REPARO DE DUPLA CONTAGEM verificado pela identidade contábil: no Protheus,
 * "3.2.15 (-) Impostos sobre venda" é pai real de "3.2.21.xx" (sem prefixo
 * comum); os filhos ficam soltos no nível acima e a folha 3.2.15 duplicaria a
 * soma. O reparo re-aninha a cauda de irmãos cuja soma bate ao centavo com a
 * última folha da subárvore anterior E que zera a divergência do pai.
 *
 * BP: grupos patrimoniais pelo Saldo atual, com o AJUSTE-CHAVE — o resultado
 * acumulado do período entra como linha do PL ("Resultado do Período") para o
 * balanço fechar: Ativo = Passivo ajustado, ao centavo.
 * DRE: acumulada YTD (saldo atual assinado); exercício encerrado → movimento.
 */

import type { BalanceteParseado, LinhaBalancete } from "./balancete-parser";
import type { ArvoreOriginalBP, ArvoreOriginalDRE, BPN3Item, DRESecaoItem } from "./ai-extraction";

const TOLERANCIA = 0.05; // centavos de arredondamento entre sistemas

export interface ProvasBalancete {
  /** P1 — só quando o doc declara totais. */
  debitosCreditos?: { debito: number; credito: number; ok: boolean };
  /**
   * P0 — PARTIDA DOBRADA DAS LINHAS LIDAS (10/08/2026).
   *
   * A prova cruzada que faltava e que não depende de o documento imprimir
   * total nenhum: num balancete, todo lançamento tem débito e crédito DENTRO
   * do próprio documento, então Σ débitos das folhas = Σ créditos das folhas.
   * Ela mede o que o sistema LEU (P1 comparava dois números impressos entre
   * si e passava mesmo se o parser perdesse trinta linhas).
   *
   * Pega, sem IA e sem custo: linha perdida no parse, dígito trocado numa
   * coluna, linha duplicada, coluna deslocada. Documento que só publica saldo
   * (sem colunas de movimento) fica `verificavel: false` — e aí o selo é ⚠,
   * nunca ✓.
   */
  partidaDobrada: { debitos: number; creditos: number; delta: number; folhas: number; verificavel: boolean; ok: boolean };
  /** P2 — fechamento patrimonial. */
  fechamento: { ativo: number; passivo: number; resultadoAcumulado: number; delta: number; ok: boolean };
  /**
   * P3 — COERÊNCIA DE CADA LINHA (31/07/2026). P1 e P2 olham só a coluna do
   * SALDO ATUAL: um saldo anterior corrompido passava com selo verde de 100%
   * (caso real Belagro — 310 milhões inflados por um valor colado ao nome).
   * Esta prova cobre as QUATRO colunas de cada conta: saldo atual = saldo
   * anterior + débito − crédito (devedora) ou + crédito − débito (credora).
   */
  linhas: { total: number; coerentes: number; ok: boolean; incoerentes: Array<{ classificacao: string; nome: string; anterior: number; debito: number; credito: number; atual: number }> };
  exercicioEncerrado: boolean;
  /**
   * P4 — RECONCILIAÇÃO DA DRE DO EXERCÍCIO ENCERRADO (10/08/2026).
   *
   * No balancete de encerramento as contas de resultado estão ZERADAS (o
   * lançamento de encerramento as transferiu), então a DRE é derivada do
   * MOVIMENTO — uma heurística: receita = crédito acumulado, gasto = débito
   * acumulado. Transferência interna entre contas de resultado infla os dois
   * lados e ninguém percebe. A única âncora do próprio documento é a variação
   * do resultado no PL: se a DRE derivada não bate com ela, o número não é
   * fato — e não pode receber selo verde ("verde só com prova").
   *
   * Só existe quando `exercicioEncerrado` (no balancete corrente a DRE vem do
   * SALDO das contas de resultado, que é prova direta) — e aí existe SEMPRE,
   * inclusive quando não há o que medir.
   *
   * NÃO-MEDIDO REPROVA (19/08/2026, caso Instituto AOCP). Antes, `ok` nascia
   * `true` quando a lista de âncoras do PL saía vazia — e saiu vazia justamente
   * no documento em que a DRE estava inteira invertida, porque o filtro não
   * conhecia o vocabulário do terceiro setor ("Superávit (Deficit) Acumulado").
   * O gap de R$ 84.234.066,99 contra um limite de R$ 5.000 foi APROVADO por
   * lista vazia, e a trava que existia para bloquear a publicação nunca
   * disparou. `verificavel` separa "medi e passou" de "não tinha o que medir",
   * e só o primeiro é verde — a mesma régua que o P0 já usa.
   *
   * `ancora` traz o nome da conta do PL contra a qual a DRE foi conferida: sem
   * ele, uma mudança de veredito no A/B do corpus não tem como ser explicada.
   *
   * `sinalUnico` é o arame de tropeço: DRE de exercício encerrado com duas ou
   * mais seções, TODAS do mesmo sinal, e ao menos uma que se diz receita. Não
   * existe demonstração assim — é leitura que não separou receita de gasto.
   * Só REPROVA, nunca aprova (a exigência de uma seção-receita é o que impede o
   * falso alarme na entidade pré-operacional, que só tem despesa).
   */
  dreEncerrada?: { derivado: number; declaradoPL: number; gap: number; limite: number; verificavel: boolean; ancora: string | null; sinalUnico: boolean; ok: boolean };
  /**
   * P5 — O QUE O DOCUMENTO REDECLARA NO RODAPÉ (17/08/2026, caso Belagro).
   *
   * P0/P2/P3 são provas INTERNAS: conferem o documento contra ele mesmo. Nenhuma
   * delas pega DUPLICAÇÃO SIMÉTRICA — no Belagro 12/2025 uma falha de hierarquia
   * dobrou Ativo, Passivo e DRE de uma vez, e as três provas saíram verdes com
   * Ativo R$ 242.398.476,82 no lugar de R$ 121.199.238,41.
   *
   * O bloco "Resumo" do rodapé é o número que o CONTADOR escreveu. Conferir o
   * que o motor montou contra ele é a única prova que fecha esse ângulo — e é a
   * regra da casa: prova cruzada com o número do documento.
   *
   * Só existe quando o documento traz o resumo. Cada item traz `declarado`,
   * `montado` e o veredito; `ok` é o E de todos os itens verificados.
   */
  resumoDeclarado?: {
    itens: Array<{ o: string; declarado: number; montado: number; gap: number; ok: boolean }>;
    ok: boolean;
  };
}

export interface ConversaoBalancete {
  /** Período do retrato principal (fim do balancete): "31/05/2026". */
  periodoBP: string;
  /** Retrato de abertura (dia anterior ao início): "30/04/2026" — grátis no doc. */
  periodoBPAnterior: string | null;
  arvoreBP: ArvoreOriginalBP;
  arvoreDRE: ArvoreOriginalDRE;
  resultadoAcumulado: number;
  provas: ProvasBalancete;
  /**
   * Raízes de CIRCUITO FECHADO deixadas de fora das demonstrações (espelho de
   * centro de custos). Estruturado, não só texto: a tela precisa mostrar QUE
   * dinheiro saiu, e um aviso perdido num array que ninguém lê não é auditoria.
   */
  gruposExcluidos: Array<{ nome: string; contas: number; movimento: number }>;
  avisos: string[];
}

// ── classificação dos grupos de nível 1 ──────────────────────────────────────

/**
 * "espelho" = raiz de CIRCUITO FECHADO (centro de custos que devolve tudo por
 * uma contrapartida). Não é ativo, não é passivo e não é demonstração: fica
 * fora do BP e da DRE. Detectado por ARITMÉTICA em converterBalancete, nunca
 * por nome — ver o bloco de quatro condições lá.
 */
export type TipoGrupo = "ativo" | "passivo" | "pl" | "resultado" | "apuracao" | "espelho";

const normalizar = (s: string): string =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();

/**
 * NOME DA FAMÍLIA DE APURAÇÃO/ENCERRAMENTO (10/08/2026 — bug crítico Belagro).
 *
 * Uma seção chamada "Resultado (líquido) do exercício/período" NÃO é componente
 * do resultado: ela É o resultado, transferido pelo lançamento de encerramento.
 * Somá-la à DRE é dupla contagem — no balancete de 2023 da Belagro a conta
 * [05] tinha débito = crédito = R$ 576.963.484 (puro contra-lançamento) e caía
 * em "Outras Despesas Operacionais", levando o Lucro Líquido a −687,9 milhões.
 *
 * A régua anterior procurava a substring "RESULTADO DO EXERC" e não casava com
 * "RESULTADO LÍQUIDO DO EXERCÍCIO" (o "LÍQUIDO" no meio) — daí o vazamento.
 *
 * CONSERVADORA de propósito: só casa quando "resultado" vem grudado em
 * "exercício/período" (com "líquido" opcional). NÃO casa — e não pode casar —
 * com contas legítimas da DRE: "Resultado de Equivalência Patrimonial",
 * "Resultado Financeiro", "Resultado de Posições de Mercado", "Resultado
 * Operacional do Exercício" (tem palavra própria no meio).
 */
export function ehNomeDeApuracao(nome: string): boolean {
  const n = normalizar(nome);
  // PALAVRA "APURAÇÃO", não o radical: "LUCROS APURADOS" é conta de PL, não
  // encerramento (revisão adversarial, 10/08/2026).
  if (/\bAPURACAO\b|\bENCERRAMENTO\b|\bZERAMENTO\b/.test(n)) return true;
  return /\bRESULTADO\s+(LIQUIDO\s+)?(DO\s+|DE\s+)?(EXERCICIO|PERIODO)\b/.test(n);
}

function tipoDoGrupo(nome: string, folhas: LinhaBalancete[]): TipoGrupo {
  const n = normalizar(nome);
  if (n.startsWith("ATIVO")) return "ativo";
  if (n.startsWith("PASSIVO")) return "passivo";
  // PATRIMÔNIO LÍQUIDO COMO RAIZ PRÓPRIA (13/08/2026, caso Clorofila — o pior
  // defeito do dia): o plano imprimia "Patrimonio Liquido" como raiz de nível 1
  // e o roteador, que só conhecia ATIVO*/PASSIVO*, mandava o PL INTEIRO para a
  // DRE. Capital social virava "Outras Receitas Não Operacionais", lucros
  // acumulados viravam "receita", e o fechamento (A − P = resultado) provava
  // uma tautologia: o "lucro líquido" do relatório era o PL total. PL é lado
  // credor do BALANÇO — o balde do BP já separa PC/PNC/PL pelo nome.
  if (/^PATRIMONIO\b|^SITUACAO LIQUIDA\b|^PL\b/.test(n)) return "pl";
  // Apuração: grupo de encerramento técnico — nunca vira linha de DRE.
  // Casos reais: "CONTAS DE APURAÇÃO" (Domínio), "RESULTADO LÍQUIDO DO
  // EXERCÍCIO" (Belagro) e grupo "RESULTADO" cujas folhas são todas de
  // encerramento (Phonetrack).
  //
  // VETO DA ECONOMIA PRÓPRIA (10/08/2026, caso EXTRAMED achado na revisão
  // adversarial): o nome do grupo NÃO basta. "CONTAS DE DESTINAÇÃO/APURAÇÃO DE
  // RESULTADO" carrega IRPJ 1.929.304,98 e CSLL 720.481,33 — despesa de
  // verdade. Se QUALQUER folha com valor próprio tem nome fora da família de
  // encerramento, o grupo tem conteúdo econômico e continua na DRE; do
  // contrário o IR/CSLL sumiria da demonstração e o lucro sairia inflado.
  // DESTINAÇÃO do lucro (distribuição, dividendo, JCP, reserva) NÃO é economia
  // própria: é uso do resultado depois de apurado e não pode virar despesa da
  // DRE. Fica de fora do veto — o grupo segue como apuração/destinação.
  const ehNomeDeDestinacao = (nome: string): boolean =>
    /\bDISTRIBUIC\w*\s+(DE\s+)?(LUCRO|RESULTADO)|\bDIVIDENDO|\bJCP\b|JUROS\s+SOBRE\s+(O\s+)?CAPITAL|\bRESERVA\s+(LEGAL|DE\s+LUCRO)/.test(normalizar(nome));
  const temEconomiaPropria = folhas.some(
    (f) => Math.abs(f.saldoAtual ?? 0) > TOLERANCIA && !ehNomeDeApuracao(f.nome) && !ehNomeDeDestinacao(f.nome),
  );
  if (temEconomiaPropria) return "resultado";
  if (ehNomeDeApuracao(n)) return "apuracao";
  const folhasSaoApuracao = folhas.length > 0 && folhas.every((f) => ehNomeDeApuracao(f.nome));
  if (folhasSaoApuracao) return "apuracao";
  return "resultado";
}

// ── natureza contábil pela equação do documento ─────────────────────────────

/** "D" = impressa como devedora · "C" = credora · null = indeterminada. */
export function convencaoImpressao(l: LinhaBalancete): "D" | "C" | null {
  const mov = l.debito - l.credito;
  if (Math.abs(mov) <= TOLERANCIA) return null; // sem movimento líquido: ambígua
  const devedora = Math.abs(l.saldoAnterior + mov - l.saldoAtual) <= TOLERANCIA;
  const credora = Math.abs(l.saldoAnterior - mov - l.saldoAtual) <= TOLERANCIA;
  if (devedora && !credora) return "D";
  if (credora && !devedora) return "C";
  return null;
}

const opor = (n: "D" | "C"): "D" | "C" => (n === "D" ? "C" : "D");

// ── natureza pelo NOME da própria conta (degrau 3) ───────────────────────────

/**
 * NATUREZA PELO VOCABULÁRIO DA PRÓPRIA CONTA (19/08/2026 — caso Instituto AOCP).
 *
 * Existe para UM estado, e só para ele: a conta ENCERRADA. No balancete de
 * encerramento a apuração zera as contas de resultado, e a linha chega com
 * saldo anterior 0,00, saldo atual 0,00 e débito == crédito. Nesse estado os
 * outros degraus são cegos POR CONSTRUÇÃO — a equação do documento não decide
 * (movimento líquido zero), não há sufixo D/C (o saldo é zero) e a direção do
 * movimento não existe (as duas colunas são iguais). Sobrava a herança, que no
 * IAOCP desceu "D" da raiz "SUPERÁVIT / DÉFICIT DO EXERCÍCIO" até as folhas e
 * publicou a receita de R$ 44.233.132,32 como −44.233.132,32, com a DRE inteira
 * negativa (soma −84.234.066,99 = a própria coluna de débito da raiz).
 *
 * Três famílias, e a ordem importa:
 *
 *  · REDUTORA vence sempre — "DEDUÇÃO DA RECEITA BRUTA" tem a palavra RECEITA e
 *    é conta devedora. Sem esta precedência o ISSQN de R$ 1.326.898,10 entra
 *    somando (erro medido de R$ 2.653.796,20 no resultado do IAOCP);
 *  · CONTRADIÇÃO = MUDO. "Recuperação de Despesas" e "Sobras de Gastos com
 *    Concursos" falam as duas línguas: quem decide é o pai, que acerta. Chutar
 *    aqui seria pior que deferir.
 *
 * PROIBIDOS no léxico, de propósito: LUCRO (aparece em "Contribuição Social
 * sobre o Lucro Líquido", que é despesa), RESULTADO ("Resultado de Equivalência
 * Patrimonial" é conta legítima dos dois lados) e DOAÇÃO ("Doações a APAE" é
 * despesa; "Doações Recebidas" é receita).
 *
 * null = o nome não fala. Não é "indefinido por preguiça": é a resposta certa
 * para a maioria das contas, e o degrau seguinte assume.
 */
/**
 * CONSTRUÇÃO DE INCIDÊNCIA — apagada do nome ANTES de consultar as famílias
 * (revisão adversarial, 19/08/2026). "<algo> sobre receita/vendas/faturamento/
 * serviços" descreve a BASE DE CÁLCULO, não a natureza: "ICMS sobre vendas",
 * "PIS SOBRE RECEITA", "COFINS S/ FATURAMENTO" e "Comissões sobre vendas" são
 * saída, e a família RECEITA os capturava pela palavra da base.
 *
 * Medido no corpus: 21 nomes distintos, 86 linhas. No "SABRINA - Balancete
 * 2020" a seção "DEDUÇÕES DA RECEITA BRUTA" ia de −16.242,87 (certo) para
 * −2.575,97, erro de 13.666,90 — MENOR que o limite do P4 do próprio documento
 * (18.721,98), ou seja, a prova não pegaria.
 *
 * APAGAR é melhor que marcar como gasto: numa corretora "Comissões sobre
 * vendas" É receita. Sem a base no nome, a conta fica MUDA e quem decide é o
 * pai — o mesmo princípio da contradição.
 */
const RE_INCIDENCIA = /\b(SOBRE|S\.?\/)\s*(AS?|OS?)?\s*(RECEITAS?|VENDAS?|FATURAMENTO|SERVICOS?)\b/g;

const LEX_REDUTORA =
  /^\(?\s*-|\bDEDUC(AO|OES)\b|\bABATIMENTO|\bDEVOLUC|\bCANCELAMENTO|\bCANCELAD|\bDESCONTOS?\s+CONCEDIDOS?\b|\bNAO\s+GANHOS?\b|\bIMPOSTOS?\s+(S\/?|SOBRE\s+|INCIDENTES?\s+)/;
// \bNAO GANHOS\b entrou na REDUTORA em vez de tirar \bGANHOS?\b da receita
// (19/08/2026): "PRÊMIOS NÃO GANHOS" é constituição de PPNG — dedução de
// prêmio — mas tirar GANHOS deixava "PRÊMIOS GANHOS" (R$ 271.461.440,53 na
// seguradora do corpus) MUDO, herdando débito e entrando NEGATIVO. Trocar uma
// família grande de receita por duas linhas ambíguas seria péssimo negócio.
const LEX_RECEITA =
  /\bRECEITAS?\b|\bRENDIMENTOS?\b|\bRENDTO|\bFATURAMENTO\b|\bVENDAS?\b|\bSOBRAS?\b|\bRECUPERAC|\bSUBVENC|\bDESCONTOS?\s+OBTIDOS?\b|\bGANHOS?\b|\bREVERS(AO|OES)\b|\bSUPERAVITS?\b/;
const LEX_GASTO =
  /\bDESPESAS?\b|\bCUSTOS?\b|\bGASTOS?\b|\bPERDAS?\b|\bIMPOSTOS?\b|\bTRIBUTOS?\b|\bTRIBUTARI|\bPROVIS(AO|OES)\b|\bENCARGOS?\b|\bDEFICITS?\b/;

export function naturezaPeloNome(nome: string): "D" | "C" | null {
  const n = normalizar(nome).replace(RE_INCIDENCIA, " ");
  if (LEX_REDUTORA.test(n)) return "D";
  const receita = LEX_RECEITA.test(n);
  const gasto = LEX_GASTO.test(n);
  if (receita && gasto) return null; // contradição: o pai decide
  if (receita) return "C";
  if (gasto) return "D";
  return null;
}

/**
 * A IMPRESSÃO DIGITAL DA CONTA ENCERRADA: zerada nos dois retratos E com as
 * duas colunas de movimento iguais. É o gate do degrau 3 — as contas de herança
 * documentadas no cabeçalho (Belagro, saldo ≠ 0) não passam por aqui.
 */
const contaEncerrada = (l: LinhaBalancete): boolean =>
  Math.abs(l.saldoAtual) <= TOLERANCIA && Math.abs(l.saldoAnterior) <= TOLERANCIA && l.debito === l.credito;

// ── árvore com naturezas resolvidas ──────────────────────────────────────────

export interface No { linha: LinhaBalancete; filhos: No[] }

export interface ArvoreBalancete {
  grupos: Array<{ no: No; tipo: TipoGrupo }>;
  /** Natureza EFETIVA do saldo atual de cada linha (D = devedor, C = credor). */
  naturezas: Map<LinhaBalancete, "D" | "C">;
  /** Natureza efetiva do saldo ANTERIOR (pode divergir se o saldo trocou de lado). */
  naturezasAnterior: Map<LinhaBalancete, "D" | "C">;
}

/** Segmentos do código com o zero à esquerda normalizado: "01.1" → ["1","1"]. */
const segmentosDeCodigo = (cls: string): string[] =>
  cls.split(".").map((s) => s.replace(/^0+(?=\d)/, ""));

/**
 * Um código é ANCESTRAL do outro? Duas réguas, e a segunda existe por documento
 * real:
 *
 *   1) prefixo de TEXTO — a régua histórica, validada no corpus: "1.1" ⊂
 *      "1.1.2", Protheus "1.1.1" ⊂ "1.1.11", corrida "11211" ⊂ "11211001".
 *
 *   2) prefixo de SEGMENTOS com o zero à esquerda normalizado. O MESMO
 *      documento pode imprimir o nível 1 SEM zero e os filhos COM: o
 *      "Balancete - Belagro - 12.2025_Auditado" traz "1 ATIVO" seguido de
 *      "01.1 ATIVO CIRCULANTE" (os outros três balancetes da mesma empresa
 *      trazem "01"). Só com a régua de texto, "01.1".startsWith("1") é falso: a
 *      raiz vira FOLHA SOLTA ao lado dos próprios filhos e o Ativo entra DUAS
 *      vezes na base.
 *
 *      E o pior: a duplicação é SIMÉTRICA, então nenhuma prova reclama. No
 *      caso Belagro (17/08/2026) P0/P2/P3 saíram verdes com Ativo
 *      R$ 242.398.476,82 no lugar de R$ 121.199.238,41 e lucro de
 *      R$ 15.266.184,78 no lugar de R$ 7.633.092,39 — exatamente o dobro dos
 *      dois. Prova que não pode falhar não protege ninguém.
 */
export function codigoEhAncestral(pai: string, filho: string): boolean {
  if (filho.length > pai.length && filho.startsWith(pai)) return true;
  const p = segmentosDeCodigo(pai), f = segmentosDeCodigo(filho);
  return f.length > p.length && p.every((s, i) => s === f[i]);
}

/**
 * Floresta por prefixo de código (ver `codigoEhAncestral`): um nó é filho do
 * último nó anterior que seja seu ancestral. Documentos reais imprimem pais
 * antes dos filhos.
 */
export function montarArvore(linhas: LinhaBalancete[]): No[] {
  const raizes: No[] = [];
  const pilha: No[] = [];
  for (const linha of linhas) {
    const no: No = { linha, filhos: [] };
    while (pilha.length && !codigoEhAncestral(pilha[pilha.length - 1].linha.classificacao, linha.classificacao)) {
      pilha.pop();
    }
    if (pilha.length === 0) raizes.push(no);
    else pilha[pilha.length - 1].filhos.push(no);
    pilha.push(no);
  }
  return raizes;
}

export function folhasDe(no: No): LinhaBalancete[] {
  if (no.filhos.length === 0) return [no.linha];
  return no.filhos.flatMap(folhasDe);
}

function ultimaFolhaNo(no: No): No {
  return no.filhos.length ? ultimaFolhaNo(no.filhos[no.filhos.length - 1]) : no;
}

/** Monta a floresta, resolve naturezas (equação→sufixo→herança) e repara dupla contagem. */
export function prepararArvore(b: BalanceteParseado): ArvoreBalancete {
  const raizes = montarArvore(b.linhas);
  const grupos = raizes.map((r) => ({ no: r, tipo: tipoDoGrupo(r.linha.nome, folhasDe(r)) }));

  const naturezas = new Map<LinhaBalancete, "D" | "C">();
  const naturezasAnterior = new Map<LinhaBalancete, "D" | "C">();

  const resolver = (l: LinhaBalancete, herdada: "D" | "C", campo: "saldoAtual" | "saldoAnterior", permiteNome: boolean): { natureza: "D" | "C"; convencao: "D" | "C" } => {
    const saldo = l[campo];
    const sufixo = campo === "saldoAtual" ? l.naturezaAtual : l.naturezaAnterior;
    const eq = convencaoImpressao(l);
    if (eq) return { natureza: saldo < 0 ? opor(eq) : eq, convencao: eq };
    if (sufixo) return { natureza: sufixo, convencao: saldo < 0 ? opor(sufixo) : sufixo };
    // NOME DA PRÓPRIA CONTA, só na conta ENCERRADA (ver `naturezaPeloNome`).
    // Devolver `convencao: porNome` — e não a herdada — é o que faz o nó RESETAR
    // a própria subárvore: sem isso, "RECEITAS FINANCEIRAS" (R$ 359.540,90 no
    // IAOCP) continuaria entrando com a convenção devedora do avô "DESPESAS C/
    // ATIVIDADE FIM", e as folhas dela junto.
    if (permiteNome && contaEncerrada(l)) {
      const porNome = naturezaPeloNome(l.nome);
      if (porNome) return { natureza: porNome, convencao: porNome };
    }
    // herança da convenção de impressão do pai × sinal do saldo
    const saldoRef = Math.abs(saldo) > TOLERANCIA ? saldo : (campo === "saldoAtual" ? l.saldoAnterior : l.saldoAtual);
    if (Math.abs(saldoRef) > TOLERANCIA || l.debito === l.credito) {
      return { natureza: saldoRef < 0 ? opor(herdada) : herdada, convencao: herdada };
    }
    // último recurso: direção do movimento
    return { natureza: l.credito > l.debito ? "C" : "D", convencao: herdada };
  };

  /**
   * SUBÁRVORE INTEIRAMENTE ENCERRADA — trava PREVENTIVA (19/08/2026).
   *
   * O degrau do nome RESETA a convenção da subárvore. Num documento CORRENTE
   * pode existir nó sintético zerado com D == C (conta de trânsito, grupo
   * aberto e fechado no período) cujos FILHOS têm saldo — e ali o reset viraria
   * o sinal de contas que nada tinham de ambíguo. Exigir que TODA a subárvore
   * esteja encerrada resolve sem caso especial: no balancete de encerramento é
   * sempre verdade (a apuração zerou tudo), e no corrente o nó de trânsito é
   * barrado porque seus filhos têm saldo.
   *
   * HONESTIDADE SOBRE A MEDIÇÃO: no acervo de hoje esta trava não muda um
   * número — nenhum documento corrente do corpus tem nó de resultado nesse
   * estado. Ela entrou por prevenção, e o teste que a cobre é sintético ("nó
   * zerado com D == C mas FILHOS COM SALDO", em bancada-iaocp.test.ts). Uma
   * versão anterior deste comentário citava 13 linhas do OCEANDROP: aquilo era
   * fantasma do comparador do A/B, que chaveava seção por NOME num documento
   * com 17 nomes repetidos. Diferença posicional real: zero.
   */
  const subarvoreEncerrada = new Map<No, boolean>();
  const marcarEncerrada = (no: No): boolean => {
    // Sem `every`: ele CURTO-CIRCUITA no primeiro filho falso e os irmãos
    // seguintes ficariam de fora do mapa — a regra passaria a depender da ordem
    // de impressão do documento.
    let filhosEncerrados = true;
    for (const f of no.filhos) if (!marcarEncerrada(f)) filhosEncerrados = false;
    const v = contaEncerrada(no.linha) && filhosEncerrados;
    subarvoreEncerrada.set(no, v);
    return v;
  };
  for (const g of grupos) marcarEncerrada(g.no);

  const atribuir = (no: No, herdada: "D" | "C", permiteNome: boolean): void => {
    const nome = permiteNome && subarvoreEncerrada.get(no) === true;
    const atual = resolver(no.linha, herdada, "saldoAtual", nome);
    naturezas.set(no.linha, atual.natureza);
    naturezasAnterior.set(no.linha, resolver(no.linha, herdada, "saldoAnterior", nome).natureza);
    for (const f of no.filhos) atribuir(f, atual.convencao, permiteNome);
  };
  for (const g of grupos) {
    const n = normalizar(g.no.linha.nome);
    const semente: "D" | "C" =
      g.tipo === "ativo" ? "D" :
      g.tipo === "passivo" ? "C" :
      /RECEITA|RENDIMENTO|FATURAMENTO/.test(n) ? "C" : "D";
    // O degrau do NOME vale só em grupo de RESULTADO. No balanço a semente
    // (ativo D · passivo/PL C) é confiável e o nome não acrescenta — mas um nó
    // sintético zerado com D == C cujo nome fala ("Receitas Antecipadas" no
    // passivo, "Adiantamentos" no ativo) resetaria a convenção de FILHOS COM
    // SALDO e viraria uma subárvore inteira em silêncio. Risco sem ganho.
    atribuir(g.no, semente, g.tipo === "resultado");
  }

  // saldo real assinado (devedor positivo) — base da identidade pai = Σ filhos
  const real = (l: LinhaBalancete): number =>
    (naturezas.get(l) === "D" ? 1 : -1) * Math.abs(l.saldoAtual);

  // Reparo de dupla contagem (Protheus): cauda de irmãos soltos cuja soma
  // bate ao centavo com a última folha da subárvore do irmão anterior E que
  // zera a divergência do pai → re-aninha sob aquela folha.
  const reparar = (no: No): void => {
    for (const f of no.filhos) reparar(f);
    if (no.filhos.length < 2 || no.filhos.length > 300) return;
    const alvo = real(no.linha);
    const soma = no.filhos.reduce((s, f) => s + folhasDe(f).reduce((x, l) => x + real(l), 0), 0);
    if (Math.abs(soma - alvo) <= TOLERANCIA) return;
    for (let i = 1; i < no.filhos.length; i++) {
      const hospedeiro = ultimaFolhaNo(no.filhos[i - 1]);
      if (hospedeiro.filhos.length) continue;
      let somaRun = 0;
      for (let j = i; j < no.filhos.length; j++) {
        somaRun += folhasDe(no.filhos[j]).reduce((x, l) => x + real(l), 0);
        if (
          Math.abs(somaRun - real(hospedeiro.linha)) <= TOLERANCIA &&
          Math.abs(soma - somaRun - alvo) <= TOLERANCIA
        ) {
          hospedeiro.filhos.push(...no.filhos.slice(i, j + 1));
          no.filhos.splice(i, j - i + 1);
          return;
        }
      }
    }
  };
  for (const g of grupos) reparar(g.no);

  return { grupos, naturezas, naturezasAnterior };
}

// ── datas ────────────────────────────────────────────────────────────────────

function diaAnterior(ddmmaaaa: string): string | null {
  const m = ddmmaaaa.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  d.setDate(d.getDate() - 1);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

/**
 * MESCLA NA LEITURA (2026-07-18): as árvores dos balancetes ficam em
 * `arvoresBalancete` (lista própria, para o /refold re-dobrar cada mês). Quem
 * CONSOME a árvore original — auditoria do IBR e "Documento original da empresa"
 * do Valuation — lê `arvoreOriginalBP/DRE`. Este helper une as duas visões SEM
 * persistir (persistir faria o refold dobrar os meses duas vezes).
 *
 * Helper ÚNICO porque a mescla já precisou existir em dois endpoints e divergiu:
 * o Valuation lia direto do banco e mostrava a aba vazia para IBR de balancete.
 */
export function mesclarArvoresBalancete<
  T extends { arvoreOriginalBP?: unknown; arvoreOriginalDRE?: unknown; arvoresBalancete?: unknown },
>(dados: T): T {
  const arv = Array.isArray(dados?.arvoresBalancete) ? (dados.arvoresBalancete as Array<Record<string, any>>) : [];
  if (arv.length === 0) return dados;
  const bp: Record<string, unknown> = { ...((dados.arvoreOriginalBP as Record<string, unknown>) ?? {}) };
  const dre: Record<string, unknown> = { ...((dados.arvoreOriginalDRE as Record<string, unknown>) ?? {}) };
  // A FOTO PRÓPRIA MANDA (31/07/2026): cada balancete produz DUAS fotos — o mês
  // corrente (saldoAtual) e o mês ANTERIOR (saldoAnterior). Sem esta ordem, a
  // foto "anterior" de um mês posterior podia OCUPAR a chave de um mês que tem
  // documento próprio (o primeiro a chegar vencia) — e a auditoria mostrava o
  // mês inteiro sem destino, porque só a foto corrente é dobrada (caso Belagro:
  // fevereiro exibido a partir do saldo anterior do balancete de março).
  // As árvores ANUAIS (BP/DRE) seguem intocadas — elas mandam sobre o balancete.
  const anuaisBP = new Set(Object.keys(bp));
  const anuaisDRE = new Set(Object.keys(dre));
  for (const ab of arv) {
    const proprio = String(ab?.periodo ?? "");
    if (!proprio) continue;
    for (const [p, v] of Object.entries(ab?.arvoreBP ?? {})) if (p === proprio && !anuaisBP.has(p)) bp[p] = v;
    for (const [p, v] of Object.entries(ab?.arvoreDRE ?? {})) if (p === proprio && !anuaisDRE.has(p)) dre[p] = v;
  }
  // Só então o saldo anterior preenche os meses ÓRFÃOS (sem documento próprio) —
  // ex.: o mês de abertura da série, que só existe como coluna do mês seguinte.
  for (const ab of arv) {
    for (const [p, v] of Object.entries(ab?.arvoreBP ?? {})) if (!bp[p]) bp[p] = v;
    for (const [p, v] of Object.entries(ab?.arvoreDRE ?? {})) if (!dre[p]) dre[p] = v;
  }
  if (Object.keys(bp).length) (dados as { arvoreOriginalBP?: unknown }).arvoreOriginalBP = bp;
  if (Object.keys(dre).length) (dados as { arvoreOriginalDRE?: unknown }).arvoreOriginalDRE = dre;
  return dados;
}

/**
 * DRE MENSALIZADA NA LEITURA (01/08/2026 — pedido do usuário: "no balancete a
 * DRE é acumulada do ano e a tela precisa do resultado do mês").
 *
 * O mês vindo de balancete carrega a DRE ACUMULADA do exercício (YTD, período
 * "01/01 a fim do mês") — é fiel ao documento e continua sendo o que fica
 * GRAVADO. O mês ISOLADO é derivado aqui, na leitura: YTD(mês) − YTD(mês
 * anterior), quando o mês anterior do MESMO exercício existe na série (também
 * vindo de balancete). Janeiro (ou o 1º mês da janela do doc) já é o próprio
 * mês. Sem o mês anterior, não há como isolar — o período fica marcado como
 * acumulado e a tela mostra o rótulo.
 *
 * Mesmo padrão do mesclarArvoresBalancete: derivado a cada GET, nunca
 * persistido (o refold/process re-dobra as árvores e o derivado acompanha).
 */
export interface DREMensal {
  /** Por período ACUMULADO (dd/mm/aaaa): desde quando acumula e se o mês pôde ser isolado. */
  periodos: Record<string, { desde: string; mesIsolado: boolean; anterior?: string }>;
  /** conta → período → valor DO MÊS (só para períodos com mesIsolado). */
  valores: Record<string, Record<string, number>>;
}

/**
 * Períodos cuja DRE de fato ACUMULA no exercício — a mesma régra que
 * `derivarDREMensal` usa, exposta para quem precisa só da lista (o Fluxo de
 * Caixa indireto). NÃO é "a lista de balancetes": duas colunas de balancete
 * podem não acumular.
 *
 *  · EXERCÍCIO ENCERRADO não acumula (03/08/2026, caça de regressão): no mês de
 *    encerramento a apuração zera as contas de resultado e `paraDREItem` passa a
 *    usar o MOVIMENTO da janela — o valor já é do período. Subtrair o mês
 *    anterior inventa prejuízo com o selo dizendo "provado ao centavo".
 *  · JANEIRO não acumula: YTD = o próprio mês, não há o que derivar.
 *  · Coluna cuja DRE não foi PUBLICADA (reprovada na prova do PL) não entra:
 *    o valor lido seria 0 e a subtração viraria prejuízo do tamanho do ano.
 */
export function periodosQueAcumulam(dados: {
  dre?: Array<{ conta: string; valores?: Record<string, number> }>;
  balancetes?: unknown;
  arvoresBalancete?: unknown;
}): string[] {
  const bals = Array.isArray(dados?.balancetes) ? [...(dados.balancetes as Array<Record<string, any>>)] : [];
  const arvores = Array.isArray(dados?.arvoresBalancete) ? (dados.arvoresBalancete as Array<Record<string, any>>) : [];
  for (const ab of arvores) {
    const p = String(ab?.periodo ?? "");
    if (p && !bals.some((b) => String(b?.periodo ?? "") === p)) bals.push({ periodo: p });
  }
  const dre = Array.isArray(dados?.dre) ? dados.dre : [];
  // MATERIAL, nao apenas presente: `0` e' number e passava na guarda, entao a
  // exclusao de "DRE nao publicada" nunca disparava — coluna recusada entrava
  // como acumulada e o FC subtraia 0 menos o YTD anterior (prejuizo fabricado).
  const temValor = (p: string) => dre.some((l) => {
    const v = l?.valores?.[p];
    return typeof v === "number" && Number.isFinite(v) && Math.abs(v) >= 0.005;
  });
  const out: string[] = [];
  for (const b of bals) {
    const p = String(b?.periodo ?? "");
    const m = p.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m || b?.erro) continue;
    if (b?.provas?.exercicioEncerrado === true) continue; // movimento, não YTD
    // JANEIRO ENTRA. Ele acumula (YTD jan = jan) e excluí-lo movia o defeito de
    // mês em vez de matá-lo: sem janeiro na lista, FEVEREIRO perdia o par
    // `mesmoAcumulado` e o FC usava o YTD de 2 meses como resultado do mês —
    // plug de −R$ 1.263.579 onde o certo é −R$ 107.151, e o excesso era, ao
    // centavo, o lucro YTD de janeiro. A virada de exercício já é barrada pela
    // guarda de mesmo ano no consumidor, não por esta lista.
    if (!temValor(p)) continue;                           // DRE não publicada
    out.push(p);
  }
  return out;
}

/**
 * Períodos que cobrem o EXERCÍCIO INTEIRO (01/01 a 31/12) — a base de comparação
 * anual. Pergunta DIFERENTE de `periodosQueAcumulam`, e é por isso que existe.
 *
 * O erro que motivou (18/08/2026): `proporcionalidade` e `valor-na-mesa`
 * procuravam o exercício fechado pela AUSÊNCIA na lista de acumulados. Só que
 * 31/12 é as duas coisas ao mesmo tempo — acumulado (é o YTD de 12 meses) E
 * fechado. Estar na primeira lista o eliminava da segunda, e a comparação caía
 * para o exercício ANTERIOR: na Belagro, contra 2024 em vez de 2025, o que
 * acusava receita e custo de fora do ritmo quando estavam no ritmo, e derrubava
 * a base da alavanca de margem de R$ 741,1 mi para R$ 592,0 mi.
 *
 * Regra: rótulo anual ("2024") sempre; coluna de 31/12 SALVO prova em contrário.
 *
 * A prova em contrário é `periodoInicio` declarado e diferente de 01/01 — um
 * balancete "01/12 a 31/12" é um MÊS e viraria denominador anual (medido: ritmo
 * de 11,61× contra 0,97×). Mas EXIGIR a prova positiva era pior: `periodoInicio`
 * nem sempre é persistido (as árvores de balancete não o carregam), e sem ele o
 * sistema perdia a referência anual inteira e caía calado na extrapolação —
 * publicando "não há exercício fechado na série" para uma empresa com dois
 * exercícios fechados na base. Errar aceitando um dezembro-de-um-mês custa uma
 * comparação torta; errar recusando custa a comparação inteira.
 *
 * Nunca se INFERE "fechado" por ausência em outra lista: 31/12 é acumulado E
 * fechado, e a inferência derrubava a régua para o exercício anterior.
 */
export function periodosDeExercicioFechado(dados: {
  periodos?: string[];
  balancetes?: unknown;
  arvoresBalancete?: unknown;
}): string[] {
  const periodos = Array.isArray(dados?.periodos) ? dados.periodos : [];
  const bals = Array.isArray(dados?.balancetes) ? (dados.balancetes as Array<Record<string, any>>) : [];
  const arvores = Array.isArray(dados?.arvoresBalancete) ? (dados.arvoresBalancete as Array<Record<string, any>>) : [];
  const doBalancete = new Map<string, Record<string, any>>();
  for (const b of [...bals, ...arvores]) {
    const p = String(b?.periodo ?? "");
    if (p && !doBalancete.has(p)) doBalancete.set(p, b);
  }
  return periodos.filter((p) => {
    const m = String(p).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return /^\s*\d{4}\s*$/.test(String(p)); // rótulo anual puro
    if (Number(m[2]) !== 12) return false;            // só dezembro fecha o ano
    const inicio = String(doBalancete.get(String(p))?.periodoInicio ?? "");
    if (!inicio) return true;                         // sem janela declarada: 31/12 é o exercício
    return /^01\/01\//.test(inicio);                  // declarada: só vale se cobre o ano
  });
}

export function derivarDREMensal(dados: {
  dre?: Array<{ conta: string; valores?: Record<string, number> }>;
  balancetes?: unknown;
  arvoresBalancete?: unknown;
}): DREMensal | null {
  // DUAS fontes para a lista de meses-de-balancete, unidas: `balancetes`
  // (traz periodoInicio quando o cache o tem) e `arvoresBalancete` (sempre
  // presente quando há mês de balancete — é dela que a auditoria vive). Cache
  // antigo pode ter a primeira incompleta; a segunda garante os meses.
  const bals = Array.isArray(dados?.balancetes) ? [...(dados.balancetes as Array<Record<string, any>>)] : [];
  const arvores = Array.isArray(dados?.arvoresBalancete) ? (dados.arvoresBalancete as Array<Record<string, any>>) : [];
  for (const ab of arvores) {
    const p = String(ab?.periodo ?? "");
    if (p && !bals.some((b) => String(b?.periodo ?? "") === p)) bals.push({ periodo: p });
  }
  const dre = Array.isArray(dados?.dre) ? dados.dre : [];
  if (bals.length === 0 || dre.length === 0) return null;

  const dataDe = (s: string): Date | null => {
    const m = (s ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
  };
  const fmtData = (d: Date): string =>
    `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

  // TODOS os meses de balancete entram no encadeamento. O critério de
  // "acumulado" é CONTÁBIL, não a janela declarada no cabeçalho: conta de
  // RESULTADO carrega saldo acumulado do exercício até o encerramento anual —
  // o balancete "01/05 a 31/05" (caso real Belagro) descreve a janela do
  // MOVIMENTO (débitos/créditos), mas a coluna de saldo das contas de
  // resultado é YTD desde 01/01 do mesmo jeito. É o mesmo conceito que os
  // indicadores sempre usaram (periodosYTD, sem olhar a janela). Logo: DRE de
  // mês de balancete acumula desde 01/01 do exercício, SEMPRE; janeiro é o
  // único mês em que YTD = mês (nada a derivar).
  const mesesBalancete = new Map<string, { desde: string; inicio: Date; fim: Date; acumula: boolean }>();
  for (const b of bals) {
    if (b?.erro || !b?.periodo) continue;
    const fim = dataDe(String(b.periodo));
    if (!fim) continue;
    // EXERCÍCIO ENCERRADO NÃO É YTD (03/08/2026 — caça de regressão). No mês de
    // encerramento a apuração ZERA as contas de resultado e a conversão passa a
    // usar o MOVIMENTO da janela (ver `paraDREItem`, ramo `encerrado`): o valor
    // já é do período, não acumulado. Subtrair o YTD do mês anterior dava
    // resultado NEGATIVO na tela (dezembro 1.000 − novembro 11.000 = −10.000)
    // com o selo dizendo "provado ao centavo".
    if (b?.provas?.exercicioEncerrado === true) {
      const inicioDecl = b.periodoInicio ? dataDe(String(b.periodoInicio)) : null;
      const desdeDecl = b.periodoInicio ? String(b.periodoInicio) : `01/01/${fim.getFullYear()}`;
      mesesBalancete.set(String(b.periodo), { desde: desdeDecl, inicio: inicioDecl ?? dataDe(`01/01/${fim.getFullYear()}`)!, fim, acumula: false });
      continue;
    }
    const desde = `01/01/${fim.getFullYear()}`;
    const inicio = dataDe(desde)!;
    mesesBalancete.set(String(b.periodo), { desde, inicio, fim, acumula: fim.getMonth() > 0 });
  }
  const acumulados = [...mesesBalancete.entries()].filter(([, v]) => v.acumula);
  if (acumulados.length === 0) return null;

  const out: DREMensal = { periodos: {}, valores: {} };
  for (const [periodo, info] of acumulados) {
    // Mês anterior DO MESMO exercício acumulado: último dia do mês anterior ao
    // fim, presente na série como mês de balancete com o MESMO início de
    // janela (o YTD dele é o minuendo da subtração).
    const fimAnterior = new Date(info.fim.getFullYear(), info.fim.getMonth(), 0);
    const chaveAnterior = fmtData(fimAnterior);
    const anterior = mesesBalancete.get(chaveAnterior);
    const encadeia = !!anterior && anterior.desde === info.desde;
    if (!encadeia || fimAnterior < info.inicio) {
      out.periodos[periodo] = { desde: info.desde, mesIsolado: false };
      continue;
    }
    out.periodos[periodo] = { desde: info.desde, mesIsolado: true, anterior: chaveAnterior };
    for (const linha of dre) {
      const ytd = linha?.valores?.[periodo];
      const ytdAnt = linha?.valores?.[chaveAnterior];
      if (typeof ytd !== "number" && typeof ytdAnt !== "number") continue;
      const mes = Math.round(((ytd ?? 0) - (ytdAnt ?? 0)) * 100) / 100;
      (out.valores[linha.conta] ??= {})[periodo] = mes;
    }
  }
  // JANELA DE UM MES JA' E' O MES — nao ha o que derivar. O comentario la' em
  // cima ja' dizia isso de janeiro ("YTD = mes"), mas janeiro nunca era
  // REGISTRADO em `out.periodos`: quem consome nao conseguia distinguir "esta
  // coluna JA' e' o mes" de "nao da' para isolar este mes". Consequencia vista
  // na tela (dono, 20/08/2026): o seletor oferecia "01/2026 -> 02/2026" e o
  // motor respondia "falta o mes anterior na serie para isolar o resultado do
  // mes" — e o bloco inteiro de pontes sumia.
  // Vale para os dois casos de `acumula: false` cuja janela cobre um mes so':
  // janeiro de uma serie acumulada (01/01 a 31/01) e balancete de encerramento
  // que declara janela mensal (01/12 a 31/12). Encerramento ANUAL (01/01 a
  // 31/12) tem janela de doze meses e continua de fora, como deve.
  for (const [periodo, info] of mesesBalancete) {
    if (out.periodos[periodo]) continue;
    const umMesSo =
      info.inicio.getDate() === 1 &&
      info.inicio.getMonth() === info.fim.getMonth() &&
      info.inicio.getFullYear() === info.fim.getFullYear();
    if (!umMesSo) continue;
    out.periodos[periodo] = { desde: info.desde, mesIsolado: true };
    for (const linha of dre) {
      const v = linha?.valores?.[periodo];
      if (typeof v === "number") (out.valores[linha.conta] ??= {})[periodo] = v;
    }
  }

  return Object.keys(out.periodos).length ? out : null;
}

// ── conversão principal ──────────────────────────────────────────────────────

export function converterBalancete(b: BalanceteParseado): ConversaoBalancete {
  const avisos = [...b.avisos];
  const periodoBP = b.periodoFim ?? "";
  const periodoBPAnterior = b.periodoInicio ? diaAnterior(b.periodoInicio) : null;

  const { grupos, naturezas, naturezasAnterior } = prepararArvore(b);

  const naturezaDe = (l: LinhaBalancete, campo: "saldoAtual" | "saldoAnterior"): "D" | "C" =>
    (campo === "saldoAtual" ? naturezas.get(l) : naturezasAnterior.get(l)) ?? "D";

  /** Saldo assinado para a DRE: receita (C) positiva, custo/despesa (D) negativa. */
  const assinadoDRE = (l: LinhaBalancete, campo: "saldoAtual" | "saldoAnterior"): number =>
    (naturezaDe(l, campo) === "C" ? 1 : -1) * Math.abs(l[campo]);

  /** Saldo assinado PATRIMONIAL: no lado natural positivo, redutora negativa. */
  const assinadoBP = (l: LinhaBalancete, ladoAtivo: boolean, campo: "saldoAtual" | "saldoAnterior"): number =>
    (naturezaDe(l, campo) === (ladoAtivo ? "D" : "C") ? 1 : -1) * Math.abs(l[campo]);

  // ── GRUPO-ESPELHO: raiz que é CIRCUITO FECHADO, não demonstração ──────────
  // Caso Budel (03/08/2026). O plano de contas traz uma raiz "4 CENTRO DE
  // CUSTOS" que espelha os custos operacionais e devolve tudo por uma
  // contrapartida ("TRANSFERÊNCIAS"). O total da raiz é zero nos dois retratos,
  // então ela não move resultado nenhum — mas, foldada, DOBRA o custo da DRE e
  // inventa uma receita do tamanho da contrapartida: no Budel, R$ 34.497.458,97
  // apareceram como "Outras Receitas Operacionais" (a verdade do grupo 33 é
  // R$ 7.015,20). O fechamento PASSAVA e a análise mentia.
  //
  // A regra sai da ARITMÉTICA, nunca do nome — "TRANSFERÊNCIAS" varia por
  // sistema contábil. São QUATRO condições, e cada uma existe por um
  // contraexemplo medido em documento real:
  //   1) a raiz zera no saldo ATUAL e no ANTERIOR;
  //   2) há movimento de verdade dentro dela — senão um período sem lançamento
  //      zeraria tudo e o grupo inteiro sumiria;
  //   3) restam ≥2 contas VIVAS **que carregam o movimento do grupo** — o saldo
  //      vivo tem de ser fração material do que passou por lá. É isto que separa
  //      espelho de EXERCÍCIO ENCERRADO. "Ter 2 contas vivas" sozinho NÃO basta:
  //      a revisão adversarial mediu que em "Balancete de encerramento 2023.xlsx"
  //      bastaria uma reclassificação de R$ 0,06 entre duas contas irmãs para a
  //      raiz "3 CONTAS DE RESULTADO" (544 folhas, R$ 834 milhões de DRE) virar
  //      "espelho" e a DRE inteira sumir COM SELO VERDE. No encerramento as 542
  //      folhas mortas carregam todo o movimento e as vivas carregam centavos
  //      (razão ~7e-11); no espelho as folhas vivas SÃO as que movimentam
  //      (razão ~1). 31 raízes do corpus passam nas outras condições e só
  //      escapam por aqui;
  //   4) a soma ASSINADA das folhas também é zero. Raiz que zera com folhas que
  //      NÃO zeram é DEFEITO DE LEITURA, não espelho — e tem de continuar dentro
  //      da prova de fechamento para o motor recusar o selo em vez de esconder
  //      o erro. É esta condição que garante que excluir o grupo NÃO enfraquece
  //      P2: o que sai soma zero, então resultadoAcumulado e delta não se movem.
  const gruposExcluidos: Array<{ nome: string; contas: number; movimento: number }> = [];
  for (const g of grupos) {
    if (g.tipo !== "resultado") continue;
    if (Math.abs(g.no.linha.saldoAtual) > TOLERANCIA) continue;
    if (Math.abs(g.no.linha.saldoAnterior) > TOLERANCIA) continue;
    const folhas = folhasDe(g.no);
    const movimento = folhas.reduce((s, f) => s + Math.abs(f.debito) + Math.abs(f.credito), 0);
    if (movimento <= TOLERANCIA) continue;
    const vivas = folhas.filter((f) => Math.abs(f.saldoAtual) > TOLERANCIA);
    if (vivas.length < 2) continue;
    // As contas vivas têm de CARREGAR o movimento (ver condição 3): no espelho
    // a razão é ~1; num exercício encerrado com resíduo de centavos, ~1e-11.
    const saldoVivo = vivas.reduce((s, f) => s + Math.abs(f.saldoAtual), 0);
    if (saldoVivo < 0.05 * movimento) continue;
    if (Math.abs(arred(folhas.reduce((s, f) => s + assinadoDRE(f, "saldoAtual"), 0))) > TOLERANCIA) continue;
    g.tipo = "espelho";
    gruposExcluidos.push({ nome: g.no.linha.nome, contas: folhas.length, movimento: arred(movimento) });
  }

  // SUPRESSÃO EXIGE QUE A DEMONSTRAÇÃO CONTINUE EXISTINDO (13/08/2026, caso
  // Clorofila). O balancete pós-encerramento tem a assinatura aritmética EXATA
  // do espelho: raiz zera nos dois retratos e as contas se cancelam — porque o
  // resultado foi transferido ao PL por uma perna interna. Só que ali dentro
  // estava a DRE VERDADEIRA (92 contas: resultado operacional, financeiro,
  // IRPJ/CSLL) e o veto a descartou inteira; o PL mal-roteado virou "a DRE".
  // Regra nova: se o veto deixar o documento SEM NENHUM grupo de resultado, o
  // candidato a espelho volta a ser resultado — descartar a única DRE possível
  // nunca é limpeza, é mutilação. (No caso Budel, que motivou o veto, os grupos
  // de resultado reais continuavam existindo — lá o veto segue valendo.)
  if (gruposExcluidos.length > 0 && !grupos.some((g) => g.tipo === "resultado")) {
    for (const g of grupos) {
      if (g.tipo !== "espelho") continue;
      g.tipo = "resultado";
      avisos.push(
        `"${g.no.linha.nome}" tem a forma de circuito fechado, mas é o ÚNICO grupo de resultado do documento — mantido como DRE (exercício encerrado dentro do próprio grupo). A perna de encerramento é identificada por prova cruzada com o PL.`,
      );
    }
    gruposExcluidos.length = 0;
  }

  const ativos = grupos.filter((g) => g.tipo === "ativo");
  const passivos = grupos.filter((g) => g.tipo === "passivo");
  const patrimonios = grupos.filter((g) => g.tipo === "pl");
  const resultados = grupos.filter((g) => g.tipo === "resultado");
  const espelhos = grupos.filter((g) => g.tipo === "espelho");
  if (ativos.length === 0 || passivos.length === 0) {
    avisos.push("Grupos ATIVO/PASSIVO não identificados no nível 1 — verifique a extração.");
  }
  for (const e of gruposExcluidos) {
    avisos.push(
      `"${e.nome}" é um CIRCUITO FECHADO (${e.contas} contas, ${fmt(e.movimento)} de movimento): o saldo da raiz é zero no início e no fim do período e as contas dentro dela se cancelam ao centavo. É espelho gerencial de centro de custos, não demonstração — ficou FORA da DRE, senão o custo apareceria dobrado e a contrapartida viraria receita. Nenhum total mudou: o que saiu soma zero.`,
    );
  }

  // ── resultado acumulado (assinado, só folhas, sem apuração) ──
  const folhasResultado = resultados.flatMap((g) => folhasDe(g.no));
  let resultadoAcumulado = arred(folhasResultado.reduce((s, f) => s + assinadoDRE(f, "saldoAtual"), 0));

  // ── exercício encerrado: resultado zerado (apurado) e A=P ──
  const ativoAtual = arred(ativos.reduce((s, g) => s + Math.abs(g.no.linha.saldoAtual), 0));
  const passivoAtual = arred(passivos.reduce((s, g) => s + Math.abs(g.no.linha.saldoAtual), 0));
  // EXERCÍCIO ENCERRADO OLHA TODAS AS FOLHAS DE RESULTADO, ESPELHO INCLUÍDO:
  // um espelho tem contas VIVAS que se cancelam; se ele saísse desta conta, um
  // documento com espelho e resultado zerado pareceria encerrado e a DRE
  // inteira trocaria de regime (saldo → movimento, e `derivarDREMensal` junto).
  const folhasResultadoTodas = [...folhasResultado, ...espelhos.flatMap((g) => folhasDe(g.no))];
  const saldosResultadoZerados = folhasResultadoTodas.every((f) => Math.abs(f.saldoAtual) < TOLERANCIA);
  const exercicioEncerrado = saldosResultadoZerados && Math.abs(ativoAtual - passivoAtual - (patrimonios.length ? arred(patrimonios.flatMap((g) => folhasDe(g.no)).reduce((s2, f) => s2 + assinadoDRE(f, "saldoAtual"), 0)) : 0)) <= TOLERANCIA;

  // ── P2: fechamento ──
  // O PL entra ASSINADO, nunca em módulo (13/08/2026): PL devedor (prejuízo
  // acumulado maior que o capital) existe no corpus — 6 balancetes reais
  // quebraram quando o PL foi somado com Math.abs no lado passivo. A soma
  // assinada reproduz exatamente a aritmética que valia quando essas folhas
  // eram contadas no "resultado acumulado".
  const plAssinado = arred(
    patrimonios.flatMap((g) => folhasDe(g.no)).reduce((s2, f) => s2 + assinadoDRE(f, "saldoAtual"), 0));
  let delta = arred(ativoAtual - passivoAtual - plAssinado - (exercicioEncerrado ? 0 : resultadoAcumulado));

  // DESTINAÇÃO DE RESULTADO com saldo vivo (caso EXTRAMED, 01/08/2026): nos
  // sistemas do corpus original o grupo de apuração é DUPLICATA do resultado
  // (só usado no encerramento) e excluí-lo fecha o balanço. Mas há plano de
  // contas em que "CONTAS DE DESTINAÇÃO/APURAÇÃO DE RESULTADO" carrega saldo
  // pelo ano (distribuições) — aí a identidade do documento é A − P =
  // resultado + destinação(assinada). Quem decide é a EQUAÇÃO: só integra a
  // apuração quando SEM ela não fecha e COM ela fecha ao centavo.
  let apuracaoIntegrada = false;
  const apuracoes = grupos.filter((g) => g.tipo === "apuracao");
  if (!exercicioEncerrado && Math.abs(delta) > TOLERANCIA && apuracoes.length > 0) {
    const folhasApuracao = apuracoes.flatMap((g) => folhasDe(g.no));
    const apuracaoAssinada = arred(folhasApuracao.reduce((s, f) => s + assinadoDRE(f, "saldoAtual"), 0));
    const resultadoCom = arred(resultadoAcumulado + apuracaoAssinada);
    const deltaCom = arred(ativoAtual - passivoAtual - resultadoCom);
    if (Math.abs(apuracaoAssinada) > TOLERANCIA && Math.abs(deltaCom) <= TOLERANCIA) {
      resultadoAcumulado = resultadoCom;
      delta = deltaCom;
      apuracaoIntegrada = true;
      avisos.push(
        `Grupo de destinação/apuração de resultado (${fmt(apuracaoAssinada)}) integrado ao resultado acumulado — é o que fecha o balanço ao centavo neste plano de contas.`,
      );
    }
  }

  // ── P3: coerência de CADA linha (cobre as 4 colunas, não só o saldo atual) ──
  // CONTAR SEMPRE, GUARDAR ALGUMAS (03/08/2026). Antes o `push` parava em 20 e
  // `coerentes` era `total − incoerentes.length`: num documento com 234 linhas
  // quebradas a PRÓPRIA PROVA declarava "635 de 655 coerentes" e o aviso dizia
  // "20 conta(s)". O teto da amostra não pode ser a contagem — o selo e o
  // analista passam a acreditar num número que ninguém mediu.
  const incoerentes: ProvasBalancete["linhas"]["incoerentes"] = [];
  const AMOSTRA_INCOERENTES = 20;
  let totalIncoerentes = 0;
  for (const l of b.linhas) {
    const d = Math.abs(l.debito), c = Math.abs(l.credito);
    let coerente: boolean;
    if (l.naturezaAnterior && l.naturezaAtual) {
      // Natureza DECLARADA nos dois retratos: equação ÚNICA assinada (débito
      // soma). Cobre a conta que VIRA de natureza no período — começa credora
      // e termina devedora (caso EXTRAMED: −2.485.223,60 + 58.450.567,81 −
      // 54.300.432,64 = +1.664.911,57 D ✓), que as duas equações sem sinal
      // reprovariam.
      const antS = (l.naturezaAnterior === "C" ? -1 : 1) * Math.abs(l.saldoAnterior);
      const atualS = (l.naturezaAtual === "C" ? -1 : 1) * Math.abs(l.saldoAtual);
      coerente = Math.abs(antS + d - c - atualS) <= TOLERANCIA;
    } else {
      const devedora = Math.abs(l.saldoAnterior + d - c - l.saldoAtual) <= TOLERANCIA;
      const credora = Math.abs(l.saldoAnterior + c - d - l.saldoAtual) <= TOLERANCIA;
      coerente = devedora || credora;
    }
    if (coerente) continue;
    totalIncoerentes++;
    if (incoerentes.length < AMOSTRA_INCOERENTES) {
      incoerentes.push({ classificacao: l.classificacao, nome: l.nome, anterior: l.saldoAnterior, debito: l.debito, credito: l.credito, atual: l.saldoAtual });
    }
  }

  // P0 — partida dobrada sobre as FOLHAS (nó sem filho): somar sintética e
  // folha contaria o mesmo lançamento duas vezes.
  const folhasDoDoc = grupos.flatMap((g) => folhasDe(g.no));
  const somaD = arred(folhasDoDoc.reduce((s, l) => s + Math.abs(l.debito || 0), 0));
  const somaC = arred(folhasDoDoc.reduce((s, l) => s + Math.abs(l.credito || 0), 0));
  const deltaDC = arred(somaD - somaC);
  const temMovimento = somaD > TOLERANCIA || somaC > TOLERANCIA;
  const partidaDobrada = {
    debitos: somaD, creditos: somaC, delta: deltaDC, folhas: folhasDoDoc.length,
    verificavel: temMovimento,
    // Tolerância relativa mínima: documento de bilhões arredondado ao centavo
    // não pode reprovar por 1 centavo de dízima.
    ok: temMovimento ? Math.abs(deltaDC) <= Math.max(TOLERANCIA, somaD * 1e-9) : false,
  };

  const provas: ProvasBalancete = {
    partidaDobrada,
    fechamento: { ativo: ativoAtual, passivo: passivoAtual, resultadoAcumulado, delta, ok: Math.abs(delta) <= TOLERANCIA },
    linhas: { total: b.linhas.length, coerentes: b.linhas.length - totalIncoerentes, ok: totalIncoerentes === 0, incoerentes },
    exercicioEncerrado,
    ...(b.totais
      ? { debitosCreditos: { ...b.totais, ok: Math.abs(b.totais.debito - b.totais.credito) <= TOLERANCIA } }
      : {}),
  };
  if (provas.partidaDobrada.verificavel && !provas.partidaDobrada.ok) {
    avisos.push(
      `Partida dobrada não fecha nas linhas lidas: débitos ${fmt(provas.partidaDobrada.debitos)} × créditos ${fmt(provas.partidaDobrada.creditos)} ` +
      `(diferença ${fmt(provas.partidaDobrada.delta)}) em ${provas.partidaDobrada.folhas} conta(s). ` +
      `Num balancete todo lançamento tem os dois lados no próprio documento — a diferença indica linha perdida, dígito trocado ou coluna deslocada na leitura.`,
    );
  }
  if (!provas.fechamento.ok) {
    avisos.push(`Fechamento não bate: Ativo ${fmt(ativoAtual)} − Passivo ${fmt(passivoAtual)} − Resultado ${fmt(resultadoAcumulado)} = ${fmt(delta)}.`);
  }
  if (!provas.linhas.ok) {
    const ex = incoerentes[0];
    avisos.push(
      `${totalIncoerentes} de ${b.linhas.length} conta(s) não fecham na própria equação (saldo anterior + débito − crédito = saldo atual). ` +
      `Ex.: "${ex.nome}" — ${fmt(ex.anterior)} + ${fmt(ex.debito)} − ${fmt(ex.credito)} ≠ ${fmt(ex.atual)}.` +
      (totalIncoerentes > AMOSTRA_INCOERENTES ? ` (listadas as ${AMOSTRA_INCOERENTES} primeiras)` : ""),
    );
  }

  // ── BP: árvore original nos 5 GRUPOS CANÔNICOS que o fold consome ──
  // (foldBP só lê as chaves "Ativo Circulante"/"Ativo Não Circulante"/"Passivo
  // Circulante"/"Passivo Não Circulante"/"Patrimônio Líquido" — o N2 do
  // documento é classificado por nome no balde certo e entra como SUBÁRVORE:
  // o fold desce estruturalmente e classifica as folhas com o dicionário.)
  const paraBPItem = (no: No, ladoAtivo: boolean, campo: "saldoAtual" | "saldoAnterior"): BPN3Item => ({
    nome: no.linha.nome,
    valor: arred(assinadoBP(no.linha, ladoAtivo, campo)),
    ...(no.filhos.length ? { filhos: no.filhos.map((f) => paraBPItem(f, ladoAtivo, campo)) } : {}),
  });

  const baldeBP = (nome: string, ladoAtivo: boolean): string => {
    const n = normalizar(nome);
    if (!ladoAtivo && (n.includes("PATRIMONIO") || n === "PL" || /^CAPITAL|^RESERVA|LUCROS? ACUM|PREJUIZOS? ACUM/.test(n))) {
      return "Patrimônio Líquido";
    }
    const naoCirculante = /NAO[ -]?CIRCULANTE|LONGO PRAZO|PERMANENTE|IMOBILIZAD|INTANGIVE|INVESTIMENT|DIFERIDO|REALIZAVEL A LONGO|EXIGIVEL A LONGO/.test(n);
    if (naoCirculante) return ladoAtivo ? "Ativo Não Circulante" : "Passivo Não Circulante";
    return ladoAtivo ? "Ativo Circulante" : "Passivo Circulante";
  };

  const arvoreBP: ArvoreOriginalBP = {};
  const montarBPPeriodo = (campo: "saldoAtual" | "saldoAnterior", periodo: string): void => {
    const gruposBP: Record<string, BPN3Item[]> = {};
    for (const g of [...ativos, ...passivos, ...patrimonios]) {
      const ladoAtivo = g.tipo === "ativo";
      const n2s = g.no.filhos.length ? g.no.filhos : [g.no];
      for (const n2 of n2s) {
        // FILHO DE RAIZ "pl" É PATRIMÔNIO POR HERANÇA, não por nome (13/08/2026,
        // segunda rodada do caso Clorofila): "Resultados" e "Capital Realizado"
        // são filhos da raiz "Patrimonio Liquido", mas "Resultados" não casa o
        // vocabulário de PL e despencava no fallback "Passivo Circulante" — a
        // tela então sugeria "Outros Passivos Circulantes" para lucros
        // acumulados e o dropdown SÓ oferecia contas de PC (a trava de grupo
        // filtra os destinos pelo balde). Quem nasce debaixo do PL é PL.
        const balde = g.tipo === "pl" ? "Patrimônio Líquido" : baldeBP(n2.linha.nome, ladoAtivo);
        (gruposBP[balde] ??= []).push(paraBPItem(n2, ladoAtivo, campo));
      }
    }
    // AJUSTE-CHAVE: resultado do período entra no PL para o balanço fechar.
    // Com a destinação integrada (EXTRAMED), ela entra nos DOIS retratos — a
    // identidade vale igualmente na coluna do saldo anterior.
    const folhasDoResultado = apuracaoIntegrada
      ? [...folhasResultado, ...apuracoes.flatMap((g) => folhasDe(g.no))]
      : folhasResultado;
    const resultadoDoCampo = campo === "saldoAtual"
      ? resultadoAcumulado
      : arred(folhasDoResultado.reduce((s, f) => s + assinadoDRE(f, "saldoAnterior"), 0));
    if (!exercicioEncerrado && Math.abs(resultadoDoCampo) > TOLERANCIA) {
      (gruposBP["Patrimônio Líquido"] ??= []).push({
        nome: "Resultado do Período (apuração do balancete)",
        valor: resultadoDoCampo,
      });
    }
    arvoreBP[periodo] = { grupos: gruposBP };
  };
  if (periodoBP) montarBPPeriodo("saldoAtual", periodoBP);
  if (periodoBPAnterior && temSaldosAnteriores(b.linhas)) montarBPPeriodo("saldoAnterior", periodoBPAnterior);

  // ── DRE: acumulada YTD (encerrado → movimento), seções nível 2 ──
  const paraDREItem = (no: No, encerrado: boolean): DRESecaoItem => {
    const valorDe = (l: LinhaBalancete): number => {
      if (!encerrado) return assinadoDRE(l, "saldoAtual");
      // exercício encerrado: o lançamento de ENCERRAMENTO entra no movimento da
      // própria conta (débito na receita = saldo YTD transferido à apuração),
      // então c−d ≈ 0. O lado OPERACIONAL é a coluna da natureza: receita =
      // crédito acumulado, despesa = débito acumulado.
      return naturezaDe(l, "saldoAtual") === "C" ? l.credito : -l.debito;
    };
    const filhos = no.filhos
      .map((f) => paraDREItem(f, encerrado))
      .filter((f) => Math.abs(f.valor) > 0.004 || (f.filhos?.length ?? 0) > 0);
    const valor = no.filhos.length
      ? arred(filhos.reduce((s, f) => s + f.valor, 0))
      : arred(valorDe(no.linha));
    return { nome: no.linha.nome, valor, ...(filhos.length ? { filhos } : {}) };
  };

  const arvoreDRE: ArvoreOriginalDRE = {};
  if (periodoBP) {
    let secoes: DRESecaoItem[] = [];
    for (const g of resultados) {
      const base = g.no.filhos.length ? g.no.filhos : [g.no];
      for (const n2 of base) {
        const item = paraDREItem(n2, exercicioEncerrado);
        if (Math.abs(item.valor) > 0.004 || (item.filhos?.length ?? 0) > 0) secoes.push(item);
      }
    }

    // PERNA DE ENCERRAMENTO IDENTIFICADA POR PROVA CRUZADA COM O PL (13/08/2026,
    // caso Clorofila). Num grupo de resultado que FECHA EM ZERO, uma das seções
    // é a transferência do lucro para o PL — mantê-la zera a DRE inteira. Nome
    // não decide ("TRANSFERÊNCIAS" foi vetado como critério no caso Budel): a
    // perna é a seção cuja REMOÇÃO faz o restante bater, ao centavo, com o
    // "Resultado do Período" que o PRÓPRIO DOCUMENTO declara no PL. Se nenhuma
    // seção satisfaz a prova, nada é removido e o aviso fica — supressão sem
    // prova é proibida pela regra-mestra.
    const somaSecoes = arred(secoes.reduce((soma, x) => soma + x.valor, 0));
    if (secoes.length >= 2 && Math.abs(somaSecoes) <= TOLERANCIA) {
      const folhasBalanco = [...ativos, ...passivos, ...patrimonios].flatMap((g) => folhasDe(g.no));
      // A folha-âncora varia por sistema: "Resultado do Período", "Resultado
      // APURADO NO Período", "Resultado do Exercício". "Lucros/Resultados
      // ACUMULADOS" fica de fora — é estoque de anos anteriores, não o resultado
      // do período que a DRE tem de reproduzir.
      const resultadoDoPL = folhasBalanco.find((l) => {
        const nm = normalizar(l.nome);
        return /\bRESULTADO\s+(\w+\s+)?([DN][OEA]S?\s+)?(PERIODO|EXERCICIO)\b/.test(nm) && !/ACUMUL/.test(nm);
      });
      if (resultadoDoPL) {
        const alvo = arred(Math.abs(resultadoDoPL.saldoAtual));
        const perna = secoes.find((sec) => Math.abs(arred(somaSecoes - sec.valor) - (sec.valor < 0 ? alvo : -alvo)) <= TOLERANCIA
          || Math.abs(Math.abs(arred(somaSecoes - sec.valor)) - alvo) <= TOLERANCIA);
        if (perna) {
          secoes = secoes.filter((sec) => sec !== perna);
          avisos.push(
            `"${perna.nome}" (${fmt(perna.valor)}) é a perna de ENCERRAMENTO do resultado — removida da DRE por prova cruzada: sem ela, a DRE soma ${fmt(arred(secoes.reduce((soma, x) => soma + x.valor, 0)))}, idêntico ao "Resultado do Período" declarado no PL do documento (${fmt(resultadoDoPL.saldoAtual)}).`,
          );
        } else {
          avisos.push(
            `O grupo de resultado fecha em zero (exercício encerrado dentro do grupo), mas nenhuma seção isolada reproduz o Resultado do Período do PL (${fmt(resultadoDoPL.saldoAtual)}) — NADA foi removido; a DRE precisa de revisão manual.`,
          );
        }
      }
    }
    arvoreDRE[periodoBP] = secoes;

    // P4 — a DRE derivada do MOVIMENTO reconcilia com o que o PL declara?
    // Âncora: variação das contas de resultado do PL (Resultado do Exercício /
    // Lucros ou Prejuízos Acumulados) entre os dois retratos do documento.
    // Distribuição de lucro no ano mexe nessas contas sem passar pela DRE — daí
    // o limite generoso (10% da receita): a prova existe para pegar DIVERGÊNCIA
    // GROSSA (caso Belagro 2023: derivado −85,9 mi × PL +1,3 mi), não ruído.
    if (exercicioEncerrado) {
      const derivado = arred(secoes.reduce((s, x) => s + x.valor, 0));
      // A varredura fica nos grupos do BALANÇO de propósito. Um grupo tipado
      // `apuracao` casa o filtro pelo nome, mas é contra-lançamento: saldo zero
      // nos dois retratos, variação zero. Incluí-lo não daria âncora — daria
      // uma âncora FALSA de R$ 0,00, que é exatamente o que esta prova passou a
      // recusar.
      const contasResultadoPL = temSaldosAnteriores(b.linhas)
        ? [...ativos, ...passivos, ...patrimonios]
          .flatMap((g) => folhasDe(g.no))
          .filter((l) => {
            const n = normalizar(l.nome);
            // SÓ CONTA DE ESTOQUE (…ACUMULAD…). SUPERÁVIT/DÉFICIT/SOBRAS é o
            // vocabulário do TERCEIRO SETOR e da cooperativa para a mesma conta
            // (Instituto AOCP: "Superávit (Deficit) Acumulado", 2.627.046,22C →
            // 10.196.736,09C, variação 7.569.689,87).
            //
            // A CONTA "DO EXERCÍCIO" FICA DE FORA, e isso é decisão, não
            // esquecimento (revisão adversarial, 19/08/2026). Ela chegou a
            // entrar no filtro e foi RETIRADA: as duas famílias medem coisas
            // diferentes — a de estoque pela VARIAÇÃO, a do exercício pelo
            // SALDO — e somar as duas fabrica número que não existe no
            // documento. No "SABRINA - Balancete 2021" o PL declara
            // 120.382,45 em "LUCRO DO EXERCICIO" (exatamente o derivado), e a
            // soma das três folhas casadas dava 60.382,45: a distribuição de
            // lucro de R$ 60.000,00 virava "gap" e bloqueava um exercício que
            // reconcilia ao centavo. Pior, o erro é simétrico — DRE errada
            // justamente pelo valor distribuído marcaria gap zero.
            //
            // O desenho certo, para quando isto voltar (backlog): havendo folha
            // FAMÍLIA + (DO|DE) EXERCÍCIO/PERÍODO que não seja ACUMUL nem
            // destinação (`ehNomeDeDestinacao`) nem de exercício ANTERIOR, usar
            // SÓ ELA e pelo saldoAtual — a régua que a perna de encerramento já
            // usa mais abaixo — e nunca misturar com a soma de variações. Exige
            // distinguir a conta que ZERA e recarrega a cada ano da que
            // ACUMULA, que é o que falta medir.
            return ehNomeDeApuracao(n)
              || /\b(LUCROS?|PREJUIZOS?|RESULTADOS?|SUPERAVITS?|DEFICITS?|SOBRAS?)\b.*\bACUMULAD/.test(n);
          })
        : [];
      // Lucro no PL é CREDOR: usa a régua patrimonial do lado passivo, para o
      // lucro sair positivo e o prejuízo negativo.
      const declaradoPL = arred(contasResultadoPL.reduce(
        (s, l) => s + (assinadoBP(l, false, "saldoAtual") - assinadoBP(l, false, "saldoAnterior")), 0));
      const receita = arred(secoes.filter((x) => x.valor > 0).reduce((s, x) => s + x.valor, 0));
      const gap = Math.abs(arred(derivado - declaradoPL));
      // A FAIXA NÃO PODE SER CALIBRADA SÓ PELO NÚMERO AUDITADO (revisão
      // adversarial, 19/08/2026). `receita × 10%` vem da DRE DERIVADA — e a
      // transferência interna que esta prova existe para pegar infla a receita
      // e, com ela, o próprio teto: na Belagro acumulado 2023 a tolerância
      // ficava 13,6× maior que o resultado declarado pelo PL. Amarrar também na
      // ÂNCORA (25% do que o PL registra) faz a régua depender do documento, não
      // do número em julgamento. O piso de 5.000 continua para não reprovar
      // empresa pequena por ruído de arredondamento.
      const limite = Math.max(5_000, Math.min(receita * 0.1, Math.abs(declaradoPL) * 0.25));
      // ÂNCORA QUE NÃO SE MOVEU NÃO É ÂNCORA (revisão adversarial, 19/08/2026).
      // `length > 0` pergunta se a CONTA existe, não se ela MEDIU alguma coisa.
      // Com o PL registrando o ano noutra conta (ou com o lucro integralmente
      // distribuído), `declaradoPL` sai 0,00 e o P4 degenerava em "a DRE cabe
      // em 10% da receita?" — comparando a demonstração contra zero e dando
      // selo verde. Medido: 3 dos balancetes de encerramento do corpus têm
      // TODAS as âncoras casadas com variação zero. `Number.isFinite` mata
      // junto o `R$ NaN` que a Cervejaria Maniacs imprimia no aviso.
      const verificavel = contasResultadoPL.length > 0
        && Number.isFinite(declaradoPL) && Math.abs(declaradoPL) > TOLERANCIA;
      // Nomeia TODAS as contas que entraram na soma: nomear só a primeira
      // atribuía o total a uma conta que podia nem ter se movido.
      const ancora = verificavel
        ? contasResultadoPL
          .filter((l) => Math.abs(assinadoBP(l, false, "saldoAtual") - assinadoBP(l, false, "saldoAnterior")) > TOLERANCIA)
          .map((l) => l.nome).join(" + ") || contasResultadoPL[0].nome
        : null;
      const comValor = secoes.filter((x) => Math.abs(x.valor) > TOLERANCIA);
      const sinalUnico = comValor.length >= 2
        && new Set(comValor.map((x) => Math.sign(x.valor))).size === 1
        && comValor.some((x) => naturezaPeloNome(x.nome) === "C");
      const ok = verificavel && !sinalUnico && gap <= limite;
      provas.dreEncerrada = { derivado, declaradoPL, gap, limite, verificavel, ancora, sinalUnico, ok };
      if (sinalUnico) {
        avisos.push(
          `Balancete de ENCERRAMENTO: as ${comValor.length} seções da DRE saíram TODAS com o mesmo sinal (soma ${fmt(derivado)}), sendo que ao menos uma delas se declara receita. ` +
          `Não existe demonstração assim — a leitura não separou receita de gasto nas contas zeradas pelo encerramento. Esta DRE não é fato e não foi publicada.`,
        );
      } else if (!verificavel) {
        avisos.push(
          `Balancete de ENCERRAMENTO: as contas de resultado estão zeradas e a DRE foi derivada do movimento (${fmt(derivado)}), mas o documento NÃO oferece âncora para conferir — ` +
          `${!temSaldosAnteriores(b.linhas)
            ? "não há coluna de saldo anterior"
            : contasResultadoPL.length === 0
              ? "nenhuma conta de resultado acumulado foi encontrada no PL"
              : !Number.isFinite(declaradoPL)
                ? `a conta "${contasResultadoPL[0].nome}" tem saldo ilegível na leitura`
                : `a conta "${contasResultadoPL[0].nome}" existe mas NÃO se moveu no ano (variação zero), então não há o que conferir`}. ` +
          `Prova ausente não é prova: esta DRE não recebeu selo e não foi publicada. Para preencher o exercício, suba a demonstração oficial ou um balancete de dezembro ANTES do encerramento.`,
        );
      } else if (!ok) {
        avisos.push(
          `Balancete de ENCERRAMENTO: as contas de resultado estão zeradas e a DRE foi derivada do movimento — ela dá ${fmt(derivado)}, mas o resultado que o próprio PL registra no ano é ${fmt(declaradoPL)} em "${ancora}" (diferença de ${fmt(gap)}). ` +
          `Transferência interna entre contas de resultado infla os dois lados: confira a DRE deste exercício contra a demonstração oficial antes de usar os números.`,
        );
      } else if (gap > TOLERANCIA) {
        // VERDE NÃO É MUDO (revisão adversarial, 19/08/2026). Passar dentro da
        // faixa não é "bater": o IAOCP publica com R$ 846.810,30 de diferença
        // contra o próprio PL e o analista nunca via esse número. Contar o que
        // foi medido é regra da casa — inclusive quando o veredito é passar.
        avisos.push(
          `Balancete de ENCERRAMENTO conferido: a DRE derivada do movimento (${fmt(derivado)}) fica ${fmt(gap)} ${derivado < declaradoPL ? "ABAIXO" : "ACIMA"} do resultado que o PL registra no ano (${fmt(declaradoPL)} em "${ancora}") — dentro da faixa de ${fmt(arred(limite))}, então foi publicada. ` +
          `A diferença é normal quando há uso do resultado fora da DRE; se for material para a sua análise, confira contra a demonstração oficial do exercício.`,
        );
      }
    }

    // ── P5 — contra o RESUMO que o documento redeclara no rodapé ──────────────
    // Cada item só entra quando o documento declara o número: prova ausente é
    // prova ausente, nunca aprovação. Tolerância RELATIVA porque documento de
    // bilhões arredondado ao centavo não pode reprovar por uma dízima.
    if (b.resumo) {
      const itens: NonNullable<ProvasBalancete["resumoDeclarado"]>["itens"] = [];
      const conferir = (o: string, declarado: number | undefined, montado: number, alternativa?: number): void => {
        if (declarado == null || !Number.isFinite(declarado)) return;
        const gap = Math.min(
          Math.abs(arred(montado - declarado)),
          alternativa == null ? Infinity : Math.abs(arred(alternativa - declarado)),
        );
        const limite = Math.max(TOLERANCIA, Math.abs(declarado) * 1e-9);
        itens.push({ o, declarado, montado, gap, ok: gap <= limite });
      };
      conferir("Ativo", b.resumo.ativo, ativoAtual);
      // O rodapé pode contar o PL DENTRO do passivo (é filho da raiz PASSIVO em
      // muitos planos) ou fora dela. Não se sabe qual convenção o sistema usou,
      // então as duas valem — e a duplicação, que é o que esta prova existe para
      // pegar, reprova nas duas.
      //
      // O PL entra ASSINADO, como no P2 (17/08/2026, revisão adversarial). Com
      // `Math.abs`, PL DEVEDOR (prejuízos acumulados > capital, situação real em
      // 6 balancetes do corpus) somava onde a convenção do rodapé subtrai: as
      // duas leituras erravam para o mesmo lado e o documento CORRETO saía com
      // selo vermelho — e com a fixação recusada em IBR/Valuation. Falso alarme
      // é pior que prova ausente: quebra a entrega de quem não tem defeito.
      conferir("Passivo", b.resumo.passivo, passivoAtual, arred(passivoAtual + plAssinado));
      if (!exercicioEncerrado) {
        // GRUPO-ESPELHO SAI DA DRE COM RAZÃO, e o rodapé não sabe disso: o resumo
        // soma o espelho junto (é uma raiz do documento como qualquer outra), então
        // conferir receita e custo bruto daria FALSO ALARME num documento sem
        // defeito nenhum. O RESULTADO segue conferível mesmo com espelho — ele
        // soma zero, é a condição 4 do detector.
        if (espelhos.length === 0) {
          const raizesResultado = resultados.map((g) => assinadoDRE(g.no.linha, "saldoAtual"));
          conferir("Receitas", b.resumo.receitas, arred(raizesResultado.filter((v) => v > 0).reduce((s, v) => s + v, 0)));
          conferir("Custos e despesas", b.resumo.custosDespesas,
            Math.abs(arred(raizesResultado.filter((v) => v < 0).reduce((s, v) => s + v, 0))));
        }
        conferir("Resultado do período", b.resumo.resultado, arred(secoes.reduce((s, x) => s + x.valor, 0)));
      }
      if (itens.length) {
        provas.resumoDeclarado = { itens, ok: itens.every((x) => x.ok) };
        for (const x of itens.filter((y) => !y.ok)) {
          avisos.push(
            `${x.o}: o motor montou ${fmt(x.montado)}, mas o RESUMO do próprio documento declara ${fmt(x.declarado)} (diferença de ${fmt(x.gap)}). ` +
            `O resumo é o número escrito pelo contador — enquanto os dois não coincidirem, a montagem deste documento não é fato.`,
          );
        }
      }
    }
  }

  return { periodoBP, periodoBPAnterior, arvoreBP, arvoreDRE, resultadoAcumulado, provas, gruposExcluidos, avisos };
}

function temSaldosAnteriores(linhas: LinhaBalancete[]): boolean {
  return linhas.some((l) => Math.abs(l.saldoAnterior) > TOLERANCIA);
}

const arred = (n: number): number => Math.round(n * 100) / 100;
const fmt = (n: number): string => n.toLocaleString("pt-BR", { minimumFractionDigits: 2 });
