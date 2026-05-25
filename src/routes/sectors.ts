import { Router, Response } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { getSectorBenchmark, listSectors } from "../services/sector-benchmark";

const router = Router();
router.use(requireAuth);

// GET /sectors — lista todos os setores ativos do catálogo Quantua.
router.get("/", async (_req: AuthRequest, res: Response): Promise<void> => {
  const sectors = await listSectors();
  res.json({ sectors });
});

// GET /sectors/:code/benchmark?year=YYYY — benchmark unificado de um setor.
// Year opcional; default = ano mais recente disponível em SectorBenchmark.
router.get("/:code/benchmark", async (req: AuthRequest, res: Response): Promise<void> => {
  const code = req.params.code as string;
  const yearParam = req.query.year as string | undefined;
  const year = yearParam ? Number(yearParam) : undefined;

  if (yearParam && (Number.isNaN(year) || !Number.isInteger(year) || year! < 1900 || year! > 2100)) {
    res.status(400).json({ error: "invalid year query param" });
    return;
  }

  const benchmark = await getSectorBenchmark(code, year);
  if (!benchmark) {
    res.status(404).json({ error: `no benchmark for sector "${code}"` });
    return;
  }

  res.json(benchmark);
});

export default router;
