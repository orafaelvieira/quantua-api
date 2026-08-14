import { Router, Response } from "express";
import { prisma } from "../db/client";
import { requireAuth, requireInternal, AuthRequest, requireQuantua } from "../middleware/auth";
import { whereEmpresaVisivel, whereRecursoEmpresa, guardaEscritaSuspensao } from "../services/escopo-empresa";
import { bumpDictionaryVersion, getCurrentDictionaryVersion } from "../services/dictionary-version";
import { DEFAULT_BP_MODEL, IGNORAR_DESTINO } from "../services/account-mapper";
import { avaliaBloqueioEstrutural } from "../services/conta-estrutural";
import { acharNaCamada, prioridadeEscopo, resolverCascataDicionario, situacaoDaCascata, whereCascataDicionario, whereCascataDicionarioAtiva } from "../services/dicionario-escopo";
import { avaliarContaParticular, grupoImediatoDoCaminho } from "../services/conta-particular";
import { limparNomeConta } from "../services/nome-conta";
import { avaliaValorNoNome } from "../services/valor-no-nome";
import { planejarDissolucaoWorkspace } from "../services/dissolver-workspace";

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
  // ESCOPO DO CHANGELOG (02/08/2026, auditoria multi-tenant): as notas gravadas
  // aqui citam NOME DE EMPRESA e de conta ("cancelada na empresa X", "regra de
  // grupo promovida a partir de…"). Sem filtro, o changelog inteiro — de todos
  // os clientes de todas as firmas — era legível por qualquer usuário interno.
  // Passa a mostrar só as mudanças GLOBAIS (companyId null) e as das empresas
  // visíveis para o caller.
  const visiveis = await prisma.company.findMany({ where: whereEmpresaVisivel(req), select: { id: true } });
  const where = { OR: [{ companyId: null }, { companyId: { in: visiveis.map((c) => c.id) } }] };
  const [items, total] = await Promise.all([
    prisma.dictionaryVersion.findMany({ where, orderBy: { versao: "desc" }, take: limit, skip: offset }),
    prisma.dictionaryVersion.count({ where }),
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
  // Cada linha diz se É ELA que o fold usa. Ver situacaoDaCascata: a lista
  // mostra camadas, não duplicatas — mas sem dizer quem vence, camada parecia
  // duplicata. A busca/tipo/grupo acima filtram ANTES, então a situação é
  // calculada sobre o RESULTADO FILTRADO: uma busca por "Autônomos" pode
  // esconder a irmã que sombreia. Por isso a situação sai da cascata COMPLETA.
  const universo = (search || tipo || grupo)
    ? await prisma.accountDictionary.findMany({ where: { OR: where.OR } })
    : entries;
  const situacao = situacaoDaCascata(universo);
  res.json(entries.map((e) => ({
    ...e,
    ...(situacao.get(e.id) ?? { emUso: true, sobrepostaPor: null, redundante: false }),
  })));
});

// GET /dictionary/template — contas-destino disponíveis para os dropdowns,
// agrupadas por grupo. Combina o template canônico de BP com TODOS os pares
// (grupoConta → contaDestino) já presentes no dicionário acessível (global +
// workspace). Assim cobre BP e DRE, e garante que qualquer entrada existente
// seja re-selecionável ao ser editada (o valor sempre está entre as opções).
router.get("/template", async (req: AuthRequest, res: Response): Promise<void> => {
  const { loadActiveDREModel, loadActiveBPModel } = require("../services/model-version");
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
  // Bridge: os dropdowns refletem o MODELO VIGENTE do banco (conta adicionada no
  // editor de modelos aparece aqui na hora). A DRE tinha a ponte desde o início;
  // o BP montava do template FIXO do código — a conta "(-) Lucros Distribuidos
  // no Periodo" publicada no modelo do workspace não aparecia no dropdown de
  // classificação (13/08/2026, print do dono). Agora os dois leem o banco, com
  // a mesma cascata empresa → global.
  const dreModel = await loadActiveDREModel(templateCompanyId);
  const bpModel = await loadActiveBPModel(templateCompanyId);

  const grouped: Record<string, string[]> = {};
  const add = (grupo: string, conta: string): void => {
    if (!grupo || !conta) return;
    if (!grouped[grupo]) grouped[grupo] = [];
    if (!grouped[grupo].includes(conta)) grouped[grupo].push(conta);
  };

  // 1) Contas do MODELO BP VIGENTE (agrupadas pelo grupo-pai)
  for (const item of bpModel.lines) {
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

  // template = as linhas do MODELO VIGENTE (a tela usa p/ autofill do grupo).
  res.json({ template: bpModel.lines, dreTemplate: dreModel.lines, grouped, dreGrouped, descricoes });
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
  const { contaDestino, grupoConta, tipo } = req.body;
  // Mesma porta, mesma régua do classify: o código do plano não entra no nome.
  const nomeOriginal = typeof req.body.nomeOriginal === "string" ? limparNomeConta(req.body.nomeOriginal) : req.body.nomeOriginal;

  if (!nomeOriginal || !contaDestino || !grupoConta) {
    res.status(400).json({ error: "nomeOriginal, contaDestino e grupoConta são obrigatórios" });
    return;
  }
  // Valor do documento dentro do nome = linha lida errada. Ver [valor-no-nome.ts].
  const valorManual = avaliaValorNoNome(nomeOriginal);
  if (valorManual.bloqueado) { res.status(422).json({ error: valorManual.motivo }); return; }

  // ÚLTIMA FÁBRICA DA CAMADA WORKSPACE, FECHADA (13/08/2026, invariante I4).
  // "Nova Entrada" sem contexto gravava workspace — a camada que vale para toda
  // a firma de uma vez e que está sendo dissolvida. Agora: com companyId a
  // entrada nasce na EMPRESA; sem, a rota explica os dois caminhos.
  const companyIdManual = typeof req.body.companyId === "string" ? req.body.companyId : null;
  if (!companyIdManual) {
    res.status(409).json({
      error: 'Entrada manual precisa de uma empresa: abra o dicionário pelo contexto da empresa (aba "Dicionário & Modelos") para a entrada valer só nela. Para o dicionário global — que vale para todos os clientes —, classifique num IBR e aprove na Validação de contas.',
    });
    return;
  }
  const empresaManual = await prisma.company.findFirst({ where: { id: companyIdManual, ...whereEmpresaVisivel(req) }, select: { id: true } });
  if (!empresaManual) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  // Identidade dobrada: não cria duplicata de acento/caixa/código na empresa.
  const camadaEmpresaManual = await prisma.accountDictionary.findMany({
    where: { companyId: empresaManual.id, tipo: tipo || "BP" },
    select: { id: true, nomeOriginal: true, contaDestino: true, grupoConta: true, tipo: true },
  });
  const duplicataManual = acharNaCamada(camadaEmpresaManual, nomeOriginal, tipo || "BP", grupoConta);
  const entry = duplicataManual
    ? await prisma.accountDictionary.update({ where: { id: duplicataManual.id }, data: { contaDestino, revisao: "local" } })
    : await prisma.accountDictionary.create({
        data: { nomeOriginal, contaDestino, grupoConta, tipo: tipo || "BP", userId: req.userId!, companyId: empresaManual.id, revisao: "local" },
      });
  await bumpDictionaryVersion({ acao: "add", fonte: "manual", nomeOriginal, contaDestino, grupoConta, tipo: tipo || "BP", criadoPor: await nomeUsuario(req.userId), companyId: empresaManual.id });
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

  // NO-OP NÃO GRAVA (13/08/2026): abrir "Editar" numa linha do Sistema e clicar
  // "Salvar" sem mudar nada criava um clone de workspace — a fábrica de UM
  // CLIQUE dos pares duplicados. Como 467 das 1.411 globais já foram corrigidas
  // depois de criadas, cada clone congelava silenciosamente a correção futura
  // do global para a firma inteira.
  const nadaMudou =
    (!nomeOriginal || nomeOriginal === existing.nomeOriginal) &&
    (!contaDestino || contaDestino === existing.contaDestino) &&
    (!grupoConta || grupoConta === existing.grupoConta);
  if (nadaMudou) { res.json(existing); return; }

  // EDITAR LINHA GLOBAL (invariante I4 do dono): a mudança ou é LOCAL de uma
  // empresa (manda companyId, vira override de EMPRESA) ou é GLOBAL e passa
  // pela tela de Validação de contas. A camada de workspace — que valia para
  // todas as empresas da firma de uma vez — não recebe mais entradas.
  if (existing.userId === null) {
    const companyId = typeof req.body.companyId === "string" ? req.body.companyId : null;
    if (!companyId) {
      res.status(409).json({
        error: `Esta entrada é do dicionário global. Para valer só numa empresa, edite pela aba "Dicionário & Modelos" da empresa (a alteração fica restrita a ela). Para mudar o global — que vale para todos os clientes —, reclassifique a conta num IBR e aprove na Validação de contas.`,
      });
      return;
    }
    const c = await prisma.company.findFirst({ where: { id: companyId, ...whereEmpresaVisivel(req) }, select: { id: true } });
    if (!c) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
    const dadosOverride = {
      nomeOriginal: nomeOriginal || existing.nomeOriginal,
      contaDestino: contaDestino || existing.contaDestino,
      grupoConta: grupoConta || existing.grupoConta,
      tipo: existing.tipo,
    };
    // Mesma identidade já existente na empresa → atualiza em vez de duplicar.
    const daEmpresa = await prisma.accountDictionary.findMany({
      where: { companyId: c.id, tipo: existing.tipo },
      select: { id: true, nomeOriginal: true, contaDestino: true, grupoConta: true, tipo: true },
    });
    const jaExiste = acharNaCamada(daEmpresa, dadosOverride.nomeOriginal, existing.tipo, dadosOverride.grupoConta);
    const override = jaExiste
      ? await prisma.accountDictionary.update({ where: { id: jaExiste.id }, data: { contaDestino: dadosOverride.contaDestino, revisao: "local" } })
      : await prisma.accountDictionary.create({ data: { ...dadosOverride, userId: req.userId!, companyId: c.id, revisao: "local" } });
    await bumpDictionaryVersion({ acao: "edit", fonte: "manual", nomeOriginal: override.nomeOriginal, contaDestino: override.contaDestino, grupoConta: override.grupoConta, tipo: override.tipo, criadoPor: await nomeUsuario(req.userId), companyId: c.id });
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
    // FAIL-CLOSED (02/08/2026, auditoria multi-tenant): análise fora do escopo
    // devolvia null e o fluxo seguia CALADO para o ramo legado, gravando a
    // entrada no dicionário do workspace. Agora recusa, como o ramo companyId.
    if (!a) { res.status(404).json({ error: "Análise não encontrada" }); return; }
    companyIdClassify = a.companyId ?? null;
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
    // O NOME ENTRA LIMPO NA PORTA (13/08/2026). O parser já não emite código do
    // plano, mas a classificação vem da TELA — e a tela pode estar mostrando uma
    // leitura antiga, ou o analista pode colar o nome com o código. Limpar aqui
    // é o que impede a varredura retroativa de virar rotina eterna: o que entra
    // hoje já entra na forma final. Ver [nome-conta.ts].
    entry.nomeOriginal = limparNomeConta(entry.nomeOriginal);
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
      // TRAVA DO VALOR NO NOME: linha lida errada não vira chave de dicionário.
      // Fica DENTRO do mesmo if do __IGNORAR__ de propósito — marcar a linha
      // como ignorada não aprende chave nenhuma, e recusar o ignorar deixaria o
      // analista sem saída: conta não classificada COM VALOR vira pendência em
      // prontidao-geracao e o /generate recusa. A trava existe para proteger o
      // dicionário, não para travar a entrega do IBR. Ver [valor-no-nome.ts].
      const comValor = avaliaValorNoNome(entry.nomeOriginal);
      if (comValor.bloqueado) {
        rejeitadas.push({ nomeOriginal: entry.nomeOriginal, contaDestino: entry.contaDestino, motivo: comValor.motivo! });
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
        // QUEM VENCE AQUI TEM DE SER QUEM VENCE NO FOLD (13/08/2026, achado da
        // revisão adversarial). Duas divergências:
        //  1. `existentes` inclui CANCELADA de propósito (é ela que o revive
        //     abaixo precisa achar), mas o fold lê a cascata ATIVA — uma
        //     cancelada podia ser eleita "vencedora" aqui e fazer a trava
        //     descartar a classificação que o analista acabou de fazer;
        //  2. o `reduce` decidia empate de escopo pela ORDEM do findMany (sem
        //     orderBy) — a mesma não-determinação que a chave da cascata matou.
        // A régua é uma só: resolverCascataDicionario.
        const ativasDaChave = existentes.filter((e) => e.revisao !== "cancelada");
        const vencedoresDaChave = resolverCascataDicionario(ativasDaChave, tipoE);
        const vencedor = vencedoresDaChave.length
          ? vencedoresDaChave.reduce((a, b) => (prioridadeEscopo(b) > prioridadeEscopo(a) ? b : a))
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
        // Global CANCELADA não é equivalente (13/08/2026, caso AOCP): depois da
        // limpeza dos legados, "RECUPERAÇÃO JUDICIAL" cancelada no global ainda
        // contava como "o global já mapeia" — a classificação virava LOCAL e
        // nunca subia para a fila. Cancelada está fora da cascata ativa; para a
        // régua da fila ela não existe.
        const globalEquivalente = existentes.find((e) => e.companyId === null && e.userId === null && e.revisao !== "cancelada");
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
            (caminho !== null && !daEmpresa.grupoCaminho) ||
            // A régua da fila mudou desde a gravação (ex.: o global equivalente
            // foi cancelado — "local" tem de virar "pendente"). Reconfirmar o
            // mesmo destino recalcula; decisão humana já tomada não reabre.
            (daEmpresa.revisao !== revisaoNova && ["local", "pendente", "particular"].includes(daEmpresa.revisao ?? ""));
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

      // FÁBRICA FECHADA (13/08/2026, invariante I4 do dono: "alterações no
      // workspace devem impactar apenas a empresa"). O ramo sem contexto gravava
      // entrada de WORKSPACE — a camada que vale para TODAS as empresas da firma
      // e que produziu os pares duplicados do dicionário. Todos os chamadores
      // reais mandam analysisId ou companyId; chamada sem contexto não tem onde
      // pendurar a classificação e é recusada com o caminho certo.
      rejeitadas.push({
        nomeOriginal: entry.nomeOriginal,
        contaDestino: entry.contaDestino,
        motivo: "Classificação sem contexto de empresa: envie analysisId (classificação dentro de um IBR) ou companyId (aba Dicionário & Modelos da empresa). A camada de workspace não recebe mais entradas.",
      });
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

/**
 * QUEM PODE ESCREVER NO DICIONÁRIO GLOBAL (endurecido em 13/08/2026).
 *
 * O global é ativo da PLATAFORMA: uma linha ali vale para todos os clientes de
 * todas as firmas. O portão tinha duas fechaduras quebradas:
 *
 *  1. `role` NULA era lida como sócio. Conta sem papel nenhum promovia conta ao
 *     dicionário de todo mundo.
 *  2. O onboarding público carimba `role: "partner"` em quem cria um workspace
 *     (routes/onboarding.ts:110). Ou seja: qualquer pessoa se cadastra, cria uma
 *     firma e vira sócia — com direito de escrita no global. Medido no banco
 *     local: uma conta auto-cadastrada de teste passava.
 *
 * Agora exige papel EXPLÍCITO de sócio e, quando existe workspace de plataforma
 * declarado, ser sócio DELE. Enquanto nenhum workspace estiver marcado, a trava
 * de tenant fica desligada e avisa no log — assim este deploy não tranca ninguém
 * para fora, e o dono liga a trava com um POST em /dictionary/plataforma/assumir.
 */
async function podeValidarGlobal(userId?: string): Promise<boolean> {
  if (!userId) return false;
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, tipoUsuario: true, workspaceId: true, desativadoEm: true },
  });
  if (!u || u.desativadoEm) return false;
  // F2 SaaS: externo NUNCA aprova/reprova para o dicionário global.
  if (u.tipoUsuario === "empresa" || u.tipoUsuario === "parceiro") return false;
  if (u.role !== "partner") return false;

  const plataforma = await prisma.workspace.findFirst({ where: { plataforma: true }, select: { id: true } });
  if (!plataforma) {
    console.warn("[DICIONÁRIO] Nenhum workspace marcado como plataforma — o global aceita qualquer sócio interno. Ligue a trava em POST /dictionary/plataforma/assumir.");
    return true;
  }
  return u.workspaceId === plataforma.id;
}

/**
 * GET /dictionary/plataforma — quem é o dono do dicionário global hoje.
 * Sem workspace marcado, a resposta diz que a trava está DESLIGADA.
 */
router.get("/plataforma", async (req: AuthRequest, res: Response): Promise<void> => {
  const ws = await prisma.workspace.findFirst({
    where: { plataforma: true },
    select: { id: true, razaoSocial: true, nomeFantasia: true },
  });
  const eu = await prisma.user.findUnique({ where: { id: req.userId! }, select: { role: true, workspaceId: true } });
  res.json({
    travaLigada: !!ws,
    workspace: ws ? { id: ws.id, nome: ws.nomeFantasia || ws.razaoSocial } : null,
    souDaPlataforma: !!ws && eu?.workspaceId === ws.id,
    podeAssumir: !ws && eu?.role === "partner" && !!eu?.workspaceId,
  });
});

/**
 * POST /dictionary/plataforma/assumir — marca o workspace do chamador como o
 * DONO do dicionário global. Só funciona enquanto NENHUM estiver marcado: é um
 * ato único, feito pelo sócio da Quantua, e depois disso nenhuma outra firma
 * escreve no global. Reverter é ato de banco, de propósito.
 */
router.post("/plataforma/assumir", async (req: AuthRequest, res: Response): Promise<void> => {
  const eu = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { role: true, tipoUsuario: true, workspaceId: true, name: true },
  });
  if (!eu || eu.role !== "partner" || eu.tipoUsuario === "empresa" || eu.tipoUsuario === "parceiro") {
    res.status(403).json({ error: "Só sócio da equipe interna pode assumir o dicionário global." });
    return;
  }
  if (!eu.workspaceId) { res.status(400).json({ error: "Sua conta não está em nenhum workspace." }); return; }
  const jaTem = await prisma.workspace.findFirst({ where: { plataforma: true }, select: { id: true, razaoSocial: true } });
  if (jaTem) {
    res.status(409).json({
      error: jaTem.id === eu.workspaceId
        ? "Seu workspace já é o dono do dicionário global."
        : `O dicionário global já pertence a outro workspace ("${jaTem.razaoSocial}"). Trocar é ato de banco, de propósito.`,
    });
    return;
  }
  const ws = await prisma.workspace.update({ where: { id: eu.workspaceId }, data: { plataforma: true } });
  await bumpDictionaryVersion({
    acao: "edit", fonte: "manual", criadoPor: eu.name,
    nota: `Workspace "${ws.nomeFantasia || ws.razaoSocial}" assumiu o dicionário global — a partir de agora só sócios dele promovem conta ao global.`,
  });
  res.json({ ok: true, workspace: { id: ws.id, nome: ws.nomeFantasia || ws.razaoSocial } });
});

/**
 * DISSOLUÇÃO DA CAMADA WORKSPACE (invariante I4 do dono). A prévia planeja e
 * PROVA por simulação, empresa a empresa; o aplicar exige a assinatura da
 * prévia — se o dicionário mudou entre a leitura e o clique, recusa com 409 em
 * vez de aplicar um plano que ninguém leu (exigência da revisão adversarial).
 */
const assinaturaDoPlanoWs = (linhas: Array<{ id: string; updatedAt: Date }>, empresas: string[]): string =>
  require("crypto").createHash("sha256")
    .update([...linhas.map((l) => `${l.id}:${l.updatedAt.toISOString()}`).sort(), ...[...empresas].sort()].join("|"))
    .digest("hex").slice(0, 16);

async function montarPlanoWs(scopeUserIds: string[]) {
  const nomes = await companiesDoEscopo(scopeUserIds);
  const empresas = [...nomes.keys()];
  const linhas = await prisma.accountDictionary.findMany({
    where: {
      OR: [
        { userId: null, companyId: null },
        { userId: { in: scopeUserIds }, companyId: null },
        { companyId: { in: empresas } },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const plano = planejarDissolucaoWorkspace(linhas, empresas);
  const doWorkspace = linhas.filter((l) => plano.workspaceIds.includes(l.id));
  const assinatura = assinaturaDoPlanoWs(doWorkspace, empresas);
  return { nomes, empresas, linhas, plano, doWorkspace, assinatura };
}

// GET /dictionary/workspace/dissolucao — prévia (não escreve nada).
router.get("/workspace/dissolucao", async (req: AuthRequest, res: Response): Promise<void> => {
  const { nomes, plano, doWorkspace, assinatura } = await montarPlanoWs(req.scopeUserIds!);
  res.json({
    entradasWorkspace: doWorkspace.map((w) => ({ id: w.id, nomeOriginal: w.nomeOriginal, contaDestino: w.contaDestino, tipo: w.tipo })),
    copias: plano.copias.map((c) => ({ empresa: nomes.get(c.companyId) ?? c.companyId, nomeOriginal: c.nomeOriginal, contaDestino: c.contaDestino, tipo: c.tipo })),
    conflitos: plano.conflitos.map((c) => ({ empresa: nomes.get(c.companyId) ?? c.companyId, chave: c.chave, motivo: c.motivo })),
    provas: plano.provas.map((p) => ({ empresa: nomes.get(p.companyId) ?? p.companyId, chaves: p.chaves, copias: p.copias, identico: p.identico })),
    aplicavel: plano.aplicavel,
    assinatura,
  });
});

// POST /dictionary/workspace/dissolver { assinatura } — aplica o plano da prévia.
router.post("/workspace/dissolver", async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await podeValidarGlobal(req.userId))) {
    res.status(403).json({ error: "Dissolver a camada de workspace é ação de sócio (partner)." });
    return;
  }
  const { nomes, plano, doWorkspace, assinatura } = await montarPlanoWs(req.scopeUserIds!);
  if (req.body?.assinatura !== assinatura) {
    res.status(409).json({ code: "PLANO_MUDOU", error: "O dicionário mudou desde a prévia — recarregue e revise o plano de novo antes de aplicar.", assinatura });
    return;
  }
  if (!plano.aplicavel) {
    res.status(422).json({ error: "O plano tem conflitos ou provas que não fecham — nada foi aplicado. Resolva os conflitos listados na prévia.", conflitos: plano.conflitos });
    return;
  }
  if (plano.workspaceIds.length === 0) { res.json({ ok: true, copias: 0, canceladas: 0 }); return; }

  const validador = await nomeUsuario(req.userId);
  await prisma.$transaction(async (tx) => {
    for (const c of plano.copias) {
      // Colisão exata na unique da empresa → a linha já existe: atualiza destino.
      const jaExiste = await tx.accountDictionary.findFirst({
        where: { nomeOriginal: c.nomeOriginal, tipo: c.tipo, grupoConta: c.grupoConta ?? "", userId: c.userId, companyId: c.companyId },
        select: { id: true },
      });
      if (jaExiste) {
        await tx.accountDictionary.update({ where: { id: jaExiste.id }, data: { contaDestino: c.contaDestino, revisao: "local" } });
      } else {
        await tx.accountDictionary.create({
          data: {
            nomeOriginal: c.nomeOriginal, contaDestino: c.contaDestino, grupoConta: c.grupoConta ?? "",
            tipo: c.tipo, userId: c.userId, companyId: c.companyId,
            revisao: "local", grupoCaminho: c.grupoCaminho,
            revisaoMotivo: "Migrada da camada de workspace na dissolução (13/08/2026) — preserva o número que esta empresa já tinha.",
          },
        });
      }
    }
    await tx.accountDictionary.updateMany({
      where: { id: { in: plano.workspaceIds } },
      data: {
        revisao: "cancelada",
        revisaoMotivo: "Camada de workspace dissolvida — a regra agora vive nas empresas que a usavam (invariante: alteração local nunca vaza para as outras).",
        revisadoPor: validador,
        revisadoEm: new Date(),
      },
    });
  });

  await bumpDictionaryVersion({
    acao: "edit", fonte: "validacao", criadoPor: validador,
    nota: `Camada de workspace dissolvida: ${doWorkspace.length} entrada(s) canceladas, ${plano.copias.length} cópia(s) criadas em ${new Set(plano.copias.map((c) => c.companyId)).size} empresa(s). Prova por simulação: mapa resolvido idêntico em ${plano.provas.length} empresa(s).`,
  });
  res.json({ ok: true, copias: plano.copias.length, canceladas: doWorkspace.length, empresas: [...new Set(plano.copias.map((c) => nomes.get(c.companyId) ?? c.companyId))] });
});

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
          // Cancelada fora: mostrar um global que o fold não lê confunde a decisão.
          AND: [{ OR: [{ revisao: null }, { revisao: { not: "cancelada" } }] }],
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

  // Valor no nome NUNCA sobe ao global: a chave morreria no próximo exercício.
  const valorAprovar = avaliaValorNoNome(row.nomeOriginal);
  if (valorAprovar.bloqueado) { res.status(422).json({ error: valorAprovar.motivo }); return; }

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

  // O WORKSPACE VENCE O GLOBAL — promover sem olhar para ele é aprovar no vazio
  // (13/08/2026, achado da revisão adversarial). Havendo entrada de workspace com
  // destino DIFERENTE, o sócio aprovava X, a trilha registrava X, a tela mostrava
  // X e o fold de TODAS as empresas da firma continuava entregando Y, calado.
  const doWorkspace = await prisma.accountDictionary.findMany({
    where: {
      nomeOriginal: { equals: row.nomeOriginal, mode: "insensitive" },
      tipo: row.tipo,
      ...(row.tipo === "DRE" ? {} : { grupoConta: { equals: row.grupoConta, mode: "insensitive" as const } }),
      userId: { in: req.scopeUserIds! }, companyId: null,
      OR: [{ revisao: null }, { revisao: { not: "cancelada" } }],
    },
    select: { id: true, contaDestino: true },
  });
  const divergente = doWorkspace.find((w) => w.contaDestino !== row.contaDestino);
  if (divergente) {
    res.status(409).json({
      code: "WORKSPACE_DIVERGENTE",
      error: `Existe uma entrada de "Usuário" para "${row.nomeOriginal}" apontando para "${divergente.contaDestino}", e ela tem prioridade sobre o dicionário global. Promover para "${row.contaDestino}" agora não mudaria nada nos IBRs — a do workspace continuaria mandando. Ajuste ou cancele a entrada de Usuário no Dicionário de contas e aprove de novo.`,
    });
    return;
  }

  // A camada EMPRESA também vence o global — e OUTRAS empresas da firma podem
  // ter override próprio desta mesma conta. Aprovar não é bloqueado por isso
  // (o override local é legítimo por definição), mas o sócio precisa saber em
  // quem a aprovação NÃO vai valer (13/08/2026, achado da revisão adversarial:
  // sem este aviso, "aprovado" lia-se como "vale para todas").
  const overridesEmpresa = await prisma.accountDictionary.findMany({
    where: {
      nomeOriginal: { equals: row.nomeOriginal, mode: "insensitive" },
      tipo: row.tipo,
      ...(row.tipo === "DRE" ? {} : { grupoConta: { equals: row.grupoConta, mode: "insensitive" as const } }),
      companyId: { in: [...nomes.keys()], not: row.companyId },
      contaDestino: { not: row.contaDestino },
      OR: [{ revisao: null }, { revisao: { not: "cancelada" } }],
    },
    select: { companyId: true, contaDestino: true },
  });
  const avisoOverrides = overridesEmpresa.length
    ? `Atenção: ${overridesEmpresa.length} empresa(s) têm override próprio desta conta e continuarão usando o destino local (${overridesEmpresa
        .slice(0, 4).map((o) => `${nomes.get(o.companyId!) ?? o.companyId} → ${o.contaDestino}`).join("; ")}${overridesEmpresa.length > 4 ? "; …" : ""}).`
    : null;

  // "A MESMA conta" é decidido pela chave de identidade, nunca por `equals` do
  // banco: o `mode: "insensitive"` do Prisma NÃO dobra acento — promover
  // "Depreciacoes Acumuladas" (grafia que o OCR entrega) quando o global tem
  // "Depreciações Acumuladas" criava uma quase-duplicata (13/08/2026; há 16
  // pares só de acento no dicionário real).
  const camadaGlobal = await prisma.accountDictionary.findMany({
    where: { userId: null, companyId: null, tipo: row.tipo },
    select: { id: true, nomeOriginal: true, contaDestino: true, grupoConta: true, tipo: true },
  });
  const global = acharNaCamada(camadaGlobal, row.nomeOriginal, row.tipo, row.grupoConta);
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
  res.json({ ok: true, entrada: atualizado, aviso: avisoOverrides });
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

  // Mesma regra do /aprovar: o workspace vence o global, então promover a regra
  // de grupo por cima de um workspace divergente seria aprovar no vazio.
  const grupoNoWorkspace = await prisma.accountDictionary.findMany({
    where: {
      nomeOriginal: { equals: nomeGrupo, mode: "insensitive" },
      tipo: row.tipo,
      ...(row.tipo === "DRE" ? {} : { grupoConta: { equals: row.grupoConta, mode: "insensitive" as const } }),
      userId: { in: req.scopeUserIds! }, companyId: null,
      OR: [{ revisao: null }, { revisao: { not: "cancelada" } }],
    },
    select: { contaDestino: true },
  });
  const grupoDivergente = grupoNoWorkspace.find((w) => w.contaDestino !== row.contaDestino);
  if (grupoDivergente) {
    res.status(409).json({
      code: "WORKSPACE_DIVERGENTE",
      error: `Existe uma entrada de "Usuário" para o grupo "${nomeGrupo}" apontando para "${grupoDivergente.contaDestino}", e ela tem prioridade sobre o global. Promover para "${row.contaDestino}" agora não mudaria nada nos IBRs. Ajuste ou cancele a entrada de Usuário no Dicionário de contas e aprove de novo.`,
    });
    return;
  }

  // Mesma régua do /aprovar: identidade pela chave dobrada, não por equals.
  const camadaGlobalGrupo = await prisma.accountDictionary.findMany({
    where: { userId: null, companyId: null, tipo: row.tipo },
    select: { id: true, nomeOriginal: true, contaDestino: true, grupoConta: true, tipo: true },
  });
  const globalGrupo = acharNaCamada(camadaGlobalGrupo, nomeGrupo, row.tipo, row.grupoConta);
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

/**
 * POST /dictionary/desfazer-ignorar — tira a marca de IGNORAR de uma conta.
 *
 * O "ignorar" existe para linha de SUBTOTAL DUPLICADO. Quando ele cai numa
 * conta REAL, o valor sai da soma e o balanço deixa de fechar — foi o caso da
 * Dunamys ("Lucros/Prejuízos Acumulados" ignorada, R$ 150,6 mil, exatamente a
 * diferença do balanço). Até aqui a marca era uma via de mão única: a tela
 * mostrava "(ignorada pelo analista)" e não havia como voltar atrás.
 *
 * Cancela (nunca deleta — política da casa) as entradas-sentinela da conta no
 * escopo da EMPRESA. A cascata volta a enxergar a conta na próxima dobra.
 */
router.post("/desfazer-ignorar", async (req: AuthRequest, res: Response): Promise<void> => {
  const { companyId, nomeOriginal, tipo } = (req.body ?? {}) as Record<string, string | undefined>;
  if (!companyId || !nomeOriginal) {
    res.status(400).json({ error: "companyId e nomeOriginal são obrigatórios" });
    return;
  }
  const empresa = await prisma.company.findFirst({ where: { id: companyId, ...whereEmpresaVisivel(req) } });
  if (!empresa) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  // A BUSCA USA A MESMA CASCATA DO FOLD (10/08/2026 — bug do primeiro corte):
  // o filtro anterior cobria empresa e workspace e ESQUECIA o dicionário GLOBAL
  // (userId null + companyId null), que é de onde vinha a marca no caso real —
  // a tela dizia "ignorada" e a rota respondia "não está marcada".
  const alvo = nomeOriginal.trim().toLowerCase();
  const candidatas = await prisma.accountDictionary.findMany({
    where: {
      AND: [
        whereCascataDicionarioAtiva(req.scopeUserIds!, companyId),
        { contaDestino: IGNORAR_DESTINO },
        ...(tipo ? [{ tipo }] : []),
      ],
    },
  });
  const norm = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const remover = candidatas.filter((c) => norm(c.nomeOriginal) === norm(alvo));
  if (remover.length === 0) {
    res.status(404).json({ error: `"${nomeOriginal}" não está marcada como ignorada nesta empresa.` });
    return;
  }
  // Marca que vem do GLOBAL não se cancela por aqui: cancelar tiraria a regra
  // de TODAS as empresas. O caminho é classificar a conta NESTA empresa — a
  // entrada da empresa vence a global na cascata (é o que a tela oferece).
  const daEmpresa = remover.filter((r) => r.companyId === companyId);
  if (daEmpresa.length === 0) {
    res.status(409).json({
      error: `"${nomeOriginal}" está marcada como ignorada no dicionário GLOBAL da Quantua. Classifique a conta aqui na empresa — a classificação da empresa substitui a regra global, sem mexer nas outras empresas.`,
      escopo: "global",
    });
    return;
  }
  const autor = await nomeUsuario(req.userId);
  await prisma.accountDictionary.updateMany({
    where: { id: { in: daEmpresa.map((r) => r.id) } },
    data: {
      revisao: "cancelada", revisadoPor: autor, revisadoEm: new Date(),
      revisaoMotivo: "Ignorar desfeito na auditoria — a conta volta a entrar nas demonstrações.",
    },
  });
  await bumpDictionaryVersion({
    acao: "cancelar", fonte: "dicionario-empresa",
    nomeOriginal, contaDestino: IGNORAR_DESTINO, grupoConta: daEmpresa[0]!.grupoConta, tipo: daEmpresa[0]!.tipo,
    criadoPor: autor, companyId,
    nota: `"Ignorar" desfeito em ${nomeOriginal} — a conta volta a somar nas demonstrações desta empresa.`,
  });
  res.json({ ok: true, desfeitas: daEmpresa.length });
});
