import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { ZodError } from "zod";
import { ApiError } from "./lib/errors.js";
import { httpRequestsTotal } from "./lib/telemetry.js";
import { loadConfig, serverRoot, type AppConfig } from "./config.js";
import { openDatabase, type DbHandle } from "./db/client.js";
import { ensureContextCursorBaselines } from "./services/context-journal.js";
import { APP_VERSION, bootstrapDatabase } from "./db/bootstrap.js";
import { createAdapterRegistry } from "./adapters/registry.js";
import type { ServiceDeps } from "./services/import.js";
import { recoverInterruptedExtractions } from "./services/extraction-recovery.js";
import {
  finalizeClaim,
  isValidIdempotencyKey,
  recoverInterruptedIdempotencyClaims,
  pruneTerminalIdempotencyClaims,
  requestHash,
  tryClaim,
} from "./services/idempotency.js";
import { readSession, setAuthCookies, SESSION_COOKIE } from "./services/session.js";
import { registerPublicAuthRoutes, registerLogoutRoute } from "./routes/auth.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerImportRoutes } from "./routes/imports.js";
import { registerInboxRoutes } from "./routes/inbox.js";
import { registerCorrectionRoutes } from "./routes/corrections.js";
import { registerSearchExportRoutes } from "./routes/search-export.js";
import { registerSynthesisRoute } from "./routes/synthesis.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerAdminRoute } from "./routes/admin.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerCodexRoutes } from "./routes/codex.js";
import { registerDshRoutes } from "./routes/dsh.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { SyncCoordinator } from "./services/sync.js";
import { HousekeepingCoordinator } from "./services/housekeeping.js";

export interface CkContext {
  config: AppConfig;
  deps: ServiceDeps;
  handle: DbHandle;
  appVersion: string;
}

declare module "fastify" {
  interface FastifyInstance {
    ck: CkContext;
  }
  interface FastifyRequest {
    ckActor: string;
    ckSessionId: string;
    /**
     * F07: present on the request iff this caller just inserted a fresh
     * `pending` claim and is therefore responsible for finalizing it on the
     * way out (see the onSend hook). Replay requests do NOT set this — they
     * never had a fresh claim.
     */
    ckIdempotencyClaim?: { key: string };
  }
}

export interface BuildAppOptions {
  config?: AppConfig;
  /** Override the SQLite path (tests). Defaults to config.dbPath. */
  dbPath?: string;
  /** Run migrations at startup (default true). */
  bootstrap?: boolean;
  /** Fastify logger options; false disables (tests). */
  logger?: unknown;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * F07 routes whose responses cannot be replayed from a cached body. Generic
 * response caching is not valid for these because their response is either a
 * streaming NDJSON body or a multipart upload where `request.body` does not
 * represent the payload. A request carrying an Idempotency-Key to one of
 * these routes fails closed with `idempotency_not_supported` before any
 * claim is created.
 */
const F07_UNSUPPORTED_ROUTE_PATTERNS: ReadonlySet<string> = new Set<string>([
  "/api/imports/file",
]);

function isF07UnsupportedRoute(url: string | undefined): boolean {
  if (!url) return false;
  return F07_UNSUPPORTED_ROUTE_PATTERNS.has(url);
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = opts.config ?? loadConfig();
  const handle = openDatabase(opts.dbPath ?? config.dbPath, config.sqliteSynchronous);
  let cleanupApp: FastifyInstance | undefined;
  try {
  if (opts.bootstrap !== false) bootstrapDatabase(handle);
  ensureContextCursorBaselines(handle.db);
  const registry = createAdapterRegistry(config.adapters);
  const deps: ServiceDeps = {
    db: handle.db,
    sqlite: handle.sqlite,
    registry,
    costCeilingUsd: config.costCeilingUsd,
    volatileReviewIntervalDays: config.volatileReviewIntervalDays,
  };
  // No provider call can survive a process restart. Any persisted `pending`
  // extraction claim therefore belongs to the previous process and is safe to
  // fail/retry before routes or the sync timer become available.
  recoverInterruptedExtractions(deps);
  // F07: any `pending` idempotency claim from the previous process cannot
  // still be legitimately executing. Convert them to `indeterminate` so a
  // retry surfaces an explicit "unknown prior outcome" instead of silently
  // re-running a possibly-committed mutation. Runs BEFORE routes are wired.
  recoverInterruptedIdempotencyClaims(handle.sqlite);
  pruneTerminalIdempotencyClaims(handle.sqlite);
  const syncCoordinator = new SyncCoordinator(deps, config);
  const housekeepingCoordinator = new HousekeepingCoordinator(deps, config);

  const app = Fastify({
    logger: (opts.logger as never) ?? {
      level: config.env === "test" ? "error" : "info",
      redact: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-csrf-token"]'],
      serializers: {
        // A rejected credential-in-query must not become a credential-in-log.
        req: (req: { id?: string; method?: string; url?: string }) =>
          ({ id: req.id, method: req.method, url: req.url?.split("?")[0] }),
      },
    },
    genReqId: () => crypto.randomUUID(),
  });

  cleanupApp = app;
  app.decorate("ck", { config, deps, handle, appVersion: APP_VERSION });
  app.decorateRequest("ckActor", "");
  app.decorateRequest("ckSessionId", "");

  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: "1 minute" });
  await app.register(multipart, { limits: { fileSize: 4 * 1024 * 1024, files: 1 } });

  app.addHook("onResponse", async (request, reply) => {
    const route = (request.routeOptions?.url as string | undefined) ?? "unknown";
    httpRequestsTotal.inc({ method: request.method, route, status: String(reply.statusCode) });
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ApiError) {
      reply.code(error.status).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    const err = error as { statusCode?: number; code?: string; message?: string };
    if (err.statusCode === 429) {
      reply.code(429).send({
        error: { code: "rate_limited", message: "Too many requests; slow down.", details: null },
      });
      return;
    }
    if (err.statusCode === 413 || err.code === "FST_REQ_FILE_TOO_LARGE") {
      reply.code(413).send({
        error: { code: "file_too_large", message: "Upload exceeds the 4 MB M0 limit.", details: null },
      });
      return;
    }
    const sqliteCode = err.code ?? "";
    const msg = err.message ?? "";
    if (sqliteCode.startsWith("SQLITE_CONSTRAINT")) {
      if (msg.includes("supersession cycle")) {
        reply.code(409).send({
          error: {
            code: "supersession_cycle",
            message: "A18: supersession cycle rejected by the database.",
            details: null,
          },
        });
        return;
      }
      reply.code(409).send({
        error: { code: "constraint_violation", message: `Database constraint: ${sqliteCode}`, details: msg },
      });
      return;
    }
    request.log.error({ err: error }, "unhandled error");
    reply.code(500).send({
      error: { code: "internal_error", message: "Internal server error.", details: null },
    });
  });

  registerPublicAuthRoutes(app);
  registerMcpRoutes(app);

  app.register(async (inst) => {
    // CK-A04: authenticated API reads carry a marker that can only be added by
    // the live ContextKeep server. The new PWA does not cache API responses,
    // so a legacy service-worker 200 lacks this marker and cannot masquerade
    // as freshly revalidated data.
    inst.addHook("onSend", async (request, reply, payload) => {
      if ((request.method === "GET" || request.method === "HEAD") && request.url.startsWith("/api/")) {
        reply.header("x-contextkeep-data-source", "network-v1");
        reply.header("x-contextkeep-fetched-at", new Date().toISOString());
        const requestId = request.headers["x-contextkeep-request-id"];
        if (typeof requestId === "string" && requestId.length > 0 && requestId.length <= 200) {
          reply.header("x-contextkeep-response-id", requestId);
        }
        reply.header("cache-control", "no-store");
      }
      return payload;
    });

    inst.addHook("onRequest", async (request, reply) => {
      const session = readSession(deps.db, request.cookies[SESSION_COOKIE], (renewed) => setAuthCookies(reply, config, renewed));
      if (!session) {
        reply.code(401).send({
          error: { code: "unauthorized", message: "Sign in as the owner to use ContextKeep.", details: null },
        });
        return reply;
      }
      request.ckActor = "owner";
      request.ckSessionId = session.id;
      if (MUTATING_METHODS.has(request.method)) {
        const header = request.headers["x-csrf-token"];
        if (typeof header !== "string" || header !== session.csrfToken) {
          reply.code(403).send({
            error: {
              code: "csrf_mismatch",
              message: "CSRF token missing or mismatched. Reload the app and retry.",
              details: null,
            },
          });
          return reply;
        }
      }
      return undefined;
    });

    // F07: durable mutation idempotency. Runs ONLY for authenticated mutations
    // (auth + CSRF already validated in the onRequest hook above, and rate-
    // limiting already accepted the request by this stage). Outcomes:
    //   - header absent           -> legacy behavior (no claim, handler runs)
    //   - header invalid          -> 400 idempotency_key_invalid (FAIL CLOSED;
    //                               we do NOT silently treat a malformed key as
    //                               absent because that would re-open the
    //                               duplicate-execution window that F07 closes)
    //   - header valid on unsupported route -> 400 idempotency_not_supported
    //                               (streaming NDJSON and multipart upload
    //                               cannot be replayed from a cached response)
    //   - header valid            -> enter the claim state machine
    inst.addHook("preHandler", async (request, reply) => {
      if (!MUTATING_METHODS.has(request.method)) return;
      const header = request.headers["idempotency-key"];
      if (header === undefined) return; // legacy path
      if (!isValidIdempotencyKey(header)) {
        // Multi-value headers arrive as arrays; isValidIdempotencyKey rejects
        // anything that is not a single canonical string. Fail closed: refuse
        // the mutation so a corrupted/truncated/replayed key cannot slip into
        // the un-claimed (legacy) path.
        throw new ApiError(
          400,
          "idempotency_key_invalid",
          "Idempotency-Key header is malformed. Use 8–200 chars of [A-Za-z0-9._-:].",
        );
      }
      if (isF07UnsupportedRoute(request.routeOptions.url)) {
        // Streaming NDJSON and multipart upload responses cannot be cached
        // for replay; reject the key explicitly so the client knows this
        // route is excluded from F07 instead of silently dropping the key.
        throw new ApiError(
          400,
          "idempotency_not_supported",
          "Idempotency-Key is not supported for this route. Streaming and multipart routes are excluded from F07 durable replay.",
          { route: request.routeOptions.url },
        );
      }
      const body = (request.body ?? undefined) as unknown;
      const hash = requestHash(request.method, request.url, body);
      const outcome = tryClaim(handle.sqlite, {
        key: header,
        method: request.method,
        url: request.url,
        requestHash: hash,
      });
      if (outcome.fresh) {
        request.ckIdempotencyClaim = { key: header };
        return;
      }
      const existing = outcome.claim;
      // Replay path: same key, same request, server has a completed answer.
      if (existing.state === "completed" && existing.requestHash === hash) {
        reply.header("x-idempotent-replay", "true");
        if (existing.responseContentType) reply.header("content-type", existing.responseContentType);
        const status = existing.responseStatus ?? 200;
        const bodyText = existing.responseBody ?? "{}";
        reply.code(status).send(bodyText);
        return reply;
      }
      // Same key, different request → the caller is reusing the key with a
      // semantically different mutation. Reject unconditionally; never run
      // either side of the duplicate.
      if (existing.requestHash !== hash) {
        throw new ApiError(
          409,
          "idempotency_key_reused",
          "Idempotency-Key was reused for a different request. Generate a new key per logical mutation.",
        );
      }
      // Same key, same request, still pending → another caller is mid-flight
      // (or was interrupted last process; recovery will turn it indeterminate
      // on next startup). Treat as retryable; do NOT execute the handler.
      if (existing.state === "pending") {
        reply.header("retry-after", "1");
        throw new ApiError(
          409,
          "idempotency_in_progress",
          "An earlier identical request is still being processed. Retry shortly.",
        );
      }
      // Same key, same request, outcome unknown (handler previously crashed
      // between commit and finalize). Fail closed: refuse to blindly re-run.
      throw new ApiError(
        409,
        "idempotency_outcome_unknown",
        "The previous identical request may have already been applied; its outcome could not be confirmed after a process restart. Resolve manually before retrying.",
      );
    });

    // F07: finalize the claim right before the bytes leave the server. The
    // ordering is critical:
    //   business effect -> idempotency completion persisted -> HTTP emit.
    // For 5xx we cannot prove whether the handler committed, so we mark the
    // claim `indeterminate` instead of releasing it for blind retry.
    inst.addHook("onSend", async (request, reply, payload) => {
      if (!request.ckIdempotencyClaim) return payload;
      const key = request.ckIdempotencyClaim.key;
      const status = reply.statusCode;
      const bodyText =
        typeof payload === "string"
          ? payload
          : payload === null || payload === undefined
            ? ""
            : Buffer.isBuffer(payload)
              ? payload.toString("utf8")
              : JSON.stringify(payload);
      const contentType = String(reply.getHeader("content-type") ?? "application/json; charset=utf-8");
      if (status >= 500) {
        finalizeClaim(handle.sqlite, {
          key,
          state: "indeterminate",
          responseStatus: status,
          responseBody: "",
          responseContentType: "",
        });
      } else {
        finalizeClaim(handle.sqlite, {
          key,
          state: "completed",
          responseStatus: status,
          responseBody: bodyText,
          responseContentType: contentType,
        });
      }
      return payload;
    });

    registerLogoutRoute(inst);
    registerProjectRoutes(inst);
    registerWorkspaceRoutes(inst);
    registerCodexRoutes(inst);
    registerDshRoutes(inst);
    registerSyncRoutes(inst, syncCoordinator);
    registerImportRoutes(inst);
    registerInboxRoutes(inst);
    registerCorrectionRoutes(inst);
    registerSearchExportRoutes(inst);
    registerSystemRoutes(inst);
    registerAdminRoute(inst);
    registerSynthesisRoute(inst);
  });

  const webDist = config.webDist ?? path.resolve(serverRoot, "../web/dist");
  const hasWebDist = fs.existsSync(path.join(webDist, "index.html"));
  if (hasWebDist) {
    await app.register(fastifyStatic, { root: webDist, wildcard: true });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api") &&
          !request.url.startsWith("/mcp") && !request.url.startsWith("/.well-known/")) {
        reply.type("text/html").send(fs.readFileSync(path.join(webDist, "index.html")));
        return;
      }
      reply.code(404).send({
        error: { code: "not_found", message: `Route ${request.url} not found.`, details: null },
      });
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      reply.code(404).send({
        error: { code: "not_found", message: `Route ${request.url} not found.`, details: null },
      });
    });
  }

  app.addHook("preClose", async () => {
    // Stop scheduling and signal active provider work before Fastify waits on
    // shutdown. onClose remains the database ownership boundary.
    housekeepingCoordinator.stop();
    syncCoordinator.beginShutdown();
  });

  app.addHook("onClose", async () => {
    await syncCoordinator.stopAndDrain();
    handle.sqlite.close();
  });

  syncCoordinator.start();
  housekeepingCoordinator.start();
  return app;
  } catch (error) {
    // Bootstrap/plugin failure must not leave a database or directory lease open.
    try {
      await cleanupApp?.close();
    } finally {
      if (handle.sqlite.open) handle.sqlite.close();
    }
    throw error;
  }
}

export type { ZodError };