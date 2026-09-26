import { parseRetryAfterMs, inboxDecisionNeedsFreshReview } from "./queue-policy.js";
export { parseRetryAfterMs } from "./queue-policy.js";
import { offlineDb, type ConflictEntry, type QueuedMutation } from "./db.js";
import { newIdempotencyKey } from "../idempotency-key.js";
import { resetOfflineRetryBudget, scheduleOfflineRetry } from "./scheduler.js";
import { createTransportGuard, type TransportAbortKind } from "../transport.js";
import { validateMutationAcknowledgement } from "../mutation-ack.js";
import {
  isDurableReconciliationBarrier,
  type DurableReconciliationCode,
} from "./barriers.js";

export { isDurableReconciliationBarrier } from "./barriers.js";

/**
 * A10: offline mutations are queued here and replayed in order on reconnect.
 *
 * F07 durable invariants enforced here:
 *
 *  1. Every newly enqueued row leaves `enqueueMutation` with a non-null
 *     `idempotencyKey` so the queue is never the weak link in the
 *     server-side PK concurrency authority.
 *  2. The legacy-row upgrade (rows persisted pre-F07) is performed inside a
 *     single READWRITE IndexedDB transaction so two browser tabs racing on
 *     the same legacy seq observe the same committed key, not two different
 *     ones.
 *  3. The "idempotency_outcome_unknown" branch produces a DURABLE barrier:
 *     the conflict row itself blocks subsequent replay invocations until the
 *     owner dismisses it. Replay is idempotent across reloads.
 *  4. "idempotency_in_progress" exposes a parsed `Retry-After`-driven
 *     `retryAfterMs` so a single module-level timer can retry the queue
 *     without timer storms.
 *  5. In-flight lease (this remediation): the active `apiFetch()` owner
 *     marks a row `deliveryState="in_flight"` with an opaque owner token
 *     and a renewable lease expiry. Replay MUST NOT fetch that row while
 *     the lease is valid; later rows behind it are NOT skipped — the whole
 *     replay stops with `stoppedReason="client_in_flight"`. An expired
 *     lease is atomically converted back to "queued" before the request is
 *     sent, keeping the SAME idempotency key.
 *  6. Owner-token safety (this remediation): every completion helper
 *     (`releaseMutationToQueue`, `completeOwnedMutation`) verifies the
 *     expected owner token inside the same READWRITE transaction that
 *     mutates the row. Stale `apiFetch()` invocations cannot accidentally
 *     delete / overwrite a row that a recovery / replay path has already
 *     taken over.
 *  7. Atomic move (this remediation): moving a row from `mutations` to
 *     `conflicts` is performed inside ONE IndexedDB readwrite transaction
 *     spanning both stores. A crash / abort between the two writes leaves
 *     no observable half-transition — the original mutation row survives.
 *  8. Replay 5xx finalization (this remediation): a queueable replay that
 *     receives HTTP 5xx releases the row back to queued (same key), sets
 *     `stoppedReason="server_indeterminate"`, and schedules a bounded
 *     SAME-KEY retry via the shared scheduler. A follow-up replay then
 *     surfaces as `409 idempotency_outcome_unknown` and moves the row
 *     into conflicts — the durable unknown-outcome barrier.
 *  9. Replay lease heartbeat (this remediation): replay claims start a
 *     lease-renewal heartbeat for the duration of the HTTP send so a
 *     long-running request never loses its lease to a competing tab.
 *     The heartbeat is cleared in `finally` on every terminal transition
 *     so no interval can outlive the loop iteration that started it.
 */

/**
 * F07 in-flight lease tunables. Conservative defaults: the lease lasts 30s
 * with a 10s heartbeat so imports / slow providers stay protected without
 * being needlessly expensive. Values exported for tests.
 */
export const IN_FLIGHT_LEASE_MS = 30_000;
export const IN_FLIGHT_HEARTBEAT_MS = 10_000;
/** CK-A07 durable cap: the fourth transport timeout remains queued without blind auto-retry. */
export const MAX_TRANSPORT_TIMEOUT_AUTO_RETRIES = 3;

/**
 * F07 replay: bounded default delay used after a queueable replay receives
 * HTTP 5xx. The server-side idempotency claim has already been finalized as
 * `indeterminate` by the time the 5xx response reaches the client, so a
 * short follow-up SAME-KEY request will normally surface as
 * `409 idempotency_outcome_unknown` and the row will be moved to conflicts.
 *
 * The delay is bounded so:
 *  - we do NOT busy-loop (no immediate re-fetch on the same call stack);
 *  - the shared scheduler remains the single timer (no second scheduler);
 *  - we stay compatible with `replayInFlight` (single-flight replay).
 */
export const DEFAULT_RESOLUTION_RETRY_MS = 750;

/**
 * Opaque owner token generator. We use `crypto.randomUUID` and fall back to
 * a Math.random hex blob for older test environments. The token only needs
 * to be unique within one IndexedDB; entropy beyond that is not security.
 */
export function newOwnerToken(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(8);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = "";
  for (let i = 0; i < 8; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return `owner-${s}`;
}

export async function enqueueMutation(
  m: Omit<QueuedMutation, "seq">,
): Promise<number> {
  const db = await offlineDb();
  // Guarantee every NEW row leaves this function with a durable key. The
  // caller may pass one through (replay path); if not, generate one HERE so
  // direct callers like the offline file-import path cannot accidentally
  // create keyless rows.
  const ensured: Omit<QueuedMutation, "seq"> = {
    ...m,
    idempotencyKey: m.idempotencyKey ?? newIdempotencyKey(),
  };
  return (await db.add("mutations", ensured)) as number;
}

/**
 * F07 atomic initial online stage (this remediation): persist the queued
 * mutation row ALREADY marked `deliveryState="in_flight"` with an opaque
 * owner token + renewable lease, in ONE IndexedDB write. The caller (the
 * apiFetch online path) mints the owner token BEFORE invoking this helper
 * so the row is born under the sender's ownership — there is no committed
 * intermediate `queued` state for a competing replay to grab.
 *
 * F07 atomic foreground barrier (this remediation): blocker inspection +
 * mutation creation happen inside ONE IndexedDB readwrite transaction
 * spanning both `mutations` and `conflicts` stores. If ANY persisted durable
 * reconciliation conflict has code `idempotency_outcome_unknown` or
 * `idempotency_result_expired`, the row is
 * persisted as queued (no lease, no owner) — the apiFetch path will see
 * that, will NOT call fetch, will NOT start a heartbeat, and will throw
 * `QueuedOfflineError(seq)` so the caller treats the operation as durably
 * queued behind the durable unknown-outcome barrier.
 *
 * Discriminated return:
 *   - `{ kind: "in_flight", seq, mutation, owner }` — the row is owned and
 *     the caller may proceed with the fetch under the same contract as
 *     before this remediation.
 *   - `{ kind: "blocked_by_unknown_outcome", code, seq, mutation }` — a barrier
 *     conflict was present; the row is queued behind it, no lease, no
 *     owner, no fetch.
 *
 * The transaction commit is the authority: no observable intermediate
 * "checked conflicts, will write soon" state is ever visible.
 *
 * The offline path keeps using `enqueueMutation` (queued) — no lease is
 * minted when no network call is about to happen.
 */
export type StageResult =
  | { kind: "in_flight"; seq: number; mutation: QueuedMutation; owner: string }
  | { kind: "blocked_by_unknown_outcome"; code: DurableReconciliationCode; seq: number; mutation: QueuedMutation };

export async function stageOwnedInFlightMutation(
  m: Omit<
    QueuedMutation,
    "seq" | "deliveryState" | "inFlightOwner" | "inFlightGeneration" | "inFlightUntil"
  >,
  owner: string,
  leaseMs: number = IN_FLIGHT_LEASE_MS,
): Promise<StageResult> {
  const db = await offlineDb();
  const ensuredKey = m.idempotencyKey ?? newIdempotencyKey();
  const tx = db.transaction(["mutations", "conflicts"], "readwrite");
  const mStore = tx.objectStore("mutations");
  const cStore = tx.objectStore("conflicts");
  try {
    // F07 atomic foreground barrier (this remediation): inspect conflicts
    // and create the row inside ONE readwrite transaction. There is no
    // observable "checked, no row yet" intermediate — a competing
    // operation observes either the prior state (no row + the blocker is
    // present) or the new state (row queued behind the blocker), never a
    // half-applied one.
    const allConflicts = (await cStore.getAll()) as ConflictEntry[];
    const blocker = allConflicts.find((c) => isDurableReconciliationBarrier(c.code));
    if (blocker) {
      const code = isDurableReconciliationBarrier(blocker.code)
        ? blocker.code
        : "idempotency_outcome_unknown";
      const queued: Omit<QueuedMutation, "seq"> = {
        ...m,
        idempotencyKey: ensuredKey,
        deliveryState: "queued",
        inFlightOwner: undefined,
        inFlightUntil: undefined,
      };
      const seq = (await mStore.add(queued)) as number;
      const stamped: QueuedMutation = { ...queued, seq };
      await tx.done;
      return { kind: "blocked_by_unknown_outcome", code, seq, mutation: stamped };
    }
    // No blocker. Persist the row ALREADY marked `in_flight` with the
    // supplied owner + lease. Generation starts at 1 and is incremented on
    // every later claim/takeover. There is still no committed queued gap.
    const ensured: Omit<QueuedMutation, "seq"> = {
      ...m,
      idempotencyKey: ensuredKey,
      deliveryState: "in_flight",
      inFlightOwner: owner,
      inFlightGeneration: 1,
      inFlightUntil: new Date(Date.now() + leaseMs).toISOString(),
    };
    const seq = (await mStore.add(ensured)) as number;
    const stamped: QueuedMutation = { ...ensured, seq };
    await tx.done;
    return { kind: "in_flight", seq, mutation: stamped, owner };
  } catch {
    try {
      await tx.done.catch(() => undefined);
    } catch {
      /* swallow */
    }
    throw new Error(`stageOwnedInFlightMutation failed`);
  }
}

/**
 * Atomic legacy-row key upgrade.
 *
 * Uses a single READWRITE transaction on the `mutations` store. A second
 * caller (e.g. another tab) issuing the same `seq` in a parallel
 * transaction observes the committed key instead of generating its own.
 *
 * Returns the persisted row (with key) or `null` if the row no longer exists.
 */
export async function ensureMutationIdempotencyKey(
  seq: number,
): Promise<QueuedMutation | null> {
  const db = await offlineDb();
  const tx = db.transaction("mutations", "readwrite");
  const store = tx.objectStore("mutations");
  let current: QueuedMutation | undefined;
  try {
    current = (await store.get(seq)) as QueuedMutation | undefined;
    if (!current) {
      await tx.done.catch(() => undefined);
      return null;
    }
    if (!current.idempotencyKey) {
      current = { ...current, idempotencyKey: newIdempotencyKey() };
      await store.put(current);
    }
    await tx.done;
    return current;
  } catch {
    try {
      await tx.done.catch(() => undefined);
    } catch {
      /* swallow */
    }
    throw new Error(`ensureMutationIdempotencyKey failed for seq ${seq}`);
  }
}

/**
 * F07 in-flight lease: transition `seq` from `queued` (or no deliveryState)
 * to `in_flight` and stamp the owner token + lease expiry. Performed inside
 * ONE readwrite transaction so a concurrent replay observes either the
 * previous state OR the new state, never a half-applied one.
 *
 * Returns the updated row on success. Returns `null` if:
 *   - the row no longer exists;
 *   - the row is already `in_flight` owned by someone else.
 */
export async function markMutationInFlight(
  seq: number,
  owner: string,
  leaseMs: number = IN_FLIGHT_LEASE_MS,
  now: number = Date.now(),
): Promise<QueuedMutation | null> {
  const db = await offlineDb();
  const tx = db.transaction("mutations", "readwrite");
  const store = tx.objectStore("mutations");
  try {
    const current = (await store.get(seq)) as QueuedMutation | undefined;
    if (!current) {
      await tx.done.catch(() => undefined);
      return null;
    }
    if (current.deliveryState === "in_flight") {
      // Some other attempt owns this row.
      await tx.done.catch(() => undefined);
      return null;
    }
    const updated: QueuedMutation = {
      ...current,
      deliveryState: "in_flight",
      inFlightOwner: owner,
      inFlightGeneration: (current.inFlightGeneration ?? 0) + 1,
      inFlightUntil: new Date(now + leaseMs).toISOString(),
    };
    await store.put(updated);
    await tx.done;
    return updated;
  } catch {
    try {
      await tx.done.catch(() => undefined);
    } catch {
      /* swallow */
    }
    throw new Error(`markMutationInFlight failed for seq ${seq}`);
  }
}

/**
 * F07 in-flight lease: extend the lease by `leaseMs` for the row identified
 * by `seq`, but ONLY if:
 *   - the row still exists;
 *   - the row is still `deliveryState="in_flight"`;
 *   - the supplied owner token matches the persisted `inFlightOwner`.
 *
 * Returns the updated row on success. Returns `null` if ownership has moved
 * on (e.g. another tab's replay took over after an expired lease). In that
 * case the caller MUST stop touching the row — it is no longer theirs.
 */
export async function renewMutationLease(
  seq: number,
  owner: string,
  generation: number,
  leaseMs: number = IN_FLIGHT_LEASE_MS,
  now: number = Date.now(),
): Promise<QueuedMutation | null> {
  const db = await offlineDb();
  const tx = db.transaction("mutations", "readwrite");
  const store = tx.objectStore("mutations");
  try {
    const current = (await store.get(seq)) as QueuedMutation | undefined;
    const until = current?.inFlightUntil ? Date.parse(current.inFlightUntil) : 0;
    if (
      !current ||
      current.deliveryState !== "in_flight" ||
      current.inFlightOwner !== owner ||
      current.inFlightGeneration !== generation ||
      !Number.isFinite(until) ||
      until <= now
    ) {
      await tx.done.catch(() => undefined);
      return null;
    }
    const updated: QueuedMutation = {
      ...current,
      inFlightUntil: new Date(now + leaseMs).toISOString(),
    };
    await store.put(updated);
    await tx.done;
    return updated;
  } catch {
    try {
      await tx.done.catch(() => undefined);
    } catch {
      /* swallow */
    }
    throw new Error(`renewMutationLease failed for seq ${seq}`);
  }
}

/**
 * F07 in-flight lease: release a row from `in_flight` back to the default
 * replayable `queued` state. Keeps the SAME `idempotencyKey`. Performed
 * inside ONE readwrite transaction so the row never momentarily disappears.
 *
 * Returns the updated row on success. Returns `null` if the row no longer
 * exists OR if the supplied owner token does not match (stale apiFetch).
 */
export async function releaseMutationToQueue(
  seq: number,
  owner: string,
  generation: number,
  now: number = Date.now(),
): Promise<QueuedMutation | null> {
  const db = await offlineDb();
  const tx = db.transaction("mutations", "readwrite");
  const store = tx.objectStore("mutations");
  try {
    const current = (await store.get(seq)) as QueuedMutation | undefined;
    if (!current) {
      await tx.done.catch(() => undefined);
      return null;
    }
    const until = current.inFlightUntil ? Date.parse(current.inFlightUntil) : 0;
    if (
      current.deliveryState !== "in_flight" ||
      current.inFlightOwner !== owner ||
      current.inFlightGeneration !== generation ||
      !Number.isFinite(until) ||
      until <= now
    ) {
      // Ownership/generation/lease already moved on — never overwrite newer state.
      await tx.done.catch(() => undefined);
      return null;
    }
    const updated: QueuedMutation = {
      ...current,
      deliveryState: "queued",
      inFlightOwner: undefined,
      inFlightUntil: undefined,
    };
    await store.put(updated);
    await tx.done;
    return updated;
  } catch {
    try {
      await tx.done.catch(() => undefined);
    } catch {
      /* swallow */
    }
    throw new Error(`releaseMutationToQueue failed for seq ${seq}`);
  }
}

/**
 * CK-A07: atomically release an owned row after a transport deadline while
 * incrementing the timeout-attempt counter on the SAME durable row/key.
 * The counter survives reloads, so automatic retry cannot reset merely by
 * restarting a tab. Returns null on stale owner/generation/lease.
 */
export async function releaseMutationAfterTransportTimeout(
  seq: number,
  owner: string,
  generation: number,
  now: number = Date.now(),
): Promise<{ row: QueuedMutation; exhausted: boolean } | null> {
  const db = await offlineDb();
  const tx = db.transaction("mutations", "readwrite");
  const store = tx.objectStore("mutations");
  try {
    const current = (await store.get(seq)) as QueuedMutation | undefined;
    if (!current) {
      await tx.done.catch(() => undefined);
      return null;
    }
    const until = current.inFlightUntil ? Date.parse(current.inFlightUntil) : 0;
    if (
      current.deliveryState !== "in_flight" ||
      current.inFlightOwner !== owner ||
      current.inFlightGeneration !== generation ||
      !Number.isFinite(until) ||
      until <= now
    ) {
      await tx.done.catch(() => undefined);
      return null;
    }
    const attempts = (current.transportTimeoutAttempts ?? 0) + 1;
    const updated: QueuedMutation = {
      ...current,
      deliveryState: "queued",
      inFlightOwner: undefined,
      inFlightUntil: undefined,
      transportTimeoutAttempts: attempts,
    };
    await store.put(updated);
    await tx.done;
    return {
      row: updated,
      exhausted: attempts > MAX_TRANSPORT_TIMEOUT_AUTO_RETRIES,
    };
  } catch {
    try {
      await tx.done.catch(() => undefined);
    } catch {
      /* swallow */
    }
    throw new Error(`releaseMutationAfterTransportTimeout failed for seq ${seq}`);
  }
}

/**
 * F07 owner-token terminal cleanup: delete a row iff it still belongs to
 * `owner`. Performed inside ONE readwrite transaction.
 *
 * Returns `true` on success (row was deleted). Returns `false` if:
 *   - the row no longer exists;
 *   - the row is `in_flight` and owned by someone else;
 *   - the supplied owner token does not match the persisted `inFlightOwner`.
 */
export async function completeOwnedMutation(
  seq: number,
  owner: string,
  generation: number,
  now: number = Date.now(),
): Promise<boolean> {
  const db = await offlineDb();
  const tx = db.transaction("mutations", "readwrite");
  const store = tx.objectStore("mutations");
  try {
    const current = (await store.get(seq)) as QueuedMutation | undefined;
    if (!current) {
      await tx.done.catch(() => undefined);
      return false;
    }
    const until = current.inFlightUntil ? Date.parse(current.inFlightUntil) : 0;
    if (
      current.deliveryState !== "in_flight" ||
      current.inFlightOwner !== owner ||
      current.inFlightGeneration !== generation ||
      !Number.isFinite(until) ||
      until <= now
    ) {
      await tx.done.catch(() => undefined);
      return false;
    }
    await store.delete(seq);
    await tx.done;
    return true;
  } catch {
    try {
      await tx.done.catch(() => undefined);
    } catch {
      /* swallow */
    }
    throw new Error(`completeOwnedMutation failed for seq ${seq}`);
  }
}

/**
 * F07 crash recovery: take over an `in_flight` row whose lease has expired.
 * Atomically transitions the row back to the default `queued` state and
 * clears the lease fields. Keeps the SAME `idempotencyKey` so the next
 * replay send hits the durable PK the server has already seen.
 *
 * The function does NOT require knowing the original owner token (because
 * a crashed client's token is gone). It requires the lease to actually be
 * expired, so a healthy in_flight row owned by an active apiFetch() is
 * NEVER touched.
 *
 * Returns the updated row on success. Returns `null` if:
 *   - the row no longer exists;
 *   - the row is no longer `in_flight` (already recovered / completed);
 *   - the row is still `in_flight` AND the lease has not yet expired.
 */
export async function recoverExpiredInFlightLease(
  seq: number,
  now: number = Date.now(),
): Promise<QueuedMutation | null> {
  const db = await offlineDb();
  const tx = db.transaction("mutations", "readwrite");
  const store = tx.objectStore("mutations");
  try {
    const current = (await store.get(seq)) as QueuedMutation | undefined;
    if (!current) {
      await tx.done.catch(() => undefined);
      return null;
    }
    if (current.deliveryState !== "in_flight") {
      await tx.done.catch(() => undefined);
      return null;
    }
    const until = current.inFlightUntil ? Date.parse(current.inFlightUntil) : 0;
    if (!Number.isFinite(until) || until > now) {
      await tx.done.catch(() => undefined);
      return null;
    }
    const updated: QueuedMutation = {
      ...current,
      deliveryState: "queued",
      inFlightOwner: undefined,
      inFlightUntil: undefined,
    };
    await store.put(updated);
    await tx.done;
    return updated;
  } catch {
    try {
      await tx.done.catch(() => undefined);
    } catch {
      /* swallow */
    }
    throw new Error(`recoverExpiredInFlightLease failed for seq ${seq}`);
  }
}

/**
 * F07 atomic move: transition a row from `mutations` into `conflicts` in a
 * SINGLE IndexedDB readwrite transaction that spans BOTH stores. A crash
 * / abort between the two writes leaves the original mutation row intact;
 * nothing observable ever lands in a "conflict exists AND mutation also
 * exists" half-transition.
 *
 * The supplied `conflictBase` may omit `mutation`; the helper attaches the
 * live `mutations` row so the persisted conflict carries the original seq
 * and idempotencyKey byte-for-byte.
 *
 * When `expectedOwner` is provided, the mutation must STILL be owned by
 * that token (`inFlightOwner === expectedOwner`). A different owner means
 * another replay path has already taken over the row; the move is refused
 * (`null`) so a stale sender never converts someone else's row.
 *
 * Returns the persisted ConflictEntry on success. Returns `null` if the
 * row no longer exists OR if `expectedOwner` was supplied and does not
 * match the persisted owner.
 */
export async function moveMutationToConflict(
  seq: number,
  conflictBase: Omit<ConflictEntry, "seq" | "mutation"> & { mutation?: QueuedMutation },
  expectedOwner?: string,
  expectedGeneration?: number,
  now: number = Date.now(),
): Promise<ConflictEntry | null> {
  const db = await offlineDb();
  const tx = db.transaction(["mutations", "conflicts"], "readwrite");
  const mStore = tx.objectStore("mutations");
  const cStore = tx.objectStore("conflicts");
  try {
    const current = (await mStore.get(seq)) as QueuedMutation | undefined;
    if (!current) {
      await tx.done.catch(() => undefined);
      return null;
    }
    if (expectedOwner !== undefined) {
      const until = current.inFlightUntil ? Date.parse(current.inFlightUntil) : 0;
      if (
        current.deliveryState !== "in_flight" ||
        current.inFlightOwner !== expectedOwner ||
        current.inFlightGeneration !== expectedGeneration ||
        !Number.isFinite(until) ||
        until <= now
      ) {
        await tx.done.catch(() => undefined);
        return null;
      }
    }
    const conflict: ConflictEntry = {
      ...conflictBase,
      mutation: conflictBase.mutation ?? current,
    };
    const cseq = (await cStore.add(conflict)) as number;
    await mStore.delete(seq);
    await tx.done;
    return { ...conflict, seq: cseq };
  } catch {
    try {
      await tx.done.catch(() => undefined);
    } catch {
      /* swallow */
    }
    throw new Error(`moveMutationToConflict failed for seq ${seq}`);
  }
}

/**
 * F07 replay-claim heartbeat (this remediation): start a lease-renewal
 * heartbeat for a row that the replay loop has just claimed. Long HTTP
 * operations (slow providers, large imports, ...) can exceed the default
 * 30 s lease; without renewal a competing tab could take over the same
 * row mid-flight and the original sender would still finish but lose its
 * durable owner token — which would then cause `completeOwnedMutation` /
 * `releaseMutationToQueue` / `moveMutationToConflict` to refuse the
 * terminal transition and `replayQueue()` to stop on `client_in_flight`.
 *
 * The helper returns a `stop()` function that callers MUST invoke inside a
 * `finally` block. The heartbeat tick is best-effort — a failed renewal
 * (e.g. ownership moved on) is allowed to be picked up by the existing
 * owner-checked terminal helpers, which already verify the persisted
 * `inFlightOwner` atomically.
 *
 * The optional `intervalMs` parameter exists for tests; production callers
 * must omit it so the global `IN_FLIGHT_HEARTBEAT_MS` tunables stay
 * authoritative.
 */
export function startReplayLeaseHeartbeat(
  seq: number,
  owner: string,
  generation: number,
  intervalMs: number = IN_FLIGHT_HEARTBEAT_MS,
): () => void {
  const timer = setInterval(() => {
    void renewMutationLease(seq, owner, generation).catch(() => {
      /* swallow — lease renewal is best-effort; owner-checked helpers
       * remain authoritative at the terminal transition. */
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

/**
 * F07 atomic replay claim (this remediation): inspect the durable barrier,
 * select the oldest mutation by seq, and acquire it as the next replay's
 * in_flight row — all in ONE IndexedDB readwrite transaction spanning
 * `mutations` and `conflicts`. A crash / abort between the barrier check
 * and the claim write leaves the system in either the pre-claim state OR
 * the post-claim state; there is no observable "barrier cleared AND row
 * still unowned" half-state.
 *
 * Outcomes:
 *  - `{ kind: "empty" }` — no queued mutations.
 *  - `{ kind: "blocked_by_unknown_outcome" }` — at least one
 *    `idempotency_outcome_unknown` conflict is durably persisted. The
 *    barrier holds; nothing is claimed.
 *  - `{ kind: "client_in_flight", row, retryAfterMs }` — the oldest row is
 *    `deliveryState="in_flight"` with a still-valid lease held by a
 *    different sender. Nothing is claimed. A bounded retryAfterMs is
 *    returned so a single scheduler timer can re-arm shortly after the
 *    active apiFetch releases its lease.
 *  - `{ kind: "claimed", row, owner }` — the oldest row was atomically
 *    transitioned to `deliveryState="in_flight"` with `inFlightOwner=owner`
 *    and a fresh lease. The caller MUST honor that owner for every
 *    post-fetch terminal operation.
 *
 * Side effects inside the transaction:
 *  - Queued / legacy rows: a missing `idempotencyKey` is synthesized and
 *    persisted BEFORE the in_flight fields are stamped. No fetch may
 *    observe a keyless row.
 *  - Expired in_flight leases: the same row is taken over by the new
 *    owner with a fresh lease, preserving `seq`, `idempotencyKey`,
 *    `method`/`url`/`body`. The transition is NOT routed through a
 *    separately-committed `queued` state.
 *  - Valid in_flight leases held by someone else: NOT touched. The caller
 *    is told to stop and re-arm a scheduler timer.
 */
export type ClaimResult =
  | { kind: "empty" }
  | { kind: "blocked_by_unknown_outcome"; code: DurableReconciliationCode }
  | { kind: "client_in_flight"; row: QueuedMutation; retryAfterMs: number }
  | { kind: "claimed"; row: QueuedMutation; owner: string };

export async function claimNextReplayMutation(
  owner: string,
  now: number = Date.now(),
  leaseMs: number = IN_FLIGHT_LEASE_MS,
): Promise<ClaimResult> {
  const db = await offlineDb();
  const tx = db.transaction(["mutations", "conflicts"], "readwrite");
  const mStore = tx.objectStore("mutations");
  const cStore = tx.objectStore("conflicts");
  try {
    // Step A — inspect blocker. ANY unresolved idempotency_outcome_unknown
    // conflict blocks the entire replay; nothing is claimed.
    const allConflicts = (await cStore.getAll()) as ConflictEntry[];
    const blocker = allConflicts.find((c) => isDurableReconciliationBarrier(c.code));
    if (blocker) {
      await tx.done.catch(() => undefined);
      const code = isDurableReconciliationBarrier(blocker.code)
        ? blocker.code
        : "idempotency_outcome_unknown";
      return { kind: "blocked_by_unknown_outcome", code };
    }
    // Step B — select the OLDEST mutation by seq order.
    const allMutations = (await mStore.getAll()) as QueuedMutation[];
    if (allMutations.length === 0) {
      await tx.done.catch(() => undefined);
      return { kind: "empty" };
    }
    allMutations.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const first = allMutations[0]!;
    // Step C — inspect its delivery state.
    if (first.deliveryState === "in_flight") {
      const until = first.inFlightUntil ? Date.parse(first.inFlightUntil) : 0;
      if (Number.isFinite(until) && until > now) {
        const retryAfterMs = Math.min(
          Math.max(Math.floor((until - now) / 4), 0),
          60_000,
        );
        await tx.done.catch(() => undefined);
        return { kind: "client_in_flight", row: first, retryAfterMs };
      }
      // Expired lease: take over in THIS SAME transaction. Preserve seq,
      // idempotencyKey, method/url/body. Do not transition through a
      // separately-committed queued state.
      const updated: QueuedMutation = {
        ...first,
        deliveryState: "in_flight",
        inFlightOwner: owner,
        inFlightGeneration: (first.inFlightGeneration ?? 0) + 1,
        inFlightUntil: new Date(now + leaseMs).toISOString(),
      };
      await mStore.put(updated);
      await tx.done;
      return { kind: "claimed", row: updated, owner };
    }
    // Queued / legacy row. Synthesize an idempotency key (if missing) and
    // stamp the in_flight fields atomically.
    const ensured: QueuedMutation = first.idempotencyKey
      ? first
      : { ...first, idempotencyKey: newIdempotencyKey() };
    const claimed: QueuedMutation = {
      ...ensured,
      deliveryState: "in_flight",
      inFlightOwner: owner,
      inFlightGeneration: (ensured.inFlightGeneration ?? 0) + 1,
      inFlightUntil: new Date(now + leaseMs).toISOString(),
    };
    await mStore.put(claimed);
    await tx.done;
    return { kind: "claimed", row: claimed, owner };
  } catch {
    try {
      await tx.done.catch(() => undefined);
    } catch {
      /* swallow */
    }
    throw new Error(`claimNextReplayMutation failed`);
  }
}

export async function listMutations(): Promise<QueuedMutation[]> {
  const db = await offlineDb();
  return db.getAll("mutations");
}

export async function clearMutation(seq: number): Promise<void> {
  const db = await offlineDb();
  await db.delete("mutations", seq);
}

export async function listConflicts(): Promise<ConflictEntry[]> {
  const db = await offlineDb();
  return db.getAll("conflicts");
}

export async function dismissConflict(seq: number): Promise<void> {
  const db = await offlineDb();
  await db.delete("conflicts", seq);
}

function csrfToken(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)ck_csrf=([^;]+)/);
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}

export type ReplayStopReason =
  | "offline"
  | "auth"
  | "forbidden"
  | "rate_limit"
  | "server"
  /** F07 replay-finalization (this remediation): a queueable replay attempt received
   * HTTP 5xx. The server-side idempotency claim has been finalized as
   * `indeterminate`; the row is released back to queued and a bounded retry
   * is scheduled via the shared scheduler so a SAME-KEY follow-up can
   * surface as `409 idempotency_outcome_unknown` and become a durable
   * barrier. */
  | "server_indeterminate"
  | "idempotency_in_progress"
  | "idempotency_outcome_unknown"
  | "idempotency_result_expired"
  | "client_in_flight"
  | "response_invalid"
  | "transport_timeout"
  | "transport_timeout_exhausted"
  | "caller_abort"
  | null;

export interface ReplayResult {
  replayed: number;
  conflicts: ConflictEntry[];
  /** Legacy flag retained for callers: true means replay halted on a retryable condition. */
  stoppedOffline: boolean;
  stoppedReason: ReplayStopReason;
  /** Retry delay requested by the current stop condition. */
  retryAfterMs?: number;
  /** Stable logical mutation key used by the bounded retry scheduler. */
  retryKey?: string;
  retryBudgetExhausted?: boolean;
  retryAttempt?: number;
}

export interface ReplayOptions {
  signal?: AbortSignal;
  /** Optional explicit transport deadline override; production uses route-aware defaults. */
  deadlineMs?: number;
}

let replayInFlight: Promise<ReplayResult> | null = null;

/**
 * Replay the queue sequentially against the live API. Outcomes:
 * - 2xx: mutation removed from the queue
 * - semantic 4xx (e.g. 409 stale/contradiction): moved to conflicts → banner (A10)
 * - 401/403/429: replay stops and the mutation stays queued for retry after
 *   authentication/authorization/rate-limit recovery (F06)
 * - 409 idempotency_in_progress: replay stops; later mutations stay queued;
 *   no conflict created; caller should schedule a single Retry-After-driven
 *   timer (F07)
 * - 409 idempotency_outcome_unknown: mutation moved to conflicts with a
 *   clear message that it MAY already have been applied. The conflict row
 *   itself becomes a DURABLE barrier — every subsequent replay invocation
 *   short-circuits with stoppedReason="idempotency_outcome_unknown" until
 *   the owner dismisses the conflict (F07).
 * - client_in_flight (F07 this remediation): another apiFetch() attempt is
 *   still actively sending this row. Replay MUST NOT fetch the row and
 *   MUST NOT skip ahead to later rows — the whole replay stops. A bounded
 *   `retryAfterMs` is returned based on the lease expiry so the single
 *   scheduler retries shortly after.
 * - expired in_flight lease (F07 this remediation): atomically converted
 *   back to `queued` inside the same readwrite tx; SAME key is reused for
 *   the replay send.
 * - network error: replay stops with stoppedReason="offline", remaining queue
 *   preserved; no scheduler — the browser offline / navigator events drive
 *   the next retry attempt.
 * - 5xx (F07 replay-finalization this remediation): the server-side
 *   idempotency claim has been finalized as `indeterminate`. The row is
 *   released back to queued (SAME key) and the shared scheduler is armed
 *   with a bounded `retryAfterMs`. A follow-up replay attempt then
 *   surfaces as `409 idempotency_outcome_unknown` and the row becomes a
 *   durable unknown-outcome barrier.
 *
 * Calls in the same browser context are single-flight so reconnect/startup races
 * cannot submit the same queued mutation twice.
 */
export function replayQueue(opts: ReplayOptions = {}): Promise<ReplayResult> {
  if (replayInFlight) return replayInFlight;
  replayInFlight = replayQueueOnce(opts).finally(() => {
    replayInFlight = null;
  });
  return replayInFlight;
}

/**
 * Bounded retry-after parser. Accepts either a non-negative integer (seconds,
 * the RFC 7231 default) or an HTTP-date. Returns undefined when the header
 * is absent, malformed, or otherwise unusable.
 */
/** Default delay used when Retry-After is missing or unparseable. */
export const DEFAULT_IN_PROGRESS_RETRY_MS = 1000;

/**
 * Returns true iff any persisted conflict still represents an unresolved
 * `idempotency_outcome_unknown`. Used as the durable-barrier predicate.
 */
export async function hasUnresolvedUnknownOutcomeConflict(): Promise<boolean> {
  const conflicts = await listConflicts();
  return conflicts.some((c) => isDurableReconciliationBarrier(c.code));
}

async function replayQueueOnce(opts: ReplayOptions = {}): Promise<ReplayResult> {
  const result: ReplayResult = {
    replayed: 0,
    conflicts: [],
    stoppedOffline: false,
    stoppedReason: null,
  };

  // F07 atomic replay loop (this remediation). The barrier check, the
  // oldest-row selection, and the in_flight claim all happen in ONE
  // IndexedDB readwrite transaction via `claimNextReplayMutation`. Every
  // post-fetch terminal operation honours the owner returned by the claim;
  // a stale apiFetch / a competing replay cannot accidentally delete or
  // move a row that has been taken over.
  //
  // The loop is intentionally simple: claim one row at a time, send it,
  // resolve the outcome with owner-checked helpers, continue or stop. No
  // second authority reads `getAll("mutations")` and ships rows without
  // ownership.
  while (true) {
    const replayOwner = newOwnerToken();
    const claim = await claimNextReplayMutation(replayOwner);
    if (claim.kind === "empty") {
      return result;
    }
    if (claim.kind === "blocked_by_unknown_outcome") {
      const conflicts = await listConflicts();
      result.stoppedOffline = true;
      result.stoppedReason = claim.code;
      result.conflicts = conflicts;
      return result;
    }
    if (claim.kind === "client_in_flight") {
      // Another apiFetch() is still actively sending this row. Replay does
      // zero fetches; later rows are NOT skipped ahead.
      result.stoppedOffline = true;
      result.stoppedReason = "client_in_flight";
      result.retryAfterMs = claim.retryAfterMs;
      result.retryKey = claim.row.idempotencyKey;
      return result;
    }
    // claim.kind === "claimed"
    const row = claim.row;
    const owner = claim.owner;
    const generation = row.inFlightGeneration!;
    const seq = row.seq!;
    const idempotencyKey = row.idempotencyKey!;
    if (row.url === "/api/agent" || row.url.startsWith("/api/agent/")) {
      const moved = await moveMutationToConflict(
        seq,
        {
          mutation: row,
          status: 410,
          code: "feature_retired",
          message: "Internal AI chat has been retired. This queued request was not sent.",
          detectedAt: new Date().toISOString(),
        },
        owner,
        generation,
      );
      if (moved) result.conflicts.push(moved);
      else {
        result.stoppedReason = "client_in_flight";
        return result;
      }
      continue;
    }

    // CK-A01: old PWA rows without revision-bound review items are not
    // replayed against newer server state. Preserve the complete mutation
    // in the conflict store so the owner can read the inbox again.
    if (inboxDecisionNeedsFreshReview(row)) {
      const moved = await moveMutationToConflict(
        seq,
        {
          mutation: row,
          status: 409,
          code: "needs_user_review",
          message:
            "This offline review was queued before revision-safe review. Reload the inbox and decide again; the original queued intent was preserved.",
          detectedAt: new Date().toISOString(),
        },
        owner,
        generation,
      );
      if (moved) result.conflicts.push(moved);
      else {
        result.stoppedReason = "client_in_flight";
        return result;
      }
      continue;
    }

    // F07 replay-finalization (this remediation): keep the row's in-flight
    // lease renewed for the full duration of the HTTP send (including body
    // processing) so a competing tab cannot take over a row whose lease
    // has outlived its 30s budget but whose request is still in flight.
    // The heartbeat is cleared in `finally` on every terminal transition
    // (success, body parse failure, 4xx, 5xx, network failure) so no
    // interval can outlive the loop iteration that minted it.
    const stopHeartbeat = startReplayLeaseHeartbeat(seq, owner, generation);
    const transportGuard = createTransportGuard(
      row.method,
      row.url,
      opts.signal,
      opts.deadlineMs,
    );

    async function stopForTransportAbort(kind: TransportAbortKind | null): Promise<boolean> {
      if (kind === null) return false;
      result.stoppedOffline = true;

      if (kind === "caller_abort") {
        const released = await releaseMutationToQueue(seq, owner, generation);
        result.stoppedReason = released ? "caller_abort" : "client_in_flight";
        return true;
      }

      const released = await releaseMutationAfterTransportTimeout(seq, owner, generation);
      if (!released) {
        result.stoppedReason = "client_in_flight";
        return true;
      }
      result.retryAfterMs = DEFAULT_RESOLUTION_RETRY_MS;
      result.retryKey = idempotencyKey;
      result.retryAttempt = released.row.transportTimeoutAttempts ?? 0;
      result.retryBudgetExhausted = released.exhausted;
      result.stoppedReason = "transport_timeout";
      if (released.exhausted) {
        return true;
      }
      scheduleOfflineRetry(DEFAULT_RESOLUTION_RETRY_MS, {
        budgetKey: idempotencyKey,
      });
      return true;
    }

    try {
      const headers: Record<string, string> = {};
      if (row.body !== undefined) headers["content-type"] = "application/json";
      const csrf = csrfToken();
      if (csrf) headers["x-csrf-token"] = csrf;
      headers["idempotency-key"] = idempotencyKey;

      let res: Response;
      try {
        res = await fetch(row.url, {
          method: row.method,
          headers,
          credentials: "include",
          body: row.body !== undefined ? JSON.stringify(row.body) : undefined,
          signal: transportGuard.signal,
        });
      } catch {
        if (await stopForTransportAbort(transportGuard.abortKind())) return result;
        // Network failure: owner-checked release so a different replay that
        // took over the row is not silently overwritten.
        await releaseMutationToQueue(seq, owner, generation);
        result.stoppedOffline = true;
        result.stoppedReason = "offline";
        return result;
      }

      if (res.redirected || (res.status >= 300 && res.status < 400)) {
        const released = await releaseMutationToQueue(seq, owner, generation);
        if (!released) {
          result.stoppedReason = "client_in_flight";
          return result;
        }
        result.stoppedOffline = true;
        result.stoppedReason = "response_invalid";
        return result;
      }

      if (res.ok) {
        let successBody: unknown;
        try {
          successBody = await res.json();
        } catch {
          if (await stopForTransportAbort(transportGuard.abortKind())) return result;
          // Every queueable mutation has an operation-specific response
          // contract. An unreadable body is not an acknowledgement.
          const released = await releaseMutationToQueue(seq, owner, generation);
          if (!released) {
            result.stoppedReason = "client_in_flight";
            return result;
          }
          result.stoppedOffline = true;
          result.stoppedReason = "response_invalid";
          return result;
        }
        const acknowledgement = validateMutationAcknowledgement(row.url, row.method, row.body, successBody);
        if (!acknowledgement.valid) {
          const released = await releaseMutationToQueue(seq, owner, generation);
          if (!released) {
            result.stoppedReason = "client_in_flight";
            return result;
          }
          result.stoppedOffline = true;
          result.stoppedReason = "response_invalid";
          return result;
        }
        successBody = acknowledgement.value;

        // Inbox decide replies 200 with per-item blocked entries; when the
        // server state moved while offline, those blocked items ARE the
        // conflicts (A10).
        if (row.url.includes("/api/inbox/decide")) {
          const body = successBody as {
            blocked?: { recordId: string; code: string; message: string }[];
          };
          const blocked = body.blocked ?? [];
          if (blocked.length > 0) {
            const moved = await moveMutationToConflict(
              seq,
              {
                mutation: row,
                status: res.status,
                code: "blocked_on_replay",
                message: `${blocked.length} item(s) blocked on replay: ${blocked
                  .map((b) => `${b.code} (${b.recordId.slice(0, 8)})`)
                  .join("; ")}`,
                detectedAt: new Date().toISOString(),
              },
              owner,
              generation,
            );
            if (moved) result.conflicts.push(moved);
            else {
              result.stoppedReason = "client_in_flight";
              return result;
            }
            continue;
          }
        }

        // Import preview can be HTTP-successful but still require explicit
        // near-duplicate confirmation. Persist the decoded preview instead of
        // acknowledging/deleting the owner's queued intent.
        if (row.url === "/api/imports/text") {
          const body = successBody as { status?: string };
          if (body?.status === "near_duplicate_pending") {
            const moved = await moveMutationToConflict(
              seq,
              {
                mutation: row,
                status: res.status,
                code: "near_duplicate_pending",
                message: "Queued import needs near-duplicate review before it can be completed.",
                response: successBody,
                detectedAt: new Date().toISOString(),
              },
              owner,
              generation,
            );
            if (moved) result.conflicts.push(moved);
            else {
              result.stoppedReason = "client_in_flight";
              return result;
            }
            continue;
          }
        }

        // A correction proposal is only the preview half of the workflow.
        // Persist its job/result so the confirmation step remains reachable
        // after offline replay or reload.
        if (row.url === "/api/corrections" && row.method.toUpperCase() === "POST") {
          const body = successBody as { jobId?: unknown };
          if (typeof body?.jobId === "string" && body.jobId.length > 0) {
            const moved = await moveMutationToConflict(
              seq,
              {
                mutation: row,
                status: res.status,
                code: "correction_preview_pending",
                message: "Queued correction proposal is ready for owner confirmation.",
                response: successBody,
                detectedAt: new Date().toISOString(),
              },
              owner,
              generation,
            );
            if (moved) result.conflicts.push(moved);
            else {
              result.stoppedReason = "client_in_flight";
              return result;
            }
            continue;
          }
        }

        const deleted = await completeOwnedMutation(seq, owner, generation);
        if (!deleted) {
          // Another replay claimed this row while we were awaiting fetch.
          result.stoppedReason = "client_in_flight";
          return result;
        }
        resetOfflineRetryBudget(idempotencyKey);
        result.replayed++;
        continue;
      }

      let code = "http_error";
      let message = `Server responded ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        if (body?.error?.code) code = body.error.code;
        if (body?.error?.message) message = body.error.message;
      } catch {
        if (await stopForTransportAbort(transportGuard.abortKind())) return result;
        /* non-JSON error body */
      }

      let retryAfterHeader: string | null = null;
      try {
        retryAfterHeader = res.headers.get("retry-after");
      } catch {
        /* headers may be opaque in some test environments */
      }

      // Authentication/authorization state and rate limiting are retryable
      // delivery conditions, not proof that the mutation conflicts with
      // canonical state. Keep the current mutation and all later mutations
      // in-order in the queue.
      if (res.status === 401) {
        await releaseMutationToQueue(seq, owner, generation);
        window.dispatchEvent(new CustomEvent("ck:unauthorized"));
        result.stoppedOffline = true;
        result.stoppedReason = "auth";
        return result;
      }
      if (res.status === 403) {
        await releaseMutationToQueue(seq, owner, generation);
        result.stoppedOffline = true;
        result.stoppedReason = "forbidden";
        return result;
      }
      if (res.status === 429) {
        await releaseMutationToQueue(seq, owner, generation);
        result.stoppedOffline = true;
        result.stoppedReason = "rate_limit";
        result.retryAfterMs = parseRetryAfterMs(retryAfterHeader) ?? DEFAULT_IN_PROGRESS_RETRY_MS;
        result.retryKey = idempotencyKey;
        return result;
      }

      // F07: server is still processing an identical retry — leave queued,
      // no conflict, no execution of any other queued mutation behind this
      // one. Caller (main.tsx) is responsible for scheduling ONE
      // Retry-After-driven retry.
      if (res.status === 409 && code === "idempotency_in_progress") {
        await releaseMutationToQueue(seq, owner, generation);
        result.stoppedOffline = true;
        result.stoppedReason = "idempotency_in_progress";
        result.retryAfterMs = parseRetryAfterMs(retryAfterHeader) ?? DEFAULT_IN_PROGRESS_RETRY_MS;
        result.retryKey = idempotencyKey;
        return result;
      }

      // F07: prior attempt may have already committed. Move to conflicts
      // atomically, verifying the row is STILL owned by us. The persisted
      // conflict becomes the durable barrier for subsequent replays.
      if (res.status === 409 && code === "idempotency_outcome_unknown") {
        const moved = await moveMutationToConflict(
          seq,
          {
            mutation: row,
            status: res.status,
            code,
            message:
              message +
              " This mutation MAY already have been applied; review before retrying.",
            detectedAt: new Date().toISOString(),
          },
          owner,
          generation,
        );
        if (!moved) {
          // Another replay took over while we awaited fetch; stop.
          result.stoppedReason = "client_in_flight";
          return result;
        }
        result.conflicts.push(moved);
        result.stoppedOffline = true;
        result.stoppedReason = "idempotency_outcome_unknown";
        return result;
      }

      // The server reports that the earlier request completed, but its cached
      // result is gone. That receipt does not prove a mutation effect: it may
      // represent a validation or other error reply. Preserve the same
      // mutation/key in a visible conflict and stop ordered replay so the
      // owner can reconcile current state before later writes proceed.
      if (res.status === 409 && code === "idempotency_result_expired") {
        const moved = await moveMutationToConflict(
          seq,
          {
            mutation: row,
            status: res.status,
            code,
            message: message + " This earlier request completed, but its saved response expired; reconcile existing state before retrying with the same event key.",
            detectedAt: new Date().toISOString(),
          },
          owner,
          generation,
        );
        if (!moved) {
          result.stoppedReason = "client_in_flight";
          return result;
        }
        result.conflicts.push(moved);
        result.stoppedOffline = true;
        result.stoppedReason = "idempotency_result_expired";
        return result;
      }

      if (res.status >= 400 && res.status < 500) {
        const moved = await moveMutationToConflict(
          seq,
          {
            mutation: row,
            status: res.status,
            code,
            message,
            detectedAt: new Date().toISOString(),
          },
          owner,
          generation,
        );
        if (!moved) {
          result.stoppedReason = "client_in_flight";
          return result;
        }
        result.conflicts.push(moved);
        continue;
      }
      // 5xx — F07 replay-finalization (this remediation): the server-side
      // idempotency claim has already been finalized as `indeterminate`
      // by the time the 5xx response reaches the client. Release the
      // row back to queued (preserving the SAME idempotency key), set a
      // specific stop reason, and schedule a bounded SAME-KEY retry via
      // the SHARED scheduler so the next replay attempt surfaces as
      // `409 idempotency_outcome_unknown` and the row becomes a durable
      // owner-visible barrier.
      await releaseMutationToQueue(seq, owner, generation);
      result.stoppedOffline = true;
      result.stoppedReason = "server_indeterminate";
      const retryAfterMs = parseRetryAfterMs(retryAfterHeader) ?? DEFAULT_RESOLUTION_RETRY_MS;
      result.retryAfterMs = retryAfterMs;
      result.retryKey = idempotencyKey;
      const scheduled = scheduleOfflineRetry(retryAfterMs, { budgetKey: idempotencyKey });
      result.retryAttempt = scheduled.attempt;
      result.retryBudgetExhausted = scheduled.exhausted;
      return result;
    } finally {
      // Always clear both transport deadline and lease heartbeat — even on
      // early return — so no timer can outlive the attempt that started it.
      transportGuard.dispose();
      stopHeartbeat();
    }
  }
}
