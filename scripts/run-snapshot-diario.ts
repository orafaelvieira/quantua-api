/** Dispara o snapshot diário manualmente (dev/diagnóstico) — mesmo código do cron. */
import { runSnapshotDiario } from "../src/jobs/snapshot-diario";

runSnapshotDiario()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
