import path from "node:path";
import { loadConfig, serverRoot } from "../config.js";
import { restoreBackup, verifyBackup } from "../services/backup.js";

const args = process.argv.slice(2);
const wipe = args.includes("--wipe");
const positional = args.filter((a) => !a.startsWith("--"));
const backupFile = positional[0]
  ? path.resolve(serverRoot, positional[0])
  : null;

if (
  !backupFile ||
  positional.length !== 1 ||
  args.some(
    (a) => a.startsWith("--") && !["--wipe", "--service-stopped"].includes(a),
  )
) {
  console.error(
    "Usage: pnpm --filter @contextkeep/server restore <backup-file.sqlite> [--service-stopped] [--wipe]\n" +
      "  --wipe  delete the current data dir contents instead of moving them to .trash-<ts>\n" +
      "Stop the ContextKeep server first. Exclusive directory ownership is always required.\n" +
      "  --service-stopped  accepted for compatibility; does not bypass ownership checks.",
  );
  process.exit(64);
}

const config = loadConfig();
const verification = verifyBackup(backupFile);
console.log(
  `[contextkeep] backup verified: schema v${verification.schemaVersion}, integrity ok — ` +
    `projects=${verification.counts.projects} records=${verification.counts.records}`,
);
console.warn(
  `[contextkeep] restoring over data dir ${config.dataDir} (exclusive directory ownership required)`,
);
const result = restoreBackup({
  dataDir: config.dataDir,
  backupFile,
  hardWipe: wipe,
  ctx: { actor: "cli:restore" },
});
console.log(
  `[contextkeep] restore complete: ${result.restored}\n` +
    (result.trashDir
      ? `  previous data moved to ${result.trashDir}\n`
      : "  previous data wiped (--wipe)\n") +
    `  projects=${result.counts.projects} records=${result.counts.records}`,
);
