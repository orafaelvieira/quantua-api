/**
 * CLASSIFICADOR AUTOMÁTICO DO DE-PARA DO ORÇAMENTO (28/07/2026) — "o analista
 * não vai saber preencher a conta canônica e ele vai colocar mais contas no
 * plano; o ideal é uma ferramenta para classificar automaticamente".
 *
 * Duas passadas, na ordem do custo:
 *   1. REGRA (sugerir-conta-canonica): determinística, grátis, auditável —
 *      resolve a maioria dos nomes comuns.
 *   2. IA (uma chamada Haiku para o LOTE que sobrou): múltipla escolha FECHADA
 *      nas canônicas do modelo da empresa — nunca inventa destino; temperature
 *      0; custo calculado e devolvido para a trilha de auditoria
 *      ([[registrar-custo-ia]]).
 *
 * O que nem a IA resolve volta em `semSugestao` — pendência VISÍVEL, nunca
 * chutada. Best-effort: IA fora do ar degrada para "só regra", nunca quebra.
 */
import { createWithRetry, calcCusto, type CustoIA } from "./ai-extraction";
import { sugerirContaCanonica } from "./sugerir-conta-canonica";

const MODELO_DEPARA = "claude-haiku-4-5-20251001";

export interface LinhaParaClassificar {
  id: string;
  nome: string;
  grupo: "custo" | "despesa";
}

export interface DeParaClassificado {
  id: string;
  nome: string;
  conta: string;
  via: "regra" | "ia";
  porque: string;
}

/** Opções que uma conta de custo/despesa do orçamento pode receber: canônicas
 *  de SAÍDA — linha de gasto nunca vira "Receita Bruta"/"Receitas Financeiras"
 *  (inclui "Deduções da Receita Bruta", que contém "Receita" de propósito). */
export function opcoesDeParaOrcamento(canonicas: string[]): string[] {
  return canonicas.filter((c) => !/receita/i.test(c));
}

export async function classificarDeParaOrcamento(
  linhas: LinhaParaClassificar[],
  canonicas: string[],
  opts?: { setor?: string | null; comIa?: boolean },
): Promise<{ classificadas: DeParaClassificado[]; semSugestao: string[]; custo: CustoIA | null }> {
  const classificadas: DeParaClassificado[] = [];
  const restantes: LinhaParaClassificar[] = [];

  // A REGRA também só enxerga as opções de saída: com a lista completa, o
  // Jaccard mapeava "Custos sobre a receita" para "Receita Bruta" pelo token
  // {receita} — linha de gasto jamais aponta para canônica de receita.
  const opcoes = opcoesDeParaOrcamento(canonicas);
  for (const l of linhas) {
    const s = sugerirContaCanonica(l.nome, opcoes, { grupo: l.grupo });
    if (s) classificadas.push({ id: l.id, nome: l.nome, conta: s.conta, via: "regra", porque: s.porque });
    else restantes.push(l);
  }
  if (restantes.length === 0 || opts?.comIa === false || opcoes.length === 0) {
    return { classificadas, semSugestao: restantes.map((l) => l.nome), custo: null };
  }

  const itens = restantes.slice(0, 200); // teto de sanidade — lote gigante não existe num orçamento real
  const prompt = `Você é um contador sênior brasileiro. Um orçamento empresarial tem contas com nomes livres do cliente, e cada uma precisa apontar para UMA conta canônica do DRE gerencial (o "de-para" que liga orçado × realizado).${opts?.setor ? ` Empresa do setor: ${opts.setor}.` : ""}

CONTAS CANÔNICAS PERMITIDAS (escolha SEMPRE uma destas, cópia literal):
${opcoes.map((o) => `- ${o}`).join("\n")}

Para CADA conta do orçamento abaixo, escolha a canônica mais adequada. "custo" = acima do lucro bruto (operação/produção); "despesa" = abaixo (comercial/administrativa).

${itens.map((l, i) => `${i + 1}. "${l.nome}" (${l.grupo})`).join("\n")}

Regras:
- "conta" deve ser EXATAMENTE uma das permitidas (cópia literal). Se NENHUMA servir com razoável certeza, use "".
- "porque": 1 frase curta e objetiva em português.
Responda APENAS JSON: [{"i":1,"conta":"...","porque":"..."}]`;

  try {
    const msg = await createWithRetry({
      model: MODELO_DEPARA,
      max_tokens: 4000,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });
    let txt = msg.content?.[0]?.type === "text" ? msg.content[0].text.trim() : "";
    if (txt.startsWith("```")) txt = txt.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    let arr: Array<{ i?: number; conta?: unknown; porque?: unknown }> = [];
    try { arr = JSON.parse(txt); } catch {
      const ini = txt.indexOf("["), fim = txt.lastIndexOf("]");
      if (ini >= 0 && fim > ini) { try { arr = JSON.parse(txt.slice(ini, fim + 1)); } catch { arr = []; } }
    }
    const resolvidos = new Set<string>();
    for (const r of arr) {
      const item = itens[(r?.i ?? 0) - 1];
      if (!item || typeof r.conta !== "string" || !r.conta) continue;
      // Blindagem: só entra o que está nas opções fechadas — IA nunca inventa.
      if (!opcoes.includes(r.conta)) continue;
      classificadas.push({
        id: item.id, nome: item.nome, conta: r.conta, via: "ia",
        porque: String(r.porque ?? "classificada por IA").slice(0, 200),
      });
      resolvidos.add(item.id);
    }
    const custo = calcCusto(MODELO_DEPARA, msg.usage?.input_tokens ?? 0, msg.usage?.output_tokens ?? 0);
    const semSugestao = restantes.filter((l) => !resolvidos.has(l.id)).map((l) => l.nome);
    return { classificadas, semSugestao, custo };
  } catch (e) {
    console.warn(`[de-para orçamento] IA falhou (segue só com as regras): ${(e as Error)?.message ?? e}`);
    return { classificadas, semSugestao: restantes.map((l) => l.nome), custo: null };
  }
}
