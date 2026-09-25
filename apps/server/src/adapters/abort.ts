export type ProviderAbortKind = "timeout" | "caller" | null;

export interface ProviderAbortGuard {
  signal: AbortSignal;
  kind(): ProviderAbortKind;
  dispose(): void;
}

/**
 * Compose an adapter-local timeout with an optional caller signal without
 * losing which side initiated cancellation. Provider adapters keep their
 * existing timeout error contract while sync shutdown can cancel transport
 * cooperatively.
 */
export function createProviderAbortGuard(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): ProviderAbortGuard {
  const controller = new AbortController();
  let abortKind: ProviderAbortKind = null;
  let disposed = false;

  const abortFromCaller = (): void => {
    if (disposed || abortKind !== null) return;
    abortKind = "caller";
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  const timer = setTimeout(() => {
    if (disposed || abortKind !== null) return;
    abortKind = "timeout";
    controller.abort(new DOMException("Provider deadline exceeded", "TimeoutError"));
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    kind: () => abortKind,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}
