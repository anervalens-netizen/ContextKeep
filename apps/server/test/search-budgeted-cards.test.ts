import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { McpSearchResultDto } from "@contextkeep/shared";
import { packSearchCards } from "../src/services/search-budget.js";
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
  it("measures byte digit boundaries as a fixed point and never returns oversized protected content", () => {
    const source = {
      query: "fixture",
      scope: "canonical",
      records: [
        {
          recordId: randomUUID(),
          projectId: null,
          subject: "A",
          type: "fact",
          text: "fixture",
          evidence: [],
          checkpoint: null,
          reviewStatus: "accepted",
          provenance: "document",
          recordedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
      workingRecords: [],
      completeness: {
        records: {
          returned: 1,
          limit: 1,
          mayHaveMore: false,
          candidateLimitReached: false,
        },
        workingRecords: {
          returned: 0,
          limit: 1,
          mayHaveMore: false,
          candidateLimitReached: false,
        },
      },
    };
    // A one-pass byte measurement can undercount at the 9999 -> 10000
    // decimal-width transition because the count itself is serialized.
    const reference = packSearchCards(source, 32_768);
    const withZeroCounter = structuredClone(reference);
    withZeroCounter.budget = {
      ...(reference.budget as Record<string, unknown>),
      actualBytes: 0,
      requestedBytes: 10_000,
    };
    const initialBytes = Buffer.byteLength(
      JSON.stringify(withZeroCounter),
      "utf8",
    );
    const padding = 9_997 - initialBytes;
    expect(padding).toBeGreaterThan(0);
    source.records[0]!.subject += "X".repeat(padding);
    expect(() => packSearchCards(source, 10_000)).toThrowError(
      expect.objectContaining({ code: "search_budget_too_small" }),
    );
    const accepted = packSearchCards(source, 10_002);
    const actual = Buffer.byteLength(JSON.stringify(accepted), "utf8");
    expect(accepted.budget).toHaveProperty("actualBytes", actual);
    expect(actual).toBeLessThanOrEqual(10_002);
  });

  it("never clips supplementary Unicode characters into an unpaired surrogate", () => {
    const source = {
      query: "unicode",
      scope: "canonical",
      records: [
        {
          recordId: randomUUID(),
          projectId: null,
          subject: "unicode fixture",
          type: "fact",
          text: "x".repeat(143) + "😀" + "tail",
          evidence: [],
          checkpoint: null,
          reviewStatus: "accepted",
          provenance: "document",
          recordedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
      workingRecords: [],
      completeness: {
        records: {
          returned: 1,
          limit: 1,
          mayHaveMore: false,
          candidateLimitReached: false,
        },
        workingRecords: {
          returned: 0,
          limit: 1,
          mayHaveMore: false,
          candidateLimitReached: false,
        },
      },
    };
    const value = packSearchCards(source, 12_000);
    expect(value.records[0]?.text).toBe("x".repeat(143) + "…");
    expect(JSON.stringify(value)).not.toContain("\\ud83d");
  });

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
    expect(rejected.structuredContent).toHaveProperty("error.nextAction", "use_cards_or_narrow_search");
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

  it("applies the exact post-redaction UTF-8 byte budget to delivered MCP cards", async () => {
    const { t, projectId } = await fixture();
    const baseline = await call(t, {
      projectId,
      scope: "all",
      compact: true,
      limit: 15,
    });
    expect(baseline.isError).not.toBe(true);
    const target = (
      baseline.structuredContent.records as Array<{ recordId: string }>
    )[0]!.recordId;
    t.app.ck.deps.sqlite
      .prepare("UPDATE records SET subject=? WHERE id=?")
      .run(
        "compactbeacon compactbeacon compactbeacon API_KEY=abcdef synthetic secret label",
        target,
      );
    const budgets = [3_200, 6_500, 10_000, 12_000, 32_768];
    let successful = 0;
    let redactedRowsSeen = 0;
    for (const maxResultBytes of budgets) {
      const result = await call(t, {
        projectId,
        representation: "cards",
        scope: "all",
        maxResultBytes,
        limit: 15,
      });
      if (result.isError) {
        expect(result.structuredContent).toHaveProperty(
          "error.code",
          "search_budget_too_small",
        );
        continue;
      }
      successful++;
      const bytes = Buffer.byteLength(
        JSON.stringify(result.structuredContent),
        "utf8",
      );
      expect(bytes).toBeLessThanOrEqual(maxResultBytes);
      expect(result.structuredContent).toHaveProperty(
        "budget.actualBytes",
        bytes,
      );
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        "API_KEY=abcdef",
      );
      const acceptedRow = (
        result.structuredContent.records as Array<{ subject: string }>
      ).find((row) => row.subject.includes("API_KEY="));
      if (acceptedRow) {
        expect(acceptedRow.subject).toContain("REDACTED_CREDENTIAL");
        redactedRowsSeen++;
      }
    }
    expect(successful).toBeGreaterThan(0);
    expect(redactedRowsSeen).toBeGreaterThan(0);
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

describe("V-12 progressive evidence reads", () => {
  it("fences chosen card, record pages and source pages across independent evidence changes", async () => {
    const { t, projectId, ids } = await fixture();
    const { sqlite } = t.app.ck.deps;
    const recordId = ids.accepted[0]!;
    const sourceId = randomUUID();
    const unrelatedProjectId = randomUUID();
    const captured = "2026-11-01T00:00:00.000Z";
    const text = "Synthetic trace with multiple evidence segments.";
    sqlite
      .prepare(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)",
      )
      .run(unrelatedProjectId, "Unrelated fixture", captured, captured);
    sqlite
      .prepare(
        `INSERT INTO sources (id,kind,title,content_hash,normalized_hash,imported_at,provenance_basis,project_id,original_text,normalized_text)
      VALUES (?,'manual','Synthetic trace',?,?,?,?,?,?,?)`,
      )
      .run(
        sourceId,
        "fixture-content",
        "fixture-normalized",
        captured,
        "document",
        projectId,
        text,
        text,
      );
    const addExcerpt = (start: number) => {
      const excerptId = randomUUID();
      sqlite
        .prepare("INSERT INTO source_excerpts VALUES(?,?,?,?,?,?)")
        .run(
          excerptId,
          sourceId,
          start,
          start + 5,
          text.slice(start, start + 5),
          "fixture-excerpt",
        );
      return excerptId;
    };
    const excerptIds = [0, 5, 10, 15, 20].map(addExcerpt);
    for (const id of excerptIds)
      sqlite
        .prepare(
          "INSERT INTO record_evidence(record_id,excerpt_id,relation) VALUES(?,?,'supports')",
        )
        .run(recordId, id);

    const details = async (
      name: string,
      args: Record<string, unknown>,
      expectedError?: string,
    ) => {
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
          params: { name, arguments: args },
        },
      });
      expect(response.statusCode).toBe(200);
      const result = response.json().result;
      if (expectedError) {
        expect(result.isError).toBe(true);
        expect(result.structuredContent.error).toMatchObject({
          code: expectedError,
          retryable: false,
        });
      } else expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return result.structuredContent;
    };
    const pageArgs = ({ tool: _tool, ...args }: Record<string, unknown>) =>
      args;
    const cardPage = await call(t, {
      projectId,
      representation: "cards",
      maxResultBytes: 32_768,
      limit: 10,
    });
    const card = (
      cardPage.structuredContent.records as Array<Record<string, unknown>>
    ).find((row) => row.recordId === recordId)!;
    expect(card.evidenceOmittedCount).toBe(5);
    const args = card.detailArgs as Record<string, unknown>;
    expect(args).toMatchObject({
      recordId,
      projectId,
      expectedRevision: 1,
      expectedEvidenceVersion: card.evidenceVersion,
      includeUnreviewed: false,
      evidenceOffset: 0,
      evidenceLimit: 3,
    });
    await details(
      "get_record",
      { ...args, projectId: unrelatedProjectId },
      "agent_record_not_found",
    );
    await details(
      "get_record",
      { recordId: ids.working[0], expectedRevision: 1 },
      "agent_record_not_found",
    );
    const first = await details("get_record", { ...args, evidenceLimit: 2 });
    expect(first).toMatchObject({
      evidenceTotal: 5,
      evidenceReturned: 2,
      evidenceNextOffset: 2,
      evidenceVersion: card.evidenceVersion,
    });
    const second = await details(
      "get_record",
      pageArgs(first.evidenceRecovery),
    );
    const third = await details(
      "get_record",
      pageArgs(second.evidenceRecovery),
    );
    expect(third).toMatchObject({
      evidenceTotal: 5,
      evidenceReturned: 1,
      evidenceNextOffset: null,
      evidenceRecovery: null,
    });
    expect(
      [...first.evidence, ...second.evidence, ...third.evidence].map(
        (item) => item.excerptId,
      ),
    ).toEqual([...excerptIds].sort());

    const sourceArgs = pageArgs(first.evidence[0].recovery);
    expect(sourceArgs).toMatchObject({
      representation: "normalized",
      offset: 0,
      maxChars: 6000,
      excerptOffset: 0,
      excerptLimit: 5,
    });
    const initialSource = await details("get_source", sourceArgs);
    expect(initialSource).toMatchObject({
      canonicalTruth: false,
      excerptReturned: 5,
      excerptNextOffset: null,
    });
    await details(
      "get_source",
      { ...sourceArgs, projectId: unrelatedProjectId },
      "source_not_found",
    );
    const source = await details("get_source", {
      ...sourceArgs,
      excerptLimit: 2,
      maxChars: 8,
    });
    expect(source).toMatchObject({
      canonicalTruth: false,
      excerptTotal: 5,
      excerptReturned: 2,
      excerptNextOffset: 2,
      returnedChars: 8,
      nextOffset: 8,
    });
    const sourceText = await details(
      "get_source",
      pageArgs(source.textRecovery),
    );
    const sourceExcerpts = await details(
      "get_source",
      pageArgs(source.excerptRecovery),
    );
    expect(sourceText).toMatchObject({
      offset: 8,
      evidenceVersion: source.evidenceVersion,
    });
    expect(sourceExcerpts).toMatchObject({
      excerptOffset: 2,
      excerptReturned: 2,
      evidenceVersion: source.evidenceVersion,
    });
    const finalExcerpts = await details(
      "get_source",
      pageArgs(sourceExcerpts.excerptRecovery),
    );
    expect(finalExcerpts).toMatchObject({
      excerptTotal: 5,
      excerptReturned: 1,
      excerptNextOffset: null,
      excerptRecovery: null,
    });
    expect(
      [
        ...source.excerpts,
        ...sourceExcerpts.excerpts,
        ...finalExcerpts.excerpts,
      ].map((excerpt) => excerpt.id),
    ).toEqual(excerptIds);
    let textPage = sourceText;
    let recovered = source.text + sourceText.text;
    while (textPage.textRecovery) {
      textPage = await details("get_source", pageArgs(textPage.textRecovery));
      expect(textPage.evidenceVersion).toBe(source.evidenceVersion);
      recovered += textPage.text;
    }
    expect(recovered).toBe(text);
    addExcerpt(25);
    await details(
      "get_source",
      pageArgs(source.excerptRecovery),
      "source_evidence_changed",
    );

    // Change only a supporting source, leaving the hit's own revision fixed.
    sqlite
      .prepare(
        "UPDATE sources SET normalized_text=?, normalized_hash=? WHERE id=?",
      )
      .run(text + " Revised.", "fixture-normalized-v2", sourceId);
    await details(
      "get_record",
      pageArgs(first.evidenceRecovery),
      "record_evidence_changed",
    );
    await details("get_record", args, "record_evidence_changed");
    sqlite
      .prepare("UPDATE records SET revision=revision+1 WHERE id=?")
      .run(recordId);
    await details("get_record", args, "record_revision_changed");
    const fresh = await details("get_record", { recordId });
    expect(fresh).toMatchObject({
      reviewStatus: "accepted",
      revision: 2,
      evidenceTotal: 5,
    });
    sqlite
      .prepare("UPDATE sources SET project_id=? WHERE id=?")
      .run(unrelatedProjectId, sourceId);
    await details(
      "get_record",
      { recordId, projectId },
      "evidence_scope_mismatch",
    );
    expect(
      sqlite
        .prepare("SELECT review_status FROM records WHERE id=?")
        .pluck()
        .get(ids.working[0]),
    ).toBe("proposed");
  });
});
