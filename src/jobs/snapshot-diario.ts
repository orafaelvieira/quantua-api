import { prisma } from "../db/client";
import { withJobLock } from "./lock";
import {
  hashConteudo,
  montarConteudoAnalise,
  montarConteudoModelo,
  MAX_FOTOS_AUTO,
  STATUS_TRANSITORIOS,
  type DocFoto,
} from "../services/snapshot-diario";

/**
 * SNAPSHOT AUTOMÁTICO DIÁRIO — o cron que tira a foto (rede de segurança
 * tipo Excel). Processa UMA entidade por vez (fetch por id, nunca a carteira
 * inteira em memória — lição do cvm-sync: o container é pequeno e o health
 * check derruba event loop travado). Dedup por hash: dia sem mudança não
 * grava. Poda mantém as últimas MAX_FOTOS_AUTO fotos automáticas por
 * entidade; "pre-restauracao" nunca é podada (evidência de restauração).
 */
export async function runSnapshotDiario(): Promise<void> {
  await withJobLock("snapshot-diario", async (ctx) => {
    let fotosAnalises = 0;
    let fotosModelos = 0;
    let inalterados = 0;
    let podadas = 0;

    const gravarSeMudou = async (
      entidade: "analysis" | "model",
      entidadeId: string,
      companyId: string,
      conteudo: unknown,
    ): Promise<void> => {
      const hash = hashConteudo(conteudo);
      const ultima = await prisma.snapshotDiario.findFirst({
        where: { entidade, entidadeId },
        orderBy: { criadoEm: "desc" },
        select: { hash: true },
      });
      if (ultima?.hash === hash) { inalterados++; return; }
      await prisma.snapshotDiario.create({
        data: { entidade, entidadeId, companyId, conteudo: conteudo as object, hash },
      });
      if (entidade === "analysis") fotosAnalises++; else fotosModelos++;

      // Poda: só as automáticas além da janela.
      const excedentes = await prisma.snapshotDiario.findMany({
        where: { entidade, entidadeId, origem: "auto-diario" },
        orderBy: { criadoEm: "desc" },
        skip: MAX_FOTOS_AUTO,
        select: { id: true },
      });
      if (excedentes.length > 0) {
        await prisma.snapshotDiario.deleteMany({ where: { id: { in: excedentes.map((e) => e.id) } } });
        podadas += excedentes.length;
      }
    };

    // IBRs — pula estado transitório (foto de processamento a meio caminho não protege nada).
    const analises = await prisma.analysis.findMany({
      where: { status: { notIn: STATUS_TRANSITORIOS } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    for (const { id } of analises) {
      const a = await prisma.analysis.findUnique({
        where: { id },
        include: {
          documents: {
            where: { status: { not: "Substituído" } },
            select: {
              id: true, nome: true, tipo: true, competencia: true, moeda: true, status: true,
              confianca: true, dadosExtraidos: true, editadoManualmente: true, versao: true,
              hash: true, fixadoDeId: true,
            },
          },
        },
      });
      if (!a || STATUS_TRANSITORIOS.includes(a.status)) continue;
      const conteudo = montarConteudoAnalise(a as unknown as Record<string, unknown>, a.documents as DocFoto[]);
      await gravarSeMudou("analysis", a.id, a.companyId, conteudo);
    }

    // Modelos financeiros.
    const modelos = await prisma.financialModel.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } });
    for (const { id } of modelos) {
      const m = await prisma.financialModel.findUnique({
        where: { id },
        include: {
          blocks: { select: { id: true, tipo: true, nome: true, ordem: true, modo: true, ativo: true, config: true } },
          scenarios: { select: { id: true, nome: true, isBase: true, overrides: true } },
        },
      });
      if (!m) continue;
      const conteudo = montarConteudoModelo(m as unknown as Record<string, unknown>, m.blocks, m.scenarios);
      await gravarSeMudou("model", m.id, m.companyId, conteudo);
    }

    ctx.meta = { fotosAnalises, fotosModelos, inalterados, podadas };
  });
}
