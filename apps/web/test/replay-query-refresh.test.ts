import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replayQueue: vi.fn(),
  listMutations: vi.fn(),
  listConflicts: vi.fn(),
  invalidateQueries: vi.fn(),
  scheduleOfflineRetry: vi.fn(),
  ui: {
    setQueuedCount: vi.fn(),
    setConflicts: vi.fn(),
    setNotice: vi.fn(),
    setOffline: vi.fn(),
    setUpdateReady: vi.fn(),
  },
}));
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: vi.fn() }),
}));
vi.mock("../src/router.js", () => ({ router: {} }));
vi.mock("../src/lib/queryClient.js", () => ({
  queryClient: { invalidateQueries: mocks.invalidateQueries },
}));
vi.mock("../src/state/ui.js", () => ({
  useUiStore: { getState: () => mocks.ui },
}));
vi.mock("../src/state/theme.js", () => ({
  useThemeStore: { getState: () => ({ init: vi.fn() }) },
}));
vi.mock("../src/lib/pwa.js", () => ({ initPwa: vi.fn() }));
vi.mock("../src/lib/offline/local-data-state.js", () => ({
  isLocalDataAccessPaused: () => false,
}));
vi.mock("../src/lib/offline/queue.js", () => ({
  replayQueue: mocks.replayQueue,
  listMutations: mocks.listMutations,
  listConflicts: mocks.listConflicts,
}));
vi.mock("../src/lib/offline/scheduler.js", () => ({
  scheduleOfflineRetry: mocks.scheduleOfflineRetry,
  cancelOfflineRetry: vi.fn(),
}));

const listeners = new Map<string, EventListenerOrEventListenerObject>();
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  listeners.clear();
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  mocks.listMutations.mockResolvedValue([]);
  mocks.listConflicts.mockResolvedValue([]);
  mocks.invalidateQueries.mockResolvedValue(undefined);
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener) => {
    if (listener) listeners.set(type, listener);
  });
  await import("../src/main.js");
  await vi.waitFor(() => expect(mocks.ui.setConflicts).toHaveBeenCalled());
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function reconnect(): Promise<void> {
  const listener = listeners.get("online");
  expect(listener).toBeDefined();
  const event = new Event("online");
  if (typeof listener === "function") listener.call(window, event);
  else listener!.handleEvent(event);
  await vi.waitFor(() => expect(mocks.ui.setNotice).toHaveBeenCalled());
}

describe("successful offline prefixes refresh queries independently of stop notices", () => {
  it.each([
    "auth",
    "forbidden",
    "rate_limit",
    "idempotency_in_progress",
    "transport_timeout",
    "caller_abort",
    "response_invalid",
    "idempotency_outcome_unknown",
    "idempotency_result_expired",
  ])(
    "refreshes an applied prefix when replay stops with %s",
    async (stoppedReason) => {
      mocks.replayQueue.mockResolvedValue({
        replayed: 2,
        stoppedReason,
        retryAfterMs: 500,
      });
      mocks.listMutations.mockResolvedValue([{ seq: 3 }]);
      await reconnect();
      expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
      expect(mocks.ui.setQueuedCount).toHaveBeenLastCalledWith(1);
      expect(mocks.ui.setNotice.mock.lastCall?.[0].kind).not.toBe("success");
      if (["rate_limit", "idempotency_in_progress"].includes(stoppedReason)) {
        expect(mocks.scheduleOfflineRetry).toHaveBeenCalledWith(500);
      }
    },
  );

  it("refreshes an applied prefix even when a remaining conflict needs attention", async () => {
    mocks.replayQueue.mockResolvedValue({ replayed: 1 });
    mocks.listConflicts.mockResolvedValue([
      { seq: 2, message: "Synthetic conflict" },
    ]);
    await reconnect();
    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(mocks.ui.setNotice.mock.lastCall?.[0].kind).toBe("error");
  });

  it("refreshes once for a completely replayed queue", async () => {
    mocks.replayQueue.mockResolvedValue({ replayed: 2 });
    await reconnect();
    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(mocks.ui.setNotice.mock.lastCall?.[0].kind).toBe("success");
  });

  it.each(["auth", "forbidden", "rate_limit", "idempotency_outcome_unknown"])(
    "does not refresh without applied operations when stopped with %s",
    async (stoppedReason) => {
      mocks.replayQueue.mockResolvedValue({
        replayed: 0,
        stoppedReason,
        retryAfterMs: 500,
      });
      await reconnect();
      expect(mocks.invalidateQueries).not.toHaveBeenCalled();
    },
  );

  it("refreshes confirmed changes even if subsequent local queue inspection fails", async () => {
    mocks.replayQueue.mockResolvedValue({ replayed: 1 });
    mocks.listMutations.mockRejectedValueOnce(
      new Error("Synthetic storage failure"),
    );
    await reconnect();
    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(mocks.ui.setNotice.mock.lastCall?.[0].text).toMatch(
      /local browser data is unavailable/i,
    );
  });
});
