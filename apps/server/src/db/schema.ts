import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Handoff §7 schema. All timestamps are UTC ISO-8601 text. JSON payloads are
// stored as TEXT columns with *Json suffixes.

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    aliasesJson: text("aliases_json").notNull().default("[]"),
    parentProjectId: text("parent_project_id").references((): any => projects.id, {
      onDelete: "set null",
    }),
    description: text("description"),
    /** Projection of the accepted lifecycle record (handoff §7), never free-floating. */
    lifecycle: text("lifecycle").notNull().default("unknown"),
    lifecycleRecordId: text("lifecycle_record_id").references((): any => records.id, {
      onDelete: "set null",
    }),
    revision: integer("revision").notNull().default(1),
    contentVersion: integer("content_version").notNull().default(0),
    /** A4: monotonic cursor for unreviewed agent working memory. */
    workingMemoryVersion: integer("working_memory_version").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_projects_name").on(t.name), index("ix_projects_parent").on(t.parentProjectId)],
);

export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    title: text("title"),
    originalFilename: text("original_filename"),
    /** sha256 of the ORIGINAL text — A1 exact-duplicate detection. */
    contentHash: text("content_hash").notNull(),
    normalizedHash: text("normalized_hash").notNull(),
    importedAt: text("imported_at").notNull(),
    eventAt: text("event_at"),
    authorLabel: text("author_label"),
    provenanceBasis: text("provenance_basis").notNull(),
    projectId: text("project_id").references((): any => projects.id, { onDelete: "set null" }),
    originalText: text("original_text").notNull(),
    normalizedText: text("normalized_text").notNull(),
    redactionState: text("redaction_state").notNull().default("none"),
  },
  (t) => [
    uniqueIndex("uq_sources_content_hash").on(t.contentHash),
    index("ix_sources_project").on(t.projectId),
  ],
);

export const sourceExcerpts = sqliteTable(
  "source_excerpts",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references((): any => sources.id, { onDelete: "cascade" }),
    /** Offsets into sources.normalized_text — exact_text === slice(start, end). */
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    exactText: text("exact_text").notNull(),
    exactTextHash: text("exact_text_hash").notNull(),
  },
  (t) => [index("ix_excerpts_source").on(t.sourceId)],
);

export const records = sqliteTable(
  "records",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references((): any => projects.id, { onDelete: "set null" }),
    type: text("type").notNull(), // fact | decision | action | constraint | question
    subject: text("subject").notNull(),
    predicate: text("predicate"),
    valueJson: text("value_json"),
    text: text("text").notNull(),
    reviewStatus: text("review_status").notNull().default("proposed"), // proposed|accepted|rejected|superseded
    evidenceBasis: text("evidence_basis").notNull(),
    taskStatus: text("task_status"), // actions: open|in_progress|blocked|done|cancelled
    /** sha256 of (project, type, subject, normalized text) — §8.8 exact-duplicate skip. */
    recordDedupHash: text("record_dedup_hash").notNull(),
    recordedAt: text("recorded_at").notNull(),
    sourceEventAt: text("source_event_at"),
    effectiveFrom: text("effective_from"),
    effectiveTo: text("effective_to"),
    reviewedAt: text("reviewed_at"),
    reviewDueAt: text("review_due_at"),
    /** A11: volatile fact flag — drives review_due_at on accept (handoff §12 item 15). */
    volatile: integer("volatile").notNull().default(0),
    /** Stale-edit rejection (handoff §7): optimistic concurrency control. */
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("ix_records_project_status").on(t.projectId, t.reviewStatus),
    index("ix_records_status").on(t.reviewStatus),
    index("ix_records_recorded").on(t.recordedAt),
    // A2 backstop: only ONE accepted lifecycle record per project/component.
    uniqueIndex("uq_accepted_lifecycle_per_project")
      .on(t.projectId)
      .where(sql`type = 'fact' AND predicate = 'lifecycle' AND review_status = 'accepted'`),
    // A2 backstop for ordinary structured claims. Relations use their object as
    // part of identity so one source/entity can have multiple dependencies.
    uniqueIndex("uq_accepted_structured_claim")
      .on(t.projectId, t.subject, t.predicate)
      .where(sql`review_status = 'accepted' AND predicate IS NOT NULL AND predicate NOT IN ('depends_on', 'blocks', 'affects', 'runs_on')`),
    uniqueIndex("uq_accepted_relation")
      .on(t.projectId, t.subject, t.predicate, t.valueJson)
      .where(sql`review_status = 'accepted' AND predicate IN ('depends_on', 'blocks', 'affects', 'runs_on')`),
    // §8.8: exact-duplicate records per project are impossible while proposed/accepted.
    uniqueIndex("uq_record_dedupe")
      .on(t.projectId, t.recordDedupHash)
      .where(sql`review_status IN ('proposed', 'accepted')`),
  ],
);

export const recordEvidence = sqliteTable(
  "record_evidence",
  {
    recordId: text("record_id")
      .notNull()
      .references((): any => records.id, { onDelete: "cascade" }),
    excerptId: text("excerpt_id")
      .notNull()
      .references((): any => sourceExcerpts.id, { onDelete: "cascade" }),
    relation: text("relation").notNull().default("supports"), // supports | contradicts
    observedAt: text("observed_at"),
    environment: text("environment"),
    artifactRef: text("artifact_ref"),
  },
  (t) => [primaryKey({ columns: [t.recordId, t.excerptId] })],
);

export const importJobs = sqliteTable(
  "import_jobs",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").references((): any => sources.id, { onDelete: "set null" }),
    stage: text("stage").notNull(),
    adapterId: text("adapter_id").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    providerModel: text("provider_model"),
    attempts: integer("attempts").notNull().default(0),
    errorCode: text("error_code"),
    usageJson: text("usage_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("ix_import_jobs_source").on(t.sourceId)],
);

export const supersessions = sqliteTable(
  "supersessions",
  {
    id: text("id").primaryKey(),
    priorRecordId: text("prior_record_id")
      .notNull()
      .references((): any => records.id, { onDelete: "cascade" }),
    replacementRecordId: text("replacement_record_id")
      .notNull()
      .references((): any => records.id, { onDelete: "cascade" }),
    jobId: text("job_id").references((): any => importJobs.id, { onDelete: "set null" }),
    reason: text("reason").notNull(),
    confirmedAt: text("confirmed_at"),
    confirmedBy: text("confirmed_by"),
    proposedAt: text("proposed_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_supersession_pair").on(t.priorRecordId, t.replacementRecordId),
    index("ix_supersessions_job").on(t.jobId),
  ],
);

export const conflicts = sqliteTable(
  "conflicts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references((): any => projects.id, { onDelete: "set null" }),
    recordIdsJson: text("record_ids_json").notNull(),
    status: text("status").notNull().default("unresolved"), // none|unresolved|resolved
    resolutionRecordId: text("resolution_record_id").references((): any => records.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("ix_conflicts_project").on(t.projectId)],
);

export const handoffs = sqliteTable("handoffs", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references((): any => projects.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
  sourceRevision: integer("source_revision").notNull(),
  sourceContentVersion: integer("source_content_version").notNull().default(0),
  objective: text("objective"),
  renderedMarkdown: text("rendered_markdown").notNull(),
  includedRecordIdsJson: text("included_record_ids_json").notNull(),
  truncationNotesJson: text("truncation_notes_json").notNull().default("[]"),
});

export const contextCursorSnapshots = sqliteTable(
  "context_cursor_snapshots",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(), // canonical | working
    cursor: integer("cursor").notNull(),
    projectRevision: integer("project_revision").notNull(),
    manifestJson: text("manifest_json").notNull(),
    baseline: integer("baseline").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.scope, t.cursor] }),
    index("ix_context_cursor_snapshots_project_scope").on(t.projectId, t.scope, t.cursor),
  ],
);

export const contextDeltaSessions = sqliteTable(
  "context_delta_sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fromCanonicalCursor: integer("from_canonical_cursor").notNull(),
    fromWorkingCursor: integer("from_working_cursor").notNull(),
    fromProjectRevision: integer("from_project_revision").notNull(),
    targetCanonicalCursor: integer("target_canonical_cursor").notNull(),
    targetWorkingCursor: integer("target_working_cursor").notNull(),
    targetProjectRevision: integer("target_project_revision").notNull(),
    requestKey: text("request_key"),
    changesJson: text("changes_json").notNull(),
    projectJson: text("project_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("ix_context_delta_sessions_project").on(t.projectId, t.createdAt),
    uniqueIndex("uq_context_delta_sessions_request").on(t.projectId, t.requestKey),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    timestamp: text("timestamp").notNull(),
    /** A15: before/after references stored as JSON snapshots. */
    beforeRef: text("before_ref"),
    afterRef: text("after_ref"),
    detailJson: text("detail_json"),
    requestId: text("request_id"),
  },
  (t) => [
    index("ix_audit_action").on(t.action),
    index("ix_audit_timestamp").on(t.timestamp),
    index("ix_audit_target").on(t.targetType, t.targetId),
  ],
);

/** A17: application schema version — startup refuses a newer-version store. */
export const schemaVersion = sqliteTable("schema_version", {
  version: integer("version").primaryKey(),
  appliedAt: text("applied_at").notNull(),
  appVersion: text("app_version").notNull(),
});

export const ownerCredentials = sqliteTable("owner_credentials", {
  id: integer("id").primaryKey(), // always 1 (single-user, owner-only)
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    csrfToken: text("csrf_token").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (t) => [index("ix_sessions_expires").on(t.expiresAt)],
);

/**
 * F07: durable server-side idempotency for offline / retryable mutations.
 *
 * The `key` column is the Idempotency-Key header value supplied by the client
 * before the first send. Its uniqueness is the concurrency authority that
 * protects every replayable mutation from being executed a second time
 * because of response loss, cross-tab replay, or process restart.
 *
 * State transitions:
 *   pending      -> completed   (handler succeeded with status < 500)
 *   pending      -> indeterminate (handler failed with status >= 500, OR the
 *                                  previous process died before finalization,
 *                                  see recoverInterruptedIdempotencyClaims)
 *   completed    -> (terminal; replay returns the stored response)
 *   indeterminate -> (terminal; any retry must surface the unknown outcome)
 *
 * `request_hash` is sha256 over method + canonical URL + canonical JSON body
 * so a reused key with a different request yields `idempotency_key_reused`
 * instead of a confused replay.
 *
 * Raw request bodies, passwords, cookies, CSRF tokens, session ids, and auth
 * headers are NEVER stored here; only the request fingerprint plus the
 * minimum response material needed for safe replay.
 */
export const idempotencyRequests = sqliteTable(
  "idempotency_requests",
  {
    key: text("key").primaryKey(),
    method: text("method").notNull(),
    url: text("url").notNull(),
    requestHash: text("request_hash").notNull(),
    state: text("state").notNull(),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    responseContentType: text("response_content_type"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("ix_idempotency_state_updated").on(t.state, t.updatedAt)],
);
