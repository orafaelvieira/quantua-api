import { Router, Response } from "express";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

// GET /standard-models — modelos padrão BP e DRE VIGENTES (ativo=true), com as linhas
// ordenadas. Base da tela de governança dos modelos (somente leitura por enquanto).
router.get("/", async (_req: AuthRequest, res: Response): Promise<void> => {
  const models = await prisma.standardModel.findMany({
    where: { ativo: true },
    include: { linhas: { orderBy: { ordem: "asc" } } },
  });
  const pick = (tipo: string) => {
    const m = models.find((x) => x.tipo === tipo);
    if (!m) return null;
    return {
      id: m.id,
      tipo: m.tipo,
      versao: m.versao,
      nota: m.nota,
      criadoEm: m.createdAt,
      linhas: m.linhas.map((l) => ({
        codigo: l.codigo,
        nome: l.nome,
        grupo: l.grupo,
        ordem: l.ordem,
        tipo: l.tipo,
        nivel: l.nivel,
        sinal: l.sinal,
      })),
    };
  };
  res.json({ bp: pick("BP"), dre: pick("DRE") });
});

export default router;
