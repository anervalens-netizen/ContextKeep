import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";

const tracked: TestApp[] = [];
afterEach(async () => {
  for (const t of tracked.splice(0)) await t.cleanup();
});

describe("CK-A10 inbox pagination backend contract", () => {
  it("navigates beyond 1000 proposals with exact scoped totals and project counts", async () => {
    const t = await makeTestApp();
    tracked.push(t);
    const p1 = (await t.post("/api/projects", { name: "A10 Large" })).json<{ id: string }>();
    const p2 = (await t.post("/api/projects", { name: "A10 Other" })).json<{ id: string }>();
    const now = "2026-09-23T17:00:00.000Z";
    const insert = t.app.ck.handle.sqlite.prepare(
      "INSERT INTO records(id,project_id,type,subject,predicate,value_json,text,review_status,evidence_basis,task_status,record_dedup_hash,recorded_at,source_event_at,effective_from,effective_to,reviewed_at,review_due_at,volatile,revision,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,?,'proposed','agent_report',NULL,?,?,NULL,NULL,NULL,NULL,NULL,0,1,?,?)",
    );
    const seed = t.app.ck.handle.sqlite.transaction((projectId: string, count: number, prefix: string) => {
      for (let i = 0; i < count; i += 1) {
        insert.run(
          crypto.randomUUID(),
          projectId,
          "fact",
          `${prefix}-subject-${i}`,
          `${prefix} proposal ${i}`,
          `${prefix}-hash-${i}`,
          now,
          now,
          now,
        );
      }
    });
    seed(p1.id, 1055, "p1");
    seed(p2.id, 12, "p2");

    const first = await t.get(`/api/inbox?projectId=${p1.id}&limit=50&offset=0`);
    expect(first.statusCode).toBe(200);
    expect(first.json<any>()).toMatchObject({ total: 1055 });
    expect(first.json<any>().candidates).toHaveLength(50);

    const beyondThousand = await t.get(`/api/inbox?projectId=${p1.id}&limit=50&offset=1000`);
    expect(beyondThousand.statusCode).toBe(200);
    expect(beyondThousand.json<any>().total).toBe(1055);
    expect(beyondThousand.json<any>().candidates).toHaveLength(50);

    const last = await t.get(`/api/inbox?projectId=${p1.id}&limit=50&offset=1050`);
    expect(last.json<any>().candidates).toHaveLength(5);

    const global = await t.get("/api/inbox?limit=50&offset=0");
    const counts = new Map(global.json<any>().byProject.map((row: any) => [row.projectId, row.count]));
    expect(global.json<any>().total).toBe(1067);
    expect(counts.get(p1.id)).toBe(1055);
    expect(counts.get(p2.id)).toBe(12);
  });
});
