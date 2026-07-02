import { Router, Response } from "express";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";
import type { TermoFormula } from "../services/indicator-config";

/**
 * Tela "Indicadores" (menu lateral) — edita a tabela IndicatorConfig.
 * Sistema: só semáforo/ativo/ordem editáveis; NUNCA deletável (IA/estágio/pares dependem).
 * Personalizado: CRUD completo; fórmula estruturada validada aqui (linhas existentes ficam
 * a cargo do editor — linha inexistente só rende valor 0, nunca quebra).
 */
const router = Router();
router.use(requireAuth);

const DIRECOES = new Set(["menor_ruim", "maior_ruim"]);
const TIPOS_DADO = new Set(["R$", "%", "Índice", "Dias"]);

function parseTermos(raw: unknown): TermoFormula[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const termos: TermoFormula[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") return null;
    const { origem, conta, sinal, abs } = t as Record<string, unknown>;
    if (origem !== "BP" && origem !== "DRE") return null;
    if (typeof conta !== "string" || !conta.trim()) return null;
    termos.push({ origem, conta: conta.trim(), sinal: sinal === -1 ? -1 : 1, ...(abs === true ? { abs: true } : {}) });
  }
  return termos;
}

function parseSemaforo(body: Record<string, unknown>): { semDirecao: string | null; semCritico: number | null; semAtencao: number | null } | { erro: string } {
  const { semDirecao, semCritico, semAtencao } = body;
  if (semDirecao === null || semDirecao === undefined || semDirecao === "") {
    return { semDirecao: null, semCritico: null, semAtencao: null }; // sem semáforo
  }
  if (typeof semDirecao !== "string" || !DIRECOES.has(semDirecao)) return { erro: "semDirecao deve ser menor_ruim ou maior_ruim" };
  const c = Number(semCritico), a = Number(semAtencao);
  if (!Number.isFinite(c) || !Number.isFinite(a)) return { erro: "semCritico e semAtencao devem ser números" };
  // Coerência: em menor_ruim o crítico fica ABAIXO da atenção; em maior_ruim, ACIMA.
  if (semDirecao === "menor_ruim" && c > a) return { erro: "Em 'menor é ruim', o limiar crítico deve ser ≤ o de atenção" };
  if (semDirecao === "maior_ruim" && c < a) return { erro: "Em 'maior é ruim', o limiar crítico deve ser ≥ o de atenção" };
  return { semDirecao, semCritico: c, semAtencao: a };
}

// GET /indicators/config — lista completa (sistema + personalizados)
router.get("/config", async (_req: AuthRequest, res: Response): Promise<void> => {
  const rows = await prisma.indicatorConfig.findMany({ orderBy: [{ ordem: "asc" }, { createdAt: "asc" }] });
  res.json(rows);
});

// POST /indicators/config — cria indicador PERSONALIZADO
router.post("/config", async (req: AuthRequest, res: Response): Promise<void> => {
  const { nome, grupo, tipoDado, formula, numerador, denominador, multiplicador } = req.body ?? {};
  if (typeof nome !== "string" || !nome.trim()) { res.status(400).json({ error: "nome é obrigatório" }); return; }
  if (typeof grupo !== "string" || !grupo.trim()) { res.status(400).json({ error: "grupo é obrigatório" }); return; }
  if (!TIPOS_DADO.has(tipoDado)) { res.status(400).json({ error: "tipoDado inválido (R$, %, Índice ou Dias)" }); return; }
  const num = parseTermos(numerador);
  if (!num) { res.status(400).json({ error: "numerador precisa de ao menos 1 linha do modelo" }); return; }
  const den = denominador == null || (Array.isArray(denominador) && denominador.length === 0) ? null : parseTermos(denominador);
  if (denominador != null && Array.isArray(denominador) && denominador.length > 0 && !den) { res.status(400).json({ error: "denominador inválido" }); return; }
  const sem = parseSemaforo(req.body ?? {});
  if ("erro" in sem) { res.status(400).json({ error: sem.erro }); return; }
  const existente = await prisma.indicatorConfig.findUnique({ where: { nome: nome.trim() } });
  if (existente) { res.status(409).json({ error: "Já existe um indicador com este nome" }); return; }
  const maxOrdem = await prisma.indicatorConfig.aggregate({ _max: { ordem: true } });
  const row = await prisma.indicatorConfig.create({
    data: {
      nome: nome.trim(), sistema: false, ativo: true, grupo: grupo.trim(),
      tipoDado, formula: typeof formula === "string" && formula.trim() ? formula.trim() : null,
      numerador: num as object[], denominador: den ? (den as object[]) : undefined,
      multiplicador: Number.isFinite(Number(multiplicador)) && Number(multiplicador) !== 0 ? Number(multiplicador) : null,
      ...sem, ordem: (maxOrdem._max.ordem ?? 0) + 1,
    },
  });
  res.status(201).json(row);
});

// PUT /indicators/config/:id — sistema: só semáforo/ativo; personalizado: tudo
router.put("/config/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const row = await prisma.indicatorConfig.findUnique({ where: { id: req.params.id as string } });
  if (!row) { res.status(404).json({ error: "Indicador não encontrado" }); return; }
  const body = req.body ?? {};
  const data: Record<string, unknown> = {};

  if (body.semDirecao !== undefined || body.semCritico !== undefined || body.semAtencao !== undefined) {
    const sem = parseSemaforo(body);
    if ("erro" in sem) { res.status(400).json({ error: sem.erro }); return; }
    Object.assign(data, sem);
  }
  if (typeof body.ativo === "boolean") data.ativo = body.ativo;

  if (!row.sistema) {
    if (typeof body.nome === "string" && body.nome.trim()) data.nome = body.nome.trim();
    if (typeof body.grupo === "string" && body.grupo.trim()) data.grupo = body.grupo.trim();
    if (typeof body.tipoDado === "string" && TIPOS_DADO.has(body.tipoDado)) data.tipoDado = body.tipoDado;
    if (typeof body.formula === "string") data.formula = body.formula.trim() || null;
    if (body.numerador !== undefined) {
      const num = parseTermos(body.numerador);
      if (!num) { res.status(400).json({ error: "numerador precisa de ao menos 1 linha" }); return; }
      data.numerador = num;
    }
    if (body.denominador !== undefined) {
      if (body.denominador === null || (Array.isArray(body.denominador) && body.denominador.length === 0)) {
        (data as { denominador: unknown }).denominador = null;
      } else {
        const den = parseTermos(body.denominador);
        if (!den) { res.status(400).json({ error: "denominador inválido" }); return; }
        data.denominador = den;
      }
    }
    if (body.multiplicador !== undefined) {
      const m = Number(body.multiplicador);
      data.multiplicador = Number.isFinite(m) && m !== 0 ? m : null;
    }
  }

  const updated = await prisma.indicatorConfig.update({ where: { id: row.id }, data: data as never });
  res.json(updated);
});

// DELETE /indicators/config/:id — SÓ personalizados (sistema nunca sai do cálculo)
router.delete("/config/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const row = await prisma.indicatorConfig.findUnique({ where: { id: req.params.id as string } });
  if (!row) { res.status(404).json({ error: "Indicador não encontrado" }); return; }
  if (row.sistema) {
    res.status(403).json({ error: "Indicador de sistema não pode ser excluído — a análise, o estágio e a comparação com pares dependem dele. Você pode desativar a exibição." });
    return;
  }
  await prisma.indicatorConfig.delete({ where: { id: row.id } });
  res.status(204).send();
});

export default router;
