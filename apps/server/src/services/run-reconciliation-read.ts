import type { ServiceDeps } from "./import.js";

/** Immutable audit receipt, independent of later edits/review of the supporting report. */
export function runReconciliation(deps: ServiceDeps, runId: string) {
  const row = deps.sqlite.prepare(`SELECT id,actor,timestamp,after_ref AS value
    FROM audit_events WHERE target_type='workflow_run' AND target_id=?
    AND action='run.reconciled' ORDER BY timestamp DESC,id DESC LIMIT 1`).get(runId) as
    { id: string; actor: string; timestamp: string; value: string } | undefined;
  if (!row) return null;
  const value = JSON.parse(row.value) as {
    disposition: "attached" | "not_started" | "lost";
    evidenceRecordId: string;
    revision: number;
    externalJobId: string | null;
  };
  return { auditId: row.id, actor: row.actor, recordedAt: row.timestamp,
    disposition: value.disposition, evidenceRecordId: value.evidenceRecordId,
    revision: value.revision, externalJobId: value.externalJobId,
    authority: "caller_reported_reconciliation" as const };
}
