/**
 * SUGESTÃO DE CLASSIFICAÇÃO POR IA para contas não-mapeadas (âmbar na auditoria).
 *
 * Substitui a heurística de sobreposição de palavras por uma escolha SEMÂNTICA com
 * justificativa — mas SEM tocar nos números: é só a dica exibida ao analista, que
 * confirma; a validação cruzada continua bloqueando incompatibilidades ao gravar.
 *
 * Desenho (requisitos do produto):
 * - UMA chamada Haiku para o LOTE inteiro (custo ~US$0,01/IBR), só quando há âmbar.
 * - MÚLTIPLA ESCOLHA: a IA só pode escolher das opções FECHADAS já filtradas por
 *   grupo (BP) / natureza (DRE) — nunca inventa destino.
 * - temperature 0 + cache: gerada na extração e salva em dadosEstruturados; abrir a
 *   tela N vezes mostra a MESMA sugestão (determinístico na prática).
 * - Custo registrado ([[registrar-custo-ia]]) em dadosEstruturados.custoSugestoes.
 */
import { createWithRetry, calcCusto, type CustoIA, type NaoMapeado } from "./ai-extraction";
import { DEFAULT_BP_MODEL, blocoDoCaminhoDRE, blocoDoDestinoDRE } from "./account-mapper";

const MODELO_SUGESTAO = "claude-haiku-4-5-20251001";

export interface SugestaoIA {
  sugestao: string;
  justificativa: string;
  confianca: "alta" | "media" | "baixa" | string;
  verificar?: string;
}

/** Chave estável de um item não-mapeado (mesma usada no carry-over do refold e no
 *  lookup da tela). O GRUPO-RAIZ entra na chave porque a MESMA conta pode existir no
 *  PC e no PNC (ex.: "INSTITUIÇÕES FINANCEIRAS" nos dois) — sem ele, a sugestão de um
 *  grupo atropelava a do outro e a tela exibia destino de LP para conta de CP, que o
 *  /classify bloquearia (flagrado pelo usuário na Move Farma). */
export const chaveNM = (nm: { tipo: string; nome: string; grupo?: string }) =>
  `${nm.tipo}|${(nm.grupo ?? "").split(">")[0].trim()}|${nm.nome}`;

const CLASSIF_TO_GRUPO: Record<string, string> = { AC: "AC", AF: "AC", AO: "AC", ANC: "ANC", PC: "PC", PO: "PC", PF: "PC", PNC: "PNC", PL: "PL" };
const GRUPO_CODE: Record<string, string> = {
  "ativo circulante": "AC", "ativo nao circulante": "ANC",
  "passivo circulante": "PC", "passivo nao circulante": "PNC", "patrimonio liquido": "PL",
};
const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/** Opções DRE permitidas: NATUREZA (entrada/saída pelo sinal) + BLOCO pela POSIÇÃO no
 *  documento (custo × despesa) — "a posição no documento manda" vale também para a
 *  SUGESTÃO, não só para o fold/dicionário: pessoas pode ser CUSTO (mão de obra fabril)
 *  ou DESPESA (folha administrativa) conforme onde a empresa a declara. Destinos
 *  neutros (D&A, financeiras, IR) passam sempre. Exportada p/ teste. */
export function opcoesDREPermitidas(dreInputs: string[], valor: number, grupoDoc?: string): string[] {
  const ehReceitaDRE = (c: string) => /receita/i.test(c);
  const porNatureza = dreInputs.filter((c) => ehReceitaDRE(c) === (valor > 0));
  const bloco = blocoDoCaminhoDRE((grupoDoc ?? "").split(">").map((s) => s.trim()));
  if (!bloco) return porNatureza;
  return porNatureza.filter((c) => {
    const b = blocoDoDestinoDRE(c);
    return b === null || b === bloco;
  });
}

/** Opções BP do grupo da conta (mesmo filtro do dropdown — a IA não vê opção inválida). */
function opcoesBPDoGrupo(grupoDoc: string): string[] {
  // grupoDoc pode vir como "Passivo Circulante" ou "Passivo Circulante > PAI > ..."
  const raiz = grupoDoc.split(">")[0].trim();
  const code = GRUPO_CODE[norm(raiz)];
  if (!code) return [];
  return DEFAULT_BP_MODEL.lines
    .filter((l) => l.tipo === "input" && CLASSIF_TO_GRUPO[l.classificacao] === code)
    .map((l) => l.conta);
}

/**
 * Gera sugestões para o lote de não-mapeadas. Best-effort: em erro, retorna mapa
 * vazio (a tela fica sem dica, nunca quebra o processamento).
 */
export async function sugerirClassificacoesIA(
  naoMapeados: NaoMapeado[],
  ctx: { setor?: string | null; receitaUltimoAno?: number | null },
  dreInputs: string[],
): Promise<{ sugestoes: Record<string, SugestaoIA>; custo: CustoIA | null }> {
  const itens = naoMapeados.filter((nm) => nm.nome && typeof nm.valor === "number");
  if (itens.length === 0) return { sugestoes: {}, custo: null };

  const linhas = itens.map((nm, i) => {
    const opcoes = nm.tipo === "BP"
      ? opcoesBPDoGrupo(nm.grupo)
      : opcoesDREPermitidas(dreInputs, nm.valor, nm.grupo);
    const pctReceita = ctx.receitaUltimoAno ? ` (${((Math.abs(nm.valor) / Math.abs(ctx.receitaUltimoAno)) * 100).toFixed(1)}% da receita)` : "";
    return `${i + 1}. [${nm.tipo}] "${nm.nome}" · posição no documento: ${nm.grupo} · valor ${nm.valor.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}${pctReceita}
   OPÇÕES PERMITIDAS: ${opcoes.join(" | ") || "(nenhuma — responda sugestao vazia)"}`;
  });

  const prompt = `Você é um contador sênior brasileiro ajudando um analista júnior a classificar contas de demonstrações financeiras no modelo padrão. Empresa do setor: ${ctx.setor ?? "não informado"}.

Para CADA conta abaixo, escolha o destino mais adequado ENTRE AS OPÇÕES PERMITIDAS daquela conta (nunca fora delas), com justificativa curta. Considere o NOME, a POSIÇÃO no documento, o VALOR/magnitude e o SETOR.

${linhas.join("\n")}

Regras:
- "sugestao" deve ser EXATAMENTE uma das OPÇÕES PERMITIDAS da conta (cópia literal). Se nenhuma servir, use "".
- "justificativa": 1 frase objetiva (por que este destino, citando o sinal que pesou).
- "confianca": "alta" | "media" | "baixa". Use "baixa" quando o nome for ambíguo sem o razão contábil.
- "verificar": SÓ quando ambíguo — o que o analista deve confirmar com o cliente (1 frase). Senão omita.
Responda APENAS JSON: [{"i":1,"sugestao":"...","justificativa":"...","confianca":"...","verificar":"..."}]`;

  try {
    const msg = await createWithRetry({
      model: MODELO_SUGESTAO,
      max_tokens: 4000,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });
    let txt = msg.content?.[0]?.type === "text" ? msg.content[0].text.trim() : "";
    if (txt.startsWith("```")) txt = txt.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    let arr: any[] = [];
    try { arr = JSON.parse(txt); } catch {
      const ini = txt.indexOf("["), fim = txt.lastIndexOf("]");
      if (ini >= 0 && fim > ini) { try { arr = JSON.parse(txt.slice(ini, fim + 1)); } catch { arr = []; } }
    }
    const sugestoes: Record<string, SugestaoIA> = {};
    for (const r of arr) {
      const idx = (r?.i ?? 0) - 1;
      const nm = itens[idx];
      if (!nm || !r?.sugestao || typeof r.sugestao !== "string") continue;
      // Blindagem: a sugestão precisa estar nas opções permitidas daquela conta.
      const opcoes = nm.tipo === "BP" ? opcoesBPDoGrupo(nm.grupo) : opcoesDREPermitidas(dreInputs, nm.valor, nm.grupo);
      if (!opcoes.includes(r.sugestao)) continue;
      sugestoes[chaveNM(nm)] = {
        sugestao: r.sugestao,
        justificativa: String(r.justificativa ?? "").slice(0, 300),
        confianca: ["alta", "media", "baixa"].includes(r.confianca) ? r.confianca : "media",
        ...(r.verificar ? { verificar: String(r.verificar).slice(0, 300) } : {}),
      };
    }
    const custo = calcCusto(MODELO_SUGESTAO, msg.usage?.input_tokens ?? 0, msg.usage?.output_tokens ?? 0);
    return { sugestoes, custo };
  } catch (e: any) {
    console.warn(`[sugestoes] falhou (segue sem dica): ${e?.message ?? e}`);
    return { sugestoes: {}, custo: null };
  }
}
