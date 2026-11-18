import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { McpSearchResultDto } from "@contextkeep/shared";
import { projects, records } from "../src/db/schema.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const token = randomUUID();
const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.cleanup();
});

async function fixture() {
  const t = await makeTestApp({ mcpToken: token });
  apps.push(t);
  const projectId = randomUUID();
  const captured = "2026-11-01T12:00:00.000Z";
  t.app.ck.deps.db
    .insert(projects)
    .values({
      id: projectId,
      name: "Synthetic search budget",
      createdAt: captured,
      updatedAt: captured,
    })
    .run();
  const ids = { accepted: [] as string[], working: [] as string[] };
  for (const scope of ["accepted", "proposed"] as const) {
    for (let n = 0; n < 12; n++) {
      const id = randomUUID();
      t.app.ck.deps.db
        .insert(records)
        .values({
          id,
          projectId,
          type: "fact",
          subject: "compactbeacon " + scope + " synthetic entry " + n,
          text:
            "compactbeacon diacritice șțâîă emoji ▰ recorded details " +
            scope +
            " " +
            "long synthetic text ".repeat(85),
          reviewStatus: scope,
          evidenceBasis: scope === "accepted" ? "document" : "agent_report",
          recordDedupHash: id,
          recordedAt: captured,
          createdAt: captured,
          updatedAt: captured,
        })
        .run();
      ids[scope === "accepted" ? "accepted" : "working"].push(id);
    }
  }
  return { t, projectId, ids };
}

async function call(t: TestApp, args: Record<string, unknown>) {
  const response = await t.app.inject({
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
        arguments: { q: "compactbeacon", ...args },
      },
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json().result as {
    isError?: boolean;
    structuredContent: Record<string, unknown>;
  };
}
async function detail(t: TestApp, args: Record<string, unknown>) {
  const response = await t.app.inject({
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
      params: { name: "get_record", arguments: args },
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json().result as {
    isError?: boolean;
    structuredContent: Record<string, unknown>;
  };
}

describe("ME10 budgeted MCP search cards", () => {
  it("retains canonical/working core, UTF-8 byte budget, completeness and detail pointers", async () => {
    const { t, projectId } = await fixture();
    const before = t.app.ck.deps.sqlite
      .prepare("SELECT * FROM records ORDER BY id")
      .all();
    const original = await call(t, {
      projectId,
      scope: "all",
      compact: true,
      limit: 15,
    });
    expect(original.isError).not.toBe(true);
    const full = McpSearchResultDto.parse(original.structuredContent);
    expect(full.records).toHaveLength(12);
    expect(full.workingRecords).toHaveLength(12);
    const response = await call(t, {
      projectId,
      scope: "all",
      representation: "cards",
      maxResultBytes: 6500,
      limit: 15,
    });
    expect(response.isError).not.toBe(true);
    const parsed = McpSearchResultDto.parse(response.structuredContent);
    expect(parsed.records.length).toBeGreaterThan(0);
    expect(parsed.workingRecords.length).toBeGreaterThan(0);
    expect(parsed.records.length + parsed.workingRecords.length).toBeLessThan(
      24,
    );
    expect(parsed.records[0]?.recordId).toBe(full.records[0]?.recordId);
    expect(parsed.workingRecords[0]?.recordId).toBe(
      full.workingRecords[0]?.recordId,
    );
    expect(
      parsed.records.every(
        (r) => r.reviewStatus === "accepted" && r.provenance === "document",
      ),
    ).toBe(true);
    expect(
      parsed.workingRecords.every(
        (r) => r.reviewStatus === "proposed" && r.provenance === "agent_report",
      ),
    ).toBe(true);
    expect(response.structuredContent).not.toHaveProperty("canonicalRecords");
    expect(parsed).toHaveProperty("representation", "cards");
    expect(parsed).toHaveProperty("compact", true);
    expect(parsed.records[0]?.text?.length).toBeLessThanOrEqual(145);
    expect(parsed.records[0]).toMatchObject({
      textOmitted: true,
      detailTool: "get_record",
      detailArgs: { recordId: full.records[0]?.recordId },
    });
    expect(parsed.workingRecords[0]).toMatchObject({
      detailTool: "get_record",
      detailArgs: {
        recordId: full.workingRecords[0]?.recordId,
        includeUnreviewed: true,
      },
    });
    expect(parsed).toHaveProperty("budget.truncated", true);
    expect(parsed.completeness.records.mayHaveMore).toBe(true);
    expect(parsed.completeness.workingRecords.mayHaveMore).toBe(true);
    const bytes = Buffer.byteLength(
      JSON.stringify(response.structuredContent),
      "utf8",
    );
    expect(bytes).toBeLessThanOrEqual(6500);
    expect(parsed).toHaveProperty("budget.requestedBytes", 6500);
    expect(parsed).toHaveProperty("budget.actualBytes", bytes);
    const after = t.app.ck.deps.sqlite
      .prepare("SELECT * FROM records ORDER BY id")
      .all();
    expect(after).toEqual(before);
  });

  it("rejects impossible budgets, does not silently truncate full results, preserves legacy mode", async () => {
    const { t, projectId } = await fixture();
    const full = await call(t, { projectId, limit: 3, compact: false });
    expect(full.isError).not.toBe(true);
    expect(full.structuredContent).toHaveProperty("canonicalRecords");
    expect(full.structuredContent).not.toHaveProperty("representation");
    const rejected = await call(t, {
      projectId,
      limit: 12,
      maxResultBytes: 2048,
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent).toHaveProperty(
      "error.code",
      "search_budget_exceeded",
    );
    const tooSmall = await call(t, {
      projectId,
      scope: "all",
      representation: "cards",
      maxResultBytes: 2048,
    });
    expect(tooSmall.isError).toBe(true);
    expect(tooSmall.structuredContent).toHaveProperty(
      "error.code",
      "search_budget_too_small",
    );
    for (const invalid of [0, 2047, 32769, null, "12000"]) {
      const res = await call(t, {
        projectId,
        representation: "cards",
        maxResultBytes: invalid,
      });
      expect(res.isError, JSON.stringify(invalid)).toBe(true);
    }
  });

  it("recovers full accepted and explicit unreviewed details using the actual MCP read tool", async () => {
    const { t, projectId } = await fixture();
    const cards = await call(t, {
      projectId,
      scope: "all",
      representation: "cards",
      maxResultBytes: 6500,
    });
    expect(cards.isError).not.toBe(true);
    const result = McpSearchResultDto.parse(cards.structuredContent);
    const accepted = result.records[0] as Record<string, unknown>;
    const proposed = result.workingRecords[0] as Record<string, unknown>;
    const acceptedRead = await detail(
      t,
      accepted.detailArgs as Record<string, unknown>,
    );
    expect(acceptedRead.isError).not.toBe(true);
    expect(acceptedRead.structuredContent).toMatchObject({
      recordId: accepted.recordId,
      reviewStatus: "accepted",
    });
    expect(
      (acceptedRead.structuredContent.text as string).length,
    ).toBeGreaterThan(144);
    const denied = await detail(t, { recordId: proposed.recordId });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toHaveProperty(
      "error.code",
      "agent_record_not_found",
    );
    const proposedRead = await detail(
      t,
      proposed.detailArgs as Record<string, unknown>,
    );
    expect(proposedRead.isError).not.toBe(true);
    expect(proposedRead.structuredContent).toMatchObject({
      recordId: proposed.recordId,
      reviewStatus: "proposed",
    });
    expect(
      (proposedRead.structuredContent.text as string).length,
    ).toBeGreaterThan(144);
  });

  it("preserves the working-only response boundary with a one-sided byte budget", async () => {
    const { t, projectId } = await fixture();
    const res = await call(t, {
      projectId,
      scope: "working",
      representation: "cards",
      maxResultBytes: 6500,
    });
    expect(res.isError).not.toBe(true);
    const parsed = McpSearchResultDto.parse(res.structuredContent);
    expect(parsed.records).toEqual([]);
    expect(parsed.workingRecords.length).toBeGreaterThan(0);
    expect(
      parsed.workingRecords.every((r) => r.reviewStatus === "proposed"),
    ).toBe(true);
    expect(parsed).toHaveProperty("budget.omittedRecords", 0);
    expect(
      Buffer.byteLength(JSON.stringify(res.structuredContent), "utf8"),
    ).toBeLessThanOrEqual(6500);
  });
});
