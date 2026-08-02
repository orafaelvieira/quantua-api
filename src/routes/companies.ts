import { Router, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { requireAuth, requireQuantua, requireInternal, AuthRequest } from "../middleware/auth";
import { whereEmpresaVisivel, guardaEscritaSuspensao } from "../services/escopo-empresa";
import { deleteFile } from "../services/storage";
import { registrarAuditoria, diffCampos } from "../services/audit-trail";
import { sugerirSetores } from "../services/cnae-b3";
import { normContaGmd } from "../services/gmd-matricial";

const router = Router();

// CNPJ lookup proxy com CADEIA DE FALLBACK — a BrasilAPI cai junto com a
// minhareceita (é o upstream dela), então a terceira perna é a ReceitaWS,
// normalizada para o MESMO shape da BrasilAPI (o front não muda).
// User-Agent obrigatório: a BrasilAPI devolve 403 para o UA default do Node.
const CABECALHOS_CNPJ = { "User-Agent": "Quantua/1.0 (+https://quantua.com.br)", Accept: "application/json" };

/** ReceitaWS → shape BrasilAPI (só os campos que o produto consome + extras). */
function normalizarReceitaWs(d: Record<string, any>): Record<string, unknown> {
  return {
    razao_social: d.nome,
    nome_fantasia: d.fantasia || null,
    uf: d.uf,
    municipio: d.municipio,
    cnae_fiscal: Number(String(d.atividade_principal?.[0]?.code ?? "").replace(/\D/g, "")) || null,
    cnae_fiscal_descricao: d.atividade_principal?.[0]?.text ?? null,
    natureza_juridica: String(d.natureza_juridica ?? "").replace(/^[\d.\-\s]+-\s*/, "") || null,
    data_inicio_atividade: d.abertura ? String(d.abertura).split("/").reverse().join("-") : null,
    descricao_situacao_cadastral: d.situacao ?? null,
    capital_social: Number(d.capital_social) || 0,
    porte: d.porte ?? null,
    opcao_pelo_simples: d.simples?.optante ?? null,
    opcao_pelo_mei: d.simei?.optante ?? null,
    qsa: Array.isArray(d.qsa) ? d.qsa.map((s: any) => ({ nome_socio: s.nome, qualificacao_socio: s.qual })) : [],
    _fonte: "receitaws",
  };
}

/**
 * Consulta o CNPJ na cadeia de fontes e devolve a resposta no shape BrasilAPI —
 * ou `{ naoEncontrado: true }` quando as fontes confirmam que o CNPJ não existe.
 * Extraído da rota (24/07/2026) para a reconsulta da ficha usar a MESMA cadeia:
 * duas cópias da cascata dariam duas verdades sobre o que é "a Receita".
 */
async function consultarCnpj(digits: string): Promise<Record<string, any> | { naoEncontrado: true } | null> {
  let houve404 = false;

  // 1ª e 2ª pernas: BrasilAPI e minhareceita (mesmo shape — passa direto)
  for (const [nome, url] of [
    ["BrasilAPI", `https://brasilapi.com.br/api/cnpj/v1/${digits}`],
    ["minhareceita", `https://minhareceita.org/${digits}`],
  ] as const) {
    try {
      const r = await fetch(url, { headers: CABECALHOS_CNPJ, signal: AbortSignal.timeout(6000) });
      if (r.status === 404) { houve404 = true; continue; } // confirma na próxima fonte
      if (!r.ok) { console.error(`[cnpj] ${nome} ${digits} → HTTP ${r.status}`); continue; }
      return (await r.json()) as Record<string, any>;
    } catch (err) {
      console.error(`[cnpj] ${nome} falhou:`, err instanceof Error ? err.message : err);
    }
  }

  // 3ª perna: ReceitaWS (shape próprio → normalizado)
  try {
    const r = await fetch(`https://receitaws.com.br/v1/cnpj/${digits}`, { headers: CABECALHOS_CNPJ, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const d = (await r.json()) as Record<string, any>;
      if (d.status !== "ERROR" && d.nome) return normalizarReceitaWs(d) as Record<string, any>;
      houve404 = houve404 || d.status === "ERROR";
    } else {
      console.error(`[cnpj] ReceitaWS ${digits} → HTTP ${r.status}`);
    }
  } catch (err) {
    console.error("[cnpj] ReceitaWS falhou:", err instanceof Error ? err.message : err);
  }

  return houve404 ? { naoEncontrado: true } : null;
}

router.use(requireAuth);
// SOMENTE CONSULTA quando a organização está suspensa (inadimplência): era o
// único router de dado de empresa sem o guard (02/08/2026, auditoria) — externo
// suspenso ainda mudava status da empresa, unidades, centros de custo e GMD.
router.use(guardaEscritaSuspensao("company-body"));

// Consulta de CNPJ na Receita — DEPOIS do requireAuth (02/08/2026, auditoria):
// registrada antes, era um proxy ANÔNIMO para BrasilAPI/minhareceita/ReceitaWS
// (3 chamadas externas por request, sem limite), queimando a cota de terceiros
// em nome da Quantua e servindo de open proxy de consulta cadastral.
router.get("/cnpj/:cnpj", async (req: AuthRequest, res: Response): Promise<void> => {
  const digits = (req.params.cnpj as string).replace(/\D/g, "");
  if (digits.length !== 14) { res.status(400).json({ error: "CNPJ inválido" }); return; }

  const dados = await consultarCnpj(digits);
  if (dados && !("naoEncontrado" in dados)) { res.json(dados); return; }
  if (dados) { res.status(404).json({ error: "CNPJ não encontrado na Receita Federal" }); return; }
  res.status(502).json({ error: "Fontes da Receita indisponíveis no momento — preencha manualmente e reconsulte depois" });
});

const companySchema = z.object({
  razaoSocial: z.string().min(2),
  nomeFantasia: z.string().optional(),
  cnpj: z.string().optional(),
  setor: z.string().optional(),
  porte: z.string().optional(),
  uf: z.string().optional(),
  // Dados da Receita Federal (consulta CNPJ) — opcionais; cnpjData = resposta COMPLETA
  municipio: z.string().optional(),
  cnae: z.string().optional(),
  cnaeDescricao: z.string().optional(),
  naturezaJuridica: z.string().optional(),
  dataInicioAtividade: z.string().optional(),
  situacaoCadastral: z.string().optional(),
  capitalSocial: z.number().finite().optional(),
  regimeTributario: z.string().optional(),
  cnpjData: z.record(z.unknown()).optional(),
});

router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const companies = await prisma.company.findMany({
    where: { ...whereEmpresaVisivel(req) },
    orderBy: { createdAt: "desc" },
    // documents entra na contagem: a tela desabilita "Excluir" quando a empresa
    // já tem acervo (documento é evidência — ver a guarda do DELETE).
    include: { _count: { select: { analyses: true, documents: true } } },
  });
  // DUPLICATA DE CNPJ (23/07/2026): criar e editar já barram — mas fichas
  // ANTERIORES às travas continuam duplicadas no banco, invisíveis até alguém
  // reparar na lista. Marcar aqui é o que permite a tela oferecer a unificação.
  const porCnpj = new Map<string, string[]>();
  for (const c of companies) {
    const d = (c.cnpj ?? "").replace(/\D/g, "");
    if (d.length !== 14) continue;
    porCnpj.set(d, [...(porCnpj.get(d) ?? []), c.id]);
  }
  res.json(companies.map((c) => {
    const d = (c.cnpj ?? "").replace(/\D/g, "");
    const irmas = (porCnpj.get(d) ?? []).filter((id) => id !== c.id);
    return { ...c, duplicataDe: irmas.length ? irmas : undefined };
  }));
});

/**
 * PUT /companies/:id/status — ATIVA ou INATIVA a empresa (27/07/2026).
 *
 * A saída para a empresa que não deve mais aparecer no dia a dia mas cujo
 * acervo não pode ser apagado (IBR concluído, documentos, modelos). Inativar
 * não esconde nem apaga nada: é um estado declarado, auditado e reversível —
 * a ficha continua acessível e os produtos, intactos.
 *
 * body: { status: "ativo" | "inativo", motivo? }
 */
const STATUS_EMPRESA = ["ativo", "inativo"] as const;
router.put("/:id/status", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const { status, motivo } = (req.body ?? {}) as { status?: string; motivo?: string };
  if (!status || !STATUS_EMPRESA.includes(status as (typeof STATUS_EMPRESA)[number])) {
    res.status(400).json({ error: `status inválido — use: ${STATUS_EMPRESA.join(" | ")}` });
    return;
  }
  const existing = await prisma.company.findFirst({ where: { id, ...whereEmpresaVisivel(req) } });
  if (!existing) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  if (existing.status === status) { res.json({ ok: true, status, semMudanca: true }); return; }

  await prisma.company.update({ where: { id }, data: { status } });
  await registrarAuditoria({
    userId: req.userId!, entity: "company", entityId: id,
    field: status === "inativo" ? "inativação da empresa" : "reativação da empresa",
    before: { status: existing.status }, after: { status },
    reason: typeof motivo === "string" && motivo.trim() ? motivo.trim().slice(0, 300) : undefined,
    source: "empresas",
  });
  res.json({ ok: true, status });
});

/**
 * POST /companies/:id/unificar — funde uma ficha DUPLICADA nesta.
 * body: { duplicataId }
 *
 * Move TUDO que aponta para a duplicata (IBRs, documentos, modelos, envelopes,
 * períodos, fotos, dicionário e modelos padrão da empresa) e só então remove a
 * ficha vazia. Nada é apagado: o que existe muda de dono. Exige mesmo CNPJ —
 * unificar fichas de empresas diferentes seria misturar histórico contábil.
 */
router.post("/:id/unificar", requireQuantua, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const duplicataId = String((req.body ?? {}).duplicataId ?? "");
  if (!duplicataId) { res.status(400).json({ error: "duplicataId é obrigatório" }); return; }
  if (duplicataId === id) { res.status(400).json({ error: "Uma ficha não se unifica com ela mesma." }); return; }

  const [principal, duplicata] = await Promise.all([
    prisma.company.findFirst({ where: { id, ...whereEmpresaVisivel(req) } }),
    prisma.company.findFirst({ where: { id: duplicataId, ...whereEmpresaVisivel(req) } }),
  ]);
  if (!principal || !duplicata) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  const dig = (v: string | null) => (v ?? "").replace(/\D/g, "");
  if (dig(principal.cnpj).length !== 14 || dig(principal.cnpj) !== dig(duplicata.cnpj)) {
    res.status(409).json({ error: "As duas fichas precisam ter o MESMO CNPJ para serem unificadas — sem isso não há prova de que são a mesma empresa." });
    return;
  }

  const movidos = await prisma.$transaction(async (tx) => {
    const onde = { where: { companyId: duplicataId }, data: { companyId: id } };
    const [analyses, documents, models, produtos, periodos, snapshots, dicionario, modelosPadrao] = await Promise.all([
      tx.analysis.updateMany(onde),
      tx.document.updateMany(onde),
      tx.financialModel.updateMany(onde),
      tx.produtoEmpresa.updateMany(onde),
      tx.periodoEmpresa.updateMany(onde),
      tx.snapshotDiario.updateMany(onde),
      tx.accountDictionary.updateMany(onde),
      tx.standardModel.updateMany(onde),
    ]);
    // Vínculo com organizações: a duplicata pode estar ligada às mesmas orgs —
    // move só o que não colide, o resto some com a ficha.
    await tx.organizacaoEmpresa.deleteMany({
      where: { companyId: duplicataId, organizacaoId: { in: (await tx.organizacaoEmpresa.findMany({ where: { companyId: id }, select: { organizacaoId: true } })).map((o) => o.organizacaoId) } },
    });
    await tx.organizacaoEmpresa.updateMany({ where: { companyId: duplicataId }, data: { companyId: id } });
    await tx.company.delete({ where: { id: duplicataId } });
    return {
      analyses: analyses.count, documents: documents.count, models: models.count,
      produtos: produtos.count, periodos: periodos.count, snapshots: snapshots.count,
      dicionario: dicionario.count, modelosPadrao: modelosPadrao.count,
    };
  });

  void registrarAuditoria({
    userId: req.userId!, entity: "company", entityId: id, field: "unificação de ficha duplicada",
    before: { duplicataId, duplicataNome: duplicata.nomeFantasia || duplicata.razaoSocial, cnpj: duplicata.cnpj },
    after: { principalNome: principal.nomeFantasia || principal.razaoSocial, movidos },
  });
  res.json({ ok: true, movidos });
});

/** Duplicidade de CNPJ no workspace (comparação por DÍGITOS — o campo é salvo
 *  formatado). Retorna a empresa existente ou null. */
async function cnpjJaCadastrado(scopeUserIds: string[], cnpj: string | undefined, ignoreId?: string) {
  const digits = (cnpj ?? "").replace(/\D/g, "");
  if (digits.length !== 14) return null;
  const todas = await prisma.company.findMany({
    where: { userId: { in: scopeUserIds }, cnpj: { not: null } },
    select: { id: true, cnpj: true, razaoSocial: true, nomeFantasia: true },
  });
  return todas.find((c) => c.id !== ignoreId && (c.cnpj ?? "").replace(/\D/g, "") === digits) ?? null;
}

router.post("/", requireQuantua, async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = companySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  // TRAVA: um CNPJ = um cadastro por workspace (duplicar geraria IBRs/documentos
  // espalhados em duas fichas da mesma empresa).
  const dup = await cnpjJaCadastrado(req.scopeUserIds!, parsed.data.cnpj);
  if (dup) {
    res.status(409).json({
      error: `Este CNPJ já está cadastrado para "${dup.nomeFantasia || dup.razaoSocial}" — edite o cadastro existente em vez de duplicar.`,
      companyId: dup.id,
    });
    return;
  }

  const company = await prisma.company.create({
    data: { ...parsed.data, cnpjData: parsed.data.cnpjData as object | undefined, userId: req.userId! },
  });
  void registrarAuditoria({
    userId: req.userId!, entity: "company", entityId: company.id, field: "criação",
    after: { razaoSocial: company.razaoSocial, nomeFantasia: company.nomeFantasia, cnpj: company.cnpj, setor: company.setor, porte: company.porte, uf: company.uf },
  });
  res.status(201).json(company);
});

router.get("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const company = await prisma.company.findFirst({
    where: { id, ...whereEmpresaVisivel(req) },
    include: { analyses: { orderBy: { createdAt: "desc" }, take: 10 } },
  });
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  res.json(company);
});

/**
 * GET /companies/:id/cadastro — FICHA CADASTRAL completa (uso interno).
 *
 * Pedido do usuário (24/07/2026): "criar uma tela de consulta que tenha todos os
 * dados possíveis da receita". A consulta de CNPJ sempre gravou a resposta
 * INTEIRA em `cnpjData` — endereço, contatos, CNAEs secundários e quadro
 * societário estavam na base e não apareciam em lugar nenhum. Esta rota expõe
 * tudo, organizado, sem reconsultar a Receita.
 *
 * `requireInternal`: o quadro societário é público na Receita, mas é dado
 * PESSOAL de terceiros — fica na equipe interna e nunca em documento do cliente
 * (o portal usa outras rotas; esta responde 403 para role "client").
 */
router.get("/:id/cadastro", requireInternal, async (req: AuthRequest, res: Response): Promise<void> => {
  const company = await prisma.company.findFirst({
    where: { id: req.params.id as string, ...whereEmpresaVisivel(req) },
  });
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  const d = (company.cnpjData ?? {}) as Record<string, any>;
  const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const numero = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

  res.json({
    // ── O que está no CADASTRO (editável pelo analista) ──
    cadastro: {
      id: company.id,
      razaoSocial: company.razaoSocial,
      nomeFantasia: company.nomeFantasia,
      cnpj: company.cnpj,
      setor: company.setor,
      porte: company.porte,
      uf: company.uf,
      municipio: company.municipio,
      regimeTributario: company.regimeTributario,
      regimeFechamento: company.regimeFechamento,
      status: company.status,
      criadoEm: company.createdAt,
    },
    // ── O que veio da RECEITA (leitura; a fonte é a consulta de CNPJ) ──
    receita: {
      razaoSocial: texto(d.razao_social),
      nomeFantasia: texto(d.nome_fantasia),
      situacaoCadastral: company.situacaoCadastral ?? texto(d.descricao_situacao_cadastral),
      dataSituacaoCadastral: texto(d.data_situacao_cadastral),
      motivoSituacaoCadastral: texto(d.descricao_motivo_situacao_cadastral),
      dataInicioAtividade: company.dataInicioAtividade ?? texto(d.data_inicio_atividade),
      naturezaJuridica: company.naturezaJuridica ?? texto(d.natureza_juridica),
      porteReceita: texto(d.porte),
      capitalSocial: company.capitalSocial ?? numero(d.capital_social),
      matrizFilial: texto(d.descricao_identificador_matriz_filial),
      cnaePrincipal: company.cnae ? { codigo: company.cnae, descricao: company.cnaeDescricao } : null,
      cnaesSecundarios: Array.isArray(d.cnaes_secundarios)
        ? d.cnaes_secundarios.map((c: any) => ({ codigo: String(c?.codigo ?? ""), descricao: texto(c?.descricao) })).filter((c: any) => c.codigo)
        : [],
      endereco: {
        logradouro: texto(d.logradouro),
        numero: texto(d.numero),
        complemento: texto(d.complemento),
        bairro: texto(d.bairro),
        municipio: company.municipio ?? texto(d.municipio),
        uf: company.uf ?? texto(d.uf),
        cep: texto(d.cep),
      },
      contato: {
        telefone: texto(d.ddd_telefone_1),
        telefone2: texto(d.ddd_telefone_2),
        email: texto(d.email),
      },
      simples: {
        optanteSimples: typeof d.opcao_pelo_simples === "boolean" ? d.opcao_pelo_simples : null,
        dataOpcaoSimples: texto(d.data_opcao_pelo_simples),
        optanteMei: typeof d.opcao_pelo_mei === "boolean" ? d.opcao_pelo_mei : null,
      },
      fonte: texto(d._fonte) ?? (Object.keys(d).length ? "brasilapi" : null),
    },
    // ── QUADRO SOCIETÁRIO — dado pessoal de terceiros, uso interno ──
    socios: Array.isArray(d.qsa)
      ? d.qsa.map((s: any) => ({
          nome: texto(s?.nome_socio) ?? texto(s?.nome),
          qualificacao: texto(s?.qualificacao_socio) ?? texto(s?.qual),
          dataEntrada: texto(s?.data_entrada_sociedade),
          faixaEtaria: texto(s?.faixa_etaria),
          representanteLegal: texto(s?.nome_representante_legal),
          qualificacaoRepresentante: texto(s?.qualificacao_representante_legal),
          pais: texto(s?.pais),
        })).filter((s: any) => s.nome)
      : [],
    /** Sem consulta de CNPJ gravada, a ficha só tem o que o analista digitou. */
    temDadosDaReceita: Object.keys(d).length > 0,
  });
});

/**
 * POST /companies/:id/reconsultar-cnpj — atualiza a ficha com a Receita de hoje.
 * Situação cadastral, endereço e QSA mudam com o tempo; sem isto a ficha
 * congelava no dia do cadastro. Grava a resposta inteira e promove os campos que
 * a análise usa; o que o analista editou à mão (setor, porte, regime) NÃO é
 * sobrescrito — decisão dele vale mais que palpite de mapeamento.
 */
router.post("/:id/reconsultar-cnpj", requireInternal, async (req: AuthRequest, res: Response): Promise<void> => {
  const company = await prisma.company.findFirst({
    where: { id: req.params.id as string, ...whereEmpresaVisivel(req) },
  });
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  const digits = (company.cnpj ?? "").replace(/\D/g, "");
  if (digits.length !== 14) { res.status(400).json({ error: "Esta empresa não tem CNPJ no cadastro — informe o CNPJ para consultar a Receita." }); return; }

  const dados = await consultarCnpj(digits);
  if (!dados) { res.status(502).json({ error: "Não foi possível consultar a Receita agora (as três fontes falharam). Tente novamente em alguns minutos." }); return; }
  if ("naoEncontrado" in dados) { res.status(404).json({ error: "CNPJ não encontrado na Receita Federal." }); return; }

  const d = dados;
  const antes = { situacaoCadastral: company.situacaoCadastral, capitalSocial: company.capitalSocial, municipio: company.municipio };
  const atualizado = await prisma.company.update({
    where: { id: company.id },
    data: {
      cnpjData: d as object,
      municipio: typeof d.municipio === "string" ? d.municipio : company.municipio,
      cnae: d.cnae_fiscal ? String(d.cnae_fiscal) : company.cnae,
      cnaeDescricao: typeof d.cnae_fiscal_descricao === "string" ? d.cnae_fiscal_descricao : company.cnaeDescricao,
      naturezaJuridica: typeof d.natureza_juridica === "string" ? d.natureza_juridica : company.naturezaJuridica,
      dataInicioAtividade: typeof d.data_inicio_atividade === "string" ? d.data_inicio_atividade : company.dataInicioAtividade,
      situacaoCadastral: typeof d.descricao_situacao_cadastral === "string" ? d.descricao_situacao_cadastral : company.situacaoCadastral,
      capitalSocial: Number.isFinite(Number(d.capital_social)) ? Number(d.capital_social) : company.capitalSocial,
    },
  });
  void registrarAuditoria({
    userId: req.userId!, entity: "company", entityId: company.id, field: "reconsulta da Receita",
    before: antes,
    after: { situacaoCadastral: atualizado.situacaoCadastral, capitalSocial: atualizado.capitalSocial, municipio: atualizado.municipio, fonte: d._fonte ?? "brasilapi" },
  });
  res.json({ ok: true });
});

// ── ESTRUTURA ORGANIZACIONAL (F1 do orçamento por unidade, 25/07/2026) ──────
// Unidades de negócio (filiais) + centros de custo da empresa. CC pertence a
// UMA unidade; CC sem unidade = COMPARTILHADO (CSC), rateado pelo critério
// gravado nele. Desativar em vez de excluir (linhas de modelo apontam para cá).

async function companyNoEscopoEstrutura(id: string, req: AuthRequest) {
  return prisma.company.findFirst({ where: { id, ...whereEmpresaVisivel(req) } });
}

const unidadeSchema = z.object({
  nome: z.string().min(1).max(80),
  codigo: z.string().max(40).optional().nullable(),
  ehMatriz: z.boolean().optional(),
  /** F4: responsável pela unidade (membro da equipe) — null limpa. */
  responsavelUserId: z.string().uuid().optional().nullable(),
  ativo: z.boolean().optional(),
  ordem: z.number().int().optional(),
});

const rateioSchema = z.object({
  driver: z.enum(["manual", "receita"]),
  pesos: z.record(z.number().min(0)).optional(),
});

const centroCustoSchema = z.object({
  nome: z.string().min(1).max(80),
  codigo: z.string().max(40).optional().nullable(),
  /** null/ausente = compartilhado (CSC). */
  unidadeId: z.string().uuid().optional().nullable(),
  rateio: rateioSchema.optional().nullable(),
  ativo: z.boolean().optional(),
  ordem: z.number().int().optional(),
});

router.get("/:id/estrutura", async (req: AuthRequest, res: Response): Promise<void> => {
  const company = await companyNoEscopoEstrutura(req.params.id as string, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  const [unidades, centros] = await Promise.all([
    prisma.unidadeNegocio.findMany({ where: { companyId: company.id }, orderBy: [{ ordem: "asc" }, { createdAt: "asc" }] }),
    prisma.centroCusto.findMany({ where: { companyId: company.id }, orderBy: [{ ordem: "asc" }, { createdAt: "asc" }] }),
  ]);
  // Nome do responsável (F4) — a tela mostra quem preenche cada unidade.
  const idsResp = [...new Set(unidades.map((u) => u.responsavelUserId).filter((v): v is string => !!v))];
  const nomes = idsResp.length
    ? new Map((await prisma.user.findMany({ where: { id: { in: idsResp } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
    : new Map<string, string>();
  res.json({
    unidades: unidades.map((u) => ({ ...u, responsavelNome: u.responsavelUserId ? nomes.get(u.responsavelUserId) ?? null : null })),
    centros,
  });
});

router.post("/:id/unidades", async (req: AuthRequest, res: Response): Promise<void> => {
  const company = await companyNoEscopoEstrutura(req.params.id as string, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  const parsed = unidadeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  // Mesma regra do centro de custo: nome único na empresa, inativo incluído.
  const jaExiste = (await prisma.unidadeNegocio.findMany({ where: { companyId: company.id } }))
    .find((u) => normContaGmd(u.nome) === normContaGmd(parsed.data.nome));
  if (jaExiste) {
    res.status(409).json({
      error: jaExiste.ativo
        ? `Já existe a unidade "${jaExiste.nome}" nesta empresa.`
        : `Já existe a unidade "${jaExiste.nome}" nesta empresa, hoje INATIVA — reative-a em vez de criar outra com o mesmo nome.`,
      unidadeExistente: { id: jaExiste.id, nome: jaExiste.nome, ativo: jaExiste.ativo },
    });
    return;
  }
  const criada = await prisma.unidadeNegocio.create({ data: { ...parsed.data, companyId: company.id } });
  void registrarAuditoria({
    userId: req.userId!, entity: "unidade_negocio", entityId: criada.id, field: "criação da unidade",
    after: { nome: criada.nome, companyId: company.id }, source: "companies",
  });
  res.status(201).json(criada);
});

router.put("/:id/unidades/:uid", async (req: AuthRequest, res: Response): Promise<void> => {
  const company = await companyNoEscopoEstrutura(req.params.id as string, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  const antes = await prisma.unidadeNegocio.findFirst({ where: { id: req.params.uid as string, companyId: company.id } });
  if (!antes) { res.status(404).json({ error: "Unidade não encontrada" }); return; }
  const parsed = unidadeSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const depois = await prisma.unidadeNegocio.update({ where: { id: antes.id }, data: parsed.data });
  void registrarAuditoria({
    userId: req.userId!, entity: "unidade_negocio", entityId: antes.id, field: "edição da unidade",
    before: { nome: antes.nome, ativo: antes.ativo }, after: { nome: depois.nome, ativo: depois.ativo }, source: "companies",
  });
  res.json(depois);
});

router.post("/:id/centros-custo", async (req: AuthRequest, res: Response): Promise<void> => {
  const company = await companyNoEscopoEstrutura(req.params.id as string, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  const parsed = centroCustoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  if (parsed.data.unidadeId) {
    const dona = await prisma.unidadeNegocio.findFirst({ where: { id: parsed.data.unidadeId, companyId: company.id } });
    if (!dona) { res.status(400).json({ error: "A unidade indicada não é desta empresa." }); return; }
  }
  // NOME ÚNICO NA EMPRESA (28/07/2026): dava para desativar "Comercial", criar
  // outro "Comercial" e reativar o antigo — dois CCs com o mesmo nome, e nem o
  // analista nem a matriz GMD saberiam qual é qual. O INATIVO conta: a saída é
  // reativar aquele, não criar um clone.
  const irmaos = await prisma.centroCusto.findMany({ where: { companyId: company.id } });
  const colisao = irmaos.find((c) => normContaGmd(c.nome) === normContaGmd(parsed.data.nome));
  if (colisao) {
    res.status(409).json({
      error: colisao.ativo
        ? `Já existe um centro de custo "${colisao.nome}" nesta empresa.`
        : `Já existe um centro de custo "${colisao.nome}" nesta empresa, hoje INATIVO — reative-o em vez de criar outro com o mesmo nome.`,
      centroExistente: { id: colisao.id, nome: colisao.nome, ativo: colisao.ativo, unidadeId: colisao.unidadeId },
    });
    return;
  }
  const criado = await prisma.centroCusto.create({
    data: { ...parsed.data, rateio: parsed.data.rateio ?? undefined, companyId: company.id },
  });
  void registrarAuditoria({
    userId: req.userId!, entity: "centro_custo", entityId: criado.id, field: "criação do centro de custo",
    after: { nome: criado.nome, unidadeId: criado.unidadeId, compartilhado: !criado.unidadeId }, source: "companies",
  });
  res.status(201).json(criado);
});

router.put("/:id/centros-custo/:cid", async (req: AuthRequest, res: Response): Promise<void> => {
  const company = await companyNoEscopoEstrutura(req.params.id as string, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  const antes = await prisma.centroCusto.findFirst({ where: { id: req.params.cid as string, companyId: company.id } });
  if (!antes) { res.status(404).json({ error: "Centro de custo não encontrado" }); return; }
  const parsed = centroCustoSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  if (parsed.data.unidadeId) {
    const dona = await prisma.unidadeNegocio.findFirst({ where: { id: parsed.data.unidadeId, companyId: company.id } });
    if (!dona) { res.status(400).json({ error: "A unidade indicada não é desta empresa." }); return; }
  }
  const depois = await prisma.centroCusto.update({
    where: { id: antes.id },
    data: { ...parsed.data, rateio: parsed.data.rateio === null ? Prisma.DbNull : parsed.data.rateio ?? undefined },
  });
  void registrarAuditoria({
    userId: req.userId!, entity: "centro_custo", entityId: antes.id, field: "edição do centro de custo",
    before: { nome: antes.nome, unidadeId: antes.unidadeId, rateio: antes.rateio },
    after: { nome: depois.nome, unidadeId: depois.unidadeId, rateio: depois.rateio }, source: "companies",
  });
  res.json(depois);
});

// DELETE /:id/centros-custo/:cid — EXCLUI de vez, e só quando NADA aponta para
// ele (28/07/2026). Desativar é a regra da casa porque o CC costuma carregar
// histórico; um centro criado por engano, que nunca recebeu conta nem posição,
// não tem por que ficar sujando a lista para sempre. Se houver qualquer
// vínculo, a resposta diz ONDE está e manda desativar.
router.delete("/:id/centros-custo/:cid", async (req: AuthRequest, res: Response): Promise<void> => {
  const company = await companyNoEscopoEstrutura(req.params.id as string, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  const cc = await prisma.centroCusto.findFirst({ where: { id: req.params.cid as string, companyId: company.id } });
  if (!cc) { res.status(404).json({ error: "Centro de custo não encontrado" }); return; }

  // Varre TODOS os modelos da empresa: linha de custo/receita etiquetada, posição
  // da folha ou rateio de CSC que cite este CC seguram a exclusão.
  const modelos = await prisma.financialModel.findMany({
    where: { companyId: company.id },
    select: { id: true, nome: true, status: true, blocks: { select: { tipo: true, config: true } } },
  });
  const usos: string[] = [];
  for (const m of modelos) {
    for (const b of m.blocks) {
      const cfg = (b.config ?? {}) as {
        linhasCusto?: Array<{ nome?: string; centroCustoId?: string | null }>;
        linhasReceita?: Array<{ nome?: string; centroCustoId?: string | null }>;
        posicoes?: Array<{ nome?: string; centroCustoId?: string | null }>;
      };
      const itens = [...(cfg.linhasCusto ?? []), ...(cfg.linhasReceita ?? []), ...(cfg.posicoes ?? [])];
      const n = itens.filter((x) => x?.centroCustoId === cc.id).length;
      if (n > 0) usos.push(`${m.nome} (${n} lançamento(s))`);
    }
  }
  const rateios = (await prisma.centroCusto.findMany({ where: { companyId: company.id, id: { not: cc.id } } }))
    .filter((outro) => JSON.stringify(outro.rateio ?? {}).includes(cc.id))
    .map((outro) => `rateio do CSC "${outro.nome}"`);
  const impedimentos = [...new Set([...usos, ...rateios])];

  if (impedimentos.length > 0) {
    res.status(409).json({
      error: `"${cc.nome}" já tem dado vinculado e não pode ser excluído — desative-o para tirar da lista sem perder o histórico.`,
      vinculos: impedimentos.slice(0, 8),
    });
    return;
  }

  await prisma.centroCusto.delete({ where: { id: cc.id } });
  void registrarAuditoria({
    userId: req.userId!, entity: "centro_custo", entityId: cc.id, field: "exclusão do centro de custo",
    before: { nome: cc.nome, unidadeId: cc.unidadeId }, source: "companies",
  });
  res.json({ ok: true, excluido: cc.nome });
});

// ── PACOTES GMD (F10 — gerenciamento matricial de despesas) ─────────────────
// Grupo de CONTAS que cruza todas as unidades, com um DONO. A dupla checagem:
// dono do pacote × responsável da unidade — nenhum real fica sem dois olhos.

const pacoteGmdSchema = z.object({
  nome: z.string().min(1).max(80),
  donoUserId: z.string().uuid().optional().nullable(),
  contas: z.array(z.string().min(1)).max(200),
  ativo: z.boolean().optional(),
});

router.get("/:id/pacotes-gmd", async (req: AuthRequest, res: Response): Promise<void> => {
  const company = await companyNoEscopoEstrutura(req.params.id as string, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  const pacotes = await prisma.pacoteGmd.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "asc" } });
  const idsDonos = [...new Set(pacotes.map((p) => p.donoUserId).filter((v): v is string => !!v))];
  const nomes = idsDonos.length
    ? new Map((await prisma.user.findMany({ where: { id: { in: idsDonos } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
    : new Map<string, string>();
  res.json({ pacotes: pacotes.map((p) => ({ ...p, donoNome: p.donoUserId ? nomes.get(p.donoUserId) ?? null : null })) });
});

router.post("/:id/pacotes-gmd", async (req: AuthRequest, res: Response): Promise<void> => {
  const company = await companyNoEscopoEstrutura(req.params.id as string, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  const parsed = pacoteGmdSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const criado = await prisma.pacoteGmd.create({ data: { ...parsed.data, contas: parsed.data.contas, companyId: company.id } });
  void registrarAuditoria({
    userId: req.userId!, entity: "pacote_gmd", entityId: criado.id, field: "criação do pacote GMD",
    after: { nome: criado.nome, contas: parsed.data.contas.length }, source: "companies",
  });
  res.status(201).json(criado);
});

router.put("/:id/pacotes-gmd/:pid", async (req: AuthRequest, res: Response): Promise<void> => {
  const company = await companyNoEscopoEstrutura(req.params.id as string, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  const antes = await prisma.pacoteGmd.findFirst({ where: { id: req.params.pid as string, companyId: company.id } });
  if (!antes) { res.status(404).json({ error: "Pacote não encontrado" }); return; }
  const parsed = pacoteGmdSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const depois = await prisma.pacoteGmd.update({ where: { id: antes.id }, data: parsed.data });
  void registrarAuditoria({
    userId: req.userId!, entity: "pacote_gmd", entityId: antes.id, field: "edição do pacote GMD",
    before: { nome: antes.nome, ativo: antes.ativo }, after: { nome: depois.nome, ativo: depois.ativo }, source: "companies",
  });
  res.json(depois);
});

/** Sugestão de SETOR B3 pelo CNAE da Receita (principal + secundários) — zero IA.
 *  Sinal FRACO: pré-preenche o picker do wizard com selo; nunca confirma sozinho. */
router.get("/:id/sugestao-setor", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const company = await prisma.company.findFirst({
    where: { id, ...whereEmpresaVisivel(req) },
    select: { cnae: true, cnaeDescricao: true, cnpjData: true },
  });
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  const cnaes: Array<{ codigo: unknown; descricao?: string | null; origem: string }> = [];
  if (company.cnae) cnaes.push({ codigo: company.cnae, descricao: company.cnaeDescricao, origem: "principal" });
  const secundarios = (company.cnpjData as { cnaes_secundarios?: Array<{ codigo?: unknown; descricao?: string }> } | null)?.cnaes_secundarios ?? [];
  for (const c of secundarios.slice(0, 20)) cnaes.push({ codigo: c?.codigo, descricao: c?.descricao ?? null, origem: "secundário" });

  if (cnaes.length === 0) {
    // Empresa sem CNAE (cadastro anterior à consulta de CNPJ ou sem CNPJ) — o wizard
    // explica e aponta o caminho (editar a empresa → Reconsultar Receita).
    res.json({ principal: null, alternativas: [], motivo: "sem-cnae" });
    return;
  }
  const sugestoes = sugerirSetores(cnaes);
  if (sugestoes.length === 0) { res.json({ principal: null, alternativas: [], motivo: "cnae-sem-mapeamento" }); return; }
  // Resolve nomes (e valida que o código existe/está ativo no picker).
  const sectors = await prisma.sector.findMany({ where: { code: { in: sugestoes.map((s) => s.sectorCode) }, active: true }, include: { parent: true } });
  const nomeDe = new Map(sectors.map((x) => [x.code, x.parent ? `${x.parent.name} — ${x.name}` : x.name]));
  const validas = sugestoes.filter((x) => nomeDe.has(x.sectorCode)).map((x) => ({ ...x, sectorName: nomeDe.get(x.sectorCode)! }));
  res.json({ principal: validas[0] ?? null, alternativas: validas.slice(1) });
});

router.put("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const existing = await prisma.company.findFirst({ where: { id, userId: { in: req.scopeUserIds! } } });
  if (!existing) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  const parsed = companySchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  // CNPJ é a IDENTIDADE da ficha (decisão do usuário 2026-07-07): alterar um CNPJ já
  // gravado religaria IBRs/documentos a outra empresa. Permitido apenas PREENCHER
  // quando o cadastro legado ainda não tem CNPJ.
  if (parsed.data.cnpj !== undefined) {
    const novo = parsed.data.cnpj.replace(/\D/g, "");
    const atual = (existing.cnpj ?? "").replace(/\D/g, "");
    if (atual.length === 14 && novo !== atual) {
      res.status(400).json({
        error: "O CNPJ de um cadastro não pode ser alterado — ele identifica a ficha (IBRs e documentos vinculados). Para outra empresa, crie um novo cadastro.",
      });
      return;
    }
    // Preenchendo pela 1ª vez: vale a trava de duplicidade contra OUTRAS fichas.
    const dup = await cnpjJaCadastrado(req.scopeUserIds!, parsed.data.cnpj, id);
    if (dup) {
      res.status(409).json({
        error: `Este CNPJ já está cadastrado para "${dup.nomeFantasia || dup.razaoSocial}".`,
        companyId: dup.id,
      });
      return;
    }
  }

  const company = await prisma.company.update({
    where: { id },
    data: { ...parsed.data, cnpjData: parsed.data.cnpjData as object | undefined },
  });

  // TRILHA: grava só o que MUDOU (before/after), com quem e quando. cnpjData fica de
  // fora do diff (payload grande) — a reconsulta é registrada como flag.
  const d = diffCampos(existing as unknown as Record<string, unknown>, parsed.data as Record<string, unknown>,
    ["razaoSocial", "nomeFantasia", "cnpj", "setor", "porte", "uf", "regimeTributario", "municipio", "cnae", "situacaoCadastral", "capitalSocial"]);
  if (d.mudou || parsed.data.cnpjData !== undefined) {
    void registrarAuditoria({
      userId: req.userId!, entity: "company", entityId: id, field: "edição do cadastro",
      before: d.before, after: { ...d.after, ...(parsed.data.cnpjData !== undefined ? { dadosReceita: "reconsultados" } : {}) },
    });
  }

  // Engagement.companyName é um SNAPSHOT gravado na criação do IBR — renomear a
  // empresa deixava engagements/propostas com o nome velho. Sincroniza aqui.
  if (parsed.data.razaoSocial !== undefined || parsed.data.nomeFantasia !== undefined) {
    const display = company.nomeFantasia || company.razaoSocial;
    await prisma.engagement.updateMany({
      where: { analysis: { companyId: id } },
      data: { companyName: display },
    });
  }

  res.json(company);
});

router.delete("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const existing = await prisma.company.findFirst({ where: { id, userId: { in: req.scopeUserIds! } } });
  if (!existing) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  // TRAVA DE PRODUTO EMITIDO (pedido do usuário, 27/07/2026): excluir empresa
  // apagava TUDO em cascata — inclusive IBR concluído e modelo emitido, que as
  // rotas individuais recusam apagar por serem evidência ("nunca deletar o que
  // participou de um produto"). Sem esta guarda, a política valia por documento
  // e caía por inteiro num clique na empresa. Espelha as regras individuais:
  // Analysis "Concluída" (DELETE /analyses/:id) e FinancialModel
  // "Concluído"/"Cancelado" (DELETE /models/:id).
  const [ibrsEmitidos, modelosEmitidos] = await Promise.all([
    prisma.analysis.findMany({
      where: { companyId: id, status: "Concluída" },
      select: { id: true, nome: true },
      take: 5,
    }),
    prisma.financialModel.findMany({
      where: { companyId: id, status: { in: ["Concluído", "Cancelado"] } },
      select: { id: true, nome: true, status: true },
      take: 5,
    }),
  ]);
  if (ibrsEmitidos.length > 0 || modelosEmitidos.length > 0) {
    const nomes = [
      ...ibrsEmitidos.map((a) => `IBR "${a.nome}" (concluído)`),
      ...modelosEmitidos.map((m) => `Modelo "${m.nome}" (${m.status.toLowerCase()})`),
    ];
    res.status(409).json({
      error:
        `"${existing.nomeFantasia || existing.razaoSocial}" tem produto emitido e não pode ser excluída — ` +
        `produto entregue é evidência e nunca sai da base: ${nomes.join(" · ")}` +
        `${nomes.length >= 5 ? " …" : ""}. Para tirá-la de circulação, marque a empresa como INATIVA. ` +
        `Se esta ficha é duplicata de outra da MESMA empresa, unifique as fichas (mesmo CNPJ).`,
      produtosEmitidos: [
        ...ibrsEmitidos.map((a) => ({ tipo: "IBR", id: a.id, nome: a.nome, status: "Concluída" })),
        ...modelosEmitidos.map((m) => ({ tipo: "Modelo financeiro", id: m.id, nome: m.nome, status: m.status })),
      ],
      podeInativar: true,
    });
    return;
  }

  // ACERVO NA DATA ROOM (pedido do usuário, 27/07/2026): documento é evidência —
  // excluir a empresa apagaria arquivos e hashes que fundamentam (ou vão
  // fundamentar) análises. Empresa com acervo sai de circulação por INATIVAÇÃO;
  // exclusão fica para a ficha criada por engano, ainda vazia.
  const documentos = await prisma.document.count({ where: { companyId: id } });
  if (documentos > 0) {
    res.status(409).json({
      error:
        `"${existing.nomeFantasia || existing.razaoSocial}" tem ${documentos} documento(s) na Data room e não pode ser excluída — ` +
        `documento é evidência, com hash e proveniência. Para tirá-la de circulação, marque a empresa como INATIVA ` +
        `(nada é apagado e dá para reativar depois).`,
      documentos,
      podeInativar: true,
    });
    return;
  }

  try {
    // Delete associated storage files before cascading DB delete
    const docs = await prisma.document.findMany({
      where: { company: { id } },
      select: { storagePath: true },
    });

    for (const doc of docs) {
      if (doc.storagePath) {
        try { await deleteFile(doc.storagePath); } catch { /* ignore storage errors */ }
      }
    }

    // Modelos financeiros da empresa NÃO têm FK (companyId é índice simples) —
    // sem esta limpeza explícita eles ficariam órfãos após a exclusão.
    const modelosRemovidos = await prisma.financialModel.deleteMany({ where: { companyId: id } });

    await prisma.company.delete({ where: { id } });
    // TRILHA da exclusão — snapshot básico ANTES de sumir (analysisId null: as análises
    // em cascade não podem levar a trilha junto).
    void registrarAuditoria({
      userId: req.userId!, entity: "company", entityId: id, field: "exclusão",
      before: { razaoSocial: existing.razaoSocial, nomeFantasia: existing.nomeFantasia, cnpj: existing.cnpj, modelosFinanceiros: modelosRemovidos.count },
    });
    res.status(204).send();
  } catch (err: any) {
    console.error("Error deleting company:", err);
    res.status(500).json({ error: "Erro ao excluir empresa. Tente novamente." });
  }
});

export default router;
