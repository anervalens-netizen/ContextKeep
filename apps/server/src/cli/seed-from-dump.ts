#!/usr/bin/env -S node --import tsx/esm
/**
 * Apply a portable JSON dump produced by `/api/export/json` to the current
 * SQLite store. Version 1 remains accepted; version 2 is the honest
 * portable_seed contract. Exact disaster recovery uses SQLite backup/restore.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/client.js";
import { checkSchemaVersion } from "../db/bootstrap.js";
import { createAdapterRegistry } from "../adapters/registry.js";
import type { DumpImportMode } from "../services/dump-import.js";
import { applyPortableDump, summarizePortableDump } from "../services/portable-dump.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dumpPath = args.find((a) => !a.startsWith("--"));
  const modeArg = args.find((a) => a.startsWith("--mode="));
  const dryRun = args.includes("--dry-run");
  if (!dumpPath) {
    throw new Error(
      "Usage: pnpm db:seed-from-dump <path-to-dump.json> [--mode=merge|reset] [--dry-run]",
    );
  }
  const mode: DumpImportMode =
    modeArg === "--mode=reset" ? "reset" : modeArg === "--mode=merge" ? "merge" : "merge";

  const dumpJson = readFileSync(path.resolve(dumpPath), "utf8");
  const dump = JSON.parse(dumpJson) as unknown;

  const summary = summarizePortableDump(dump);
  if (!summary.ok) {
    throw new Error(`dump rejected (${summary.code}): ${summary.message}`);
  }

  const config = loadConfig({ ...(process.env as Record<string, string | undefined>), NODE_ENV: "production" }, {});
  const handle = openDatabase(config.dbPath, config.sqliteSynchronous);
  checkSchemaVersion(handle);
  const registry = createAdapterRegistry(config.adapters ?? ["manual", "faketest"]);

  if (dryRun) {
    handle.sqlite.close();
    // eslint-disable-next-line no-console
    console.log(`dry-run: dump OK, sha256=${summary.sha256}, mode=${mode} (no changes written)`);
    return;
  }

  const counters = applyPortableDump(
    {
      db: handle.db,
      sqlite: handle.sqlite,
      registry,
      costCeilingUsd: config.costCeilingUsd,
      volatileReviewIntervalDays: config.volatileReviewIntervalDays,
    },
    { dump, mode, source: `cli:seed-from-dump:${path.basename(dumpPath)}` },
    { actor: "cli:seed-from-dump", requestId: null },
  );
  handle.sqlite.close();

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ mode, ...counters }, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`seed-from-dump failed: ${(err as Error).message}`);
  process.exit(1);
});
