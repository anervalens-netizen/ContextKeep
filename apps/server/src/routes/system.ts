import type { FastifyInstance } from "fastify";
import { APP_VERSION } from "../db/bootstrap.js";
import { SERVER_SCHEMA_VERSION } from "../db/schema-version.js";
import { registry as metricsRegistry } from "../lib/telemetry.js";
import {
  assertVersionedSchemaShape,
  backupFreshnessStatus,
} from "../services/backup.js";
import { runtimeMetadata } from "../mcp/runtime-metadata.js";

export function registerSystemRoutes(app: FastifyInstance): void {
  const { deps, config } = app.ck;

  app.get("/api/health", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      const schema = deps.sqlite
        .prepare("SELECT MAX(version) AS version FROM schema_version")
        .get() as { version: number | null };
      if (schema.version !== SERVER_SCHEMA_VERSION)
        throw new Error("Database schema mismatch");
      // Bounded metadata checks shared with recovery validation, not an integrity
      // scan. Recheck on every request so a warm connection cannot hide drift.
      assertVersionedSchemaShape(deps.sqlite, schema.version);
      deps.sqlite.prepare("SELECT id FROM projects LIMIT 1").get();
      deps.sqlite.prepare("SELECT id FROM records LIMIT 1").get();
      return {
        status: "ready",
        database: "reachable",
        schemaVersion: schema.version,
      };
    } catch {
      return reply
        .code(503)
        .send({ status: "not_ready", database: "unavailable" });
    }
  });

  app.get("/api/meta", async () => ({
    appVersion: APP_VERSION,
    schemaVersion: SERVER_SCHEMA_VERSION,
    buildSha: config.buildSha,
    runtime: runtimeMetadata(config.buildSha),
    adapters: deps.registry.list(),
    env: config.env,
    dataDir: config.dataDir,
    backup: backupFreshnessStatus(config.backupDir),
  }));

  app.get("/api/metrics", async (_request, reply) => {
    reply.header("content-type", metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });
}
