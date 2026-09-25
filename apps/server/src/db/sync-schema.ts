import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { importJobs, projects, sources } from "./schema.js";

/** M3.4: idempotent extraction state for an immutable source + target project. */
export const sourceExtractions = sqliteTable(
  "source_extractions",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    /** SQLite UNIQUE treats NULLs as distinct, so keep an explicit stable key. */
    projectKey: text("project_key").notNull(),
    adapterId: text("adapter_id").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    stage: text("stage").notNull(), // pending | done | failed
    attempts: integer("attempts").notNull().default(0),
    lastJobId: text("last_job_id").references(() => importJobs.id, { onDelete: "set null" }),
    lastErrorCode: text("last_error_code"),
    preflightUsageJson: text("preflight_usage_json"),
    actualUsageJson: text("actual_usage_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_source_extraction_target").on(
      t.sourceId,
      t.projectKey,
      t.adapterId,
      t.adapterVersion,
    ),
    index("ix_source_extractions_source").on(t.sourceId),
    index("ix_source_extractions_stage").on(t.stage),
  ],
);

/** M3.4: tiny persisted health snapshot; no raw source or provider content. */
export const connectorSyncState = sqliteTable("connector_sync_state", {
  connector: text("connector").primaryKey(), // codex | dsh
  lastScanAt: text("last_scan_at"),
  lastSuccessAt: text("last_success_at"),
  lastError: text("last_error"),
  lastResultJson: text("last_result_json"),
  updatedAt: text("updated_at").notNull(),
});

/** L4.1: durable sync/backfill run state. Progress survives process restart. */
export const syncJobs = sqliteTable(
  "sync_jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    connector: text("connector").notNull(),
    mode: text("mode").notNull(),
    inputJson: text("input_json").notNull(),
    stage: text("stage").notNull(), // running | completed | completed_with_errors | failed | interrupted
    selected: integer("selected").notNull().default(0),
    completed: integer("completed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    currentKey: text("current_key"),
    resultJson: text("result_json"),
    lastError: text("last_error"),
    startedAt: text("started_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => [index("ix_sync_jobs_stage_updated").on(t.stage, t.updatedAt), index("ix_sync_jobs_project_updated").on(t.projectId, t.updatedAt)],
);
