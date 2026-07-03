/**
 * JOB check-cvm-updates — semanal (segunda 6h).
 * Compara o ETag/Last-Modified dos arquivos ITR/DFP publicados pela CVM com o último
 * processado (CvmSyncState) e cria um AVISO no Inbox (SystemNotice) quando há versão
 * nova — mantendo a base de pares sempre sinalizada para atualização.
 */
import { withJobLock } from "./lock";
import { checarAtualizacoesCvm } from "../services/cvm-sync";

export async function runCheckCvmUpdates(): Promise<void> {
  await withJobLock("check-cvm-updates", async () => {
    const resultados = await checarAtualizacoesCvm();
    const novos = resultados.filter((r) => r.novo).map((r) => r.arquivo);
    console.log(
      novos.length > 0
        ? `[check-cvm-updates] versão nova na CVM: ${novos.join(", ")} — aviso criado no Inbox`
        : `[check-cvm-updates] sem novidades (${resultados.map((r) => r.arquivo).join(", ")})`,
    );
  });
}
