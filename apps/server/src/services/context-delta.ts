import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { RecordDto } from "@contextkeep/shared";
import {
  contextCursorSnapshots,
  contextDeltaSessions,
  projects,
  records,
} from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { dualContentResultBytes, MCP_RESULT_BYTE_BUDGET } from "../lib/result-budget.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import { loadEvidenceFor, attachProjectNames, toProjectDto } from "./mappers.js";
import {
  buildContextManifest,
  readContextCursorSnapshot,
  type ContextCursorScope,
  type ContextManifest,
} from "./context-journal.js";
import type { ServiceDeps } from "./import.js";
import { requireProject } from "./memory-management.js";

export type ContextDeltaResetReason =
  | "cursor_ahead"
  | "history_unavailable"
  | "cursor_expired"
  | "page_expired";

export type ContextDeltaChange = {
  changeId: string;
  scope: ContextCursorScope;
  kind: "upsert" | "remove";
  recordId: string;
  targetCursor: number;
  previousHash: string | null;
  currentHash: string | null;
  record: RecordDto | null;
};

type HighWatermark = {
  canonicalCursor: number;
  workingCursor: number;
  projectRevision: number;
};

type DeltaSessionPayload = {
  changes: ContextDeltaChange[];
  baseline?: boolean;
  resetReason?: ContextDeltaResetReason | null;
  fullSnapshot?: unknown | null;
};

const SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const DELTA_PAGE_MAX_BYTES = 400_000;

function parseManifest(raw: string): ContextManifest {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: ContextManifest = {};
    for (const [id, hash] of Object.entries(value)) {
      if (typeof hash === "string") out[id] = hash;
    }
    return out;
  } catch {
    return {};
  }
}

function rowsForScope(deps: ServiceDeps, projectId: string, scope: ContextCursorScope, ids?: string[]) {
  const base = scope === "canonical"
    ? and(eq(records.projectId, projectId), inArray(records.reviewStatus, ["accepted", "superseded"]))
    : and(
        eq(records.projectId, projectId),
        eq(records.reviewStatus, "proposed"),
        eq(records.evidenceBasis, "agent_report"),
      );
  const where = ids
    ? and(base, ids.length > 0 ? inArray(records.id, ids) : sql`0`)
    : base;
  return deps.db.select().from(records).where(where).orderBy(asc(records.id)).all();
}

function materialRecords(
  deps: ServiceDeps,
  projectId: string,
  scope: ContextCursorScope,
  ids?: string[],
): RecordDto[] {
  const rows = rowsForScope(deps, projectId, scope, ids);
  const evidence = loadEvidenceFor(deps.db, rows.map((row) => row.id));
  return attachProjectNames(deps.db, rows, evidence);
}

function fullSnapshot(deps: ServiceDeps, projectId: string) {
  const project = requireProject(deps, projectId);
  return {
    project: toProjectDto(project),
    freshness: {
      canonical: { cursor: project.contentVersion, status: "canonical" },
      working: { cursor: project.workingMemoryVersion, status: "unreviewed_working_memory" },
    },
    canonicalRecords: materialRecords(deps, projectId, "canonical"),
    workingRecords: materialRecords(deps, projectId, "working"),
  };
}

function resetResponse(
  deps: ServiceDeps,
  input: {
    projectId: string;
    canonicalCursor: number;
    workingCursor: number;
    projectRevision: number;
    requestKey?: string | null;
  },
  reason: ContextDeltaResetReason,
  current: HighWatermark,
  limit: number,
) {
  const canonicalChanges = makeChanges(
    deps,
    input.projectId,
    "canonical",
    {},
    buildContextManifest(deps.db, input.projectId, "canonical"),
    current.canonicalCursor,
  );
  const workingChanges = makeChanges(
    deps,
    input.projectId,
    "working",
    {},
    buildContextManifest(deps.db, input.projectId, "working"),
    current.workingCursor,
  );
  const changes = [...canonicalChanges, ...workingChanges].sort((a, b) =>
    a.scope.localeCompare(b.scope) || a.recordId.localeCompare(b.recordId) || a.kind.localeCompare(b.kind)
  );
  const sessionId = newId();
  const cutoff = new Date(Date.now() - SESSION_RETENTION_MS).toISOString();
  const projectJson = JSON.stringify(toProjectDto(requireProject(deps, input.projectId)));
  const snapshot = fullSnapshot(deps, input.projectId);
  const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot));
  const inlineSnapshot = snapshotBytes <= 250_000 ? snapshot : null;

  deps.db.transaction((tx) => {
    tx.delete(contextDeltaSessions).where(sql`${contextDeltaSessions.createdAt} < ${cutoff}`).run();
    tx.insert(contextDeltaSessions).values({
      id: sessionId,
      projectId: input.projectId,
      fromCanonicalCursor: input.canonicalCursor,
      fromWorkingCursor: input.workingCursor,
      fromProjectRevision: input.projectRevision,
      targetCanonicalCursor: current.canonicalCursor,
      targetWorkingCursor: current.workingCursor,
      targetProjectRevision: current.projectRevision,
      requestKey: input.requestKey ?? null,
      changesJson: JSON.stringify({ changes, baseline: true, resetReason: reason, fullSnapshot: inlineSnapshot } satisfies DeltaSessionPayload),
      projectJson,
      createdAt: nowIso(),
    }).run();
  });

  const session = deps.db.select().from(contextDeltaSessions).where(eq(contextDeltaSessions.id, sessionId)).get()!;
  return pageFromSession(deps, session, 0, limit, false);
}

function missingSnapshotReason(
  deps: ServiceDeps,
  projectId: string,
  scope: ContextCursorScope,
  requestedCursor: number,
): ContextDeltaResetReason {
  const oldest = deps.db
    .select({
      cursor: contextCursorSnapshots.cursor,
      baseline: contextCursorSnapshots.baseline,
    })
    .from(contextCursorSnapshots)
    .where(and(
      eq(contextCursorSnapshots.projectId, projectId),
      eq(contextCursorSnapshots.scope, scope),
    ))
    .orderBy(asc(contextCursorSnapshots.cursor))
    .limit(1)
    .get();
  if (!oldest) return "history_unavailable";
  if (requestedCursor < oldest.cursor && oldest.baseline === 1) return "history_unavailable";
  return "cursor_expired";
}

function makeChanges(
  deps: ServiceDeps,
  projectId: string,
  scope: ContextCursorScope,
  fromManifest: ContextManifest,
  targetManifest: ContextManifest,
  targetCursor: number,
): ContextDeltaChange[] {
  const ids = [...new Set([...Object.keys(fromManifest), ...Object.keys(targetManifest)])].sort();
  const changedIds = ids.filter((id) =>
    targetManifest[id] !== undefined && targetManifest[id] !== fromManifest[id]
  );
  const recordsById = new Map(
    materialRecords(deps, projectId, scope, changedIds).map((record) => [record.id, record]),
  );

  const changes: ContextDeltaChange[] = [];
  for (const recordId of ids) {
    const before = fromManifest[recordId] ?? null;
    const after = targetManifest[recordId] ?? null;
    if (before === after) continue;
    const kind = after === null ? "remove" : "upsert";
    const record = kind === "upsert" ? (recordsById.get(recordId) ?? null) : null;
    if (kind === "upsert" && record === null) {
      throw new ApiError(409, "context_delta_state_changed", "Context state changed while materializing the delta; retry from the same cursor.");
    }
    changes.push({
      changeId: [scope, targetCursor, kind, recordId, before ?? "", after ?? ""].join(":"),
      scope,
      kind,
      recordId,
      targetCursor,
      previousHash: before,
      currentHash: after,
      record,
    });
  }
  return changes;
}

function parsePageToken(token: string): { sessionId: string; offset: number } | null {
  const match = /^([0-9a-fA-F-]{36}):(\d+)$/.exec(token);
  if (!match) return null;
  const offset = Number.parseInt(match[2]!, 10);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  return { sessionId: match[1]!, offset };
}

function pageFromSession(
  deps: ServiceDeps,
  row: typeof contextDeltaSessions.$inferSelect,
  offset: number,
  limit: number,
  strictOffset = false,
) {
  let payload: DeltaSessionPayload;
  try {
    payload = JSON.parse(row.changesJson) as DeltaSessionPayload;
  } catch {
    throw new ApiError(409, "context_delta_session_corrupt", "Stored context delta session is unreadable; request a fresh snapshot.");
  }
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  if (offset > changes.length || (strictOffset && (changes.length === 0 || offset >= changes.length))) {
    throw new ApiError(400, "context_delta_page_offset_invalid", "Context delta page token points past the available session data.", {
      offset,
      totalChanges: changes.length,
    });
  }
  const page: ContextDeltaChange[] = [];
  let pageBytes = 2; // JSON array brackets.
  for (let index = offset; index < changes.length && page.length < limit; index += 1) {
    const change = changes[index]!;
    const serializedBytes = Buffer.byteLength(JSON.stringify(change), "utf8");
    const separatorBytes = page.length > 0 ? 1 : 0;
    if (page.length > 0 && pageBytes + separatorBytes + serializedBytes > DELTA_PAGE_MAX_BYTES) break;
    page.push(change);
    pageBytes += separatorBytes + serializedBytes;
    // A single material change may exceed the normal page budget. Return it
    // alone so pagination always makes forward progress and never drops data.
    if (pageBytes > DELTA_PAGE_MAX_BYTES) break;
  }
  const nextOffset = offset + page.length;
  const nextPageToken = nextOffset < changes.length ? `${row.id}:${nextOffset}` : null;
  const result = {
    projectId: row.projectId,
    resetRequired: payload.baseline === true,
    fullSnapshotRequired: payload.baseline === true,
    resetReason: payload.baseline === true ? payload.resetReason ?? "history_unavailable" : null,
    from: {
      canonicalCursor: row.fromCanonicalCursor,
      workingCursor: row.fromWorkingCursor,
      projectRevision: row.fromProjectRevision,
    },
    highWatermark: {
      canonicalCursor: row.targetCanonicalCursor,
      workingCursor: row.targetWorkingCursor,
      projectRevision: row.targetProjectRevision,
    },
    changes: page,
    totalChanges: changes.length,
    offset,
    returned: page.length,
    pageBytes,
    pageByteBudget: DELTA_PAGE_MAX_BYTES,
    pageOversize: pageBytes > DELTA_PAGE_MAX_BYTES,
    pageToken: `${row.id}:${offset}`,
    nextPageToken,
    sessionId: row.id,
    requestKey: row.requestKey,
    project: row.projectJson ? JSON.parse(row.projectJson) as unknown : null,
    fullSnapshot: payload.baseline === true && offset === 0 ? payload.fullSnapshot ?? null : null,
    fullSnapshotTruncated: payload.baseline === true && !payload.fullSnapshot,
    baselineMode: payload.baseline === true ? "changes_from_empty" : null,
  };
  // Inline snapshots duplicate the baseline changes and are only a convenience.
  // Keep the complete material baseline pageable when both representations
  // plus that duplicate would exceed the result transport budget.
  if (dualContentResultBytes(result) > MCP_RESULT_BYTE_BUDGET && result.fullSnapshot !== null) {
    result.fullSnapshot = null;
    result.fullSnapshotTruncated = true;
  }
  while (page.length > 1 && dualContentResultBytes(result) > MCP_RESULT_BYTE_BUDGET) {
    page.pop();
    result.returned = page.length;
    result.pageBytes = Buffer.byteLength(JSON.stringify(page), "utf8");
    result.pageOversize = result.pageBytes > DELTA_PAGE_MAX_BYTES;
    result.nextPageToken = `${row.id}:${offset + page.length}`;
  }
  // A single record is never skipped. The MCP boundary reports an explicit
  // oversize error if even that one material change cannot be represented.
  return result;
}

export function getContextDelta(
  deps: ServiceDeps,
  input: {
    projectId: string;
    canonicalCursor: number;
    workingCursor: number;
    projectRevision: number;
    limit?: number;
    pageToken?: string | null;
    requestKey?: string | null;
  },
) {
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  const currentProject = requireProject(deps, input.projectId);
  const current: HighWatermark = {
    canonicalCursor: currentProject.contentVersion,
    workingCursor: currentProject.workingMemoryVersion,
    projectRevision: currentProject.revision,
  };

  if (input.pageToken) {
    const parsed = parsePageToken(input.pageToken);
    if (!parsed) {
      throw new ApiError(400, "context_delta_page_token_invalid", "Context delta page token is malformed.");
    }
    const session = deps.db
      .select()
      .from(contextDeltaSessions)
      .where(and(
        eq(contextDeltaSessions.id, parsed.sessionId),
        eq(contextDeltaSessions.projectId, input.projectId),
      ))
      .get();
    const cutoffMs = Date.now() - SESSION_RETENTION_MS;
    if (!session || Date.parse(session.createdAt) < cutoffMs) {
      if (session) deps.db.delete(contextDeltaSessions).where(eq(contextDeltaSessions.id, session.id)).run();
      return resetResponse(deps, input, "page_expired", current, limit);
    }
    return pageFromSession(deps, session, parsed.offset, limit, true);
  }

  if (input.requestKey) {
    const existingSession = deps.db
      .select()
      .from(contextDeltaSessions)
      .where(and(
        eq(contextDeltaSessions.projectId, input.projectId),
        eq(contextDeltaSessions.requestKey, input.requestKey),
      ))
      .get();
    if (existingSession) {
      if (
        existingSession.fromCanonicalCursor !== input.canonicalCursor ||
        existingSession.fromWorkingCursor !== input.workingCursor ||
        existingSession.fromProjectRevision !== input.projectRevision
      ) {
        throw new ApiError(
          409,
          "context_delta_request_key_reused",
          "Context delta requestKey was already used with different cursors.",
        );
      }
      return pageFromSession(deps, existingSession, 0, limit);
    }
  }

  if (
    input.canonicalCursor > current.canonicalCursor ||
    input.workingCursor > current.workingCursor ||
    input.projectRevision > current.projectRevision
  ) {
    return resetResponse(deps, input, "cursor_ahead", current, limit);
  }

  const canonicalFrom = readContextCursorSnapshot(deps.db, input.projectId, "canonical", input.canonicalCursor);
  if (!canonicalFrom) {
    return resetResponse(
      deps,
      input,
      missingSnapshotReason(deps, input.projectId, "canonical", input.canonicalCursor),
      current,
      limit,
    );
  }
  const workingFrom = readContextCursorSnapshot(deps.db, input.projectId, "working", input.workingCursor);
  if (!workingFrom) {
    return resetResponse(
      deps,
      input,
      missingSnapshotReason(deps, input.projectId, "working", input.workingCursor),
      current,
      limit,
    );
  }
  const canonicalTarget = readContextCursorSnapshot(deps.db, input.projectId, "canonical", current.canonicalCursor);
  const workingTarget = readContextCursorSnapshot(deps.db, input.projectId, "working", current.workingCursor);
  if (!canonicalTarget || !workingTarget) {
    return resetResponse(deps, input, "history_unavailable", current, limit);
  }

  const canonicalChanges = makeChanges(
    deps,
    input.projectId,
    "canonical",
    parseManifest(canonicalFrom.manifestJson),
    parseManifest(canonicalTarget.manifestJson),
    current.canonicalCursor,
  );
  const workingChanges = makeChanges(
    deps,
    input.projectId,
    "working",
    parseManifest(workingFrom.manifestJson),
    parseManifest(workingTarget.manifestJson),
    current.workingCursor,
  );
  const changes = [...canonicalChanges, ...workingChanges]
    .sort((a, b) =>
      a.scope.localeCompare(b.scope) ||
      a.recordId.localeCompare(b.recordId) ||
      a.kind.localeCompare(b.kind)
    );

  const projectJson = input.projectRevision === current.projectRevision
    ? null
    : JSON.stringify(toProjectDto(currentProject));
  const sessionId = newId();
  const cutoff = new Date(Date.now() - SESSION_RETENTION_MS).toISOString();

  deps.db.transaction((tx) => {
    tx.delete(contextDeltaSessions)
      .where(sql`${contextDeltaSessions.createdAt} < ${cutoff}`)
      .run();
    tx.insert(contextDeltaSessions).values({
      id: sessionId,
      projectId: input.projectId,
      fromCanonicalCursor: input.canonicalCursor,
      fromWorkingCursor: input.workingCursor,
      fromProjectRevision: input.projectRevision,
      targetCanonicalCursor: current.canonicalCursor,
      targetWorkingCursor: current.workingCursor,
      targetProjectRevision: current.projectRevision,
      requestKey: input.requestKey ?? null,
      changesJson: JSON.stringify({ changes } satisfies DeltaSessionPayload),
      projectJson,
      createdAt: nowIso(),
    }).run();
  });

  const session = deps.db.select().from(contextDeltaSessions).where(eq(contextDeltaSessions.id, sessionId)).get()!;
  return pageFromSession(deps, session, 0, limit);
}
