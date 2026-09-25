import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { ProjectCreateInput, ProjectUpdateInput, McpWorkContextResult } from "@contextkeep/shared";
import { projects } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { parseWith } from "../lib/validate.js";
import { buildBriefPayload, buildTimeline } from "../services/brief.js";
import { toProjectDto } from "../services/mappers.js";
import { createProject, updateProject } from "../services/memory-management.js";
import { ContextKeepMemoryService } from "../services/memory-context.js";

export function registerProjectRoutes(app: FastifyInstance): void {
  const { deps } = app.ck;
  const memory = new ContextKeepMemoryService(deps);

  app.get("/api/projects", async () => {
    const rows = deps.db.select().from(projects).all();
    return rows.map(toProjectDto);
  });

  app.post("/api/projects", async (request) => {
    const input = parseWith(ProjectCreateInput, request.body, "project payload");
    return createProject(deps, input, { actor: request.ckActor, requestId: request.id });
  });

  app.get("/api/projects/:id", async (request) => {
    const { id } = request.params as { id: string };
    const row = deps.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) throw new ApiError(404, "project_not_found", `Project ${id} not found.`);
    return toProjectDto(row);
  });

  app.get("/api/projects/:id/freshness", async (request, reply) => {
    const { id } = request.params as { id: string };
    const rawAfter = (request.query as { after?: string }).after;
    let after: number | undefined;
    if (rawAfter !== undefined) {
      after = Number(rawAfter);
      if (!Number.isSafeInteger(after) || after < 0) {
        throw new ApiError(400, "invalid_freshness_cursor", "Freshness cursor must be a non-negative safe integer.");
      }
    }
    const row = deps.db
      .select({ id: projects.id, contentVersion: projects.contentVersion, workingMemoryVersion: projects.workingMemoryVersion })
      .from(projects)
      .where(eq(projects.id, id))
      .get();
    if (!row) throw new ApiError(404, "project_not_found", `Project ${id} not found.`);
    const rawWorkingAfter = (request.query as { workingAfter?: string }).workingAfter;
    let workingAfter: number | undefined;
    if (rawWorkingAfter !== undefined) {
      workingAfter = Number(rawWorkingAfter);
      if (!Number.isSafeInteger(workingAfter) || workingAfter < 0) {
        throw new ApiError(400, "invalid_working_freshness_cursor", "Working freshness cursor must be a non-negative safe integer.");
      }
    }
    const resetRequired = after !== undefined && after > row.contentVersion;
    const workingResetRequired = workingAfter !== undefined && workingAfter > row.workingMemoryVersion;
    reply.header("cache-control", "no-store");
    return {
      projectId: row.id,
      cursor: row.contentVersion,
      contentCursor: row.contentVersion,
      workingCursor: row.workingMemoryVersion,
      workingMemoryVersion: row.workingMemoryVersion,
      changed: after !== undefined && after !== row.contentVersion,
      delta: after === undefined || resetRequired ? 0 : row.contentVersion - after,
      resetRequired,
      workingChanged: workingAfter !== undefined && workingAfter !== row.workingMemoryVersion,
      workingDelta: workingAfter === undefined || workingResetRequired ? 0 : row.workingMemoryVersion - workingAfter,
      workingResetRequired,
    };
  });

  app.get("/api/projects/:id/work-context", async (request, reply) => {
    const { id } = request.params as { id: string };
    reply.header("cache-control", "no-store");
    return McpWorkContextResult.parse(memory.getWorkContext(
      { scope: "all", projectId: id },
      { projectId: id, limitPerSection: 5, totalContextBudgetChars: 20_000, diagnostics: false },
    ));
  });

  app.patch("/api/projects/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = parseWith(ProjectUpdateInput, request.body, "project update");
    return updateProject(
      deps,
      { projectId: id, ...input },
      { actor: request.ckActor, requestId: request.id },
    );
  });

  app.get("/api/projects/:id/brief", async (request, reply) => {
    const { id } = request.params as { id: string };
    // §10 hot path: pre-serialized cache with exact lazy invalidation.
    const payload = buildBriefPayload(deps, id);
    return reply.type("application/json; charset=utf-8").send(payload);
  });

  app.get("/api/projects/:id/timeline", async (request) => {
    const { id } = request.params as { id: string };
    return buildTimeline(deps, id);
  });
}
