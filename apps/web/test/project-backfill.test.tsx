import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SyncPlanDto, SyncRunResultDto, SyncStatusDto } from "@contextkeep/shared";

/**
 * Project history backfill UI (M-history-backfill).
 *
 * Covers the owner-visible guarantees of durable bounded backfill:
 *  - one run is large enough to avoid repeated owner-driven batches but remains bounded;
 *  - a finished run reports WHY each artifact failed, not just a count;
 *  - a run still executing on the server blocks a second import;
 *  - a run recovered after reload/disconnect is shown, and only for THIS project.
 */

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("../src/lib/api.js", () => ({
  apiFetch: apiFetchMock,
  ApiError: class ApiError extends Error {},
}));
vi.mock("@tanstack/react-router", async () => {
  const ReactModule = await import("react");
  return {
    Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) =>
      ReactModule.createElement("a", { href: to, ...props }, children),
  };
});

const { ProjectHistoryBackfill } = await import("../src/components/ProjectHistoryBackfill.js");

const PROJECT_ID = "03912070-9bda-4c74-a547-dde0822821b1";
const OTHER_PROJECT_ID = "0f0e0d0c-0b0a-4a09-8807-060504030201";

type RunOverrides = {
  projectId?: string | null;
  dryRun?: boolean;
  errors?: SyncRunResultDto["errors"];
  counts?: Partial<SyncRunResultDto["counts"]>;
  selected?: number;
  plannedExtract?: number;
  plannedArchive?: number;
};

function plan(overrides: RunOverrides = {}): SyncPlanDto {
  return {
    projectId: overrides.projectId === undefined ? PROJECT_ID : overrides.projectId,
    connector: "both",
    mode: "archiveAndExtract",
    extractionAdapterId: "deepseek",
    idleMinutes: 30,
    maxArtifacts: 25,
    maxChars: 250_000,
    maxCostUsd: 0.1,
    discovered: 392,
    eligible: 392,
    unlinked: 0,
    unchanged: 0,
    selected: overrides.selected ?? 25,
    plannedArchive: overrides.plannedArchive ?? 25,
    plannedExtract: overrides.plannedExtract ?? 25,
    deferredByArtifactLimit: 367,
    deferredByCharBudget: 0,
    deferredByCostBudget: 0,
    estimateErrors: 0,
    totalSafeChars: 18_000,
    totalEstimatedCostUsd: 0.0442,
    items: [],
  };
}

function syncResult(overrides: RunOverrides = {}): SyncRunResultDto {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    dryRun: overrides.dryRun ?? true,
    startedAt: "2026-09-12T17:21:08.000Z",
    finishedAt: "2026-09-12T17:26:17.000Z",
    plan: plan(overrides),
    counts: {
      archivedCreated: 0,
      archivedUnchanged: 0,
      extractedCreated: 0,
      extractionUnchanged: 0,
      skippedUnlinked: 0,
      skippedUnchanged: 0,
      deferredBudget: 0,
      failed: 0,
      ...overrides.counts,
    },
    errors: overrides.errors ?? [],
  };
}

function status(overrides: Partial<SyncStatusDto> = {}): SyncStatusDto {
  return {
    running: false,
    intervalEnabled: false,
    intervalMinutes: 0,
    scheduledMode: "archiveOnly",
    lastScanAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastResult: null,
    ...overrides,
  };
}

const TRUNCATED = {
  code: "deepseek_output_truncated",
  message:
    "DeepSeek stopped at the output token bound (32768); the extraction is truncated and was discarded. Raise CK_DEEPSEEK_MAX_OUTPUT_TOKENS or shorten the input.",
};

function renderBackfill(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProjectHistoryBackfill projectId={PROJECT_ID} sessionCount={12} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  apiFetchMock.mockReset();
});

describe("project history backfill UI", () => {
  it("requests one bounded run (maxArtifacts = 25) while preserving total cost and text ceilings", async () => {
    let body: Record<string, unknown> | null = null;
    apiFetchMock.mockImplementation(async (url: string, opts?: { body?: Record<string, unknown> }) => {
      if (url === "/api/sync/status") return status();
      if (url === "/api/sync/run") {
        body = opts?.body ?? null;
        return syncResult();
      }
      throw new Error(`unexpected ${url}`);
    });
    renderBackfill();

    expect(screen.getByText(/Up to 25 linked Codex\/DSH artifacts/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Preview history/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.maxArtifacts).toBe(25);
    // Everything else about the bounded, project-scoped contract is unchanged.
    expect(body!.projectId).toBe(PROJECT_ID);
    expect(body!.maxCostUsd).toBe(0.1);
    expect(body!.maxChars).toBe(250_000);
    expect(body!.mode).toBe("archiveAndExtract");
    expect(body!.allowUnassignedArchive).toBe(false);
    expect(body!.dryRun).toBe(true);

    // The preview reports the plan the owner will execute.
    await waitFor(() => expect(screen.getByText("25/25")).toBeTruthy());
  });

  it("shows the server-side code AND message for every failed artifact", async () => {
    const failures = [
      { key: "codex:session-aaaa", ...TRUNCATED },
      { key: "codex:session-bbbb", ...TRUNCATED },
      { key: "codex:session-cccc", code: "cost_ceiling_exceeded", message: "Provider cost estimate $0.0612 exceeds the cost ceiling ($0.05 USD) for adapter \"deepseek\"." },
    ];
    apiFetchMock.mockImplementation(async (url: string, opts?: { body?: Record<string, unknown> }) => {
      if (url === "/api/sync/status") return status();
      if (url === "/api/sync/run") {
        return opts?.body?.dryRun === false
          ? syncResult({
              dryRun: false,
              errors: failures,
              counts: { archivedCreated: 3, extractedCreated: 0, failed: 3 },
            })
          : syncResult();
      }
      throw new Error(`unexpected ${url}`);
    });
    renderBackfill();

    fireEvent.click(screen.getByRole("button", { name: /Preview history/i }));
    const importButton = await screen.findByRole("button", { name: /Import this run/i });
    fireEvent.click(importButton);

    await waitFor(() => expect(screen.getByText("Run finished")).toBeTruthy());
    // Counts.
    expect(screen.getByText(/0 extracted · 3 archived · 3 failed\./)).toBeTruthy();
    // Every failure is individually explained — code and message, not a bare count.
    expect(screen.getAllByText("deepseek_output_truncated")).toHaveLength(2);
    expect(screen.getByText("cost_ceiling_exceeded")).toBeTruthy();
    expect(screen.getAllByText(TRUNCATED.message)).toHaveLength(2);
    expect(screen.getByText(/exceeds the cost ceiling/)).toBeTruthy();
    expect(document.querySelectorAll("[data-import-error]")).toHaveLength(3);
  });

  it("disables preview and import while the server reports a run in progress", async () => {
    let current = status();
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/sync/status") return current;
      if (url === "/api/sync/run") return syncResult();
      throw new Error(`unexpected ${url}`);
    });
    renderBackfill();

    // Preview first, so the Import button exists and can be observed.
    fireEvent.click(screen.getByRole("button", { name: /Preview history/i }));
    await screen.findByRole("button", { name: /Import this run/i });

    // The server is now busy with a run this page did not start (or lost).
    current = status({ running: true });
    // Any status refetch re-renders against the live server view.
    fireEvent.click(screen.getByRole("button", { name: /Refresh preview/i }));

    await waitFor(() =>
      expect(screen.getByText(/Import running on server… progress is durable and can be recovered after a reload\./)).toBeTruthy(),
    );
    expect((screen.getByRole("button", { name: /Import this run/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Refresh preview/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("recovers the last finished run for this project after a reload, including failures", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/sync/status") {
        return status({
          lastResult: syncResult({
            dryRun: false,
            errors: [{ key: "codex:session-aaaa", ...TRUNCATED }],
            counts: { archivedCreated: 3, extractedCreated: 0, failed: 1 },
          }),
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    renderBackfill();

    // No click, no request replay: the finished run is recovered from status.
    await waitFor(() => expect(screen.getByText("Run finished")).toBeTruthy());
    expect(screen.getByText(/0 extracted · 3 archived · 1 failed\./)).toBeTruthy();
    expect(screen.getByText("deepseek_output_truncated")).toBeTruthy();
    expect(screen.getByText(TRUNCATED.message)).toBeTruthy();
    // Recovery never re-runs anything.
    expect(apiFetchMock.mock.calls.filter((c) => c[0] === "/api/sync/run")).toHaveLength(0);
  });

  it("never shows a lastResult belonging to another project, a global run, or a preview", async () => {
    const foreign = syncResult({ projectId: OTHER_PROJECT_ID, dryRun: false });
    const global = syncResult({ projectId: null, dryRun: false });
    const preview = syncResult({ dryRun: true });

    for (const lastResult of [foreign, global, preview]) {
      let resolveStatus: (value: SyncStatusDto) => void = () => undefined;
      const pending = new Promise<SyncStatusDto>((resolve) => {
        resolveStatus = resolve;
      });
      apiFetchMock.mockImplementation(async (url: string) => {
        if (url === "/api/sync/status") return pending;
        throw new Error(`unexpected ${url}`);
      });
      renderBackfill();
      // Nothing can be displayed before status resolves.
      expect(document.querySelector("[data-import-result]")).toBeNull();
      await act(async () => {
        resolveStatus(status({ lastResult }));
        await pending;
      });
      // Status has resolved and React has flushed: a wrong implementation
      // would have rendered the result card by now.
      expect(document.querySelector("[data-import-result]")).toBeNull();
      expect(screen.queryByText("Run finished")).toBeNull();
      expect(screen.queryByText("deepseek_output_truncated")).toBeNull();
      cleanup();
      apiFetchMock.mockReset();
    }
  });
});
