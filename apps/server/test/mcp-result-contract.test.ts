import { describe, expect, it, vi } from "vitest";
import { makeTestApp } from "./helpers.js";
import { ApiError } from "../src/lib/errors.js";
import { atomicWrite, durableWrite, MCP_RESULT_BYTE_BUDGET, toolError } from "../src/mcp/safety.js";
import { finalizeClaim, requestHash, tryClaim } from "../src/services/idempotency.js";
import { renderHandoff } from "../src/services/export.js";

const eventKey = "22222222-2222-4222-8222-222222222222";

describe("complete MCP result budget and durable write outcomes", () => {
  it.each(["oversized", "malformed"] as const)("does not re-execute a completed event with a %s legacy reply", async (kind) => {
    const t = await makeTestApp({ adapters: "manual" });
    try {
      const input = { idempotencyKey: eventKey };
      const key = `mcp:${eventKey}`;
      const hash = requestHash("MCP", "synthetic_receipt", input);
      const clean = { text: "x".repeat(400_000) };
      const body = kind === "malformed" ? "null" : JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(clean) }],
        structuredContent: clean,
      });
      expect(tryClaim(t.app.ck.deps.sqlite, { key, method: "MCP", url: "synthetic_receipt", requestHash: hash }).fresh).toBe(true);
      finalizeClaim(t.app.ck.deps.sqlite, { key, state: "completed", responseStatus: 200, responseBody: body, responseContentType: "application/json" });
      const operation = vi.fn(() => ({ unexpected: true }));
      expect(() => atomicWrite(t.app.ck.deps, "synthetic_receipt", input, operation, [])).toThrow("cannot be returned safely");
      expect(operation).not.toHaveBeenCalled();
      const retained = tryClaim(t.app.ck.deps.sqlite, { key, method: "MCP", url: "synthetic_receipt", requestHash: hash });
      expect(retained.fresh).toBe(false);
      expect(retained.claim.state).toBe("completed");
      expect(retained.claim.responseBody).toBe(body);
    } finally { await t.cleanup(); }
  });

  it("keeps an async write outcome fenced when its already-created handoff cannot fit the reply", async () => {
    const t = await makeTestApp({ adapters: "manual" });
    try {
      const project = (await t.post("/api/projects", { name: "Synthetic async result budget" })).json<{ id: string }>();
      const input = { idempotencyKey: eventKey, projectId: project.id, objective: null, contextBudgetChars: 2000 };
      const operation = vi.fn(async () => ({
        handoff: renderHandoff(t.app.ck.deps, input, { actor: "synthetic" }),
        padding: "x".repeat(400_000),
      }));
      const result = await durableWrite(t.app.ck.deps, "synthetic_handoff", input, operation, []);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: "idempotency_outcome_unknown", nextAction: "reconcile_state_before_retry" } });
      await expect(durableWrite(t.app.ck.deps, "synthetic_handoff", input, operation, [])).rejects.toMatchObject({ code: "idempotency_outcome_unknown" });
      expect(operation).toHaveBeenCalledTimes(1);
      expect(t.app.ck.deps.sqlite.prepare("SELECT count(*) AS count FROM handoffs WHERE project_id=?").get(project.id)).toEqual({ count: 1 });
    } finally { await t.cleanup(); }
  });

  it("rolls back a synchronous handoff when its complete reply exceeds the cap", async () => {
    const t = await makeTestApp({ adapters: "manual" });
    try {
      const project = (await t.post("/api/projects", { name: "Synthetic atomic result budget" })).json<{ id: string }>();
      const input = { idempotencyKey: eventKey, projectId: project.id, objective: null, contextBudgetChars: 2000 };
      const result = atomicWrite(t.app.ck.deps, "synthetic_handoff", input, () => ({
        handoff: renderHandoff(t.app.ck.deps, input, { actor: "synthetic" }),
        padding: "x".repeat(400_000),
      }), []);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: "result_too_large" } });
      expect(t.app.ck.deps.sqlite.prepare("SELECT count(*) AS count FROM handoffs WHERE project_id=?").get(project.id)).toEqual({ count: 0 });
    } finally { await t.cleanup(); }
  });

  it("keeps oversized error diagnostics bounded with an explicit reconciliation action", () => {
    const result = toolError(new ApiError(409, "idempotency_result_expired", "x".repeat(500_000)), []);
    expect(result.isError).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(MCP_RESULT_BYTE_BUDGET);
    expect(result.structuredContent).toMatchObject({ error: { code: "idempotency_result_expired", nextAction: "reconcile_state_before_retry", retryable: false } });
  });
});
