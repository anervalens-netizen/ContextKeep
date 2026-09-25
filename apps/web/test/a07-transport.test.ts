import { afterEach, describe, expect, it, vi } from "vitest";
import { isNetworkUnavailableError } from "../src/lib/api.js";
import {
  CallerAbortedError,
  MUTATION_TRANSPORT_DEADLINE_MS,
  PROVIDER_TRANSPORT_DEADLINE_MS,
  READ_TRANSPORT_DEADLINE_MS,
  TransportTimeoutError,
  createTransportGuard,
  requestDeadlineMs,
} from "../src/lib/transport.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function neverResolvingFetch(): typeof fetch {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  }) as unknown as typeof fetch;
}

async function guardedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<Response> {
  const guard = createTransportGuard(String(init.method ?? "GET"), url, callerSignal, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: guard.signal });
  } catch (error) {
    throw guard.classify(error);
  } finally {
    guard.dispose();
  }
}

describe("CK-A07 transport deadlines", () => {
  it("aborts a hung fetch at its explicit deadline and clears the timer", async () => {
    vi.useFakeTimers();
    globalThis.fetch = neverResolvingFetch();

    const pending = guardedFetch("/api/projects", { method: "GET" }, 50);
    const rejected = expect(pending).rejects.toBeInstanceOf(TransportTimeoutError);
    await vi.advanceTimersByTimeAsync(50);

    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps caller abort distinct from a transport timeout", async () => {
    vi.useFakeTimers();
    globalThis.fetch = neverResolvingFetch();
    const controller = new AbortController();

    const pending = guardedFetch("/api/projects", { method: "GET" }, 5000, controller.signal);
    const rejected = expect(pending).rejects.toBeInstanceOf(CallerAbortedError);
    controller.abort("caller cancelled");

    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a longer deadline for synchronous import/extraction routes", () => {
    expect(requestDeadlineMs("GET", "/api/projects")).toBe(READ_TRANSPORT_DEADLINE_MS);
    expect(requestDeadlineMs("PUT", "/api/records/abc")).toBe(MUTATION_TRANSPORT_DEADLINE_MS);
    expect(requestDeadlineMs("POST", "/api/imports/text")).toBe(PROVIDER_TRANSPORT_DEADLINE_MS);
    expect(requestDeadlineMs("POST", "/api/imports/file")).toBe(PROVIDER_TRANSPORT_DEADLINE_MS);
    expect(requestDeadlineMs("POST", "/api/sources/abc/extract")).toBe(PROVIDER_TRANSPORT_DEADLINE_MS);
    expect(PROVIDER_TRANSPORT_DEADLINE_MS).toBeGreaterThanOrEqual(120_000);
    expect(PROVIDER_TRANSPORT_DEADLINE_MS).toBeGreaterThan(MUTATION_TRANSPORT_DEADLINE_MS);
  });

  it("keeps transport timeout distinct from offline/cache fallback classification", () => {
    expect(isNetworkUnavailableError(new TransportTimeoutError(1234))).toBe(false);
    expect(isNetworkUnavailableError(new CallerAbortedError("cancelled"))).toBe(false);
  });

  it("removes caller listener and timer after a successful response", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

    await guardedFetch("/api/projects", { method: "GET" }, 1000, controller.signal);

    expect(addSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
