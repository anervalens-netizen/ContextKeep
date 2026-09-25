import { RETRY_OFFLINE_QUEUE_EVENT } from "../idempotency-key.js";

/**
 * F07 single-flight retry scheduler (this remediation): the only place that
 * owns a retry-after-delay timer for the offline queue. apiFetch (5xx, 429,
 * body-read failure) and the existing idempotency_in_progress path both go
 * through this module so they share ONE timer and never form overlapping
 * parallel fetches.
 *
 * The timer fires the neutral `ck:retry-offline-queue` event, which main.tsx
 * already listens for. main.tsx's listener calls `syncAfterReconnect()` →
 * `replayQueue()`. This indirection keeps the queue-replay code in main.tsx
 * (where it already lives) and lets the scheduler stay pure (no imports of
 * main.tsx → no circular imports).
 */

export const MAX_AUTOMATIC_RETRY_ATTEMPTS = 3;
export const AUTOMATIC_RETRY_BASE_MS = 750;

let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
const retryAttempts = new Map<string, number>();

export interface RetryScheduleOptions {
  /**
   * Stable logical mutation identity. When provided, automatic retry is
   * bounded across timer firings for this same idempotency key.
   */
  budgetKey?: string;
  /** Lease-wait scheduling does not represent another transport attempt. */
  consumeBudget?: boolean;
}

export interface RetryScheduleResult {
  scheduled: boolean;
  attempt: number;
  exhausted: boolean;
  delayMs: number;
}

function clearPendingRetry(): void {
  if (pendingRetryTimer !== null) {
    clearTimeout(pendingRetryTimer);
    pendingRetryTimer = null;
  }
}

function fireRetryEvent(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(RETRY_OFFLINE_QUEUE_EVENT));
  } catch {
    /* swallow — best-effort dispatch */
  }
}

/**
 * Schedule exactly ONE retry attempt after `delayMs`. Any prior pending
 * timer is replaced — there is never more than one in flight. When the
 * browser is offline we drop the timer (no point retrying).
 */
export function scheduleOfflineRetry(
  delayMs: number,
  opts: RetryScheduleOptions = {},
): RetryScheduleResult {
  clearPendingRetry();

  const consumeBudget = opts.consumeBudget ?? true;
  let attempt = 0;
  if (opts.budgetKey) {
    attempt = retryAttempts.get(opts.budgetKey) ?? 0;
    if (consumeBudget) attempt += 1;
    if (attempt > MAX_AUTOMATIC_RETRY_ATTEMPTS) {
      return { scheduled: false, attempt, exhausted: true, delayMs: 0 };
    }
    if (consumeBudget) retryAttempts.set(opts.budgetKey, attempt);
  }

  const backoffFloor =
    opts.budgetKey && consumeBudget
      ? AUTOMATIC_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1)
      : 0;
  const clamped = Math.max(0, Math.min(Math.max(delayMs, backoffFloor), 60_000));

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { scheduled: false, attempt, exhausted: false, delayMs: clamped };
  }
  if (clamped <= 0) {
    fireRetryEvent();
    return { scheduled: true, attempt, exhausted: false, delayMs: 0 };
  }
  pendingRetryTimer = setTimeout(() => {
    pendingRetryTimer = null;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    fireRetryEvent();
  }, clamped);
  return { scheduled: true, attempt, exhausted: false, delayMs: clamped };
}

/** Clear any pending retry timer (called on `offline` / navigation away). */
export function cancelOfflineRetry(): void {
  clearPendingRetry();
}

/** Reset retry accounting once a logical mutation is reconciled or abandoned. */
export function resetOfflineRetryBudget(budgetKey?: string): void {
  if (budgetKey) retryAttempts.delete(budgetKey);
  else retryAttempts.clear();
}

/** Diagnostic/test helper for the bounded automatic retry budget. */
export function getOfflineRetryAttempt(budgetKey: string): number {
  return retryAttempts.get(budgetKey) ?? 0;
}

/** Test-only helper: returns true iff a retry timer is currently armed. */
export function hasPendingOfflineRetry(): boolean {
  return pendingRetryTimer !== null;
}
