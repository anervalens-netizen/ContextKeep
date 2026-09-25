import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ExistingSourceExtractInput, SyncJobActionInput, SyncRunInput } from "@contextkeep/shared";
import { parseWith } from "../lib/validate.js";
import { extractExistingSource } from "../services/extraction.js";
import type { SyncCoordinator } from "../services/sync.js";

const SourceParams = z.object({ id: z.string().min(1).max(128) });
const SyncJobParams = z.object({ id: z.string().min(1).max(128) });

/** M3.4/L4: owner-only dry-run/execution sync control and explicit source extraction. */
export function registerSyncRoutes(app: FastifyInstance, coordinator: SyncCoordinator): void {
  app.get("/api/sync/status", async () => coordinator.status());

  app.post("/api/sync/run", async (request) => {
    const input = parseWith(SyncRunInput, request.body ?? {}, "sync run");
    return coordinator.run(input, { actor: request.ckActor, requestId: request.id });
  });

  app.post("/api/sync/jobs/:id/action", async (request) => {
    const params = parseWith(SyncJobParams, request.params, "sync job params");
    const input = parseWith(SyncJobActionInput, request.body ?? {}, "sync job action");
    if (input.action === "cancel") return coordinator.cancel(params.id, { actor: request.ckActor, requestId: request.id });
    return coordinator.rerun(params.id, input.action, { actor: request.ckActor, requestId: request.id });
  });

  app.post("/api/sources/:id/extract", async (request) => {
    const params = parseWith(SourceParams, request.params, "source extraction params");
    const input = parseWith(ExistingSourceExtractInput, request.body ?? {}, "source extraction");
    return extractExistingSource(app.ck.deps, { sourceId: params.id, adapterId: input.adapterId }, {
      actor: request.ckActor,
      requestId: request.id,
    });
  });
}
