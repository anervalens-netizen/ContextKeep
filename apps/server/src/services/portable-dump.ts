import { createHash, randomUUID } from "node:crypto";
import {
  projects,
  recordEvidence,
  records,
  sourceExcerpts,
  sources,
  supersessions,
} from "../db/schema.js";
import { nowIso } from "../lib/time.js";
import { writeAudit } from "./audit.js";
import {
  applyDump,
  summarizeDump,
  type DumpImportCounters,
  type DumpImportInput,
} from "./dump-import.js";
import type { ActorCtx, ServiceDeps } from "./import.js";

export const PORTABLE_DUMP_FORMAT = "contextkeep.json_dump";
export const PORTABLE_DUMP_VERSION = 3;
export const LEGACY_PORTABLE_DUMP_VERSIONS = [1, 2] as const;

export const PORTABLE_DUMP_INCLUDED = [
  "projects",
  "sources",
  "sourceExcerpts",
  "records",
  "recordEvidence",
  "supersessions",
] as const;

export const PORTABLE_DUMP_EXCLUDED = [
  "conflicts",
  "importJobs",
  "handoffs",
  "auditEvents",
  "ownerCredentials",
  "sessions",
  "idempotencyRequests",
  "sourceExtractions",
  "workspaceBindings",
  "sourceOrigins",
  "agentThreads",
  "agentMessages",
  "agentRuns",
  "runtime/provider state",
] as const;

export interface PortableDumpV3 {
  format: typeof PORTABLE_DUMP_FORMAT;
  version: typeof PORTABLE_DUMP_VERSION;
  exportedAt: string;
  contract: {
    kind: "portable_seed";
    exactDisasterRecovery: false;
    included: readonly string[];
    excluded: readonly string[];
    exactRecoveryMechanism: "sqlite_backup";
  };
  projects: unknown[];
  sources: unknown[];
  sourceExcerpts: unknown[];
  records: unknown[];
  recordEvidence: unknown[];
  supersessions: unknown[];
}

export function buildPortableJsonDump(deps: ServiceDeps, ctx: ActorCtx): PortableDumpV3 {
  const exportedAt = nowIso();
  const dump: PortableDumpV3 = {
    format: PORTABLE_DUMP_FORMAT,
    version: PORTABLE_DUMP_VERSION,
    exportedAt,
    contract: {
      kind: "portable_seed",
      exactDisasterRecovery: false,
      included: [...PORTABLE_DUMP_INCLUDED],
      excluded: [...PORTABLE_DUMP_EXCLUDED],
      exactRecoveryMechanism: "sqlite_backup",
    },
    projects: deps.db.select().from(projects).all(),
    sources: deps.db.select().from(sources).all(),
    sourceExcerpts: deps.db.select().from(sourceExcerpts).all(),
    records: deps.db.select().from(records).all(),
    recordEvidence: deps.db.select().from(recordEvidence).all(),
    // importJobs are intentionally not portable, so supersession job links
    // cannot survive this contract. Preserve the relationship itself while
    // clearing the non-portable FK deterministically.
    supersessions: deps.db.select().from(supersessions).all().map((row) => ({ ...row, jobId: null })),
  };
  writeAudit(deps.db, {
    actor: ctx.actor,
    action: "dump.exported",
    targetType: "store",
    targetId: null,
    after: { exportedAt, format: PORTABLE_DUMP_FORMAT, version: PORTABLE_DUMP_VERSION, kind: "portable_seed" },
    detail: {
      included: PORTABLE_DUMP_INCLUDED,
      excluded: PORTABLE_DUMP_EXCLUDED,
      exactDisasterRecovery: false,
    },
    requestId: ctx.requestId ?? null,
  });
  return dump;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeForLegacyImporter(dump: unknown): unknown {
  if (!isObject(dump)) return dump;
  if (dump["format"] !== PORTABLE_DUMP_FORMAT ||
      (dump["version"] !== PORTABLE_DUMP_VERSION && !LEGACY_PORTABLE_DUMP_VERSIONS.includes(dump["version"] as 1 | 2))) return dump;
  for (const key of PORTABLE_DUMP_INCLUDED) {
    if (!Array.isArray(dump[key])) return dump;
  }
  return {
    format: PORTABLE_DUMP_FORMAT,
    version: 1,
    exportedAt: dump["exportedAt"],
    projects: dump["projects"],
    sources: dump["sources"],
    sourceExcerpts: dump["sourceExcerpts"],
    records: dump["records"],
    recordEvidence: dump["recordEvidence"],
    supersessions: (dump["supersessions"] as unknown[]).map((row) =>
      isObject(row) ? { ...row, jobId: null } : row,
    ),
  };
}

function payloadSha256(dump: unknown): string {
  return createHash("sha256").update(JSON.stringify(dump)).digest("hex");
}

export function summarizePortableDump(
  dump: unknown,
): { ok: true; sha256: string } | { ok: false; code: string; message: string } {
  if (isObject(dump) && dump["format"] === PORTABLE_DUMP_FORMAT && dump["version"] === PORTABLE_DUMP_VERSION) {
    const contract = dump["contract"];
    if (!isObject(contract) || contract["kind"] !== "portable_seed") {
      return { ok: false, code: "invalid_dump", message: "dump.contract must declare kind=portable_seed for version 3." };
    }
    for (const key of PORTABLE_DUMP_INCLUDED) {
      if (!Array.isArray(dump[key])) {
        return { ok: false, code: "invalid_dump", message: `dump.${key} must be an array.` };
      }
    }
  }
  const normalizedSummary = summarizeDump(normalizeForLegacyImporter(dump));
  if (!normalizedSummary.ok) return normalizedSummary;
  return { ok: true, sha256: payloadSha256(dump) };
}

export function applyPortableDump(
  deps: ServiceDeps,
  input: DumpImportInput,
  ctx: ActorCtx,
): DumpImportCounters {
  const isVersionedPortableSeed =
    isObject(input.dump) &&
    input.dump["format"] === PORTABLE_DUMP_FORMAT &&
    (input.dump["version"] === PORTABLE_DUMP_VERSION || input.dump["version"] === 2);
  if (!isVersionedPortableSeed) return applyDump(deps, input, ctx);

  const originalSha = payloadSha256(input.dump);
  const auditRequestId = ctx.requestId ?? `portable-dump:${randomUUID()}`;
  const counters = applyDump(
    deps,
    {
      ...input,
      dump: normalizeForLegacyImporter(input.dump),
      source: `portable-v${(input.dump as Record<string, unknown>)["version"]}:${input.source}`,
    },
    { ...ctx, requestId: auditRequestId },
  );

  // The v1 engine applies exactly the six portable entities, but it hashes its
  // normalized compatibility object. Restore the owner-visible identity to the
  // original versioned payload in both returned counters and its audit event.
  counters.dumpSha256 = originalSha;
  deps.sqlite
    .prepare(`
      UPDATE audit_events
      SET after_ref=?, detail_json=?
      WHERE action='import_dump.applied' AND request_id=?
    `)
    .run(
      JSON.stringify(counters),
      JSON.stringify({
        mode: input.mode,
        source: input.source,
        version: PORTABLE_DUMP_VERSION,
        compatibilityEngineVersion: 1,
        contract: "portable_seed",
      }),
      auditRequestId,
    );
  return counters;
}
