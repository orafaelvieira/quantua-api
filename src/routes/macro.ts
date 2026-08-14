/**
 * ÍNDICES MACRO REALIZADOS — superfície HTTP mínima (onda 1).
 *
 * O serviço indices-realizados (BCB/SGS, cache 12h) só era alcançável via
 * GET /models/:id/indicadores (o espelho do IBR). O Sumário do IBR precisa do
 * IPCA do ano de referência para a nota nominal×real do card de Receita —
 * esta rota expõe o realizado por ano, sem acoplar ao modelo.
 *
 * Regras herdadas do serviço: ano sem os 12 meses publicados NÃO sai (nada de
 * número parcial com cara de ano fechado); fonte carimbada na resposta.
 */
import { Router, Response } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { indicesRealizadosPorAno } from "../services/indices-realizados";

const router = Router();
router.use(requireAuth);

// GET /macro/realizado?anos=2024,2025 — IndicesRealizados | null (sem dado → nulls).
router.get("/realizado", async (req: AuthRequest, res: Response): Promise<void> => {
  // Faixa plausível [2000, ano atual]: além de não fazer sentido contábil, ano
  // arbitrário inflaria o cache do serviço (Map sem eviction, instância única).
  const anoMax = new Date().getFullYear();
  const anos = String(req.query.anos ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d{4}$/.test(s) && Number(s) >= 2000 && Number(s) <= anoMax)
    .slice(0, 12); // teto defensivo — ninguém precisa de mais de 12 anos por chamada
  if (anos.length === 0) {
    res.status(400).json({ error: "Informe ?anos=YYYY[,YYYY...]" });
    return;
  }
  // Best-effort: BCB fora do ar não pode derrubar a tela — devolve vazio e a nota não aparece.
  const dados = await indicesRealizadosPorAno(anos).catch(() => null);
  res.json(dados ?? { fonte: null, indices: null, memoria: [] });
});

export default router;
