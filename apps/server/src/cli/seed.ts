import { bootstrapDatabase } from "../db/bootstrap.js";
import { openDatabase } from "../db/client.js";
import { loadConfig } from "../config.js";
import { createAdapterRegistry } from "../adapters/registry.js";
import { seedDemo } from "../seed.js";

const config = loadConfig();
const handle = openDatabase(config.dbPath, config.sqliteSynchronous);
bootstrapDatabase(handle);
const deps = { db: handle.db, sqlite: handle.sqlite, registry: createAdapterRegistry(config.adapters), costCeilingUsd: config.costCeilingUsd, volatileReviewIntervalDays: config.volatileReviewIntervalDays };
const result = seedDemo(deps, { actor: "system:seed" });
if (result.seeded) {
  console.log(
    `[contextkeep] demo data seeded: ${Object.keys(result.projectIds).length} projects, ${result.recordCount} records.`,
  );
  console.log(JSON.stringify(result.projectIds, null, 2));
} else {
  console.log("[contextkeep] seed skipped — store already has projects.");
}
handle.sqlite.close();
