/**
 * ASSISTENTE (Quantua Digital, 2026-08) — pergunta livre ancorada na análise.
 *
 * A IA aqui é PURAMENTE interpretativa, como no generateAnalysis: o contexto
 * injeta os números determinísticos da análise vigente (indicadores do último
 * período com semáforo, áreas do semáforo da IA, recomendações) e o modelo
 * responde SOBRE eles — nunca inventa número novo. Modelo barato (haiku),
 * custo rastreado no AiUsageEvent via createWithRetry, teto de 30 perguntas
 * por usuário/hora (assistantLimiter).
 */
import { Router, Response } from "express";
import { z } from "zod";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { assistantLimiter } from "../middleware/rate-limit";
import { whereRecursoEmpresa } from "../services/escopo-empresa";
import { prisma } from "../db/client";
import { createWithRetry, modeloAnaliseId } from "../services/ai-extraction";
import { middlewareContextoIA, enriquecerContextoIA, resolverAutorIA } from "../services/ai-usage";

const router = Router();
router.use(requireAuth);
router.use(middlewareContextoIA("assistente-digital"));

const askSchema = z.object({
  analysisId: z.string().uuid(),
  pergunta: z.string().min(3).max(600),
  historico: z
    .array(z.object({ autor: z.enum(["usuario", "agente"]), texto: z.string().max(2000) }))
    .max(10)
    .optional(),
});

interface IndicadorLite {
  nome?: string;
  tipoDado?: string;
  oculto?: boolean;
  valores?: Record<string, number | string | null>;
  status?: Record<string, string | null>;
}

function ordPeriodo(p: string): number {
  const m = p.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return Number(`${m[3]}${m[2]}${m[1]}`);
  const y = p.match(/\d{4}/);
  return y ? Number(`${y[0]}0000`) : 0;
}

function fmtValor(v: number | string | null | undefined, tipoDado?: string): string | null {
  if (typeof v === "string") return v;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (tipoDado === "%") return `${(v * 100).toFixed(1)}%`;
  if (tipoDado === "Dias") return `${Math.round(v)} dias`;
  if (tipoDado === "R$") return `R$ ${Math.round(v).toLocaleString("pt-BR")}`;
  return v.toFixed(2);
}

/** Heurística simples de "de onde veio a resposta" para o deep-link do front. */
function inferirFonte(texto: string): "ibr" | "valuation" | "revisao" | undefined {
  const t = texto.toLowerCase();
  if (/valuation|equity|wacc|fcd|dcf|perpetuidade|m[uú]ltiplo/.test(t)) return "valuation";
  if (/assinar|assinatura|checklist|revis[aã]o|parecer/.test(t)) return "revisao";
  if (/indicador|margem|liquidez|ciclo|dso|giro|score|endividamento|receita|caixa/.test(t)) return "ibr";
  return undefined;
}

// POST /assistant/ask — { analysisId, pergunta, historico? } → { resposta, fonte? }
router.post("/ask", assistantLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { analysisId, pergunta, historico } = parsed.data;

  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId, ...whereRecursoEmpresa(req) },
    select: {
      id: true,
      nome: true,
      companyId: true,
      periodo: true,
      status: true,
      dadosEstruturados: true,
      resultado: true,
      company: { select: { razaoSocial: true, nomeFantasia: true, setor: true } },
    },
  });
  if (!analysis) {
    res.status(404).json({ error: "Análise não encontrada" });
    return;
  }

  const dados = analysis.dadosEstruturados as {
    indicadores?: IndicadorLite[];
    periodos?: string[];
    naoMapeados?: unknown[];
  } | null;
  const resultado = analysis.resultado as {
    semaforo?: Array<{ area: string; status: string; descricao?: string }>;
    recomendacoes?: Array<{ titulo: string; prioridade?: string }>;
    valorNaMesa?: { total?: number; leitura?: string } | null;
    situacao?: { classificacao?: string; racional?: string };
  } | null;

  const periodos = [...(dados?.periodos ?? [])].sort((a, b) => ordPeriodo(a) - ordPeriodo(b));
  const ultimo = periodos[periodos.length - 1];
  const indicadores = (dados?.indicadores ?? []).filter((i) => !i.oculto);

  const linhasIndicadores = ultimo
    ? indicadores
        .map((i) => {
          const valor = fmtValor(i.valores?.[ultimo], i.tipoDado);
          if (valor === null) return null;
          const st = i.status?.[ultimo];
          return `- ${i.nome}: ${valor}${st ? ` (${st})` : ""}`;
        })
        .filter(Boolean)
        .join("\n")
    : "(sem indicadores calculados)";

  const empresa = analysis.company?.nomeFantasia || analysis.company?.razaoSocial || "a empresa";
  const contexto = [
    `Empresa: ${empresa}${analysis.company?.setor ? ` · setor ${analysis.company.setor}` : ""}`,
    `Análise: ${analysis.nome} · status ${analysis.status} · período mais recente: ${ultimo ?? analysis.periodo ?? "—"}`,
    `Contas aguardando mapeamento: ${dados?.naoMapeados?.length ?? 0}`,
    resultado?.situacao?.classificacao ? `Situação: ${resultado.situacao.classificacao}` : null,
    resultado?.semaforo?.length
      ? `Semáforo por área:\n${resultado.semaforo.map((s) => `- ${s.area}: ${s.status}${s.descricao ? ` — ${s.descricao}` : ""}`).join("\n")}`
      : null,
    `Indicadores (último período, com status ok/atencao/critico quando avaliado):\n${linhasIndicadores}`,
    resultado?.recomendacoes?.length
      ? `Recomendações da análise:\n${resultado.recomendacoes.slice(0, 6).map((r) => `- [${r.prioridade ?? "—"}] ${r.titulo}`).join("\n")}`
      : null,
    resultado?.valorNaMesa?.total ? `Valor na mesa (estimado): R$ ${Math.round(resultado.valorNaMesa.total).toLocaleString("pt-BR")}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const conversa = (historico ?? [])
    .slice(-6)
    .map((m) => `${m.autor === "usuario" ? "Usuário" : "Assistente"}: ${m.texto}`)
    .join("\n");

  const prompt = [
    "Você é o assistente do Quantua, ancorado nos dados REAIS da análise abaixo. Responda em português, em 2 a 5 frases, direto e técnico, citando os números do contexto. NUNCA invente números que não estejam no contexto; se a informação não estiver disponível, diga isso e sugira onde encontrá-la na plataforma (coleta, mapeamento, IBR, valuation). Sem markdown, sem listas — texto corrido.",
    `=== CONTEXTO (fatos determinísticos) ===\n${contexto}`,
    conversa ? `=== CONVERSA ATÉ AQUI ===\n${conversa}` : null,
    `=== PERGUNTA ===\n${pergunta}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  enriquecerContextoIA({ analysisId: analysis.id, companyId: analysis.companyId });
  await resolverAutorIA();

  try {
    const msg = await createWithRetry(
      {
        model: modeloAnaliseId("haiku"),
        max_tokens: 600,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      },
      0,
      { etapa: "assistente-digital", modeloSolicitado: "haiku" }
    );
    const resposta = msg.content?.[0]?.type === "text" ? String(msg.content[0].text).trim() : "";
    if (!resposta) {
      res.status(502).json({ error: "A IA não retornou resposta. Tente novamente." });
      return;
    }
    res.json({ resposta, fonte: inferirFonte(`${pergunta} ${resposta}`) });
  } catch (e) {
    console.error("[assistant] erro na chamada de IA:", e instanceof Error ? e.message : e);
    res.status(502).json({ error: "Assistente indisponível no momento. Tente novamente em instantes." });
  }
});

export default router;
