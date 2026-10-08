import { afterEach, describe, expect, it, vi } from "vitest";
import { records } from "../src/db/schema.js";
import {
  runMemoryHousekeeping,
  previewMemoryHousekeeping,
} from "../src/services/housekeeping.js";
import {
  getTaskProgress,
  effectiveTaskState,
} from "../src/services/operational-dossier.js";
import { requireTaskScope } from "../src/services/task-scope.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const apps: TestApp[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const t of apps.splice(0)) await t.cleanup();
});
const old = "2020-01-01T00:00:00.000Z";
const at = Date.parse("2030-01-01T00:00:00.000Z");
const config = { housekeepingProposalRetentionDays: 30 };

async function fixture() {
  const t = await makeTestApp();
  apps.push(t);
  const project = (
    await t.post("/api/projects", { name: "Synthetic retention" })
  ).json<{ id: string }>();
  function add(overrides: Partial<typeof records.$inferInsert> = {}) {
    const id = crypto.randomUUID();
    t.app.ck.deps.db
      .insert(records)
      .values({
        id,
        projectId: project.id,
        type: "fact",
        subject: id,
        text: "Synthetic retention evidence",
        recordDedupHash: id,
        evidenceBasis: "agent_report",
        recordedAt: old,
        createdAt: old,
        updatedAt: old,
        ...overrides,
      })
      .run();
    return id;
  }
  const review = (id: string) =>
    (
      t.app.ck.deps.sqlite
        .prepare("SELECT review_status FROM records WHERE id=?")
        .get(id) as { review_status: string }
    ).review_status;
  return { t, project, add, review, deps: t.app.ck.deps };
}

describe("Operational retention invariants", () => {
  it("retains every task state and each task's progress, including closed reports on old raw state", async () => {
    const { deps, project, add, review } = await fixture();
    const tasks = [
      "open",
      "in_progress",
      "blocked",
      "done",
      "cancelled",
      null,
    ].map((taskStatus) => add({ type: "action", taskStatus }));
    const progressIds = tasks.map((taskId, i) => {
      const id = add({
        type: "decision",
        valueJson: JSON.stringify({
          kind: "task_progress",
          taskId,
          revision: 1,
          taskRevision: 1,
          status: i === 1 ? "done" : "open",
          summary: "Retained",
          nextAction: null,
          ownerAction: null,
          previousRecordId: null,
        }),
      });
      deps.sqlite
        .prepare(
          "INSERT INTO workflow_task_records(task_id,record_id) VALUES (?,?)",
        )
        .run(taskId, id);
      return id;
    });
    const plain = add();
    add({
      predicate: "lifecycle",
      valueJson: JSON.stringify({ kind: "lifecycle", state: "paused" }),
    });
    const before = tasks.map((id) => {
      const task = requireTaskScope(deps, project.id, id);
      return effectiveTaskState(deps, task, getTaskProgress(deps, id));
    });
    const result = runMemoryHousekeeping(deps, config, undefined, at);
    expect(result.archivedRecordIds).toEqual([plain]);
    for (const id of [...tasks, ...progressIds])
      expect(review(id)).toBe("proposed");
    expect(
      tasks.map((id) =>
        effectiveTaskState(
          deps,
          requireTaskScope(deps, project.id, id),
          getTaskProgress(deps, id),
        ),
      ),
    ).toEqual(before);
    expect(before[1]).toEqual({
      state: "done",
      stateSource: "reported_progress",
    });
  });

  it("retains malformed/unknown structured memory and unstructured workflow references, including future reference tables", async () => {
    const { deps, add, review } = await fixture();
    const structured = [
      "{broken",
      "{}",
      JSON.stringify({ kind: "future_operational_kind" }),
    ].map((valueJson) => add({ valueJson }));
    const relation = add({ predicate: "depends_on" });
    const referenced = add();
    // A future workflow table must be protected without an allow-list update.
    deps.sqlite.exec(
      "CREATE TABLE workflow_future_receipts (support_record_id TEXT REFERENCES records(id))",
    );
    deps.sqlite
      .prepare("INSERT INTO workflow_future_receipts VALUES (?)")
      .run(referenced);
    const plain = add();
    const result = runMemoryHousekeeping(deps, config, undefined, at);
    expect(result.archivedRecordIds).toEqual([plain]);
    for (const id of [...structured, relation, referenced])
      expect(review(id)).toBe("proposed");
    expect(result.skipped).toContainEqual({
      recordId: referenced,
      reason: "workflow_reference",
    });
  });

  it("previews without writes, keeps a stable cutoff across pages and matches apply", async () => {
    const { deps, add } = await fixture();
    const ids = [
      add(),
      add({ type: "action" }),
      add(),
      add({ valueJson: "{}" }),
    ];
    const before = deps.sqlite.prepare("SELECT total_changes() AS n").get();
    const all = [];
    let cursor: string | undefined;
    let cutoff: string | undefined;
    do {
      const page = previewMemoryHousekeeping(deps, config, {
        nowMs: cursor ? at + 86400000 : at,
        limit: 1,
        cursor,
      });
      cutoff ??= page.cutoff;
      expect(page.cutoff).toBe(cutoff);
      all.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(deps.sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(
      before,
    );
    expect(all.map((i) => i.recordId).sort()).toEqual(ids.sort());
    const expected = all
      .filter((i) => i.disposition === "archive")
      .map((i) => i.recordId)
      .sort();
    expect(
      runMemoryHousekeeping(
        deps,
        config,
        undefined,
        at,
      ).archivedRecordIds.sort(),
    ).toEqual(expected);
    expect(
      runMemoryHousekeeping(deps, config, undefined, at).archivedRecordIds,
    ).toEqual([]);
  });

  it("rechecks references and revisions added after the candidate page was enumerated", async () => {
    const { deps, add, review } = await fixture();
    const task = add({ type: "action" });
    const referenced = add();
    const edited = add();
    const original = deps.sqlite.prepare.bind(deps.sqlite);
    let injected = false;
    vi.spyOn(deps.sqlite, "prepare").mockImplementation((sql: string) => {
      const statement = original(sql);
      if (sql.includes("LIMIT 5000") && !injected) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
          const page = all(...args);
          injected = true;
          original(
            "INSERT INTO workflow_task_records(task_id,record_id) VALUES (?,?)",
          ).run(task, referenced);
          original("UPDATE records SET revision=revision+1 WHERE id=?").run(
            edited,
          );
          return page;
        });
      }
      return statement;
    });
    const result = runMemoryHousekeeping(deps, config, undefined, at);
    expect(result.archivedProposals).toBe(0);
    expect(review(referenced)).toBe("proposed");
    expect(review(edited)).toBe("proposed");
    expect(result.skipped).toContainEqual({
      recordId: referenced,
      reason: "workflow_reference",
    });
    expect(result.skipped).toContainEqual({
      recordId: edited,
      reason: "stale_candidate",
    });
  });

  it("scans beyond a full protected page and retains records on the exact cutoff", async () => {
    const { deps, add, review } = await fixture();
    deps.sqlite.transaction(() => {
      for (let i = 0; i < 5001; i++) add({ type: "action" });
    })();
    const eligible = add({ createdAt: "2021-01-01T00:00:00.000Z" });
    const boundary = add({
      createdAt: new Date(at - 30 * 86400000).toISOString(),
    });
    const result = runMemoryHousekeeping(deps, config, undefined, at);
    expect(result.checkedProposals).toBe(5002);
    expect(result.archivedRecordIds).toEqual([eligible]);
    expect(review(boundary)).toBe("proposed");
  });

  it("bounds workflow-history scans by pages rather than candidate count", async () => {
    const { deps, add } = await fixture();
    add();
    add();
    const prepare = vi.spyOn(deps.sqlite, "prepare");
    const referenceScans = () =>
      prepare.mock.calls.filter(([sql]) => /FROM \"?workflow_/.test(sql))
        .length;
    runMemoryHousekeeping(deps, config, undefined, at);
    const small = referenceScans();
    expect(small).toBeGreaterThan(0);
    deps.sqlite.transaction(() => {
      for (let i = 0; i < 500; i++) add();
    })();
    prepare.mockClear();
    const large = runMemoryHousekeeping(deps, config, undefined, at);
    expect(large.archivedProposals).toBe(500);
    expect(referenceScans()).toBe(small);
  });

  it("rejects malformed cursors and changed policy configuration", async () => {
    const { deps, add } = await fixture();
    add();
    add();
    const first = previewMemoryHousekeeping(deps, config, {
      nowMs: at,
      limit: 1,
    });
    expect(first.nextCursor).not.toBeNull();
    expect(() =>
      previewMemoryHousekeeping(
        deps,
        { housekeepingProposalRetentionDays: 60 },
        { cursor: first.nextCursor! },
      ),
    ).toThrow(/cursor/);
    expect(() =>
      previewMemoryHousekeeping(deps, config, { cursor: "invalid" }),
    ).toThrow(/cursor/);
    expect(() =>
      previewMemoryHousekeeping(deps, config, { limit: 501 }),
    ).toThrow(/limit/);
  });
});
