/**
 * RELATÓRIO DE CONSUMO DE IA — a tela que responde "quanto custou, de quem é".
 *
 * Regra do dono: "sempre precisaremos ter o custo de tudo que usar IA... quando a
 * Quantua escalar não podemos ser surpreendidos" — e o escopo é TODO produto ou
 * atividade que consuma IA, não só o IBR.
 *
 * TRÊS COMPROMISSOS DE HONESTIDADE, porque custo é número que vira decisão:
 *
 * 1. ESCOPO DE TENANT NA PRIMEIRA LINHA. Uma firma nunca pode ver o gasto de
 *    outra. O filtro sai de `req.scopeCompanyIds` (lista fechada) e é aplicado
 *    ANTES de qualquer agregação — nunca depois, nunca no cliente.
 * 2. CUSTO NÃO APURADO ≠ ZERO. Evento com `precoDesconhecido` (modelo novo sem
 *    preço cadastrado) sai numa linha própria, jamais somado como R$ 0.
 * 3. MEDIDO ≠ RECUPERADO. `fonte` viaja até a tela: dado recuperado de JSON
 *    antigo não pode se apresentar como medido.
 */
import { Router, type Response } from "express";
import { prisma } from "../db/client";
import { requireAuth, type AuthRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

/**
 * Janela padrão: mês corrente. Datas em ISO (yyyy-mm-dd).
 *
 * O "até" fecha no FIM DO DIA. `new Date("2026-08-04")` é meia-noite: sem isto o
 * dia corrente inteiro ficava de fora e a tela dizia "nenhum consumo" com dez
 * eventos gravados — o pior tipo de tela vazia, a que parece que nada aconteceu.
 */
function janela(req: AuthRequest): { de: Date; ate: Date } {
  const hoje = new Date();
  const de = req.query.de ? new Date(`${String(req.query.de)}T00:00:00.000Z`) : new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1));
  const ate = req.query.ate
    ? new Date(`${String(req.query.ate)}T23:59:59.999Z`)
    : new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  return { de, ate };
}

/**
 * Filtro de tenant. Externo enxerga só as empresas da lista fechada; equipe
 * Quantua (scopeCompanyIds null) enxerga tudo.
 *
 * Eventos SEM empresa (etapa disparada fora de um IBR/modelo) só aparecem para a
 * equipe — para um cliente eles seriam gasto de origem desconhecida, e mostrar
 * gasto alheio é vazamento.
 */
function escopo(req: AuthRequest): Record<string, unknown> {
  if (!req.scopeCompanyIds) return {};
  return { companyId: { in: req.scopeCompanyIds } };
}

/** GET /ai-usage/resumo — os cortes que um sócio usa. */
router.get("/resumo", async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { de, ate } = janela(req);
    const where = { ...escopo(req), iniciadoEm: { gte: de, lte: ate } } as any;

    const [total, porProduto, porEtapa, porModelo, naoApurados, reaproveitados] = await Promise.all([
      prisma.aiUsageEvent.aggregate({
        where, _sum: { usdTotal: true, inputTokens: true, outputTokens: true, cacheLeituraTokens: true, quantidade: true },
        _count: true,
      }),
      prisma.aiUsageEvent.groupBy({ by: ["produto"], where, _sum: { usdTotal: true }, _count: true }),
      prisma.aiUsageEvent.groupBy({ by: ["etapa"], where, _sum: { usdTotal: true }, _count: true }),
      prisma.aiUsageEvent.groupBy({ by: ["provedor", "modelo"], where, _sum: { usdTotal: true }, _count: true }),
      // Modelo sem preço cadastrado: NUNCA somar como zero, mostrar à parte.
      prisma.aiUsageEvent.count({ where: { ...where, precoDesconhecido: true } }),
      // Reaproveitamento de cache: custo zero agora, mas o histórico guarda o
      // que a leitura custou quando foi de fato paga.
      prisma.aiUsageEvent.aggregate({ where: { ...where, reaproveitado: true }, _sum: { usdOriginal: true }, _count: true }),
    ]);

    const ordena = (xs: any[]) => xs.sort((a, b) => (b._sum.usdTotal ?? 0) - (a._sum.usdTotal ?? 0));

    res.json({
      periodo: { de: de.toISOString().slice(0, 10), ate: ate.toISOString().slice(0, 10) },
      total: {
        usd: total._sum.usdTotal ?? 0,
        chamadas: total._count,
        tokensEntrada: total._sum.inputTokens ?? 0,
        tokensSaida: total._sum.outputTokens ?? 0,
        tokensCacheLeitura: total._sum.cacheLeituraTokens ?? 0,
      },
      porProduto: ordena(porProduto).map((p) => ({ produto: p.produto, usd: p._sum.usdTotal ?? 0, chamadas: p._count })),
      porEtapa: ordena(porEtapa).map((p) => ({ etapa: p.etapa, usd: p._sum.usdTotal ?? 0, chamadas: p._count })),
      porModelo: ordena(porModelo).map((p) => ({ provedor: p.provedor, modelo: p.modelo, usd: p._sum.usdTotal ?? 0, chamadas: p._count })),
      /** Eventos cujo custo NÃO pôde ser apurado — some-los como zero seria mentir. */
      custoNaoApurado: naoApurados,
      economiaCache: { usd: reaproveitados._sum.usdOriginal ?? 0, chamadas: reaproveitados._count },
    });
  } catch (e: any) {
    console.error("[ai-usage] resumo:", e?.message ?? e);
    res.status(500).json({ error: "Não foi possível montar o resumo de consumo de IA" });
  }
});

/** GET /ai-usage/eventos — o extrato linha a linha (base da exportação). */
router.get("/eventos", async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { de, ate } = janela(req);
    const filtros: any = { ...escopo(req), iniciadoEm: { gte: de, lte: ate } };
    if (req.query.produto) filtros.produto = String(req.query.produto);
    if (req.query.etapa) filtros.etapa = String(req.query.etapa);
    if (req.query.companyId) {
      const alvo = String(req.query.companyId);
      // Nunca ampliar o escopo: o filtro do usuário só pode ESTREITAR.
      if (!req.scopeCompanyIds || req.scopeCompanyIds.includes(alvo)) filtros.companyId = alvo;
      else { res.status(404).json({ error: "Empresa não encontrada" }); return; }
    }

    const limite = Math.min(Number(req.query.limite ?? 500), 5000);
    const eventos = await prisma.aiUsageEvent.findMany({
      where: filtros,
      orderBy: { iniciadoEm: "desc" },
      take: limite,
      select: {
        id: true, iniciadoEm: true, duracaoMs: true, produto: true, etapa: true, origem: true,
        provedor: true, modelo: true, modeloSolicitado: true, unidade: true, quantidade: true,
        inputTokens: true, outputTokens: true, cacheCriacaoTokens: true, cacheLeituraTokens: true, buscasWeb: true,
        usdTotal: true, precoDesconhecido: true, reaproveitado: true, usdOriginal: true,
        status: true, stopReason: true, fonte: true,
        userName: true, companyId: true, analysisId: true, modelId: true, documentId: true,
      },
    });

    // Nome da empresa e do IBR para o extrato ficar legível (uma consulta cada).
    const empresaIds = [...new Set(eventos.map((e) => e.companyId).filter(Boolean))] as string[];
    const analiseIds = [...new Set(eventos.map((e) => e.analysisId).filter(Boolean))] as string[];
    const [empresas, analises] = await Promise.all([
      empresaIds.length ? prisma.company.findMany({ where: { id: { in: empresaIds } }, select: { id: true, razaoSocial: true, nomeFantasia: true } }) : [],
      analiseIds.length ? prisma.analysis.findMany({ where: { id: { in: analiseIds } }, select: { id: true, nome: true } }) : [],
    ]);
    const nomeEmpresa = new Map(empresas.map((c) => [c.id, c.nomeFantasia || c.razaoSocial]));
    const nomeAnalise = new Map(analises.map((a) => [a.id, a.nome]));

    res.json({
      periodo: { de: de.toISOString().slice(0, 10), ate: ate.toISOString().slice(0, 10) },
      total: eventos.length,
      limiteAtingido: eventos.length >= limite,
      eventos: eventos.map((e) => ({
        ...e,
        empresa: e.companyId ? (nomeEmpresa.get(e.companyId) ?? null) : null,
        analise: e.analysisId ? (nomeAnalise.get(e.analysisId) ?? null) : null,
      })),
    });
  } catch (e: any) {
    console.error("[ai-usage] eventos:", e?.message ?? e);
    res.status(500).json({ error: "Não foi possível listar o consumo de IA" });
  }
});

export default router;
