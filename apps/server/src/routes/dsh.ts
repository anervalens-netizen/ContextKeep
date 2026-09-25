import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DshMemoryImportInput, DshSessionImportInput } from "@contextkeep/shared";
import { parseWith } from "../lib/validate.js";
import {
  catalogDshMemory,
  catalogDshSessions,
  importDshMemory,
  importDshSession,
} from "../services/dsh.js";

const SessionCatalogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

const MemoryCatalogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** M3.3: owner-only, read-only DSH catalog + explicit single-artifact import. */
export function registerDshRoutes(app: FastifyInstance): void {
  app.get("/api/connectors/dsh/sessions", async (request) => {
    const query = parseWith(SessionCatalogQuery, request.query, "DSH session catalog query");
    return catalogDshSessions(app.ck.deps.db, app.ck.config.dshHome, query.limit);
  });

  app.post("/api/connectors/dsh/sessions/import", async (request) => {
    const input = parseWith(DshSessionImportInput, request.body, "DSH session import");
    return importDshSession(app.ck.deps, app.ck.config.dshHome, input, {
      actor: request.ckActor,
      requestId: request.id,
    });
  });

  app.get("/api/connectors/dsh/memory", async (request) => {
    const query = parseWith(MemoryCatalogQuery, request.query, "DSH memory catalog query");
    return catalogDshMemory(app.ck.deps.db, app.ck.config.dshHome, query.limit);
  });

  app.post("/api/connectors/dsh/memory/import", async (request) => {
    const input = parseWith(DshMemoryImportInput, request.body, "DSH memory import");
    return importDshMemory(app.ck.deps, app.ck.config.dshHome, input, {
      actor: request.ckActor,
      requestId: request.id,
    });
  });
}
