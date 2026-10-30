import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { registry } from "../lib/telemetry.js";

/** Dedicated scrape auth: no web session, MCP access, or credential in a URL. */
export function registerMetricsRoute(app: FastifyInstance): void {
  const token = app.ck.config.metricsToken;
  const expected = token
    ? crypto.createHash("sha256").update(`Bearer ${token}`).digest()
    : undefined;
  app.get("/metrics", {
    onRequest: async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!expected) return reply.code(404).send({ error: "Metrics scrape is not configured." });
      const actual = crypto.createHash("sha256").update(request.headers.authorization ?? "").digest();
      if (!crypto.timingSafeEqual(actual, expected)) {
        return reply.header("www-authenticate", 'Bearer realm="ContextKeep metrics"')
          .code(401).send({ error: "Metrics authentication required." });
      }
      if (request.headers.origin) return reply.code(403).send({ error: "Browser origins are not allowed." });
    },
  }, async (_request, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
}
