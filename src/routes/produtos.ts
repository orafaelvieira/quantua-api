/**
 * PRODUTOS DA EMPRESA (Workspace FP&A, W1) — envelopes de versões.
 *
 * Camada 100% ADITIVA: nenhum fluxo de IBR ou Valuation é alterado. Declarar um
 * registro como versão só preenche `produtoId`/`produtoVersao` (campos novos,
 * anuláveis) — o registro em si não muda.
 *
 * Toda mutação emite trilha via registrarAuditoria (regra da casa). As mutações
 * de sub-rota exigem `companyId` no body: auto-documenta e permite à guarda de
 * suspensão resolver a empresa-alvo (fail-closed sem isso).
 */
import { Router, Response } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { whereEmpresaVisivel, guardaEscritaSuspensao } from "../services/escopo-empresa";
import { prisma } from "../db/client";
import { registrarAuditoria } from "../services/audit-trail";
import { cicloVidaAnalysis, cicloVidaModel, etapaAnalysis } from "../services/ciclo-vida";
import {
  TIPOS_PRODUTO,
  TipoProduto,
  normalizarRotulo,
  montarRotulo,
  proximaVersao,
  vigenteDoEnvelope,
  tipoCompativel,
  VersaoEnvelope,
} from "../services/produto-empresa";

const router = Router();
router.use(requireAuth);
// Org suspensa lê mas não escreve (o alvo resolve pelo companyId do body/query).
router.use(guardaEscritaSuspensao("company-body"));

async function companyNoEscopo(companyId: string, req: AuthRequest) {
  return prisma.company.findFirst({ where: { id: companyId, ...whereEmpresaVisivel(req) } });
}

async function produtoNoEscopo(id: string, req: AuthRequest) {
  const produto = await prisma.produtoEmpresa.findUnique({ where: { id } });
  if (!produto) return null;
  const company = await companyNoEscopo(produto.companyId, req);
  return company ? produto : null;
}

/** Versões do envelope no formato das regras puras + dados de exibição. */
async function versoesDoProduto(produtoId: string) {
  const [analyses, models] = await Promise.all([
    prisma.analysis.findMany({
      where: { produtoId },
      select: { id: true, nome: true, status: true, periodo: true, createdAt: true, produtoVersao: true, motivoVersao: true },
    }),
    prisma.financialModel.findMany({
      where: { produtoId },
      select: { id: true, nome: true, status: true, objetivo: true, mesInicial: true, horizonteMeses: true, updatedAt: true, createdAt: true, produtoVersao: true, motivoVersao: true },
    }),
  ]);
  // CICLO DE VIDA UNIFICADO (21/07/2026): `status` segue cru (compat); as telas
  // novas usam cicloVida+etapa; motivoVersao explica por que a versão existe.
  const versoes = [
    ...analyses.map((a) => ({ origem: "analysis" as const, id: a.id, nome: a.nome, status: a.status, cicloVida: cicloVidaAnalysis(a.status), etapa: etapaAnalysis(a.status), motivoVersao: a.motivoVersao, detalhe: a.periodo ?? "", criadoEm: a.createdAt, produtoVersao: a.produtoVersao ?? 0 })),
    ...models.map((m) => ({ origem: "model" as const, id: m.id, nome: m.nome, status: m.status, cicloVida: cicloVidaModel(m.status), etapa: null as string | null, motivoVersao: m.motivoVersao, detalhe: `${m.mesInicial} · ${m.horizonteMeses}m`, criadoEm: m.createdAt, produtoVersao: m.produtoVersao ?? 0 })),
  ].sort((a, b) => b.produtoVersao - a.produtoVersao);
  return versoes;
}

// GET /produtos?companyId= — envelopes da empresa (com versões e vigente
// resolvido) + registros SOLTOS (sem envelope), para a ação "organizar versões".
router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const companyId = String(req.query.companyId ?? "");
  if (!companyId) { res.status(400).json({ error: "companyId é obrigatório" }); return; }
  const company = await companyNoEscopo(companyId, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  const produtos = await prisma.produtoEmpresa.findMany({
    where: { companyId },
    orderBy: [{ tipo: "asc" }, { createdAt: "asc" }],
  });

  const compostos = await Promise.all(
    produtos.map(async (p) => {
      const versoes = await versoesDoProduto(p.id);
      const paraRegra: VersaoEnvelope[] = versoes.map((v) => ({ id: v.id, produtoVersao: v.produtoVersao, status: v.status }));
      return {
        id: p.id,
        tipo: p.tipo,
        rotulo: p.rotulo,
        // A vigência do IBR é DERIVADA aqui (decisão 20/07/2026) — nunca gravada
        // por hook no fluxo do IBR.
        vigenteId: vigenteDoEnvelope(p.tipo as TipoProduto, p.versaoVigenteId, paraRegra),
        versoes,
      };
    })
  );

  const [analisesSoltas, modelosSoltos] = await Promise.all([
    prisma.analysis.findMany({
      // ehTeste fora de TODA listagem (higienização 21/07) — o workspace incluso.
      where: { companyId, produtoId: null, ehTeste: false },
      orderBy: { createdAt: "desc" },
      select: { id: true, nome: true, status: true, periodo: true, createdAt: true },
    }),
    prisma.financialModel.findMany({
      where: { companyId, produtoId: null },
      orderBy: { updatedAt: "desc" },
      select: { id: true, nome: true, status: true, objetivo: true, mesInicial: true, horizonteMeses: true, updatedAt: true },
    }),
  ]);

  res.json({
    produtos: compostos,
    soltos: {
      analyses: analisesSoltas.map((a) => ({ ...a, cicloVida: cicloVidaAnalysis(a.status), etapa: etapaAnalysis(a.status) })),
      models: modelosSoltos.map((m) => ({ ...m, cicloVida: cicloVidaModel(m.status), etapa: null as string | null })),
    },
  });
});

// POST /produtos — cria um envelope. Colisão de rótulo normalizado devolve 409
// COM a sugestão ("isto é uma nova versão de X?") — nunca cria duplicata.
// body: { companyId, tipo, periodo?, complemento? }
router.post("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const { companyId, tipo, periodo, complemento } = (req.body ?? {}) as Record<string, string | undefined>;
  if (!companyId) { res.status(400).json({ error: "companyId é obrigatório" }); return; }
  if (!tipo || !TIPOS_PRODUTO.includes(tipo as TipoProduto)) {
    res.status(400).json({ error: `tipo inválido — use: ${TIPOS_PRODUTO.join(", ")}` });
    return;
  }
  const company = await companyNoEscopo(companyId, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  const { rotulo, erro } = montarRotulo(tipo as TipoProduto, { periodo, complemento });
  if (erro) { res.status(400).json({ error: erro }); return; }
  const rotuloNorm = normalizarRotulo(rotulo);

  const existente = await prisma.produtoEmpresa.findFirst({ where: { companyId, rotuloNorm } });
  if (existente) {
    res.status(409).json({
      error: `Já existe o produto "${existente.rotulo}" nesta empresa.`,
      sugestao: { produtoId: existente.id, rotulo: existente.rotulo, pergunta: `Isto é uma nova versão de "${existente.rotulo}"?` },
    });
    return;
  }

  const criado = await prisma.produtoEmpresa.create({
    data: { companyId, tipo, rotulo, rotuloNorm, userId: req.userId! },
  });
  await registrarAuditoria({
    userId: req.userId!, entity: "produto_empresa", entityId: criado.id,
    field: "criação do produto", after: { tipo, rotulo, companyId }, source: "produtos",
  });
  res.json({ ok: true, produto: { id: criado.id, tipo: criado.tipo, rotulo: criado.rotulo, vigenteId: null, versoes: [] } });
});

// POST /produtos/:id/versoes — DECLARA um registro existente como nova versão.
// Não altera o registro além dos dois campos novos; nada de fluxo de IBR/Valuation.
// body: { companyId, origem: "analysis"|"model", registroId }
router.post("/:id/versoes", async (req: AuthRequest, res: Response): Promise<void> => {
  const { companyId, origem, registroId } = (req.body ?? {}) as Record<string, string | undefined>;
  if (!companyId || !registroId || (origem !== "analysis" && origem !== "model")) {
    res.status(400).json({ error: "companyId, origem (analysis|model) e registroId são obrigatórios" });
    return;
  }
  const produto = await produtoNoEscopo(req.params.id as string, req);
  if (!produto) { res.status(404).json({ error: "Produto não encontrado" }); return; }
  if (produto.companyId !== companyId) { res.status(400).json({ error: "companyId não confere com o produto" }); return; }

  // O registro precisa ser DA MESMA empresa, estar SOLTO, e casar com o tipo.
  const registro = origem === "analysis"
    ? await prisma.analysis.findFirst({ where: { id: registroId, companyId }, select: { id: true, nome: true, produtoId: true, status: true } })
    : await prisma.financialModel.findFirst({ where: { id: registroId, companyId }, select: { id: true, nome: true, produtoId: true, objetivo: true, status: true } });
  if (!registro) { res.status(404).json({ error: "Registro não encontrado nesta empresa" }); return; }
  if (registro.produtoId) {
    res.status(409).json({ error: "Este registro já pertence a um produto — remova de lá antes (nada é movido em silêncio)." });
    return;
  }
  const compat = tipoCompativel(produto.tipo as TipoProduto, origem, (registro as { objetivo?: string }).objetivo);
  if (!compat.ok) { res.status(400).json({ error: compat.erro }); return; }

  const versoes = await versoesDoProduto(produto.id);
  const versao = proximaVersao(versoes);

  if (origem === "analysis") {
    await prisma.analysis.update({ where: { id: registroId }, data: { produtoId: produto.id, produtoVersao: versao } });
  } else {
    await prisma.financialModel.update({ where: { id: registroId }, data: { produtoId: produto.id, produtoVersao: versao } });
  }

  // Primeiro registro de um envelope NÃO-IBR vira vigente por default óbvio
  // (envelope de 1 versão sem vigente não informa nada); depois disso, manual.
  // IBR nunca grava ponteiro — vigência derivada.
  let vigenteInicial = false;
  if (produto.tipo !== "ibr" && versoes.length === 0 && !produto.versaoVigenteId) {
    await prisma.produtoEmpresa.update({ where: { id: produto.id }, data: { versaoVigenteId: registroId } });
    vigenteInicial = true;
  }

  await registrarAuditoria({
    userId: req.userId!, entity: "produto_empresa", entityId: produto.id,
    field: "versão declarada",
    after: { origem, registroId, nome: registro.nome, versao, vigenteInicial },
    source: "produtos",
  });

  const atualizadas = await versoesDoProduto(produto.id);
  const paraRegra: VersaoEnvelope[] = atualizadas.map((v) => ({ id: v.id, produtoVersao: v.produtoVersao, status: v.status }));
  const recarregado = await prisma.produtoEmpresa.findUnique({ where: { id: produto.id } });
  res.json({
    ok: true,
    produto: {
      id: produto.id, tipo: produto.tipo, rotulo: produto.rotulo,
      vigenteId: vigenteDoEnvelope(produto.tipo as TipoProduto, recarregado?.versaoVigenteId, paraRegra),
      versoes: atualizadas,
    },
  });
});

// PUT /produtos/:id/vigente — define a versão vigente MANUALMENTE.
// IBR é rejeitado: a vigência dele é automática (maior versão Concluída).
// body: { companyId, registroId }
router.put("/:id/vigente", async (req: AuthRequest, res: Response): Promise<void> => {
  const { companyId, registroId } = (req.body ?? {}) as Record<string, string | undefined>;
  if (!companyId || !registroId) { res.status(400).json({ error: "companyId e registroId são obrigatórios" }); return; }
  const produto = await produtoNoEscopo(req.params.id as string, req);
  if (!produto) { res.status(404).json({ error: "Produto não encontrado" }); return; }
  if (produto.companyId !== companyId) { res.status(400).json({ error: "companyId não confere com o produto" }); return; }
  if (produto.tipo === "ibr") {
    res.status(409).json({ error: "A vigência do IBR é automática: a maior versão concluída é sempre a vigente." });
    return;
  }

  const versoes = await versoesDoProduto(produto.id);
  if (!versoes.some((v) => v.id === registroId)) {
    res.status(400).json({ error: "O registro indicado não é uma versão deste produto." });
    return;
  }

  const antes = produto.versaoVigenteId;
  await prisma.produtoEmpresa.update({ where: { id: produto.id }, data: { versaoVigenteId: registroId } });
  await registrarAuditoria({
    userId: req.userId!, entity: "produto_empresa", entityId: produto.id,
    field: "versão vigente", before: { vigenteId: antes }, after: { vigenteId: registroId }, source: "produtos",
  });
  res.json({ ok: true, vigenteId: registroId });
});

export default router;
