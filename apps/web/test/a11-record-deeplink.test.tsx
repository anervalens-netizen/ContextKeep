import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordDto } from "@contextkeep/shared";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock("../src/lib/api.js", async (importOriginal) => {
  const original = await importOriginal<any>();
  return { ...original, apiFetch: apiFetchMock };
});
vi.mock("@tanstack/react-router", async () => {
  const ReactModule = await import("react");
  return {
    Link: ({ children, to, ...props }: any) =>
      ReactModule.createElement("a", { href: to, ...props }, children),
    useParams: () => ({ projectId: "project-1" }),
    useSearch: () => ({ recordId: undefined }),
  };
});

const { RecordDeepLink, recordDeepLinkErrorMessage } = await import("../src/pages/ProjectDetail.js");
const record: RecordDto = {
  id: "record-1",
  projectId: "project-1",
  projectName: "Project One",
  type: "fact",
  subject: "resume evidence",
  predicate: null,
  valueJson: null,
  text: "Exact record text",
  reviewStatus: "accepted",
  evidenceBasis: "owner_declaration",
  taskStatus: null,
  recordedAt: "2026-09-23T14:00:00.000Z",
  sourceEventAt: null,
  effectiveFrom: null,
  effectiveTo: null,
  reviewedAt: "2026-09-23T14:05:00.000Z",
  reviewDueAt: null,
  volatile: false,
  isOverdue: false,
  revision: 2,
  createdAt: "2026-09-23T14:00:00.000Z",
  updatedAt: "2026-09-23T14:05:00.000Z",
  evidence: [{
    recordId: "record-1",
    excerptId: "excerpt-1",
    relation: "supports",
    observedAt: "2026-09-23T13:59:00.000Z",
    environment: null,
    artifactRef: null,
    sourceId: "source-1",
    sourceTitle: "Evidence source",
    startOffset: 0,
    endOffset: 15,
    text: "Evidence excerpt",
  }],
};

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RecordDeepLink projectId="project-1" recordId="record-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => apiFetchMock.mockReset());
afterEach(cleanup);

describe("CK-A11 record/evidence deep link", () => {
  it("opens the exact record and its existing evidence without changing review state", async () => {
    apiFetchMock.mockResolvedValue(record);
    mount();

    expect(await screen.findByText("Exact record text")).toBeTruthy();
    expect(screen.getByText(/1 evidence excerpt/)).toBeTruthy();
    expect(apiFetchMock).toHaveBeenCalledWith("/api/records/record-1", { noQueue: true });
  });

  it("explains a missing/deleted record instead of treating it as an offline failure", () => {
    const message = recordDeepLinkErrorMessage(
      Object.assign(new Error("missing"), { status: 404, code: "record_not_found" }),
    );
    expect(message).toMatch(/Record not found in the current store/i);
    expect(message).not.toMatch(/unavailable offline/i);
  });
});
