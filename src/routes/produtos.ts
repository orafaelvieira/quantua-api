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
  nomeDocumento,
  dataBaseDoIbr,
  dataBaseDoModelo,
  VersaoEnvelope,
} from "../services/produto-empresa";
import { rotuloDoDestino } from "../services/produto-vinculo";

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
/**
 * QUANTOS RÓTULOS FOGEM DO PADRÃO (12/08/2026, relato do dono: "não entendi por
 * que o padronizar nomes está aparecendo").
 *
 * O botão "Padronizar nomes…" é FERRAMENTA DE ACERVO ANTIGO — existe para
 * arrumar nomes que nasceram antes do padrão. Ele aparecia SEMPRE, no cabeçalho
 * de todo grupo de produto, inclusive numa empresa com um único IBR já chamado
 * "IBR DUNAMYS · dez/24 · v1", que É o padrão. Botão que não tem o que fazer
 * vira pergunta na cabeça do analista.
 *
 * A contagem usa a MESMA montagem de rótulo do POST /padronizar-nomes — sem
 * duplicar a regra: se o padrão mudar, os dois mudam juntos.
 */
function rotulosForaDoPadrao(produtos: Array<{ id: string; tipo: string; rotulo: string }>): number {
  const porTipo = new Map<string, number>();
  for (const p of produtos) porTipo.set(p.tipo, (porTipo.get(p.tipo) ?? 0) + 1);
  let fora = 0;
  for (const p of produtos) {
    const tipo = p.tipo as TipoProduto;
    const [cabeca, ...resto] = p.rotulo.split("—");
    const complementoAtual = resto.join("—").trim();
    const anoAtual = /(\d{4})/.exec(cabeca)?.[1] ?? "";
    const unicoDoTipo = (porTipo.get(p.tipo) ?? 0) <= 1;
    const complementoNovo = tipo === "business-plan"
      ? complementoAtual
      : tipo === "orcamento" || !unicoDoTipo
        ? complementoAtual
        : "";
    const { rotulo: rotuloNovo, erro } = montarRotulo(tipo, { periodo: anoAtual, complemento: complementoNovo });
    // Rótulo que o motor não consegue montar NÃO conta como fora do padrão: a
    // padronização o manteria como está (vai para `mantidos`), então oferecer o
    // botão por causa dele seria oferecer uma ação sem efeito.
    if (!erro && rotuloNovo && rotuloNovo !== p.rotulo) fora++;
  }
  return fora;
}

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

  const foraDoPadrao = rotulosForaDoPadrao(produtos);

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
    /** Quantos rótulos fogem do padrão — a tela só oferece "Padronizar nomes…"
     *  quando há o que padronizar (ver rotulosForaDoPadrao). */
    foraDoPadrao,
    soltos: {
      analyses: analisesSoltas.map((a) => ({ ...a, cicloVida: cicloVidaAnalysis(a.status), etapa: etapaAnalysis(a.status) })),
      models: modelosSoltos.map((m) => ({ ...m, cicloVida: cicloVidaModel(m.status), etapa: null as string | null })),
    },
  });
});

/**
 * GET /produtos/rotulo?companyId=&tipo=&complemento= — qual rótulo o "produto
 * novo" produziria e se ele está LIVRE na empresa.
 *
 * Serve aos wizards: eles avisam ANTES de criar ("esta empresa já tem o produto
 * IBR — diferencie ou use Nova versão dentro dele"), em vez de deixar o analista
 * descobrir na tela seguinte. Leitura pura, sem efeito colateral.
 */
router.get("/rotulo", async (req: AuthRequest, res: Response): Promise<void> => {
  const companyId = String(req.query.companyId ?? "");
  const tipo = String(req.query.tipo ?? "") as TipoProduto;
  if (!companyId || !TIPOS_PRODUTO.includes(tipo)) {
    res.status(400).json({ error: `companyId e tipo (${TIPOS_PRODUTO.join(", ")}) são obrigatórios` });
    return;
  }
  const company = await companyNoEscopo(companyId, req);
  if (!company) { res.status(404).json({ error: "Empresa não encontrada" }); return; }
  const r = await rotuloDoDestino({
    companyId,
    tipo,
    periodo: req.query.periodo ? String(req.query.periodo) : null,
    complemento: req.query.complemento ? String(req.query.complemento) : null,
  });
  res.json({
    rotulo: r.rotulo,
    erro: r.erro ?? null,
    disponivel: !r.erro && !!r.rotulo && !r.existente,
    existente: r.existente ?? null,
    empresa: company.nomeFantasia || company.razaoSocial,
  });
});

/**
 * POST /produtos/padronizar-nomes — aplica o padrão de nomes ao que JÁ EXISTE.
 *
 * Pedido do usuário (24/07/2026): o padrão novo (produto + empresa + data-base
 * + versão) só valia para o que nascia depois do deploy, então a lista ficava
 * com dois idiomas. Aqui o passado é acertado — com PRÉVIA obrigatória: sem
 * `aplicar: true` a rota só DIZ o que mudaria, não muda nada.
 *
 * Duas regras de prudência:
 *  - o complemento de IBR/Valuation só é removido quando a empresa tem UM
 *    produto daquele tipo; com dois ou mais, ele é o que os distingue e fica;
 *  - rótulo que colidiria com outro produto da mesma empresa não é alterado —
 *    a rota reporta o caso em vez de fundir dois produtos por conta própria.
 *
 * body: { companyId?, todas?, aplicar? }
 */
router.post("/padronizar-nomes", async (req: AuthRequest, res: Response): Promise<void> => {
  const { companyId, todas, aplicar } = (req.body ?? {}) as { companyId?: string; todas?: boolean; aplicar?: boolean };
  if (!companyId && !todas) { res.status(400).json({ error: "Informe companyId ou todas: true" }); return; }

  const empresas = companyId
    ? await prisma.company.findMany({ where: { id: companyId, ...whereEmpresaVisivel(req) }, select: { id: true, nomeFantasia: true, razaoSocial: true } })
    : await prisma.company.findMany({ where: whereEmpresaVisivel(req), select: { id: true, nomeFantasia: true, razaoSocial: true } });
  if (!empresas.length) { res.status(404).json({ error: "Empresa não encontrada" }); return; }

  const produtosRenomeados: Array<{ id: string; de: string; para: string; empresa: string }> = [];
  const documentosRenomeados: Array<{ id: string; origem: "analysis" | "model"; de: string; para: string; empresa: string }> = [];
  const mantidos: Array<{ id: string; rotulo: string; motivo: string }> = [];

  for (const empresa of empresas) {
    const nomeEmpresa = empresa.nomeFantasia || empresa.razaoSocial;
    const produtos = await prisma.produtoEmpresa.findMany({ where: { companyId: empresa.id } });
    const porTipo = new Map<string, number>();
    for (const p of produtos) porTipo.set(p.tipo, (porTipo.get(p.tipo) ?? 0) + 1);
    // Rótulos ocupados na empresa — a trava anti-duplicata vale também aqui.
    const ocupados = new Map(produtos.map((p) => [p.rotuloNorm, p.id]));

    for (const p of produtos) {
      const tipo = p.tipo as TipoProduto;
      // O rótulo atual é a única fonte do complemento e do ano ("Orçamento 2026
      // — Revisado" → ano 2026, complemento "Revisado").
      const [cabeca, ...resto] = p.rotulo.split("—");
      const complementoAtual = resto.join("—").trim();
      const anoAtual = /(\d{4})/.exec(cabeca)?.[1] ?? "";
      const unicoDoTipo = (porTipo.get(p.tipo) ?? 0) <= 1;
      const complementoNovo = tipo === "business-plan"
        ? complementoAtual
        : tipo === "orcamento" || !unicoDoTipo
          ? complementoAtual
          : ""; // IBR/Valuation únicos do tipo: o complemento vira ruído
      const { rotulo: rotuloNovo, erro } = montarRotulo(tipo, { periodo: anoAtual, complemento: complementoNovo });
      // Rótulo EFETIVO: o que o produto terá depois desta rodada. Os nomes dos
      // documentos derivam dele — nunca de um rótulo que não vai valer.
      let rotuloEfetivo = p.rotulo;
      if (erro || !rotuloNovo) {
        mantidos.push({ id: p.id, rotulo: p.rotulo, motivo: erro ?? "não foi possível montar o rótulo padrão" });
      } else if (rotuloNovo !== p.rotulo) {
        const norm = normalizarRotulo(rotuloNovo);
        const dono = ocupados.get(norm);
        if (dono && dono !== p.id) {
          mantidos.push({ id: p.id, rotulo: p.rotulo, motivo: `"${rotuloNovo}" já é de outro produto desta empresa — renomear fundiria os dois` });
        } else {
          rotuloEfetivo = rotuloNovo;
          produtosRenomeados.push({ id: p.id, de: p.rotulo, para: rotuloNovo, empresa: nomeEmpresa });
          ocupados.delete(p.rotuloNorm);
          ocupados.set(norm, p.id);
          if (aplicar) {
            await prisma.produtoEmpresa.update({ where: { id: p.id }, data: { rotulo: rotuloNovo, rotuloNorm: norm } });
            await registrarAuditoria({
              userId: req.userId!, entity: "produto_empresa", entityId: p.id, field: "rótulo padronizado",
              before: { rotulo: p.rotulo }, after: { rotulo: rotuloNovo }, source: "produtos",
            });
          }
        }
      } else {
        rotuloEfetivo = rotuloNovo;
      }

      // ── Documentos (versões) do produto ──
      const complementoFinal = rotuloEfetivo.split("—").slice(1).join("—").trim();
      const anoFinal = /(\d{4})/.exec(rotuloEfetivo.split("—")[0] ?? "")?.[1] ?? anoAtual;
      const [analyses, models] = await Promise.all([
        // dadosEstruturados entra por causa da DATA-BASE: `periodo` é texto de
        // exibição e às vezes vem sem o mês ("2026-LTM"); a lista extraída tem
        // a data do último documento, que é a definição da data-base.
        prisma.analysis.findMany({ where: { produtoId: p.id }, select: { id: true, nome: true, periodo: true, produtoVersao: true, dadosEstruturados: true } }),
        prisma.financialModel.findMany({ where: { produtoId: p.id }, select: { id: true, nome: true, mesInicial: true, produtoVersao: true } }),
      ]);
      for (const a of analyses) {
        const periodosExtraidos = (a.dadosEstruturados as { periodos?: string[] } | null)?.periodos ?? null;
        const novo = nomeDocumento({ tipo, empresa: nomeEmpresa, complemento: complementoFinal, dataBase: dataBaseDoIbr(a.periodo, periodosExtraidos), versao: a.produtoVersao ?? 1 });
        if (novo === a.nome) continue;
        documentosRenomeados.push({ id: a.id, origem: "analysis", de: a.nome, para: novo, empresa: nomeEmpresa });
        if (aplicar) {
          await prisma.analysis.update({ where: { id: a.id }, data: { nome: novo } });
          await registrarAuditoria({
            userId: req.userId!, analysisId: a.id, entity: "analysis", entityId: a.id, field: "nome padronizado",
            before: { nome: a.nome }, after: { nome: novo }, source: "produtos",
          });
        }
      }
      for (const m of models) {
        const novo = nomeDocumento({
          tipo, empresa: nomeEmpresa, complemento: complementoFinal,
          dataBase: dataBaseDoModelo(m.mesInicial), ano: anoFinal || m.mesInicial.slice(0, 4),
          versao: m.produtoVersao ?? 1,
        });
        if (novo === m.nome) continue;
        documentosRenomeados.push({ id: m.id, origem: "model", de: m.nome, para: novo, empresa: nomeEmpresa });
        if (aplicar) {
          await prisma.financialModel.update({ where: { id: m.id }, data: { nome: novo } });
          await registrarAuditoria({
            userId: req.userId!, entity: "financial_model", entityId: m.id, field: "nome padronizado",
            before: { nome: m.nome }, after: { nome: novo }, source: "produtos",
          });
        }
      }
    }
  }

  res.json({
    aplicado: !!aplicar,
    empresas: empresas.length,
    produtosRenomeados,
    documentosRenomeados,
    mantidos,
    total: produtosRenomeados.length + documentosRenomeados.length,
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
    ? await prisma.analysis.findFirst({ where: { id: registroId, companyId }, select: { id: true, nome: true, produtoId: true, status: true, periodo: true, dadosEstruturados: true } })
    : await prisma.financialModel.findFirst({ where: { id: registroId, companyId }, select: { id: true, nome: true, produtoId: true, objetivo: true, status: true, mesInicial: true } });
  if (!registro) { res.status(404).json({ error: "Registro não encontrado nesta empresa" }); return; }
  if (registro.produtoId) {
    res.status(409).json({ error: "Este registro já pertence a um produto — remova de lá antes (nada é movido em silêncio)." });
    return;
  }
  const compat = tipoCompativel(produto.tipo as TipoProduto, origem, (registro as { objetivo?: string }).objetivo);
  if (!compat.ok) { res.status(400).json({ error: compat.erro }); return; }

  const versoes = await versoesDoProduto(produto.id);
  const versao = proximaVersao(versoes);

  // NOME NO PADRÃO ao entrar no produto (24/07/2026): entrar num produto É
  // ganhar uma versão, e o nome carrega a versão. Sem isto, um registro
  // organizado à mão ficava com o nome antigo ao lado de irmãos padronizados.
  const empresaDoProduto = await prisma.company.findUnique({ where: { id: companyId }, select: { nomeFantasia: true, razaoSocial: true } });
  const nomeEmpresa = empresaDoProduto?.nomeFantasia || empresaDoProduto?.razaoSocial || "";
  const complementoProduto = produto.rotulo.split("—").slice(1).join("—").trim();
  const nomePadrao = nomeEmpresa
    ? nomeDocumento({
        tipo: produto.tipo as TipoProduto,
        empresa: nomeEmpresa,
        complemento: complementoProduto,
        dataBase: origem === "analysis"
          ? dataBaseDoIbr((registro as { periodo?: string | null }).periodo, ((registro as { dadosEstruturados?: { periodos?: string[] } | null }).dadosEstruturados)?.periodos ?? null)
          : dataBaseDoModelo((registro as { mesInicial?: string }).mesInicial ?? ""),
        ano: /(\d{4})/.exec(produto.rotulo)?.[1] ?? (registro as { mesInicial?: string }).mesInicial?.slice(0, 4),
        versao,
      })
    : registro.nome;

  if (origem === "analysis") {
    await prisma.analysis.update({ where: { id: registroId }, data: { produtoId: produto.id, produtoVersao: versao, nome: nomePadrao } });
  } else {
    await prisma.financialModel.update({ where: { id: registroId }, data: { produtoId: produto.id, produtoVersao: versao, nome: nomePadrao } });
  }
  if (nomePadrao !== registro.nome) {
    await registrarAuditoria({
      userId: req.userId!, entity: origem === "analysis" ? "analysis" : "financial_model", entityId: registroId,
      ...(origem === "analysis" ? { analysisId: registroId } : {}),
      field: "nome padronizado (entrada no produto)",
      before: { nome: registro.nome }, after: { nome: nomePadrao }, source: "produtos",
    });
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

// DELETE /produtos/:id — remove o ENVELOPE VAZIO (pedido do usuário, 27/07/2026).
//
// O envelope existe para guardar versões: sem nenhuma, ele é só um rótulo — não
// é evidência de nada e ainda assim contava no "Produtos N" da tela, o que fazia
// a empresa parecer ter produto que não tem. Envelope COM versão nunca sai por
// aqui (a política da casa vale para o conteúdo: cancele/exclua as versões
// primeiro, cada uma com sua própria regra).
//
// body: { companyId } — mesmo contrato das demais mutações (guarda de suspensão).
router.delete("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const { companyId } = (req.body ?? {}) as Record<string, string | undefined>;
  if (!companyId) { res.status(400).json({ error: "companyId é obrigatório" }); return; }
  const produto = await produtoNoEscopo(req.params.id as string, req);
  if (!produto) { res.status(404).json({ error: "Produto não encontrado" }); return; }
  if (produto.companyId !== companyId) { res.status(400).json({ error: "companyId não confere com o produto" }); return; }

  const versoes = await versoesDoProduto(produto.id);
  if (versoes.length > 0) {
    res.status(409).json({
      error: `"${produto.rotulo}" tem ${versoes.length} versão(ões) — o produto guarda o histórico delas. Exclua ou cancele as versões primeiro; o envelope sai quando ficar vazio.`,
      versoes: versoes.map((v) => ({ id: v.id, nome: v.nome, status: v.status })),
    });
    return;
  }

  await prisma.produtoEmpresa.delete({ where: { id: produto.id } });
  await registrarAuditoria({
    userId: req.userId!, entity: "produto_empresa", entityId: produto.id,
    field: "exclusão do produto (envelope vazio)",
    before: { tipo: produto.tipo, rotulo: produto.rotulo, companyId: produto.companyId, criadoEm: produto.createdAt },
    source: "produtos",
  });
  res.status(204).send();
});

export default router;
