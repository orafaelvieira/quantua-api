/**
 * SELEÇÃO DOS DOCUMENTOS CONTÁBEIS DO IBR (11/08/2026, pedido do dono).
 *
 * UM endereço serve o wizard E a aba Escopo — "se saiu do wizard precisa ter a
 * opção de escolher novamente os documentos fora do wizard". Duas telas com
 * duas regras de seleção divergiriam no primeiro conserto.
 *
 * O GET devolve tudo que a decisão exige, já mastigado pelo servidor:
 *   · o pool contábil da empresa, com o INTERVALO que cada documento cobre;
 *   · o selo de CONCILIAÇÃO por documento, com o motivo quando não fecha
 *     (garantia 6: documento não conciliado não entra em IBR);
 *   · em que outros IBRs cada documento já foi usado (garantia 7);
 *   · a avaliação da SÉRIE da seleção atual — buraco no meio reprova e o motivo
 *     nomeia o período que falta;
 *   · o veredito `podeRodar` com TODOS os motivos juntos. O analista precisa
 *     saber por que não dá para rodar, não descobrir um impedimento por vez.
 *
 * Vive em arquivo próprio e se pendura no router de /analyses: a rota de
 * análises já tem 3 mil linhas, e esta regra é de escopo, não de análise.
 */
import { Router, Response } from "express";
import { z } from "zod";
import type { AuthRequest } from "../middleware/auth";
import { prisma } from "../db/client";
import { MATERIAL_TIPO } from "../services/material-context";
import { insumosDaBase, montarBaseContabil } from "../services/base-contabil";
import { avaliarSerie, trechoContinuoMaisRecente, type ColunaSerie } from "../services/serie-periodos";
import { fixarDocumentosDoPool, conjuntoJaUsadoEmOutroIBR } from "../services/fixacao-pool";
import { registrarAuditoria } from "../services/audit-trail";

export const ERRO_CONCLUIDA = "IBR concluído é imutável — crie uma nova versão para mudar o escopo.";

type Escopo = { whereRecursoEmpresa: (req: AuthRequest) => Record<string, unknown> };

export function registrarRotasDocumentosBase(router: Router, { whereRecursoEmpresa }: Escopo): void {
  router.get("/:id/documentos-base", async (req: AuthRequest, res: Response): Promise<void> => {
    const id = req.params.id as string;
    const analysis = await prisma.analysis.findFirst({
      where: { id, ...whereRecursoEmpresa(req) },
      select: {
        id: true, companyId: true, status: true,
        documents: { select: { id: true, tipo: true, status: true, fixadoDeId: true } },
      },
    });
    if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }

    const pool = await prisma.document.findMany({
      where: { companyId: analysis.companyId, analysisId: null, status: { not: "Substituído" }, tipo: { not: MATERIAL_TIPO } },
      select: { id: true, nome: true, tipo: true, competencia: true, tamanho: true, versao: true, createdAt: true },
      orderBy: [{ tipo: "asc" }, { createdAt: "asc" }],
    });
    const insumos = await insumosDaBase(analysis.companyId, req.scopeUserIds!);
    const base = await montarBaseContabil(analysis.companyId, req.scopeUserIds!, insumos);
    const conc = base.conciliacaoPorDocumento as Record<string, { ok: boolean; motivos: string[] }>;
    const intervalos = base.intervaloPorDocumento;

    // Onde cada documento já foi usado — IBR CANCELADO não conta como uso.
    const usados = await prisma.document.findMany({
      where: { companyId: analysis.companyId, analysisId: { not: null }, fixadoDeId: { in: pool.map((p) => p.id) } },
      select: { fixadoDeId: true, analysisId: true, analysis: { select: { nome: true, status: true } } },
    });
    const usoPorPool = new Map<string, Array<{ analysisId: string; nome: string; status: string }>>();
    for (const u of usados) {
      if (!u.fixadoDeId || !u.analysisId || u.analysis?.status === "Cancelada") continue;
      const lista = usoPorPool.get(u.fixadoDeId) ?? [];
      lista.push({ analysisId: u.analysisId, nome: u.analysis?.nome ?? "IBR", status: u.analysis?.status ?? "?" });
      usoPorPool.set(u.fixadoDeId, lista);
    }

    const selecionados = new Set(
      analysis.documents
        .filter((d) => d.fixadoDeId && d.tipo !== MATERIAL_TIPO && d.status !== "Substituído")
        .map((d) => d.fixadoDeId!),
    );
    const documentos = pool.map((p) => ({
      id: p.id, nome: p.nome, tipo: p.tipo, competencia: p.competencia, tamanho: p.tamanho, versao: p.versao,
      intervalo: intervalos[p.id] ?? null,
      conciliado: conc[p.id] ?? { ok: false, motivos: ["ainda sem leitura na Data room — abra a aba Conciliação contábil"] },
      usadoEm: (usoPorPool.get(p.id) ?? []).filter((u) => u.analysisId !== analysis.id),
      selecionado: selecionados.has(p.id),
    }));

    const colunasDe = (ds: typeof documentos): ColunaSerie[] =>
      ds.filter((d) => d.intervalo).map((d) => ({
        periodo: d.intervalo!.fim, tipo: d.intervalo!.tipo, inicio: d.intervalo!.inicio, fim: d.intervalo!.fim,
      }));
    const colunas = colunasDe(documentos.filter((d) => d.selecionado));
    const serie = avaliarSerie(colunas);

    const motivos: string[] = [];
    if (selecionados.size === 0) motivos.push("nenhum documento contábil selecionado");
    for (const d of documentos.filter((x) => x.selecionado && !x.conciliado.ok)) {
      motivos.push(`"${d.nome}" não está conciliado: ${d.conciliado.motivos.join(" · ")}`);
    }
    motivos.push(...serie.motivos);
    const reuso = await conjuntoJaUsadoEmOutroIBR(analysis.id, analysis.companyId);
    if (reuso) {
      motivos.push(
        `estes mesmos documentos já foram usados no IBR "${reuso.nome}" (${reuso.status}) — inclua um documento novo, ou crie uma nova versão daquele IBR em vez de um IBR novo`,
      );
    }

    res.json({
      documentos,
      serie,
      // Quando a série está furada e o documento que falta não existe, este é o
      // clique de resgate: "usar só o trecho contínuo mais recente".
      sugestaoTrechoContinuo: serie.ok ? null : trechoContinuoMaisRecente(colunas),
      podeRodar: { ok: motivos.length === 0, motivos },
      reuso,
    });
  });

  /**
   * Aplica a seleção: fixa o que entrou, desfixa o que saiu. A tela manda a
   * lista COMPLETA do que deve ficar selecionado, não um delta — delta com duas
   * abas abertas vira estado inconsistente.
   */
  router.put("/:id/documentos-base", async (req: AuthRequest, res: Response): Promise<void> => {
    const id = req.params.id as string;
    const parsed = z.object({ documentIds: z.array(z.string().uuid()).max(200) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const analysis = await prisma.analysis.findFirst({
      where: { id, ...whereRecursoEmpresa(req) },
      select: {
        id: true, companyId: true, status: true,
        documents: { select: { id: true, nome: true, tipo: true, status: true, fixadoDeId: true } },
      },
    });
    if (!analysis) { res.status(404).json({ error: "Análise não encontrada" }); return; }
    if (analysis.status === "Concluída") { res.status(409).json({ error: ERRO_CONCLUIDA }); return; }

    const querem = new Set(parsed.data.documentIds);
    const atuais = analysis.documents.filter((d) => d.fixadoDeId && d.tipo !== MATERIAL_TIPO && d.status !== "Substituído");
    const remover = atuais.filter((d) => !querem.has(d.fixadoDeId!));
    const adicionar = [...querem].filter((pid) => !atuais.some((d) => d.fixadoDeId === pid));

    for (const d of remover) {
      await prisma.document.delete({ where: { id: d.id } }).catch(() => {});
      void registrarAuditoria({
        userId: req.userId!, analysisId: analysis.id, entity: "document", entityId: d.id,
        field: "documento retirado do escopo do IBR",
        before: { nome: d.nome, tipo: d.tipo, documentoPoolId: d.fixadoDeId }, source: "escopo",
      });
    }
    const fixacao = adicionar.length
      ? await fixarDocumentosDoPool({ id: analysis.id, companyId: analysis.companyId }, adicionar)
      : { fixados: [], erros: [] };
    for (const f of fixacao.fixados) {
      if (f.jaExistia) continue;
      void registrarAuditoria({
        userId: req.userId!, analysisId: analysis.id, entity: "document", entityId: f.id,
        field: "documento incluído no escopo do IBR",
        after: { nome: f.nome, tipo: f.tipo, competencia: f.competencia, documentoPoolId: f.fixadoDeId },
        source: "escopo",
      });
    }
    res.json({ removidos: remover.length, ...fixacao });
  });
}
