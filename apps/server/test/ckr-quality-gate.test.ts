import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import heldout from "../src/evals/ai-memory-heldout.json" with { type: "json" };
import { HELDOUT_CORPUS_SHA256, runHeldoutEval } from "../src/evals/ai-memory-heldout.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const TOKEN = crypto.randomBytes(32).toString("hex");
const AUTH = { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
const FROZEN_SHA = "09c419f27eb508786c48fe68db92fc82fd897e1ccd80177e5dd9f276e0c49921";
const tracked: TestApp[] = [];

afterEach(async () => {
  for (const t of tracked.splice(0)) await t.cleanup();
});

function assertCkrQuality(report: Awaited<ReturnType<typeof runHeldoutEval>>): void {
  expect(report.corpusHashSha256).toBe(FROZEN_SHA);
  expect(report.metrics.overall.recallAt10).toBeGreaterThanOrEqual(0.8627);
  expect(report.metrics.overall.currentness).toBeGreaterThanOrEqual(0.5385);
  expect(report.metrics.overall.evidenceCoverageEligible).toBeGreaterThanOrEqual(0.8571);
  expect(report.metrics.overall.abstention).toBeGreaterThanOrEqual(0.0833);

  const independent = report.cases.filter((item) => item.categories.includes("ckr_independent"));
  expect(independent).toHaveLength(24);
  expect(independent.filter((item) => item.language === "ro")).toHaveLength(12);
  expect(independent.filter((item) => item.language === "en")).toHaveLength(12);
  expect(independent.filter((item) => item.shouldAbstain === true)).toHaveLength(6);

  for (const item of independent) {
    if (item.targetRecordIds.length > 0) {
      expect(item.recallAt10, item.id).toBe(1);
      if (item.requiresEvidence) expect(item.evidenceCoverage, item.id).toBe(1);
      if (item.currentnessCorrect !== null) expect(item.currentnessCorrect, item.id).toBe(true);
    }
    if (item.shouldAbstain) {
      expect(item.observedAbstention, item.id).toBe(true);
      expect(item.synthesisStatus, item.id).toBe("unknown");
    }
  }
}

async function rpc(t: TestApp, name: string, args: Record<string, unknown>) {
  const response = await t.app.inject({
    method: "POST",
    url: "/mcp",
    headers: AUTH,
    payload: {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<any>();
  expect(body.error).toBeUndefined();
  expect(body.result?.isError).not.toBe(true);
  return body.result.structuredContent as any;
}

describe("CKR-01 frozen independent quality gate", () => {
  it("keeps the frozen corpus and non-regression floors green", async () => {
    expect(HELDOUT_CORPUS_SHA256).toBe(FROZEN_SHA);
    expect(heldout.filter((item) => item.categories.includes("ckr_independent"))).toHaveLength(24);
    const report = await runHeldoutEval();
    assertCkrQuality(report);
  }, 30000);

  it("proves the gate rejects a degraded independent result", async () => {
    const report = await runHeldoutEval();
    const degraded = structuredClone(report);
    const positive = degraded.cases.find((item) => item.id === "K-EN-01");
    if (!positive) throw new Error("missing K-EN-01");
    positive.recallAt10 = 0;
    expect(() => assertCkrQuality(degraded)).toThrow();
  }, 30000);

  it("keeps checkpoint projection working-only and explicitly labeled through MCP", async () => {
    const t = await makeTestApp({
      mcpToken: TOKEN,
      mcpDefaultClientId: "chatgpt",
      mcpDelegateWorkingMemory: true,
      adapters: "manual",
    });
    tracked.push(t);
    const project = (await t.post("/api/projects", { name: "CKR quality checkpoint" })).json<{ id: string }>();
    const captured = await rpc(t, "capture_working_memory", {
      projectId: project.id,
      outcome: "Frozen quality checkpoint marker.",
      subject: "quality-checkpoint",
      checkpoint: {
        summary: "Quality checkpoint",
        nextAction: "Keep projection canonical-safe",
        artifactRefs: ["PR-7711"],
      },
      idempotencyKey: crypto.randomUUID(),
    });
    const search = await rpc(t, "search_context", {
      projectId: project.id,
      q: "quality checkpoint",
      scope: "all",
      limit: 10,
    });
    const working = search.workingRecords.find((item: any) => item.recordId === captured.outcome.recordId);
    expect(working).toMatchObject({
      reviewStatus: "proposed",
      status: "proposed",
      provenance: "agent_report",
      memoryStatus: "unreviewed_working_memory",
      truthStatus: "not_canonical_requires_review",
    });
    expect(working.checkpoint).toMatchObject({
      kind: "working_checkpoint",
      summary: "Quality checkpoint",
      nextAction: "Keep projection canonical-safe",
    });
    expect(search.records.some((item: any) => item.recordId === captured.outcome.recordId)).toBe(false);
  });
});
