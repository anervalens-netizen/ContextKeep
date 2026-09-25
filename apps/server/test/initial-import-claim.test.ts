import { describe, expect, it } from "vitest";
import type { ExtractionAdapter } from "@contextkeep/shared";
import { ImportTextInput } from "@contextkeep/shared";
import { eq } from "drizzle-orm";
import { importJobs } from "../src/db/schema.js";
import { ApiError } from "../src/lib/errors.js";
import {
  INITIAL_IMPORT_CLAIM_MARKER,
  initialImportClaimId,
  recoverInterruptedInitialImportClaims,
  runDurablyClaimedImport,
} from "../src/services/initial-import-claim.js";
import { sha256 } from "../src/lib/hash.js";
import { normalizeText } from "../src/services/normalize.js";
import { makeTestApp } from "./helpers.js";

function slowAdapter(gate: Promise<void>, onExtract: () => void): ExtractionAdapter {
  return {
    id: "slowtest",
    version: "1.0.0",
    label: "F08 slow test adapter",
    costCategory: "free",
    async estimateUsage() {
      return null;
    },
    async extract() {
      onExtract();
      await gate;
      return { candidates: [], usage: null };
    },
  };
}

function registryFor(adapter: ExtractionAdapter) {
  return {
    enabledIds: () => [adapter.id],
    get(id: string) {
      if (id !== adapter.id) throw new Error(`unexpected adapter ${id}`);
      return adapter;
    },
    list: () => [{ id: adapter.id, label: adapter.label, version: adapter.version, enabled: true }],
  };
}

describe("F08 durable initial import/provider claim", () => {
  it("commits the claim before provider extraction and refuses a concurrent identical provider call", async () => {
    const t = await makeTestApp({ seed: false });
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const providerEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let extractCalls = 0;
      const adapter = slowAdapter(gate, () => {
        extractCalls += 1;
        entered();
      });
      t.app.ck.deps.registry = registryFor(adapter);
      const input = ImportTextInput.parse({
        text: "fact: F08 provider work must have durable ownership before it starts",
        adapterId: "slowtest",
      });

      const first = runDurablyClaimedImport(t.app.ck.deps, input, { actor: "test:first" });
      await providerEntered;

      const pendingClaim = t.app.ck.deps.db
        .select()
        .from(importJobs)
        .all()
        .find((row) => row.stage === "chunked" && row.usageJson === INITIAL_IMPORT_CLAIM_MARKER);
      expect(pendingClaim).toBeDefined();
      expect(extractCalls).toBe(1);

      let secondError: unknown = null;
      try {
        await runDurablyClaimedImport(t.app.ck.deps, input, { actor: "test:second" });
      } catch (error) {
        secondError = error;
      }
      expect(secondError).toBeInstanceOf(ApiError);
      expect((secondError as ApiError).code).toBe("import_in_progress");
      expect(extractCalls).toBe(1);

      release();
      const result = await first;
      expect(result.status).toBe("created");
      expect(extractCalls).toBe(1);

      const claimAfter = t.app.ck.deps.db
        .select()
        .from(importJobs)
        .all()
        .find((row) => row.id === pendingClaim!.id);
      expect(claimAfter?.stage).toBe("done");
      expect(claimAfter?.sourceId).toBe(result.source?.id);
    } finally {
      await t.cleanup();
    }
  });

  it("reclaims a terminal claim whose source was deleted before any provider call", async () => {
    const t = await makeTestApp({ seed: false });
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const providerEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let extractCalls = 0;
      const adapter = slowAdapter(gate, () => {
        extractCalls += 1;
        entered();
      });
      t.app.ck.deps.registry = registryFor(adapter);
      const input = ImportTextInput.parse({
        text: "fact: reclaim an initial import claim after its source is deleted",
        adapterId: "slowtest",
      });
      const claimId = initialImportClaimId(sha256(normalizeText(input.text)));
      const now = new Date().toISOString();
      t.app.ck.deps.db
        .insert(importJobs)
        .values({
          id: claimId,
          sourceId: null,
          stage: "done",
          adapterId: "slowtest",
          adapterVersion: "1.0.0",
          providerModel: null,
          attempts: 1,
          errorCode: null,
          usageJson: INITIAL_IMPORT_CLAIM_MARKER,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const first = runDurablyClaimedImport(t.app.ck.deps, input, { actor: "test:reclaim:first" });
      await providerEntered;
      let secondError: unknown = null;
      try {
        await runDurablyClaimedImport(t.app.ck.deps, input, { actor: "test:reclaim:second" });
      } catch (error) {
        secondError = error;
      }
      expect(secondError).toBeInstanceOf(ApiError);
      expect((secondError as ApiError).code).toBe("import_in_progress");
      expect(extractCalls).toBe(1);

      release();
      const result = await first;
      expect(result.status).toBe("created");
      expect(extractCalls).toBe(1);
      const claim = t.app.ck.deps.db.select().from(importJobs).where(eq(importJobs.id, claimId)).get();
      expect(claim?.stage).toBe("done");
      expect(claim?.sourceId).toBe(result.source?.id);
    } finally {
      await t.cleanup();
    }
  });

  it("marks an interrupted claim failed so the next process can reclaim it", async () => {
    const t = await makeTestApp({ seed: false });
    try {
      const now = new Date().toISOString();
      t.app.ck.deps.db
        .insert(importJobs)
        .values({
          id: "11111111-1111-5111-8111-111111111111",
          sourceId: null,
          stage: "chunked",
          adapterId: "slowtest",
          adapterVersion: "1.0.0",
          providerModel: null,
          attempts: 1,
          errorCode: null,
          usageJson: INITIAL_IMPORT_CLAIM_MARKER,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      expect(recoverInterruptedInitialImportClaims(t.app.ck.deps)).toBe(1);
      const row = t.app.ck.deps.db.select().from(importJobs).all().find((job) => job.id.startsWith("11111111"));
      expect(row?.stage).toBe("failed");
      expect(row?.errorCode).toBe("interrupted_restart");
    } finally {
      await t.cleanup();
    }
  });
});
