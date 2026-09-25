import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InboxPageDto, ProjectDto, RecordDto, ReviewResultDto } from "@contextkeep/shared";

const { apiFetchMock, notifyErrorMock, navigateMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  notifyErrorMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    useSearch: () => ({ projectId: undefined, page: 1 }),
    useNavigate: () => navigateMock,
  };
});

class TestApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

vi.mock("../src/lib/api.js", () => ({
  apiFetch: apiFetchMock,
  ApiError: TestApiError,
  isNetworkUnavailableError: () => false,
}));
vi.mock("../src/lib/hooks.js", () => ({
  isQueued: () => false,
  notifyError: notifyErrorMock,
  reportQueued: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/offline/mirror.js", () => ({
  inboxKey: ({ projectId, page, limit }: any) => `inbox:${projectId ?? "*"}:${page}:${limit}`,
  readCache: vi.fn(async () => null),
  saveToCache: vi.fn(async () => undefined),
}));
vi.mock("../src/components/VirtualList.js", () => ({
  VirtualList: ({ items, renderRow, emptyText }: any) =>
    React.createElement(
      "div",
      null,
      items.length ? items.map((item: any) => React.createElement(React.Fragment, { key: item.id }, renderRow(item))) : emptyText,
    ),
}));

const { default: Inbox } = await import("../src/pages/Inbox.js");

const project: ProjectDto = {
  id: "project-1",
  name: "Project One",
  aliases: [],
  parentId: null,
  description: null,
  lifecycle: "active",
  lifecycleRecordId: null,
  revision: 1,
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z",
};

function record(revision: number): RecordDto {
  return {
    id: "record-1",
    projectId: project.id,
    projectName: project.name,
    type: "fact",
    subject: "revision-safe review",
    predicate: null,
    valueJson: null,
    text: `Proposal at R${revision}`,
    reviewStatus: "proposed",
    evidenceBasis: "document",
    taskStatus: null,
    recordedAt: "2026-09-23T00:00:00.000Z",
    sourceEventAt: null,
    effectiveFrom: null,
    effectiveTo: null,
    reviewedAt: null,
    reviewDueAt: null,
    volatile: false,
    isOverdue: false,
    revision,
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    evidence: [],
  };
}

function page(revision: number): InboxPageDto {
  return { candidates: [record(revision)], total: 1, byProject: [{ projectId: project.id, projectName: project.name, count: 1 }] };
}

function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Inbox />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  notifyErrorMock.mockReset();
});

afterEach(cleanup);

describe("CK-A01 inbox revision-bound decisions", () => {
  it("captures the displayed revision when selecting and submits items, never bare recordIds", async () => {
    apiFetchMock.mockImplementation(async (url: string, opts?: { body?: unknown }) => {
      if (url === "/api/inbox?limit=50&offset=0") return page(7);
      if (url === "/api/projects") return [project];
      if (url === "/api/inbox/decide") {
        const result: ReviewResultDto = { accepted: ["record-1"], rejected: [], edited: [], blocked: [] };
        return result;
      }
      throw new Error(`unexpected API call ${url} ${JSON.stringify(opts)}`);
    });

    mount();
    const checkbox = await screen.findByRole("checkbox", { name: "Select record record-1" });
    fireEvent.click(checkbox);
    expect(await screen.findByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]!);

    await waitFor(() => {
      const decide = apiFetchMock.mock.calls.find((call) => call[0] === "/api/inbox/decide");
      expect(decide).toBeTruthy();
      expect(decide![1].body).toEqual({
        items: [{ recordId: "record-1", revision: 7 }],
        action: "accept",
      });
      expect((decide![1].body as Record<string, unknown>)["recordIds"]).toBeUndefined();
    });
  });

  it("on stale_revision reloads and clears the old selection instead of applying the new revision", async () => {
    let inboxReads = 0;
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/inbox?limit=50&offset=0") {
        inboxReads += 1;
        return page(inboxReads === 1 ? 7 : 8);
      }
      if (url === "/api/projects") return [project];
      if (url === "/api/inbox/decide") {
        throw new TestApiError(409, "stale_revision", "Record changed; reload and decide again.", { serverRevision: 8 });
      }
      throw new Error(`unexpected API call ${url}`);
    });

    mount();
    const checkbox = await screen.findByRole("checkbox", { name: "Select record record-1" });
    fireEvent.click(checkbox);
    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]!);

    await waitFor(() => expect(inboxReads).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByText("1 selected")).toBeNull());

    const decideCalls = apiFetchMock.mock.calls.filter((call) => call[0] === "/api/inbox/decide");
    expect(decideCalls).toHaveLength(1);
    expect(decideCalls[0]![1].body).toEqual({
      items: [{ recordId: "record-1", revision: 7 }],
      action: "accept",
    });
    expect((await screen.findByRole("checkbox", { name: "Select record record-1" }) as HTMLInputElement).checked).toBe(false);
    expect(notifyErrorMock).toHaveBeenCalledOnce();
  });
});
