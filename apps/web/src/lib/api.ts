import { newIdempotencyKey, RETRY_OFFLINE_QUEUE_EVENT } from "./idempotency-key.js";
import * as offlineQueue from "./offline/queue.js";
import * as offlineScheduler from "./offline/scheduler.js";
import {
  CallerAbortedError,
  createTransportGuard,
  TransportTimeoutError,
  type TransportAbortKind,
  type TransportGuard,
} from "./transport.js";

export { CallerAbortedError, TransportTimeoutError } from "./transport.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Thrown when a mutation was queued offline instead of sent (A10). */
export class QueuedOfflineError extends Error {
  readonly queued = true;
  constructor(readonly seq: number) {
    super(`Mutation queued offline (seq ${seq}); it will replay on reconnect.`);
    this.name = "QueuedOfflineError";
  }
}

/**
 * CK-A07: the request was sent (or may have been sent) but its terminal
 * result was not observed. The persisted row + original idempotency key are
 * retained so reconciliation cannot create a second logical write.
 */
export class QueuedUnknownOutcomeError extends Error {
  readonly queued = true;
  readonly unknownOutcome = true;
  constructor(
    readonly seq: number,
    readonly reason: TransportAbortKind,
  ) {
    super(
      reason === "timeout"
        ? `Mutation delivery timed out (seq ${seq}). The server may already have applied it; the same request remains queued for reconciliation.`
        : `Mutation delivery was cancelled after send (seq ${seq}). The server may already have applied it; the same request remains queued for reconciliation.`,
    );
    this.name = "QueuedUnknownOutcomeError";
  }
}

/**
 * CK-A04: a successful-looking private API response without the live-server
 * provenance marker may have come from the legacy service-worker cache.
 * Treat it as cache/unknown rather than as a fresh network read.
 */
export class UnverifiedDataResponseError extends Error {
  constructor(readonly url: string) {
    super(`Unverified cached API response for ${url}`);
    this.name = "UnverifiedDataResponseError";
  }
}

/** True only for transport/cache reachability failures, never HTTP/semantic errors. */
export function isNetworkUnavailableError(error: unknown): boolean {
  if (
    error instanceof ApiError ||
    error instanceof QueuedOfflineError ||
    error instanceof QueuedUnknownOutcomeError ||
    error instanceof CallerAbortedError ||
    error instanceof TransportTimeoutError
  ) return false;
  if (error instanceof UnverifiedDataResponseError) return true;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return error instanceof TypeError;
}

function requiresVerifiedDataProvenance(url: string, method: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (!url.startsWith("/api/")) return false;
  // Public auth bootstrap is intentionally outside the authenticated data
  // plugin and was never part of the legacy SW runtime cache.
  return !url.startsWith("/api/auth/");
}

function dispatchOfflineQueueRetry(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(RETRY_OFFLINE_QUEUE_EVENT));
  } catch {
    /* best-effort signal; the durable row remains the recovery authority */
  }
}

export function csrfToken(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)ck_csrf=([^;]+)/);
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}

let privateReadsPausedForAuthTransition = false;
export function setPrivateReadsPausedForAuthTransition(paused: boolean): void {
  privateReadsPausedForAuthTransition = paused;
}
function isPrivateRead(url: string, method: string): boolean {
  return (method === "GET" || method === "HEAD") && url.startsWith("/api/") && !url.startsWith("/api/auth/");
}

export interface FetchOptions {
  method?: string;
  body?: unknown;
  /** Verified live-server provenance for authenticated private GET/HEAD data. */
  onDataProvenance?: (meta: { fetchedAt: string; requestId: string }) => void;
  /** Human label shown in the offline queue/conflict banner. */
  label?: string;
  /** Skip offline queueing (auth endpoints must fail loudly, not queue). */
  noQueue?: boolean;
  /**
   * F07: caller-supplied durable idempotency key. When omitted for a
   * queueable mutation, the client generates one and PERSISTS it on the
   * IndexedDB row alongside the queued mutation BEFORE the first HTTP
   * request is dispatched.
   */
  idempotencyKey?: string;
  /** Optional caller cancellation. A pre-aborted signal sends/stages nothing. */
  signal?: AbortSignal;
  /**
   * Explicit transport deadline override. Production callers normally rely
   * on route-aware defaults; tests and deliberately bounded operations may
   * provide a positive value.
   */
  deadlineMs?: number;
}

/**
 * Stages a queueable mutation to IndexedDB and returns its seq. Always sets
 * a durable idempotencyKey before the transaction commits — direct callers
 * like the offline file-import path that pass no key still get one
 * automatically.
 */
async function stageMutation(
  method: string,
  url: string,
  body: unknown,
  label: string | undefined,
  idempotencyKey: string,
): Promise<number> {
  const { enqueueMutation } = offlineQueue;
  return enqueueMutation({
    method,
    url,
    body,
    enqueuedAt: new Date().toISOString(),
    label,
    idempotencyKey,
  });
}

/**
 * F07 atomic initial online stage (this remediation): persist the queued
 * mutation row ALREADY marked `deliveryState="in_flight"` with an opaque
 * owner token + renewable lease, in ONE IndexedDB write. No committed
 * `queued` intermediate state exists for a competing replay to grab.
 *
 * F07 atomic foreground barrier (this remediation): blocker inspection +
 * mutation creation happen inside ONE readwrite transaction spanning both
 * `mutations` and `conflicts` stores. If an `idempotency_outcome_unknown`
 * blocker is present, the row is persisted as queued (no lease, no owner)
 * and the apiFetch path will see the `blocked_by_unknown_outcome` result,
 * throw `QueuedOfflineError(seq)`, and NOT call fetch.
 *
 * The offline path keeps using `enqueueMutation` (queued) — no lease is
 * minted when no network call is about to happen.
 */
async function stageOwnedOnline(
  method: string,
  url: string,
  body: unknown,
  label: string | undefined,
  idempotencyKey: string,
  ownerToken: string,
): Promise<Awaited<ReturnType<typeof offlineQueue.stageOwnedInFlightMutation>>> {
  const { stageOwnedInFlightMutation } = offlineQueue;
  return stageOwnedInFlightMutation(
    {
      method,
      url,
      body,
      enqueuedAt: new Date().toISOString(),
      label,
      idempotencyKey,
    },
    ownerToken,
  );
}

/**
 * API client: same-origin fetch with cookie session + CSRF double-submit.
 * Mutations made while offline (or on network failure) are queued in
 * IndexedDB and replayed on reconnect (A10); GETs fall through to the
 * service-worker cache and, at page level, to the IndexedDB mirror.
 *
 * F07 durability contract:
 *
 *   IndexedDB stage  (key + owner + lease in ONE write)
 *       ↓
 *   heartbeat every 10s (extend lease)
 *       ↓
 *   fetch
 *       ↓
 *   response arrives
 *       ↓
 *   body fully consumed
 *       ↓
 *   complete / release / move to conflict
 *
 * The IndexedDB row is the crash-recovery record: even if the tab or the
 * browser dies between the stage write and the HTTP response, a future
 * replay observes the same key. While an `apiFetch()` call is actively
 * sending a row it is marked `deliveryState="in_flight"` with an opaque
 * owner token and a renewable lease so no other browser tab / startup
 * recovery / retry event can re-fetch the SAME row while the original is
 * still in flight.
 *
 * The atomic online stage helper persists key + owner + lease in ONE
 * IndexedDB write — there is no committed intermediate `queued` state
 * for a competing replay to exploit.
 *
 * F07 atomic foreground barrier: the SAME staging transaction inspects the
 * `conflicts` store. If an unresolved `idempotency_outcome_unknown`
 * conflict is present at the moment we stage the row, the row is persisted
 * as queued (no owner, no lease, same key). The fetch is NEVER issued
 * under that condition — the durable unknown-outcome barrier is enforced
 * across both the replay path AND the foreground path. The caller sees
 * `QueuedOfflineError(seq)` and treats the operation as durably queued.
 *
 * Only fully-consumed 2xx responses delete the staging row; everything
 * else (network failure, body-read failure, 4xx/5xx retryable conditions,
 * 429) releases the row back to `queued` so a later replay uses the exact
 * same key. `409 idempotency_in_progress` follows the same release rule
 * and additionally schedules exactly one same-key retry via the existing
 * single offline scheduler before throwing `QueuedOfflineError(stagedSeq)`
 * so the caller knows to wait instead of treating this as a normal error.
 */
export async function apiFetch<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const method = (opts.method ?? "GET").toUpperCase();
  const isMutation = method !== "GET" && method !== "HEAD";
  const isQueueable = isMutation && !opts.noQueue;

  if (privateReadsPausedForAuthTransition && isPrivateRead(url, method)) {
    throw new CallerAbortedError("auth-transition");
  }

  // A caller that cancelled before apiFetch starts has not sent anything and
  // must not leave a durable mutation behind.
  if (opts.signal?.aborted) {
    throw new CallerAbortedError(opts.signal.reason);
  }

  // Bind a stable key for the entire lifecycle of this logical mutation.
  // If the caller already pinned one (e.g. queue replay) keep it; otherwise
  // mint a fresh UUID here. The key is always bound BEFORE any check,
  // IndexedDB write, or network call.
  let idempotencyKey: string | undefined;
  if (isQueueable) {
    idempotencyKey = opts.idempotencyKey ?? newIdempotencyKey();
  }

  // Stage the durable IndexedDB row BEFORE first network send. This is the
  // crash-recovery record: if the process dies before the HTTP response
  // completes, a future replay still finds this row with the original key.
  let stagedSeq: number | undefined;
  let ownerToken: string | undefined;
  let ownerGeneration: number | undefined;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let transportGuard: TransportGuard | null = null;

  if (isQueueable) {
    const isOffline = typeof navigator !== "undefined" && navigator.onLine === false;
    if (isOffline) {
      // Offline: stage as queued (no lease — no network call will happen).
      stagedSeq = await stageMutation(method, url, opts.body, opts.label, idempotencyKey!);
      throw new QueuedOfflineError(stagedSeq);
    }
    // F07 atomic initial online stage + atomic foreground barrier
    // (this remediation): the staging helper performs blocker inspection
    // and mutation creation inside ONE IndexedDB readwrite transaction
    // spanning `mutations` and `conflicts`. The result is a discriminated
    // union:
    //   - `in_flight`: no blocker; row is born under our ownership.
    //   - `blocked_by_unknown_outcome`: a durable `idempotency_outcome_
    //     unknown` conflict exists; the row is queued behind it (no lease,
    //     no owner). We MUST NOT call fetch and MUST NOT start a heartbeat.
    const { renewMutationLease, newOwnerToken, IN_FLIGHT_HEARTBEAT_MS } = offlineQueue;
    ownerToken = newOwnerToken();
    const stamped = await stageOwnedOnline(
      method,
      url,
      opts.body,
      opts.label,
      idempotencyKey!,
      ownerToken,
    );
    if (stamped.kind === "blocked_by_unknown_outcome") {
      // F07 foreground barrier (this remediation): the durable unknown-
      // outcome barrier blocks this mutation from sending. The row is
      // durably queued (same seq, same key, no owner, no lease). Surfacing
      // QueuedOfflineError lets existing page handlers treat the
      // operation as queued rather than as a normal failure — and means
      // the user can NEVER re-submit and bypass the barrier with a fresh
      // idempotency key.
      throw new QueuedOfflineError(stamped.seq);
    }
    stagedSeq = stamped.seq;
    ownerGeneration = stamped.mutation.inFlightGeneration;
    heartbeat = setInterval(() => {
      void renewMutationLease(stagedSeq!, ownerToken!, ownerGeneration!).catch(() => {
        /* swallow — lease extension is best-effort */
      });
    }, IN_FLIGHT_HEARTBEAT_MS);
  }

  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const dataRequestId = requiresVerifiedDataProvenance(url, method)
    ? newIdempotencyKey()
    : null;
  if (dataRequestId) headers["x-contextkeep-request-id"] = dataRequestId;
  if (isMutation) {
    const csrf = csrfToken();
    if (csrf) headers["x-csrf-token"] = csrf;
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  }

  function stopHeartbeat(): void {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (transportGuard !== null) {
      transportGuard.dispose();
      transportGuard = null;
    }
  }

  // Final cleanup helper. ALWAYS releases / completes the row through an
  // owner-token-checking helper so a stale apiFetch (e.g. the tab is gone
  // and a replay has already taken over) cannot accidentally delete or
  // overwrite the newer state. `op` selects which terminal transition to
  // attempt; the helper itself verifies ownership.
  async function finalizeStage(op: "complete" | "release"): Promise<void> {
    if (
      stagedSeq === undefined ||
      ownerToken === undefined ||
      ownerGeneration === undefined
    ) return;
    stopHeartbeat();
    try {
      if (op === "complete") {
        const { completeOwnedMutation } = offlineQueue;
        await completeOwnedMutation(stagedSeq, ownerToken, ownerGeneration);
      } else {
        const { releaseMutationToQueue } = offlineQueue;
        await releaseMutationToQueue(stagedSeq, ownerToken, ownerGeneration);
      }
    } catch {
      /* IndexedDB is best-effort here — server durable state is the source of truth. */
    }
  }

  async function scheduleStagedRetry(delayMs: number): Promise<void> {
    if (!idempotencyKey) return;
    const { scheduleOfflineRetry } = offlineScheduler;
    scheduleOfflineRetry(delayMs, { budgetKey: idempotencyKey });
  }

  async function resetStagedRetryBudget(): Promise<void> {
    if (!idempotencyKey) return;
    const { resetOfflineRetryBudget } = offlineScheduler;
    resetOfflineRetryBudget(idempotencyKey);
  }

  async function releaseStageAfterTransportAbort(
    kind: TransportAbortKind,
  ): Promise<{ exhausted: boolean }> {
    if (
      stagedSeq === undefined ||
      ownerToken === undefined ||
      ownerGeneration === undefined
    ) {
      stopHeartbeat();
      return { exhausted: false };
    }

    if (kind === "caller_abort") {
      await finalizeStage("release");
      return { exhausted: false };
    }

    stopHeartbeat();
    try {
      const { releaseMutationAfterTransportTimeout } = offlineQueue;
      const released = await releaseMutationAfterTransportTimeout(
        stagedSeq,
        ownerToken,
        ownerGeneration,
      );
      if (released && !released.exhausted) await scheduleStagedRetry(750);
      return { exhausted: released?.exhausted ?? false };
    } catch {
      // Preserve the unknown result. A stale owner is fenced by CK-A06 and
      // a future recovery/replay still sees the durable row.
      return { exhausted: false };
    }
  }

  // The caller may have cancelled while the IndexedDB stage was being
  // created. No network send has happened yet, so terminate our own stage
  // rather than preserving a false unknown outcome.
  if (opts.signal?.aborted) {
    if (stagedSeq !== undefined) await finalizeStage("complete");
    else stopHeartbeat();
    throw new CallerAbortedError(opts.signal.reason);
  }

  transportGuard = createTransportGuard(method, url, opts.signal, opts.deadlineMs);

  async function rethrowTransportAbortIfNeeded(error: unknown): Promise<void> {
    const kind = transportGuard?.abortKind() ?? null;
    if (kind === null) return;
    const classified = transportGuard?.classify(error) ?? error;
    if (stagedSeq !== undefined) {
      await releaseStageAfterTransportAbort(kind);
      throw new QueuedUnknownOutcomeError(stagedSeq, kind);
    }
    stopHeartbeat();
    throw classified;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: "include",
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: transportGuard.signal,
    });
  } catch (networkError) {
    const abortKind = transportGuard.abortKind();
    if (abortKind !== null) {
      if (stagedSeq !== undefined) {
        await releaseStageAfterTransportAbort(abortKind);
        throw new QueuedUnknownOutcomeError(stagedSeq, abortKind);
      }
      const classified = transportGuard.classify(networkError);
      stopHeartbeat();
      throw classified;
    }
    // Network failure: release the row back to queued so a future replay
    // uses the exact same key. We do NOT add a second queue entry.
    if (stagedSeq !== undefined) {
      await finalizeStage("release");
      throw new QueuedOfflineError(stagedSeq);
    }
    stopHeartbeat();
    throw networkError;
  }

  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent("ck:unauthorized"));
    // Auth is a retryable delivery condition; keep the staged row so the
    // post-login resume (Login.tsx → ck:retry-offline-queue → main.tsx) can
    // replay it with the SAME key.
    await finalizeStage("release");
    throw new ApiError(401, "unauthorized", "Session expired — please sign in again.");
  }

  if (res.status === 429) {
    // F07 429 routing (this remediation): only enter the queueable-mutation
    // branch when a real staged row exists. GETs, headless requests, and
    // auth/login/setup calls (noQueue: true) have no `stagedSeq`; turning
    // them into `QueuedOfflineError(undefined)` was bogus queue behaviour.
    if (stagedSeq === undefined) {
      // Surface as a normal HTTP error. No queue row, no scheduler, no
      // QueuedOfflineError — exactly as the F07 429 routing rule requires.
      let rateCode = "rate_limit";
      let rateMessage = res.statusText || "Too many requests (429)";
      try {
        const body429 = (await res.json()) as {
          error?: { code?: string; message?: string };
        };
        if (body429?.error?.code) rateCode = body429.error.code;
        if (body429?.error?.message) rateMessage = body429.error.message;
      } catch (bodyError) {
        await rethrowTransportAbortIfNeeded(bodyError);
        /* non-JSON body — keep generic code/message */
      }
      stopHeartbeat();
      throw new ApiError(429, rateCode, rateMessage);
    }
    // Queueable mutation path: release the row back to queued and schedule
    // exactly one same-key retry after Retry-After. Same parser as the
    // replay's idempotency_in_progress path so behaviour stays symmetrical.
    await finalizeStage("release");
    let parsed: number | undefined;
    try {
      const header = res.headers.get("retry-after");
      const { parseRetryAfterMs, DEFAULT_IN_PROGRESS_RETRY_MS } = offlineQueue;
      parsed = parseRetryAfterMs(header) ?? DEFAULT_IN_PROGRESS_RETRY_MS;
    } catch {
      const { DEFAULT_IN_PROGRESS_RETRY_MS } = offlineQueue;
      parsed = DEFAULT_IN_PROGRESS_RETRY_MS;
    }
    await scheduleStagedRetry(parsed);
    throw new QueuedOfflineError(stagedSeq);
  }

  // F07 terminal-race fix: a 403 csrf_mismatch originates from the server's
  // onRequest CSRF pre-flight check that runs BEFORE the idempotency
  // pre-handler AND BEFORE any business handler. By contract the server did
  // NOT create an idempotency claim and did NOT execute any side effect, so
  // the staged row is safe to terminate. Doing so prevents a future replay
  // from re-issuing the request with the SAME key and creating a duplicate
  // logical mutation once the user reloads after a stale CSRF cookie.
  //
  // Any other 403 code (e.g. project-scope checks that may fire AFTER the
  // idempotency claim) keeps the existing fail-closed behavior: release the
  // row back to queued so a later retry can use the same key.
  if (res.status === 403) {
    let csrfCode = "forbidden";
    let csrfMessage = res.statusText || "Request forbidden (403)";
    try {
      const body403 = (await res.json()) as {
        error?: { code?: string; message?: string };
      };
      if (body403?.error?.code) csrfCode = body403.error.code;
      if (body403?.error?.message) csrfMessage = body403.error.message;
    } catch (bodyError) {
      await rethrowTransportAbortIfNeeded(bodyError);
      /* non-JSON body — keep generic code/message */
    }
    if (csrfCode === "csrf_mismatch" && stagedSeq !== undefined && ownerToken !== undefined) {
      // Owner-token-checked delete via finalizeStage("complete").
      await finalizeStage("complete");
      await resetStagedRetryBudget();
      throw new ApiError(403, "csrf_mismatch", csrfMessage);
    }
    // Any other 403 code: keep the row queued so a later retry with the
    // SAME key has a chance to succeed once authorization is resolved.
    if (stagedSeq !== undefined) {
      await finalizeStage("release");
    }
    throw new ApiError(403, csrfCode, csrfMessage);
  }

  if (!res.ok) {
    let code = "http_error";
    let message = res.statusText || `Request failed (${res.status})`;
    let details: unknown = null;
    let parsedErrorBody = false;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
      parsedErrorBody = true;
      if (body?.error?.code) code = body.error.code;
      if (body?.error?.message) message = body.error.message;
      if (body?.error?.details !== undefined) details = body.error.details;
    } catch (bodyError) {
      await rethrowTransportAbortIfNeeded(bodyError);
      // The HTTP status arrived but the response body is not consumable.
      // For a staged mutation that outcome is not safe to classify as
      // terminal: preserve the same key/intent for reconciliation.
      if (stagedSeq !== undefined) {
        await finalizeStage("release");
        dispatchOfflineQueueRetry();
        throw new QueuedOfflineError(stagedSeq);
      }
    }
    // F07: a queueable mutation that received a 5xx has already had its
    // server-side idempotency claim finalized as `indeterminate`. Release
    // only if THIS owner/generation still holds a live lease, then retry
    // with the same key through the existing scheduler.
    if (stagedSeq !== undefined && res.status >= 500) {
      await finalizeStage("release");
      dispatchOfflineQueueRetry();
      throw new QueuedOfflineError(stagedSeq);
    }
    if (
      res.status === 409 &&
      code === "idempotency_in_progress" &&
      stagedSeq !== undefined &&
      ownerToken !== undefined
    ) {
      await finalizeStage("release");
      let parsedInProgress: number;
      try {
        const header = res.headers.get("retry-after");
        const { parseRetryAfterMs, DEFAULT_IN_PROGRESS_RETRY_MS } = offlineQueue;
        parsedInProgress =
          parseRetryAfterMs(header) ?? DEFAULT_IN_PROGRESS_RETRY_MS;
      } catch {
        const { DEFAULT_IN_PROGRESS_RETRY_MS } = offlineQueue;
        parsedInProgress = DEFAULT_IN_PROGRESS_RETRY_MS;
      }
      await scheduleStagedRetry(parsedInProgress);
      throw new QueuedOfflineError(stagedSeq);
    }

    // Every remaining staged 4xx is terminal for this attempt but the
    // owner's original intent remains useful evidence. Move it atomically
    // to the conflict store only if the SAME owner + claim generation still
    // holds a live lease. A delayed response from an older tab may still
    // inform that tab's UI through ApiError, but cannot delete/move a row
    // already taken over by another generation.
    if (
      stagedSeq !== undefined &&
      ownerToken !== undefined &&
      ownerGeneration !== undefined &&
      parsedErrorBody &&
      res.status >= 400 &&
      res.status < 500
    ) {
      const { moveMutationToConflict } = offlineQueue;
      await moveMutationToConflict(
        stagedSeq,
        {
          status: res.status,
          code,
          message,
          detectedAt: new Date().toISOString(),
        },
        ownerToken,
        ownerGeneration,
      );
    }
    stopHeartbeat();
    throw new ApiError(res.status, code, message, details);
  }

  // CK-A04 legacy-SW handshake. A static "network" marker alone is not
  // enough: an old NetworkFirst worker can cache a newer marked response and
  // replay it later. The live server must echo this request's nonce. A cached
  // response necessarily carries a missing/old nonce and is downgraded to
  // cache/unknown instead of refreshing the explicit IndexedDB mirror.
  if (res.ok && requiresVerifiedDataProvenance(url, method)) {
    const responseRequestId = res.headers.get("x-contextkeep-response-id");
    const fetchedAt = res.headers.get("x-contextkeep-fetched-at");
    if (
      res.headers.get("x-contextkeep-data-source") !== "network-v1" ||
      !dataRequestId ||
      responseRequestId !== dataRequestId ||
      !fetchedAt
    ) {
      stopHeartbeat();
      throw new UnverifiedDataResponseError(url);
    }
    opts.onDataProvenance?.({ fetchedAt, requestId: dataRequestId });
  }

  // Successful 2xx: parse JSON. If body parsing fails the staged row MUST
  // survive so a later replay uses the same key against the (now committed)
  // server state.
  try {
    const dto = (await res.json()) as T;
    if (stagedSeq !== undefined) {
      await finalizeStage("complete");
      await resetStagedRetryBudget();
    } else {
      stopHeartbeat();
    }
    return dto;
  } catch (parseError) {
    await rethrowTransportAbortIfNeeded(parseError);
    if (stagedSeq !== undefined) {
      // Body consumption failed AFTER the server committed the mutation.
      // Atomically release the owned stage from `in_flight` back to
      // `queued` (keeping the SAME idempotency key) and trigger the
      // neutral queue-retry event. A same-key replay will then hit the
      // server's already-completed cached response for this key.
      await finalizeStage("release");
      dispatchOfflineQueueRetry();
      throw new QueuedOfflineError(stagedSeq);
    }
    stopHeartbeat();
    throw parseError;
  }
}
