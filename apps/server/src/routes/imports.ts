import path from "node:path";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { ImportTextInput } from "@contextkeep/shared";
import { importJobs } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { parseWith } from "../lib/validate.js";
import { tracer, importsTotal, providerRefusedTotal } from "../lib/telemetry.js";
import { runDurablyClaimedImport } from "../services/initial-import-claim.js";

const ALLOWED_EXTENSIONS = new Set([".md", ".txt"]);

export function registerImportRoutes(app: FastifyInstance): void {
  const { deps } = app.ck;

  function actorCtx(request: { ckActor: string; id: string }) {
    return { actor: request.ckActor, requestId: request.id };
  }

  app.post("/api/imports/text", { bodyLimit: 10 * 1024 * 1024 }, async (request, reply) => {
    const input = parseWith(ImportTextInput, request.body, "import payload");
    let result;
    try {
      result = await tracer.startActiveSpan("import.text", async (span) => {
        try {
          return await runDurablyClaimedImport(deps, input, actorCtx(request));
        } finally {
          span.end();
        }
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === "adapter_disabled") {
        providerRefusedTotal.inc({ adapter: input.adapterId });
      }
      throw e;
    }
    importsTotal.inc({ stage: result.status === "created" ? "done" : result.status });
    reply.code(result.status === "created" ? 201 : 200);
    return result;
  });

  app.post("/api/imports/file", async (request, reply) => {
    if (!request.isMultipart()) {
      throw new ApiError(400, "multipart_required", "Upload must be multipart/form-data with a single file.");
    }
    // Iterate ALL parts so field order relative to the file part does not matter.
    let filePart: { filename: string; buffer: Buffer } | null = null;
    const fields: Record<string, string> = {};
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (filePart) throw new ApiError(400, "single_file_only", "Only one file per upload is supported.");
        const buffer = await part.toBuffer();
        filePart = { filename: part.filename ?? "", buffer };
      } else if (part.type === "field") {
        const value = part.value;
        fields[part.fieldname] = typeof value === "string" ? value : String(value);
      }
    }
    if (!filePart) throw new ApiError(400, "file_required", "No file part found.");
    const ext = path.extname(filePart.filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new ApiError(
        415,
        "unsupported_file_type",
        `Only .md and .txt files can be imported in M0 (got "${filePart.filename}"). PDF/DOCX/OCR ingestion is explicitly out of MVP scope.`,
      );
    }
    const text = filePart.buffer.toString("utf8");
    const field = (name: string): string | null => {
      const v = fields[name];
      return v === undefined || v === "" ? null : v;
    };

    const input = parseWith(
      ImportTextInput,
      {
        text,
        kind: "upload",
        title: field("title"),
        originalFilename: filePart.filename,
        projectId: field("projectId"),
        adapterId: field("adapterId") ?? "manual",
        eventAt: field("eventAt"),
        authorLabel: field("authorLabel"),
        confirmNearDuplicateOf: field("confirmNearDuplicateOf"),
      },
      "upload payload",
    );
    let result;
    try {
      result = await runDurablyClaimedImport(deps, input, actorCtx(request));
    } catch (e) {
      if (e instanceof ApiError && e.code === "adapter_disabled") {
        providerRefusedTotal.inc({ adapter: input.adapterId });
      }
      throw e;
    }
    importsTotal.inc({ stage: result.status === "created" ? "done" : result.status });
    reply.code(result.status === "created" ? 201 : 200);
    return result;
  });

  app.get("/api/imports/jobs/:id", async (request) => {
    const { id } = request.params as { id: string };
    const job = deps.db.select().from(importJobs).where(eq(importJobs.id, id)).get();
    if (!job) throw new ApiError(404, "job_not_found", `Import job ${id} not found.`);
    // usageJson shape (M2.4e):
    //   cost_ceiling_exceeded: { usage?: AdapterUsage, ceilingUsd, actualUsage?: AdapterUsage }
    //   done with usage:        { candidates, created, skippedDuplicates, preflightUsage?, ceilingUsd, actualUsage? }
    //   done without usage:     { candidates, created, skippedDuplicates, ceilingUsd, actualUsage? }
    //   estimate_required:      { reason } or { usage?, ceilingUsd, actualUsage? }
    //   duplicate / near_dup:   null
    // Both providerUsage (preflight estimate) and actualUsage (post-call billable)
    // are surfaced only when the JSON shape contains a real AdapterUsage (so the
    // DTO contract holds end-to-end). Fields that are missing in usageJson
    // surface as null, not undefined — the DTO contract is explicit.
    type UsagePayload = {
      inputTokens: number | null;
      outputTokens: number | null;
      estCostUsd: number;
      model: string | null;
    };
    let providerUsage: UsagePayload | null = null;
    let actualUsage: UsagePayload | null = null;
    if (job.usageJson !== null) {
      try {
        const parsed = JSON.parse(job.usageJson) as {
          // Legacy keys (M2.4a/b/c/d): `usage` for the preflight estimate.
          usage?: {
            inputTokens: number | null;
            outputTokens: number | null;
            estCostUsd: number;
            model: string | null;
          };
          // M2.4e key: `preflightUsage` for the preflight estimate.
          preflightUsage?: {
            inputTokens: number | null;
            outputTokens: number | null;
            estCostUsd: number;
            model: string | null;
          };
          // M2.4e: actual usage captured AFTER the provider call. Only present
          // when the adapter implements getActualUsage() (paid network adapters).
          actualUsage?: {
            inputTokens: number | null;
            outputTokens: number | null;
            estCostUsd: number;
            model: string | null;
          };
        };
        const isUsage = (u: unknown): u is {
          inputTokens: number | null;
          outputTokens: number | null;
          estCostUsd: number;
          model: string | null;
        } =>
          !!u &&
          typeof (u as { estCostUsd?: unknown }).estCostUsd === "number";
        // Preflight estimate: prefer M2.4e key, fall back to legacy key.
        if (isUsage(parsed.preflightUsage)) providerUsage = parsed.preflightUsage;
        else if (isUsage(parsed.usage)) providerUsage = parsed.usage;
        // Actual usage: only present in M2.4e runs.
        if (isUsage(parsed.actualUsage)) actualUsage = parsed.actualUsage;
      } catch {
        // usageJson malformed — surface null providerUsage and actualUsage
        // rather than 500.
      }
    }
    return {
      id: job.id,
      sourceId: job.sourceId,
      stage: job.stage,
      adapterId: job.adapterId,
      adapterVersion: job.adapterVersion,
      providerModel: job.providerModel,
      attempts: job.attempts,
      errorCode: job.errorCode,
      providerUsage,
      actualUsage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  });
}
