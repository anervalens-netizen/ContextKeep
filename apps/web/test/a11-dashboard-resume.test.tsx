import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock, readCacheMock, saveToCacheMock, clipboardWriteMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  readCacheMock: vi.fn(),
  saveToCacheMock: vi.fn().mockResolvedValue(undefined),
  clipboardWriteMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/lib/api.js", () => ({
  apiFetch: apiFetchMock,
  isNetworkUnavailableError: () => false,
}));
vi.mock("../src/lib/offline/mirror.js", () => ({
  META_DASHBOARD_KEY: "meta:dashboard",
  workContextKey: (id: string) => `work-context:${id}`,
  readCache: readCacheMock,
  saveToCache: saveToCacheMock,
}));
vi.mock("@tanstack/react-router", async () => {
  const ReactModule = await import("react");
  return {
    Link: ({ children, to, search, ...props }: any) =>
      ReactModule.createElement(
        "a",
        {
          href: to,
          "data-search": search ? JSON.stringify(search) : undefined,
          ...props,
        },
        children,
      ),
  };
});

const { ProjectMemoryDashboard } = await import("../src/components/ProjectMemoryDashboard.js");

const context = {
  project: { id: "project-1", name: "ContextKeep" },
  freshness: { canonicalCursor: 17, workingCursor: 46 },
  goals: {
    total: 1,
    truncated: false,
    items: [{
      recordId: "decision-1", revision: 3, sourceType: "decision", subject: "deploy policy",
      text: "Deploy only after exact-head CI.", status: "accepted", provenance: "owner_declaration",
      stale: false, requiresReview: false, evidenceRefs: [{ excerptId: "e1", sourceId: "s1" }], evidenceCount: 1,
    }],
  },
  constraints: {
    total: 1,
    truncated: false,
    items: [{
      recordId: "constraint-1", revision: 2, sourceType: "constraint", subject: "output discipline",
      text: "Keep tool output bounded.", status: "accepted", provenance: "owner_declaration",
      stale: false, requiresReview: false, evidenceRefs: [], evidenceCount: 0,
    }],
  },
  actions: { total: 0, truncated: false, items: [] },
  workingMemory: {
    total: 1,
    truncated: false,
    items: [{
      recordId: "working-1", revision: 1, text: "Unreviewed agent note", recordedAt: "2026-09-23T14:00:00.000Z",
      reviewStatus: "proposed", evidenceBasis: "agent_report", provenance: "agent_report", evidenceCount: 1,
    }],
  },
  latestCheckpoint: {
    recordId: "checkpoint-1",
    revision: 4,
    recordedAt: "2026-09-23T14:40:28.884Z",
    status: "proposed",
    provenance: "agent_report",
    checkpoint: {
      summary: "Lot B delivered",
      outcome: "Runtime healthy",
      nextAction: "Start CK-A10",
      artifactRefs: ["git:ec0a566f", "plain-note"],
    },
  },
  blockerState: {
    activeCount: 1,
    resolvedCount: 0,
    active: [{ blockerId: "b1", text: "Waiting for external proof", checkpointRevision: 4 }],
  },
  indicators: { stale: false, blocked: true, truncated: false, unknown: [] },
};

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProjectMemoryDashboard projectId="project-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  readCacheMock.mockReset();
  saveToCacheMock.mockClear();
  clipboardWriteMock.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWriteMock },
  });
  apiFetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/projects/project-1/work-context") return context;
    if (url === "/api/meta") {
      return {
        appVersion: "0.1.0",
        schemaVersion: 16,
        buildSha: "abcdef1234567890",
        backup: {
          status: "fresh", latestCreatedAt: "2026-09-23T14:00:00.000Z", ageSeconds: 60,
          staleAfterHours: 36, manifestPresent: true, verificationStatus: "verified",
          latestVerifiedAt: "2026-09-23T14:00:00.000Z", latestBackupRestoreTestedAt: "2026-09-23T13:00:00.000Z",
          lastRestoreTestedAt: "2026-09-23T13:00:00.000Z",
        },
      };
    }
    throw new Error(`unexpected ${url}`);
  });
});

afterEach(cleanup);

describe("CK-A11 resume-oriented dashboard", () => {
  it("puts resume state and canonical guardrails ahead of technical cursors and keeps working separate", async () => {
    mount();

    expect(await screen.findByText("Resume from checkpoint")).toBeTruthy();
    expect(screen.getByText("Lot B delivered")).toBeTruthy();
    expect(saveToCacheMock).toHaveBeenCalledWith("work-context:project-1", context, expect.objectContaining({cursor:context.freshness}));
    expect(screen.getByText(/Next action/)).toBeTruthy();
    expect(screen.getByText("Start CK-A10")).toBeTruthy();

    expect(screen.getByText("Deploy only after exact-head CI.")).toBeTruthy();
    expect(screen.getByText("Keep tool output bounded.")).toBeTruthy();
    expect(screen.getByText("Unreviewed agent note")).toBeTruthy();
    expect(screen.getAllByText("proposed").length).toBeGreaterThanOrEqual(2);

    const details = screen.getByText("Technical details").closest("details");
    expect(details).toBeTruthy();
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.textContent).toContain("Canonical cursor 17");
    expect(details?.textContent).toContain("Working cursor 46");
    expect(details?.textContent).toContain("Schema 16");
    expect(details?.textContent).toContain("abcdef12");

    const checkpointLink = screen.getByRole("link", { name: /Open checkpoint record/i });
    expect(checkpointLink.getAttribute("data-search")).toContain("checkpoint-1");
    expect(screen.queryByRole("link", { name: "git:ec0a566f" })).toBeNull();
    expect(screen.getByText("git:ec0a566f")).toBeTruthy();
  });

  it("copies checkpoint identity, revision, timestamp, provenance and trust warning", async () => {
    mount();
    await screen.findByText("Resume from checkpoint");
    fireEvent.click(screen.getByRole("button", { name: "Copy context" }));

    await waitFor(() => expect(clipboardWriteMock).toHaveBeenCalledOnce());
    const copied = String(clipboardWriteMock.mock.calls[0]?.[0]);
    expect(copied).toContain("checkpoint-1");
    expect(copied).toContain("revision: 4");
    expect(copied).toContain("2026-09-23T14:40:28.884Z");
    expect(copied).toContain("provenance: agent_report");
    expect(copied).toContain("WARNING: checkpoint is proposed");
  });

  it("keeps resume text selectable when clipboard access is denied", async () => {
    mount();
    await screen.findByText("Resume from checkpoint");
    clipboardWriteMock.mockRejectedValueOnce(new Error("clipboard denied"));
    fireEvent.click(screen.getByRole("button", { name: "Copy context" }));

    const fallback = await screen.findByRole("textbox", { name: "Selectable resume text" });
    expect((fallback as HTMLTextAreaElement).value).toContain("Project: ContextKeep");
  });

  it("loads compact checkpoint artifacts lazily from the authenticated record endpoint", async () => {
    const compact = {
      ...context,
      latestCheckpoint: {
        ...context.latestCheckpoint,
        checkpoint: { ...context.latestCheckpoint.checkpoint, artifactRefs: undefined, artifactRefCount: 2 },
      },
    };
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/projects/project-1/work-context") return compact;
      if (url === "/api/meta") return { appVersion: "0.1.0", schemaVersion: 16 };
      if (url === "/api/records/checkpoint-1") return { valueJson: { kind: "working_checkpoint", artifactRefs: ["full:one", "full:two"] } };
      throw new Error(`unexpected ${url}`);
    });
    mount();
    await screen.findByText("Resume from checkpoint");
    fireEvent.click(screen.getByRole("button", { name: /Load 2 checkpoint artifacts/i }));
    expect(await screen.findByText("full:one")).toBeTruthy();
    expect(apiFetchMock).toHaveBeenCalledWith("/api/records/checkpoint-1", { noQueue: true });
  });
});

// Independent CV06 review: feedback must describe the payload actually copied.
it("offers the selected artifact, not an unrelated resume, when artifact copy is denied", async () => {
  mount();
  await screen.findByText("Resume from checkpoint");
  clipboardWriteMock.mockRejectedValueOnce(new Error("clipboard denied"));
  fireEvent.click(screen.getByRole("button", { name: "Copy artifact reference plain-note" }));
  const fallback = await screen.findByRole("textbox", { name: "Selectable artifact reference" });
  expect((fallback as HTMLTextAreaElement).value).toBe("plain-note");
  expect(screen.getByText(/Clipboard unavailable/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy context" })).toBeTruthy();
});

it("does not claim the resume was copied after copying only an artifact reference", async () => {
  mount();
  await screen.findByText("Resume from checkpoint");
  fireEvent.click(screen.getByRole("button", { name: "Copy artifact reference plain-note" }));
  await waitFor(() => expect(clipboardWriteMock).toHaveBeenCalledWith("plain-note"));
  expect(screen.getByRole("button", { name: "Copy context" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy artifact reference plain-note" }).textContent).toBe("Copied");
});
