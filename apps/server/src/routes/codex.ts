import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CodexSessionImportInput, CodexSummaryImportInput } from "@contextkeep/shared";
import { parseWith } from "../lib/validate.js";
import {
  catalogCodexSessions,
  catalogCodexSummaries,
  importCodexSession,
  importCodexSummary,
} from "../services/codex.js";

const SessionCatalogQuery = z.object({
  state: z.enum(["all", "current", "archived"]).default("all"),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

const SummaryCatalogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** M3.2: owner-only, read-only catalog + explicit single-artifact Codex import. */
export function registerCodexRoutes(app: FastifyInstance): void {
  app.get("/api/connectors/codex/sessions", async (request) => {
    const query = parseWith(SessionCatalogQuery, request.query, "Codex session catalog query");
    return catalogCodexSessions(app.ck.deps.db, app.ck.config.codexHome, query);
  });

  app.post("/api/connectors/codex/sessions/import", async (request) => {
    const input = parseWith(CodexSessionImportInput, request.body, "Codex session import");
    return importCodexSession(app.ck.deps, app.ck.config.codexHome, input, {
      actor: request.ckActor,
      requestId: request.id,
    });
  });

  app.get("/api/connectors/codex/summaries", async (request) => {
    const query = parseWith(SummaryCatalogQuery, request.query, "Codex summary catalog query");
    return catalogCodexSummaries(app.ck.deps.db, app.ck.config.codexHome, query.limit);
  });

  app.post("/api/connectors/codex/summaries/import", async (request) => {
    const input = parseWith(CodexSummaryImportInput, request.body, "Codex summary import");
    return importCodexSummary(app.ck.deps, app.ck.config.codexHome, input, {
      actor: request.ckActor,
      requestId: request.id,
    });
  });
}
