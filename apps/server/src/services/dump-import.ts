import { eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "../db/client.js";
import {
  projects,
  sources,
  sourceExcerpts,
  records,
  recordEvidence,
  supersessions,
} from "../db/schema.js";
import { recordDedupHash as computeRecordDedupHash, sha256 } from "../lib/hash.js";
import { ApiError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import { writeAudit } from "./audit.js";
import { bumpProjectContentVersion, bumpProjectWorkingMemoryVersion } from "./content-version.js";
import type { ActorCtx, ServiceDeps } from "./import.js";

/**
 * M1 dump seeding flow (handoff §12 item 11): apply a JSON dump produced
 * by `/api/export/json` to the current store.
 *
 * Two modes:
 *   - merge  (default) — idempotent. Skips rows whose primary key or
 *                       content hash already exists. The §3 inventory
 *                       policy is enforced: a retired project's
 *                       lifecycle is never changed by an import; facts
 *                       about retired projects are only accepted when
 *                       ownerAction is set (A19), which a dump import
 *                       never sets.
 *   - reset            — transactional: wipe store, re-apply every
 *                       table from the dump. Used for "second-machine
 *                       seed" where the owner wants an exact clone.
 *
 * The CLI and the admin HTTP route share this service. The CLI is the
 * durable, auditable path (the binary in the repo, versioned); the HTTP
 * endpoint exists for owner convenience and writes the same
 * `import_dump.applied` audit event.
 */
export type DumpImportMode = "merge" | "reset";

export interface DumpImportCounters {
  /** Rows actually inserted (new in merge mode, every row in reset mode). */
  accepted: number;
  /** Rows that already existed with matching id/hash and were left untouched. */
  skipped: number;
  /** Rows the §3 inventory policy refused to apply (A3 retired reactivation). */
  retiredGuards: number;
  /** Rows that failed to parse / failed an invariant — see `errors`. */
  blocked: number;
  /** SHA-256 of the dump payload that was applied (for the audit log). */
  dumpSha256: string;
  errors: Array<{ kind: string; id?: string; reason: string }>;
}

interface RawDump {
  format: unknown;
  version: unknown;
  exportedAt?: unknown;
  projects: unknown[];
  sources: unknown[];
  sourceExcerpts: unknown[];
  records: unknown[];
  recordEvidence: unknown[];
  supersessions: unknown[];
}

export interface DumpImportInput {
  dump: unknown;
  mode: DumpImportMode;
  /** Where the import came from — recorded in the audit event. */
  source: string;
}

export class DumpImportError extends ApiError {
  constructor(code: string, message: string, detail?: unknown) {
    super(400, code, message, detail ?? null);
    this.name = "DumpImportError";
  }
}

/** Entry point: validate + apply. */
export function applyDump(deps: ServiceDeps, input: DumpImportInput, ctx: ActorCtx): DumpImportCounters {
  const parsed = parseDump(input.dump);
  const dumpJson = JSON.stringify(input.dump);
  const dumpSha256 = createHash("sha256").update(dumpJson).digest("hex");
  const counters: DumpImportCounters = {
    accepted: 0,
    skipped: 0,
    retiredGuards: 0,
    blocked: 0,
    dumpSha256,
    errors: [],
  };
  const importedRecordIds = new Set<string>();
  const sourceIdRemap = new Map<string, string>();
  const excerptIdRemap = new Map<string, string>();
  const recordIdRemap = new Map<string, string>();
  const changedCanonicalProjectIds = new Set<string>();
  const workingMemoryProjectIds = new Set<string>();
  const insertedProjectIds = new Set<string>();

  // reset mode runs inside a single transaction so a partial failure leaves
  // the store untouched. merge mode also wraps in a transaction so accepted /
  // skipped counters are consistent with what landed on disk.
  deps.sqlite.transaction(() => {
    // Defer FK checks until COMMIT so circular references
    // (projects.lifecycle_record_id ↔ records.project_id) resolve together.
    deps.sqlite.pragma("defer_foreign_keys = ON");

    if (input.mode === "reset") {
      // Order matters for FKs: children before parents.
      deps.db.delete(recordEvidence).run();
      deps.db.delete(supersessions).run();
      deps.db.delete(records).run();
      deps.db.delete(sourceExcerpts).run();
      deps.db.delete(sources).run();
      deps.db.delete(projects).run();
    }

    // Projects first (records reference them by id). Sort by parent_project_id
    // so a child is never inserted before its parent — otherwise the
    // self-referential FK fires and the reset-mode replay dies mid-way.
    const orderedProjects = topologicallyOrderProjects(parsed.projects);
    for (const raw of orderedProjects) {
      const result = importProject(deps, raw, input.mode);
      counters.accepted += result.accepted;
      counters.skipped += result.skipped;
      counters.retiredGuards += result.retiredGuards;
      counters.blocked += result.blocked;
      result.error && counters.errors.push(result.error);
      if (result.insertedProjectId) insertedProjectIds.add(result.insertedProjectId);
    }
    for (const raw of parsed.sources) {
      const incomingId = isObject(raw) ? stringOrNull(raw["id"]) : null;
      const result = importSource(deps, raw, input.mode);
      counters.accepted += result.accepted;
      counters.skipped += result.skipped;
      counters.blocked += result.blocked;
      result.error && counters.errors.push(result.error);
      if (incomingId && result.canonicalId) sourceIdRemap.set(incomingId, result.canonicalId);
    }
    for (const raw of parsed.sourceExcerpts) {
      const incomingId = isObject(raw) ? stringOrNull(raw["id"]) : null;
      const normalized = isObject(raw) && typeof raw["sourceId"] === "string"
        ? { ...raw, sourceId: sourceIdRemap.get(raw["sourceId"]) ?? raw["sourceId"] }
        : raw;
      const result = importSourceExcerpt(deps, normalized, input.mode);
      counters.accepted += result.accepted;
      counters.skipped += result.skipped;
      counters.blocked += result.blocked;
      result.error && counters.errors.push(result.error);
      if (incomingId && result.canonicalId) excerptIdRemap.set(incomingId, result.canonicalId);
    }
    for (const raw of parsed.records) {
      const incomingId = isObject(raw) ? stringOrNull(raw["id"]) : null;
      const result = importRecord(deps, raw, input.mode);
      counters.accepted += result.accepted;
      counters.skipped += result.skipped;
      counters.retiredGuards += result.retiredGuards;
      counters.blocked += result.blocked;
      result.error && counters.errors.push(result.error);
      if (incomingId && result.canonicalId) recordIdRemap.set(incomingId, result.canonicalId);
      if (result.accepted > 0 && result.canonicalId) importedRecordIds.add(result.canonicalId);
      if (input.mode === "merge" && result.canonicalProjectId) changedCanonicalProjectIds.add(result.canonicalProjectId);
      if (result.workingMemoryProjectId && input.mode === "merge" && !insertedProjectIds.has(result.workingMemoryProjectId)) {
        workingMemoryProjectIds.add(result.workingMemoryProjectId);
      }
    }
    for (const raw of parsed.recordEvidence) {
      const normalized = isObject(raw)
        ? {
            ...raw,
            recordId: typeof raw["recordId"] === "string"
              ? (recordIdRemap.get(raw["recordId"]) ?? raw["recordId"])
              : raw["recordId"],
            excerptId: typeof raw["excerptId"] === "string"
              ? (excerptIdRemap.get(raw["excerptId"]) ?? raw["excerptId"])
              : raw["excerptId"],
          }
        : raw;
      const result = importRecordEvidence(deps, normalized, input.mode);
      counters.accepted += result.accepted;
      counters.skipped += result.skipped;
      counters.blocked += result.blocked;
      result.error && counters.errors.push(result.error);
      if (input.mode === "merge" && result.canonicalProjectId) changedCanonicalProjectIds.add(result.canonicalProjectId);
    }

    // Canonical accepted memory is evidence-backed. A portable/legacy dump may
    // contain proposed rows without evidence, but a newly imported accepted row
    // must have at least one evidence link before this transaction can commit.
    for (const recordId of importedRecordIds) {
      const row = deps.sqlite.prepare(`
        SELECT r.review_status AS reviewStatus,
               (SELECT count(*) FROM record_evidence re WHERE re.record_id = r.id) AS evidenceCount
        FROM records r WHERE r.id = ?
      `).get(recordId) as { reviewStatus: string; evidenceCount: number } | undefined;
      if (row?.reviewStatus === "accepted" && row.evidenceCount === 0) {
        throw new DumpImportError(
          "accepted_record_without_evidence",
          `Dump record ${recordId} is accepted but has no evidence; import refused.`,
          { recordId },
        );
      }
    }

    for (const raw of parsed.supersessions) {
      const normalized = isObject(raw)
        ? {
            ...raw,
            priorRecordId: typeof raw["priorRecordId"] === "string"
              ? (recordIdRemap.get(raw["priorRecordId"]) ?? raw["priorRecordId"])
              : raw["priorRecordId"],
            replacementRecordId: typeof raw["replacementRecordId"] === "string"
              ? (recordIdRemap.get(raw["replacementRecordId"]) ?? raw["replacementRecordId"])
              : raw["replacementRecordId"],
          }
        : raw;
      const result = importSupersession(deps, normalized, input.mode);
      counters.accepted += result.accepted;
      counters.skipped += result.skipped;
      counters.blocked += result.blocked;
      result.error && counters.errors.push(result.error);
      if (input.mode === "merge" && result.canonicalProjectId) changedCanonicalProjectIds.add(result.canonicalProjectId);
    }

    if (input.mode === "merge") {
      bumpProjectContentVersion(deps.db, changedCanonicalProjectIds);
      // A merged proposed agent report is a new working-memory observation. Do
      // not overwrite the target cursor with a cursor from another store; a
      // local monotonic increment preserves ordering on both machines.
      bumpProjectWorkingMemoryVersion(deps.db, workingMemoryProjectIds);
    }

    // Reset means exact reseed, not best-effort import. Any row-level blocker
    // must roll the whole transaction back so the previous store survives.
    if (input.mode === "reset" && counters.blocked > 0) {
      throw new DumpImportError(
        "reset_dump_blocked",
        `Reset import refused because ${counters.blocked} row(s) failed validation.`,
        { blocked: counters.blocked, errors: counters.errors },
      );
    }
  })();

  writeAudit(deps.db, {
    actor: ctx.actor,
    action: "import_dump.applied",
    targetType: "store",
    targetId: null,
    before: null,
    after: counters,
    detail: { mode: input.mode, source: input.source, version: parsed.version },
    requestId: ctx.requestId ?? null,
  });

  return counters;
}

function parseDump(dump: unknown): RawDump {
  if (!dump || typeof dump !== "object") {
    throw new DumpImportError("invalid_dump", "Dump payload must be a JSON object.");
  }
  const d = dump as Record<string, unknown>;
  if (d.format !== "contextkeep.json_dump") {
    throw new DumpImportError(
      "invalid_dump",
      `Unsupported dump format: ${String(d.format)} (expected contextkeep.json_dump).`,
    );
  }
  if (d.version !== 1) {
    throw new DumpImportError(
      "invalid_dump_version",
      `Unsupported dump version: ${String(d.version)} (this build handles version 1). Re-export from a compatible server.`,
    );
  }
  for (const k of ["projects", "sources", "sourceExcerpts", "records", "recordEvidence", "supersessions"] as const) {
    if (!Array.isArray(d[k])) {
      throw new DumpImportError("invalid_dump", `dump.${k} must be an array.`);
    }
  }
  return d as unknown as RawDump;
}

interface RowResult {
  accepted: number;
  skipped: number;
  retiredGuards: number;
  blocked: number;
  canonicalId?: string;
  canonicalProjectId?: string;
  insertedProjectId?: string;
  workingMemoryProjectId?: string;
  error?: { kind: string; id?: string; reason: string };
}

function importProject(deps: ServiceDeps, raw: unknown, mode: DumpImportMode): RowResult {
  const empty: RowResult = { accepted: 0, skipped: 0, retiredGuards: 0, blocked: 0 };
  if (!isObject(raw)) return { ...empty, blocked: 1, error: { kind: "project", reason: "not an object" } };
  const id = stringOrNull(raw["id"]);
  const name = stringOrNull(raw["name"]);
  if (!id || !name) {
    return { ...empty, blocked: 1, error: { kind: "project", reason: "missing id or name" } };
  }
  const existing = deps.db.select().from(projects).where(eq(projects.id, id)).get();
  if (existing) {
    if (mode === "merge") {
      // A3: never let a dump push a retired project back to a non-retired
      // lifecycle. If the incoming lifecycle differs, drop it on the floor
      // and bump the retired_guards counter so the owner notices.
      if (
        existing.lifecycle === "retired" &&
        typeof raw["lifecycle"] === "string" &&
        raw["lifecycle"] !== "retired"
      ) {
        return {
          ...empty,
          skipped: 1,
          retiredGuards: 1,
        };
      }
      return { ...empty, skipped: 1 };
    }
    // reset mode wiped the table — existing should be null; fall through to insert.
  }
  deps.db
    .insert(projects)
    .values({
      id,
      name,
      aliasesJson: typeof raw["aliasesJson"] === "string" ? raw["aliasesJson"] : "[]",
      parentProjectId: typeof raw["parentProjectId"] === "string" ? raw["parentProjectId"] : null,
      description: typeof raw["description"] === "string" ? raw["description"] : null,
      lifecycle: typeof raw["lifecycle"] === "string" ? raw["lifecycle"] : "unknown",
      lifecycleRecordId:
        typeof raw["lifecycleRecordId"] === "string" ? raw["lifecycleRecordId"] : null,
      revision: numberOr(raw["revision"], 1),
      contentVersion: numberOr(raw["contentVersion"], 0),
      workingMemoryVersion: numberOr(raw["workingMemoryVersion"], 0),
      createdAt: stringOr(raw["createdAt"], nowIso()),
      updatedAt: stringOr(raw["updatedAt"], nowIso()),
    })
    .run();
  return { ...empty, accepted: 1, insertedProjectId: id };
}

function importSource(deps: ServiceDeps, raw: unknown, mode: DumpImportMode): RowResult {
  const empty: RowResult = { accepted: 0, skipped: 0, retiredGuards: 0, blocked: 0 };
  if (!isObject(raw)) return { ...empty, blocked: 1, error: { kind: "source", reason: "not an object" } };
  const id = stringOrNull(raw["id"]);
  const contentHash = stringOrNull(raw["contentHash"]);
  if (!id || !contentHash) {
    return { ...empty, blocked: 1, error: { kind: "source", id: id ?? undefined, reason: "missing id or contentHash" } };
  }
  if (mode === "merge") {
    const existing = deps.db.select().from(sources).where(eq(sources.id, id)).get()
      ?? deps.db.select().from(sources).where(eq(sources.contentHash, contentHash)).get();
    if (existing) return { ...empty, skipped: 1, canonicalId: existing.id };
  }
  deps.db
    .insert(sources)
    .values({
      id,
      kind: stringOr(raw["kind"], "manual"),
      title: typeof raw["title"] === "string" ? raw["title"] : null,
      originalFilename: typeof raw["originalFilename"] === "string" ? raw["originalFilename"] : null,
      contentHash,
      normalizedHash: stringOr(raw["normalizedHash"], contentHash),
      importedAt: stringOr(raw["importedAt"], nowIso()),
      eventAt: typeof raw["eventAt"] === "string" ? raw["eventAt"] : null,
      authorLabel: typeof raw["authorLabel"] === "string" ? raw["authorLabel"] : null,
      provenanceBasis: stringOr(raw["provenanceBasis"], "document"),
      projectId: typeof raw["projectId"] === "string" ? raw["projectId"] : null,
      originalText: stringOr(raw["originalText"], ""),
      normalizedText: stringOr(raw["normalizedText"], ""),
      redactionState: stringOr(raw["redactionState"], "none"),
    })
    .run();
  return { ...empty, accepted: 1, canonicalId: id };
}

function importSourceExcerpt(deps: ServiceDeps, raw: unknown, mode: DumpImportMode): RowResult {
  const empty: RowResult = { accepted: 0, skipped: 0, retiredGuards: 0, blocked: 0 };
  if (!isObject(raw)) return { ...empty, blocked: 1, error: { kind: "sourceExcerpt", reason: "not an object" } };
  const id = stringOrNull(raw["id"]);
  const sourceId = stringOrNull(raw["sourceId"]);
  if (!id || !sourceId) {
    return { ...empty, blocked: 1, error: { kind: "sourceExcerpt", id: id ?? undefined, reason: "missing id or sourceId" } };
  }
  if (mode === "merge") {
    const existing = deps.db.select().from(sourceExcerpts).where(eq(sourceExcerpts.id, id)).get();
    if (existing) return { ...empty, skipped: 1, canonicalId: existing.id };
    const exactText = stringOr(raw["exactText"], "");
    const exactTextHash = stringOr(raw["exactTextHash"], sha256(exactText));
    const startOffset = numberOr(raw["startOffset"], 0);
    const endOffset = numberOr(raw["endOffset"], 0);
    const equivalent = deps.db
      .select({ id: sourceExcerpts.id })
      .from(sourceExcerpts)
      .where(sql`${sourceExcerpts.sourceId} = ${sourceId}
        AND ${sourceExcerpts.startOffset} = ${startOffset}
        AND ${sourceExcerpts.endOffset} = ${endOffset}
        AND ${sourceExcerpts.exactTextHash} = ${exactTextHash}`)
      .get();
    if (equivalent) return { ...empty, skipped: 1, canonicalId: equivalent.id };
  }
  deps.db
    .insert(sourceExcerpts)
    .values({
      id,
      sourceId,
      startOffset: numberOr(raw["startOffset"], 0),
      endOffset: numberOr(raw["endOffset"], 0),
      exactText: stringOr(raw["exactText"], ""),
      exactTextHash: stringOr(raw["exactTextHash"], sha256(stringOr(raw["exactText"], ""))),
    })
    .run();
  return { ...empty, accepted: 1, canonicalId: id };
}

function importRecord(deps: ServiceDeps, raw: unknown, mode: DumpImportMode): RowResult {
  const empty: RowResult = { accepted: 0, skipped: 0, retiredGuards: 0, blocked: 0 };
  if (!isObject(raw)) return { ...empty, blocked: 1, error: { kind: "record", reason: "not an object" } };
  const id = stringOrNull(raw["id"]);
  const text = typeof raw["text"] === "string" ? raw["text"] : "";
  const subject = typeof raw["subject"] === "string" ? raw["subject"] : "imported";
  const type = typeof raw["type"] === "string" ? raw["type"] : "fact";
  const projectId = typeof raw["projectId"] === "string" ? raw["projectId"] : null;
  const reviewStatus = typeof raw["reviewStatus"] === "string" ? raw["reviewStatus"] : "proposed";
  const evidenceBasis = typeof raw["evidenceBasis"] === "string" ? raw["evidenceBasis"] : "agent_report";

  if (!id) {
    return { ...empty, blocked: 1, error: { kind: "record", reason: "missing id" } };
  }

  if (mode === "merge") {
    const existing = deps.db.select().from(records).where(eq(records.id, id)).get();
    if (existing) return { ...empty, skipped: 1, canonicalId: existing.id };
    // Also skip on dedup hash collision — protects against dumps from a
    // second machine where the ids are different but the content matches.
    const incomingHash = computeRecordDedupHash({ projectId, type, subject, text });
    const dup = deps.db
      .select({ id: records.id })
      .from(records)
      .where(sql`record_dedup_hash = ${incomingHash}`)
      .get();
    if (dup) return { ...empty, skipped: 1, canonicalId: dup.id };
  }

  // A19: a dump import never sets ownerAction. If the target project is
  // retired, force the imported record's review_status to "proposed" so the
  // owner still has to review it (and explicit-accept with ownerAction).
  let effectiveStatus = reviewStatus;
  let retiredGuard = 0;
  if (projectId) {
    const proj = deps.db.select({ lifecycle: projects.lifecycle }).from(projects).where(eq(projects.id, projectId)).get();
    if (proj?.lifecycle === "retired" && reviewStatus === "accepted") {
      effectiveStatus = "proposed";
      retiredGuard = 1;
    }
  }

  const dedupHash =
    typeof raw["recordDedupHash"] === "string" && raw["recordDedupHash"].length > 0
      ? raw["recordDedupHash"]
      : computeRecordDedupHash({ projectId, type, subject, text });

  deps.db
    .insert(records)
    .values({
      id,
      projectId,
      type,
      subject,
      predicate: typeof raw["predicate"] === "string" ? raw["predicate"] : null,
      valueJson: typeof raw["valueJson"] === "string" ? raw["valueJson"] : null,
      text,
      reviewStatus: effectiveStatus,
      evidenceBasis,
      taskStatus: typeof raw["taskStatus"] === "string" ? raw["taskStatus"] : null,
      recordDedupHash: dedupHash,
      recordedAt: stringOr(raw["recordedAt"], nowIso()),
      sourceEventAt: typeof raw["sourceEventAt"] === "string" ? raw["sourceEventAt"] : null,
      effectiveFrom: typeof raw["effectiveFrom"] === "string" ? raw["effectiveFrom"] : null,
      effectiveTo: typeof raw["effectiveTo"] === "string" ? raw["effectiveTo"] : null,
      reviewedAt: typeof raw["reviewedAt"] === "string" ? raw["reviewedAt"] : null,
      reviewDueAt: typeof raw["reviewDueAt"] === "string" ? raw["reviewDueAt"] : null,
      volatile: raw["volatile"] === true || raw["volatile"] === 1 ? 1 : 0,
      revision: numberOr(raw["revision"], 1),
      createdAt: stringOr(raw["createdAt"], nowIso()),
      updatedAt: stringOr(raw["updatedAt"], nowIso()),
    })
    .run();
  return {
    ...empty,
    accepted: 1,
    retiredGuards: retiredGuard,
    canonicalId: id,
    canonicalProjectId: effectiveStatus === "accepted" ? projectId ?? undefined : undefined,
    workingMemoryProjectId: effectiveStatus === "proposed" && evidenceBasis === "agent_report" ? projectId ?? undefined : undefined,
  };
}

function importRecordEvidence(deps: ServiceDeps, raw: unknown, mode: DumpImportMode): RowResult {
  const empty: RowResult = { accepted: 0, skipped: 0, retiredGuards: 0, blocked: 0 };
  if (!isObject(raw)) return { ...empty, blocked: 1, error: { kind: "recordEvidence", reason: "not an object" } };
  const recordId = stringOrNull(raw["recordId"]);
  const excerptId = stringOrNull(raw["excerptId"]);
  if (!recordId || !excerptId) {
    return {
      ...empty,
      blocked: 1,
      error: { kind: "recordEvidence", reason: "missing recordId or excerptId" },
    };
  }
  if (mode === "merge") {
    const existing = deps.db
      .select({ recordId: recordEvidence.recordId })
      .from(recordEvidence)
      .where(sql`record_id = ${recordId} AND excerpt_id = ${excerptId}`)
      .get();
    if (existing) return { ...empty, skipped: 1 };
  }
  deps.db
    .insert(recordEvidence)
    .values({
      recordId,
      excerptId,
      relation: stringOr(raw["relation"], "supports"),
      observedAt: typeof raw["observedAt"] === "string" ? raw["observedAt"] : null,
      environment: typeof raw["environment"] === "string" ? raw["environment"] : null,
      artifactRef: typeof raw["artifactRef"] === "string" ? raw["artifactRef"] : null,
    })
    .run();
  const record = deps.db.select({ projectId: records.projectId, reviewStatus: records.reviewStatus }).from(records).where(eq(records.id, recordId)).get();
  return {
    ...empty,
    accepted: 1,
    canonicalProjectId: record?.reviewStatus === "accepted" ? record.projectId ?? undefined : undefined,
  };
}

function importSupersession(deps: ServiceDeps, raw: unknown, mode: DumpImportMode): RowResult {
  const empty: RowResult = { accepted: 0, skipped: 0, retiredGuards: 0, blocked: 0 };
  if (!isObject(raw)) return { ...empty, blocked: 1, error: { kind: "supersession", reason: "not an object" } };
  const id = stringOrNull(raw["id"]);
  if (!id) {
    return { ...empty, blocked: 1, error: { kind: "supersession", reason: "missing id" } };
  }
  if (mode === "merge") {
    const existing = deps.db.select().from(supersessions).where(eq(supersessions.id, id)).get();
    if (existing) return { ...empty, skipped: 1 };
  }
  deps.db
    .insert(supersessions)
    .values({
      id,
      priorRecordId: stringOrNull(raw["priorRecordId"]) ?? "",
      replacementRecordId: stringOrNull(raw["replacementRecordId"]) ?? "",
      jobId: typeof raw["jobId"] === "string" ? raw["jobId"] : null,
      reason: stringOr(raw["reason"], ""),
      confirmedAt: typeof raw["confirmedAt"] === "string" ? raw["confirmedAt"] : null,
      confirmedBy: typeof raw["confirmedBy"] === "string" ? raw["confirmedBy"] : null,
      proposedAt: stringOr(raw["proposedAt"], nowIso()),
    })
    .run();
  if (raw["confirmedAt"] === null || typeof raw["confirmedAt"] !== "string") return { ...empty, accepted: 1 };
  const prior = deps.db.select({ projectId: records.projectId }).from(records).where(eq(records.id, stringOrNull(raw["priorRecordId"]) ?? "")).get();
  const replacement = deps.db.select({ projectId: records.projectId }).from(records).where(eq(records.id, stringOrNull(raw["replacementRecordId"]) ?? "")).get();
  return {
    ...empty,
    accepted: 1,
    canonicalProjectId: replacement?.projectId ?? prior?.projectId ?? undefined,
  };
}

function topologicallyOrderProjects(rawProjects: unknown[]): unknown[] {
  // Build id -> raw map and id -> parentId map. Invalid/duplicate rows must
  // remain in the returned list so importProject can count/block them instead
  // of silently dropping them before a reset decision is made.
  const byId = new Map<string, Record<string, unknown>>();
  const parentOf = new Map<string, string | null>();
  const deferred: unknown[] = [];
  for (const r of rawProjects) {
    if (!isObject(r)) {
      deferred.push(r);
      continue;
    }
    const id = stringOrNull(r["id"]);
    if (!id || byId.has(id)) {
      deferred.push(r);
      continue;
    }
    byId.set(id, r);
    parentOf.set(id, typeof r["parentProjectId"] === "string" ? r["parentProjectId"] : null);
  }
  // Kahn's algorithm restricted to projects in this dump (orphaned parent
  // references are kept as-is; they'll just produce a FK error and end up
  // in counters.blocked with a useful message — not a silent failure).
  const result: unknown[] = [];
  const remaining = new Set(byId.keys());
  const progress = (): boolean => {
    let added = false;
    for (const id of [...remaining]) {
      const parent = parentOf.get(id);
      if (parent === null || parent === undefined || !byId.has(parent) || result.includes(byId.get(parent)!)) {
        result.push(byId.get(id)!);
        remaining.delete(id);
        added = true;
      }
    }
    return added;
  };
  while (remaining.size > 0) {
    if (!progress()) {
      // Cycle or all remaining have unresolved parents — append in original
      // order; the FK will fire and report blocked rows.
      for (const r of rawProjects) {
        if (isObject(r) && typeof r["id"] === "string" && remaining.has(r["id"] as string)) {
          result.push(r);
        }
      }
      break;
    }
  }
  return [...result, ...deferred];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}
function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Build a fresh dump-import counters object (used by tests). */
export function emptyCounters(dumpSha256: string): DumpImportCounters {
  return { accepted: 0, skipped: 0, retiredGuards: 0, blocked: 0, dumpSha256, errors: [] };
}

/** Convenience: parse the dump and produce its SHA-256 without applying it. */
export function summarizeDump(dump: unknown): { ok: true; sha256: string } | { ok: false; code: string; message: string } {
  try {
    parseDump(dump);
  } catch (e) {
    if (e instanceof DumpImportError) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: "invalid_dump", message: (e as Error).message };
  }
  const sha = createHash("sha256").update(JSON.stringify(dump)).digest("hex");
  return { ok: true, sha256: sha };
}

/** Helper to give external callers (HTTP route) a stable id for the dry-run. */
export function dryRunIdempotency(deps: ServiceDeps, dump: RawDump): { wouldSkip: number; wouldApply: number } {
  let wouldSkip = 0;
  let wouldApply = 0;
  for (const raw of dump.projects) {
    if (!isObject(raw)) continue;
    const id = stringOrNull(raw["id"]);
    if (!id) continue;
    const existing = deps.db.select().from(projects).where(eq(projects.id, id)).get();
    if (existing) wouldSkip += 1;
    else wouldApply += 1;
  }
  return { wouldSkip, wouldApply };
}
