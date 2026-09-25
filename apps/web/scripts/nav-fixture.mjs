// Private child-process bootstrap for verify-nav.mjs; never loads a .env file.
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

let app;
let closing = false;

async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 4000);
  try {
    if (app) await app.close();
  } catch {
    code = 1;
  } finally {
    clearTimeout(deadline);
    process.exit(code);
  }
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown(1));
process.once("disconnect", () => void shutdown(1));

try {
  if (!process.send || process.env.NODE_ENV !== "test")
    throw new Error("Fixture requires its isolated parent");
  const root = process.cwd();
  const dataDir = path.join(root, "data");
  const backupDir = path.join(root, "backups");
  const codexHome = path.join(root, "codex");
  const dshHome = path.join(root, "dsh");
  await Promise.all(
    [dataDir, backupDir, codexHome, dshHome].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  const { loadConfig } = await import("../../server/dist/config.js");
  const { buildApp } = await import("../../server/dist/app.js");
  const config = loadConfig(
    {
      NODE_ENV: "test",
      CK_DATA_DIR: dataDir,
      CK_BACKUP_DIR: backupDir,
      CK_CODEX_HOME: codexHome,
      CK_DSH_HOME: dshHome,
      CK_SESSION_SECRET: randomBytes(32).toString("hex"),
      CK_COOKIE_SECURE: "false",
      CK_HOST: "127.0.0.1",
      CK_ADAPTERS: "manual",
      CK_WORKSPACE_ROOTS: "",
      CK_SYNC_INTERVAL_MINUTES: "0",
      CK_SYNC_EXTRACTION_ADAPTER: "manual",
      CK_SYNC_ALLOW_UNASSIGNED_ARCHIVE: "false",
      CK_HOUSEKEEPING_INTERVAL_MINUTES: "0",
      CK_COST_CEILING_USD: "0",
      CK_SYNC_MAX_COST_USD: "0",
      CK_SEED_ON_START: "",
      CK_WEB_DIST: fileURLToPath(new URL("../dist/", import.meta.url)),
    },
    { port: 0 },
  );
  // Explicit config prevents loadConfig() from falling back to process.env.
  // No demo seed, telemetry initialization, external adapters, or scheduled work.
  app = await buildApp({ config, logger: false });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (
    !address ||
    typeof address === "string" ||
    address.address !== "127.0.0.1" ||
    address.port === 0
  ) {
    throw new Error("Unexpected fixture listener");
  }
  process.send({ type: "ready", origin: `http://127.0.0.1:${address.port}` });
} catch {
  if (process.connected) process.send({ type: "failed" });
  await shutdown(1);
}
