import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { instantKey } from "./instant.js";
import {
  foldMemoryText,
  isCurrentStateClaim,
  prepareState,
  preparedStateRelationship,
  type FreshnessRecord,
  type FreshnessPreloadSignals,
  type PreparedState,
} from "./memory-freshness.js";

const SAMPLE_SIZE = 20;
const MAX_PROJECTS = 8;
const MAX_SIGNALS = 512;
const MAX_INDEX_BYTES = 48 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

export function emptyFreshnessSignals(): FreshnessPreloadSignals {
  return {
    explicitConflict: false,
    conflictSupportRecordIds: [],
    conflictSupportCount: 0,
    conflictReferencesTruncated: false,
    supportRecordIds: [],
    supportCount: 0,
    supportReferencesTruncated: false,
    possiblyRelatedRecordIds: [],
    possiblyRelatedCount: 0,
    possiblyRelatedReferencesTruncated: false,
  };
}

type Observation = {
  id: string;
  at: string;
  structuredTime: boolean;
  state: PreparedState;
};
type ObservationIndex = {
  // Complete only for these predicates (null means all) and times > after.
  // Other projections rescan; absence from a partial index is never evidence.
  predicates: Set<string> | null;
  after: string;
  observations: Observation[];
  postings: Map<string, number[]>;
  strings: Map<string, string>;
  bytes: number;
};
type ProjectCache = {
  version: string;
  index: ObservationIndex | null;
  signals: Map<string, FreshnessPreloadSignals>;
  signalBytes: number;
};
// Each live DB owns a bounded LRU. Transaction handles never publish snapshots.
const caches = new WeakMap<Db, Map<string, ProjectCache>>();

function signalBytes(signal: FreshnessPreloadSignals): number {
  return (
    512 +
    [...signal.supportRecordIds, ...signal.possiblyRelatedRecordIds].reduce(
      (n, id) => n + 64 + id.length * 2,
      0,
    )
  );
}
function trim(cache: Map<string, ProjectCache>): void {
  let bytes = [...cache.values()].reduce(
    (n, entry) => n + (entry.index?.bytes ?? 0) + entry.signalBytes,
    0,
  );
  while (cache.size > MAX_PROJECTS || bytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value!;
    const entry = cache.get(oldest)!;
    bytes -= (entry.index?.bytes ?? 0) + entry.signalBytes;
    cache.delete(oldest);
  }
}
function remember(
  entry: ProjectCache,
  key: string,
  signal: FreshnessPreloadSignals,
): void {
  const previous = entry.signals.get(key);
  if (previous) entry.signalBytes -= signalBytes(previous);
  entry.signals.delete(key);
  entry.signals.set(key, signal);
  entry.signalBytes += signalBytes(signal);
  while (entry.signals.size > MAX_SIGNALS) {
    const oldest = entry.signals.keys().next().value!;
    entry.signalBytes -= signalBytes(entry.signals.get(oldest)!);
    entry.signals.delete(oldest);
  }
}
function observationTime(row: FreshnessRecord): string {
  return row.sourceEventAt || row.effectiveFrom || row.recordedAt;
}
function targetKey(row: FreshnessRecord): string {
  // Callers can supply different projections/revisions of the same ID. Do not
  // retain an arbitrarily long body in a cache key or assume caller immutability.
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.id,
        row.projectId,
        row.subject,
        row.predicate,
        row.text,
        observationTime(row),
      ]),
    )
    .digest("hex");
}
function keys(state: PreparedState): string[] {
  // A superset of every possible match in preparedStateRelationship, including
  // one-character subjects and identifiers whose component tokens are too short.
  return [
    ...(state.subject ? [`s:${state.subject}`] : []),
    ...(state.dimension ? [`d:${state.dimension}`] : []),
    ...[...state.identifiers].map((id) => `i:${id}`),
    ...[...state.broad].map((token) => `t:${token}`),
  ];
}
function detachState(
  state: PreparedState,
  copies: Map<string, string>,
): PreparedState {
  // V8 can keep a large report alive through a small sliced token. Copy retained
  // strings through UTF-16 (including lone surrogates) so accounting is based on
  // the stored features, not the size of their original backing strings. Intern
  // repeated tokens within the bounded index to avoid copying each per report.
  const copy = (value: string): string => {
    let result = copies.get(value);
    if (result === undefined) {
      result = Buffer.from(value, "utf16le").toString("utf16le");
      copies.set(result, result);
    }
    return result;
  };
  const copySet = (values: ReadonlySet<string>) =>
    new Set([...values].map(copy));
  return {
    projectId: state.projectId === null ? null : copy(state.projectId),
    predicate: state.predicate === null ? null : copy(state.predicate),
    subject: copy(state.subject),
    dimension: state.dimension === null ? null : copy(state.dimension),
    identifiers: copySet(state.identifiers),
    significant: copySet(state.significant),
    content: copySet(state.content),
    broad: copySet(state.broad),
  };
}

function addToIndex(
  index: ObservationIndex,
  observation: Observation,
): boolean {
  const state = observation.state;
  // Conservative retained-size accounting includes Set/Map/posting overhead;
  // both variable-length strings and entry counts are bounded. Bodies are never
  // retained. If admission fails the entire scan still contributes to signals.
  let bytes =
    1024 +
    2 *
      (observation.id.length +
        observation.at.length +
        state.subject.length +
        (state.predicate?.length ?? 0));
  for (const set of [
    state.identifiers,
    state.significant,
    state.content,
    state.broad,
  ]) {
    for (const token of set) bytes += 64 + token.length * 2;
  }
  const interned = new Set([
    state.subject,
    state.predicate ?? "",
    state.dimension ?? "",
    state.projectId ?? "",
    ...state.identifiers,
    ...state.significant,
    ...state.content,
    ...state.broad,
  ]);
  for (const value of interned) if (!index.strings.has(value)) bytes += 96;
  const terms = keys(state);
  for (const term of terms)
    bytes += 16 + (index.postings.has(term) ? 0 : 128 + term.length * 2);
  if (index.bytes + bytes > MAX_INDEX_BYTES) return false;
  const offset = index.observations.length;
  const retained = { ...observation, state: detachState(state, index.strings) };
  index.observations.push(retained);
  for (const term of keys(retained.state)) {
    const list = index.postings.get(term);
    if (list) list.push(offset);
    else index.postings.set(term, [offset]);
  }
  index.bytes += bytes;
  return true;
}
function candidates(
  index: ObservationIndex,
  state: PreparedState,
): Iterable<Observation> {
  const offsets = new Set<number>();
  for (const term of keys(state))
    for (const offset of index.postings.get(term) ?? []) offsets.add(offset);
  return (function* () {
    for (const offset of offsets) yield index.observations[offset]!;
  })();
}

function rememberId(ids: string[], id: string): void {
  // Keep the smallest distinct IDs, independently of scan/postings order.
  let at = 0;
  while (at < ids.length && ids[at]! < id) at++;
  if (at === SAMPLE_SIZE || ids[at] === id) return;
  ids.splice(at, 0, id);
  if (ids.length > SAMPLE_SIZE) ids.pop();
}

function mergeSignal(
  result: Map<string, FreshnessPreloadSignals>,
  id: string,
  signal: FreshnessPreloadSignals,
): void {
  const combined = result.get(id) ?? emptyFreshnessSignals();
  // Preserve the original mapper's conservative per-projection counts and
  // distinct reference union when several projections share one record ID.
  combined.supportCount += signal.supportCount;
  combined.possiblyRelatedCount += signal.possiblyRelatedCount;
  for (const ref of signal.supportRecordIds)
    rememberId(combined.supportRecordIds, ref);
  for (const ref of signal.possiblyRelatedRecordIds)
    rememberId(combined.possiblyRelatedRecordIds, ref);
  combined.supportReferencesTruncated = combined.supportCount > SAMPLE_SIZE;
  combined.possiblyRelatedReferencesTruncated =
    combined.possiblyRelatedCount > SAMPLE_SIZE;
  result.set(id, combined);
}
function accumulate(
  signal: FreshnessPreloadSignals,
  target: PreparedState,
  after: string,
  observation: Observation,
): void {
  if (observation.at <= after) return;
  const relation = preparedStateRelationship(target, observation.state);
  if (relation === "unrelated") return;
  if (relation === "same_entity" && observation.structuredTime) {
    signal.supportCount++;
    rememberId(signal.supportRecordIds, observation.id);
  } else {
    signal.possiblyRelatedCount++;
    rememberId(signal.possiblyRelatedRecordIds, observation.id);
  }
}

const columnsText = `id, project_id AS projectId, type, subject, predicate,
  value_json AS valueJson, text, review_status AS reviewStatus,
  evidence_basis AS evidenceBasis, task_status AS taskStatus,
  recorded_at AS recordedAt, source_event_at AS sourceEventAt,
  effective_from AS effectiveFrom, effective_to AS effectiveTo,
  review_due_at AS reviewDueAt, volatile`;
const columns = sql.raw(columnsText);
function* workingRows(
  db: Db,
  client: Database.Database | undefined,
  projectId: string,
): Iterable<FreshnessRecord> {
  if (client) {
    // One indexed project scan, with native streaming: no repeated json_each
    // cutoff joins/sorts and no eager .all() of long report bodies.
    yield* client
      .prepare(
        `SELECT ${columnsText} FROM records
      WHERE project_id = ? AND review_status = 'proposed'
        AND evidence_basis = 'agent_report' AND type = 'fact' ORDER BY rowid`,
      )
      .iterate(projectId) as IterableIterator<FreshnessRecord>;
    return;
  }
  // Drizzle transaction handles do not expose the native client. Their rare
  // uncached reads retain bounded keyset pages with a direct project predicate.
  let after: number | null = null;
  while (true) {
    const rows: (FreshnessRecord & { scanRowid: number })[] =
      db.all(sql`SELECT ${columns}, rowid AS scanRowid FROM records
      WHERE project_id = ${projectId} AND review_status = 'proposed'
        AND evidence_basis = 'agent_report' AND type = 'fact'
        ${after === null ? sql`` : sql`AND rowid > ${after}`}
      ORDER BY rowid LIMIT 128`);
    yield* rows;
    if (rows.length < 128) return;
    after = rows.at(-1)!.scanRowid;
  }
}

/** Versioned, time-independent evidence only; verdicts always use the caller's clock. */
export function loadFreshnessObservations(
  db: Db,
  targets: FreshnessRecord[],
): Map<string, FreshnessPreloadSignals> {
  if (!targets.some((row) => row.projectId && isCurrentStateClaim(row)))
    return new Map();
  const client = (db as Db & { $client?: Database.Database }).$client;
  const canCache = Boolean(client && !client.inTransaction);
  // Versions and observations must come from the same read snapshot, including
  // when another connection commits while a cold index is being built.
  const read = () => loadSnapshot(db, targets, client, canCache);
  return canCache ? client!.transaction(read)() : read();
}

function loadSnapshot(
  db: Db,
  targets: FreshnessRecord[],
  client: Database.Database | undefined,
  canCache: boolean,
): Map<string, FreshnessPreloadSignals> {
  const result = new Map<string, FreshnessPreloadSignals>();
  const byProject = new Map<string, FreshnessRecord[]>();
  for (const target of targets) {
    if (!target.projectId || !isCurrentStateClaim(target)) continue;
    const group = byProject.get(target.projectId) ?? [];
    group.push(target);
    byProject.set(target.projectId, group);
  }
  const cache = canCache
    ? (caches.get(db) ?? new Map<string, ProjectCache>())
    : new Map<string, ProjectCache>();
  if (canCache) caches.set(db, cache);
  for (const [projectId, rows] of byProject) {
    const state = db.get<{
      contentVersion: number;
      workingMemoryVersion: number;
      createdAt: string;
    }>(sql`
      SELECT content_version AS contentVersion, working_memory_version AS workingMemoryVersion,
             created_at AS createdAt FROM projects WHERE id = ${projectId}`);
    const version = JSON.stringify(state);
    let entry = cache.get(projectId);
    if (!entry || entry.version !== version) {
      entry = { version, index: null, signals: new Map(), signalBytes: 0 };
    }
    cache.delete(projectId);
    cache.set(projectId, entry);
    const projections = rows.map((row) => {
      const key = targetKey(row);
      return {
        row,
        key,
        signal: entry!.signals.get(key) ?? emptyFreshnessSignals(),
      };
    });
    const missing = projections
      .filter(({ key }) => !entry!.signals.has(key))
      .map(({ row, key, signal }) => ({
        row,
        key,
        state: prepareState(row),
        after: instantKey(observationTime(row)),
        signal,
      }));
    if (missing.length) {
      if (
        entry.index &&
        missing.every(
          (target) =>
            target.after >= entry!.index!.after &&
            (entry!.index!.predicates === null ||
              (target.state.predicate !== null &&
                entry!.index!.predicates.has(target.state.predicate))),
        )
      ) {
        for (const target of missing) {
          for (const observation of candidates(entry.index, target.state)) {
            accumulate(target.signal, target.state, target.after, observation);
          }
        }
      } else {
        // Release a narrower snapshot before constructing its replacement.
        entry.index = null;
        const after = missing.reduce(
          (min, target) => (target.after < min ? target.after : min),
          missing[0]!.after,
        );
        const predicates = missing.some(
          (target) => target.state.predicate === null,
        )
          ? null
          : new Set(missing.map((target) => target.state.predicate!));
        let index: ObservationIndex | null = canCache
          ? {
              predicates,
              after,
              observations: [],
              postings: new Map(),
              strings: new Map(),
              bytes:
                256 +
                after.length * 2 +
                [...(predicates ?? [])].reduce(
                  (n, predicate) => n + 64 + predicate.length * 2,
                  0,
                ),
            }
          : null;
        if (index && index.bytes > MAX_INDEX_BYTES) index = null;
        for (const row of workingRows(db, client, projectId)) {
          // Predicate disagreement is an exact rejection in the classifier.
          // Avoid tokenizing/indexing irrelevant bodies on every version bump.
          if (
            predicates &&
            row.predicate &&
            !predicates.has(foldMemoryText(row.predicate))
          )
            continue;
          const at = instantKey(observationTime(row));
          if (at <= after) continue;
          if (!isCurrentStateClaim(row)) continue;
          const observation = {
            id: row.id,
            at,
            structuredTime: Boolean(row.sourceEventAt || row.effectiveFrom),
            state: prepareState(row),
          };
          for (const target of missing)
            accumulate(target.signal, target.state, target.after, observation);
          if (index && !addToIndex(index, observation)) index = null;
        }
        entry.index = index;
      }
      for (const target of missing) {
        target.signal.supportReferencesTruncated =
          target.signal.supportCount > SAMPLE_SIZE;
        target.signal.possiblyRelatedReferencesTruncated =
          target.signal.possiblyRelatedCount > SAMPLE_SIZE;
        remember(entry, target.key, target.signal);
      }
    }
    for (const target of projections)
      mergeSignal(result, target.row.id, target.signal);
    trim(cache);
  }
  return result;
}
