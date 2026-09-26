import { beforeEach, describe, expect, it } from "vitest";
import { ApiError, apiFetch } from "../src/lib/api.js";
import { validateMutationAcknowledgement } from "../src/lib/mutation-ack.js";
import { offlineDb } from "../src/lib/offline/db.js";
import { cancelOfflineRetry } from "../src/lib/offline/scheduler.js";
import { dismissConflict, enqueueMutation, listConflicts, listMutations, replayQueue } from "../src/lib/offline/queue.js";

const stamp = "2026-01-01T00:00:00.000Z";
const project = (id = "project-1", name = "Synthetic project") => ({
  id, name, aliases: [], parentId: null, description: null, lifecycle: "unknown",
  lifecycleRecordId: null, revision: 1, contentVersion: 0, workingMemoryVersion: 0,
  createdAt: stamp, updatedAt: stamp,
});
const record = (id = "record-1") => ({
  id, projectId: null, projectName: null, type: "fact", subject: "synthetic", predicate: null,
  valueJson: null, text: "Synthetic record", reviewStatus: "proposed", evidenceBasis: "document",
  taskStatus: null, recordedAt: stamp, sourceEventAt: null, effectiveFrom: null, effectiveTo: null,
  reviewedAt: null, reviewDueAt: null, volatile: false, isOverdue: false, revision: 1,
  createdAt: stamp, updatedAt: stamp, evidence: [],
});
const importPreview = {
  jobId: "job-1", status: "created", source: null, duplicateOf: null, nearDuplicates: [],
  excerptCount: 0, candidateCount: 0, warnings: [], providerUsage: null, actualUsage: null, costCeilingUsd: 0,
};

beforeEach(async () => {
  const db = await offlineDb();
  await db.clear("mutations");
  await db.clear("conflicts");
  cancelOfflineRetry();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

describe("operation-specific mutation acknowledgements", () => {
  it("accepts actual project, record, import, and inbox response contracts", () => {
    expect(validateMutationAcknowledgement("/api/projects", "POST", { name: "Synthetic project" }, project()).valid).toBe(true);
    expect(validateMutationAcknowledgement("/api/records/record-1", "PUT", { revision: 1, text: "edit" }, record()).valid).toBe(true);
    expect(validateMutationAcknowledgement("/api/records/record-1", "PUT", { revision: 1, text: "edit" }, { ...record(), revision: 2 }).valid).toBe(true);
    expect(validateMutationAcknowledgement("/api/imports/text", "POST", { text: "synthetic" }, importPreview).valid).toBe(true);
    expect(validateMutationAcknowledgement(
      "/api/corrections/job-1/confirm",
      "POST",
      {},
      { jobId: "job-1", acceptedRecordIds: [], supersededRecordIds: [], confirmedSupersessionIds: [] },
    ).valid).toBe(true);
    expect(validateMutationAcknowledgement(
      "/api/inbox/decide",
      "POST",
      { action: "accept", items: [{ recordId: "record-1" }] },
      { accepted: ["record-1"], rejected: [], edited: [], blocked: [] },
    ).valid).toBe(true);
    expect(validateMutationAcknowledgement(
      "/api/inbox/decide",
      "POST",
      { action: "accept", items: [{ recordId: "record-1", revision: 1, edit: { text: "edited" } }] },
      { accepted: ["record-1"], rejected: [], edited: ["record-1"], blocked: [] },
    ).valid).toBe(true);
  });

  it("rejects generic success objects and wrong identities", () => {
    expect(validateMutationAcknowledgement("/api/projects", "POST", { name: "Synthetic project" }, { ok: true }).valid).toBe(false);
    expect(validateMutationAcknowledgement("/api/records/record-1", "PUT", { revision: 1 }, record("other-record")).valid).toBe(false);
    expect(validateMutationAcknowledgement("/api/records/record-1", "PUT", { revision: 1 }, { ...record(), revision: 3 }).valid).toBe(false);
    expect(validateMutationAcknowledgement(
      "/api/corrections/job-1/confirm",
      "POST",
      {},
      { jobId: "job-2", acceptedRecordIds: [], supersededRecordIds: [], confirmedSupersessionIds: [] },
    ).valid).toBe(false);
    expect(validateMutationAcknowledgement(
      "/api/inbox/decide",
      "POST",
      { items: [{ recordId: "record-1" }] },
      { accepted: ["unexpected-record"], rejected: [], edited: [], blocked: [] },
    ).valid).toBe(false);
  });

  it("keeps inbox primary outcomes disjoint while allowing edited accepted records", () => {
    const request = { action: "accept", items: [{ recordId: "record-1", revision: 1 }] };
    expect(validateMutationAcknowledgement(
      "/api/inbox/decide", "POST", request,
      { accepted: ["record-1"], rejected: [], edited: ["record-1"], blocked: [] },
    ).valid).toBe(true);
    expect(validateMutationAcknowledgement(
      "/api/inbox/decide", "POST", request,
      { accepted: ["record-1"], rejected: [], edited: ["record-1", "record-1"], blocked: [] },
    ).valid).toBe(false);
    expect(validateMutationAcknowledgement(
      "/api/inbox/decide", "POST", request,
      { accepted: ["record-1"], rejected: ["record-1"], edited: [], blocked: [] },
    ).valid).toBe(false);
    expect(validateMutationAcknowledgement(
      "/api/inbox/decide", "POST", { action: "reject", items: [{ recordId: "record-1" }] },
      { accepted: ["record-1"], rejected: [], edited: ["record-1"], blocked: [] },
    ).valid).toBe(false);
    expect(validateMutationAcknowledgement(
      "/api/inbox/decide", "POST", request,
      { accepted: [], rejected: [], edited: [], blocked: [] },
    ).valid).toBe(false);
  });

  it("rejects malformed encoded path identities and preserves the queued row", async () => {
    const key = "stable-malformed-record-path";
    const body = { revision: 1, text: "Synthetic edit" };
    await enqueueMutation({
      method: "PUT",
      url: "/api/records/%E0%A4%A",
      body,
      enqueuedAt: stamp,
      idempotencyKey: key,
    });
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => record("%E0%A4%A"),
    })) as unknown as typeof fetch;

    const result = await replayQueue();
    expect(result.stoppedReason).toBe("response_invalid");
    expect(await listMutations()).toMatchObject([{
      url: "/api/records/%E0%A4%A",
      body,
      idempotencyKey: key,
      deliveryState: "queued",
    }]);
  });

  it.each([
    { label: "empty JSON", response: () => ({ ok: true, status: 204, json: async () => { throw new SyntaxError("empty"); } }) },
    { label: "HTML body", response: () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }) },
    { label: "truncated body", response: () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("truncated"); } }) },
    { label: "redirect", response: () => ({ ok: true, status: 200, redirected: true, json: async () => project() }) },
    { label: "HTTP redirect", response: () => ({ ok: false, status: 302, json: async () => project() }) },
  ])("retains the same queued mutation for $label", async ({ response }) => {
    const key = `stable-${labelToKey(response)}`;
    await enqueueMutation({ method: "POST", url: "/api/projects", body: { name: "Synthetic project" }, enqueuedAt: stamp, idempotencyKey: key });
    globalThis.fetch = (async () => response()) as unknown as typeof fetch;

    const result = await replayQueue();
    expect(result.replayed).toBe(0);
    expect(result.stoppedReason).toBe("response_invalid");
    const rows = await listMutations();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotencyKey).toBe(key);
    expect(rows[0]!.deliveryState).toBe("queued");
  });

  it("deletes a queued mutation only after a validated success body", async () => {
    const key = "stable-success-project";
    await enqueueMutation({ method: "POST", url: "/api/projects", body: { name: "Synthetic project" }, enqueuedAt: stamp, idempotencyKey: key });
    globalThis.fetch = (async () => ({ ok: true, status: 201, json: async () => project() })) as unknown as typeof fetch;

    const result = await replayQueue();
    expect(result.replayed).toBe(1);
    expect(await listMutations()).toEqual([]);
  });

  it("retains a record edit when a valid-shaped response has the wrong identity", async () => {
    const key = "stable-wrong-record";
    const body = { revision: 1, text: "Synthetic edit" };
    await enqueueMutation({ method: "PUT", url: "/api/records/record-1", body, enqueuedAt: stamp, idempotencyKey: key });
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => record("other-record") })) as unknown as typeof fetch;

    const result = await replayQueue();
    expect(result.stoppedReason).toBe("response_invalid");
    const rows = await listMutations();
    expect(rows[0]).toMatchObject({ method: "PUT", url: "/api/records/record-1", body, idempotencyKey: key, deliveryState: "queued" });
  });

  it("preserves an expired completed key as an online reconciliation conflict", async () => {
    const key = "stable-expired-online";
    globalThis.fetch = (async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: "idempotency_result_expired", message: "completed result expired", details: null } }),
    })) as unknown as typeof fetch;

    await expect(apiFetch("/api/projects", { method: "POST", body: { name: "Synthetic project" }, idempotencyKey: key })).rejects.toBeInstanceOf(ApiError);
    expect(await listMutations()).toEqual([]);
    const conflicts = await listConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.code).toBe("idempotency_result_expired");
    expect(conflicts[0]!.mutation.idempotencyKey).toBe(key);
  });

  it("stops offline replay on an expired completed key without re-keying it", async () => {
    const key = "stable-expired-offline";
    await enqueueMutation({ method: "POST", url: "/api/projects", body: { name: "Synthetic project" }, enqueuedAt: stamp, idempotencyKey: key });
    globalThis.fetch = (async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: "idempotency_result_expired", message: "completed result expired", details: null } }),
    })) as unknown as typeof fetch;

    const result = await replayQueue();
    expect(result.stoppedReason).toBe("idempotency_result_expired");
    expect(result.replayed).toBe(0);
    const conflicts = await listConflicts();
    expect(conflicts[0]!.mutation.idempotencyKey).toBe(key);
    expect(await listMutations()).toEqual([]);
  });

  it("blocks a later online write behind an expired-result barrier until acknowledgement", async () => {
    const barrierKey = "stable-expired-online-barrier";
    const db = await offlineDb();
    await db.add("conflicts", {
      mutation: { method: "POST", url: "/api/projects", body: { name: "earlier" }, enqueuedAt: stamp, idempotencyKey: barrierKey, deliveryState: "queued" },
      status: 409,
      code: "idempotency_result_expired",
      message: "earlier request completed, saved response expired",
      detectedAt: stamp,
    });
    const calls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url));
      return { ok: true, status: 201, json: async () => project("project-1", "later") };
    }) as unknown as typeof fetch;

    await expect(apiFetch("/api/projects", {
      method: "POST",
      body: { name: "later" },
      idempotencyKey: "stable-later-online",
    })).rejects.toBeInstanceOf(Error);
    expect(calls).toEqual([]);
    expect((await listMutations())[0]).toMatchObject({
      body: { name: "later" },
      idempotencyKey: "stable-later-online",
      deliveryState: "queued",
    });

    const [conflict] = await listConflicts();
    await dismissConflict(conflict!.seq!);
    const resumed = await replayQueue();
    expect(resumed.replayed).toBe(1);
    expect(calls).toEqual(["/api/projects"]);
    expect(await listMutations()).toEqual([]);
  });

  it("holds later replay rows behind an expired-result barrier across replay", async () => {
    const db = await offlineDb();
    await db.add("conflicts", {
      mutation: { method: "POST", url: "/api/projects", body: { name: "earlier" }, enqueuedAt: stamp, idempotencyKey: "stable-expired-replay", deliveryState: "queued" },
      status: 409,
      code: "idempotency_result_expired",
      message: "earlier request completed, saved response expired",
      detectedAt: stamp,
    });
    await enqueueMutation({ method: "POST", url: "/api/projects", body: { name: "later" }, enqueuedAt: stamp, idempotencyKey: "stable-later-replay" });
    const calls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url));
      return { ok: true, status: 201, json: async () => project("project-1", "later") };
    }) as unknown as typeof fetch;

    const blocked = await replayQueue();
    expect(blocked.stoppedReason).toBe("idempotency_result_expired");
    expect(calls).toEqual([]);
    expect((await listMutations())[0]).toMatchObject({ idempotencyKey: "stable-later-replay" });

    const [conflict] = await listConflicts();
    await dismissConflict(conflict!.seq!);
    const resumed = await replayQueue();
    expect(resumed.replayed).toBe(1);
    expect(calls).toEqual(["/api/projects"]);
    expect(await listMutations()).toEqual([]);
  });
});

function labelToKey(response: () => unknown): string {
  const value = response();
  return typeof value === "object" && value !== null && "redirected" in value ? "redirect" : "body";
}
