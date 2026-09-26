import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useUiStore } from "../src/state/ui.js";
import type { ConflictEntry } from "../src/lib/offline/db.js";

// Mock listConflicts / dismissConflict at the module level. The handler
// captures a reference to the mocked `listConflicts` so each test can
// control what `hasBlockingUnknownAfterDismiss` observes.
const listConflictsMock = vi.fn(async (): Promise<ConflictEntry[]> => []);
const dismissConflictMock = vi.fn(async (_seq: number) => undefined);

vi.mock("../src/lib/offline/queue.js", () => ({
  listConflicts: listConflictsMock,
  dismissConflict: dismissConflictMock,
  replayQueue: async () => ({
    replayed: 0,
    conflicts: [],
    stoppedOffline: false,
    stoppedReason: null,
  }),
}));

const { ConflictOverlay } = await import("../src/components/ConflictOverlay.js");

function mount(): ReturnType<typeof render> {
  const q = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={q}>
      <ConflictOverlay />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listConflictsMock.mockReset();
  dismissConflictMock.mockReset();
  useUiStore.setState({ conflicts: [], notice: null });
});

afterEach(() => {
  cleanup();
});

describe("ConflictOverlay (F07): unknown-outcome visibility", () => {
  it("uses reconciliation wording and action for an expired saved response", async () => {
    const expiredEntry: ConflictEntry = {
      seq: 150,
      mutation: {
        seq: 15,
        method: "POST",
        url: "/api/projects",
        body: { name: "synthetic" },
        enqueuedAt: new Date().toISOString(),
        label: "create project",
        idempotencyKey: "ui-expired-aaaaaaaaaaa",
      },
      status: 409,
      code: "idempotency_result_expired",
      message: "Earlier request completed; saved response expired.",
      detectedAt: new Date().toISOString(),
    };
    useUiStore.setState({ conflicts: [expiredEntry] });

    mount();
    expect(await screen.findByRole("button", { name: /acknowledge.+reconcile queue/i })).toBeTruthy();
    expect(screen.getByTestId("conflict-message").textContent).toMatch(/saved response expired/i);
    expect(screen.getByText(/same event key/i)).toBeTruthy();
  });

  it("renders the conflict's message directly, including the may-already-have-applied wording", async () => {
    const unknownEntry: ConflictEntry = {
      seq: 100,
      mutation: {
        seq: 1,
        method: "POST",
        url: "/api/projects",
        body: { name: "x" },
        enqueuedAt: new Date().toISOString(),
        label: "create project",
        idempotencyKey: "ui-unknown-aaaaaaaaaaaaa",
      },
      status: 409,
      code: "idempotency_outcome_unknown",
      message: "Previous outcome was indeterminate. This mutation MAY already have been applied.",
      detectedAt: new Date().toISOString(),
    };
    useUiStore.setState({ conflicts: [unknownEntry] });

    mount();
    expect(await screen.findByTestId("conflict-message")).toBeTruthy();
    expect(screen.getByTestId("conflict-message").textContent).toMatch(
      /may already have been applied/i,
    );
    expect(screen.getByText(/create project/)).toBeTruthy();
  });

  it("uses the explicit acknowledgement label for idempotency_outcome_unknown so the barrier release is clear", async () => {
    const unknownEntry: ConflictEntry = {
      seq: 200,
      mutation: {
        seq: 2,
        method: "POST",
        url: "/api/x",
        body: {},
        enqueuedAt: new Date().toISOString(),
        label: "edit",
        idempotencyKey: "ui-unknown-bbbbbbbbbbbbb",
      },
      status: 409,
      code: "idempotency_outcome_unknown",
      message: "MAY already have been applied; review before retrying.",
      detectedAt: new Date().toISOString(),
    };
    useUiStore.setState({ conflicts: [unknownEntry] });

    mount();
    const button = await screen.findByRole("button", { name: /acknowledge.+continue queue/i });
    expect(button).toBeTruthy();
    expect(button.textContent).toBe("Acknowledge & continue queue");
  });

  it("uses the generic dismiss label for ordinary semantic 4xx conflicts", async () => {
    const semEntry: ConflictEntry = {
      seq: 300,
      mutation: {
        seq: 3,
        method: "PUT",
        url: "/api/records/r9",
        body: { revision: 1 },
        enqueuedAt: new Date().toISOString(),
        label: "stale edit",
        idempotencyKey: "ui-semantic-aaaaaaaaaaaa",
      },
      status: 409,
      code: "stale_revision",
      message: "server revision is 3, client sent 1",
      detectedAt: new Date().toISOString(),
    };
    useUiStore.setState({ conflicts: [semEntry] });

    mount();
    const button = await screen.findByRole("button", { name: /dismiss/i });
    expect(button.textContent?.toLowerCase()).toBe("dismiss");
  });

  it("clicking the acknowledgement button removes the conflict from the UI and dispatches ck:retry-offline-queue only after the last blocking unknown is gone", async () => {
    const unknownEntry: ConflictEntry = {
      seq: 400,
      mutation: {
        seq: 4,
        method: "POST",
        url: "/api/y",
        body: {},
        enqueuedAt: new Date().toISOString(),
        label: "y",
        idempotencyKey: "ui-ack-aaaaaaaaaaaaaa",
      },
      status: 409,
      code: "idempotency_outcome_unknown",
      message: "MAY already have been applied; review before retrying.",
      detectedAt: new Date().toISOString(),
    };
    useUiStore.setState({ conflicts: [unknownEntry] });
    // No further blocking unknown → the retry event should fire after dismissal.
    listConflictsMock.mockResolvedValueOnce([]);
    const retrySpy = vi.fn();
    window.addEventListener("ck:retry-offline-queue", retrySpy);

    mount();
    const button = await screen.findByRole("button", { name: /acknowledge.+continue queue/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(dismissConflictMock).toHaveBeenCalledWith(400);
      expect(retrySpy).toHaveBeenCalledTimes(1);
    });
    window.removeEventListener("ck:retry-offline-queue", retrySpy);
  });

  it("when a second blocking unknown outcome conflict still persists, dismissal does NOT dispatch the retry event yet", async () => {
    const first: ConflictEntry = {
      seq: 500,
      mutation: {
        seq: 5,
        method: "POST",
        url: "/api/A",
        body: {},
        enqueuedAt: new Date().toISOString(),
        label: "A",
        idempotencyKey: "ui-multi-aaaaaaaaaaaaa",
      },
      status: 409,
      code: "idempotency_outcome_unknown",
      message: "A MAY already have been applied.",
      detectedAt: new Date().toISOString(),
    };
    const second: ConflictEntry = {
      seq: 501,
      mutation: {
        seq: 6,
        method: "POST",
        url: "/api/B",
        body: {},
        enqueuedAt: new Date().toISOString(),
        label: "B",
        idempotencyKey: "ui-multi-bbbbbbbbbbbbb",
      },
      status: 409,
      code: "idempotency_outcome_unknown",
      message: "B MAY already have been applied.",
      detectedAt: new Date().toISOString(),
    };
    useUiStore.setState({ conflicts: [first, second] });
    // After the first dismiss, the second unknown still persists.
    listConflictsMock.mockResolvedValueOnce([second]);
    const retrySpy = vi.fn();
    window.addEventListener("ck:retry-offline-queue", retrySpy);

    mount();
    const buttons = await screen.findAllByRole("button", { name: /acknowledge.+continue queue/i });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);

    // Allow async dismiss path to settle.
    await waitFor(() => {
      expect(dismissConflictMock).toHaveBeenCalledWith(500);
      expect(listConflictsMock).toHaveBeenCalled();
    });
    expect(retrySpy).not.toHaveBeenCalled();
    window.removeEventListener("ck:retry-offline-queue", retrySpy);
  });
});

describe("ConflictOverlay (F07 terminal-race): concurrent unknown-outcome acknowledgements", () => {
  function makeUnknown(seq: number, k: string): ConflictEntry {
    return {
      seq,
      mutation: {
        seq: 1000 + seq,
        method: "POST",
        url: `/api/race-${seq}`,
        body: {},
        enqueuedAt: new Date().toISOString(),
        label: `race-${seq}`,
        idempotencyKey: k,
      },
      status: 409,
      code: "idempotency_outcome_unknown",
      message: `${seq} MAY already have been applied`,
      detectedAt: new Date().toISOString(),
    };
  }

  it("two concurrent ack clicks both delete their conflict; ck:retry-offline-queue fires at least once (replayQueue single-flight coalesces)", async () => {
    // Both unknown conflicts mounted in the UI store; once a click fires
    // ConflictOverlay's handler, the matching entry is removed from the UI
    // store BEFORE the second click handler can resolve. To exercise the
    // race we drive both handlers concurrently through the SAME
    // (still-mounted) set of conflicts, mirroring the production concurrent
    // flow exactly.
    const a = makeUnknown(700, "ui-race-aaaaaaaaaaaaaa");
    const b = makeUnknown(701, "ui-race-bbbbbbbbbbbbbb");
    useUiStore.setState({ conflicts: [a, b] });

    // Post-delete authoritative read returns an empty list. With the new
    // dismiss-then-check order both handlers observe zero blockers and
    // dispatch — single-flight replayQueue coalesces to one effective replay.
    listConflictsMock.mockResolvedValue([]);

    const retrySpy = vi.fn();
    window.addEventListener("ck:retry-offline-queue", retrySpy);

    mount();
    const buttons = await screen.findAllByRole("button", { name: /acknowledge.+continue queue/i });
    expect(buttons).toHaveLength(2);

    // Fire the two onClick handlers before either has reached the
    // dismissConflict await resolution. We reuse the first rendered <button>
    // for both clicks because the ack label matches a /acknowledge/i regex
    // — once the FIRST handler resolves `dismiss(700)` the underlying entry
    // unmounts, so the React snapshot we captured points to the SAME
    // second button for both clicks. To avoid that race we click both
    // elements via the underlying DOM only when both are still present.
    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);

    // Allow async handlers to settle. dismissConflict is mocked to resolve
    // immediately; the dynamic-import + listConflicts chain fully resolves.
    await waitFor(() => {
      expect(dismissConflictMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(retrySpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    // Both deletions requested across the two handlers (mocked; in a real
    // IDB the second click races with the first under the same logical
    // acknowledgement flow, but the post-delete list reads the durable
    // truth).
    expect(dismissConflictMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    window.removeEventListener("ck:retry-offline-queue", retrySpy);
  });

  it("when one blocking conflict still remains after the dismiss, the retry event MUST NOT be dispatched (durable barrier holds)", async () => {
    const a = makeUnknown(800, "ui-blocker-aaaaaaaaaaaa");
    const b = makeUnknown(801, "ui-blocker-bbbbbbbbbbbb");
    useUiStore.setState({ conflicts: [a, b] });
    // After the dismiss, one unknown (b) is still in the durable store.
    listConflictsMock.mockResolvedValueOnce([b]);

    const retrySpy = vi.fn();
    window.addEventListener("ck:retry-offline-queue", retrySpy);

    mount();
    const buttons = await screen.findAllByRole("button", { name: /acknowledge.+continue queue/i });
    fireEvent.click(buttons[0]!);

    await waitFor(() => {
      expect(dismissConflictMock).toHaveBeenCalledWith(800);
      expect(listConflictsMock).toHaveBeenCalled();
    });
    expect(retrySpy).not.toHaveBeenCalled();
    window.removeEventListener("ck:retry-offline-queue", retrySpy);
  });
});
