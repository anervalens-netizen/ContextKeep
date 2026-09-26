import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RecordDto, TimelineDto } from "@contextkeep/shared";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("../src/lib/api.js", () => ({ apiFetch: apiFetchMock }));
vi.mock("../src/components/VirtualList.js", () => ({
  VirtualList: ({ items, renderRow, emptyText }: any) =>
    React.createElement(
      "div",
      null,
      items.length
        ? items.map((item: any) =>
            React.createElement(
              React.Fragment,
              { key: item.record.id },
              renderRow(item),
            ),
          )
        : emptyText,
    ),
}));

const { default: ProjectTimeline } =
  await import("../src/components/ProjectTimeline.js");
let client: QueryClient | null = null;

function record(id: string, text: string): RecordDto {
  return {
    id,
    projectId: "project-1",
    projectName: "Synthetic project",
    type: "fact",
    subject: id,
    predicate: null,
    valueJson: null,
    text,
    reviewStatus: "accepted",
    evidenceBasis: "document",
    taskStatus: null,
    recordedAt: "2026-09-23T00:00:00.000Z",
    sourceEventAt: "2026-09-23T00:00:00.000Z",
    effectiveFrom: null,
    effectiveTo: null,
    reviewedAt: null,
    reviewDueAt: null,
    volatile: false,
    isOverdue: false,
    revision: 1,
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    evidence: [
      {
        recordId: id,
        excerptId: `excerpt-${id}`,
        relation: "supports",
        observedAt: null,
        environment: "synthetic",
        artifactRef: null,
        sourceId: "source-1",
        sourceTitle: "Synthetic source",
        startOffset: 0,
        endOffset: 8,
        text: "synthetic evidence",
      },
    ],
  };
}

function page(
  entries: TimelineDto["entries"],
  nextCursor: string | null,
): TimelineDto {
  return {
    projectId: "project-1",
    entries,
    pagination: {
      limit: 50,
      total: 2,
      returned: entries.length,
      hasNext: nextCursor !== null,
      nextCursor,
      snapshotContentVersion: 0,
    },
  };
}

function entry(id: string, text: string) {
  return { record: record(id, text), supersededBy: null, supersedes: [] };
}

function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProjectTimeline projectId="project-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
});
afterEach(() => {
  cleanup();
  client?.clear();
  client = null;
});

describe("ProjectTimeline", () => {
  it("loads bounded pages, preserves evidence, and supports More/Previous navigation", async () => {
    apiFetchMock.mockImplementation(async (url: string | undefined) => {
      if (url === "/api/projects/project-1/timeline?limit=50")
        return page([entry("r-1", "first timeline record")], "cursor-1");
      if (url === "/api/projects/project-1/timeline?limit=50&cursor=cursor-1")
        return page([entry("r-2", "second timeline record")], null);
      return page([entry("r-1", "first timeline record")], "cursor-1");
    });

    mount();
    expect(await screen.findByText("first timeline record")).toBeTruthy();
    expect(screen.getByText(/synthetic evidence/)).toBeTruthy();
    expect(
      screen.getByText("Showing 1 of 2 records · page size 50"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(await screen.findByText("second timeline record")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() =>
      expect(screen.getByText("first timeline record")).toBeTruthy(),
    );
    expect(apiFetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/projects/project-1/timeline?limit=50",
      "/api/projects/project-1/timeline?limit=50&cursor=cursor-1",
      "/api/projects/project-1/timeline?limit=50",
    ]);
  });

  it("restarts with a fresh first page after a concurrent canonical update invalidates the cursor", async () => {
    let changed = false;
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("cursor=")) {
        changed = true;
        throw new Error(
          "Project knowledge changed; restart from the first page.",
        );
      }
      return page(
        [entry("r-1", changed ? "refreshed timeline" : "initial timeline")],
        "old-cursor",
      );
    });
    mount();
    await screen.findByText("initial timeline");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart timeline" }),
    );
    expect(await screen.findByText("refreshed timeline")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("does not reuse another project's page cursor when the parent changes projects", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("project-2"))
        return page([entry("r-3", "other project timeline")], null);
      return page(
        [
          entry(
            "r-1",
            url.includes("cursor=")
              ? "later original page"
              : "first original page",
          ),
        ],
        "cursor-1",
      );
    });
    const view = mount();
    await screen.findByText("first original page");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    await screen.findByText("later original page");
    view.rerender(
      <QueryClientProvider client={client!}>
        <ProjectTimeline projectId="project-2" />
      </QueryClientProvider>,
    );
    await screen.findByText("other project timeline");
    expect(
      apiFetchMock.mock.calls
        .filter(([url]) => String(url).includes("project-2"))
        .map(([url]) => url),
    ).toEqual(["/api/projects/project-2/timeline?limit=50"]);
    expect(
      (screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows a loading state while the bounded read is pending", async () => {
    apiFetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve(page([entry("r-1", "first timeline record")], null)),
            50,
          );
        }),
    );
    mount();
    expect(screen.getByText("Loading timeline…")).toBeTruthy();
    expect(await screen.findByText("first timeline record")).toBeTruthy();
  });
});
