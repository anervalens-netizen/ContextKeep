import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import {
  classifyRecordFreshness,
  foldMemoryText,
  isCurrentStateClaim,
  memoryTokens,
  reviewOverdue,
  stateRelationship,
  type FreshnessRecord,
  type RecordFreshnessContext,
} from "./memory-freshness.js";
import type {
  EvidenceBasis,
  EvidenceDto,
  LifecycleState,
  ProjectDto,
  RecordDto,
  ReviewStatus,
  SourceDto,
  SourceKind,
  ProvenanceBasis,
  TaskStatus,
  RecordType,
} from "@contextkeep/shared";
import type { Db } from "../db/client.js";
import {
  conflicts,
  projects,
  recordEvidence,
  records,
  sources,
  sourceExcerpts,
  type projects as projectsT,
  type records as recordsT,
  type sources as sourcesT,
} from "../db/schema.js";

type ProjectRow = typeof projectsT.$inferSelect;
type RecordRow = typeof recordsT.$inferSelect;
type SourceRow = typeof sourcesT.$inferSelect;

export function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function relationObjectValue(predicate: string | null, valueJson: unknown): string | null {
  const kinds = new Set(["depends_on", "blocks", "affects", "runs_on"]);
  if (!predicate || !kinds.has(predicate)) return null;
  let value = valueJson;
  if (typeof valueJson === "string") {
    try {
      value = JSON.parse(valueJson) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = (value as Record<string, unknown>).object;
  return typeof object === "string" && object.trim() ? object.trim() : null;
}

export function toProjectDto(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    aliases: parseJson<string[]>(row.aliasesJson, []),
    parentId: row.parentProjectId,
    description: row.description,
    lifecycle: row.lifecycle as LifecycleState,
    lifecycleRecordId: row.lifecycleRecordId,
    revision: row.revision,
    contentVersion: row.contentVersion,
    workingMemoryVersion: row.workingMemoryVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toRecordDto(
  row: RecordRow,
  evidence: EvidenceDto[] = [],
  freshnessContext: RecordFreshnessContext = { nowIso: new Date().toISOString() },
): RecordDto {
  const volatile = row.volatile === 1;
  // A11 compatibility field; CK-A05 freshness is the richer additive model.
  const isOverdue = reviewOverdue(row, freshnessContext.nowIso);
  const freshness = classifyRecordFreshness(row as FreshnessRecord, freshnessContext);
  return {
    id: row.id,
    projectId: row.projectId,
    projectName: null, // filled by callers that join projects
    type: row.type as RecordType,
    subject: row.subject,
    predicate: row.predicate,
    valueJson: parseJson<unknown>(row.valueJson, null),
    text: row.text,
    reviewStatus: row.reviewStatus as ReviewStatus,
    evidenceBasis: row.evidenceBasis as EvidenceBasis,
    taskStatus: (row.taskStatus as TaskStatus | null) ?? null,
    recordedAt: row.recordedAt,
    sourceEventAt: row.sourceEventAt,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    reviewedAt: row.reviewedAt,
    reviewDueAt: row.reviewDueAt,
    volatile,
    isOverdue,
    freshness,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    evidence,
  };
}

export function toSourceDto(row: SourceRow, excerptCount: number): SourceDto {
  return {
    id: row.id,
    kind: row.kind as SourceKind,
    title: row.title,
    originalFilename: row.originalFilename,
    contentHash: row.contentHash,
    normalizedHash: row.normalizedHash,
    importedAt: row.importedAt,
    eventAt: row.eventAt,
    authorLabel: row.authorLabel,
    provenanceBasis: row.provenanceBasis as ProvenanceBasis,
    projectId: row.projectId,
    redactionState: row.redactionState,
    excerptCount,
  };
}

/** Loads joined evidence DTOs for a set of record ids (one query). */
export function loadEvidenceFor(db: Db, recordIds: string[]): Map<string, EvidenceDto[]> {
  const out = new Map<string, EvidenceDto[]>();
  if (recordIds.length === 0) return out;
  const rows = db
    .select(EVIDENCE_SELECT)
    .from(recordEvidence)
    .innerJoin(sourceExcerpts, eq(recordEvidence.excerptId, sourceExcerpts.id))
    .innerJoin(sources, eq(sourceExcerpts.sourceId, sources.id))
    .where(inArray(recordEvidence.recordId, recordIds))
    .all();
  return groupEvidence(out, rows);
}

export type EvidenceRefDto = Pick<
  EvidenceDto,
  "excerptId" | "sourceId" | "sourceTitle" | "relation" | "observedAt" | "artifactRef"
>;

/**
 * Metadata-only evidence projection for hot paths that return evidence refs,
 * not excerpt bodies. This deliberately excludes exact_text/start/end so a
 * bounded work-context read cannot materialize large source text only to drop
 * it before serialization.
 */
export function loadEvidenceRefsFor(db: Db, recordIds: string[]): Map<string, EvidenceRefDto[]> {
  const out = new Map<string, EvidenceRefDto[]>();
  if (recordIds.length === 0) return out;
  const rows = db
    .select({
      recordId: recordEvidence.recordId,
      excerptId: recordEvidence.excerptId,
      relation: recordEvidence.relation,
      observedAt: recordEvidence.observedAt,
      artifactRef: recordEvidence.artifactRef,
      sourceId: sourceExcerpts.sourceId,
      sourceTitle: sources.title,
    })
    .from(recordEvidence)
    .innerJoin(sourceExcerpts, eq(recordEvidence.excerptId, sourceExcerpts.id))
    .innerJoin(sources, eq(sourceExcerpts.sourceId, sources.id))
    .where(inArray(recordEvidence.recordId, recordIds))
    .all();
  for (const row of rows) {
    const list = out.get(row.recordId) ?? [];
    list.push({
      excerptId: row.excerptId,
      sourceId: row.sourceId,
      sourceTitle: row.sourceTitle,
      relation: row.relation as EvidenceDto["relation"],
      observedAt: row.observedAt,
      artifactRef: row.artifactRef,
    });
    out.set(row.recordId, list);
  }
  return out;
}

const EVIDENCE_SELECT = {
  recordId: recordEvidence.recordId,
  excerptId: recordEvidence.excerptId,
  relation: recordEvidence.relation,
  observedAt: recordEvidence.observedAt,
  environment: recordEvidence.environment,
  artifactRef: recordEvidence.artifactRef,
  sourceId: sourceExcerpts.sourceId,
  startOffset: sourceExcerpts.startOffset,
  endOffset: sourceExcerpts.endOffset,
  text: sourceExcerpts.exactText,
  sourceTitle: sources.title,
} as const;

function groupEvidence(
  out: Map<string, EvidenceDto[]>,
  rows: {
    recordId: string;
    excerptId: string;
    relation: string;
    observedAt: string | null;
    environment: string | null;
    artifactRef: string | null;
    sourceId: string;
    startOffset: number;
    endOffset: number;
    text: string;
    sourceTitle: string | null;
  }[],
): Map<string, EvidenceDto[]> {
  for (const r of rows) {
    const list = out.get(r.recordId) ?? [];
    list.push({
      recordId: r.recordId,
      excerptId: r.excerptId,
      relation: r.relation as EvidenceDto["relation"],
      observedAt: r.observedAt,
      environment: r.environment,
      artifactRef: r.artifactRef,
      sourceId: r.sourceId,
      sourceTitle: r.sourceTitle,
      startOffset: r.startOffset,
      endOffset: r.endOffset,
      text: r.text,
    });
    out.set(r.recordId, list);
  }
  return out;
}

/**
 * Evidence for ALL records of one project in a given review status — join-driven
 * (two bind params) instead of a huge IN list; keeps the brief route inside the
 * §10 p95 budget on a 1k-record corpus.
 */
export function loadEvidenceForProject(
  db: Db,
  projectId: string,
  statuses: string[],
): Map<string, EvidenceDto[]> {
  const rows = db
    .select(EVIDENCE_SELECT)
    .from(recordEvidence)
    .innerJoin(records, eq(recordEvidence.recordId, records.id))
    .innerJoin(sourceExcerpts, eq(recordEvidence.excerptId, sourceExcerpts.id))
    .innerJoin(sources, eq(sourceExcerpts.sourceId, sources.id))
    .where(and(eq(records.projectId, projectId), inArray(records.reviewStatus, statuses)))
    .all();
  return groupEvidence(new Map(), rows);
}

export function loadRecordFreshnessContext(
  db: Db,
  rows: RecordRow[],
  nowIso = new Date().toISOString(),
): RecordFreshnessContext {
  const projectIds = [
    ...new Set(
      rows.map((r) => r.projectId).filter((p): p is string => p !== null),
    ),
  ];
  if (projectIds.length === 0)
    return { nowIso, workingRecords: [], conflicts: [] };

  const freshnessTargets = rows.filter(
    (row) =>
      row.reviewStatus === "accepted" &&
      isCurrentStateClaim(row as FreshnessRecord),
  ) as FreshnessRecord[];
  const targetByProject = new Map<string, FreshnessRecord[]>();
  for (const target of freshnessTargets) {
    if (!target.projectId) continue;
    const projectTargets = targetByProject.get(target.projectId) ?? [];
    projectTargets.push(target);
    targetByProject.set(target.projectId, projectTargets);
  }

  const observationTime = sql<string>`coalesce(${records.sourceEventAt}, ${records.effectiveFrom}, ${records.recordedAt})`;
  const currentStateWorking = or(
    eq(records.volatile, 1),
    ...[
      "current",
      "current_state",
      "operational_state",
      "status",
      "version",
      "release",
      "deployment",
    ].map((term) => sql`lower(${records.predicate}) = ${term}`),
    sql`(
      json_valid(${records.valueJson}) AND
      (json_type(json_extract(${records.valueJson}, '$.currentState')) IS NOT NULL OR
       json_type(json_extract(${records.valueJson}, '$.operationalState')) IS NOT NULL)
    )`,
    ...[
      "current",
      "curent",
      "cur",
      "operational",
      "oper",
      "production",
      "prod",
      "productie",
      "deployed",
      "release",
      "version",
      "versiune",
      "versi",
      "status",
      "ready",
      "active",
      "activ",
    ].map(
      (term) => sql`(
      lower(${records.subject}) LIKE ${`%${term}%`} OR
      lower(${records.text}) LIKE ${`%${term}%`}
    )`,
    ),
  );

  const workingWhere = [...targetByProject.entries()].map(
    ([projectId, targets]) => {
      const earliestTarget = targets
        .map(
          (target) =>
            target.sourceEventAt ?? target.effectiveFrom ?? target.recordedAt,
        )
        .sort()[0]!;
      const terms = [
        ...new Set(
          targets.flatMap((target) => [
            ...freshnessSearchTerms(target.subject),
            ...freshnessSearchTerms(target.text),
          ]),
        ),
      ];
      // NFKD folding is part of stateRelationship, but SQLite LIKE does not
      // fold accents. A non-ASCII target therefore keeps the SQL prefilter
      // conservative and lets the exact JS relationship check decide.
      const lexicalPotential =
        terms.length === 0 || terms.some((term) => /[^\x00-\x7f]/u.test(term))
          ? undefined
          : sql`EXISTS (
          SELECT 1
          FROM json_each(${JSON.stringify(terms)}) AS freshness_term
          WHERE lower(${records.subject}) LIKE '%' || lower(freshness_term.value) || '%'
             OR lower(${records.text}) LIKE '%' || lower(freshness_term.value) || '%'
        )`;
      return and(
        eq(records.projectId, projectId),
        gt(observationTime, earliestTarget),
        currentStateWorking,
        lexicalPotential,
      );
    },
  );
  const workingCandidates =
    workingWhere.length === 0
      ? []
      : (db
          .select()
          .from(records)
          .where(
            and(
              eq(records.reviewStatus, "proposed"),
              eq(records.evidenceBasis, "agent_report"),
              eq(records.type, "fact"),
              or(...workingWhere),
            ),
          )
          .all() as FreshnessRecord[]);
  const workingRecords = workingCandidates.filter((working) => {
    if (!isCurrentStateClaim(working)) return false;
    const workingTime =
      working.sourceEventAt ?? working.effectiveFrom ?? working.recordedAt;
    return freshnessTargets.some(
      (target) =>
        target.projectId === working.projectId &&
        workingTime >
          (target.sourceEventAt ?? target.effectiveFrom ?? target.recordedAt) &&
        stateRelationship(target, working) !== "unrelated",
    );
  });

  const conflictRecordIds = rows
    .filter((row) => row.reviewStatus === "accepted" && row.projectId !== null)
    .map((row) => row.id);
  const unresolvedConflicts = db
    .select({ recordIdsJson: conflicts.recordIdsJson })
    .from(conflicts)
    .where(
      conflictRecordIds.length === 0
        ? sql`0`
        : and(
            inArray(conflicts.projectId, projectIds),
            eq(conflicts.status, "unresolved"),
            sql`EXISTS (
            SELECT 1
            FROM json_each(CASE
              WHEN json_valid(${conflicts.recordIdsJson}) THEN ${conflicts.recordIdsJson}
              ELSE '[]'
            END) AS conflict_record
            WHERE EXISTS (
              SELECT 1
              FROM json_each(${JSON.stringify(conflictRecordIds)}) AS page_record
              WHERE page_record.value = conflict_record.value
            )
          )`,
          ),
    )
    .all()
    .map((row) => ({ recordIds: parseJson<string[]>(row.recordIdsJson, []) }));

  return { nowIso, workingRecords, conflicts: unresolvedConflicts };
}

function freshnessSearchTerms(value: string): string[] {
  const rawTerms = value
    .split(/[^\p{L}\p{N}._:-]+/u)
    .filter((term) => term.length >= 2);
  return [
    ...new Set([...rawTerms, ...memoryTokens(value), foldMemoryText(value)]),
  ];
}

export function attachProjectNames(db: Db, rows: RecordRow[], evidence: Map<string, EvidenceDto[]>): RecordDto[] {
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((p): p is string => p !== null))];
  const names = new Map<string, string>();
  if (projectIds.length > 0) {
    for (const p of db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(inArray(projects.id, projectIds)))
      .all()) {
      names.set(p.id, p.name);
    }
  }
  const freshnessContext = loadRecordFreshnessContext(db, rows);
  return rows.map((r) => ({
    ...toRecordDto(r, evidence.get(r.id) ?? [], freshnessContext),
    projectName: r.projectId ? (names.get(r.projectId) ?? null) : null,
  }));
}
