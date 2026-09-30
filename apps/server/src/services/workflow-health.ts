import type { ServiceDeps } from "./import.js";

/** Task-scoped operational metadata only: no callback addresses, secrets, or raw output. */
export function workflowHealth(deps: ServiceDeps, taskId: string) {
  const now = new Date().toISOString();
  const totals = deps.sqlite
    .prepare(
      `SELECT
    COALESCE(SUM(CASE WHEN d.status IN ('pending','sending') THEN 1 ELSE 0 END),0) AS pendingDeliveries,
    COALESCE(SUM(CASE WHEN d.status='failed' THEN 1 ELSE 0 END),0) AS failedDeliveries,
    MIN(CASE WHEN d.status IN ('pending','sending') THEN e.created_at END) AS oldestPendingAt
    FROM workflow_events e JOIN workflow_deliveries d ON d.event_id=e.id WHERE e.task_id=?`,
    )
    .get(taskId) as {
    pendingDeliveries: number;
    failedDeliveries: number;
    oldestPendingAt: string | null;
  };
  const lastDelivery = deps.sqlite
    .prepare(
      `SELECT d.status,d.attempts,d.http_status AS httpStatus,
    e.created_at AS eventCreatedAt,CASE WHEN d.status='pending' THEN d.next_at END AS nextAttemptAt
    FROM workflow_events e JOIN workflow_deliveries d ON d.event_id=e.id WHERE e.task_id=?
    ORDER BY e.sequence DESC,d.id DESC LIMIT 1`,
    )
    .get(taskId) as
    | {
        status: string;
        attempts: number;
        httpStatus: number | null;
        eventCreatedAt: string;
        nextAttemptAt: string | null;
      }
    | undefined;
  const abandoned = deps.sqlite
    .prepare(
      `SELECT count(*) AS n FROM workflow_continuations
    WHERE task_id=? AND status='claimed' AND lease_until<=?`,
    )
    .get(taskId, now) as { n: number };
  return {
    ...totals,
    lastDelivery: lastDelivery ?? null,
    reconciliationNeeded: abandoned.n,
  };
}
