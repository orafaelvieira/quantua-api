import { Router, Response } from "express";
import { prisma } from "../db/client";
import { requireAuth, requireInternal, AuthRequest, requireQuantua } from "../middleware/auth";
import { whereEmpresaVisivel, whereRecursoEmpresa, guardaEscritaSuspensao } from "../services/escopo-empresa";
import { bumpDictionaryVersion, getCurrentDictionaryVersion } from "../services/dictionary-version";
import { DEFAULT_BP_MODEL, IGNORAR_DESTINO } from "../services/account-mapper";
import { avaliaBloqueioEstrutural } from "../services/conta-estrutural";
import { prioridadeEscopo, whereCascataDicionario } from "../services/dicionario-escopo";
import { avaliarContaParticular, grupoImediatoDoCaminho } from "../services/conta-particular";

const router = Router();
router.use(requireAuth);
// Dicionário é ativo interno da firma — cliente de portal não lê nem escreve.
router.use(requireInternal);
// SOMENTE CONSULTA: org suspensa (inadimplência) lê mas não escreve.
router.use(guardaEscritaSuspensao("company-body"));

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
    select: { id: true, nomeOriginal: true, contaDestino: true, grupoConta: true, tipo: true, userId: true, companyId: true },
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
        grupoConta: r.grupoConta, grupoDoDestino: grupoDestino, escopo: r.companyId ? "empresa" : r.userId ? "usuário" : "global",
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

  // ?companyId= → CONTEXTO DE EMPRESA: além do global+workspace, inclui as
  // entradas próprias daquela empresa (a cascata que os IBRs dela usam).
  // Sem o parâmetro, entradas de empresa ficam fora (geridas na Validação).
  let companyIdCtx: string | null = null;
  if (typeof req.query.companyId === "string" && req.query.companyId) {
    const c = await prisma.company.findFirst({
      where: { id: req.query.companyId, ...whereEmpresaVisivel(req) },
      select: { id: true },
    });
    if (!c) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
    companyIdCtx = c.id;
  }

  const where: any = {
    OR: [
      { companyId: null, userId: null },                        // global seed entries
      { companyId: null, userId: { in: req.scopeUserIds! } },   // entries do workspace (firma)
      ...(companyIdCtx ? [{ companyId: companyIdCtx }] : []),   // entries da EMPRESA (contexto)
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
  // ?analysisId= → contexto de EMPRESA: o dropdown reflete o modelo DAQUELA
  // empresa (cascata empresa→global). Sem o parâmetro, modelo global (como antes).
  let templateCompanyId: string | null = null;
  if (typeof req.query.analysisId === "string" && req.query.analysisId) {
    const a = await prisma.analysis.findFirst({
      where: { id: req.query.analysisId, ...whereRecursoEmpresa(req) },
      select: { companyId: true },
    });
    templateCompanyId = a?.companyId ?? null;
  } else if (typeof req.query.companyId === "string" && req.query.companyId) {
    // Aba Dicionário & Modelos (contexto direto de empresa, sem análise)
    const c = await prisma.company.findFirst({
      where: { id: req.query.companyId, ...whereEmpresaVisivel(req) },
      select: { id: true },
    });
    templateCompanyId = c?.id ?? null;
  }
  // Bridge: o dropdown da DRE reflete o MODELO VIGENTE do banco (contas adicionadas no
  // editor de modelos aparecem aqui na hora).
  const dreModel = await loadActiveDREModel(templateCompanyId);

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
  // 2) Complementa com destinos usados no dicionário, mas SÓ os que são alvos VÁLIDOS
  //    para o analista: inputs do modelo DRE vigente (o dicionário também mapeia nomes
  //    de documento para SUBTOTAIS — "Lucro Bruto", "EBITDA"… — que servem ao
  //    reconhecimento, nunca ao dropdown). Sentinela __IGNORAR__ nunca aparece.
  const dreInputsModelo = new Set(dreGrouped["Resultado (DRE)"]);
  const addDRE = (conta: string): void => {
    if (!conta || conta === IGNORAR_DESTINO || !dreInputsModelo.has(conta)) return;
    // já está na lista (a lista É o modelo) — mantido por clareza caso o modelo mude
  };
  const used = await prisma.accountDictionary.findMany({
    where: {
      companyId: null, // destinos das entradas de empresa já são contas do modelo
      OR: [{ userId: null }, { userId: { in: req.scopeUserIds! } }],
    },
    select: { grupoConta: true, contaDestino: true, tipo: true },
    distinct: ["tipo", "grupoConta", "contaDestino"],
  });
  for (const u of used) {
    if (u.contaDestino === IGNORAR_DESTINO) continue; // sentinela — nunca é opção
    if (u.tipo === "DRE") addDRE(u.contaDestino);
    else add(u.grupoConta, u.contaDestino);
  }

  // Guia "entra/não entra" por conta (linhas dos modelos VIGENTES) — tooltips dos dropdowns.
  const linhasGuia = await prisma.standardModelLine.findMany({
    where: {
      model: { ativo: true, OR: [{ companyId: null }, ...(templateCompanyId ? [{ companyId: templateCompanyId }] : [])] },
      NOT: { descricao: null },
    },
    select: { nome: true, descricao: true },
  });
  const descricoes: Record<string, string> = {};
  for (const l of linhasGuia) if (l.descricao && !descricoes[l.nome]) descricoes[l.nome] = l.descricao;

  res.json({ template: BP_TEMPLATE, dreTemplate: dreModel.lines, grouped, dreGrouped, descricoes });
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
router.post("/", requireQuantua, async (req: AuthRequest, res: Response): Promise<void> => {
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

  // Entradas de EMPRESA são geridas pela tela "Validação de contas" (aprovar/
  // reprovar) — editar aqui misturaria escopos.
  if (existing.companyId !== null) {
    res.status(403).json({ error: "Entrada de empresa — gerencie pela tela Validação de contas." });
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

  // Entrada de EMPRESA: remover é permitido no contexto dela (a conta volta a
  // herdar o global). Escopo validado pela POSSE da empresa, não pelo autor.
  if (existing.companyId !== null) {
    const dona = await prisma.company.findFirst({
      where: { id: existing.companyId, ...whereEmpresaVisivel(req) },
      select: { id: true },
    });
    if (!dona) { res.status(403).json({ error: "Sem permissão" }); return; }
  } else if (!req.scopeUserIds!.includes(existing.userId)) {
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

  // CASCATA POR EMPRESA (2026-07-17): o autofeed do IBR grava no escopo da
  // EMPRESA do IBR (companyId), nunca mais no workspace inteiro — uma conta nova
  // classificada aqui não "suja" os IBRs das outras empresas. A promoção ao
  // global é humana, na tela "Validação de contas".
  let companyIdClassify: string | null = null;
  // Caminho do documento por conta (dos não-mapeados do IBR): alimenta o
  // detector de conta PARTICULAR e a promoção "como regra de grupo" na fila.
  const caminhoPorConta = new Map<string, string>();
  if (typeof analysisId === "string" && analysisId) {
    const a = await prisma.analysis.findFirst({
      where: { id: analysisId, ...whereRecursoEmpresa(req) },
      select: { companyId: true, dadosEstruturados: true },
    });
    companyIdClassify = a?.companyId ?? null;
    const nms = (a?.dadosEstruturados as any)?.naoMapeados;
    if (Array.isArray(nms)) {
      for (const nm of nms) {
        if (nm?.nome && nm?.grupo && String(nm.grupo).includes(">")) {
          caminhoPorConta.set(`${String(nm.nome).toLowerCase()}|${nm.tipo ?? "BP"}`, String(nm.grupo));
        }
      }
    }
  } else if (typeof req.body?.companyId === "string" && req.body.companyId) {
    // Aba "Dicionário & Modelos" do IBR: edição direta do dicionário DA EMPRESA
    // (sem análise específica) — mesma gravação por empresa, escopo validado.
    const c = await prisma.company.findFirst({
      where: { id: req.body.companyId, ...whereEmpresaVisivel(req) },
      select: { id: true },
    });
    if (!c) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
    companyIdClassify = c.id;
  }

  const created = [];
  const autor = await nomeUsuario(req.userId);
  const rejeitadas: Array<{ nomeOriginal: string; contaDestino: string; motivo: string }> = [];
  for (const entry of entries) {
    if (!entry.nomeOriginal || !entry.contaDestino || !entry.grupoConta) continue;
    const tipoE = entry.tipo || "BP";

    // TRAVA ESTRUTURAL: conta de AGRUPAMENTO (ex.: "Exigível a Curto Prazo") não
    // pode virar conta-FOLHA no dicionário — colapsaria o grupo e comprometeria os
    // demais IBRs. __IGNORAR__ passa sempre (não aprende nada).
    if (entry.contaDestino !== IGNORAR_DESTINO) {
      const bloqueio = avaliaBloqueioEstrutural(entry.nomeOriginal, entry.contaDestino);
      if (bloqueio.bloqueado) {
        rejeitadas.push({ nomeOriginal: entry.nomeOriginal, contaDestino: entry.contaDestino, motivo: bloqueio.motivo! });
        continue;
      }
    }

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
      const chaveBase = { nomeOriginal: entry.nomeOriginal, tipo: tipoE, grupoConta: entry.grupoConta };

      if (companyIdClassify) {
        // Cascata atual desta conta (global + workspace + a empresa do IBR).
        // CASE-INSENSITIVE: o documento traz "CLIENTES", o seed tem "Clientes" —
        // é a mesma conta (o fold já compara sem caixa; aqui precisa igualar,
        // senão a personalização entraria na fila como se fosse conta nova).
        // DRE: a tela usa o DESTINO como `grupoConta`. Filtrar por ele aqui fazia
        // com que TROCAR o destino não encontrasse a entrada existente e criasse
        // uma SEGUNDA linha — e a antiga continuava vencendo no fold (a blindagem
        // contextual prefere o destino cujo bloco casa com o caminho do documento).
        // Resultado: "alterei a classificação e ele não respeitou". Para DRE a
        // identidade é (nome, tipo, escopo); para BP o grupo é o grupo REAL do
        // documento (a mesma conta em PC e PNC são distintas) e continua na chave.
        const existentes = await prisma.accountDictionary.findMany({
          where: {
            nomeOriginal: { equals: entry.nomeOriginal, mode: "insensitive" },
            ...(tipoE === "DRE" ? {} : { grupoConta: { equals: entry.grupoConta, mode: "insensitive" as const } }),
            tipo: tipoE,
            ...whereCascataDicionario(req.scopeUserIds!, companyIdClassify),
          },
        });
        const vencedor = existentes.length
          ? existentes.reduce((a, b) => (prioridadeEscopo(b) >= prioridadeEscopo(a) ? b : a))
          : null;
        // Já resolvido pelo global/workspace com o MESMO destino → nada a gravar
        // (não cria entrada de empresa redundante nem fila de validação à toa).
        if (vencedor && vencedor.companyId === null && vencedor.contaDestino === entry.contaDestino) {
          created.push(vencedor);
          continue;
        }
        // Regra da fila (decisão 2026-07-17): só conta NOVA (sem equivalente no
        // GLOBAL) entra na validação da Quantua ("pendente"). Personalizar uma
        // conta que o global já mapeia é ajuste LOCAL da empresa ("local") —
        // vale só para ela, sem fila.
        // PARTICULAR (LGPD, 2026-07-18): nome de terceiro (mútuo/cliente/
        // fornecedor/razão social) NUNCA entra na fila — nasce e fica na
        // empresa ("particular"). O conhecimento genérico é promovível como
        // REGRA DE GRUPO pela fila das demais.
        const caminho = caminhoPorConta.get(`${entry.nomeOriginal.toLowerCase()}|${tipoE}`) ?? null;
        const globalEquivalente = existentes.find((e) => e.companyId === null && e.userId === null);
        const particular = avaliarContaParticular(entry.nomeOriginal, caminho ?? entry.grupoConta);
        const revisaoNova = globalEquivalente ? "local" : particular.particular ? "particular" : "pendente";
        const daEmpresaTodas = existentes.filter((e) => e.companyId === companyIdClassify);
        // Escolhe a linha a MANTER: preferir a que já tem a chave-alvo
        // (nome+tipo+grupoConta) — senão o update mudaria o grupoConta para uma
        // chave JÁ OCUPADA por outra linha e a unique estouraria (era o que fazia
        // a alteração ser silenciosamente descartada).
        const chaveIgual = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
        const daEmpresa = daEmpresaTodas.find((e) => chaveIgual(e.grupoConta, entry.grupoConta)) ?? daEmpresaTodas[0];
        // Duplicatas herdadas do bug (DRE reclassificada antes desta correção):
        // CANCELA as sobrando — saem da cascata do fold sem apagar o histórico
        // (política: nunca deletar). A mantida é atualizada logo abaixo.
        const duplicatas = daEmpresaTodas.filter((e) => e.id !== daEmpresa?.id);
        if (duplicatas.length > 0) {
          await prisma.accountDictionary.updateMany({
            where: { id: { in: duplicatas.map((e) => e.id) } },
            data: { revisao: "cancelada", revisaoMotivo: "Duplicata de reclassificação da DRE — substituída pela classificação atual." },
          });
        }
        let result;
        let mudou = false;
        if (daEmpresa) {
          // Muda quando: destino diferente; entrada CANCELADA sendo reclassificada
          // (revive); ou o caminho do documento chegou agora (detector/regra de
          // grupo passam a funcionar para entradas antigas).
          mudou = daEmpresa.contaDestino !== entry.contaDestino ||
            daEmpresa.revisao === "cancelada" ||
            duplicatas.length > 0 ||
            (caminho !== null && !daEmpresa.grupoCaminho);
          result = mudou
            ? await prisma.accountDictionary.update({
                where: { id: daEmpresa.id },
                // Reclassificar reabre a revisão (o destino proposto mudou). Na DRE
                // o grupoConta acompanha o destino (convenção da tela).
                data: {
                  contaDestino: entry.contaDestino, userId: req.userId!,
                  ...(tipoE === "DRE" ? { grupoConta: entry.grupoConta } : {}),
                  revisao: revisaoNova, revisadoPor: null, revisadoEm: null, revisaoMotivo: particular.motivo,
                  ...(caminho ? { grupoCaminho: caminho } : {}),
                },
              })
            : daEmpresa;
        } else {
          mudou = true;
          result = await prisma.accountDictionary.create({
            data: { ...chaveBase, contaDestino: entry.contaDestino, userId: req.userId!, companyId: companyIdClassify, revisao: revisaoNova, revisaoMotivo: particular.motivo, grupoCaminho: caminho },
          });
        }
        created.push(result);
        if (mudou) {
          await bumpDictionaryVersion({
            acao: "classify", fonte: "autofeed",
            nomeOriginal: entry.nomeOriginal, contaDestino: entry.contaDestino, grupoConta: entry.grupoConta, tipo: tipoE,
            criadoPor: autor, analysisId, companyId: companyIdClassify,
          });
        }
        continue;
      }

      // Sem análise (chamada avulsa/legado): comportamento anterior — entrada de workspace.
      const antes = await prisma.accountDictionary.findFirst({ where: { ...chaveBase, userId: req.userId!, companyId: null } });
      const result = antes
        ? await prisma.accountDictionary.update({ where: { id: antes.id }, data: { contaDestino: entry.contaDestino } })
        : await prisma.accountDictionary.create({ data: { ...chaveBase, contaDestino: entry.contaDestino, userId: req.userId! } });
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

// ── VALIDAÇÃO DE CONTAS (2026-07-17) ─────────────────────────────────────────
// Entradas criadas no escopo de EMPRESA durante um IBR entram numa fila de
// revisão humana. APROVAR promove ao dicionário GLOBAL (novas empresas herdam);
// REPROVAR mantém a entrada valendo SÓ para aquela empresa. Nada é automático.

// Aprovar/reprovar mexe no dicionário global → mesmo gate do modelo padrão
// (partner; role null = contas antigas de sócio).
async function podeValidarGlobal(userId?: string): Promise<boolean> {
  if (!userId) return false;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, tipoUsuario: true } });
  if (!u) return false;
  // F2 SaaS: externo NUNCA aprova/reprova para o dicionário global.
  if (u.tipoUsuario === "empresa" || u.tipoUsuario === "parceiro") return false;
  return !u.role || u.role === "partner";
}

async function companiesDoEscopo(scopeUserIds: string[]): Promise<Map<string, string>> {
  const companies = await prisma.company.findMany({
    where: { userId: { in: scopeUserIds } },
    select: { id: true, razaoSocial: true, nomeFantasia: true },
  });
  return new Map(companies.map((c) => [c.id, c.nomeFantasia || c.razaoSocial]));
}

// GET /dictionary/validacao?status=pendente|todas — fila de revisão + histórico.
router.get("/validacao", async (req: AuthRequest, res: Response): Promise<void> => {
  const status = String(req.query.status ?? "pendente");
  const nomes = await companiesDoEscopo(req.scopeUserIds!);
  const companyIds = [...nomes.keys()];
  if (!companyIds.length) { res.json({ itens: [], pendentes: 0, podeValidar: await podeValidarGlobal(req.userId) }); return; }

  const [rows, pendentes] = await Promise.all([
    prisma.accountDictionary.findMany({
      where: { companyId: { in: companyIds }, ...(status === "todas" ? {} : { revisao: "pendente" }) },
      orderBy: [{ revisao: "asc" }, { updatedAt: "desc" }],
      take: 500,
    }),
    prisma.accountDictionary.count({ where: { companyId: { in: companyIds }, revisao: "pendente" } }),
  ]);

  // Conflito com o global: se já existe entrada global para a MESMA conta, a
  // aprovação vai ALTERAR o destino global — o analista precisa ver isso.
  const globais = rows.length
    ? await prisma.accountDictionary.findMany({
        where: {
          userId: null, companyId: null,
          OR: rows.map((r) => ({
            nomeOriginal: { equals: r.nomeOriginal, mode: "insensitive" as const },
            tipo: r.tipo,
            grupoConta: { equals: r.grupoConta, mode: "insensitive" as const },
          })),
        },
        select: { nomeOriginal: true, tipo: true, grupoConta: true, contaDestino: true },
      })
    : [];
  const globalDe = new Map(globais.map((g) => [`${g.nomeOriginal.toLowerCase()}|${g.tipo}|${g.grupoConta.toLowerCase()}`, g.contaDestino]));

  res.json({
    itens: rows.map((r) => ({
      id: r.id, nomeOriginal: r.nomeOriginal, contaDestino: r.contaDestino, grupoConta: r.grupoConta,
      tipo: r.tipo, revisao: r.revisao, revisadoPor: r.revisadoPor, revisadoEm: r.revisadoEm, revisaoMotivo: r.revisaoMotivo,
      grupoCaminho: r.grupoCaminho, grupoImediato: grupoImediatoDoCaminho(r.grupoCaminho),
      particular: avaliarContaParticular(r.nomeOriginal, r.grupoCaminho ?? r.grupoConta),
      criadoEm: r.createdAt, atualizadoEm: r.updatedAt,
      empresa: nomes.get(r.companyId!) ?? r.companyId,
      globalAtual: globalDe.get(`${r.nomeOriginal.toLowerCase()}|${r.tipo}|${r.grupoConta.toLowerCase()}`) ?? null,
    })),
    pendentes,
    podeValidar: await podeValidarGlobal(req.userId),
  });
});

// POST /dictionary/validacao/:id/aprovar — promove a entrada ao dicionário GLOBAL.
router.post("/validacao/:id/aprovar", async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await podeValidarGlobal(req.userId))) { res.status(403).json({ error: "Aprovar contas para o dicionário global é ação de sócio (partner)." }); return; }
  const nomes = await companiesDoEscopo(req.scopeUserIds!);
  const row = await prisma.accountDictionary.findFirst({
    where: { id: req.params.id as string, companyId: { in: [...nomes.keys()] } },
  });
  if (!row || !row.companyId) { res.status(404).json({ error: "Entrada de empresa não encontrada" }); return; }
  // Só o que está NA FILA é promovível: ajustes "local" (personalização de conta
  // que o global já tem) não vão ao global — decisão do usuário 2026-07-17.
  if (row.revisao !== "pendente") { res.status(409).json({ error: `Entrada não está pendente (${row.revisao ?? "sem revisão"}).` }); return; }

  // Mesmas travas do classify — o global protege TODOS os clientes.
  if (row.contaDestino !== IGNORAR_DESTINO) {
    const bloqueio = avaliaBloqueioEstrutural(row.nomeOriginal, row.contaDestino);
    if (bloqueio.bloqueado) { res.status(422).json({ error: bloqueio.motivo }); return; }
  }

  // TRAVA LGPD (2026-07-18): nome com cara de PARTICULAR (terceiro) não sobe ao
  // global sem confirmação consciente; CNPJ/CPF no nome NUNCA sobe (sem override).
  const particularAprovar = avaliarContaParticular(row.nomeOriginal, row.grupoCaminho ?? row.grupoConta);
  if (particularAprovar.bloqueioDuro) {
    res.status(422).json({ error: `Promoção bloqueada: ${particularAprovar.motivo}. Use "Aprovar como regra de grupo" ou reprove.` });
    return;
  }
  if (particularAprovar.particular && req.body?.confirmarParticular !== true) {
    res.status(422).json({
      code: "PARTICULAR",
      error: `Esta conta parece PARTICULAR da empresa (${particularAprovar.motivo}). Promover ao global exporia o nome a todos os clientes da plataforma. Prefira "Aprovar como regra de grupo" ou reprove; para promover mesmo assim, confirme.`,
    });
    return;
  }

  const validador = await nomeUsuario(req.userId);
  // Case-insensitive: promover "CLIENTES" quando o global tem "Clientes" deve
  // ATUALIZAR a entrada existente, nunca criar uma quase-duplicata de caixa.
  const global = await prisma.accountDictionary.findFirst({
    where: {
      nomeOriginal: { equals: row.nomeOriginal, mode: "insensitive" },
      tipo: row.tipo,
      grupoConta: { equals: row.grupoConta, mode: "insensitive" },
      userId: null, companyId: null,
    },
  });
  // revisao "promovida" na entrada GLOBAL = marcador para o sync do seed no boot:
  // decisão humana não é revertida nem apagada pelo arquivo oficial.
  if (global && global.contaDestino !== row.contaDestino) {
    await prisma.accountDictionary.update({ where: { id: global.id }, data: { contaDestino: row.contaDestino, revisao: "promovida" } });
  } else if (!global) {
    await prisma.accountDictionary.create({
      data: { nomeOriginal: row.nomeOriginal, contaDestino: row.contaDestino, grupoConta: row.grupoConta, tipo: row.tipo, userId: null, companyId: null, revisao: "promovida" },
    });
  }
  const atualizado = await prisma.accountDictionary.update({
    where: { id: row.id },
    data: { revisao: "aprovada", revisadoPor: validador, revisadoEm: new Date(), revisaoMotivo: null },
  });
  await bumpDictionaryVersion({
    acao: "promover", fonte: "validacao",
    nomeOriginal: row.nomeOriginal, contaDestino: row.contaDestino, grupoConta: row.grupoConta, tipo: row.tipo,
    criadoPor: validador, companyId: row.companyId,
    nota: global && global.contaDestino !== row.contaDestino
      ? `Destino global alterado: "${global.contaDestino}" → "${row.contaDestino}" (promoção da empresa ${nomes.get(row.companyId)}).`
      : `Promovida ao global a partir da empresa ${nomes.get(row.companyId)}.`,
  });
  res.json({ ok: true, entrada: atualizado });
});

// POST /dictionary/validacao/reavaliar — reroda o detector de conta PARTICULAR
// nas entradas PENDENTES do escopo e move as detectadas para "particular" (saem
// da fila). Usado após ajustes no detector para limpar a fila de nomes de
// terceiros que subiram antes da regra (ex.: "Belagro Transportes").
router.post("/validacao/reavaliar", async (req: AuthRequest, res: Response): Promise<void> => {
  const nomes = await companiesDoEscopo(req.scopeUserIds!);
  const companyIds = [...nomes.keys()];
  if (!companyIds.length) { res.json({ movidas: 0 }); return; }
  const pendentes = await prisma.accountDictionary.findMany({
    where: { companyId: { in: companyIds }, revisao: "pendente" },
  });
  let movidas = 0;
  for (const row of pendentes) {
    const av = avaliarContaParticular(row.nomeOriginal, row.grupoCaminho ?? row.grupoConta);
    if (!av.particular) continue;
    await prisma.accountDictionary.update({
      where: { id: row.id },
      data: { revisao: "particular", revisaoMotivo: av.motivo },
    });
    movidas++;
  }
  res.json({ movidas, avaliadas: pendentes.length });
});

// POST /dictionary/validacao/:id/aprovar-grupo — promove ao global a REGRA DO
// GRUPO ("EMPRÉSTIMOS A PESSOAS LIGADAS" → destino), NUNCA o nome do terceiro.
// O fold classifica no nó mais alto que mapeia (a subárvore absorve), então a
// regra beneficia TODAS as empresas sem expor nome de contraparte (LGPD).
router.post("/validacao/:id/aprovar-grupo", async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await podeValidarGlobal(req.userId))) { res.status(403).json({ error: "Aprovar contas para o dicionário global é ação de sócio (partner)." }); return; }
  const nomes = await companiesDoEscopo(req.scopeUserIds!);
  const row = await prisma.accountDictionary.findFirst({
    where: { id: req.params.id as string, companyId: { in: [...nomes.keys()] } },
  });
  if (!row || !row.companyId) { res.status(404).json({ error: "Entrada de empresa não encontrada" }); return; }
  if (row.revisao !== "pendente" && row.revisao !== "particular") { res.status(409).json({ error: `Entrada não está na fila (${row.revisao ?? "sem revisão"}).` }); return; }

  const nomeGrupo = grupoImediatoDoCaminho(row.grupoCaminho);
  if (!nomeGrupo) { res.status(400).json({ error: "Sem caminho do documento nesta entrada — não dá para derivar a regra de grupo. Reclassifique a conta na auditoria do IBR (o caminho é capturado lá) ou aprove/reprove o nome literal." }); return; }
  // O nome do grupo também passa pelas travas: estrutural canônica e particular.
  const particularGrupo = avaliarContaParticular(nomeGrupo, row.grupoCaminho);
  if (particularGrupo.particular) { res.status(422).json({ error: `O próprio grupo ("${nomeGrupo}") parece nome de terceiro (${particularGrupo.motivo}) — nada a promover.` }); return; }
  const bloqueio = avaliaBloqueioEstrutural(nomeGrupo, row.contaDestino);
  if (bloqueio.bloqueado) { res.status(422).json({ error: bloqueio.motivo }); return; }

  const validador = await nomeUsuario(req.userId);
  const globalGrupo = await prisma.accountDictionary.findFirst({
    where: {
      nomeOriginal: { equals: nomeGrupo, mode: "insensitive" },
      tipo: row.tipo,
      grupoConta: { equals: row.grupoConta, mode: "insensitive" },
      userId: null, companyId: null,
    },
  });
  if (globalGrupo && globalGrupo.contaDestino !== row.contaDestino) {
    await prisma.accountDictionary.update({ where: { id: globalGrupo.id }, data: { contaDestino: row.contaDestino, revisao: "promovida" } });
  } else if (!globalGrupo) {
    await prisma.accountDictionary.create({
      data: { nomeOriginal: nomeGrupo, contaDestino: row.contaDestino, grupoConta: row.grupoConta, tipo: row.tipo, userId: null, companyId: null, revisao: "promovida", grupoCaminho: row.grupoCaminho },
    });
  }
  // A entrada da empresa (com o nome do terceiro) fica onde está: PARTICULAR dela.
  const atualizado = await prisma.accountDictionary.update({
    where: { id: row.id },
    data: { revisao: "particular", revisadoPor: validador, revisadoEm: new Date(), revisaoMotivo: `Regra de grupo promovida ao global ("${nomeGrupo}" → ${row.contaDestino}); o nome permanece só nesta empresa.` },
  });
  await bumpDictionaryVersion({
    acao: "promover", fonte: "validacao",
    nomeOriginal: nomeGrupo, contaDestino: row.contaDestino, grupoConta: row.grupoConta, tipo: row.tipo,
    criadoPor: validador, companyId: row.companyId,
    nota: `REGRA DE GRUPO promovida a partir de "${row.nomeOriginal}" (${nomes.get(row.companyId)}) — o nome da contraparte NÃO foi ao global (LGPD).`,
  });
  res.json({ ok: true, entrada: atualizado, regraGrupo: { nomeOriginal: nomeGrupo, contaDestino: row.contaDestino } });
});

// POST /dictionary/:id/enviar-validacao — escape para falso positivo do detector:
// a empresa/analista pede que uma conta marcada "particular" entre na fila global.
router.post("/:id/enviar-validacao", async (req: AuthRequest, res: Response): Promise<void> => {
  const nomes = await companiesDoEscopo(req.scopeUserIds!);
  const row = await prisma.accountDictionary.findFirst({
    where: { id: req.params.id as string, companyId: { in: [...nomes.keys()] } },
  });
  if (!row) { res.status(404).json({ error: "Entrada não encontrada" }); return; }
  if (row.revisao !== "particular" && row.revisao !== "reprovada") { res.status(409).json({ error: `Só entradas particulares/reprovadas podem ser reenviadas (${row.revisao ?? "sem revisão"}).` }); return; }
  const atualizado = await prisma.accountDictionary.update({
    where: { id: row.id },
    data: { revisao: "pendente", revisadoPor: null, revisadoEm: null, revisaoMotivo: null },
  });
  res.json({ ok: true, entrada: atualizado });
});

// GET /dictionary/global/particulares — VARREDURA LGPD retroativa do global:
// entradas já promovidas/seedadas com cara de nome de terceiro, para o time
// revisar e cancelar (o cancelamento v123 tira da cascata sem apagar histórico).
router.get("/global/particulares", requireQuantua, async (req: AuthRequest, res: Response): Promise<void> => {
  const globais = await prisma.accountDictionary.findMany({
    where: { userId: null, companyId: null },
    orderBy: [{ grupoConta: "asc" }, { nomeOriginal: "asc" }],
  });
  const suspeitas = globais
    // Fora da varredura: canceladas e as JÁ REVISADAS/mantidas por um humano.
    .filter((g) => g.revisao !== "cancelada" && !g.lgpdRevisadoEm)
    .map((g) => ({ g, av: avaliarContaParticular(g.nomeOriginal, g.grupoCaminho ?? g.grupoConta) }))
    .filter(({ av }) => av.particular)
    .map(({ g, av }) => ({
      id: g.id, nomeOriginal: g.nomeOriginal, contaDestino: g.contaDestino,
      grupoConta: g.grupoConta, tipo: g.tipo, motivo: av.motivo, bloqueioDuro: av.bloqueioDuro,
    }));
  res.json({ total: globais.length, suspeitas });
});

// POST /dictionary/:id/lgpd-ok — marca uma entrada GLOBAL como revisada e
// MANTIDA (falso positivo do detector — não é dado pessoal). Não altera o
// mapeamento; só a tira das varreduras seguintes. Ação de sócio (atestação
// sobre o dicionário global), com registro de quem revisou.
router.post("/:id/lgpd-ok", async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await podeValidarGlobal(req.userId))) { res.status(403).json({ error: "Revisar o dicionário global é ação de sócio (partner)." }); return; }
  const row = await prisma.accountDictionary.findUnique({ where: { id: req.params.id as string } });
  if (!row || row.companyId !== null || row.userId !== null) { res.status(404).json({ error: "Entrada global não encontrada" }); return; }
  const validador = await nomeUsuario(req.userId);
  const atualizado = await prisma.accountDictionary.update({
    where: { id: row.id },
    data: { lgpdRevisadoEm: new Date(), lgpdRevisadoPor: validador },
  });
  res.json({ ok: true, entrada: atualizado });
});

// POST /dictionary/validacao/:id/reprovar — mantém a entrada SÓ na empresa.
router.post("/validacao/:id/reprovar", async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await podeValidarGlobal(req.userId))) { res.status(403).json({ error: "Reprovar contas da fila de validação é ação de sócio (partner)." }); return; }
  const nomes = await companiesDoEscopo(req.scopeUserIds!);
  const row = await prisma.accountDictionary.findFirst({
    where: { id: req.params.id as string, companyId: { in: [...nomes.keys()] } },
  });
  if (!row || !row.companyId) { res.status(404).json({ error: "Entrada de empresa não encontrada" }); return; }
  if (row.revisao !== "pendente") { res.status(409).json({ error: `Entrada não está pendente (${row.revisao ?? "sem revisão"}).` }); return; }

  const validador = await nomeUsuario(req.userId);
  // MOTIVO OBRIGATÓRIO (decisão do usuário 2026-07-18): a reprovação fica
  // registrada com autor, data e razão — auditável e visível na fila ("Todas").
  const motivo = typeof req.body?.motivo === "string" ? req.body.motivo.trim().slice(0, 400) : "";
  if (!motivo) { res.status(400).json({ error: "Informe o motivo da reprovação." }); return; }
  const atualizado = await prisma.accountDictionary.update({
    where: { id: row.id },
    data: { revisao: "reprovada", revisadoPor: validador, revisadoEm: new Date(), revisaoMotivo: motivo },
  });
  await bumpDictionaryVersion({
    acao: "reprovar", fonte: "validacao",
    nomeOriginal: row.nomeOriginal, contaDestino: row.contaDestino, grupoConta: row.grupoConta, tipo: row.tipo,
    criadoPor: validador, companyId: row.companyId,
    nota: `Reprovada: ${motivo}`,
  });
  res.json({ ok: true, entrada: atualizado });
});

// ── CANCELAMENTO (2026-07-18): inclusão errada sai da cascata dos folds sem
// apagar o histórico (política: nunca deletar). GLOBAL cancelada deixa de ser
// herdada por QUALQUER empresa (novas inclusive); entrada de EMPRESA cancelada
// sai das próximas análises daquela empresa. Reversível (reativar) e, no
// classify, re-classificar a mesma conta revive a entrada naturalmente. ──

/** Carrega a entrada e valida a permissão: global/workspace = sócio; empresa = escopo. */
async function entradaParaCancelamento(req: AuthRequest, res: Response): Promise<{ row: any; escopoGlobal: boolean; nomes: Map<string, string> } | null> {
  const row = await prisma.accountDictionary.findUnique({ where: { id: req.params.id as string } });
  if (!row) { res.status(404).json({ error: "Entrada não encontrada" }); return null; }
  const nomes = await companiesDoEscopo(req.scopeUserIds!);
  if (row.companyId) {
    if (!nomes.has(row.companyId)) { res.status(404).json({ error: "Entrada não encontrada" }); return null; }
    return { row, escopoGlobal: false, nomes };
  }
  // global (seed) ou workspace: mexer afeta todas as empresas → ação de sócio
  if (!(await podeValidarGlobal(req.userId))) {
    res.status(403).json({ error: "Cancelar/reativar contas do dicionário global é ação de sócio (partner)." });
    return null;
  }
  return { row, escopoGlobal: true, nomes };
}

// POST /dictionary/:id/cancelar — tira a entrada da cascata (não apaga).
router.post("/:id/cancelar", async (req: AuthRequest, res: Response): Promise<void> => {
  const ctx = await entradaParaCancelamento(req, res);
  if (!ctx) return;
  const { row, escopoGlobal, nomes } = ctx;
  if (row.revisao === "cancelada") { res.status(409).json({ error: "Entrada já está cancelada." }); return; }
  const validador = await nomeUsuario(req.userId);
  const motivo = typeof req.body?.motivo === "string" ? req.body.motivo.trim().slice(0, 400) : null;
  const atualizado = await prisma.accountDictionary.update({
    where: { id: row.id },
    data: { revisao: "cancelada", revisadoPor: validador, revisadoEm: new Date(), revisaoMotivo: motivo },
  });
  await bumpDictionaryVersion({
    acao: "cancelar", fonte: escopoGlobal ? "dicionario-global" : "dicionario-empresa",
    nomeOriginal: row.nomeOriginal, contaDestino: row.contaDestino, grupoConta: row.grupoConta, tipo: row.tipo,
    criadoPor: validador, companyId: row.companyId,
    nota: escopoGlobal
      ? `Cancelada no dicionário GLOBAL${motivo ? `: ${motivo}` : ""} — deixa de ser herdada por qualquer empresa.`
      : `Cancelada na empresa ${nomes.get(row.companyId!) ?? row.companyId}${motivo ? `: ${motivo}` : ""} — sai das próximas análises.`,
  });
  res.json({ ok: true, entrada: atualizado });
});

// POST /dictionary/:id/reativar — volta a valer na cascata.
router.post("/:id/reativar", async (req: AuthRequest, res: Response): Promise<void> => {
  const ctx = await entradaParaCancelamento(req, res);
  if (!ctx) return;
  const { row, escopoGlobal, nomes } = ctx;
  if (row.revisao !== "cancelada") { res.status(409).json({ error: "Entrada não está cancelada." }); return; }
  const validador = await nomeUsuario(req.userId);
  // Estado de volta: global → "promovida" (decisão humana — o seed não reverte);
  // workspace → sem revisão; empresa → recomputa a fila (equivalente global?
  // "local" : "pendente"), a mesma regra do classify.
  let revisaoNova: string | null = null;
  if (escopoGlobal) {
    revisaoNova = row.companyId === null && row.userId === null ? "promovida" : null;
  } else {
    const globalEq = await prisma.accountDictionary.findFirst({
      where: {
        nomeOriginal: { equals: row.nomeOriginal, mode: "insensitive" },
        tipo: row.tipo,
        grupoConta: { equals: row.grupoConta, mode: "insensitive" },
        userId: null, companyId: null,
      },
      select: { id: true },
    });
    revisaoNova = globalEq ? "local" : "pendente";
  }
  const atualizado = await prisma.accountDictionary.update({
    where: { id: row.id },
    data: { revisao: revisaoNova, revisadoPor: validador, revisadoEm: new Date(), revisaoMotivo: null },
  });
  await bumpDictionaryVersion({
    acao: "reativar", fonte: escopoGlobal ? "dicionario-global" : "dicionario-empresa",
    nomeOriginal: row.nomeOriginal, contaDestino: row.contaDestino, grupoConta: row.grupoConta, tipo: row.tipo,
    criadoPor: validador, companyId: row.companyId,
    nota: escopoGlobal
      ? "Reativada no dicionário global — volta a ser herdada."
      : `Reativada na empresa ${nomes.get(row.companyId!) ?? row.companyId}.`,
  });
  res.json({ ok: true, entrada: atualizado });
});

export default router;
