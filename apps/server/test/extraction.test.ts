import { afterEach, describe, expect, it } from "vitest";
import type { ExistingSourceExtractionResultDto, ImportPreviewDto } from "@contextkeep/shared";
import { recoverInterruptedExtractions } from "../src/services/extraction-recovery.js";
import { extractExistingSource } from "../src/services/extraction.js";
import { ApiError } from "../src/lib/errors.js";
import { expectStatus, makeTestApp, type TestApp } from "./helpers.js";

const apps: TestApp[] = [];

afterEach(async () => {
  while (apps.length) await apps.pop()!.cleanup();
});

async function archiveManual(t: TestApp, text: string): Promise<string> {
  const importedRes = await t.post("/api/imports/text", {
    text,
    kind: "paste",
    title: "archive-only fixture",
    projectId: null,
    adapterId: "manual",
    eventAt: "2026-09-11T06:00:00.000Z",
    authorLabel: "sync-test",
    confirmNearDuplicateOf: null,
  });
  expectStatus(importedRes, 201);
  const imported = importedRes.json<ImportPreviewDto>();
  expect(imported.source).not.toBeNull();
  return imported.source!.id;
}

describe("M3.4 existing-source extraction", () => {
  it("skips a malformed provider candidate without failing or stranding the extraction claim", async () => {
    const t = await makeTestApp({ adapters: "manual,faketest" });
    apps.push(t);
    const sourceId = await archiveManual(t, "provider candidate validation fixture");
    const malformed = {
      id: "malformed-provider",
      version: "1.0.0",
      costCategory: "paid",
      estimateUsage: async () => ({ inputTokens: 1, outputTokens: 1, estCostUsd: 0.01, model: "fixture" }),
      extract: async () => ({
        candidates: [{ type: "fact", subject: "fixture", text: "missing evidence basis", excerptId: "does-not-matter" }],
        usage: null,
      }),
    } as any;
    const original = t.app.ck.deps.registry;
    const deps = {
      ...t.app.ck.deps,
      registry: { ...original, get: (id: string) => id === malformed.id ? malformed : original.get(id) },
    } as any;

    const result = await extractExistingSource(deps, { sourceId, adapterId: malformed.id }, { actor: "fixture" });
    expect(result.status).toBe("created");
    expect(result.candidateCount).toBe(0);
    expect(result.warnings.join(" ")).toMatch(/malformed provider candidate/i);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM records").get() as { n: number }).n).toBe(0);
    const state = t.app.ck.handle.sqlite.prepare("SELECT stage,last_error_code FROM source_extractions WHERE source_id=?").get(sourceId) as { stage: string; last_error_code: string | null };
    expect(state).toEqual({ stage: "done", last_error_code: null });
  });

  it("does not spend provider-attempt budget on repeated preflight configuration failures", async () => {
    const t = await makeTestApp({ adapters: "manual,faketest" });
    apps.push(t);
    const sourceId = await archiveManual(t, "preflight retry budget fixture");
    let configured = false;
    let providerCalls = 0;
    const adapter = {
      id: "preflight-fixture",
      version: "1.0.0",
      costCategory: "paid",
      estimateUsage: async () => {
        if (!configured) throw new ApiError(409, "fixture_missing_config", "synthetic missing config");
        return { inputTokens: 1, outputTokens: 1, estCostUsd: 0.01, model: "fixture" };
      },
      extract: async () => {
        providerCalls += 1;
        return { candidates: [], usage: null };
      },
    } as any;
    const original = t.app.ck.deps.registry;
    const deps = {
      ...t.app.ck.deps,
      registry: { ...original, get: (id: string) => id === adapter.id ? adapter : original.get(id) },
    } as any;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(extractExistingSource(deps, { sourceId, adapterId: adapter.id }, { actor: "fixture" }))
        .rejects.toMatchObject({ code: "fixture_missing_config" });
    }
    let state = t.app.ck.handle.sqlite.prepare("SELECT stage,attempts,last_error_code FROM source_extractions WHERE source_id=?").get(sourceId) as { stage: string; attempts: number; last_error_code: string | null };
    expect(state).toEqual({ stage: "failed", attempts: 0, last_error_code: "fixture_missing_config" });

    configured = true;
    const recovered = await extractExistingSource(deps, { sourceId, adapterId: adapter.id }, { actor: "fixture" });
    expect(recovered.status).toBe("created");
    expect(providerCalls).toBe(1);
    state = t.app.ck.handle.sqlite.prepare("SELECT stage,attempts,last_error_code FROM source_extractions WHERE source_id=?").get(sourceId) as { stage: string; attempts: number; last_error_code: string | null };
    expect(state).toEqual({ stage: "done", attempts: 1, last_error_code: null });
  });

  it("extracts an already archived Manual source without re-importing it and remains idempotent", async () => {
    const t = await makeTestApp({ adapters: "manual,faketest" });
    apps.push(t);
    const sourceId = await archiveManual(
      t,
      "fact: Alpha is explicitly documented.\nowner-claim: Beta was selected by the owner.",
    );

    const before = t.app.ck.handle.sqlite.prepare(`
      SELECT
        (SELECT count(*) FROM sources) AS sources,
        (SELECT count(*) FROM records) AS records,
        (SELECT count(*) FROM source_extractions) AS extractions
    `).get() as { sources: number; records: number; extractions: number };
    expect(before).toEqual({ sources: 1, records: 0, extractions: 0 });

    const firstRes = await t.post(`/api/sources/${sourceId}/extract`, { adapterId: "faketest" });
    expectStatus(firstRes, 200);
    const first = firstRes.json<ExistingSourceExtractionResultDto>();
    expect(first.status).toBe("created");
    expect(first.sourceId).toBe(sourceId);
    expect(first.candidateCount).toBe(2);
    expect(first.clampedOwnerDeclarations).toBe(1);
    expect(first.invalidExcerptCandidates).toBe(0);

    const rows = t.app.ck.handle.sqlite.prepare(`
      SELECT r.review_status, r.evidence_basis, e.source_id
      FROM records r
      JOIN record_evidence re ON re.record_id = r.id
      JOIN source_excerpts e ON e.id = re.excerpt_id
      ORDER BY r.subject
    `).all() as { review_status: string; evidence_basis: string; source_id: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.review_status === "proposed")).toBe(true);
    expect(rows.every((row) => row.source_id === sourceId)).toBe(true);
    expect(rows.some((row) => row.evidence_basis === "owner_declaration")).toBe(false);
    expect(rows.some((row) => row.evidence_basis === "agent_report")).toBe(true);

    const extractionState = t.app.ck.handle.sqlite.prepare(`
      SELECT stage, attempts, adapter_id, adapter_version, project_key
      FROM source_extractions WHERE source_id=?
    `).get(sourceId) as {
      stage: string;
      attempts: number;
      adapter_id: string;
      adapter_version: string;
      project_key: string;
    };
    expect(extractionState.stage).toBe("done");
    expect(extractionState.attempts).toBe(1);
    expect(extractionState.adapter_id).toBe("faketest");
    expect(extractionState.project_key).toBe("");

    const sourceCount = (t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM sources").get() as { n: number }).n;
    const recordCount = (t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM records").get() as { n: number }).n;
    const jobCount = (t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM import_jobs").get() as { n: number }).n;

    const secondRes = await t.post(`/api/sources/${sourceId}/extract`, { adapterId: "faketest" });
    expectStatus(secondRes, 200);
    const second = secondRes.json<ExistingSourceExtractionResultDto>();
    expect(second.status).toBe("unchanged");
    expect(second.jobId).toBeNull();

    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM sources").get() as { n: number }).n).toBe(sourceCount);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM records").get() as { n: number }).n).toBe(recordCount);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM import_jobs").get() as { n: number }).n).toBe(jobCount);
  });

  it("atomically claims one extraction target before async provider work", async () => {
    const t = await makeTestApp({ adapters: "manual,asynctest" });
    apps.push(t);
    const sourceId = await archiveManual(t, "async-fact: only one extraction may run");
    const jobsBefore = (t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM import_jobs").get() as { n: number }).n;

    const [a, b] = await Promise.all([
      t.post(`/api/sources/${sourceId}/extract`, { adapterId: "asynctest" }),
      t.post(`/api/sources/${sourceId}/extract`, { adapterId: "asynctest" }),
    ]);
    expect([a.statusCode, b.statusCode].sort((x, y) => x - y)).toEqual([200, 409]);
    const rejected = a.statusCode === 409 ? a : b;
    expect(rejected.json<{ error: { code: string } }>().error.code).toBe("extraction_in_progress");

    const jobsAfter = (t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM import_jobs").get() as { n: number }).n;
    expect(jobsAfter - jobsBefore).toBe(1);
    const state = t.app.ck.handle.sqlite
      .prepare("SELECT stage,attempts,last_job_id AS lastJobId FROM source_extractions WHERE source_id=? AND adapter_id='asynctest'")
      .get(sourceId) as { stage: string; attempts: number; lastJobId: string };
    expect(state.stage).toBe("done");
    expect(state.attempts).toBe(1);
    expect(state.lastJobId).toBeTruthy();
    const linkedJob = t.app.ck.handle.sqlite
      .prepare("SELECT source_id AS sourceId,adapter_id AS adapterId,adapter_version AS adapterVersion FROM import_jobs WHERE id=?")
      .get(state.lastJobId) as { sourceId: string; adapterId: string; adapterVersion: string };
    expect(linkedJob).toEqual({ sourceId, adapterId: "asynctest", adapterVersion: t.app.ck.deps.registry.get("asynctest").version });
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM records").get() as { n: number }).n).toBe(1);
  });

  it("recovers pending claims left by a previous server process and permits a bounded retry", async () => {
    const t = await makeTestApp({ adapters: "manual,faketest" });
    apps.push(t);
    const sourceId = await archiveManual(t, "fact: interrupted work can be retried");
    const adapterVersion = t.app.ck.deps.registry.get("faketest").version;
    const stamp = "2026-09-11T05:00:00.000Z";
    const jobId = "interrupted-job";
    t.app.ck.handle.sqlite.prepare(`
      INSERT INTO import_jobs(
        id,source_id,stage,adapter_id,adapter_version,provider_model,attempts,error_code,usage_json,created_at,updated_at
      ) VALUES(?,?,'chunked','faketest',?,NULL,1,NULL,NULL,?,?)
    `).run(jobId, sourceId, adapterVersion, stamp, stamp);
    t.app.ck.handle.sqlite.prepare(`
      INSERT INTO source_extractions(
        id,source_id,project_id,project_key,adapter_id,adapter_version,stage,attempts,last_job_id,last_error_code,
        preflight_usage_json,actual_usage_json,created_at,updated_at
      ) VALUES('interrupted-extraction',?,NULL,'','faketest',?,'pending',1,?,NULL,NULL,NULL,?,?)
    `).run(sourceId, adapterVersion, jobId, stamp, stamp);

    expect(recoverInterruptedExtractions(t.app.ck.deps)).toBe(1);
    const recovered = t.app.ck.handle.sqlite
      .prepare("SELECT stage,attempts,last_error_code FROM source_extractions WHERE id='interrupted-extraction'")
      .get() as { stage: string; attempts: number; last_error_code: string };
    expect(recovered).toEqual({ stage: "failed", attempts: 1, last_error_code: "interrupted_restart" });
    const failedJob = t.app.ck.handle.sqlite
      .prepare("SELECT stage,error_code FROM import_jobs WHERE id=?")
      .get(jobId) as { stage: string; error_code: string };
    expect(failedJob).toEqual({ stage: "failed", error_code: "interrupted_restart" });

    const retry = await t.post(`/api/sources/${sourceId}/extract`, { adapterId: "faketest" });
    expectStatus(retry, 200);
    expect(retry.json<ExistingSourceExtractionResultDto>().status).toBe("created");
    const finalState = t.app.ck.handle.sqlite
      .prepare("SELECT stage,attempts,last_error_code FROM source_extractions WHERE id='interrupted-extraction'")
      .get() as { stage: string; attempts: number; last_error_code: string | null };
    expect(finalState).toEqual({ stage: "done", attempts: 2, last_error_code: null });
  });


  it("repairs legacy null linkage only for an exact chunked owner and leaves terminal or foreign jobs untouched", async () => {
    const t = await makeTestApp({ adapters: "manual,faketest" });
    apps.push(t);
    const sourceId = await archiveManual(t, "fact: legacy extraction linkage");
    const terminalSourceId = await archiveManual(t, "fact: terminal extraction linkage");
    const foreignSourceId = await archiveManual(t, "fact: foreign extraction linkage");
    const adapterVersion = t.app.ck.deps.registry.get("faketest").version;
    const stamp = "2026-09-19T13:00:00.000Z";
    const sqlite = t.app.ck.handle.sqlite;
    sqlite.prepare(`
      INSERT INTO import_jobs(
        id,source_id,stage,adapter_id,adapter_version,provider_model,attempts,error_code,usage_json,created_at,updated_at
      ) VALUES(?,?,'chunked','faketest',?,NULL,1,NULL,NULL,?,?)
    `).run("legacy-link-job", sourceId, adapterVersion, stamp, stamp);
    sqlite.prepare(`
      INSERT INTO import_jobs(
        id,source_id,stage,adapter_id,adapter_version,provider_model,attempts,error_code,usage_json,created_at,updated_at
      ) VALUES(?,?,'done','faketest',?,NULL,1,NULL,NULL,?,?)
    `).run("terminal-link-job", terminalSourceId, adapterVersion, stamp, stamp);
    sqlite.prepare(`
      INSERT INTO import_jobs(
        id,source_id,stage,adapter_id,adapter_version,provider_model,attempts,error_code,usage_json,created_at,updated_at
      ) VALUES(?,?,'chunked','manual','1.0.0',NULL,1,NULL,NULL,?,?)
    `).run("foreign-link-job", foreignSourceId, stamp, stamp);

    const insertExtraction = sqlite.prepare(`
      INSERT INTO source_extractions(
        id,source_id,project_id,project_key,adapter_id,adapter_version,stage,attempts,last_job_id,last_error_code,
        preflight_usage_json,actual_usage_json,created_at,updated_at
      ) VALUES(?,?,NULL,'',? ,?,'pending',1,?,NULL,NULL,NULL,?,?)
    `);
    insertExtraction.run("legacy-null-link", sourceId, "faketest", adapterVersion, null, stamp, stamp);
    insertExtraction.run("terminal-link", terminalSourceId, "faketest", adapterVersion, "terminal-link-job", stamp, stamp);
    insertExtraction.run("foreign-link", foreignSourceId, "faketest", adapterVersion, "foreign-link-job", stamp, stamp);

    expect(recoverInterruptedExtractions(t.app.ck.deps)).toBe(3);
    expect(sqlite.prepare("SELECT stage,last_job_id AS lastJobId,last_error_code AS code FROM source_extractions WHERE id='legacy-null-link'").get())
      .toEqual({ stage: "failed", lastJobId: "legacy-link-job", code: "interrupted_restart" });
    expect(sqlite.prepare("SELECT stage,error_code AS code FROM import_jobs WHERE id='legacy-link-job'").get())
      .toEqual({ stage: "failed", code: "interrupted_restart" });
    expect(sqlite.prepare("SELECT stage,error_code AS code FROM import_jobs WHERE id='terminal-link-job'").get())
      .toEqual({ stage: "done", code: null });
    expect(sqlite.prepare("SELECT stage,error_code AS code FROM import_jobs WHERE id='foreign-link-job'").get())
      .toEqual({ stage: "chunked", code: null });
    expect(recoverInterruptedExtractions(t.app.ck.deps)).toBe(0);
  });

  it("stops provider retries after the bounded failed-attempt limit", async () => {
    const t = await makeTestApp({ adapters: "manual,asynctest" });
    apps.push(t);
    const sourceId = await archiveManual(t, "async-fact: bounded retries must not spend forever");
    const adapterVersion = t.app.ck.deps.registry.get("asynctest").version;
    const stamp = "2026-09-19T12:00:00.000Z";
    t.app.ck.handle.sqlite.prepare(`
      INSERT INTO source_extractions(
        id,source_id,project_id,project_key,adapter_id,adapter_version,stage,attempts,last_job_id,last_error_code,
        preflight_usage_json,actual_usage_json,created_at,updated_at
      ) VALUES('retry-exhausted',?,NULL,'','asynctest',?,'failed',3,NULL,'extract_failed',NULL,NULL,?,?)
    `).run(sourceId, adapterVersion, stamp, stamp);
    const jobsBefore = (t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM import_jobs").get() as { n: number }).n;

    const res = await t.post(`/api/sources/${sourceId}/extract`, { adapterId: "asynctest" });
    expectStatus(res, 409);
    const body = res.json<{ error: { code: string; details: { maxAttempts: number } } }>();
    expect(body.error.code).toBe("extraction_retry_exhausted");
    expect(body.error.details.maxAttempts).toBe(3);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM import_jobs").get() as { n: number }).n).toBe(jobsBefore);
    const state = t.app.ck.handle.sqlite
      .prepare("SELECT stage,attempts,last_error_code FROM source_extractions WHERE id='retry-exhausted'")
      .get() as { stage: string; attempts: number; last_error_code: string };
    expect(state).toEqual({ stage: "failed", attempts: 3, last_error_code: "extract_failed" });
  });

  it("audits disabled adapter refusals on existing-source extraction", async () => {
    const t = await makeTestApp({ adapters: "manual" });
    apps.push(t);
    const sourceId = await archiveManual(t, "plain archived source");
    const res = await t.post(`/api/sources/${sourceId}/extract`, { adapterId: "faketest" });
    expectStatus(res, 409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("adapter_disabled");
    const audit = t.app.ck.handle.sqlite
      .prepare("SELECT action,target_id FROM audit_events WHERE action='provider_call.refused_disabled' ORDER BY rowid DESC LIMIT 1")
      .get() as { action: string; target_id: string };
    expect(audit).toEqual({ action: "provider_call.refused_disabled", target_id: "faketest" });
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM source_extractions").get() as { n: number }).n).toBe(0);
  });

  it("keeps extraction owner-gated", async () => {
    const t = await makeTestApp({ adapters: "manual,faketest" });
    apps.push(t);
    const res = await t.raw("POST", "/api/sources/not-a-source/extract", { adapterId: "faketest" });
    expectStatus(res, 401);
  });
});
