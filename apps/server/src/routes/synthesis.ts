import type { FastifyInstance } from "fastify";
import { SynthesisInput } from "@contextkeep/shared";
import { ApiError } from "../lib/errors.js";
import { parseWith } from "../lib/validate.js";
import { synthesize } from "../services/synthesis.js";

/**
 * Bounded synthesis endpoint (handoff §12 item 14). Owner-gated by the same
 * auth preHandler that protects every other /api/* route (registered inside
 * the auth-gated sub-app in app.ts). Read-only; does not consult providers.
 */
export function registerSynthesisRoute(app: FastifyInstance): void {
  const { deps } = app.ck;

  app.post("/api/synthesis", async (request) => {
    const input = parseWith(SynthesisInput, request.body, "synthesis payload");
    if (input.question.trim().length === 0) {
      throw new ApiError(400, "empty_question", "Question must contain at least one non-whitespace character.");
    }
    return synthesize(deps, input);
  });
}
