import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { McpSearchResultDto, SearchResultDto } from "@contextkeep/shared";
import { projects, records } from "../src/db/schema.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const token = randomUUID();
const apps: TestApp[] = [];
const day = "2024-02-29";
const when = day + "T12:00:00.000Z";
afterEach(async () => {
  for (const app of apps.splice(0)) await app.cleanup();
});

async function fixture() {
  const app = await makeTestApp({ mcpToken: token });
  apps.push(app);
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  for (const id of [projectId, otherProjectId]) {
    app.app.ck.deps.db
      .insert(projects)
      .values({
        id,
        name: "Synthetic scope " + id,
        createdAt: when,
        updatedAt: when,
      })
      .run();
  }
  const add = (fields: Partial<typeof records.$inferInsert> = {}) => {
    const id = randomUUID();
    app.app.ck.deps.db
      .insert(records)
      .values({
        id,
        projectId,
        type: "fact",
        subject: "searchfilter synthetic " + id,
        text: "searchfilter deployment fixture",
        evidenceBasis: "document",
        reviewStatus: "accepted",
        recordDedupHash: id,
        recordedAt: when,
        createdAt: when,
        updatedAt: when,
        sourceEventAt: "2018-06-15T00:00:00.000Z",
        effectiveFrom: "2030-01-01T00:00:00.000Z",
        ...fields,
      })
      .run();
    return id;
  };
  return { app, projectId, otherProjectId, add };
}

async function mcp(app: TestApp, args: Record<string, unknown>) {
  const response = await app.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: "Bearer " + token,
      accept: "application/json, text/event-stream",
    },
    payload: {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: {
        name: "search_context",
        arguments: { q: "searchfilter", compact: true, ...args },
      },
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json().result;
}
const ids = (rows: { recordId: string }[]) =>
  rows.map((r) => r.recordId).sort();

describe("ME-13 shared MCP scoped search filters", () => {
  it("matches HTTP on accepted and working records, inclusive UTC dates and type", async () => {
    const { app, projectId, otherProjectId, add } = await fixture();
    const accepted = [
      add({ recordedAt: "2024-02-29T00:00:00.000Z" }),
      add({ recordedAt: "2024-02-29T23:59:59.999Z" }),
    ];
    const working = [
      add({
        recordedAt: "2024-02-29T00:00:00.000Z",
        reviewStatus: "proposed",
        evidenceBasis: "agent_report",
      }),
      add({
        recordedAt: "2024-02-29T23:59:59.999Z",
        reviewStatus: "proposed",
        evidenceBasis: "agent_report",
      }),
    ];
    add({ recordedAt: "2024-02-28T23:59:59.999Z" });
    add({ recordedAt: "2024-03-01T00:00:00.000Z" });
    add({ type: "decision" });
    add({ reviewStatus: "superseded" });
    add({ projectId: otherProjectId });
    add({ reviewStatus: "proposed", evidenceBasis: "document" });
    const filter = {
      projectId,
      recordType: "fact",
      recordedFrom: day,
      recordedTo: day,
      scope: "all",
      limit: 15,
    };
    const result = await mcp(app, filter);
    expect(result.isError).not.toBe(true);
    const parsed = McpSearchResultDto.parse(result.structuredContent);
    const http = await app.get(
      "/api/search?" +
        new URLSearchParams({
          q: "searchfilter",
          mode: "canonical",
          scope: "all",
          ...filter,
          limit: "15",
        }),
    );
    expect(http.statusCode).toBe(200);
    const rest = SearchResultDto.parse(http.json());
    expect(ids(parsed.records)).toEqual(accepted.sort());
    expect(ids(parsed.workingRecords)).toEqual(working.sort());
    expect(ids(parsed.records)).toEqual(rest.records.map((r) => r.id).sort());
    expect(ids(parsed.workingRecords)).toEqual(
      rest.workingRecords.map((r) => r.id).sort(),
    );
    expect(parsed.records.every((r) => r.reviewStatus === "accepted")).toBe(
      true,
    );
    expect(
      parsed.workingRecords.every(
        (r) => r.reviewStatus === "proposed" && r.provenance === "agent_report",
      ),
    ).toBe(true);
    expect(parsed.completeness.records.mayHaveMore).toBe(false);
    expect(parsed.completeness.workingRecords.mayHaveMore).toBe(false);
    expect(parsed).not.toHaveProperty("canonicalRecords");
    const decision = await mcp(app, { ...filter, recordType: "decision" });
    expect(decision.isError).not.toBe(true);
    expect(decision.structuredContent.records).toHaveLength(1);
    expect(decision.structuredContent.workingRecords).toHaveLength(0);
    const historical = await mcp(app, {
      projectId,
      includeHistorical: true,
      recordType: "fact",
    });
    expect(historical.isError).not.toBe(true);
    expect(
      historical.structuredContent.records.some(
        (r: { reviewStatus: string }) => r.reviewStatus === "superseded",
      ),
    ).toBe(true);
  });

  it("uses recordedAt, not event/effective timestamps, and keeps unfiltered compatibility", async () => {
    const { app, projectId, add } = await fixture();
    const id = add();
    const base = await mcp(app, { projectId });
    expect(base.isError).not.toBe(true);
    expect(ids(base.structuredContent.records)).toContain(id);
    const recorded = await mcp(app, {
      projectId,
      recordedFrom: day,
      recordedTo: day,
    });
    expect(ids(recorded.structuredContent.records)).toContain(id);
    for (const date of ["2018-06-15", "2030-01-01"]) {
      const wrongAxis = await mcp(app, {
        projectId,
        recordedFrom: date,
        recordedTo: date,
      });
      expect(wrongAxis.isError).not.toBe(true);
      expect(wrongAxis.structuredContent.records).toEqual([]);
    }
    const legacy = await mcp(app, { projectId, compact: false });
    expect(legacy.structuredContent.canonicalRecords).toEqual(
      legacy.structuredContent.records,
    );
  });

  it("matches offset timestamps by inclusive UTC recorded day, not literal local day", async () => {
    const { app, projectId, add } = await fixture();
    const early = add({ recordedAt: "2024-02-28T22:00:00-02:00" });
    const late = add({ recordedAt: "2024-03-01T01:59:59.999+02:00" });
    const out = await mcp(app, {
      projectId,
      recordedFrom: day,
      recordedTo: day,
    });
    expect(out.isError).not.toBe(true);
    expect(ids(out.structuredContent.records)).toEqual([early, late].sort());
    expect(out.structuredContent.records).toHaveLength(2);
  });

  it("fails closed for reversed, malformed and unsupported inputs without business-state writes", async () => {
    const { app, projectId, add } = await fixture();
    add();
    const before = app.app.ck.deps.sqlite
      .prepare("SELECT * FROM records ORDER BY id")
      .all();
    for (const bad of [
      "",
      "2024-02-30",
      "2024-2-29",
      "2023-02-29",
      "2024-02-29T00:00:00Z",
      " 2024-02-29",
      20240229,
      null,
      true,
    ]) {
      for (const field of ["recordedFrom", "recordedTo"]) {
        const out = await mcp(app, { projectId, [field]: bad });
        expect(out.isError, field + ": " + String(bad)).toBe(true);
      }
    }
    for (const args of [
      { recordedFrom: "2024-03-01", recordedTo: day },
      { recordType: "unsupported" },
      { recordType: "" },
      { recordType: "note" },
      { unknownFilter: "untrusted" },
    ]) {
      const out = await mcp(app, { projectId, ...args });
      expect(out.isError, JSON.stringify(args)).toBe(true);
    }
    const valid = await mcp(app, {
      projectId,
      recordedFrom: day,
      recordedTo: day,
    });
    expect(valid.isError).not.toBe(true);
    const after = app.app.ck.deps.sqlite
      .prepare("SELECT * FROM records ORDER BY id")
      .all();
    expect(after).toEqual(before);
  });
});
