import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAdapterRegistry } from "../src/adapters/registry.js";
import { loadConfig } from "../src/config.js";
import { bootstrapDatabase } from "../src/db/bootstrap.js";
import { openDatabase } from "../src/db/client.js";
import { backupFreshnessStatus } from "../src/services/backup.js";
import { captureWork } from "../src/services/capture-work.js";
import { CONTEXT_CURSOR_RETENTION_PER_SCOPE } from "../src/services/context-journal.js";
import { getContextDelta } from "../src/services/context-delta.js";
import type { ActorCtx, ServiceDeps } from "../src/services/import.js";
import {
  createProject,
  requireProject,
} from "../src/services/memory-management.js";
import { makeTestApp } from "./helpers.js";

const ctx: ActorCtx = { actor: "test:mcf11", requestId: null };

describe("MCF-11 growth and maintenance", () => {
  it("caches verified backup hashing by file identity and invalidates after bytes change", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ck-mcf11-backup-"));
    const file = path.join(dir, "store-2026-09-22T14-00-00-000Z.sqlite");
    try {
      fs.writeFileSync(file, Buffer.alloc(1024 * 1024, 0x61));
      const stat = fs.statSync(file);
      const sha256 = crypto
        .createHash("sha256")
        .update(fs.readFileSync(file))
        .digest("hex");
      fs.writeFileSync(
        file + ".meta.json",
        JSON.stringify({
          version: 1,
          fileName: path.basename(file),
          attemptedAt: "2026-09-22T14:00:00.000Z",
          completedAt: "2026-09-22T14:00:00.000Z",
          verifiedAt: "2026-09-22T14:00:00.000Z",
          schemaVersion: 16,
          sizeBytes: stat.size,
          sha256,
          counts: {
            projects: 1,
            sources: 1,
            records: 1,
            supersessions: 0,
            auditEvents: 1,
          },
        }),
      );

      expect(
        backupFreshnessStatus(dir, Date.parse("2026-09-22T14:01:00.000Z"))
          .verificationStatus,
      ).toBe("verified");

      const readSpy = vi.spyOn(fs, "readSync");
      const second = backupFreshnessStatus(
        dir,
        Date.parse("2026-09-22T14:02:00.000Z"),
      );
      expect(second.verificationStatus).toBe("verified");
      expect(readSpy).not.toHaveBeenCalled();

      fs.writeFileSync(file, Buffer.alloc(1024 * 1024, 0x62));
      const future = new Date(Date.now() + 2_000);
      fs.utimesSync(file, future, future);
      const changed = backupFreshnessStatus(
        dir,
        Date.parse("2026-09-22T14:03:00.000Z"),
      );
      expect(changed.verificationStatus).toBe("changed_or_invalid");
      expect(readSpy).toHaveBeenCalled();
      readSpy.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds derived cursor snapshots while an expired client reconstructs the complete working baseline", () => {
    const handle = openDatabase(":memory:");
    try {
      bootstrapDatabase(handle);
      const deps: ServiceDeps = {
        ...handle,
        registry: createAdapterRegistry(["manual"]),
        costCeilingUsd: 0,
        volatileReviewIntervalDays: 7,
      };
      const project = createProject(
        deps,
        {
          name: "MCF11 retention",
          aliases: [],
          description: null,
          parentId: null,
        },
        ctx,
      );
      for (let i = 0; i < 100; i += 1) {
        captureWork(
          deps,
          {
            projectId: project.id,
            outcome: `retained working record ${i}`,
            evidenceText: `retention evidence ${i}`,
            title: null,
            eventAt: null,
            recordType: "fact",
            subject: `retention-${i}`,
            progressUpdates: [],
          },
          ctx,
        );
      }

      const snapshotCount = (
        handle.sqlite
          .prepare(
            "SELECT count(*) AS n FROM context_cursor_snapshots WHERE project_id=? AND scope='working'",
          )
          .get(project.id) as { n: number }
      ).n;
      expect(snapshotCount).toBe(CONTEXT_CURSOR_RETENTION_PER_SCOPE);

      const current = requireProject(deps, project.id);
      let page = getContextDelta(deps, {
        projectId: project.id,
        canonicalCursor: 0,
        workingCursor: 0,
        projectRevision: current.revision,
        limit: 37,
      });
      expect(page.resetRequired).toBe(true);
      expect(page.baselineMode).toBe("changes_from_empty");

      const ids = new Set<string>();
      for (;;) {
        for (const change of page.changes) {
          if (change.scope === "working" && change.kind === "upsert")
            ids.add(change.recordId);
        }
        if (!page.nextPageToken) break;
        page = getContextDelta(deps, {
          projectId: project.id,
          canonicalCursor: 0,
          workingCursor: 0,
          projectRevision: current.revision,
          limit: 37,
          pageToken: page.nextPageToken,
        });
      }
      expect(ids.size).toBe(100);
    } finally {
      handle.sqlite.close();
    }
  });

  it("fails closed on a missing production session secret and exposes a normalized build SHA in config", () => {
    expect(() => loadConfig({ NODE_ENV: "production" }, {})).toThrow(
      /CK_SESSION_SECRET.*required/i,
    );
    const config = loadConfig(
      {
        NODE_ENV: "production",
        CK_SESSION_SECRET: "production-secret-0123456789",
        CK_BUILD_SHA: "ABCDEF1234567890",
      },
      {},
    );
    expect(config.secretIsEphemeral).toBe(false);
    expect(config.buildSha).toBe("abcdef1234567890");
  });

  it("publishes the exact configured build SHA through authenticated meta", async () => {
    const t = await makeTestApp({ buildSha: "ABCDEF1234567890" });
    try {
      const response = await t.get("/api/meta");
      expect(response.statusCode).toBe(200);
      expect(response.json<{ buildSha: string | null }>().buildSha).toBe(
        "abcdef1234567890",
      );
    } finally {
      await t.cleanup();
    }
  });

  it("does not retain the retired AI PR Review workflow", () => {
    expect(
      fs.existsSync(path.resolve("../../.github/workflows/ai-pr-review.yml")),
    ).toBe(false);
  });
});
