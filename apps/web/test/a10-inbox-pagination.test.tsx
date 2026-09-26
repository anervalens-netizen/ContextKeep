import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InboxPageDto, ProjectDto, RecordDto, ReviewResultDto } from "@contextkeep/shared";

const { apiFetchMock, navigateMock, routerState } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  navigateMock: vi.fn(),
  routerState: { search: { projectId: undefined as string | undefined, page: 1 } },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    useSearch: () => routerState.search,
    useNavigate: () => navigateMock,
  };
});
vi.mock("../src/lib/api.js", () => ({
  apiFetch: apiFetchMock,
  ApiError: class extends Error {},
  isNetworkUnavailableError: () => false,
}));
vi.mock("../src/lib/hooks.js", () => ({
  isQueued: () => false,
  notifyError: vi.fn(),
  reportQueued: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/offline/mirror.js", () => ({
  inboxKey: ({ projectId, page, limit }: any) => `inbox:${projectId ?? "*"}:${page}:${limit}`,
  readCache: vi.fn(async () => null),
  saveToCacheBestEffort: vi.fn(async () => undefined),
}));
vi.mock("../src/components/VirtualList.js", () => ({
  VirtualList: ({ items, renderRow, emptyText }: any) =>
    React.createElement(
      "div",
      null,
      items.length
        ? items.map((item: any) => React.createElement(React.Fragment, { key: item.id }, renderRow(item)))
        : emptyText,
    ),
}));

const { default: Inbox } = await import("../src/pages/Inbox.js");

const projects: ProjectDto[] = [
  {
    id: "project-1", name: "Project One", aliases: [], parentId: null, description: null,
    lifecycle: "active", lifecycleRecordId: null, revision: 1,
    createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z",
  },
  {
    id: "project-2", name: "Project Two", aliases: [], parentId: null, description: null,
    lifecycle: "active", lifecycleRecordId: null, revision: 1,
    createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z",
  },
];

function record(id: string, revision: number, projectId = "project-1"): RecordDto {
  return {
    id, projectId, projectName: projects.find((p) => p.id === projectId)?.name ?? null,
    type: "fact", subject: id, predicate: null, valueJson: null, text: `Proposal ${id}`,
    reviewStatus: "proposed", evidenceBasis: "document", taskStatus: null,
    recordedAt: "2026-09-23T00:00:00.000Z", sourceEventAt: null, effectiveFrom: null,
    effectiveTo: null, reviewedAt: null, reviewDueAt: null, volatile: false, isOverdue: false,
    revision, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z", evidence: [],
  };
}

function page(candidates: RecordDto[], total: number): InboxPageDto {
  return {
    candidates,
    total,
    byProject: [
      { projectId: "project-1", projectName: "Project One", count: 1055 },
      { projectId: "project-2", projectName: "Project Two", count: 12 },
    ],
  };
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Inbox />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  navigateMock.mockReset();
  routerState.search = { projectId: undefined, page: 1 };
});

afterEach(cleanup);

describe("CK-A10 paginated scoped inbox", () => {
  it("deep-links project/page, shows the real total and select-all sends only current-page revisions", async () => {
    routerState.search = { projectId: "project-1", page: 2 };
    apiFetchMock.mockImplementation(async (url: string, opts?: any) => {
      if (url === "/api/inbox?projectId=project-1&limit=50&offset=50") {
        return page([record("r-51", 7), record("r-52", 8)], 1055);
      }
      if (url === "/api/projects") return projects;
      if (url === "/api/inbox/decide") {
        const out: ReviewResultDto = { accepted: ["r-51", "r-52"], rejected: [], edited: [], blocked: [] };
        return out;
      }
      throw new Error(`unexpected API call ${url} ${JSON.stringify(opts)}`);
    });

    mount();
    expect(await screen.findByText("1055 proposed")).toBeTruthy();
    expect(screen.getByText("Page 2 of 22")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select page" }));
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]!);

    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find((entry) => entry[0] === "/api/inbox/decide");
      expect(call?.[1].body).toEqual({
        items: [
          { recordId: "r-51", revision: 7 },
          { recordId: "r-52", revision: 8 },
        ],
        action: "accept",
      });
    });
  });

  it("project filter navigation resets to page one and never carries selected records across scope", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/inbox?limit=50&offset=0") return page([record("r-1", 2)], 1067);
      if (url === "/api/projects") return projects;
      throw new Error(`unexpected API call ${url}`);
    });

    mount();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select record r-1" }));
    expect(screen.getByText("1 selected")).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: "Project filter" }), {
      target: { value: "project-2" },
    });

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/inbox",
      search: { projectId: "project-2", page: 1 },
      replace: false,
    });
    expect(screen.queryByText("1 selected")).toBeNull();
  });

  it("clamps a now-empty trailing page to the last real page", async () => {
    routerState.search = { projectId: "project-1", page: 23 };
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/inbox?projectId=project-1&limit=50&offset=1100") return page([], 1055);
      if (url === "/api/projects") return projects;
      throw new Error(`unexpected API call ${url}`);
    });

    mount();
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({
        to: "/inbox",
        search: { projectId: "project-1", page: 22 },
        replace: true,
      });
    });
  });
});
