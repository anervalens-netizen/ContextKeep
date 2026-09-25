import type { AppConfig } from "../config.js";
import { parseWorkingCheckpoint } from "./checkpoint.js";
import { blockerIdFor } from "./blockers.js";
import { deleteRecord } from "./memory-management.js";
import type { ActorCtx, ServiceDeps } from "./import.js";

export interface HousekeepingResult {
  checkedAt: string;
  proposalRetentionDays: number;
  checkedProposals: number;
  archivedProposals: number;
  archivedRecordIds: string[];
  skippedProposals: number;
  skipped: Array<{ recordId: string; reason: string }>;
  errors: Array<{ recordId: string; code: string; message: string }>;
  status: "ok" | "partial";
  overdueAccepted: number;
  superseded: number;
  rejected: number;
}

type CandidateRow = {
  id: string;
  revision: number;
  projectId: string | null;
  taskStatus: string | null;
  predicate: string | null;
  valueJson: string | null;
  createdAt: string;
};

function usefulCheckpoint(
  row: Pick<CandidateRow, "id" | "revision" | "valueJson">,
  resolvedBlockerIds: Set<string>,
): boolean {
  const checkpoint = parseWorkingCheckpoint(row.valueJson);
  if (!checkpoint) return false;
  const hasUnresolvedBlocker = checkpoint.blockers.some(
    (_blocker, index) => !resolvedBlockerIds.has(blockerIdFor(row.id, row.revision, index)),
  );
  return Boolean(checkpoint.summary || checkpoint.nextAction || hasUnresolvedBlocker || checkpoint.artifactRefs.length);
}

function explicitResolvedBlockerIds(deps: ServiceDeps): Set<string> {
  const rows = deps.sqlite.prepare(`
    SELECT value_json AS valueJson
    FROM records
    WHERE predicate='blocker_resolution'
      AND review_status IN ('proposed','accepted')
      AND value_json IS NOT NULL
      AND json_valid(value_json)=1
      AND json_extract(value_json, '$.kind')='blocker_resolution'
  `).all() as Array<{ valueJson: string }>;
  const out = new Set<string>();
  for (const row of rows) {
    try {
      const value = JSON.parse(row.valueJson) as Record<string, unknown>;
      if (typeof value.blockerId === "string") out.add(value.blockerId);
    } catch {
      // Malformed historical metadata is not an active resolution.
    }
  }
  return out;
}

function count(deps: ServiceDeps, sql: string, ...params: unknown[]): number {
  return (deps.sqlite.prepare(sql).get(...params) as { n: number }).n;
}

/**
 * Safe proposal housekeeping.
 *
 * - accepted truth and owner declarations are never auto-archived;
 * - lifecycle proposals are explicitly skipped because lifecycle mutation has
 *   its own transition workflow;
 * - the newest useful checkpoint is protected per project across the entire
 *   proposal set, not only the aged batch;
 * - each recoverable archive failure is reported and does not abort the rest
 *   of the batch.
 */
export function runMemoryHousekeeping(
  deps: ServiceDeps,
  config: Pick<AppConfig, "housekeepingProposalRetentionDays">,
  ctx: ActorCtx = { actor: "system:housekeeping", requestId: null },
  nowMs = Date.now(),
): HousekeepingResult {
  const checkedAt = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - config.housekeepingProposalRetentionDays * 86_400_000).toISOString();

  const explicitlyResolvedBlockers = explicitResolvedBlockerIds(deps);
  const latestUsefulByProject = new Map<string, string>();
  const allCheckpointRows = deps.sqlite.prepare(`
    SELECT id, revision, project_id AS projectId, task_status AS taskStatus,
           predicate, value_json AS valueJson, created_at AS createdAt
    FROM records
    WHERE review_status='proposed'
      AND evidence_basis<>'owner_declaration'
      AND value_json IS NOT NULL
    ORDER BY created_at DESC, id DESC
  `).all() as CandidateRow[];
  for (const row of allCheckpointRows) {
    if (!row.projectId || latestUsefulByProject.has(row.projectId) || !usefulCheckpoint(row, explicitlyResolvedBlockers)) continue;
    latestUsefulByProject.set(row.projectId, row.id);
  }

  const archivedRecordIds: string[] = [];
  const skipped: Array<{ recordId: string; reason: string }> = [];
  const errors: Array<{ recordId: string; code: string; message: string }> = [];
  let checkedProposals = 0;
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;

  // Scan aged proposals with a stable keyset cursor. Protected/skipped rows are
  // not removed, so OFFSET/LIMIT alone could revisit the same first 5,000
  // forever and starve later eligible proposals.
  for (;;) {
    const page = (cursorCreatedAt === null
      ? deps.sqlite.prepare(`
          SELECT id, revision, project_id AS projectId, task_status AS taskStatus,
                 predicate, value_json AS valueJson, created_at AS createdAt
          FROM records
          WHERE review_status='proposed'
            AND evidence_basis<>'owner_declaration'
            AND created_at < ?
          ORDER BY created_at ASC, id ASC
          LIMIT 5000
        `).all(cutoff)
      : deps.sqlite.prepare(`
          SELECT id, revision, project_id AS projectId, task_status AS taskStatus,
                 predicate, value_json AS valueJson, created_at AS createdAt
          FROM records
          WHERE review_status='proposed'
            AND evidence_basis<>'owner_declaration'
            AND created_at < ?
            AND (created_at > ? OR (created_at = ? AND id > ?))
          ORDER BY created_at ASC, id ASC
          LIMIT 5000
        `).all(cutoff, cursorCreatedAt, cursorCreatedAt, cursorId)) as CandidateRow[];

    if (page.length === 0) break;
    checkedProposals += page.length;

    for (const row of page) {
      const checkpoint = parseWorkingCheckpoint(row.valueJson);
      const hasBlocker = row.taskStatus === "blocked" || Boolean(checkpoint?.blockers.some(
        (_blocker, index) => !explicitlyResolvedBlockers.has(blockerIdFor(row.id, row.revision, index)),
      ));
      if (row.predicate === "blocker_resolution") {
        skipped.push({ recordId: row.id, reason: "blocker_resolution_history" });
        continue;
      }
      if (row.predicate === "lifecycle") {
        skipped.push({ recordId: row.id, reason: "lifecycle_requires_transition" });
        continue;
      }
      if (hasBlocker) {
        skipped.push({ recordId: row.id, reason: "unresolved_blocker" });
        continue;
      }
      if (row.projectId && latestUsefulByProject.get(row.projectId) === row.id) {
        skipped.push({ recordId: row.id, reason: "latest_useful_checkpoint" });
        continue;
      }
      try {
        deleteRecord(deps, {
          recordId: row.id,
          revision: row.revision,
          reason: `Automatic housekeeping: proposal remained unreviewed for more than ${config.housekeepingProposalRetentionDays} days.`,
        }, ctx);
        archivedRecordIds.push(row.id);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : "housekeeping_archive_failed";
        errors.push({
          recordId: row.id,
          code,
          message: error instanceof Error ? error.message : "Housekeeping archive failed.",
        });
      }
    }

    const last = page[page.length - 1]!;
    cursorCreatedAt = last.createdAt;
    cursorId = last.id;
    if (page.length < 5000) break;
  }

  return {
    checkedAt,
    proposalRetentionDays: config.housekeepingProposalRetentionDays,
    checkedProposals,
    archivedProposals: archivedRecordIds.length,
    archivedRecordIds,
    skippedProposals: skipped.length,
    skipped,
    errors,
    status: errors.length ? "partial" : "ok",
    overdueAccepted: count(
      deps,
      "SELECT count(*) AS n FROM records WHERE review_status='accepted' AND volatile=1 AND review_due_at IS NOT NULL AND review_due_at < ?",
      checkedAt,
    ),
    superseded: count(deps, "SELECT count(*) AS n FROM records WHERE review_status='superseded'"),
    rejected: count(deps, "SELECT count(*) AS n FROM records WHERE review_status='rejected'"),
  };
}

export class HousekeepingCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private lastResult: HousekeepingResult | null = null;
  private lastError: string | null = null;

  constructor(private readonly deps: ServiceDeps, private readonly config: AppConfig) {}

  private runScheduled(): void {
    try {
      this.lastResult = runMemoryHousekeeping(this.deps, this.config);
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Housekeeping failed.";
    }
  }

  start(): void {
    if (this.config.housekeepingIntervalMinutes <= 0 || this.timer) return;
    queueMicrotask(() => this.runScheduled());
    this.timer = setInterval(() => this.runScheduled(), this.config.housekeepingIntervalMinutes * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  run(nowMs = Date.now()): HousekeepingResult {
    this.lastResult = runMemoryHousekeeping(this.deps, this.config, undefined, nowMs);
    this.lastError = null;
    return this.lastResult;
  }

  status(): { enabled: boolean; intervalMinutes: number; lastResult: HousekeepingResult | null; lastError: string | null } {
    return {
      enabled: this.config.housekeepingIntervalMinutes > 0,
      intervalMinutes: this.config.housekeepingIntervalMinutes,
      lastResult: this.lastResult,
      lastError: this.lastError,
    };
  }
}
