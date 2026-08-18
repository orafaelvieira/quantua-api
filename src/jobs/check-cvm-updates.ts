/**
 * JOB check-cvm-updates — semanal (segunda 6h).
 * Compara o ETag/Last-Modified dos arquivos ITR/DFP publicados pela CVM com o último
 * processado (CvmSyncState) e cria um AVISO no Inbox (SystemNotice) quando há versão
 * nova — mantendo a base de pares sempre sinalizada para atualização.
 *
 * E JÁ SINCRONIZA: avisar sem agir deixava a base parada esperando alguém clicar
 * arquivo por arquivo. Agora a fila de pendentes dispara sozinha logo após a
 * checagem, em background — retomável se o container reiniciar no meio.
 */
import { withJobLock } from "./lock";
import { checarAtualizacoesCvm, sincronizarPendentesCvm, getProgressoHistorico } from "../services/cvm-sync";
import { runtimeState } from "../services/runtime-state";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { sendCvmChecagemFalhouEmail } from "../services/email";

/** Destino do alerta da base de pares (pedido do dono, 18/08/2026). */
const ALERTA_BASE_CVM = "emerson@valoo.com.br";

export async function runCheckCvmUpdates(): Promise<void> {
  await withJobLock("check-cvm-updates", async (ctx) => {
    const resultados = await checarAtualizacoesCvm();
    const novos = resultados.filter((r) => r.novo).map((r) => r.arquivo);
    const falharam = resultados.filter((r) => !r.ok).map((r) => r.arquivo);
    // O QUE A CHECAGEM ACHOU FICA GRAVADO. O JobRun já existia e registrava só
    // que a execução ocorreu; `meta` estava sendo ignorado, então "rodou e não
    // achou nada" e "rodou e não conseguiu perguntar" eram a mesma linha.
    ctx.meta = { verificados: resultados.length - falharam.length, tentados: resultados.length, novos, falharam };
    console.log(
      novos.length > 0
        ? `[check-cvm-updates] versão nova na CVM: ${novos.join(", ")} — aviso criado no Inbox`
        : `[check-cvm-updates] sem novidades (${resultados.length - falharam.length} de ${resultados.length} verificados)`,
    );
    if (falharam.length) {
      console.warn(`[check-cvm-updates] ${falharam.length} arquivo(s) não puderam ser verificados: ${falharam.join(", ")}`);
      // AVISAR QUEM PODE AGIR (18/08/2026, pedido do dono ao ver DFP 2025 e ITR
      // 2024 parados desde 10/08). O motivo já era gravado em `verificacaoErro` e
      // o selo já ficava vermelho — mas só para quem abrisse a tela de pares.
      // Base que para de ser verificada envelhece em silêncio enquanto o
      // benchmark do IBR segue publicando. Em try próprio: falha de e-mail não
      // pode derrubar o job nem impedir a fila de pendentes.
      try {
        const estados = await prisma.cvmSyncState.findMany({
          where: { arquivo: { in: falharam } },
          select: { arquivo: true, verificacaoErro: true, verificadoEm: true },
        });
        await sendCvmChecagemFalhouEmail({
          to: ALERTA_BASE_CVM,
          falhas: estados.map((e) => ({
            arquivo: e.arquivo,
            motivo: e.verificacaoErro ?? "a consulta de versão à CVM falhou",
            desde: e.verificadoEm ?? null,
          })),
          paresUrl: `${env.frontendUrl}/admin/pares`,
        });
      } catch (e) {
        console.warn("[check-cvm-updates] alerta por e-mail não pôde ser enviado:", e instanceof Error ? e.message : e);
      }
    }
    if (novos.length === 0) return;
    // Não atropela um processamento em curso nem o boot (seeds disputando CPU/RAM):
    // os avisos ficam pendentes e a próxima checagem — ou o boot — pega a fila.
    if (getProgressoHistorico().emAndamento || runtimeState.seedsRodando) {
      console.log("[check-cvm-updates] já há processamento em andamento — fila fica para depois");
      return;
    }
    console.log(`[check-cvm-updates] disparando a fila de pendentes (${novos.length} arquivo(s)) em background`);
    void sincronizarPendentesCvm().catch((e) =>
      console.error("[check-cvm-updates] fila de pendentes falhou:", e instanceof Error ? e.message : e),
    );
  });
}
