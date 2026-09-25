import { checkSchemaVersion } from "../db/bootstrap.js";
import { openDatabase } from "../db/client.js";
import { loadConfig } from "../config.js";
import { createAdapterRegistry } from "../adapters/registry.js";
import { createBackup } from "../services/backup.js";

const config = loadConfig();
const handle = openDatabase(config.dbPath, config.sqliteSynchronous);

// Backup is deliberately NON-MIGRATING. It may snapshot any store whose schema
// is not newer than this server build supports, but it must never run Drizzle
// migrations or stamp schema_version as a side effect. This protects rollback /
// certification workflows where workspace packages may temporarily differ.
try {
  checkSchemaVersion(handle);

  const deps = {
    db: handle.db,
    sqlite: handle.sqlite,
    registry: createAdapterRegistry(config.adapters),
    costCeilingUsd: config.costCeilingUsd,
    volatileReviewIntervalDays: config.volatileReviewIntervalDays,
  };
  const summary = await createBackup(
    handle,
    deps,
    config.backupDir,
    config.backupKeep,
    { actor: "cli:backup" },
  );
  console.log(
    `[contextkeep] backup written: ${summary.file} (${summary.sizeBytes} bytes)\n` +
      `  projects=${summary.counts.projects} sources=${summary.counts.sources} records=${summary.counts.records} ` +
      `supersessions=${summary.counts.supersessions} auditEvents=${summary.counts.auditEvents}`,
  );
} finally {
  handle.sqlite.close();
}
