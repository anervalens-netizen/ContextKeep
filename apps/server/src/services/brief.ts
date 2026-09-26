import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import {
  LIFECYCLE_PREDICATE,
  type BriefDto,
  type BriefStatementDto,
  type EvidenceBasis,
  type EvidenceDto,
  type LifecycleState,
  type RecordDto,
  type RecordType,
  type ReviewStatus,
  type TaskStatus,
  type TimelineDto,
  type TimelineEntryDto,
} from "@contextkeep/shared";
import { projects, records, supersessions } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { nowIso } from "../lib/time.js";
import {
  attachProjectNames,
  loadEvidenceFor,
  loadEvidenceForProject,
  toProjectDto,
} from "./mappers.js";
import type { ServiceDeps } from "./import.js";
import {
  decodeTimelineCursor,
  encodeReadCursor,
  type TimelineReadCursor,
} from "./bounded-read.js";

const OPEN_TASK_STATUSES = new Set<string>(["open", "in_progress", "blocked"]);

interface RawRecordRow {
  id: string;
  project_id: string | null;
  type: string;
  subject: string;
  predicate: string | null;
  value_json: string | null;
  text: string;
  review_status: string;
  evidence_basis: string;
  task_status: string | null;
  recorded_at: string;
  source_event_at: string | null;
  effective_from: string | null;
  effective_to: string | null;
  reviewed_at: string | null;
  review_due_at: string | null;
  volatile: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface RawEvidenceRow {
  record_id: string;
  excerpt_id: string;
  relation: string;
  observed_at: string | null;
  environment: string | null;
  artifact_ref: string | null;
  source_id: string;
  source_title: string | null;
  start_offset: number;
  end_offset: number;
  exact_text: string;
}

/**
 * Pre-serialized brief cache (§8.7). Canonical record writes advance the
 * project's monotonic contentVersion, while project metadata edits advance
 * revision/updatedAt. Cache hits therefore validate in O(1) without rescanning
 * all accepted records. A volatile review deadline is the only time-based
 * invalidation that can occur without a write; the earliest future deadline is
 * captured only when rebuilding the brief.
 */
interface BriefCacheEntry {
  revision: number;
  contentVersion: number;
  updatedAt: string;
  nextReviewDueAt: string | null;
  json: string;
  payload: Buffer;
}
const briefCache = new Map<string, BriefCacheEntry>();

function projectCacheState(
  deps: ServiceDeps,
  projectId: string,
): { revision: number; contentVersion: number; updatedAt: string } | null {
  const project = deps.sqlite
    .prepare(
      `SELECT revision, content_version AS contentVersion, updated_at AS updatedAt FROM projects WHERE id = ?`,
    )
    .get(projectId) as
    { revision: number; contentVersion: number; updatedAt: string } | undefined;
  return project ?? null;
}

function nextVolatileReviewDueAt(
  deps: ServiceDeps,
  projectId: string,
  now: string,
): string | null {
  const row = deps.sqlite
    .prepare(
      `SELECT min(review_due_at) AS due
       FROM records
       WHERE project_id = ?
         AND review_status = 'accepted'
         AND volatile = 1
         AND review_due_at IS NOT NULL
         AND review_due_at > ?`,
    )
    .get(projectId, now) as { due: string | null };
  return row.due;
}

function briefCacheEntry(
  deps: ServiceDeps,
  projectId: string,
): BriefCacheEntry {
  const state = projectCacheState(deps, projectId);
  if (state === null)
    throw new ApiError(
      404,
      "project_not_found",
      `Project ${projectId} not found.`,
    );
  const now = nowIso();
  const cached = briefCache.get(projectId);
  if (
    cached &&
    cached.revision === state.revision &&
    cached.contentVersion === state.contentVersion &&
    cached.updatedAt === state.updatedAt &&
    (cached.nextReviewDueAt === null || now < cached.nextReviewDueAt)
  ) {
    return cached;
  }
  const json = JSON.stringify(buildBrief(deps, projectId));
  const entry: BriefCacheEntry = {
    ...state,
    nextReviewDueAt: nextVolatileReviewDueAt(deps, projectId, now),
    json,
    payload: Buffer.from(json),
  };
  briefCache.set(projectId, entry);
  return entry;
}

export function buildBriefJson(deps: ServiceDeps, projectId: string): string {
  return briefCacheEntry(deps, projectId).json;
}

/** Cached UTF-8 payload for the hot HTTP route; avoids re-encoding ~1 MiB on every hit. */
export function buildBriefPayload(
  deps: ServiceDeps,
  projectId: string,
): Buffer {
  return briefCacheEntry(deps, projectId).payload;
}

/**
 * Current project brief (handoff §4 journey A, M0 scope 5).
 * - Lifecycle is the PROJECTION of the accepted lifecycle record (handoff §7).
 * - Only accepted records appear (A22: "agent reported done" proposals never
 *   reach the brief until the owner accepts them).
 * - Superseded records disappear from the brief but stay in the timeline.
 * - Every statement carries its evidence excerpts.
 *
 * §10 performance budget (p95 ≤ 50ms on a 1k-record corpus): this hot path uses
 * raw prepared statements + single-pass DTO mapping. Drizzle's per-row object
 * materialization costs ~70µs/record at this scale, which alone would blow the
 * budget; better-sqlite3's native row mapping is ~10x cheaper.
 */
export function buildBrief(deps: ServiceDeps, projectId: string): BriefDto {
  const { db, sqlite } = deps;
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project)
    throw new ApiError(
      404,
      "project_not_found",
      `Project ${projectId} not found.`,
    );

  const recordRows = sqlite
    .prepare(
      `SELECT * FROM records WHERE project_id = ? AND review_status = 'accepted' ORDER BY recorded_at`,
    )
    .all(projectId) as RawRecordRow[];
  const evidenceRows = sqlite
    .prepare(
      `SELECT re.record_id, re.excerpt_id, re.relation, re.observed_at, re.environment, re.artifact_ref,
              se.source_id, se.start_offset, se.end_offset, se.exact_text, s.title AS source_title
       FROM record_evidence re
       JOIN records r ON r.id = re.record_id
       JOIN source_excerpts se ON se.id = re.excerpt_id
       JOIN sources s ON s.id = se.source_id
       WHERE r.project_id = ? AND r.review_status = 'accepted'`,
    )
    .all(projectId) as RawEvidenceRow[];

  const evidenceByRecord = new Map<string, EvidenceDto[]>();
  for (const e of evidenceRows) {
    let list = evidenceByRecord.get(e.record_id);
    if (!list) {
      list = [];
      evidenceByRecord.set(e.record_id, list);
    }
    list.push({
      recordId: e.record_id,
      excerptId: e.excerpt_id,
      relation: e.relation as EvidenceDto["relation"],
      observedAt: e.observed_at,
      environment: e.environment,
      artifactRef: e.artifact_ref,
      sourceId: e.source_id,
      sourceTitle: e.source_title,
      startOffset: e.start_offset,
      endOffset: e.end_offset,
      text: e.exact_text,
    });
  }

  const facts: BriefStatementDto[] = [];
  const decisions: BriefStatementDto[] = [];
  const constraints: BriefStatementDto[] = [];
  const openQuestions: BriefStatementDto[] = [];
  const actions: BriefStatementDto[] = [];

  let lifecycle: BriefDto["lifecycle"] = {
    state: project.lifecycle as LifecycleState,
    recordId: project.lifecycleRecordId,
    reviewedAt: null,
    reviewDueAt: null,
  };
  let lastReviewedAt: string | null = null;

  for (const row of recordRows) {
    const evidence = evidenceByRecord.get(row.id) ?? [];
    const dto: RecordDto = {
      id: row.id,
      projectId: row.project_id,
      projectName: project.name,
      type: row.type as RecordType,
      subject: row.subject,
      predicate: row.predicate,
      valueJson:
        row.value_json === null
          ? null
          : (JSON.parse(row.value_json) as unknown),
      text: row.text,
      reviewStatus: row.review_status as ReviewStatus,
      evidenceBasis: row.evidence_basis as EvidenceBasis,
      taskStatus: (row.task_status as TaskStatus | null) ?? null,
      recordedAt: row.recorded_at,
      sourceEventAt: row.source_event_at,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      reviewedAt: row.reviewed_at,
      reviewDueAt: row.review_due_at,
      volatile: row.volatile === 1,
      isOverdue:
        row.volatile === 1 &&
        row.review_due_at !== null &&
        row.review_due_at < new Date().toISOString(),
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      evidence,
    };
    if (
      dto.reviewedAt !== null &&
      (lastReviewedAt === null || dto.reviewedAt > lastReviewedAt)
    ) {
      lastReviewedAt = dto.reviewedAt;
    }

    // Lifecycle lives in the lifecycle block (projection), not in free facts.
    if (row.type === "fact" && row.predicate === LIFECYCLE_PREDICATE) {
      const parsed = dto.valueJson as { state?: string } | null;
      lifecycle = {
        state: (parsed?.state ?? project.lifecycle) as LifecycleState,
        recordId: project.lifecycleRecordId,
        reviewedAt: dto.reviewedAt,
        reviewDueAt: dto.reviewDueAt,
      };
      continue;
    }

    const statement: BriefStatementDto = { record: dto, evidence };
    switch (dto.type) {
      case "fact":
        facts.push(statement);
        break;
      case "decision":
        decisions.push(statement);
        break;
      case "constraint":
        constraints.push(statement);
        break;
      case "question":
        openQuestions.push(statement);
        break;
      case "action":
        if (dto.taskStatus === null || OPEN_TASK_STATUSES.has(dto.taskStatus)) {
          actions.push(statement);
        }
        break;
    }
  }

  return {
    project: toProjectDto(project),
    lifecycle,
    description: project.description,
    facts,
    decisions,
    constraints,
    openQuestions,
    actions,
    lastReviewedAt,
    generatedAt: nowIso(),
    revision: project.revision,
    contentVersion: project.contentVersion,
  };
}

/**
 * Historical timeline (handoff §4 journey A): accepted + superseded records
 * with supersession links, ordered by best-known event time.
 */
export function buildTimeline(
  deps: ServiceDeps,
  projectId: string,
  options?: { limit?: number; cursor?: string },
): TimelineDto {
  const { db } = deps;
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project)
    throw new ApiError(
      404,
      "project_not_found",
      `Project ${projectId} not found.`,
    );

  const paginated = options !== undefined;
  const limit = options?.limit ?? 100;
  const cursor =
    options?.cursor === undefined
      ? undefined
      : decodeTimelineCursor(options.cursor, projectId);
  if (cursor && cursor.contentVersion !== project.contentVersion) {
    throw new ApiError(
      409,
      "timeline_snapshot_changed",
      "Project knowledge changed while this timeline page was being read; restart from the first page.",
      {
        projectId,
        currentContentVersion: project.contentVersion,
        snapshotContentVersion: cursor.contentVersion,
      },
    );
  }

  // Preserve the legacy unbounded response semantics for consumers that do
  // not opt into pagination, including its existing freshness projection.
  if (!paginated) {
    const rows = db
      .select()
      .from(records)
      .where(
        and(
          eq(records.projectId, projectId),
          inArray(records.reviewStatus, ["accepted", "superseded"]),
        ),
      )
      .all();
    const evidenceMap = loadEvidenceForProject(db, projectId, [
      "accepted",
      "superseded",
    ]);
    const dtos = attachProjectNames(db, rows, evidenceMap);
    const idSet = new Set(rows.map((row) => row.id));
    const supers = db
      .select()
      .from(supersessions)
      .all()
      .filter(
        (supersession) =>
          idSet.has(supersession.priorRecordId) ||
          idSet.has(supersession.replacementRecordId),
      );
    const entries: TimelineEntryDto[] = dtos.map((dto) => {
      const asSuper = supers.find(
        (supersession) => supersession.priorRecordId === dto.id,
      );
      const replaces = supers
        .filter((supersession) => supersession.replacementRecordId === dto.id)
        .map((supersession) => ({
          recordId: supersession.priorRecordId,
          confirmedAt: supersession.confirmedAt,
          reason: supersession.reason,
        }));
      return {
        record: dto,
        supersededBy: asSuper
          ? {
              recordId: asSuper.replacementRecordId,
              confirmedAt: asSuper.confirmedAt,
              reason: asSuper.reason,
            }
          : null,
        supersedes: replaces,
      };
    });
    entries.sort((a, b) => {
      const ta = a.record.sourceEventAt ?? a.record.recordedAt;
      const tb = b.record.sourceEventAt ?? b.record.recordedAt;
      return ta.localeCompare(tb);
    });
    return { projectId, entries };
  }

  const statusFilter = inArray(records.reviewStatus, [
    "accepted",
    "superseded",
  ]);
  const eventTime = sql<string>`coalesce(${records.sourceEventAt}, ${records.recordedAt})`;
  const afterCursor = cursor
    ? or(
        gt(eventTime, cursor.eventTime),
        and(eq(eventTime, cursor.eventTime), gt(records.id, cursor.recordId)),
      )
    : undefined;
  const where = and(
    eq(records.projectId, projectId),
    statusFilter,
    afterCursor,
  );
  const total = paginated
    ? Number(
        db
          .select({ count: sql<number>`count(*)` })
          .from(records)
          .where(and(eq(records.projectId, projectId), statusFilter))
          .get()?.count ?? 0,
      )
    : undefined;
  const recordQuery = db
    .select()
    .from(records)
    .where(where)
    .orderBy(asc(eventTime), asc(records.id));
  const rows = paginated
    ? recordQuery.limit(limit + 1).all()
    : recordQuery.all();
  const pageRows = paginated ? rows.slice(0, limit) : rows;
  const evidenceMap = loadEvidenceFor(
    db,
    pageRows.map((row) => row.id),
  );
  // Keep the same freshness and project-name projection as the legacy API,
  // while loading only this page's records and evidence.
  const dtos = attachProjectNames(db, pageRows, evidenceMap);

  // Query only links touching this page. Links to records on another page are
  // retained as IDs, so pagination never silently drops supersession context.
  const pageIds = pageRows.map((row) => row.id);
  const supers =
    pageIds.length === 0
      ? []
      : db
          .select()
          .from(supersessions)
          .where(
            or(
              inArray(supersessions.priorRecordId, pageIds),
              inArray(supersessions.replacementRecordId, pageIds),
            ),
          )
          .all();

  const entries: TimelineEntryDto[] = dtos.map((dto) => {
    const asSuper = supers.find((s) => s.priorRecordId === dto.id);
    const replaces = supers
      .filter((s) => s.replacementRecordId === dto.id)
      .map((s) => ({
        recordId: s.priorRecordId,
        confirmedAt: s.confirmedAt,
        reason: s.reason,
      }));
    return {
      record: dto,
      supersededBy: asSuper
        ? {
            recordId: asSuper.replacementRecordId,
            confirmedAt: asSuper.confirmedAt,
            reason: asSuper.reason,
          }
        : null,
      supersedes: replaces,
    };
  });

  const hasNext = rows.length > pageRows.length;
  const last = pageRows.at(-1);
  const nextCursor =
    hasNext && last
      ? encodeReadCursor({
          version: 1,
          kind: "timeline",
          projectId,
          eventTime: last.sourceEventAt ?? last.recordedAt,
          recordId: last.id,
          contentVersion: project.contentVersion,
        } satisfies TimelineReadCursor)
      : null;
  return {
    projectId,
    entries,
    pagination: {
      limit,
      total: total ?? entries.length,
      returned: entries.length,
      hasNext,
      nextCursor,
      snapshotContentVersion: project.contentVersion,
    },
  };
}
