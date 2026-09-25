import type { FastifyInstance } from "fastify";
import { APP_VERSION } from "../db/bootstrap.js";
import { SERVER_SCHEMA_VERSION } from "../db/schema-version.js";
import { registry as metricsRegistry } from "../lib/telemetry.js";
import { backupFreshnessStatus } from "../services/backup.js";
import { runtimeMetadata } from "../mcp/runtime-metadata.js";

export function registerSystemRoutes(app: FastifyInstance): void {
  const { deps, config } = app.ck;

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
