import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/errors.js";
import {
  ContextKeepMemoryService,
  type MemoryToolRunContext,
} from "../src/services/memory-context.js";
import { getProjectByName, makeTestApp, type TestApp } from "./helpers.js";

let current: TestApp | null = null;
afterEach(async () => {
  if (current) await current.cleanup();
  current = null;
});

function projectContext(projectId: string): MemoryToolRunContext {
  return {
    scope: "project",
    projectId,
  };
}

const allContext: MemoryToolRunContext = {
  scope: "all",
  projectId: null,
};

describe("ContextKeep memory evidence service", () => {

  it("enforces project scope server-side instead of trusting model arguments", async () => {
    const t = (current = await makeTestApp({ seed: true }));
    const keyboard = await getProjectByName(t, "ExampleSuite Keyboard");
    const web = await getProjectByName(t, "ExampleSuite Web");
    const service = new ContextKeepMemoryService(t.app.ck.deps);
    const context = projectContext(keyboard.id);

    const listed = service.listProjects(context, 50) as { projects: Array<{ id: string }> };
    expect(listed.projects.map((project) => project.id)).toEqual([keyboard.id]);

    try {
      service.getProjectOverview(context, { projectId: web.id });
      throw new Error("expected scope violation");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("agent_scope_violation");
    }
  });

  it("searches canonical reviewed records only and keeps stable evidence identifiers", async () => {
    const t = (current = await makeTestApp({ seed: true }));
    const keyboard = await getProjectByName(t, "ExampleSuite Keyboard");
    const dsh = await getProjectByName(t, "ExampleAssistant");
    const service = new ContextKeepMemoryService(t.app.ck.deps);

    const keyboardResult = service.searchContext(allContext, {
      q: "OpenAI",
      projectId: keyboard.id,
      limit: 10,
    }) as {
      records: Array<{
        reviewStatus: string;
        evidence: Array<{ sourceId: string; excerptId: string }>;
      }>;
    };
    expect(keyboardResult.records.length).toBeGreaterThan(0);
    expect(keyboardResult.records.every((record) => record.reviewStatus === "accepted")).toBe(true);
    expect(keyboardResult.records.some((record) => record.evidence.length > 0)).toBe(true);
    for (const record of keyboardResult.records) {
      for (const evidence of record.evidence) {
        expect(evidence.sourceId).toBeTruthy();
        expect(evidence.excerptId).toBeTruthy();
      }
    }

    // ExampleAssistant seed material is proposal-only. The agent search surface must not
    // promote raw source matches or proposed records into canonical retrieval.
    const dshResult = service.searchContext(allContext, {
      q: "ExampleAssistant",
      projectId: dsh.id,
      limit: 10,
    }) as { records: unknown[] };
    expect(dshResult.records).toEqual([]);
  });

  it("preserves synthesis status/evidence and denies cross-project record reads", async () => {
    const t = (current = await makeTestApp({ seed: true }));
    const keyboard = await getProjectByName(t, "ExampleSuite Keyboard");
    const web = await getProjectByName(t, "ExampleSuite Web");
    const service = new ContextKeepMemoryService(t.app.ck.deps);
    const context = projectContext(keyboard.id);

    const synthesis = service.synthesizeContext(context, {
      question: "OpenAI voice feature",
      limit: 10,
    }) as {
      status: string;
      claims: Array<{ recordId: string; evidence: Array<{ sourceId: string; excerptId: string }> }>;
    };
    expect(synthesis.status).toBe("known");
    expect(synthesis.claims.length).toBeGreaterThan(0);
    expect(synthesis.claims.every((claim) => claim.evidence.length > 0)).toBe(true);

    const other = t.app.ck.deps.sqlite
      .prepare("SELECT id FROM records WHERE project_id = ? AND review_status = 'accepted' LIMIT 1")
      .get(web.id) as { id: string } | undefined;
    expect(other).toBeTruthy();
    try {
      service.getRecordWithEvidence(context, other!.id);
      throw new Error("expected scope violation");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("agent_scope_violation");
    }
  });

  it("returns agent-history metadata only, never transcript/source bodies", async () => {
    const t = (current = await makeTestApp({ seed: true }));
    const keyboard = await getProjectByName(t, "ExampleSuite Keyboard");
    const service = new ContextKeepMemoryService(t.app.ck.deps);
    const source = t.app.ck.deps.sqlite.prepare("SELECT id FROM sources LIMIT 1").get() as { id: string };
    const workspaceId = crypto.randomUUID();
    const originId = crypto.randomUUID();
    const now = "2026-09-11T12:00:00.000Z";
    const sentinel = "NEVER_EXPOSE_AGENT_HISTORY_BODY_7c18";

    t.app.ck.deps.sqlite
      .prepare("UPDATE sources SET original_text = original_text || ? WHERE id = ?")
      .run(sentinel, source.id);
    t.app.ck.deps.sqlite
      .prepare(
        `INSERT INTO workspace_bindings
          (id, canonical_key, canonical_path, display_name, git_remote, git_branch, git_head_sha,
           last_git_activity, last_observed_activity, project_id, ignored, first_seen_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(workspaceId, `path:${workspaceId}`, `/tmp/${workspaceId}`, "Keyboard fixture", now, now, keyboard.id, now, now, now, now);
    t.app.ck.deps.sqlite
      .prepare(
        `INSERT INTO source_origins
          (id, source_id, connector, external_id, external_part, external_revision, external_hash,
           workspace_binding_id, archive_state, external_updated_at, created_at)
         VALUES (?, ?, 'codex', ?, 'full', NULL, NULL, ?, 'archived', ?, ?)`,
      )
      .run(originId, source.id, "fixture-session", workspaceId, now, now);

    const result = service.listAgentHistory(projectContext(keyboard.id), { limit: 10 }) as {
      contentIncluded: boolean;
      history: Array<Record<string, unknown>>;
    };
    expect(result.contentIncluded).toBe(false);
    expect(result.history).toHaveLength(1);
    expect(result.history[0]?.externalId).toBe("fixture-session");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("originalText");
    expect(serialized).not.toContain("normalizedText");
  });
});
