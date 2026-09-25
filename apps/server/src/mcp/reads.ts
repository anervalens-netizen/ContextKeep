import { and, eq, inArray, sql, desc, like, or } from "drizzle-orm";
import { projects, records, sources } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { loadRecordFreshnessContext, toProjectDto, toRecordDto } from "../services/mappers.js";
import { requireProject, requireRecord, deletionReceipt } from "../services/memory-management.js";
import type { ServiceDeps } from "../services/import.js";
import { sourceProjectIds, sourceProjectScope } from "../services/source-membership.js";

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
export function readRecord(deps: ServiceDeps, input: {recordId: string; includeUnreviewed: boolean; evidenceOffset: number; evidenceLimit: number}) {
  const row = requireRecord(deps, input.recordId);
  if (!input.includeUnreviewed && !["accepted", "superseded"].includes(row.reviewStatus))
    throw new ApiError(404, "agent_record_not_found", "Accepted or historical record not found. Use includeUnreviewed for inbox/deleted records.");
  const evidence = deps.sqlite.prepare("SELECT re.excerpt_id AS excerptId,re.relation,re.observed_at AS observedAt,re.artifact_ref AS artifactRef,se.source_id AS sourceId,s.title AS sourceTitle,substr(se.exact_text,1,4000) AS text,length(se.exact_text)>4000 AS textTruncated FROM record_evidence re JOIN source_excerpts se ON se.id=re.excerpt_id JOIN sources s ON s.id=se.source_id WHERE re.record_id=? ORDER BY re.excerpt_id LIMIT ? OFFSET ?")
    .all(row.id, input.evidenceLimit, input.evidenceOffset);
  const total = (deps.sqlite.prepare("SELECT count(*) n FROM record_evidence WHERE record_id=?").get(row.id) as {n:number}).n;
  const freshnessContext = loadRecordFreshnessContext(deps.db, [row]);
  const { evidence: _e, ...dto } = toRecordDto(row, [], freshnessContext);
  return { ...dto, recordId: row.id, projectName: row.projectId ? requireProject(deps, row.projectId).name : null,
    evidence, evidenceTotal: total, evidenceNextOffset: input.evidenceOffset + input.evidenceLimit < total ? input.evidenceOffset + input.evidenceLimit : null,
    deletionId: deletionReceipt(deps, row.id, row.revision)?.id ?? null, excerptLimits: { evidenceChars: 4000, evidenceCount: input.evidenceLimit }, textTruncated: false };
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
export function readSource(deps: ServiceDeps, input: { sourceId: string; offset: number; maxChars: number; excerptOffset: number; excerptLimit: number }) {
  const row = deps.db.select({id:sources.id,projectId:sources.projectId,title:sources.title,kind:sources.kind,eventAt:sources.eventAt,
    authorLabel:sources.authorLabel,provenanceBasis:sources.provenanceBasis}).from(sources).where(eq(sources.id,input.sourceId)).get();
  if (!row) throw new ApiError(404, "source_not_found", "Source not found.");
  const text = deps.sqlite.prepare("SELECT substr(normalized_text,?,?) text,length(normalized_text) totalChars FROM sources WHERE id=?")
    .get(input.offset+1,input.maxChars,input.sourceId) as {text:string;totalChars:number};
  const excerpts = deps.sqlite.prepare("SELECT id,start_offset AS startOffset,end_offset AS endOffset,substr(exact_text,1,4000) text,length(exact_text)>4000 AS textTruncated FROM source_excerpts WHERE source_id=? ORDER BY start_offset,id LIMIT ? OFFSET ?")
    .all(input.sourceId,input.excerptLimit,input.excerptOffset);
  const total = (deps.sqlite.prepare("SELECT count(*) n FROM source_excerpts WHERE source_id=?").get(input.sourceId) as {n:number}).n;
  return {...row,projectIds:sourceProjectIds(deps,row.id),...text,offset:input.offset,nextOffset:input.offset+input.maxChars<text.totalChars?input.offset+input.maxChars:null,
    excerpts,excerptTotal:total,excerptNextOffset:input.excerptOffset+input.excerptLimit<total?input.excerptOffset+input.excerptLimit:null,canonicalTruth:false};
}
