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
  const archivedRecordIds: string[] = [];
  const skipped: Array<{ recordId: string; reason: string }> = [];
  const errors: Array<{ recordId: string; code: string; message: string }> = [];
  let checkedProposals = 0;
  let position: { createdAt: string; id: string } | null = null;
  for (;;) {
    // Protected rows remain present, so advance by key rather than OFFSET.
    const page = deps.sqlite
      .prepare(
        `SELECT ${RETENTION_COLUMNS} FROM records
      WHERE review_status='proposed' AND evidence_basis<>'owner_declaration' AND created_at<?
      ${position ? "AND (created_at>? OR (created_at=? AND id>?))" : ""}
      ORDER BY created_at,id LIMIT 5000`,
      )
      .all(
        ...(position
          ? [cutoff, position.createdAt, position.createdAt, position.id]
          : [cutoff]),
      ) as RetentionCandidate[];
    if (!page.length) break;
    checkedProposals += page.length;
    // Read references once per bounded page AFTER acquiring the write lock.
    // No other writer can add a reference between this snapshot and archival.
    // Each archive has a savepoint so one failure does not abort the batch.
    deps.sqlite
      .transaction(() => {
        const classify = createRetentionPolicy(
          deps,
          cutoff,
          page.map((row) => row.id),
        );
        const currentRecord = deps.sqlite.prepare(
          `SELECT ${RETENTION_COLUMNS} FROM records WHERE id=?`,
        );
        for (const row of page) {
          try {
            const reason = deps.sqlite.transaction(() => {
              const current = currentRecord.get(row.id) as
                RetentionCandidate | undefined;
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
            })();
            if (reason) skipped.push({ recordId: row.id, reason });
            else archivedRecordIds.push(row.id);
          } catch (error) {
            const code =
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              typeof error.code === "string"
                ? error.code
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
      })
      .immediate();
    const last = page.at(-1)!;
    position = { createdAt: last.createdAt, id: last.id };
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
