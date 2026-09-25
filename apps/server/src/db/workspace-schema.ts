import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projects, sources } from "./schema.js";

/**
 * Observational registry of server workspaces. A binding is NOT a lifecycle
 * assertion: projectId is set only by an explicit owner action.
 */
export const workspaceBindings = sqliteTable(
  "workspace_bindings",
  {
    id: text("id").primaryKey(),
    canonicalKey: text("canonical_key").notNull(),
    canonicalPath: text("canonical_path").notNull(),
    displayName: text("display_name").notNull(),
    gitRemote: text("git_remote"),
    gitBranch: text("git_branch"),
    gitHeadSha: text("git_head_sha"),
    lastGitActivity: text("last_git_activity"),
    lastObservedActivity: text("last_observed_activity"),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    ignored: integer("ignored").notNull().default(0),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_workspace_canonical_key").on(t.canonicalKey),
    index("ix_workspace_project").on(t.projectId),
    index("ix_workspace_activity").on(t.lastObservedActivity),
  ],
);

/**
 * Connector provenance for ContextKeep sources. Multiple external artifacts
 * may legitimately collapse to one immutable ContextKeep source when their
 * sanitized text is byte-identical, so sourceId is indexed but not unique.
 */
export const sourceOrigins = sqliteTable(
  "source_origins",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    connector: text("connector").notNull(), // codex | dsh
    externalId: text("external_id").notNull(),
    externalPart: text("external_part").notNull().default("full"),
    externalRevision: text("external_revision"),
    externalHash: text("external_hash"),
    workspaceBindingId: text("workspace_binding_id").references(() => workspaceBindings.id, {
      onDelete: "set null",
    }),
    archiveState: text("archive_state").notNull().default("unknown"), // current|archived|unknown
    externalUpdatedAt: text("external_updated_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_source_origin_external_part").on(t.connector, t.externalId, t.externalPart),
    index("ix_source_origin_source").on(t.sourceId),
    index("ix_source_origin_workspace").on(t.workspaceBindingId),
  ],
);
