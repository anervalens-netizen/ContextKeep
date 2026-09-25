export const READ_TRANSPORT_DEADLINE_MS = 20_000;
export const MUTATION_TRANSPORT_DEADLINE_MS = 45_000;
/**
 * Server-side extraction adapters allow up to 120s. Browser import and
 * explicit extraction calls need enough headroom to receive and consume the
 * server response instead of aborting before the server's own deadline.
 */
export const PROVIDER_TRANSPORT_DEADLINE_MS = 135_000;
export const MAX_TRANSPORT_DEADLINE_MS = 5 * 60_000;

export type TransportAbortKind = "timeout" | "caller_abort";

export class TransportTimeoutError extends Error {
  readonly kind = "timeout" as const;
  constructor(readonly deadlineMs: number) {
    super(
      `Request timed out after ${deadlineMs}ms. The server may still have completed a write; its result must be reconciled.`,
    );
    this.name = "TransportTimeoutError";
  }
}

export class CallerAbortedError extends Error {
  readonly kind = "caller_abort" as const;
  constructor(readonly reason: unknown = null) {
    super("Request was cancelled by the caller.");
    this.name = "CallerAbortedError";
  }
}

function routePath(url: string): string {
  try {
    return new URL(url, "http://contextkeep.local").pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

export function requestDeadlineMs(
  method: string,
  url: string,
  overrideMs?: number,
): number {
  if (overrideMs !== undefined) {
    if (!Number.isFinite(overrideMs) || overrideMs <= 0) {
      throw new RangeError("deadlineMs must be a finite positive number");
    }
    return Math.max(1, Math.min(Math.floor(overrideMs), MAX_TRANSPORT_DEADLINE_MS));
  }

  const normalizedMethod = method.toUpperCase();
  const path = routePath(url);
  if (
    normalizedMethod !== "GET" &&
    normalizedMethod !== "HEAD" &&
    (path.startsWith("/api/imports/") ||
      /^\/api\/sources\/[^/]+\/extract$/.test(path))
  ) {
    return PROVIDER_TRANSPORT_DEADLINE_MS;
  }
  if (normalizedMethod !== "GET" && normalizedMethod !== "HEAD") {
    return MUTATION_TRANSPORT_DEADLINE_MS;
  }
  return READ_TRANSPORT_DEADLINE_MS;
}

export interface TransportGuard {
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  readonly abortKind: () => TransportAbortKind | null;
  classify(error: unknown): unknown;
  dispose(): void;
}

/**
 * One finite transport budget spanning fetch + response body consumption.
 * The returned signal is the signal passed to fetch. Keep the guard alive
 * until the body has been consumed; dispose it in a finally block.
 */
export function createTransportGuard(
  method: string,
  url: string,
  callerSignal?: AbortSignal,
  overrideMs?: number,
): TransportGuard {
  const deadlineMs = requestDeadlineMs(method, url, overrideMs);
  const controller = new AbortController();
  let kind: TransportAbortKind | null = null;
  let disposed = false;

  const onCallerAbort = (): void => {
    if (kind !== null || disposed) return;
    kind = "caller_abort";
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal?.aborted) {
    kind = "caller_abort";
    controller.abort(callerSignal.reason);
  } else {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  }

  const timer = setTimeout(() => {
    if (kind !== null || disposed) return;
    kind = "timeout";
    controller.abort(new DOMException("Transport deadline exceeded", "TimeoutError"));
  }, deadlineMs);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  };

  return {
    signal: controller.signal,
    deadlineMs,
    abortKind: () => kind,
    classify(error: unknown): unknown {
      if (kind === "timeout") return new TransportTimeoutError(deadlineMs);
      if (kind === "caller_abort") return new CallerAbortedError(callerSignal?.reason ?? null);
      return error;
    },
    dispose,
  };
}
