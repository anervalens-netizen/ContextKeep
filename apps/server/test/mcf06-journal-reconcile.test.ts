import { describe, expect, it } from "vitest";
import { createAdapterRegistry } from "../src/adapters/registry.js";
import { bootstrapDatabase } from "../src/db/bootstrap.js";
import { openDatabase } from "../src/db/client.js";
import { captureWork } from "../src/services/capture-work.js";
import { buildContextManifest, ensureContextCursorBaselines, readContextCursorSnapshot } from "../src/services/context-journal.js";
import type { ActorCtx, ServiceDeps } from "../src/services/import.js";
import { createProject, requireProject } from "../src/services/memory-management.js";

const ctx: ActorCtx = { actor: "test:mcf06", requestId: null };

describe("MCF-06 journal reconciliation", () => {
  it("repairs a stale current derived snapshot with an explicit cursor advance", () => {
    const handle = openDatabase(":memory:");
    try {
      bootstrapDatabase(handle);
      const deps: ServiceDeps = {
        ...handle,
        registry: createAdapterRegistry(["manual"]),
        costCeilingUsd: 0,
        volatileReviewIntervalDays: 7,
      };
      const project = createProject(deps, { name: "mcf06-reconcile", aliases: [], description: null, parentId: null }, ctx);
      captureWork(deps, {
        projectId: project.id,
        outcome: "derived repair",
        evidenceText: null,
        title: null,
        eventAt: null,
        recordType: "fact",
        subject: "derived repair",
        progressUpdates: [],
      }, ctx);

      const before = requireProject(deps, project.id);
      handle.sqlite.prepare(
        "UPDATE context_cursor_snapshots SET manifest_json='{}' WHERE project_id=? AND scope='working' AND cursor=?",
      ).run(project.id, before.workingMemoryVersion);

      ensureContextCursorBaselines(deps.db);

      const after = requireProject(deps, project.id);
      expect(after.workingMemoryVersion).toBe(before.workingMemoryVersion + 1);
      const snapshot = readContextCursorSnapshot(deps.db, project.id, "working", after.workingMemoryVersion);
      expect(snapshot).not.toBeNull();
      expect(JSON.parse(snapshot!.manifestJson)).toEqual(buildContextManifest(deps.db, project.id, "working"));
    } finally {
      handle.sqlite.close();
    }
  });
});
