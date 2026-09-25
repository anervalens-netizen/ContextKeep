import { describe, expect, it } from "vitest";
import { projects, recordEvidence, records, sources, supersessions } from "../src/db/schema.js";
import {
  applyPortableDump,
  buildPortableJsonDump,
  PORTABLE_DUMP_EXCLUDED,
  PORTABLE_DUMP_INCLUDED,
  summarizePortableDump,
} from "../src/services/portable-dump.js";
import { expectStatus, getInboxCandidates, makeTestApp, reviewCurrent } from "./helpers.js";

describe("A4 portable JSON dump v3", () => {
  it("exports only the round-trippable portable entity contract", async () => {
    const t = await makeTestApp({ seed: false });
    try {
      const imported = await t.post("/api/imports/text", {
        text: "fact: portable dump round trip keeps evidence-linked records",
        adapterId: "faketest",
      });
      expect(imported.statusCode).toBe(201);

      const dump = buildPortableJsonDump(t.app.ck.deps, { actor: "test:export" });
      expect(dump.format).toBe("contextkeep.json_dump");
      expect(dump.version).toBe(3);
      expect(dump.contract.kind).toBe("portable_seed");
      expect(dump.contract.exactDisasterRecovery).toBe(false);
      expect(dump.contract.exactRecoveryMechanism).toBe("sqlite_backup");
      expect(dump.contract.included).toEqual([...PORTABLE_DUMP_INCLUDED]);
      expect(dump.contract.excluded).toEqual([...PORTABLE_DUMP_EXCLUDED]);

      const raw = dump as unknown as Record<string, unknown>;
      for (const key of PORTABLE_DUMP_INCLUDED) expect(Array.isArray(raw[key])).toBe(true);
      for (const key of ["conflicts", "importJobs", "handoffs", "auditEvents", "ownerCredentials", "sessions"]) {
        expect(Object.prototype.hasOwnProperty.call(raw, key)).toBe(false);
      }
    } finally {
      await t.cleanup();
    }
  });

  it("round-trips the v3 portable entities and preserves the original payload SHA", async () => {
    const sourceApp = await makeTestApp({ seed: false });
    const targetApp = await makeTestApp({ seed: false });
    try {
      const imported = await sourceApp.post("/api/imports/text", {
        text: "fact: A4 v3 round trip has one source and one proposed record",
        adapterId: "faketest",
      });
      expect(imported.statusCode).toBe(201);
      const dump = buildPortableJsonDump(sourceApp.app.ck.deps, { actor: "test:source" });
      const summary = summarizePortableDump(dump);
      expect(summary.ok).toBe(true);

      const counters = applyPortableDump(
        targetApp.app.ck.deps,
        { dump, mode: "merge", source: "test:v2" },
        { actor: "test:target", requestId: "portable-v2-roundtrip" },
      );
      expect(counters.blocked).toBe(0);
      if (summary.ok) expect(counters.dumpSha256).toBe(summary.sha256);

      const sourceRows = targetApp.app.ck.deps.db.select().from(sources).all();
      const recordRows = targetApp.app.ck.deps.db.select().from(records).all();
      expect(sourceRows).toHaveLength(1);
      expect(recordRows).toHaveLength(1);
      expect(recordRows[0]!.text).toContain("A4 v3 round trip");
    } finally {
      await sourceApp.cleanup();
      await targetApp.cleanup();
    }
  });

  it("round-trips confirmed supersessions without non-portable import-job foreign keys", async () => {
    const sourceApp = await makeTestApp({ seed: false });
    const targetApp = await makeTestApp({ seed: false });
    try {
      const projectRes = await sourceApp.post("/api/projects", { name: "Portable corrections" });
      expectStatus(projectRes, 200);
      const project = projectRes.json<{ id: string }>();

      const first = await sourceApp.post("/api/corrections", {
        statement: "Portable policy starts in mode A.",
        projectId: project.id,
        scopeProjectIds: [],
        supersedesRecordIds: [],
        lifecycleChange: null,
        recordType: "fact",
        subject: "portable-policy",
        predicate: "mode",
      });
      expectStatus(first, 201);
      const firstPreview = first.json<{ jobId: string; proposedRecordIds: string[] }>();
      const firstConfirm = await sourceApp.post(`/api/corrections/${firstPreview.jobId}/confirm`, {});
      expectStatus(firstConfirm, 200);

      const second = await sourceApp.post("/api/corrections", {
        statement: "Portable policy now uses mode B.",
        projectId: project.id,
        scopeProjectIds: [],
        supersedesRecordIds: [firstPreview.proposedRecordIds[0]!],
        lifecycleChange: null,
        recordType: "fact",
        subject: "portable-policy",
        predicate: "mode",
      });
      expectStatus(second, 201);
      const secondPreview = second.json<{ jobId: string }>();
      const secondConfirm = await sourceApp.post(`/api/corrections/${secondPreview.jobId}/confirm`, {});
      expectStatus(secondConfirm, 200);

      const dump = buildPortableJsonDump(sourceApp.app.ck.deps, { actor: "test:a05" });
      expect(dump.supersessions).toHaveLength(1);
      expect((dump.supersessions[0] as { jobId?: unknown }).jobId).toBeNull();

      const counters = applyPortableDump(
        targetApp.app.ck.deps,
        { dump, mode: "merge", source: "test:a05" },
        { actor: "test:a05-target" },
      );
      expect(counters.blocked).toBe(0);
      const restored = targetApp.app.ck.deps.db.select().from(supersessions).all();
      expect(restored).toHaveLength(1);
      expect(restored[0]!.jobId).toBeNull();
    } finally {
      await sourceApp.cleanup();
      await targetApp.cleanup();
    }
  });

  it("remaps deduplicated source, excerpt and record IDs during merge", async () => {
    const sourceApp = await makeTestApp({ seed: false });
    const targetApp = await makeTestApp({ seed: false });
    try {
      const payload = {
        text: "fact: portable duplicate content must merge through canonical IDs",
        adapterId: "faketest",
        title: "same content",
      };
      expectStatus(await sourceApp.post("/api/imports/text", payload), 201);
      expectStatus(await targetApp.post("/api/imports/text", payload), 201);

      const sourceBefore = sourceApp.app.ck.deps.db.select().from(sources).get()!;
      const targetBefore = targetApp.app.ck.deps.db.select().from(sources).get()!;
      expect(sourceBefore.id).not.toBe(targetBefore.id);
      expect(sourceBefore.contentHash).toBe(targetBefore.contentHash);

      const dump = buildPortableJsonDump(sourceApp.app.ck.deps, { actor: "test:a06" });
      const counters = applyPortableDump(
        targetApp.app.ck.deps,
        { dump, mode: "merge", source: "test:a06" },
        { actor: "test:a06-target" },
      );
      expect(counters.blocked).toBe(0);
      expect(targetApp.app.ck.deps.db.select().from(sources).all()).toHaveLength(1);
      expect(targetApp.app.ck.deps.db.select().from(records).all()).toHaveLength(1);
      expect(targetApp.app.ck.deps.db.select().from(recordEvidence).all()).toHaveLength(1);
    } finally {
      await sourceApp.cleanup();
      await targetApp.cleanup();
    }
  });

  it("preserves volatile record state and project contentVersion", async () => {
    const sourceApp = await makeTestApp({ seed: false });
    const targetApp = await makeTestApp({ seed: false });
    try {
      const projectRes = await sourceApp.post("/api/projects", { name: "Portable freshness" });
      expectStatus(projectRes, 200);
      const project = projectRes.json<{ id: string }>();
      const imported = await sourceApp.post("/api/imports/text", {
        text: "volatile-fact: portable freshness metadata must survive",
        adapterId: "faketest",
        projectId: project.id,
      });
      expectStatus(imported, 201);
      const candidate = (await getInboxCandidates(sourceApp, project.id))[0]!;
      const accepted = await reviewCurrent(sourceApp, [candidate.id], "accept");
      expectStatus(accepted, 200);
      sourceApp.app.ck.deps.db.update(projects).set({ contentVersion: 42 }).run();

      const dump = buildPortableJsonDump(sourceApp.app.ck.deps, { actor: "test:a07" });
      const counters = applyPortableDump(
        targetApp.app.ck.deps,
        { dump, mode: "reset", source: "test:a07" },
        { actor: "test:a07-target" },
      );
      expect(counters.blocked).toBe(0);
      const restoredProject = targetApp.app.ck.deps.db.select().from(projects).get()!;
      const restoredRecord = targetApp.app.ck.deps.db.select().from(records).get()!;
      expect(restoredProject.contentVersion).toBe(42);
      expect(restoredRecord.volatile).toBe(1);
    } finally {
      await sourceApp.cleanup();
      await targetApp.cleanup();
    }
  });

  it("keeps legacy version 1 dumps import-compatible", async () => {
    const t = await makeTestApp({ seed: false });
    try {
      const v1 = {
        format: "contextkeep.json_dump",
        version: 1,
        exportedAt: new Date().toISOString(),
        projects: [],
        sources: [],
        sourceExcerpts: [],
        records: [],
        recordEvidence: [],
        supersessions: [],
      };
      expect(summarizePortableDump(v1).ok).toBe(true);
      const result = applyPortableDump(
        t.app.ck.deps,
        { dump: v1, mode: "merge", source: "test:v1" },
        { actor: "test:v1" },
      );
      expect(result.blocked).toBe(0);
    } finally {
      await t.cleanup();
    }
  });
});
