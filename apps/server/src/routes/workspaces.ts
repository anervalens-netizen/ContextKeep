import type { FastifyInstance } from "fastify";
import { WorkspaceActionInput } from "@contextkeep/shared";
import { parseWith } from "../lib/validate.js";
import { buildWorkspaceReconciliation } from "../services/reconciliation.js";
import {
  applyWorkspaceAction,
  listWorkspaces,
  scanAndUpsertWorkspaces,
} from "../services/workspaces.js";

/** M3.1/M3.5 owner-only observed-workspace registry + reconciliation metadata. */
export function registerWorkspaceRoutes(app: FastifyInstance): void {
  app.get("/api/workspaces", async () => listWorkspaces(app.ck.deps.db));

  app.get("/api/workspaces/reconciliation", async () =>
    buildWorkspaceReconciliation(app.ck.deps.db, app.ck.config),
  );

  app.post("/api/workspaces/scan", async (request, reply) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const onClose = () => {
      if (!reply.raw.writableFinished) abort();
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", onClose);
    try {
      return await scanAndUpsertWorkspaces(
        app.ck.deps.db,
        {
          roots: app.ck.config.workspaceRoots,
          maxDepth: app.ck.config.workspaceScanMaxDepth,
          signal: controller.signal,
        },
        { actor: request.ckActor, requestId: request.id },
      );
    } finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", onClose);
    }
  });

  app.post("/api/workspaces/:id/action", async (request) => {
    const { id } = request.params as { id: string };
    const input = parseWith(
      WorkspaceActionInput,
      request.body,
      "workspace action",
    );
    return applyWorkspaceAction(app.ck.deps.db, id, input, {
      actor: request.ckActor,
      requestId: request.id,
    });
  });
}
