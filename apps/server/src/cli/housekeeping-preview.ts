import { openReadOnlyDatabase } from "../db/client.js";
import { parseArgs } from "node:util";
import { previewMemoryHousekeeping } from "../services/retention-policy.js";

// Explicit file path; no loadConfig, bootstrap, migrations, scheduler or server.
const { values } = parseArgs({
  options: {
    db: { type: "string" },
    days: { type: "string", default: "30" },
    at: { type: "string" },
    limit: { type: "string", default: "100" },
    cursor: { type: "string" },
  },
});
if (!values.db)
  throw new Error("--db is required (existing SQLite file; read-only).");
const sqlite = openReadOnlyDatabase(values.db);
try {
  const result = previewMemoryHousekeeping(
    { sqlite },
    { housekeepingProposalRetentionDays: Number(values.days) },
    {
      nowMs: values.at ? Date.parse(values.at) : undefined,
      limit: Number(values.limit),
      cursor: values.cursor,
    },
  );
  console.log(JSON.stringify(result));
} finally {
  sqlite.close();
}
