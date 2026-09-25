import type { FastifyInstance } from "fastify";
import { CorrectionInput } from "@contextkeep/shared";
import { ApiError } from "../lib/errors.js";
import { parseWith } from "../lib/validate.js";
import { writeAudit } from "../services/audit.js";
import { confirmCorrection, getCorrectionState, proposeCorrection } from "../services/corrections.js";

export function registerCorrectionRoutes(app: FastifyInstance): void {
  const { deps } = app.ck;

  app.post("/api/corrections", async (request, reply) => {
    const input = parseWith(CorrectionInput, request.body, "correction payload");
    const preview = proposeCorrection(deps, input, { actor: request.ckActor, requestId: request.id });
    reply.code(201);
    return preview;
  });

  app.get("/api/corrections/:jobId", async (request) => {
    const { jobId } = request.params as { jobId: string };
    return getCorrectionState(deps, jobId);
  });

  app.post("/api/corrections/:jobId/confirm", async (request) => {
    const { jobId } = request.params as { jobId: string };
    try {
      return confirmCorrection(deps, jobId, { actor: request.ckActor, requestId: request.id });
    } catch (e) {
      if (e instanceof ApiError && e.code === "precedence_violation") {
        // Audited AFTER the rollback so the refusal survives in the log (A4/A15).
        writeAudit(deps.db, {
          actor: request.ckActor,
          action: "supersession.precedence_refused",
          targetType: "import_job",
          targetId: jobId,
          before: null,
          after: null,
          detail: { refused: "precedence_violation", ...(e.details as object) },
          requestId: request.id,
        });
      }
      throw e;
    }
  });
}
