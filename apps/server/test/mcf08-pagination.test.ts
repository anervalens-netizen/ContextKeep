import { describe, expect, it } from "vitest";
import { createAdapterRegistry } from "../src/adapters/registry.js";
import { bootstrapDatabase } from "../src/db/bootstrap.js";
import { openDatabase } from "../src/db/client.js";
import { captureWork } from "../src/services/capture-work.js";
import { getContextDelta } from "../src/services/context-delta.js";
import type { ActorCtx, ServiceDeps } from "../src/services/import.js";
import { createProject, requireProject } from "../src/services/memory-management.js";
import { toolResult } from "../src/mcp/safety.js";

const ctx: ActorCtx = { actor: "test:mcf08", requestId: null };

function fixture(name: string) {
  const handle = openDatabase(":memory:");
  bootstrapDatabase(handle);
  const deps: ServiceDeps = {
    ...handle,
    registry: createAdapterRegistry(["manual"]),
    costCeilingUsd: 0,
    volatileReviewIntervalDays: 7,
  };
  const project = createProject(deps, { name, aliases: [], description: null, parentId: null }, ctx);
  return { handle, deps, project };
}

function curs(f: ReturnType<typeof fixture>) {
  const p = requireProject(f.deps, f.project.id);
  return { canonicalCursor: p.contentVersion, workingCursor: p.workingMemoryVersion, projectRevision: p.revision };
}

describe("MCF-08 bounded reset and pagination edges", () => {
  it("returns a small inline reset for an empty project", () => {
    const f = fixture("mcf08-empty");
    try {
      const current = curs(f);
      const reset = getContextDelta(f.deps, {
        projectId: f.project.id,
        ...current,
        canonicalCursor: current.canonicalCursor + 1,
        limit: 100,
      });
      expect(reset.resetRequired).toBe(true);
      expect(reset.fullSnapshot).toBeTruthy();
      expect(reset.fullSnapshotTruncated).toBe(false);
      expect(reset.changes).toEqual([]);
      expect(reset.nextPageToken).toBeNull();
      expect(() => toolResult(reset, [])).not.toThrow();
    } finally {
      f.handle.sqlite.close();
    }
  });

  it("paginates a max-limit Unicode baseline without omission or duplication", () => {
    const f = fixture("mcf08-unicode");
    try {
      for (let i = 0; i < 105; i += 1) {
        captureWork(f.deps, {
          projectId: f.project.id,
          outcome: `stare-🙂-漢字-${i}`,
          evidenceText: `dovadă unicode 🙂 漢字 ${i}`,
          title: null,
          eventAt: null,
          recordType: "fact",
          subject: `unicode-${i}`,
          progressUpdates: [],
        }, ctx);
      }
      const current = curs(f);
      const first = getContextDelta(f.deps, {
        projectId: f.project.id,
        ...current,
        workingCursor: current.workingCursor + 1,
        limit: 100,
      });
      expect(first.resetRequired).toBe(true);
      expect(first.returned).toBe(100);
      expect(first.nextPageToken).toBeTruthy();
      expect(() => toolResult(first, [])).not.toThrow();

      const second = getContextDelta(f.deps, {
        projectId: f.project.id,
        ...current,
        workingCursor: current.workingCursor + 1,
        limit: 100,
        pageToken: first.nextPageToken,
      });
      expect(second.returned).toBe(5);
      expect(second.nextPageToken).toBeNull();
      const ids = [...first.changes, ...second.changes].map((change) => change.recordId);
      expect(ids).toHaveLength(105);
      expect(new Set(ids).size).toBe(105);
      expect(() => toolResult(second, [])).not.toThrow();
    } finally {
      f.handle.sqlite.close();
    }
  });
});
