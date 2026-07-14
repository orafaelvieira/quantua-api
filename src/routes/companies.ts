import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../db/client";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { deleteFile } from "../services/storage";
import { registrarAuditoria, diffCampos } from "../services/audit-trail";
import { sugerirSetores } from "../services/cnae-b3";

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

router.get("/cnpj/:cnpj", async (req: AuthRequest, res: Response): Promise<void> => {
  const digits = (req.params.cnpj as string).replace(/\D/g, "");
  if (digits.length !== 14) { res.status(400).json({ error: "CNPJ inválido" }); return; }

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
      res.json(await r.json());
      return;
    } catch (err) {
      console.error(`[cnpj] ${nome} falhou:`, err instanceof Error ? err.message : err);
    }
  }

  // 3ª perna: ReceitaWS (shape próprio → normalizado)
  try {
    const r = await fetch(`https://receitaws.com.br/v1/cnpj/${digits}`, { headers: CABECALHOS_CNPJ, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const d = (await r.json()) as Record<string, any>;
      if (d.status !== "ERROR" && d.nome) { res.json(normalizarReceitaWs(d)); return; }
      houve404 = houve404 || d.status === "ERROR";
    } else {
      console.error(`[cnpj] ReceitaWS ${digits} → HTTP ${r.status}`);
    }
  } catch (err) {
    console.error("[cnpj] ReceitaWS falhou:", err instanceof Error ? err.message : err);
  }

  if (houve404) { res.status(404).json({ error: "CNPJ não encontrado na Receita Federal" }); return; }
  res.status(502).json({ error: "Fontes da Receita indisponíveis no momento — preencha manualmente e reconsulte depois" });
});

router.use(requireAuth);

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
    where: { userId: { in: req.scopeUserIds! } },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { analyses: true } } },
  });
  res.json(companies);
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

router.post("/", async (req: AuthRequest, res: Response): Promise<void> => {
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
    where: { id, userId: { in: req.scopeUserIds! } },
    include: { analyses: { orderBy: { createdAt: "desc" }, take: 10 } },
  });
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  res.json(company);
});

/** Sugestão de SETOR B3 pelo CNAE da Receita (principal + secundários) — zero IA.
 *  Sinal FRACO: pré-preenche o picker do wizard com selo; nunca confirma sozinho. */
router.get("/:id/sugestao-setor", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const company = await prisma.company.findFirst({
    where: { id, userId: { in: req.scopeUserIds! } },
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
