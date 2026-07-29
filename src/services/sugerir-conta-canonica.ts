/**
 * DE-PARA SUGERIDO (28/07/2026) — "faz sentido vincular a conta canônica a cada
 * conta nova? Não fica complicado para o analista?".
 *
 * Fica, se ele tiver que escolher numa lista de 40 contas a cada linha. A saída
 * é o sistema PROPOR e ele confirmar: aqui mora a regra determinística que, do
 * nome da conta do cliente ("Vale transporte", "Energia elétrica"), aponta a
 * conta canônica do modelo padrão ("Despesas com Pessoas", "Despesas com
 * Utilidades"…).
 *
 * Três camadas, da mais forte para a mais fraca — a mais forte que casar vence:
 *   1. NOME IGUAL (normalizado) a uma canônica → certeza.
 *   2. PALAVRA-CHAVE do vocabulário contábil brasileiro → alta confiança.
 *   3. Palavras em comum (Jaccard ≥ 0,5) → média confiança.
 * Nada casou = null: a conta fica sem de-para e VISÍVEL como pendência, nunca
 * chutada. Zero IA: mesma entrada, mesma saída, auditável.
 */

/** Normaliza para casar sem acento/caixa/pontuação. */
function norm(s: string): string {
  return (s || "").normalize("NFD").replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Palavras que não ajudam a distinguir conta (ruído em quase todo nome).
 *  "despesa(s)"/"custo(s)" entram aqui (28/07/2026) porque estão em QUASE TODA
 *  canônica: sem isso, "Despesas com cobrança" casava "Despesas com P&D" só
 *  pelo {despesas} — o mesmo bug já corrigido no account-mapper. */
const VAZIAS = new Set(["de", "da", "do", "das", "dos", "e", "com", "sobre", "para", "em", "a", "o", "as", "os", "the", "gerais", "geral", "diversos", "diversas", "outros", "outras", "despesa", "despesas", "custo", "custos"]);

const tokens = (s: string) => norm(s).split(" ").filter((t) => t.length > 2 && !VAZIAS.has(t));

/**
 * Vocabulário: gatilhos no nome do cliente → PISTA da conta canônica. A pista é
 * casada por substring contra as canônicas REAIS do modelo da empresa — se o
 * modelo não tiver aquela conta, a regra simplesmente não se aplica.
 */
const VOCABULARIO: Array<{ gatilhos: RegExp; pista: RegExp; porque: string }> = [
  { gatilhos: /\b(salari|ordenad|folha|encargo|inss|fgts|13|ferias|rescis|pro labore|prolabore)\w*/, pista: /pessoa|folha|salari/, porque: "remuneração e encargos" },
  { gatilhos: /\b(vale|beneficio|vr|va|vt|plano de saude|odontolog|convenio medico)\w*/, pista: /pessoa|beneficio/, porque: "benefício de pessoal" },
  { gatilhos: /\b(aluguel|condominio|iptu|locacao)\w*/, pista: /aluguel|condominio|iptu|ocupac/, porque: "ocupação" },
  { gatilhos: /\b(energia|eletric|agua|esgoto|saneament|telefon|internet|link|utilidade)\w*/, pista: /utilidade|energia|agua|telefon/, porque: "utilidades" },
  { gatilhos: /\b(frete|transporte|logistic|entrega|carreto)\w*/, pista: /frete|transporte|logistic/, porque: "frete e logística" },
  // Comissão sem canônica própria cai em "Despesas com Vendas" — é onde ela
  // mora no DRE_TEMPLATE (flagrado pelo usuário: ficava sem de-para).
  { gatilhos: /\b(comissa|comission)\w*/, pista: /comiss|com vendas/, porque: "comissão de vendas" },
  { gatilhos: /\b(viagem|viagens|hospedag|passage|diaria)\w*/, pista: /viage|deslocament/, porque: "viagens" },
  { gatilhos: /\b(marketing|publicidade|propaganda|midia|patrocin|feira|evento|brinde|amostra|agencia|conteudo|influenc)\w*/, pista: /marketing|publicidade|propaganda|comercial/, porque: "marketing" },
  { gatilhos: /\b(software|licenca|sistema|nuvem|cloud|ti|tecnologia|informatica)\w*/, pista: /software|licenc|tecnolog|informatic|ti\b/, porque: "tecnologia" },
  { gatilhos: /\b(honorari|advocat|juridic|contabil|auditoria|consultor|assessor)\w*/, pista: /honorari|servico de terceiro|terceiro|juridic|contabil/, porque: "serviços profissionais" },
  { gatilhos: /\b(seguro|apolice)\w*/, pista: /seguro/, porque: "seguros" },
  // Veículos ANTES de manutenção: "Veículos (combustível e manutenção)" é conta
  // de frota — caía em "Limpeza, Manutenção e Reparos" porque manutenção vinha
  // primeiro e a ordem das regras decide.
  { gatilhos: /\b(combustivel|veiculo|frota|pedagio)\w*/, pista: /veiculo|frota|combustivel/, porque: "frota" },
  { gatilhos: /\b(manutenc|reparo|conserto|peca)\w*/, pista: /manutenc|reparo/, porque: "manutenção" },
  { gatilhos: /\b(materia prima|insumo|mercadoria|cmv|custo da mercadoria|materiais?)\w*/, pista: /custo operacional|mercadoria|materia prima|cmv|insumo/, porque: "consumo de material" },
  // Agregados genéricos dos modelos antigos: melhor a regra do que deixar a IA
  // filosofar ("Custos sobre a receita" virou Impostos s/ Faturamento num teste).
  { gatilhos: /\bcustos? sobre (a )?receita\b|\bcusto das? (vendas|mercadorias)\b|\bcpv\b|\bcsv\b/, pista: /custo operacional/, porque: "custo da operação" },
  { gatilhos: /\bdespesas? (operacionais|gerais|administrativas)\b/, pista: /gerais e administrativ/, porque: "despesa geral/administrativa" },
  { gatilhos: /\b(deprecia|amortiza)\w*/, pista: /deprecia|amortiza/, porque: "depreciação/amortização" },
  // "tarifas? bancaria": o singular puro não casava "Tarifas bancárias" (o \w*
  // do grupo não cobre o S no meio) — era um dos sem-de-para do usuário.
  { gatilhos: /\b(juros|financeir|tarifas? bancaria|iof|banco|cobranca|taxas? de cartao|meios de pagamento|adquirencia|antecipacao de recebiv)\w*/, pista: /financeir|juros|tarifa/, porque: "despesa financeira" },
  { gatilhos: /\b(imposto|tributo|icms|iss|pis|cofins|simples)\w*/, pista: /imposto|tributo/, porque: "tributos" },
  // SST/ASO são siglas — palavra inteira, senão casariam dentro de outras.
  { gatilhos: /\b(treinament|capacitac|curso|recrutament|selecao|medicina|seguranca do trabalho|ocupacional)\w*|\bsst\b|\baso\b/, pista: /treinament|pessoa|recursos humanos/, porque: "desenvolvimento de pessoas" },
  { gatilhos: /\b(escritorio|copa|limpeza|papelaria|consumo)\w*/, pista: /material|escritorio|administrativ/, porque: "consumo administrativo" },
];

export interface SugestaoConta {
  conta: string;
  /** "exata" | "vocabulario" | "similaridade" — de onde veio a sugestão. */
  base: "exata" | "vocabulario" | "similaridade";
  /** 0..1 — a tela usa para decidir se pré-seleciona ou só sugere. */
  confianca: number;
  /** Frase curta para o analista entender POR QUE ("remuneração e encargos"). */
  porque: string;
}

/** Marcadores de que a conta é da OPERAÇÃO (custo), não do administrativo.
 *  Radicais, não palavras inteiras: "operac" cobre operação/operações/
 *  operacional; "produc", produção/produtivo. "mod" é sigla — palavra inteira,
 *  senão casaria "modelo". */
const CHEIRO_DE_PRODUCAO = /\b(produc|produtiv|fabrica|industrial|operac|direta|obra)\w*|\bmod\b/;

/**
 * Sugere a conta canônica para o nome de uma conta do cliente.
 * @param nome      nome da conta como o cliente escreve
 * @param canonicas contas canônicas disponíveis NO MODELO da empresa
 * @param opts.grupo "custo" (acima do lucro bruto) ou "despesa" — desempata as
 *   canônicas de mesma natureza ("Custos com Pessoas (MOD)" × "Despesas com
 *   Pessoas"). Sem ele, o nome da conta decide (produção/MOD → custo).
 */
export function sugerirContaCanonica(
  nome: string,
  canonicas: string[],
  opts?: { grupo?: "custo" | "despesa" },
): SugestaoConta | null {
  const alvo = norm(nome);
  if (!alvo || canonicas.length === 0) return null;

  // 1) Nome igual ao da canônica.
  const exata = canonicas.find((c) => norm(c) === alvo);
  if (exata) return { conta: exata, base: "exata", confianca: 1, porque: "mesmo nome da conta canônica" };

  // Candidatas do grupo certo primeiro: sem isso, "Salários e encargos
  // (Comercial)" caía em "Custos com Pessoas (MOD)" só por vir antes na lista.
  const grupo = opts?.grupo ?? (CHEIRO_DE_PRODUCAO.test(alvo) ? "custo" : "despesa");
  const ehDoGrupo = (c: string) => (grupo === "custo" ? /^custo/.test(norm(c)) : !/^custo/.test(norm(c)));
  const preferidas = canonicas.filter(ehDoGrupo);
  const ordem = [...preferidas, ...canonicas.filter((c) => !preferidas.includes(c))];

  // 2) Vocabulário contábil: gatilho no nome → pista casada nas canônicas.
  for (const regra of VOCABULARIO) {
    if (!regra.gatilhos.test(alvo)) continue;
    const alvoCanonica = ordem.find((c) => regra.pista.test(norm(c)));
    if (alvoCanonica) return { conta: alvoCanonica, base: "vocabulario", confianca: 0.85, porque: regra.porque };
  }

  // 3) Palavras em comum (Jaccard) — desempate por nome mais curto (mais geral).
  const tAlvo = new Set(tokens(nome));
  if (tAlvo.size === 0) return null;
  const pontuadas = canonicas
    .map((c) => {
      const tC = new Set(tokens(c));
      if (tC.size === 0) return { conta: c, score: 0 };
      let comuns = 0;
      for (const t of tAlvo) if (tC.has(t)) comuns++;
      return { conta: c, score: comuns / new Set([...tAlvo, ...tC]).size };
    })
    // Maior score; empate resolve pelo nome mais curto (a conta mais geral).
    .sort((a, b) => b.score - a.score || a.conta.length - b.conta.length);
  const melhor = pontuadas[0];
  if (melhor && melhor.score >= 0.5) {
    return { conta: melhor.conta, base: "similaridade", confianca: Math.min(0.8, melhor.score), porque: "palavras em comum com a conta canônica" };
  }
  return null;
}
