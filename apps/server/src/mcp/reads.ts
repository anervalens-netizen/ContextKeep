import { isUtf16ExcerptSpan, sliceUtf16Excerpt } from "../services/source-offsets.js";
import { and, eq, inArray, sql, desc, like, or } from "drizzle-orm";
import { projects, records, sources } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { loadRecordFreshnessContext, toProjectDto, toRecordDto } from "../services/mappers.js";
import { requireProject, requireRecord, deletionReceipt } from "../services/memory-management.js";
import type { ServiceDeps } from "../services/import.js";
import { sourceBelongsToProject, sourceProjectIds, sourceProjectScope } from "../services/source-membership.js";

import { safeText } from "./safety.js";
import { sha256 } from "../lib/hash.js";
import { recordEvidenceVersion, recordEvidenceVersions, sourceEvidenceVersions } from "../services/evidence-versions.js";

export type Page = { offset: number; limit: number };
const next = (total: number, page: Page) => page.offset + page.limit < total ? page.offset + page.limit : null;
export function pageResult<T>(items: T[], total: number, page: Page) {
  return { items, total, offset: page.offset, limit: page.limit, nextOffset: next(total, page) };
}
function count(deps: ServiceDeps, where: ReturnType<typeof sql>) {
  return Number(deps.db.select({ n: sql.raw("count(*)") }).from(records).where(where).get()!.n);
}
function compact(deps: ServiceDeps, rows: (typeof records.$inferSelect)[]) {
  const byRecord = new Map<string, string[]>();
  const freshnessContext = loadRecordFreshnessContext(deps.db, rows);
  if (rows.length) {
    const placeholders = rows.map(() => "?").join(",");
    const evidence = deps.sqlite.prepare("SELECT record_id,excerpt_id FROM record_evidence WHERE record_id IN (" + placeholders + ") ORDER BY record_id,excerpt_id")
      .all(...rows.map(r => r.id)) as {record_id: string; excerpt_id: string}[];
    for (const e of evidence) { const ids = byRecord.get(e.record_id) ?? []; ids.push(e.excerpt_id); byRecord.set(e.record_id, ids); }
  }
  return rows.map(row => {
    const { evidence: _evidence, ...dto } = toRecordDto(row, [], freshnessContext);
    return { ...dto, recordId: row.id, text: row.text.slice(0, 2000), textTruncated: row.text.length > 2000,
      evidenceIds: (byRecord.get(row.id) ?? []).slice(0, 10), evidenceCount: (byRecord.get(row.id) ?? []).length };
  });
}
export function listProjects(deps: ServiceDeps, page: Page, q?: string) {
  const where = q ? or(like(projects.name, "%" + q + "%"), like(projects.aliasesJson, "%" + q + "%")) : undefined;
  const rows = deps.db.select().from(projects).where(where).orderBy(projects.name, projects.id).limit(page.limit).offset(page.offset).all();
  const total = Number(deps.db.select({ n: sql.raw("count(*)") }).from(projects).where(where).get()!.n);
  return { scope: "all", projects: rows.map(toProjectDto), total, offset: page.offset, limit: page.limit, nextOffset: next(total, page) };
}
export function listRecords(deps: ServiceDeps, input: Page & { projectId: string; reviewStatus: string; recordType?: string; taskStatus?: string }) {
  requireProject(deps, input.projectId);
  const where = and(eq(records.projectId, input.projectId),
    input.reviewStatus === "all" ? undefined : eq(records.reviewStatus, input.reviewStatus),
    input.recordType ? eq(records.type, input.recordType) : undefined,
    input.taskStatus ? eq(records.taskStatus, input.taskStatus) : undefined)!;
  const rows = deps.db.select().from(records).where(where).orderBy(desc(records.recordedAt), records.id).limit(input.limit).offset(input.offset).all();
  return { projectId: input.projectId, ...pageResult(compact(deps, rows).map(row => ({
    ...row, deletionId: deletionReceipt(deps, row.id, row.revision)?.id ?? null,
  })), count(deps, where), input) };
}
export function readBrief(deps: ServiceDeps, input: Page & { projectId: string }) {
  const project = requireProject(deps, input.projectId);
  const accepted = and(eq(records.projectId, project.id), eq(records.reviewStatus, "accepted"))!;
  const types = { facts: "fact", decisions: "decision", constraints: "constraint", openQuestions: "question", actions: "action" };
  const sections = Object.fromEntries(Object.entries(types).map(([name, type]) => {
    const where = and(accepted, eq(records.type, type),
      type === "fact" ? sql.raw("(predicate IS NULL OR predicate != 'lifecycle')") : undefined,
      type === "action" ? sql.raw("(task_status IS NULL OR task_status IN ('open','in_progress','blocked'))") : undefined)!;
    const rows = deps.db.select().from(records).where(where).orderBy(desc(records.recordedAt), desc(records.id)).limit(input.limit).offset(input.offset).all();
    return [name, pageResult(compact(deps, rows), count(deps, where), input)];
  }));
  const reviewed = deps.db.select({ last: sql.raw("max(reviewed_at)") }).from(records).where(accepted).get()!.last;
  const life = project.lifecycleRecordId ? requireRecord(deps, project.lifecycleRecordId) : null;
  return { project: toProjectDto(project), description: project.description, revision: project.revision, contentVersion: project.contentVersion,
    lifecycle: { state: project.lifecycle, recordId: project.lifecycleRecordId, reviewedAt: life?.reviewedAt ?? null, reviewDueAt: life?.reviewDueAt ?? null },
    generatedAt: new Date().toISOString(), lastReviewedAt: reviewed, sections };
}
export function readTimeline(deps: ServiceDeps, input: Page & { projectId: string }) {
  requireProject(deps, input.projectId);
  const where = and(eq(records.projectId, input.projectId), inArray(records.reviewStatus, ["accepted", "superseded"]))!;
  const rows = deps.db.select().from(records).where(where)
    .orderBy(sql.raw("coalesce(source_event_at,recorded_at) DESC"), desc(records.recordedAt), desc(records.id))
    .limit(input.limit).offset(input.offset).all();
  const entries = compact(deps, rows).map(record => {
    const links = deps.sqlite.prepare("SELECT prior_record_id,replacement_record_id,confirmed_at,reason FROM supersessions WHERE prior_record_id=? OR replacement_record_id=? ORDER BY confirmed_at DESC,id")
      .all(record.id, record.id) as {prior_record_id: string; replacement_record_id: string; confirmed_at: string | null; reason: string}[];
    const replacement = links.find(s => s.prior_record_id === record.id && s.confirmed_at);
    return { record, supersededBy: replacement ? { recordId: replacement.replacement_record_id, confirmedAt: replacement.confirmed_at, reason: replacement.reason } : null,
      supersedes: links.filter(s => s.replacement_record_id === record.id && s.confirmed_at).map(s => ({recordId: s.prior_record_id, confirmedAt: s.confirmed_at, reason: s.reason})) };
  });
  const total = count(deps, where);
  return { projectId: input.projectId, total, offset: input.offset, nextOffset: next(total, input), entries };
}
type RecordReadInput = {
  recordId: string; projectId?: string; includeUnreviewed: boolean;
  evidenceOffset: number; evidenceLimit: number;
  expectedRevision?: number; expectedEvidenceVersion?: string;
};

export function readRecord(deps: ServiceDeps, input: RecordReadInput, secrets: string[] = []) {
  return deps.sqlite.transaction(() => {
    const row = requireRecord(deps, input.recordId);
    if ((input.projectId && row.projectId !== input.projectId) ||
        (!input.includeUnreviewed && !["accepted", "superseded"].includes(row.reviewStatus)))
      throw new ApiError(404, "agent_record_not_found", "Record not found in the requested scope. Use includeUnreviewed for authorized inbox/deleted reads.");
    if (input.expectedRevision !== undefined && input.expectedRevision !== row.revision)
      throw new ApiError(409, "record_revision_changed", "Restart the selected record from evidenceOffset=0 with its current revision.", { currentRevision: row.revision });
    const { version, total, outsideProject } = recordEvidenceVersions(deps, [row.id], secrets).get(row.id)!;
    if (input.projectId && outsideProject)
      throw new ApiError(409, "evidence_scope_mismatch", "Evidence is outside the requested project. Check source membership before using this record.");
    const freshnessContext = loadRecordFreshnessContext(deps.db, [row]);
    const { evidence: _e, ...dto } = toRecordDto(row, [], freshnessContext);
    const evidenceVersion = recordEvidenceVersion(version, dto.freshness);
    if (input.expectedEvidenceVersion !== undefined && input.expectedEvidenceVersion !== evidenceVersion)
      throw new ApiError(409, "record_evidence_changed", "Restart the selected record from evidenceOffset=0 and use its new evidenceVersion.", { currentRevision: row.revision });

    const rawPage = deps.sqlite.prepare(`
      SELECT re.excerpt_id AS excerptId,re.relation,re.observed_at AS observedAt,re.artifact_ref AS artifactRef,
             se.source_id AS sourceId,s.title AS sourceTitle,se.start_offset AS startOffset,se.end_offset AS endOffset
      FROM record_evidence re JOIN source_excerpts se ON se.id=re.excerpt_id JOIN sources s ON s.id=se.source_id
      WHERE re.record_id=? ORDER BY re.excerpt_id LIMIT ? OFFSET ?`
    ).all(row.id, input.evidenceLimit, input.evidenceOffset) as Array<{
      sourceId: string; startOffset: number; endOffset: number;
    }>;
    const sourceVersions = sourceEvidenceVersions(deps, rawPage.map(item => item.sourceId), secrets);
    const evidence = rawPage.map(({ startOffset, endOffset, ...metadata }) => {
      const prepared = cachedSource(deps, metadata.sourceId, "normalized", secrets);
      return {
        ...metadata, startOffset, endOffset, ...boundedExcerpt(prepared.normalizedMask, startOffset, endOffset),
        recovery: { tool: "get_source", sourceId: metadata.sourceId, projectId: input.projectId,
          expectedVersion: sourceVersions.get(metadata.sourceId)!.version },
      };
    });
    const { offset, limit } = { offset: input.evidenceOffset, limit: input.evidenceLimit };
    const nextOffset = next(total, { offset, limit });
    return {
      ...dto, recordId: row.id, projectName: row.projectId ? requireProject(deps, row.projectId).name : null,
      evidence, evidenceTotal: total, evidenceReturned: evidence.length, evidenceNextOffset: nextOffset,
      evidenceOffset: offset, evidenceVersion,
      evidenceRecovery: nextOffset === null ? null : {
        tool: "get_record", ...input, evidenceOffset: nextOffset, expectedRevision: row.revision, expectedEvidenceVersion: evidenceVersion,
      },
      deletionId: deletionReceipt(deps, row.id, row.revision)?.id ?? null,
      excerptLimits: { evidenceChars: 4000, evidenceCount: input.evidenceLimit }, textTruncated: false,
    };
  })();
}
export function listSources(deps: ServiceDeps, input: Page & {projectId: string}) {
  requireProject(deps, input.projectId);
  const where = sourceProjectScope(input.projectId);
  const rows = deps.db.select({ id: sources.id, title: sources.title, kind: sources.kind, importedAt: sources.importedAt,
    eventAt: sources.eventAt, authorLabel: sources.authorLabel, provenanceBasis: sources.provenanceBasis })
    .from(sources).where(where).orderBy(desc(sources.importedAt), sources.id).limit(input.limit).offset(input.offset).all();
  const total = Number(deps.db.select({ n: sql.raw("count(*)") }).from(sources).where(where).get()!.n);
  return pageResult(rows, total, input);
}
const SOURCE_CACHE_BYTES = 64 * 1024 * 1024;
const SOURCE_INDEX_STRIDE = 1024;
function prepareSource(deps: ServiceDeps, sourceId: string, representation: "normalized" | "original", secrets: string[]) {
  const row = deps.db.select().from(sources).where(eq(sources.id, sourceId)).get();
  if (!row) throw new ApiError(404, "source_not_found", "Source not found.");
  const text = safeText(representation === "original" ? row.originalText : row.normalizedText, secrets);
  const normalizedMask = safeText(row.normalizedText, secrets, true);
  // Sparse code-point anchors avoid an array entry for every character of a large source.
  const anchors: number[] = [];
  let totalChars = 0;
  for (let i = 0; i < text.length; totalChars++) {
    if (totalChars % SOURCE_INDEX_STRIDE === 0) anchors.push(i);
    i += text.codePointAt(i)! > 0xffff ? 2 : 1;
  }
  return { text, normalizedMask, anchors, totalChars,
    bytes: (text.length + normalizedMask.length) * 2 + anchors.length * 8 + 1024,
    metadata: { id: row.id, projectId: row.projectId, title: row.title, kind: row.kind, eventAt: row.eventAt,
      authorLabel: row.authorLabel, provenanceBasis: row.provenanceBasis,
      contentHash: sha256(row.originalText), normalizedHash: sha256(row.normalizedText), deliveredHash: sha256(text) } };
}
type PreparedSource = ReturnType<typeof prepareSource>;
const sourceCaches = new WeakMap<ServiceDeps["sqlite"], { stamp: string; bytes: number; entries: Map<string, PreparedSource> }>();
function cachedSource(deps: ServiceDeps, sourceId: string, representation: "normalized" | "original", secrets: string[]) {
  // Own-connection writes, external commits and credential rotation all invalidate.
  const changes = (deps.sqlite.prepare("SELECT total_changes() n").get() as { n: number }).n;
  const stamp = `${changes}:${deps.sqlite.pragma("data_version", { simple: true })}:${sha256(JSON.stringify(secrets))}`;
  let cache = sourceCaches.get(deps.sqlite);
  if (!cache || cache.stamp !== stamp) {
    cache = { stamp, bytes: 0, entries: new Map() };
    sourceCaches.set(deps.sqlite, cache);
  }
  const key = `${sourceId}:${representation}`;
  const existing = cache.entries.get(key);
  if (existing) { cache.entries.delete(key); cache.entries.set(key, existing); return existing; }
  const prepared = prepareSource(deps, sourceId, representation, secrets);
  if (prepared.bytes <= SOURCE_CACHE_BYTES) {
    while (cache.entries.size && (cache.entries.size >= 4 || cache.bytes + prepared.bytes > SOURCE_CACHE_BYTES)) {
      const oldest = cache.entries.keys().next().value!;
      cache.bytes -= cache.entries.get(oldest)!.bytes;
      cache.entries.delete(oldest);
    }
    cache.entries.set(key, prepared); cache.bytes += prepared.bytes;
  }
  return prepared;
}
function boundedExcerpt(mask: string, start: number, end: number) {
  if (!isUtf16ExcerptSpan(mask, start, end)) {
    return { text: "", textTruncated: true, unavailableReason: "invalid_normalized_utf16_span" as const };
  }
  const { text, textTruncated } = sliceUtf16Excerpt(mask,start,end);
  return { text, textTruncated };
}

function sourcePage(source: PreparedSource, offset: number, limit: number) {
  if (offset >= source.totalChars) return "";
  const anchor = Math.floor(offset / SOURCE_INDEX_STRIDE);
  let start = source.anchors[anchor]!;
  for (let n = anchor * SOURCE_INDEX_STRIDE; n < offset; n++) start += source.text.codePointAt(start)! > 0xffff ? 2 : 1;
  let end = start;
  for (let n = 0; n < limit && end < source.text.length; n++) end += source.text.codePointAt(end)! > 0xffff ? 2 : 1;
  return source.text.slice(start, end);
}
type SourceReadInput = {
  sourceId: string; projectId?: string; representation?: "normalized" | "original";
  offset: number; maxChars: number; excerptOffset: number; excerptLimit: number; expectedVersion?: string;
};

export function readSource(deps: ServiceDeps, input: SourceReadInput, secrets: string[] = []) {
  return deps.sqlite.transaction(() => {
    if (input.projectId && !sourceBelongsToProject(deps, input.sourceId, input.projectId))
      throw new ApiError(404, "source_not_found", "Source not found in the requested project.");
    const snapshot = sourceEvidenceVersions(deps, [input.sourceId], secrets).get(input.sourceId);
    if (!snapshot) throw new ApiError(404, "source_not_found", "Source not found.");
    const { version, total } = snapshot;
    if (input.expectedVersion !== undefined && input.expectedVersion !== version)
      throw new ApiError(409, "source_evidence_changed", "Restart get_source with offset=0 and excerptOffset=0 to obtain the current evidenceVersion.");
    const representation = input.representation ?? "normalized";
    const prepared = cachedSource(deps, input.sourceId, representation, secrets);
    const { metadata, normalizedMask, totalChars } = prepared;
    const excerpts = deps.sqlite.prepare("SELECT id,start_offset AS startOffset,end_offset AS endOffset FROM source_excerpts WHERE source_id=? ORDER BY start_offset,id LIMIT ? OFFSET ?")
      .all(input.sourceId,input.excerptLimit,input.excerptOffset).map(raw => {
        const item = raw as { id: string; startOffset: number; endOffset: number };
        return { ...item, ...boundedExcerpt(normalizedMask, item.startOffset, item.endOffset) };
      });
    const text = sourcePage(prepared, input.offset, input.maxChars);
    const nextOffset = next(totalChars, { offset: input.offset, limit: input.maxChars });
    const excerptNextOffset = next(total, { offset: input.excerptOffset, limit: input.excerptLimit });
    const recover = { tool: "get_source", ...input, expectedVersion: version };
    return {...metadata, projectIds: input.projectId ? [input.projectId] : sourceProjectIds(deps,metadata.id),
      representation, offsetUnit:"unicode_code_points", excerptOffsetUnit:"normalized_utf16",
      excerptRepresentation:"normalized_length_preserving_redaction",
      text, totalChars, returnedChars: Math.max(0, Math.min(input.maxChars, totalChars - input.offset)),
      offset: input.offset, nextOffset, textRecovery: nextOffset === null ? null : { ...recover, offset: nextOffset },
      excerpts, excerptTotal: total, excerptReturned: excerpts.length, excerptOffset: input.excerptOffset,
      excerptNextOffset, excerptRecovery: excerptNextOffset === null ? null : { ...recover, excerptOffset: excerptNextOffset },
      evidenceVersion: version, canonicalTruth:false };
  })();
}
