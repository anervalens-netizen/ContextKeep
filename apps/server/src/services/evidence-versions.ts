import { createHash } from "node:crypto";
import type { ServiceDeps } from "./import.js";
import { sha256 } from "../lib/hash.js";
import type { RecordDto } from "@contextkeep/shared";

type EvidenceVersion = {
  version: string;
  total: number;
  outsideProject: boolean;
};

function versionHash(kind: string, secrets: string[]) {
  return createHash("sha256").update(
    JSON.stringify([kind, sha256(JSON.stringify(secrets))]),
  );
}

type VersionRow = {
  id: string;
  excerpt_id: string | null;
  outside_project?: number;
};

function collectVersions(
  rows: Iterable<VersionRow>,
  kind: string,
  secrets: string[],
): Map<string, EvidenceVersion> {
  const versions = new Map<string, EvidenceVersion>();
  let group:
    | {
        id: string;
        hash: ReturnType<typeof versionHash>;
        total: number;
        outsideProject: boolean;
      }
    | undefined;
  const store = () => {
    if (group)
      versions.set(group.id, {
        version: group.hash.digest("hex"),
        total: group.total,
        outsideProject: group.outsideProject,
      });
  };
  for (const row of rows) {
    if (row.id !== group?.id) {
      store();
      group = {
        id: row.id,
        hash: versionHash(kind, secrets),
        total: 0,
        outsideProject: false,
      };
    }
    group.hash.update(JSON.stringify(row));
    if (row.excerpt_id !== null) group.total++;
    group.outsideProject ||= row.outside_project === 1;
  }
  store();
  return versions;
}

/** Freshness references are sampled. Include their delivered identities and
 * counts so changes such as conflict resolution can invalidate a fence even
 * when they leave the project cursors alone.
 */
export function recordEvidenceVersion(
  version: string,
  freshness: RecordDto["freshness"],
) {
  return sha256(
    JSON.stringify([
      version,
      freshness?.supportRecordIds,
      freshness?.possiblyRelatedRecordIds,
      freshness?.referenceSummary,
    ]),
  );
}

/** Stream only indexed evidence metadata. Source content is immutable at its
 * stored hashes. Project cursors also invalidate conservatively when freshness
 * references can change, even when the selected record revision is unchanged.
 */
export function recordEvidenceVersions(
  deps: ServiceDeps,
  recordIds: string[],
  secrets: string[],
): Map<string, EvidenceVersion> {
  if (!recordIds.length) return new Map();
  const rows = deps.sqlite
    .prepare(
      `
    SELECT r.id, r.revision, r.review_status, r.project_id, p.content_version, p.working_memory_version,
           re.excerpt_id, re.relation, re.observed_at, re.environment, re.artifact_ref,
           e.start_offset, e.end_offset, e.exact_text_hash, s.id AS source_id,
           s.content_hash, s.normalized_hash, s.title, s.event_at, s.provenance_basis,
           CASE WHEN r.project_id IS NULL OR s.id IS NULL OR r.project_id = s.project_id OR EXISTS (
             SELECT 1 FROM source_origins o JOIN workspace_bindings w ON w.id = o.workspace_binding_id
             WHERE o.source_id = s.id AND w.project_id = r.project_id
           ) THEN 0 ELSE 1 END AS outside_project
    FROM json_each(?) ids JOIN records r ON r.id = ids.value
    LEFT JOIN projects p ON p.id = r.project_id
    LEFT JOIN record_evidence re ON re.record_id = r.id
    LEFT JOIN source_excerpts e ON e.id = re.excerpt_id
    LEFT JOIN sources s ON s.id = e.source_id
    ORDER BY r.id, re.excerpt_id
  `,
    )
    .iterate(JSON.stringify([...new Set(recordIds)])) as Iterable<VersionRow>;
  return collectVersions(rows, "record-evidence-v1", secrets);
}

/** Source tokens cover both text and the excerpt catalogue, independent of page. */
export function sourceEvidenceVersions(
  deps: ServiceDeps,
  sourceIds: string[],
  secrets: string[],
) {
  if (!sourceIds.length) return new Map<string, EvidenceVersion>();
  const rows = deps.sqlite
    .prepare(
      `
    SELECT s.id, s.project_id, s.kind, s.title, s.event_at, s.author_label,
           s.provenance_basis, s.content_hash, s.normalized_hash, e.id AS excerpt_id,
           e.start_offset, e.end_offset, e.exact_text_hash
    FROM json_each(?) ids JOIN sources s ON s.id = ids.value
    LEFT JOIN source_excerpts e ON e.source_id = s.id
    ORDER BY s.id, e.start_offset, e.id
  `,
    )
    .iterate(JSON.stringify([...new Set(sourceIds)])) as Iterable<VersionRow>;
  return collectVersions(rows, "source-evidence-v1", secrets);
}
