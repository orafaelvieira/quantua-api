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

export async function runCheckCvmUpdates(): Promise<void> {
  await withJobLock("check-cvm-updates", async () => {
    const resultados = await checarAtualizacoesCvm();
    const novos = resultados.filter((r) => r.novo).map((r) => r.arquivo);
    console.log(
      novos.length > 0
        ? `[check-cvm-updates] versão nova na CVM: ${novos.join(", ")} — aviso criado no Inbox`
        : `[check-cvm-updates] sem novidades (${resultados.map((r) => r.arquivo).join(", ")})`,
    );
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
