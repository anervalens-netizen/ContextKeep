import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { recoverInterruptedExtractions } from "../src/services/extraction-recovery.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const apps: TestApp[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.cleanup();
});

describe("legacy Codex review reconciliation", () => {
  it("recovers a pre-linkage chunked extraction job and links it before failing both rows", async () => {
    const t = await makeTestApp();
    apps.push(t);
    const db = t.app.ck.handle.sqlite;
    const sourceId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const extractionId = crypto.randomUUID();
    const now = "2026-09-24T10:00:00.000Z";

    db.prepare(`
      INSERT INTO sources(
        id,kind,title,original_filename,content_hash,normalized_hash,imported_at,event_at,
        author_label,provenance_basis,project_id,original_text,normalized_text,redaction_state
      ) VALUES(?, 'text', 'legacy recovery', NULL, ?, ?, ?, NULL, NULL, 'document', NULL, 'legacy', 'legacy', 'none')
    `).run(sourceId, crypto.randomBytes(32).toString("hex"), crypto.randomBytes(32).toString("hex"), now);

    db.prepare(`
      INSERT INTO import_jobs(
        id,source_id,stage,adapter_id,adapter_version,provider_model,attempts,error_code,usage_json,created_at,updated_at
      ) VALUES(?, ?, 'chunked', 'manual', '1.0.0', NULL, 1, NULL, NULL, ?, ?)
    `).run(jobId, sourceId, now, now);

    db.prepare(`
      INSERT INTO source_extractions(
        id,source_id,project_id,project_key,adapter_id,adapter_version,stage,attempts,last_job_id,
        last_error_code,preflight_usage_json,actual_usage_json,created_at,updated_at
      ) VALUES(?, ?, NULL, '', 'manual', '1.0.0', 'pending', 1, NULL, NULL, NULL, NULL, ?, ?)
    `).run(extractionId, sourceId, now, now);

    expect(recoverInterruptedExtractions(t.app.ck.deps)).toBe(1);

    const extraction = db.prepare(
      "SELECT stage,last_job_id AS lastJobId,last_error_code AS lastErrorCode FROM source_extractions WHERE id=?",
    ).get(extractionId) as { stage: string; lastJobId: string | null; lastErrorCode: string | null };
    expect(extraction).toEqual({
      stage: "failed",
      lastJobId: jobId,
      lastErrorCode: "interrupted_restart",
    });

    const job = db.prepare("SELECT stage,error_code AS errorCode FROM import_jobs WHERE id=?").get(jobId) as {
      stage: string;
      errorCode: string | null;
    };
    expect(job).toEqual({ stage: "failed", errorCode: "interrupted_restart" });
  });
});
