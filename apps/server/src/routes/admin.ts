import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DumpImportMode } from "../services/dump-import.js";
import { applyPortableDump, summarizePortableDump } from "../services/portable-dump.js";

const DumpImportBody = z.object({
  dump: z.unknown(),
  mode: z.enum(["merge", "reset"]).default("merge"),
});

/**
 * Portable dump seed route. Version 1 remains accepted for backward
 * compatibility; version 2 is the explicit portable_seed contract.
 */
export function registerAdminRoute(app: FastifyInstance): void {
  const { deps } = app.ck;

  app.post("/api/admin/import-dump", async (request, reply) => {
    const body = DumpImportBody.parse(request.body ?? {});
    const summary = summarizePortableDump(body.dump);
    if (!summary.ok) {
      reply.code(400);
      return {
        error: {
          code: summary.code,
          message: summary.message,
          details: null,
        },
      };
    }
    const counters = applyPortableDump(
      deps,
      { dump: body.dump, mode: body.mode as DumpImportMode, source: "http:api/admin/import-dump" },
      { actor: request.ckActor, requestId: request.id },
    );
    reply.code(200);
    return { ok: true, mode: body.mode, ...counters };
  });
}
