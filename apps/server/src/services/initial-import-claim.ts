import type { ImportPreviewDto, ImportTextInput } from "@contextkeep/shared";
import { eq } from "drizzle-orm";
import { importJobs } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { sha256 } from "../lib/hash.js";
import { nowIso } from "../lib/time.js";
import type { ActorCtx, ServiceDeps } from "./import.js";
import { runImport } from "./import.js";
import { normalizeText } from "./normalize.js";

/**
 * F08: internal durable claim marker stored in import_jobs. The row is
 * operational ownership, not the user-facing import result job returned by
 * runImport(). Reusing the existing table avoids a schema/migration solely
 * for a one-owner concurrency claim.
 */
export const INITIAL_IMPORT_CLAIM_MARKER = JSON.stringify({ kind: "initial_import_claim" });

type ClaimResult =
  | { kind: "claimed"; jobId: string }
  | { kind: "busy"; jobId: string }
  | { kind: "completed"; jobId: string };

/**
 * Stable UUID-shaped primary key derived from the normalized source content.
 * Source dedupe is global by content/normalized hash, so the same normalized
 * source must serialize through one initial provider claim regardless of
 * browser request, project metadata or adapter choice.
 */
export function initialImportClaimId(normalizedHash: string): string {
  const hex = sha256(`contextkeep:initial-import:${normalizedHash}`).slice(0, 32).split("");
  // RFC 4122 layout: mark as deterministic v5-style + RFC variant. This is
  // only an internal stable identifier; no UUID library/dependency is needed.
  hex[12] = "5";
  const variant = (Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8;
  hex[16] = variant.toString(16);
  const compact = hex.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20, 32)}`;
}

function claimInitialImport(
  deps: ServiceDeps,
  normalizedHash: string,
  adapterId: string,
  adapterVersion: string,
): ClaimResult {
  const jobId = initialImportClaimId(normalizedHash);
  const stamp = nowIso();
  const inserted = deps.sqlite
    .prepare(`
      INSERT INTO import_jobs(
        id,source_id,stage,adapter_id,adapter_version,provider_model,attempts,
        error_code,usage_json,created_at,updated_at
      ) VALUES(?,NULL,'chunked',?,?,NULL,1,NULL,?,?,?)
      ON CONFLICT(id) DO NOTHING
    `)
    .run(jobId, adapterId, adapterVersion, INITIAL_IMPORT_CLAIM_MARKER, stamp, stamp);
  if (inserted.changes === 1) return { kind: "claimed", jobId };

  const current = deps.sqlite
    .prepare("SELECT stage,source_id FROM import_jobs WHERE id=?")
    .get(jobId) as { stage: string; source_id: string | null } | undefined;
  if (!current) return { kind: "busy", jobId };
  if (current.stage === "chunked") return { kind: "busy", jobId };
  if (current.stage === "done" || current.stage === "duplicate_skipped") {
    // source_id is SET NULL if the completed source is later removed. In that
    // case the terminal claim must become claimable again; otherwise callers
    // bypass the durable gate and can race duplicate provider work.
    const sourceStillExists = current.source_id !== null && Boolean(
      deps.sqlite.prepare("SELECT 1 FROM sources WHERE id=?").get(current.source_id),
    );
    if (sourceStillExists) return { kind: "completed", jobId };
    const reclaimedTerminal = deps.sqlite
      .prepare(`
        UPDATE import_jobs
        SET source_id=NULL,stage='chunked',adapter_id=?,adapter_version=?,provider_model=NULL,
            attempts=attempts+1,error_code=NULL,usage_json=?,updated_at=?
        WHERE id=? AND stage IN ('done','duplicate_skipped')
          AND (source_id IS NULL OR NOT EXISTS (SELECT 1 FROM sources WHERE id=import_jobs.source_id))
      `)
      .run(adapterId, adapterVersion, INITIAL_IMPORT_CLAIM_MARKER, stamp, jobId);
    return reclaimedTerminal.changes === 1 ? { kind: "claimed", jobId } : { kind: "busy", jobId };
  }

  // Failed work and near-duplicate previews are explicitly retryable. Reclaim
  // the SAME durable row before any new provider/preflight await.
  const reclaimed = deps.sqlite
    .prepare(`
      UPDATE import_jobs
      SET source_id=NULL,stage='chunked',adapter_id=?,adapter_version=?,provider_model=NULL,
          attempts=attempts+1,error_code=NULL,usage_json=?,updated_at=?
      WHERE id=? AND stage<>'chunked' AND stage<>'done' AND stage<>'duplicate_skipped'
    `)
    .run(adapterId, adapterVersion, INITIAL_IMPORT_CLAIM_MARKER, stamp, jobId);
  return reclaimed.changes === 1 ? { kind: "claimed", jobId } : { kind: "busy", jobId };
}

function finishClaim(
  deps: ServiceDeps,
  jobId: string,
  result: ImportPreviewDto,
): void {
  const stage = result.status === "created" ? "done" : result.status;
  const sourceId = result.source?.id ?? result.duplicateOf?.sourceId ?? null;
  deps.db
    .update(importJobs)
    .set({
      sourceId,
      stage,
      errorCode: null,
      usageJson: INITIAL_IMPORT_CLAIM_MARKER,
      updatedAt: nowIso(),
    })
    .where(eq(importJobs.id, jobId))
    .run();
}

function failClaim(deps: ServiceDeps, jobId: string, error: unknown): void {
  deps.db
    .update(importJobs)
    .set({
      stage: "failed",
      errorCode: error instanceof ApiError ? error.code : "initial_import_failed",
      usageJson: INITIAL_IMPORT_CLAIM_MARKER,
      updatedAt: nowIso(),
    })
    .where(eq(importJobs.id, jobId))
    .run();
}

/**
 * F08 initial import/provider gate.
 *
 * A durable import_jobs claim is committed BEFORE runImport() can reach
 * estimateUsage()/extract(). Exactly one process request may own a normalized
 * source at a time. A completed source falls back to runImport's existing
 * exact-duplicate path; failed/near-duplicate work may be reclaimed.
 */
export async function runDurablyClaimedImport(
  deps: ServiceDeps,
  input: ImportTextInput,
  ctx: ActorCtx,
): Promise<ImportPreviewDto> {
  const normalized = normalizeText(input.text);
  if (!normalized) return runImport(deps, input, ctx); // preserve canonical 400 path

  // Disabled/unknown adapters cannot perform provider work; preserve the
  // existing runImport audit/error path instead of creating an internal claim.
  let adapterVersion: string;
  try {
    adapterVersion = deps.registry.get(input.adapterId).version;
  } catch {
    return runImport(deps, input, ctx);
  }

  const normalizedHash = sha256(normalized);
  const claim = claimInitialImport(deps, normalizedHash, input.adapterId, adapterVersion);
  if (claim.kind === "busy") {
    throw new ApiError(
      409,
      "import_in_progress",
      "An identical source import is already being processed. Wait for that attempt to finish before retrying.",
      { claimJobId: claim.jobId },
    );
  }
  // If the durable claim already completed, source dedupe is the authority and
  // runImport returns duplicate_skipped without reaching the provider.
  if (claim.kind === "completed") return runImport(deps, input, ctx);

  try {
    const result = await runImport(deps, input, ctx);
    finishClaim(deps, claim.jobId, result);
    return result;
  } catch (error) {
    failClaim(deps, claim.jobId, error);
    throw error;
  }
}

/**
 * Process restart recovery for F08. `chunked` + marker is reserved for the
 * internal initial-import claim; runImport itself only persists terminal job
 * rows. Provider calls cannot survive process death, so the next process may
 * safely mark these claims failed and allow an atomic reclaim on retry.
 */
export function recoverInterruptedInitialImportClaims(deps: ServiceDeps): number {
  const recover = deps.sqlite.transaction(() => {
    const stamp = nowIso();
    const result = deps.sqlite
      .prepare(`
        UPDATE import_jobs
        SET stage='failed',error_code='interrupted_restart',updated_at=?
        WHERE stage='chunked' AND source_id IS NULL AND usage_json=?
      `)
      .run(stamp, INITIAL_IMPORT_CLAIM_MARKER);
    return result.changes;
  });
  return recover.immediate();
}
