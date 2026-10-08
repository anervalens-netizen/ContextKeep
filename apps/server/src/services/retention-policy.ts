import type { ServiceDeps } from "./import.js";

export const RETENTION_POLICY_VERSION = "operational-retention-v1";
export const RETENTION_COLUMNS = `id, revision, type, review_status AS reviewStatus,
  evidence_basis AS evidenceBasis, project_id AS projectId, task_status AS taskStatus,
  predicate, value_json AS valueJson, created_at AS createdAt`;

export interface RetentionCandidate {
  id: string;
  revision: number;
  type: string;
  reviewStatus: string;
  evidenceBasis: string;
  projectId: string | null;
  taskStatus: string | null;
  predicate: string | null;
  valueJson: string | null;
  createdAt: string;
}
type ReadDeps = Pick<ServiceDeps, "sqlite">;
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';

/** Inspect every workflow record/task reference, including historical receipts.
 * Schema-derived columns prevent newly added workflow tables from silently
 * becoming retention-blind. Values and identifiers never come from a client. */
export function createRetentionPolicy(deps: ReadDeps, cutoff: string) {
  const tables = deps.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'workflow_*'",
    )
    .all() as Array<{ name: string }>;
  const references = tables.flatMap(({ name }) => {
    const columns = deps.sqlite
      .prepare(`PRAGMA table_info(${quote(name)})`)
      .all() as Array<{ name: string }>;
    return columns
      .filter((c) => /(?:^|_)(?:record|task)_id$/.test(c.name))
      .map((c) =>
        deps.sqlite.prepare(
          `SELECT 1 FROM ${quote(name)} WHERE ${quote(c.name)}=? LIMIT 1`,
        ),
      );
  });
  return (row: RetentionCandidate): string | null => {
    if (row.reviewStatus !== "proposed") return "not_proposed";
    if (row.evidenceBasis === "owner_declaration") return "owner_declaration";
    if (row.createdAt >= cutoff) return "retention_window";
    if (row.type === "action") return "task_identity";
    if (row.predicate === "lifecycle") return "lifecycle_requires_transition";
    if (row.predicate === "blocker_resolution")
      return "blocker_resolution_history";
    if (row.taskStatus !== null) return "task_state";
    // Includes current and historical progress, checkpoints, handoffs, policies,
    // relations and malformed/unknown metadata. Compaction is a separate policy.
    if (row.valueJson !== null || row.predicate !== null)
      return "structured_memory";
    if (references.some((statement) => statement.get(row.id)))
      return "workflow_reference";
    return null;
  };
}

export function retentionCutoff(days: number, nowMs: number): string {
  if (!Number.isInteger(days) || days < 1 || !Number.isFinite(nowMs))
    throw new Error(
      "Retention requires positive whole days and a valid observation time.",
    );
  return new Date(nowMs - days * 86_400_000).toISOString();
}

export function previewMemoryHousekeeping(
  deps: ReadDeps,
  config: { housekeepingProposalRetentionDays: number },
  options: { nowMs?: number; limit?: number; cursor?: string } = {},
) {
  const days = config.housekeepingProposalRetentionDays;
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("Preview limit must be between 1 and 500.");
  let cutoff = retentionCutoff(days, options.nowMs ?? Date.now());
  let position: { createdAt: string; id: string } | null = null;
  if (options.cursor) {
    try {
      if (options.cursor.length > 2048) throw new Error();
      const c = JSON.parse(
        Buffer.from(options.cursor, "base64url").toString("utf8"),
      );
      if (
        c.policy !== RETENTION_POLICY_VERSION ||
        c.days !== days ||
        typeof c.cutoff !== "string" ||
        new Date(c.cutoff).toISOString() !== c.cutoff ||
        typeof c.createdAt !== "string" ||
        new Date(c.createdAt).toISOString() !== c.createdAt ||
        typeof c.id !== "string" ||
        c.id.length < 1 ||
        c.id.length > 128
      )
        throw new Error();
      cutoff = c.cutoff;
      position = { createdAt: c.createdAt, id: c.id };
    } catch {
      throw new Error("Invalid or incompatible retention preview cursor.");
    }
  }
  // A page is a consistent read; subsequent pages retain the cutoff, but report
  // current revisions. It is deliberately not an authorization to delete later.
  return deps.sqlite.transaction(() => {
    const rows = deps.sqlite
      .prepare(
        `SELECT ${RETENTION_COLUMNS} FROM records
      WHERE review_status='proposed' AND evidence_basis<>'owner_declaration' AND created_at<?
      ${position ? "AND (created_at>? OR (created_at=? AND id>?))" : ""}
      ORDER BY created_at,id LIMIT ?`,
      )
      .all(
        ...(position
          ? [
              cutoff,
              position.createdAt,
              position.createdAt,
              position.id,
              limit + 1,
            ]
          : [cutoff, limit + 1]),
      ) as RetentionCandidate[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const classify = createRetentionPolicy(deps, cutoff);
    const items = page.map((row) => {
      const reason = classify(row);
      return {
        recordId: row.id,
        revision: row.revision,
        projectId: row.projectId,
        disposition: reason ? ("retain" as const) : ("archive" as const),
        reason: reason ?? "aged_generic_proposal",
      };
    });
    const reasonCounts: Record<string, number> = {};
    for (const item of items)
      reasonCounts[item.reason] = (reasonCounts[item.reason] ?? 0) + 1;
    const last = page.at(-1);
    return {
      policyVersion: RETENTION_POLICY_VERSION,
      cutoff,
      proposalRetentionDays: days,
      items,
      pageSummary: {
        checked: items.length,
        archive: items.filter((i) => i.disposition === "archive").length,
        reasonCounts,
      },
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({
                policy: RETENTION_POLICY_VERSION,
                days,
                cutoff,
                createdAt: last.createdAt,
                id: last.id,
              }),
            ).toString("base64url")
          : null,
      semantics:
        "Read-only page; counts are page-local. Apply rechecks current revision and references.",
    };
  })();
}
