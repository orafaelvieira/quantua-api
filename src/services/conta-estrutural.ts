/**
 * TRAVAS DO DICIONÁRIO — proteção contra "veneno de dicionário".
 *
 * Contexto: quem opera o IBR pode ser um estagiário sem domínio contábil. O
 * dicionário auto-alimentado aprende de cada confirmação — então uma classificação
 * ERRADA de uma conta AGREGADA (nível de grupo) como se fosse uma conta-FOLHA
 * contaminaria os próximos IBRs do mesmo workspace.
 *
 * Caso real (Fibracabos, balanço "Grau 4"): "EXIGÍVEL A CURTO PRAZO" é um
 * agrupamento (= todo o Passivo Circulante) cujas filhas são fornecedores,
 * empréstimos, obrigações etc. Classificá-lo como "Obrigações Trabalhistas - CP"
 * (uma folha) descartaria a composição e distorceria dívida líquida, NCG, prazos.
 *
 * Regra: BLOQUEAR "agregado → folha". PERMITIR "agregado → seu próprio grupo"
 * (ex.: EXIGÍVEL A CURTO PRAZO → Passivo Circulante) e "folha → folha" (normal).
 */
import { DEFAULT_BP_MODEL } from "./account-mapper";

const semAcento = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Termos que são CABEÇALHOS DE AGRUPAMENTO (não contas-folha). Conservador: só
 * entram padrões inequívocos. Âncoras `^...$` nos ambíguos ("créditos", "obrigações"
 * puro) para NÃO pegar folhas legítimas ("Obrigações Fiscais", "Outros Créditos").
 * "Disponibilidades" NÃO entra: a absorção → Caixa é correta (filhas homogêneas).
 */
const TERMOS_AGREGADOS: RegExp[] = [
  /\bexig[ií]vel\b/,                                  // exigível a curto/longo prazo · passivo exigível
  /^(ativo|passivo)\s+(n[ãa]o\s+)?circulante$/,       // grupos do BP
  /^(ativo|passivo)\s+total$/,
  /^patrim[oô]nio\s+l[ií]quido(\s+consolidado)?$/,
  /^cr[ée]ditos$/,                                    // "CRÉDITOS" (impostos+duplicatas+adiantamentos)
  /^(outras\s+)?obriga[çc][õo]es$/,                   // "Obrigações"/"Outras Obrigações" puro (heterogêneo)
];
// NOTA: "Realizável a Longo Prazo" é FOLHA legítima do modelo (catch-all de ALP) —
// mapear o header do doc p/ ela é o comportamento correto, então NÃO é agregado.
// A checagem de folha é BP-only; agregados de DRE são tratados na extração (DRE_SUBTOTAIS).

/** true = o nome é um agrupamento/subtotal, não uma conta-folha. */
export function ehTermoAgregado(nome: string): boolean {
  const n = semAcento(nome);
  return TERMOS_AGREGADOS.some((re) => re.test(n));
}

/** true = o destino é uma conta-FOLHA do modelo (tipo "input"), não grupo/subtotal. */
export function ehDestinoFolha(contaDestino: string): boolean {
  const linha = DEFAULT_BP_MODEL.lines.find((l) => l.conta === contaDestino);
  return linha?.tipo === "input";
}

export interface BloqueioEstrutural {
  bloqueado: boolean;
  motivo?: string;
}

/**
 * Trava principal: uma conta AGREGADA sendo mapeada para uma conta-FOLHA?
 * Isso colapsa um grupo inteiro numa única linha, perdendo a composição — quase
 * sempre erro de quem não domina contabilidade. Bloqueado no dicionário.
 */
export function avaliaBloqueioEstrutural(nomeOriginal: string, contaDestino: string): BloqueioEstrutural {
  if (!ehTermoAgregado(nomeOriginal)) return { bloqueado: false };
  if (!ehDestinoFolha(contaDestino)) return { bloqueado: false }; // agregado → grupo: OK
  return {
    bloqueado: true,
    motivo:
      `"${nomeOriginal}" é uma conta de AGRUPAMENTO — classificá-la como "${contaDestino}" ` +
      `(uma conta detalhada) descartaria a composição do grupo e distorceria os indicadores ` +
      `(dívida líquida, NCG, prazos) dos próximos IBRs. Reprocesse o documento para extrair as ` +
      `contas detalhadas, ou use "Editar" para lançar a composição manualmente.`,
  };
}
