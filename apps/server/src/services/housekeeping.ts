import type { AppConfig } from "../config.js";
import {
  createRetentionPolicy,
  RETENTION_COLUMNS,
  retentionCutoff,
  type RetentionCandidate,
} from "./retention-policy.js";
export { previewMemoryHousekeeping } from "./retention-policy.js";
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

function count(deps: ServiceDeps, sql: string, ...params: unknown[]): number {
  return (deps.sqlite.prepare(sql).get(...params) as { n: number }).n;
}

/** Recoverable retention of generic proposals only; operational history never expires here. */
export function runMemoryHousekeeping(
  deps: ServiceDeps,
  config: Pick<AppConfig, "housekeepingProposalRetentionDays">,
  ctx: ActorCtx = { actor: "system:housekeeping", requestId: null },
  nowMs = Date.now(),
): HousekeepingResult {
  const checkedAt = new Date(nowMs).toISOString();
  const cutoff = retentionCutoff(
    config.housekeepingProposalRetentionDays,
    nowMs,
  );
  const classify = createRetentionPolicy(deps, cutoff);

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
    const page = (
      cursorCreatedAt === null
        ? deps.sqlite
            .prepare(
              `
          SELECT ${RETENTION_COLUMNS}
          FROM records
          WHERE review_status='proposed'
            AND evidence_basis<>'owner_declaration'
            AND created_at < ?
          ORDER BY created_at ASC, id ASC
          LIMIT 5000
        `,
            )
            .all(cutoff)
        : deps.sqlite
            .prepare(
              `
          SELECT ${RETENTION_COLUMNS}
          FROM records
          WHERE review_status='proposed'
            AND evidence_basis<>'owner_declaration'
            AND created_at < ?
            AND (created_at > ? OR (created_at = ? AND id > ?))
          ORDER BY created_at ASC, id ASC
          LIMIT 5000
        `,
            )
            .all(cutoff, cursorCreatedAt, cursorCreatedAt, cursorId)
    ) as RetentionCandidate[];

    if (page.length === 0) break;
    checkedProposals += page.length;

    for (const row of page) {
      try {
        // Recheck inside the write lock: a new workflow reference or revision
        // after candidate enumeration must never be archived from a stale page.
        const result = deps.sqlite
          .transaction(() => {
            const current = deps.sqlite
              .prepare(`SELECT ${RETENTION_COLUMNS} FROM records WHERE id=?`)
              .get(row.id) as RetentionCandidate | undefined;
            if (!current || current.revision !== row.revision)
              return "stale_candidate";
            const reason = classify(current);
            if (reason) return reason;
            deleteRecord(
              deps,
              {
                recordId: current.id,
                revision: current.revision,
                reason: `Automatic housekeeping: generic proposal remained unreviewed for more than ${config.housekeepingProposalRetentionDays} days.`,
              },
              ctx,
            );
            return null;
          })
          .immediate();
        if (result) skipped.push({ recordId: row.id, reason: result });
        else archivedRecordIds.push(row.id);
      } catch (error) {
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : "housekeeping_archive_failed";
        errors.push({
          recordId: row.id,
          code,
          message:
            error instanceof Error
              ? error.message
              : "Housekeeping archive failed.",
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
    superseded: count(
      deps,
      "SELECT count(*) AS n FROM records WHERE review_status='superseded'",
    ),
    rejected: count(
      deps,
      "SELECT count(*) AS n FROM records WHERE review_status='rejected'",
    ),
  };
}

export class HousekeepingCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private lastResult: HousekeepingResult | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly deps: ServiceDeps,
    private readonly config: AppConfig,
  ) {}

  private runScheduled(): void {
    try {
      this.lastResult = runMemoryHousekeeping(this.deps, this.config);
      this.lastError = null;
    } catch (error) {
      this.lastError =
        error instanceof Error ? error.message : "Housekeeping failed.";
    }
  }

  start(): void {
    if (this.config.housekeepingIntervalMinutes <= 0 || this.timer) return;
    queueMicrotask(() => this.runScheduled());
    this.timer = setInterval(
      () => this.runScheduled(),
      this.config.housekeepingIntervalMinutes * 60_000,
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  run(nowMs = Date.now()): HousekeepingResult {
    this.lastResult = runMemoryHousekeeping(
      this.deps,
      this.config,
      undefined,
      nowMs,
    );
    this.lastError = null;
    return this.lastResult;
  }

  status(): {
    enabled: boolean;
    intervalMinutes: number;
    lastResult: HousekeepingResult | null;
    lastError: string | null;
  } {
    return {
      enabled: this.config.housekeepingIntervalMinutes > 0,
      intervalMinutes: this.config.housekeepingIntervalMinutes,
      lastResult: this.lastResult,
      lastError: this.lastError,
    };
  }
}
