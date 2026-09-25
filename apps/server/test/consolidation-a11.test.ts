import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";

const tracked: TestApp[] = [];
afterEach(async () => {
  while (tracked.length) await tracked.pop()!.cleanup();
});

describe("CK-A11 resume metadata contract", () => {
  it("returns checkpoint revision, provenance and timestamp needed for a trustworthy resume copy", async () => {
    const t = await makeTestApp();
    tracked.push(t);
    const project = (await t.post("/api/projects", { name: "A11 resume" })).json<{ id: string }>();
    const id = crypto.randomUUID();
    const recordedAt = "2026-09-23T15:10:00.000Z";
    t.app.ck.handle.sqlite.prepare(
      "INSERT INTO records(id,project_id,type,subject,predicate,value_json,text,review_status,evidence_basis,task_status,record_dedup_hash,recorded_at,source_event_at,effective_from,effective_to,reviewed_at,review_due_at,volatile,revision,created_at,updated_at) VALUES(?,?, 'fact','checkpoint',NULL,?,?,'proposed','agent_report',NULL,?,?,NULL,NULL,NULL,NULL,NULL,0,7,?,?)",
    ).run(
      id,
      project.id,
      JSON.stringify({ kind: "working_checkpoint", summary: "Resume here", nextAction: "Do the next thing", blockers: [], artifactRefs: [] }),
      "Resume here",
      crypto.randomBytes(32).toString("hex"),
      recordedAt,
      recordedAt,
      recordedAt,
    );

    const res = await t.get(`/api/projects/${project.id}/work-context`);
    expect(res.statusCode).toBe(200);
    expect(res.json<any>().latestCheckpoint).toMatchObject({
      recordId: id,
      revision: 7,
      recordedAt,
      status: "proposed",
      provenance: "agent_report",
    });
  });
});
