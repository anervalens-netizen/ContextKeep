import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, QueuedUnknownOutcomeError } from "../src/lib/api.js";
import { isQueued, reportQueued } from "../src/lib/hooks.js";
import { offlineDb } from "../src/lib/offline/db.js";
import { useUiStore } from "../src/state/ui.js";
import {
  enqueueMutation,
  listMutations,
  MAX_TRANSPORT_TIMEOUT_AUTO_RETRIES,
  replayQueue,
} from "../src/lib/offline/queue.js";
import {
  cancelOfflineRetry,
  getOfflineRetryAttempt,
  hasPendingOfflineRetry,
  resetOfflineRetryBudget,
} from "../src/lib/offline/scheduler.js";

function controlledHungFetch(calls: RequestInit[]): {
  fetch: typeof fetch;
  waitForCall: (count: number) => Promise<void>;
} {
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const notify = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]!;
      if (calls.length >= waiter.count) {
        waiters.splice(i, 1);
        waiter.resolve();
      }
    }
  };
  const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init ?? {});
    notify();
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
  return {
    fetch,
    waitForCall(count: number): Promise<void> {
      if (calls.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push({ count, resolve }));
    },
  };
}

beforeEach(async () => {
  const db = await offlineDb();
  await db.clear("mutations");
  await db.clear("conflicts");
  await db.clear("cache");
  cancelOfflineRetry();
  resetOfflineRetryBudget();
  document.cookie = "ck_csrf=test-csrf-token";
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

afterEach(() => {
  cancelOfflineRetry();
  resetOfflineRetryBudget();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CK-A07 durable timeout reconciliation", () => {
  it("foreground write timeout preserves same-key intent and schedules bounded reconciliation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const calls: RequestInit[] = [];
    const hung = controlledHungFetch(calls);
    globalThis.fetch = hung.fetch;

    const pending = apiFetch("/api/records/r-timeout", {
      method: "PUT",
      body: { text: "intent" },
      deadlineMs: 25,
      label: "timeout intent",
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "QueuedUnknownOutcomeError",
      reason: "timeout",
      unknownOutcome: true,
    });

    await hung.waitForCall(1);
    await vi.advanceTimersByTimeAsync(25);
    await rejected;

    const rows = await listMutations();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveryState).toBe("queued");
    const key = rows[0]!.idempotencyKey!;
    expect(key).toBeTruthy();
    expect(calls[0]!.headers).toMatchObject({ "idempotency-key": key });
    expect(getOfflineRetryAttempt(key)).toBe(1);
    expect(hasPendingOfflineRetry()).toBe(true);
  });

  it("replay timeout retries the exact same key and a later success clears one logical intent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const key = "cka07-same-key-reconcile-0001";
    await enqueueMutation({
      method: "PUT",
      url: "/api/records/r1",
      body: { text: "once" },
      enqueuedAt: new Date().toISOString(),
      idempotencyKey: key,
    });

    const seenKeys: string[] = [];
    const firstCalls: RequestInit[] = [];
    const firstHung = controlledHungFetch(firstCalls);
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      seenKeys.push(String((init?.headers as Record<string, string> | undefined)?.["idempotency-key"]));
      return firstHung.fetch(input, init);
    }) as unknown as typeof fetch;

    const first = replayQueue({ deadlineMs: 20 });
    await firstHung.waitForCall(1);
    await vi.advanceTimersByTimeAsync(20);
    await expect(first).resolves.toMatchObject({ stoppedReason: "transport_timeout", replayed: 0 });
    cancelOfflineRetry();

    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenKeys.push(String((init?.headers as Record<string, string> | undefined)?.["idempotency-key"]));
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "r1", revision: 2 }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const second = await replayQueue({ deadlineMs: 20 });
    expect(second.replayed).toBe(1);
    expect(await listMutations()).toEqual([]);
    expect(seenKeys).toEqual([key, key]);
    expect(getOfflineRetryAttempt(key)).toBe(0);
  });

  it("caps automatic timeout retries while keeping the row visible and recoverable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const key = "cka07-retry-cap-0000000001";
    await enqueueMutation({
      method: "POST",
      url: "/api/imports/text",
      body: { text: "slow" },
      enqueuedAt: new Date().toISOString(),
      idempotencyKey: key,
    });

    const calls: RequestInit[] = [];
    const hung = controlledHungFetch(calls);
    globalThis.fetch = hung.fetch;

    for (let attempt = 1; attempt <= MAX_TRANSPORT_TIMEOUT_AUTO_RETRIES; attempt++) {
      const pending = replayQueue({ deadlineMs: 10 });
      await hung.waitForCall(attempt);
      await vi.advanceTimersByTimeAsync(10);
      const result = await pending;
      expect(result.stoppedReason).toBe("transport_timeout");
      expect(result.retryBudgetExhausted).toBe(false);
      expect(result.retryAttempt).toBe(attempt);
      expect(hasPendingOfflineRetry()).toBe(true);
      cancelOfflineRetry();
    }

    const exhausted = replayQueue({ deadlineMs: 10 });
    await hung.waitForCall(MAX_TRANSPORT_TIMEOUT_AUTO_RETRIES + 1);
    await vi.advanceTimersByTimeAsync(10);
    const exhaustedResult = await exhausted;
    expect(exhaustedResult.stoppedReason).toBe("transport_timeout");
    expect(exhaustedResult.retryBudgetExhausted).toBe(true);
    expect(exhaustedResult.retryAttempt).toBe(MAX_TRANSPORT_TIMEOUT_AUTO_RETRIES + 1);
    expect(hasPendingOfflineRetry()).toBe(false);

    const rows = await listMutations();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotencyKey).toBe(key);
    expect(rows[0]!.transportTimeoutAttempts).toBe(MAX_TRANSPORT_TIMEOUT_AUTO_RETRIES + 1);
    expect(calls).toHaveLength(MAX_TRANSPORT_TIMEOUT_AUTO_RETRIES + 1);
  });

  it("caller abort after send is distinct, preserves intent, and does not arm blind retry", async () => {
    const key = "cka07-caller-abort-00000001";
    await enqueueMutation({
      method: "PUT",
      url: "/api/records/r2",
      body: { text: "cancelled after send" },
      enqueuedAt: new Date().toISOString(),
      idempotencyKey: key,
    });
    const calls: RequestInit[] = [];
    const hung = controlledHungFetch(calls);
    globalThis.fetch = hung.fetch;
    const controller = new AbortController();

    const pending = replayQueue({ signal: controller.signal, deadlineMs: 5000 });
    await hung.waitForCall(1);
    controller.abort("owner cancelled");
    const result = await pending;

    expect(result.stoppedReason).toBe("caller_abort");
    expect(hasPendingOfflineRetry()).toBe(false);
    const rows = await listMutations();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotencyKey).toBe(key);
    expect(calls).toHaveLength(1);
  });

  it("exposes foreground timeout as queued unknown outcome with distinct UI copy", async () => {
    const error = new QueuedUnknownOutcomeError(7, "timeout");
    expect(error.unknownOutcome).toBe(true);
    expect(error.message).toMatch(/may already have applied|may still have completed/i);
    expect(error.message).not.toMatch(/connection returns/i);
    expect(isQueued(error)).toBe(true);

    await reportQueued(error, "Saving record");
    const notice = useUiStore.getState().notice;
    expect(notice?.kind).toBe("queued");
    expect(notice?.text).toMatch(/timed out|outcome/i);
    expect(notice?.text).toMatch(/may already|reconcil/i);
    expect(notice?.text).not.toMatch(/connection returns/i);
  });
});
