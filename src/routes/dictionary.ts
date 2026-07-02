import { Router, Response } from "express";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { bumpDictionaryVersion, getCurrentDictionaryVersion } from "../services/dictionary-version";
import { DEFAULT_BP_MODEL, IGNORAR_DESTINO } from "../services/account-mapper";

const router = Router();
router.use(requireAuth);

// classificacao (do template) → grupo de alto nível; e aliases de grupoConta → código.
const CLASSIF_TO_GRUPO: Record<string, string> = { AC: "AC", AF: "AC", AO: "AC", ANC: "ANC", PC: "PC", PO: "PC", PF: "PC", PNC: "PNC", PL: "PL" };
const GRUPO_ALIASES: Record<string, string> = {
  "ativo circulante": "AC", ac: "AC",
  "ativo nao circulante": "ANC", anc: "ANC",
  "passivo circulante": "PC", pc: "PC",
  "passivo nao circulante": "PNC", pnc: "PNC",
  "patrimonio liquido": "PL", pl: "PL",
};
const normGrp = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

// GET /dictionary/audit — READ ONLY. Reporta entradas de BP cujo DESTINO é de um grupo
// diferente do grupoConta em que a conta foi vista (cruza Ativo/Passivo ou CP/LP). NÃO
// exclui nada — é só um raio-x para o analista decidir. Ignora __IGNORAR__ (intencional)
// e destinos fora do template atual (podem ser de um modelo antigo, não necessariamente erro).
router.get("/audit", async (req: AuthRequest, res: Response): Promise<void> => {
  const rows = await prisma.accountDictionary.findMany({
    where: { OR: [{ userId: null }, { userId: { in: req.scopeUserIds! } }] },
    select: { id: true, nomeOriginal: true, contaDestino: true, grupoConta: true, tipo: true, userId: true },
  });
  const suspeitas: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    if (r.tipo !== "BP" || r.contaDestino === IGNORAR_DESTINO) continue;
    const classif = DEFAULT_BP_MODEL.classifMap.get(r.contaDestino);
    if (!classif) continue; // destino fora do template atual — não auditável com certeza
    const grupoDestino = CLASSIF_TO_GRUPO[classif];
    const grupoEntry = GRUPO_ALIASES[normGrp(r.grupoConta)];
    if (!grupoDestino || !grupoEntry) continue;
    if (grupoDestino !== grupoEntry) {
      suspeitas.push({
        id: r.id, nomeOriginal: r.nomeOriginal, contaDestino: r.contaDestino,
        grupoConta: r.grupoConta, grupoDoDestino: grupoDestino, escopo: r.userId ? "usuário" : "global",
        motivo: `Cruza grupo: destino "${r.contaDestino}" é ${grupoDestino}, mas a conta foi vista em ${grupoEntry}.`,
      });
    }
  }
  res.json({ totalEntradas: rows.length, bp: rows.filter((r) => r.tipo === "BP").length, suspeitas });
});

// Nome de exibição do usuário para o changelog (controle interno).
async function nomeUsuario(userId?: string): Promise<string | null> {
  if (!userId) return null;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return u?.name ?? null;
}

// GET /dictionary/version — versão vigente do dicionário (controle interno).
router.get("/version", async (_req: AuthRequest, res: Response): Promise<void> => {
  res.json({ versao: await getCurrentDictionaryVersion() });
});

// GET /dictionary/versions — changelog (uma linha por mudança), mais recente primeiro.
router.get("/versions", async (req: AuthRequest, res: Response): Promise<void> => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "100")) || 100, 500);
  const offset = parseInt(String(req.query.offset ?? "0")) || 0;
  const [items, total] = await Promise.all([
    prisma.dictionaryVersion.findMany({ orderBy: { versao: "desc" }, take: limit, skip: offset }),
    prisma.dictionaryVersion.count(),
  ]);
  res.json({ items, total, atual: await getCurrentDictionaryVersion() });
});

// GET /dictionary — list all entries for current user (global + user-specific)
// Query params: ?search=, ?tipo=BP|DRE, ?grupo=
router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const { search, tipo, grupo } = req.query;

  const where: any = {
    OR: [
      { userId: null },                        // global seed entries
      { userId: { in: req.scopeUserIds! } },   // entries do workspace (firma)
    ],
  };

  if (tipo) where.tipo = tipo as string;
  if (grupo) where.grupoConta = { contains: grupo as string, mode: "insensitive" };
  if (search) {
    where.AND = [
      {
        OR: [
          { nomeOriginal: { contains: search as string, mode: "insensitive" } },
          { contaDestino: { contains: search as string, mode: "insensitive" } },
        ],
      },
    ];
  }

  const entries = await prisma.accountDictionary.findMany({
    where,
    orderBy: [{ grupoConta: "asc" }, { contaDestino: "asc" }, { nomeOriginal: "asc" }],
  });
  res.json(entries);
});

// GET /dictionary/template — contas-destino disponíveis para os dropdowns,
// agrupadas por grupo. Combina o template canônico de BP com TODOS os pares
// (grupoConta → contaDestino) já presentes no dicionário acessível (global +
// workspace). Assim cobre BP e DRE, e garante que qualquer entrada existente
// seja re-selecionável ao ser editada (o valor sempre está entre as opções).
router.get("/template", async (req: AuthRequest, res: Response): Promise<void> => {
  const { BP_TEMPLATE } = require("../services/financial-templates");
  const { loadActiveDREModel } = require("../services/model-version");
  // Bridge: o dropdown da DRE reflete o MODELO VIGENTE do banco (contas adicionadas no
  // editor de modelos aparecem aqui na hora).
  const dreModel = await loadActiveDREModel();

  const grouped: Record<string, string[]> = {};
  const add = (grupo: string, conta: string): void => {
    if (!grupo || !conta) return;
    if (!grouped[grupo]) grouped[grupo] = [];
    if (!grouped[grupo].includes(conta)) grouped[grupo].push(conta);
  };

  // 1) Contas canônicas do template de BP (agrupadas pelo grupo-pai)
  for (const item of BP_TEMPLATE) {
    add(getParentGroup(item), item.conta);
  }

  // Dropdown da DRE: contas de INPUT do template (não-subtotais) — alvos válidos para
  // reclassificar uma linha da DRE (ex.: custo que caiu em "Outras Despesas" → "Custo
  // Operacional"). Agrupado sob "Resultado (DRE)" para o <optgroup>.
  const dreGrouped: Record<string, string[]> = {
    "Resultado (DRE)": dreModel.lines.filter((l: { subtotal: boolean }) => !l.subtotal).map((l: { conta: string }) => l.conta),
  };
  const addDRE = (conta: string): void => {
    if (!conta) return;
    if (!dreGrouped["Resultado (DRE)"].includes(conta)) dreGrouped["Resultado (DRE)"].push(conta);
  };

  // 2) Contas-destino efetivamente usadas no dicionário (mantém o dropdown em sincronia
  //    com os dados). Roteia por TIPO: entradas de BP vão p/ `grouped`, de DRE p/ `dreGrouped`
  //    — assim o dropdown de BP nunca mostra conta de DRE e vice-versa.
  const used = await prisma.accountDictionary.findMany({
    where: {
      OR: [{ userId: null }, { userId: { in: req.scopeUserIds! } }],
    },
    select: { grupoConta: true, contaDestino: true, tipo: true },
    distinct: ["tipo", "grupoConta", "contaDestino"],
  });
  for (const u of used) {
    if (u.tipo === "DRE") addDRE(u.contaDestino);
    else add(u.grupoConta, u.contaDestino);
  }

  res.json({ template: BP_TEMPLATE, dreTemplate: dreModel.lines, grouped, dreGrouped });
});

// Helper to determine parent group based on classificacao
function getParentGroup(item: { classificacao: string; conta: string; nivel: number }): string {
  if (item.nivel <= 1) return item.conta;
  // Map classificacao to parent
  const map: Record<string, string> = {
    AF: "Ativo Circulante", AO: "Ativo Circulante",
    ANC: "Ativo Não Circulante",
    PO: "Passivo Circulante", PF: "Passivo Circulante",
    PNC: "Passivo Não Circulante",
    PL: "Patrimônio Líquido",
  };
  return map[item.classificacao] || item.conta;
}

// POST /dictionary — add entry
router.post("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const { nomeOriginal, contaDestino, grupoConta, tipo } = req.body;

  if (!nomeOriginal || !contaDestino || !grupoConta) {
    res.status(400).json({ error: "nomeOriginal, contaDestino e grupoConta são obrigatórios" });
    return;
  }

  const entry = await prisma.accountDictionary.create({
    data: {
      nomeOriginal,
      contaDestino,
      grupoConta,
      tipo: tipo || "BP",
      userId: req.userId!,
    },
  });
  await bumpDictionaryVersion({ acao: "add", fonte: "manual", nomeOriginal, contaDestino, grupoConta, tipo: tipo || "BP", criadoPor: await nomeUsuario(req.userId) });
  res.status(201).json(entry);
});

// PUT /dictionary/:id — update entry
router.put("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const existing = await prisma.accountDictionary.findFirst({
    where: { id },
  });

  if (!existing) {
    res.status(404).json({ error: "Entrada não encontrada" });
    return;
  }

  // Pode editar entradas do próprio workspace (não as globais do sistema)
  if (existing.userId !== null && !req.scopeUserIds!.includes(existing.userId)) {
    res.status(403).json({ error: "Sem permissão para editar esta entrada" });
    return;
  }

  const { nomeOriginal, contaDestino, grupoConta } = req.body;

  // If it's a global entry, create a user override instead of modifying
  if (existing.userId === null) {
    const override = await prisma.accountDictionary.create({
      data: {
        nomeOriginal: nomeOriginal || existing.nomeOriginal,
        contaDestino: contaDestino || existing.contaDestino,
        grupoConta: grupoConta || existing.grupoConta,
        tipo: existing.tipo,
        userId: req.userId!,
      },
    });
    await bumpDictionaryVersion({ acao: "edit", fonte: "manual", nomeOriginal: override.nomeOriginal, contaDestino: override.contaDestino, grupoConta: override.grupoConta, tipo: override.tipo, criadoPor: await nomeUsuario(req.userId) });
    res.json(override);
    return;
  }

  const updated = await prisma.accountDictionary.update({
    where: { id },
    data: {
      ...(nomeOriginal && { nomeOriginal }),
      ...(contaDestino && { contaDestino }),
      ...(grupoConta && { grupoConta }),
    },
  });
  await bumpDictionaryVersion({ acao: "edit", fonte: "manual", nomeOriginal: updated.nomeOriginal, contaDestino: updated.contaDestino, grupoConta: updated.grupoConta, tipo: updated.tipo, criadoPor: await nomeUsuario(req.userId) });
  res.json(updated);
});

// DELETE /dictionary/:id — delete entry (only user-owned)
router.delete("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const existing = await prisma.accountDictionary.findFirst({
    where: { id },
  });

  if (!existing) {
    res.status(404).json({ error: "Entrada não encontrada" });
    return;
  }

  if (existing.userId === null) {
    res.status(403).json({ error: "Não é possível excluir entradas globais do sistema" });
    return;
  }

  if (!req.scopeUserIds!.includes(existing.userId)) {
    res.status(403).json({ error: "Sem permissão" });
    return;
  }

  await prisma.accountDictionary.delete({ where: { id } });
  await bumpDictionaryVersion({ acao: "delete", fonte: "manual", nomeOriginal: existing.nomeOriginal, contaDestino: existing.contaDestino, grupoConta: existing.grupoConta, tipo: existing.tipo, criadoPor: await nomeUsuario(req.userId) });
  res.status(204).send();
});

// POST /dictionary/classify — bulk classify unmatched accounts
// Body: { analysisId?: string, entries: Array<{ nomeOriginal, contaDestino, grupoConta }> }
router.post("/classify", async (req: AuthRequest, res: Response): Promise<void> => {
  const { entries, analysisId } = req.body;

  if (!entries || !Array.isArray(entries)) {
    res.status(400).json({ error: "entries deve ser um array" });
    return;
  }

  const created = [];
  const autor = await nomeUsuario(req.userId);
  const rejeitadas: Array<{ nomeOriginal: string; contaDestino: string; motivo: string }> = [];
  for (const entry of entries) {
    if (!entry.nomeOriginal || !entry.contaDestino || !entry.grupoConta) continue;
    const tipoE = entry.tipo || "BP";

    // VALIDAÇÃO CRUZADA (BP): o destino precisa ser do MESMO grupo em que a conta foi
    // vista no documento — nunca cruza Ativo/Passivo nem CP/LP. Protege o dicionário
    // (e os demais IBRs) de um clique errado do analista. __IGNORAR__ passa sempre.
    if (tipoE === "BP" && entry.contaDestino !== IGNORAR_DESTINO) {
      const classif = DEFAULT_BP_MODEL.classifMap.get(entry.contaDestino);
      const grupoDestino = classif ? CLASSIF_TO_GRUPO[classif] : undefined;
      const grupoEntrada = GRUPO_ALIASES[normGrp(entry.grupoConta)];
      if (grupoDestino && grupoEntrada && grupoDestino !== grupoEntrada) {
        rejeitadas.push({
          nomeOriginal: entry.nomeOriginal,
          contaDestino: entry.contaDestino,
          motivo: `"${entry.contaDestino}" pertence a ${grupoDestino}, mas a conta está em ${grupoEntrada} no documento — classificação bloqueada para proteger os demais IBRs.`,
        });
        continue;
      }
    }

    try {
      const chave = { nomeOriginal: entry.nomeOriginal, tipo: tipoE, grupoConta: entry.grupoConta, userId: req.userId! };
      const antes = await prisma.accountDictionary.findUnique({ where: { nomeOriginal_tipo_grupoConta_userId: chave } });
      const result = await prisma.accountDictionary.upsert({
        where: { nomeOriginal_tipo_grupoConta_userId: chave },
        update: { contaDestino: entry.contaDestino },
        create: {
          nomeOriginal: entry.nomeOriginal,
          contaDestino: entry.contaDestino,
          grupoConta: entry.grupoConta,
          tipo: tipoE,
          userId: req.userId!,
        },
      });
      created.push(result);
      // Autofeed: bumpa a versão SÓ quando a entrada é nova ou a conta-destino mudou
      // (re-classificar igual não infla a versão). Registra o IBR de origem.
      if (!antes || antes.contaDestino !== entry.contaDestino) {
        await bumpDictionaryVersion({
          acao: "classify", fonte: "autofeed",
          nomeOriginal: entry.nomeOriginal, contaDestino: entry.contaDestino, grupoConta: entry.grupoConta, tipo: tipoE,
          criadoPor: autor, analysisId: typeof analysisId === "string" ? analysisId : null,
        });
      }
    } catch (err) {
      // skip duplicates
      console.error("Error classifying entry:", entry.nomeOriginal, err);
    }
  }

  res.json({ classified: created.length, entries: created, rejeitadas });
});

export default router;
