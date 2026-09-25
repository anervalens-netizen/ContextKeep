import { nowIso } from "../lib/time.js";
import type { ServiceDeps } from "./import.js";
import { recoverInterruptedInitialImportClaims } from "./initial-import-claim.js";

/**
 * A `pending` extraction row can only belong to the current server process.
 * On a fresh process start there are no surviving provider calls, so any
 * persisted pending claim is necessarily abandoned by the previous process.
 * Mark it failed before routes/timers become available; the normal claim path
 * may then atomically retry the same immutable source target.
 *
 * F08 initial-import provider claims use the same restart boundary. Recover
 * those first; the return value remains the historical source-extraction count
 * so existing callers/tests keep their contract.
 */
export function recoverInterruptedExtractions(deps: ServiceDeps): number {
  recoverInterruptedInitialImportClaims(deps);

  // The pending-row read, legacy pre-linkage repair, extraction transition and
  // owned import-job transition must share one IMMEDIATE barrier. Otherwise a
  // second process can observe the same pending row and either recover it twice
  // or mutate a job that no longer belongs to this extraction.
  const recover = deps.sqlite.transaction(() => {
    const pending = deps.sqlite
      .prepare(`
        SELECT id,source_id AS sourceId,adapter_id AS adapterId,
               adapter_version AS adapterVersion,last_job_id AS lastJobId
        FROM source_extractions
        WHERE stage='pending'
        ORDER BY id
      `)
      .all() as Array<{
        id: string;
        sourceId: string;
        adapterId: string;
        adapterVersion: string;
        lastJobId: string | null;
      }>;
    if (pending.length === 0) return 0;

    const stamp = nowIso();
    let recovered = 0;
    const findLegacyJob = deps.sqlite.prepare(`
      SELECT id
      FROM import_jobs
      WHERE source_id=? AND adapter_id=? AND adapter_version=? AND stage='chunked'
      ORDER BY created_at ASC, id ASC
    `);
    const failExtraction = deps.sqlite.prepare(`
      UPDATE source_extractions
      SET stage='failed',last_job_id=?,last_error_code='interrupted_restart',updated_at=?
      WHERE id=? AND stage='pending'
    `);
    const failOwnedJob = deps.sqlite.prepare(`
      UPDATE import_jobs
      SET stage='failed',error_code='interrupted_restart',updated_at=?
      WHERE id=? AND source_id=? AND adapter_id=? AND adapter_version=? AND stage='chunked'
    `);

    for (const row of pending) {
      let linkedJobId = row.lastJobId;
      if (linkedJobId === null) {
        // Old versions could create the chunked job before writing
        // last_job_id. Link only a unique exact match; ambiguity fails safe
        // by leaving all candidate jobs untouched.
        const candidates = findLegacyJob.all(row.sourceId, row.adapterId, row.adapterVersion) as Array<{ id: string }>;
        if (candidates.length === 1) linkedJobId = candidates[0]!.id;
      }

      const extraction = failExtraction.run(linkedJobId, stamp, row.id);
      if (extraction.changes !== 1) continue;
      recovered += 1;

      if (linkedJobId) {
        // Ownership is explicit on every mutable identity dimension. A stale,
        // terminal or foreign job is never rewritten during recovery.
        failOwnedJob.run(stamp, linkedJobId, row.sourceId, row.adapterId, row.adapterVersion);
      }
    }
    return recovered;
  });
  return recover.immediate();
}
