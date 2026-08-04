/**
 * PORTFÓLIO (Quantua Digital, 2026-08) — a carteira inteira em UMA request.
 *
 * Para cada empresa do escopo, resolve a análise VIGENTE (mais recente
 * Concluída; senão a mais recente) e devolve um resumo leve: score composto,
 * semáforo por área, margem EBITDA, ciclo financeiro e alertas — tudo derivado
 * do que a análise JÁ tem gravado (indicadores com semáforo calibrado por
 * pares + resultado da IA). Nenhum recálculo acontece aqui.
 *
 * SCORE COMPOSTO (0–100, determinístico): sobre os indicadores ativos com
 * semáforo avaliado no último período — ok=1 · atenção=0,5 · crítico=0 →
 * média × 100, arredondado. A régua de cada indicador é a já calibrada da
 * análise (indicadorConfig/pares B3); o score só agrega.
 */
import { Router, Response } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { whereEmpresaVisivel } from "../services/escopo-empresa";
import { prisma } from "../db/client";
import { cicloVidaAnalysis, etapaAnalysis } from "../services/ciclo-vida";

const router = Router();
router.use(requireAuth);

interface IndicadorLite {
  nome?: string;
  oculto?: boolean;
  valores?: Record<string, number | string | null>;
  status?: Record<string, string | null>;
}

/** Ordenação canônica de períodos ("31/12/2024" ou "2024") — espelho do front. */
function ordPeriodo(p: string): number {
  const m = p.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return Number(`${m[3]}${m[2]}${m[1]}`);
  const y = p.match(/\d{4}/);
  return y ? Number(`${y[0]}0000`) : 0;
}

function numOuNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const PROCESSANDO = new Set(["Extraindo", "Gerando diagnóstico"]);

// GET /portfolio — resumo por empresa do escopo (uma linha da carteira cada).
router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const companies = await prisma.company.findMany({
    where: { status: { not: "inativo" }, ...whereEmpresaVisivel(req) },
    select: { id: true, razaoSocial: true, nomeFantasia: true, setor: true, uf: true },
    orderBy: { createdAt: "asc" },
  });
  if (companies.length === 0) {
    res.json({ empresas: [] });
    return;
  }

  // Fase 1 — metadados leves de todas as análises das empresas (sem JSONs).
  const metas = await prisma.analysis.findMany({
    where: { companyId: { in: companies.map((c) => c.id) }, ehTeste: false },
    select: { id: true, companyId: true, status: true, reviewState: true, createdAt: true, periodo: true },
    orderBy: { createdAt: "desc" },
  });

  // Vigente por empresa: mais recente Concluída; senão a mais recente.
  const vigentePorEmpresa = new Map<string, (typeof metas)[number]>();
  for (const m of metas) {
    const atual = vigentePorEmpresa.get(m.companyId);
    if (!atual) {
      vigentePorEmpresa.set(m.companyId, m);
      continue;
    }
    if (atual.status !== "Concluída" && m.status === "Concluída") vigentePorEmpresa.set(m.companyId, m);
  }

  // Fase 2 — JSONs pesados SÓ das vigentes.
  const vigenteIds = [...vigentePorEmpresa.values()].map((m) => m.id);
  const detalhes = vigenteIds.length
    ? await prisma.analysis.findMany({
        where: { id: { in: vigenteIds } },
        select: { id: true, dadosEstruturados: true, resultado: true },
      })
    : [];
  const detalhePorId = new Map(detalhes.map((d) => [d.id, d]));

  const empresas = companies.map((c) => {
    const meta = vigentePorEmpresa.get(c.id) ?? null;
    const detalhe = meta ? detalhePorId.get(meta.id) : undefined;
    const dados = (detalhe?.dadosEstruturados ?? null) as {
      indicadores?: IndicadorLite[];
      periodos?: string[];
      naoMapeados?: unknown[];
      extraidoEm?: string;
    } | null;
    const resultado = (detalhe?.resultado ?? null) as {
      semaforo?: Array<{ area: string; status: string; descricao?: string }>;
    } | null;

    const periodos = [...(dados?.periodos ?? [])].sort((a, b) => ordPeriodo(a) - ordPeriodo(b));
    const ultimo = periodos[periodos.length - 1];
    const anterior = periodos[periodos.length - 2];
    const indicadores = (dados?.indicadores ?? []).filter((i) => !i.oculto);

    // Score composto sobre os status do último período.
    let score: number | null = null;
    let alertasCriticos = 0;
    if (ultimo && indicadores.length) {
      let soma = 0;
      let n = 0;
      for (const ind of indicadores) {
        const st = ind.status?.[ultimo] ?? null;
        if (st === "ok") { soma += 1; n += 1; }
        else if (st === "atencao") { soma += 0.5; n += 1; }
        else if (st === "critico") { soma += 0; n += 1; alertasCriticos += 1; }
      }
      if (n > 0) score = Math.round((soma / n) * 100);
    }

    // Análises antigas/seeds usam nomes curtos; o motor atual, os canônicos.
    const porNome = (...nomes: string[]) => indicadores.find((i) => nomes.includes(i.nome ?? ""));
    const margemInd = porNome("Margem EBITDA");
    const cicloInd = porNome("Ciclo Financeiro", "Ciclo de Caixa", "Ciclo de Conversão de Caixa");
    const margemEbitda = ultimo ? numOuNull(margemInd?.valores?.[ultimo]) : null;
    const margemAnterior = anterior ? numOuNull(margemInd?.valores?.[anterior]) : null;
    const ciclo = ultimo ? numOuNull(cicloInd?.valores?.[ultimo]) : null;

    return {
      companyId: c.id,
      nome: c.nomeFantasia || c.razaoSocial,
      setor: [c.setor, c.uf].filter(Boolean).join(" · ") || null,
      analiseVigenteId: meta?.id ?? null,
      analiseStatus: meta?.status ?? null,
      cicloVida: meta ? cicloVidaAnalysis(meta.status) : null,
      etapa: meta ? etapaAnalysis(meta.status) : null,
      reviewState: meta?.reviewState ?? null,
      score,
      scoreAreas: resultado?.semaforo?.map((s) => ({ area: s.area, status: s.status })) ?? [],
      margemEbitda,
      margemAnterior,
      cicloFinanceiroDias: ciclo !== null ? Math.round(ciclo) : null,
      alertasCriticos,
      naoMapeados: dados?.naoMapeados?.length ?? 0,
      periodoBase: ultimo ?? meta?.periodo ?? null,
      atualizadoEm: dados?.extraidoEm ?? meta?.createdAt?.toISOString() ?? null,
      processando: meta ? PROCESSANDO.has(meta.status) : false,
    };
  });

  res.json({ empresas });
});

export default router;
