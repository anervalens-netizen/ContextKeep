import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { McpWorkContextResult } from "@contextkeep/shared";
import { makeTestApp, type TestApp } from "./helpers.js";

const TOKEN = crypto.randomBytes(32).toString("hex");
const AUTHORIZE = { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
const tracked: TestApp[] = [];

afterEach(async () => {
  for (const app of tracked.splice(0)) await app.cleanup();
});

async function call(t: TestApp, name: string, args: Record<string, unknown> = {}) {
  const response = await t.app.inject({
    method: "POST",
    url: "/mcp",
    headers: AUTHORIZE,
    payload: { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.statusCode).toBe(200);
  const result = response.json().result as { isError?: boolean; structuredContent: any };
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent;
}

function ids(section: any): string[] {
  return Array.isArray(section?.items) ? section.items.map((item: any) => item.recordId).filter(Boolean) : [];
}

describe("CK-A02 canonical-first work-context budgeting", () => {
  it("keeps relevant canonical guardrails ahead of verbose working checkpoints at 16k", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(t);
    const project = await call(t, "create_project", {
      name: "A02 canonical priority",
      description: "Release safety context",
      idempotencyKey: crypto.randomUUID(),
    });
    const decision = await call(t, "add_owner_note", {
      projectId: project.id,
      recordType: "decision",
      statement: "Release safety requires the canonical backup gate before deployment.",
      idempotencyKey: crypto.randomUUID(),
    });
    const constraint = await call(t, "add_owner_note", {
      projectId: project.id,
      recordType: "constraint",
      statement: "Never deploy without a verified backup and exact-head checks.",
      idempotencyKey: crypto.randomUUID(),
    });

    const noise = "working-report ".repeat(220);
    for (let i = 0; i < 4; i += 1) {
      await call(t, "capture_work", {
        projectId: project.id,
        outcome: `Recent unreviewed release report ${i}: ${noise}`,
        evidenceText: `agent evidence ${i}`,
        title: `working checkpoint ${i}`,
        recordType: "fact",
        subject: `release-working-${i}`,
        progressUpdates: [],
        checkpoint: {
          summary: `verbose summary ${i} ${noise}`,
          outcome: `verbose outcome ${i} ${noise}`,
          nextAction: null,
          blockers: [`working blocker ${i} ${"x".repeat(500)}`],
          artifactRefs: [`artifact-${i}-${"y".repeat(500)}`],
        },
        clientId: "a02-test",
        sessionId: `a02-${i}`,
        idempotencyKey: crypto.randomUUID(),
      });
    }

    const args = {
      projectId: project.id,
      task: "release safety deployment backup",
      limitPerSection: 4,
      totalContextBudgetChars: 16_000,
    };
    const plain = await call(t, "get_work_context", { ...args, diagnostics: false });
    const diagnostic = await call(t, "get_work_context", { ...args, diagnostics: true });

    expect(JSON.stringify(plain).length).toBeLessThanOrEqual(16_000);
    expect(JSON.stringify(diagnostic).length).toBeLessThanOrEqual(16_000);
    expect(ids(plain.goals)).toContain(decision.acceptedRecordIds[0]);
    expect(ids(plain.constraints)).toContain(constraint.acceptedRecordIds[0]);
    expect(ids(diagnostic.goals)).toEqual(ids(plain.goals));
    expect(ids(diagnostic.constraints)).toEqual(ids(plain.constraints));
    expect(plain.workingMemory.items).toHaveLength(4);
    expect(plain.workingMemory.items.every((item: any) => item.text === undefined && item.evidenceRefs === undefined)).toBe(true);
    expect(plain.recentWork.items.every((item: any) =>
      !item.checkpoint || (item.checkpoint.blockers === undefined && item.checkpoint.artifactRefs === undefined)
    )).toBe(true);
    expect(plain.latestCheckpoint.checkpoint.blockers).toHaveLength(1);
    expect(plain.latestCheckpoint.checkpoint.artifactRefs).toBeUndefined();

    for (const budget of [2_000, 4_000, 60_000]) {
      const withoutDiagnostics = await call(t, "get_work_context", { ...args, totalContextBudgetChars: budget, diagnostics: false });
      const withDiagnostics = await call(t, "get_work_context", { ...args, totalContextBudgetChars: budget, diagnostics: true });
      expect(McpWorkContextResult.safeParse(withoutDiagnostics).success).toBe(true);
      expect(McpWorkContextResult.safeParse(withDiagnostics).success).toBe(true);
      expect(JSON.stringify(withoutDiagnostics).length).toBeLessThanOrEqual(budget);
      expect(JSON.stringify(withDiagnostics).length).toBeLessThanOrEqual(budget);
      expect(ids(withDiagnostics.goals)).toEqual(ids(withoutDiagnostics.goals));
      expect(ids(withDiagnostics.constraints)).toEqual(ids(withoutDiagnostics.constraints));
      if (budget === 2_000) {
        expect(withoutDiagnostics.constraints.total).toBeGreaterThan(0);
        expect(withoutDiagnostics.constraints.items).toHaveLength(0);
        expect(withoutDiagnostics.constraints.omitted).toBeGreaterThan(0);
        expect(withoutDiagnostics.constraints.budgetOmittedRecordIds).toContain(constraint.acceptedRecordIds[0]);
        expect(withoutDiagnostics.constraints.recovery).toEqual({ tool: "search_context", scope: "canonical" });
        expect(withDiagnostics.constraints.budgetOmittedRecordIds).toEqual(withoutDiagnostics.constraints.budgetOmittedRecordIds);
      } else {
        expect(ids(withoutDiagnostics.constraints), `budget ${budget}`).toContain(constraint.acceptedRecordIds[0]);
      }
      expect(ids(withDiagnostics.actions)).toEqual(ids(withoutDiagnostics.actions));
      expect(ids(withDiagnostics.facts)).toEqual(ids(withoutDiagnostics.facts));
    }

    // Selection is deterministic across repeated calls and diagnostics only
    // describes the already-selected semantic payload.
    const repeat = await call(t, "get_work_context", { ...args, diagnostics: false });
    expect(ids(repeat.goals)).toEqual(ids(plain.goals));
    expect(ids(repeat.constraints)).toEqual(ids(plain.constraints));
    expect(ids(repeat.workingMemory)).toEqual(ids(plain.workingMemory));

    // A long task may be omitted from the final envelope to protect context,
    // but it must not change the diagnostics/plain semantic selection.
    const longTask = ("release deployment backup exact-head safety " + "verificare backup ").repeat(45).slice(0, 1_950);
    const longPlain = await call(t, "get_work_context", {
      projectId: project.id,
      task: longTask,
      limitPerSection: 4,
      totalContextBudgetChars: 4_000,
      diagnostics: false,
    });
    const longDiagnostic = await call(t, "get_work_context", {
      projectId: project.id,
      task: longTask,
      limitPerSection: 4,
      totalContextBudgetChars: 4_000,
      diagnostics: true,
    });
    expect(JSON.stringify(longPlain).length).toBeLessThanOrEqual(4_000);
    expect(JSON.stringify(longDiagnostic).length).toBeLessThanOrEqual(4_000);
    expect(ids(longDiagnostic.goals)).toEqual(ids(longPlain.goals));
    expect(ids(longDiagnostic.constraints)).toEqual(ids(longPlain.constraints));

    // No task is a supported deterministic mode as well.
    const noTaskPlain = await call(t, "get_work_context", {
      projectId: project.id,
      limitPerSection: 4,
      totalContextBudgetChars: 4_000,
      diagnostics: false,
    });
    const noTaskDiagnostic = await call(t, "get_work_context", {
      projectId: project.id,
      limitPerSection: 4,
      totalContextBudgetChars: 4_000,
      diagnostics: true,
    });
    expect(JSON.stringify(noTaskPlain).length).toBeLessThanOrEqual(4_000);
    expect(JSON.stringify(noTaskDiagnostic).length).toBeLessThanOrEqual(4_000);
    expect(ids(noTaskDiagnostic.goals)).toEqual(ids(noTaskPlain.goals));
    expect(ids(noTaskDiagnostic.constraints)).toEqual(ids(noTaskPlain.constraints));

    // Canonical truth and proposal-only working memory remain explicitly
    // separate even in the compact representation.
    expect(plain.constraints.items.every((item: any) => item.status === "accepted")).toBe(true);
    expect(plain.workingMemory.items.every((item: any) => item.status === "proposed")).toBe(true);
  });

  it("keeps an empty project representable at tight budgets with long metadata", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(t);
    const project = await call(t, "create_project", {
      name: "P".repeat(200),
      description: "metadata ".repeat(350),
      idempotencyKey: crypto.randomUUID(),
    });

    for (const budget of [2_000, 4_000, 16_000, 60_000]) {
      const plain = await call(t, "get_work_context", {
        projectId: project.id,
        limitPerSection: 4,
        totalContextBudgetChars: budget,
        diagnostics: false,
      });
      const diagnostic = await call(t, "get_work_context", {
        projectId: project.id,
        limitPerSection: 4,
        totalContextBudgetChars: budget,
        diagnostics: true,
      });
      expect(McpWorkContextResult.safeParse(plain).success).toBe(true);
      expect(McpWorkContextResult.safeParse(diagnostic).success).toBe(true);
      expect(JSON.stringify(plain).length).toBeLessThanOrEqual(budget);
      expect(JSON.stringify(diagnostic).length).toBeLessThanOrEqual(budget);
      expect(ids(diagnostic.goals)).toEqual(ids(plain.goals));
      expect(ids(diagnostic.constraints)).toEqual(ids(plain.constraints));
      expect(plain.goals.total).toBe(0);
      expect(plain.constraints.total).toBe(0);
      expect(plain.workingMemory.total).toBe(0);
    }
  });
});
