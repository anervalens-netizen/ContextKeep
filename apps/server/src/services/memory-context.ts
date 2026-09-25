import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { ContextDiagnosticReason, EvidenceDto } from "@contextkeep/shared";
import { conflicts, handoffs, projects, records } from "../db/schema.js";
import { workspaceBindings } from "../db/workspace-schema.js";
import { ApiError } from "../lib/errors.js";
import type { ServiceDeps } from "./import.js";
import { loadEvidenceFor, loadEvidenceRefsFor, parseJson, toProjectDto, type EvidenceRefDto } from "./mappers.js";
import { retrieveRecordMatches, search, type RetrievedRecordMatch } from "./search.js";
import { searchRelations } from "./relations.js";
import { synthesize } from "./synthesis.js";
import { parseWorkingCheckpoint } from "./checkpoint.js";
import { compactWorkingCheckpoint, latestCheckpointFor } from "./checkpoint-context.js";
import { getBlockerState } from "./blockers.js";
import { selectContextRows } from "./context-selection.js";
import { fitWorkContext, type WorkContextDiagnostics, type WorkContextSectionDiagnostic } from "./context-budget.js";
import {
  classifyRecordFreshness,
  isCurrentStateClaim,
  memoryTokens,
  type FreshnessRecord,
  type RecordFreshnessContext,
} from "./memory-freshness.js";
import type { MemoryScope } from "./memory-scope.js";

const MAX_PROJECTS = 50;
const MAX_OVERVIEW_RECORDS = 24;
const MAX_ACTIVITY = 25;
const MAX_SEARCH_RECORDS = 15;
const MAX_SYNTHESIS_CLAIMS = 20;
const MAX_SOURCES = 20;
const MAX_AGENT_HISTORY = 25;
const MAX_EVIDENCE_PER_RECORD = 3;
const MAX_TEXT_CHARS = 2_000;
const MAX_EVIDENCE_TEXT_CHARS = 1_200;

type WorkContextTaskCache = {
  matches: Map<string, RetrievedRecordMatch[]>;
  relations: Map<string, ReturnType<typeof searchRelations>>;
};

const WORK_CONTEXT_TASK_CACHE = new WeakMap<ServiceDeps, WorkContextTaskCache>();

function workContextTaskCache(deps: ServiceDeps): WorkContextTaskCache {
  const cached = WORK_CONTEXT_TASK_CACHE.get(deps);
  if (cached) return cached;
  const created: WorkContextTaskCache = { matches: new Map(), relations: new Map() };
  WORK_CONTEXT_TASK_CACHE.set(deps, created);
  return created;
}

function rememberBounded<T>(cache: Map<string, T>, key: string, value: T, maxEntries = 64): T {
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}

type RecordRow = typeof records.$inferSelect;

function checkpointFromRow(row: RecordRow) {
  return parseWorkingCheckpoint(row.valueJson);
}

function observedAt(row: RecordRow): string {
  return row.sourceEventAt ?? row.recordedAt;
}

function queryTokens(value: string): string[] {
  return memoryTokens(value);
}

function relevanceScore(row: RecordRow, task: string | undefined): number {
  if (!task) return 0;
  const wanted = new Set(queryTokens(task));
  const haystack = new Set(queryTokens([row.subject, row.predicate ?? "", row.text, row.valueJson ?? ""].join(" ")));
  let score = 0;
  for (const token of wanted) if (haystack.has(token)) score += 1;
  return score;
}

function rankForTask(rows: RecordRow[], task: string | undefined, limit: number): RecordRow[] {
  if (!task) return rows.slice(0, limit);
  return rows
    .map((row, index) => ({ row, score: relevanceScore(row, task), index }))
    .sort((a, b) => b.score - a.score || observedAt(b.row).localeCompare(observedAt(a.row)) || a.index - b.index)
    .filter((item) => item.score > 0)
    .slice(0, limit)
    .map((item) => item.row);
}

export interface MemoryToolRunContext {
  scope: MemoryScope;
  projectId: string | null;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  return Math.max(1, Math.min(max, value ?? fallback));
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function compactEvidence(evidence: EvidenceDto[]): Array<Record<string, unknown>> {
  return evidence.slice(0, MAX_EVIDENCE_PER_RECORD).map((item) => ({
    excerptId: item.excerptId,
    sourceId: item.sourceId,
    sourceTitle: item.sourceTitle,
    relation: item.relation,
    observedAt: item.observedAt,
    artifactRef: item.artifactRef,
    text: clip(item.text, MAX_EVIDENCE_TEXT_CHARS),
  }));
}

function evidenceRefs(evidence: EvidenceRefDto[]): Array<Record<string, unknown>> {
  return evidence.slice(0, MAX_EVIDENCE_PER_RECORD).map((item) => ({
    excerptId: item.excerptId,
    sourceId: item.sourceId,
    sourceTitle: item.sourceTitle,
    relation: item.relation,
    observedAt: item.observedAt,
    artifactRef: item.artifactRef,
  }));
}

export class ContextKeepMemoryService {
  constructor(private readonly deps: ServiceDeps) {}

  private projectId(
    context: MemoryToolRunContext,
    requestedProjectId: string | undefined,
    required: boolean,
  ): string | null {
    if (context.scope === "project") {
      if (!context.projectId) {
        throw new ApiError(409, "agent_scope_invalid", "Project-scoped context has no project binding.");
      }
      if (requestedProjectId && requestedProjectId !== context.projectId) {
        throw new ApiError(403, "agent_scope_violation", "This context is scoped to a different project.");
      }
      return context.projectId;
    }

    if (!requestedProjectId) {
      if (required) {
        throw new ApiError(400, "agent_project_required", "Choose a project for this operation in all-project scope.");
      }
      return null;
    }

    const exists = this.deps.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, requestedProjectId))
      .get();
    if (!exists) throw new ApiError(404, "project_not_found", "Project not found.");
    return requestedProjectId;
  }

  listProjects(context: MemoryToolRunContext, requestedLimit?: number): Record<string, unknown> {
    if (context.scope === "project") {
      const projectId = this.projectId(context, undefined, true)!;
      const row = this.deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
      return { scope: "project", projects: row ? [toProjectDto(row)] : [] };
    }
    const limit = clamp(requestedLimit, 25, MAX_PROJECTS);
    const rows = this.deps.db.select().from(projects).orderBy(desc(projects.updatedAt), projects.name).limit(limit).all();
    return { scope: "all", projects: rows.map(toProjectDto), limit };
  }

  getProjectOverview(
    context: MemoryToolRunContext,
    input: { projectId?: string; limit?: number },
  ): Record<string, unknown> {
    const projectId = this.projectId(context, input.projectId, true)!;
    const project = this.deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) throw new ApiError(404, "project_not_found", "Project not found.");
    const limit = clamp(input.limit, 12, MAX_OVERVIEW_RECORDS);
    const rows = this.deps.db
      .select()
      .from(records)
      .where(and(eq(records.projectId, projectId), eq(records.reviewStatus, "accepted")))
      .orderBy(sql`COALESCE(${records.reviewedAt}, ${records.recordedAt}) DESC`)
      .limit(limit)
      .all();
    const evidence = loadEvidenceFor(this.deps.db, rows.map((row) => row.id));
    const counts = this.deps.sqlite
      .prepare(
        `SELECT type, count(*) AS count
         FROM records
         WHERE project_id = ? AND review_status = 'accepted'
         GROUP BY type`,
      )
      .all(projectId) as Array<{ type: string; count: number }>;

    return {
      project: toProjectDto(project),
      acceptedCounts: Object.fromEntries(counts.map((row) => [row.type, row.count])),
      recentCanonicalRecords: rows.map((row) => ({
        recordId: row.id,
        type: row.type,
        subject: row.subject,
        predicate: row.predicate,
        text: clip(row.text, MAX_TEXT_CHARS),
        taskStatus: row.taskStatus,
        reviewedAt: row.reviewedAt,
        reviewDueAt: row.reviewDueAt,
        volatile: row.volatile === 1,
        evidence: compactEvidence(evidence.get(row.id) ?? []),
      })),
      limit,
    };
  }

  getWorkContext(
    context: MemoryToolRunContext,
    input: { projectId?: string; limitPerSection?: number; task?: string; totalContextBudgetChars?: number; diagnostics?: boolean; permanentConstraintIds?: string[] },
  ): Record<string, unknown> {
    const projectId = this.projectId(context, input.projectId, true)!;
    const project = this.deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) throw new ApiError(404, "project_not_found", "Project not found.");
    const limit = clamp(input.limitPerSection, 5, 10);
    const task = input.task?.trim() || undefined;
    const fetchLimit = task ? Math.min(50, Math.max(limit * 5, 25)) : limit;
    const contextNow = new Date().toISOString();
    // CK-A05: preload freshness signals once. The pure classifier below does
    // not query the database per record.
    const freshnessWorkingRecords = this.deps.db
      .select({
        id: records.id,
        projectId: records.projectId,
        type: records.type,
        subject: records.subject,
        predicate: records.predicate,
        valueJson: records.valueJson,
        text: records.text,
        reviewStatus: records.reviewStatus,
        evidenceBasis: records.evidenceBasis,
        taskStatus: records.taskStatus,
        recordedAt: records.recordedAt,
        sourceEventAt: records.sourceEventAt,
        effectiveFrom: records.effectiveFrom,
        effectiveTo: records.effectiveTo,
        reviewDueAt: records.reviewDueAt,
        volatile: records.volatile,
      })
      .from(records)
      .where(and(
        eq(records.projectId, projectId),
        eq(records.reviewStatus, "proposed"),
        eq(records.evidenceBasis, "agent_report"),
        eq(records.type, "fact"),
      ))
      .all() as FreshnessRecord[];
    const freshnessConflicts = this.deps.db
      .select({ recordIdsJson: conflicts.recordIdsJson })
      .from(conflicts)
      .where(and(eq(conflicts.projectId, projectId), eq(conflicts.status, "unresolved")))
      .all()
      .map((row) => ({ recordIds: parseJson<string[]>(row.recordIdsJson, []) }));
    const recordFreshnessContext: RecordFreshnessContext = {
      nowIso: contextNow,
      workingRecords: freshnessWorkingRecords,
      conflicts: freshnessConflicts,
    };
    const diagnosticsRequested = input.diagnostics === true;
    const canonicalTaskMatchIds = new Set<string>();
    const workingTaskMatchIds = new Set<string>();
    const taskCache = task ? workContextTaskCache(this.deps) : null;
    const taskCachePrefix = task
      ? [project.id, project.revision, project.contentVersion, project.workingMemoryVersion, task, fetchLimit].join(":")
      : "";
    const taskMatches = (
      suffix: string,
      factory: () => RetrievedRecordMatch[],
    ): RetrievedRecordMatch[] => {
      if (!taskCache) return factory();
      const key = `${taskCachePrefix}:${suffix}`;
      const cached = taskCache.matches.get(key);
      if (cached) return cached;
      return rememberBounded(taskCache.matches, key, factory());
    };

    const section = (type: string, activeActionsOnly = false) => {
      const where = and(
        eq(records.projectId, projectId),
        eq(records.reviewStatus, "accepted"),
        eq(records.type, type),
        activeActionsOnly ? sql`(${records.taskStatus} IS NULL OR ${records.taskStatus} IN ('open','in_progress','blocked'))` : undefined,
      )!;
      const order = activeActionsOnly
        ? sql`CASE ${records.taskStatus} WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END, COALESCE(${records.reviewedAt}, ${records.recordedAt}) DESC`
        : sql`COALESCE(${records.reviewedAt}, ${records.recordedAt}) DESC`;

      const recentRows = this.deps.db.select().from(records).where(where).orderBy(order, desc(records.id)).limit(limit).all();
      const relevantRows = task
        ? taskMatches(`accepted:${type}`, () => retrieveRecordMatches(this.deps.db, {
            q: task,
            projectId,
            type,
            statuses: ["accepted"],
            limit: fetchLimit,
            hydrateEvidence: false,
          })).map((match) => match.row)
            .filter((row) => !activeActionsOnly || row.taskStatus === null || ["open", "in_progress", "blocked"].includes(row.taskStatus))
        : [];
      if (diagnosticsRequested && task) {
        for (const row of relevantRows) canonicalTaskMatchIds.add(row.id);
      }

      // Constraints and active actions are operational guardrails: reserve
      // space for recent mandatory context even if task wording has no lexical
      // overlap. Other sections stay task-relevant.
      const mandatoryRows = task && (type === "constraint" || activeActionsOnly) ? recentRows : [];
      const selectedRows = task
        ? selectContextRows({ relevantRows, mandatoryRows, limit })
        : recentRows.slice(0, limit);
      const requestedCore = type === "constraint" ? [...new Set(input.permanentConstraintIds ?? [])].slice(0, 5) : [];
      const coreRows = requestedCore.length ? this.deps.db.select().from(records)
        .where(and(where, inArray(records.id, requestedCore))).orderBy(records.id).all() : [];
      const rows = [...coreRows, ...selectedRows.filter((row) => !coreRows.some((core) => core.id === row.id))].slice(0, limit);
      const evidence = loadEvidenceRefsFor(this.deps.db, rows.map((row) => row.id));
      const total = Number(this.deps.db.select({ n: sql.raw("count(*)") }).from(records).where(where).get()!.n);
      return {
        total,
        ...(requestedCore.length ? { permanentCore: {
          requestedRecordIds: requestedCore,
          eligibleRecordIds: coreRows.map((row) => row.id),
          maxRecords: 5,
          semantics: "Explicit opt-in accepted project constraints only; priority within section and total budgets. No authority changes. Omitted IDs require get_record.",
        } } : {}),
        truncated: total > rows.length,
        items: rows.map((row) => {
          const refs = evidence.get(row.id) ?? [];
          const attention = classifyRecordFreshness(row as FreshnessRecord, recordFreshnessContext);
          return {
            recordId: row.id,
            revision: row.revision,
            sourceType: row.type,
            subject: row.subject,
            text: clip(row.text, 1_000),
            taskStatus: row.taskStatus,
            reviewedAt: row.reviewedAt,
            reviewDueAt: row.reviewDueAt,
            status: "accepted",
            provenance: row.evidenceBasis,
            observedAt: observedAt(row),
            stale: attention.stale,
            requiresReview: attention.requiresReview,
            freshnessReasons: attention.reasons,
            freshness: attention,
            evidenceRefs: evidenceRefs(refs),
            evidenceCount: refs.length,
          };
        }),
      };
    };

    const factWhere = and(
      eq(records.projectId, projectId),
      eq(records.reviewStatus, "accepted"),
      eq(records.type, "fact"),
      sql`(${records.predicate} IS NULL OR ${records.predicate} != 'lifecycle')`,
    )!;
    const recentFactRows = this.deps.db
      .select()
      .from(records)
      .where(factWhere)
      .orderBy(sql`COALESCE(${records.reviewedAt}, ${records.recordedAt}) DESC`, desc(records.id))
      .limit(limit)
      .all();
    const factRows = task
      ? (() => {
          const global = taskMatches("accepted:fact", () => retrieveRecordMatches(this.deps.db, {
            q: task,
            projectId,
            type: "fact",
            statuses: ["accepted"],
            limit: fetchLimit,
            hydrateEvidence: false,
          })).map((match) => match.row).filter((row) => row.predicate !== "lifecycle");
          const recentRelevant = rankForTask(recentFactRows, task, limit);
          const seen = new Set<string>();
          return [...global, ...recentRelevant].filter((row) => {
            if (seen.has(row.id)) return false;
            seen.add(row.id);
            return true;
          }).slice(0, limit);
        })()
      : recentFactRows;
    if (diagnosticsRequested && task) {
      for (const row of factRows) canonicalTaskMatchIds.add(row.id);
    }
    const factTotal = Number(this.deps.db.select({ n: sql.raw("count(*)") }).from(records).where(factWhere).get()!.n);
    const factEvidence = loadEvidenceRefsFor(this.deps.db, factRows.map((row) => row.id));
    const mapFact = (row: RecordRow) => {
      const refs = factEvidence.get(row.id) ?? [];
      const attention = classifyRecordFreshness(row as FreshnessRecord, recordFreshnessContext);
      return {
        recordId: row.id,
        revision: row.revision,
        sourceType: row.type,
        subject: row.subject,
        predicate: row.predicate,
        text: clip(row.text, 1_000),
        taskStatus: row.taskStatus,
        reviewedAt: row.reviewedAt,
        recordedAt: row.recordedAt,
        observedAt: observedAt(row),
        reviewDueAt: row.reviewDueAt,
        status: "accepted",
        provenance: row.evidenceBasis,
        stale: attention.stale,
        requiresReview: attention.requiresReview,
        freshnessReasons: attention.reasons,
        freshness: attention,
        evidenceRefs: evidenceRefs(refs),
        evidenceCount: refs.length,
      };
    };
    const facts = {
      total: factTotal,
      truncated: factTotal > factRows.length,
      items: factRows.map(mapFact),
    };
    const currentFacts = factRows.filter(isCurrentStateClaim);
    const currentState = {
      scope: "selected_facts_subset",
      selectedCount: currentFacts.length,
      upstreamOmitted: Math.max(0, factTotal - factRows.length),
      total: currentFacts.length,
      truncated: currentFacts.length > limit,
      items: currentFacts.slice(0, limit).map(mapFact),
      semantics: "Subset of selected facts, not a project-wide census. Zero selected does not mean zero existing. Current-state claims are timestamped observations. A newer working observation marks accepted state stale and requires owner review; working memory is never auto-promoted.",
    };

    const recentWorkWhere = and(
      eq(records.projectId, projectId),
      eq(records.reviewStatus, "proposed"),
      eq(records.evidenceBasis, "agent_report"),
    )!;
    const recentWorkRows = this.deps.db
      .select()
      .from(records)
      .where(recentWorkWhere)
      .orderBy(desc(records.recordedAt), desc(records.id))
      .limit(fetchLimit)
      .all();
    const rankedRecentWorkRows = task
      ? (() => {
          const global = taskMatches("working:agent_report", () => retrieveRecordMatches(this.deps.db, {
            q: task,
            projectId,
            basis: "agent_report",
            statuses: ["proposed"],
            limit: fetchLimit,
            hydrateEvidence: false,
          })).map((match) => match.row);
          const recentRelevant = rankForTask(recentWorkRows, task, limit);
          const seen = new Set<string>();
          return [...global, ...recentRelevant].filter((row) => {
            if (seen.has(row.id)) return false;
            seen.add(row.id);
            return true;
          }).slice(0, limit);
        })()
      : recentWorkRows.slice(0, limit);
    if (diagnosticsRequested && task) {
      for (const row of rankedRecentWorkRows) workingTaskMatchIds.add(row.id);
    }
    const recentWorkEvidence = loadEvidenceRefsFor(this.deps.db, rankedRecentWorkRows.map((row) => row.id));
    const recentWorkTotal = Number(
      this.deps.db.select({ n: sql.raw("count(*)") }).from(records).where(recentWorkWhere).get()!.n,
    );
    const recentHandoffRows = this.deps.db
      .select()
      .from(handoffs)
      .where(eq(handoffs.projectId, projectId))
      .orderBy(desc(handoffs.createdAt), desc(handoffs.id))
      .limit(limit)
      .all();
    const recentHandoffTotal = Number(
      this.deps.db
        .select({ n: sql.raw("count(*)") })
        .from(handoffs)
        .where(eq(handoffs.projectId, projectId))
        .get()!.n,
    );

    const recentWork = {
      total: recentWorkTotal,
      truncated: recentWorkTotal > rankedRecentWorkRows.length || (task !== undefined && rankedRecentWorkRows.length === limit),
      items: rankedRecentWorkRows.map((row) => {
        const refs = recentWorkEvidence.get(row.id) ?? [];
        const checkpoint = checkpointFromRow(row);
        const attention = classifyRecordFreshness(row as FreshnessRecord, recordFreshnessContext);
        return {
          recordId: row.id,
          revision: row.revision,
          reviewStatus: row.reviewStatus,
          sourceType: row.type,
          subject: row.subject,
          text: clip(row.text, 1_000),
          taskStatus: row.taskStatus,
          recordedAt: row.recordedAt,
          observedAt: observedAt(row),
          status: "proposed",
          provenance: row.evidenceBasis,
          memoryStatus: "unreviewed_working_memory",
          truthStatus: "not_canonical_requires_review",
          stale: attention.stale,
          requiresReview: attention.requiresReview,
          freshnessReasons: attention.reasons,
          freshness: attention,
          checkpoint: compactWorkingCheckpoint(checkpoint, row.id),
          evidenceRefs: evidenceRefs(refs),
          evidenceCount: refs.length,
        };
      }),
    };
    // Review changes authority, not the chronology of agent resume.
    const latestCheckpoint = latestCheckpointFor(this.deps.db, projectId);
    const blockerState = getBlockerState(this.deps, projectId);
    const latestBlockers = blockerState.active.map((item) => item.text).slice(0, 20);
    const compactBlockerState = {
      activeCount: blockerState.activeCount,
      resolvedCount: blockerState.resolvedCount,
      active: blockerState.active.slice(0, 10).map((item) => ({
        blockerId: item.blockerId,
        text: clip(item.text, 500),
        checkpointRecordId: item.checkpointRecordId,
        checkpointRevision: item.checkpointRevision,
        checkpointRecordedAt: item.checkpointRecordedAt,
        identitySource: item.identitySource,
      })),
      recentResolved: blockerState.resolved.slice(0, 5).map((item) => ({
        blockerId: item.blockerId,
        text: clip(item.text, 500),
        disposition: item.status,
        resolution: item.resolution,
      })),
      semantics: blockerState.semantics,
    };

    const taskRelations = task
      ? (() => {
          const key = `${taskCachePrefix}:relations`;
          const cached = taskCache!.relations.get(key);
          if (cached) return cached;
          return rememberBounded(
            taskCache!.relations,
            key,
            searchRelations(this.deps, { projectId, q: task, scope: "all", limit: 5 }),
          );
        })()
      : null;
    if (diagnosticsRequested && taskRelations) {
      for (const relation of taskRelations.canonicalRelations) canonicalTaskMatchIds.add(relation.recordId);
      for (const relation of taskRelations.workingRelations) workingTaskMatchIds.add(relation.recordId);
    }
    const relations = taskRelations
      ? {
          canonical: taskRelations.canonicalRelations.map((relation) => ({
            ...relation,
            text: clip(relation.text, 600),
            status: "accepted",
            truthStatus: "canonical_accepted_or_historical",
          })),
          working: taskRelations.workingRelations.map((relation) => ({
            ...relation,
            text: clip(relation.text, 600),
            status: "proposed",
            truthStatus: "not_canonical_requires_review",
          })),
          semantics: "Task-aware relations are bounded to five matches and keep accepted canonical records separate from proposed working records.",
        }
      : undefined;

    const workingMemory = {
      scope: "working",
      semantics: "Unreviewed agent_report records only. Proposal-only, project-scoped, timestamped and never canonical truth.",
      cursor: project.workingMemoryVersion,
      total: recentWork.total,
      truncated: recentWork.truncated,
      // recentWork remains the compatibility/detail view. workingMemory is a
      // non-duplicating index that points at the same proposal records.
      items: recentWork.items.map((item) => ({
        recordId: item.recordId,
        revision: item.revision,
        recordedAt: item.recordedAt,
        status: item.status,
        subject: item.subject,
        truthStatus: item.truthStatus,
        requiresReview: item.requiresReview,
        memoryStatus: item.memoryStatus,
        // Full CK-A05 freshness lives on recentWork/search/RecordDto. This
        // compatibility index stays compact so a 6k resume budget can retain
        // at least one proposal pointer instead of duplicating the same model.
        freshnessState: item.freshness
          ? {
              authority: item.freshness.authority,
              currentness: item.freshness.currentness,
              stale: item.freshness.stale,
              requiresReview: item.freshness.requiresReview,
            }
          : undefined,
        checkpointRef: item.checkpoint
          ? { recordId: item.recordId, recovery: { tool: "get_record", includeUnreviewed: true } }
          : null,
      })),
    };
    const goals = section("decision");
    const actions = section("action", true);
    const constraints = section("constraint");
    const openQuestions = section("question");
    const recentHandoffs = {
      total: recentHandoffTotal,
      truncated: recentHandoffTotal > recentHandoffRows.length,
      items: recentHandoffRows.map((handoff) => {
        const included = parseJson<unknown[]>(handoff.includedRecordIdsJson, []);
        const truncationNotes = parseJson<unknown[]>(handoff.truncationNotesJson, []);
        return {
          handoffId: handoff.id,
          createdAt: handoff.createdAt,
          sourceRevision: handoff.sourceRevision,
          sourceContentVersion: handoff.sourceContentVersion,
          objective: handoff.objective === null ? null : clip(handoff.objective, 1_000),
          includedRecordCount: Array.isArray(included) ? included.length : 0,
          truncationNoteCount: Array.isArray(truncationNotes) ? truncationNotes.length : 0,
        };
      }),
    };

    const canonicalEligibleTotal = goals.total + actions.total + constraints.total + openQuestions.total + facts.total;
    const workingEligibleTotal = recentWork.total;
    const diagnosticReasons: ContextDiagnosticReason[] = [];
    if (diagnosticsRequested) {
      if (canonicalEligibleTotal === 0 && workingEligibleTotal === 0) {
        diagnosticReasons.push("no_data");
      } else if (task && canonicalTaskMatchIds.size === 0 && workingTaskMatchIds.size > 0) {
        diagnosticReasons.push("unreviewed_only");
      } else if (task && canonicalTaskMatchIds.size === 0 && workingTaskMatchIds.size === 0) {
        diagnosticReasons.push("no_relevant_match");
      }
    }

    const canonicalSections = [goals, actions, constraints, openQuestions, facts];
    const selectedStaleIds = diagnosticsRequested
      ? [...new Set(canonicalSections.flatMap((value) =>
          value.items
            .filter((item) => item.stale === true && (!task || canonicalTaskMatchIds.has(item.recordId)))
            .map((item) => item.recordId),
        ))]
      : [];
    if (selectedStaleIds.length > 0 && !diagnosticReasons.includes("stale")) {
      diagnosticReasons.push("stale");
    }

    const sectionDiagnostic = (
      value: { total: number; items: unknown[]; upstreamOmitted?: number },
      kind: "canonical" | "working" | "other" = "canonical",
    ): WorkContextSectionDiagnostic => {
      const selectedBeforeBudget = value.items.length;
      let omissionReason: ContextDiagnosticReason | null = null;
      if (value.total === 0 && !value.upstreamOmitted) {
        omissionReason = "no_data";
      } else if (
        diagnosticsRequested &&
        task &&
        selectedBeforeBudget === 0 &&
        (kind !== "working" || workingTaskMatchIds.size === 0)
      ) {
        omissionReason = "no_relevant_match";
      }
      return {
        eligibleTotal: value.total,
        selectedBeforeBudget,
        returnedAfterBudget: selectedBeforeBudget,
        omittedAfterBudget: Math.max(0, value.total - selectedBeforeBudget),
        omissionReason,
      };
    };

    const diagnostics: WorkContextDiagnostics | undefined = diagnosticsRequested
      ? {
          mode: "deterministic_lexical_fts",
          reasons: diagnosticReasons,
          taskSelection: {
            matchReason: task ? "deterministic_lexical_fts" : null,
            canonicalRecordIds: [...canonicalTaskMatchIds].slice(0, 20),
            workingRecordIds: [...workingTaskMatchIds].slice(0, 20),
            staleRecordIds: selectedStaleIds.slice(0, 20),
            freshnessReason: selectedStaleIds.length > 0 ? "stale" : null,
          },
          sections: {
            goals: sectionDiagnostic(goals),
            actions: sectionDiagnostic(actions),
            constraints: sectionDiagnostic(constraints),
            openQuestions: sectionDiagnostic(openQuestions),
            facts: sectionDiagnostic(facts),
            currentState: sectionDiagnostic(currentState),
            recentWork: sectionDiagnostic(recentWork, "working"),
            workingMemory: sectionDiagnostic(workingMemory, "working"),
            recentHandoffs: sectionDiagnostic(recentHandoffs, "other"),
          },
        }
      : undefined;

    const payload: Record<string, unknown> = {
      project: {
        id: project.id,
        name: project.name,
        lifecycle: project.lifecycle,
        description: project.description,
        revision: project.revision,
        contentVersion: project.contentVersion,
        workingMemoryVersion: project.workingMemoryVersion,
      },
      freshness: {
        canonicalCursor: project.contentVersion,
        workingCursor: project.workingMemoryVersion,
        canonical: { cursor: project.contentVersion, status: "canonical" },
        working: { cursor: project.workingMemoryVersion, status: "unreviewed_working_memory" },
      },
      objective: project.description,
      task: task ?? null,
      goalSemantics: "goals are current accepted decision records; unstated goals are never inferred",
      goals,
      actions,
      constraints,
      openQuestions,
      facts,
      currentState,
      recentWorkSemantics:
        "recentWork contains unreviewed agent_report proposals only; it is useful working memory, not canonical truth.",
      recentWork,
      workingMemory,
      recentHandoffs,
      latestCheckpoint,
      latestNextAction: latestCheckpoint?.checkpoint?.nextAction ?? null,
      latestBlockers,
      blockerState: compactBlockerState,
      ...(relations ? { relations } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      indicators: {
        stale: currentState.items.some((item) => item.stale),
        blocked: blockerState.activeCount > 0,
        truncated: false,
        unknown: [
          ...(task && facts.items.length === 0 ? ["no_task_relevant_accepted_facts"] : []),
          ...(task && rankedRecentWorkRows.length === 0 ? ["no_task_relevant_working_memory"] : []),
        ],
      },
      generatedAt: new Date().toISOString(),
      limits: { perSection: limit, evidenceRefsPerRecord: MAX_EVIDENCE_PER_RECORD, textCharsPerRecord: 1_000 },
    };
    // CK-A03: every normal/compact/minimal branch returns through the MCP
    // registry's single shared McpWorkContextResult validator. Do not parse a
    // second time here: output validation belongs at the transport boundary
    // and the duplicate traversal is material on the 1k+1k hot-path fixture.
    return fitWorkContext(payload, input.totalContextBudgetChars);
  }

  getProjectActivity(
    context: MemoryToolRunContext,
    input: { projectId?: string; limit?: number },
  ): Record<string, unknown> {
    const projectId = this.projectId(context, input.projectId, true)!;
    const limit = clamp(input.limit, 15, MAX_ACTIVITY);
    const rows = this.deps.db
      .select()
      .from(records)
      .where(and(eq(records.projectId, projectId), inArray(records.reviewStatus, ["accepted", "superseded"])))
      .orderBy(sql`COALESCE(${records.sourceEventAt}, ${records.recordedAt}) DESC`)
      .limit(limit)
      .all();
    const workspaces = this.deps.db
      .select({
        workspaceId: workspaceBindings.id,
        displayName: workspaceBindings.displayName,
        gitRemote: workspaceBindings.gitRemote,
        gitBranch: workspaceBindings.gitBranch,
        gitHeadSha: workspaceBindings.gitHeadSha,
        lastGitActivity: workspaceBindings.lastGitActivity,
        lastObservedActivity: workspaceBindings.lastObservedActivity,
      })
      .from(workspaceBindings)
      .where(and(eq(workspaceBindings.projectId, projectId), eq(workspaceBindings.ignored, 0)))
      .orderBy(sql`COALESCE(${workspaceBindings.lastObservedActivity}, ${workspaceBindings.lastGitActivity}, ${workspaceBindings.updatedAt}) DESC`)
      .limit(5)
      .all();

    return {
      projectId,
      canonicalEvents: rows.map((row) => ({
        recordId: row.id,
        type: row.type,
        reviewStatus: row.reviewStatus,
        text: clip(row.text, MAX_TEXT_CHARS),
        taskStatus: row.taskStatus,
        eventAt: row.sourceEventAt ?? row.recordedAt,
        reviewedAt: row.reviewedAt,
      })),
      workspaceSignals: workspaces,
      limit,
    };
  }

  searchContext(
    context: MemoryToolRunContext,
    input: { q: string; projectId?: string; includeHistorical?: boolean; match?: "terms" | "phrase"; scope?: "canonical" | "working" | "all"; limit?: number },
  ): Record<string, unknown> {
    const projectId = this.projectId(context, input.projectId, false);
    const limit = clamp(input.limit, 10, MAX_SEARCH_RECORDS);
    const result = search(this.deps, {
      q: input.q,
      mode: "canonical",
      match: input.match ?? "terms",
      scope: input.scope ?? "canonical",
      projectId,
      includeHistorical: input.includeHistorical === true,
      limit,
    });
    const compactSearchRecord = (record: (typeof result.records)[number], working: boolean) => {
      const freshness = record.freshness ?? {
        authority: working ? "working" : record.reviewStatus === "superseded" ? "historical" : "canonical",
        currentness: record.isOverdue ? "review_due" : working ? "unknown" : "not_applicable",
        progress: record.taskStatus,
        provenance: record.evidenceBasis,
        stale: record.isOverdue,
        requiresReview: working || record.isOverdue,
        reasons: record.isOverdue ? ["review_overdue"] : working ? ["unreviewed_proposal"] : [],
        supportRecordIds: [],
        possiblyRelatedRecordIds: [],
      };
      return {
        recordId: record.id,
        projectId: record.projectId,
        projectName: record.projectName,
        type: record.type,
        subject: record.subject,
        predicate: record.predicate,
        text: clip(record.text, MAX_TEXT_CHARS),
        reviewStatus: record.reviewStatus,
        taskStatus: record.taskStatus,
        recordedAt: record.recordedAt,
        observedAt: record.sourceEventAt ?? record.recordedAt,
        reviewedAt: record.reviewedAt,
        reviewDueAt: record.reviewDueAt,
        volatile: record.volatile,
        isOverdue: record.isOverdue,
        status: working ? "proposed" : record.reviewStatus,
        provenance: record.evidenceBasis,
        memoryStatus: working ? "unreviewed_working_memory" : "canonical_memory",
        truthStatus: working ? "not_canonical_requires_review" : "canonical_accepted_or_historical",
        stale: freshness.stale,
        requiresReview: freshness.requiresReview,
        freshnessReasons: freshness.reasons,
        freshness,
        checkpoint: working ? parseWorkingCheckpoint(record.valueJson) : null,
        evidence: compactEvidence(record.evidence),
      };
    };
    const canonicalRecords = result.records.map((record) => compactSearchRecord(record, false));
    const workingRecords = result.workingRecords.map((record) => compactSearchRecord(record, true));
    return {
      completeness: result.completeness,
      query: result.query,
      mode: "canonical",
      match: result.match,
      projectId,
      scope: result.scope,
      includeHistorical: result.includeHistorical,
      records: canonicalRecords,
      canonicalRecords,
      workingRecords,
      semantics: {
        canonical: "accepted records are truth-bearing subject to historical/stale labels",
        working: "unreviewed agent_report proposals only; never auto-promoted or blended into canonical records",
      },
      limit,
    };
  }

  synthesizeContext(
    context: MemoryToolRunContext,
    input: { question: string; projectId?: string; includeHistorical?: boolean; limit?: number },
  ): Record<string, unknown> {
    const projectId = this.projectId(context, input.projectId, false);
    const limit = clamp(input.limit, 12, MAX_SYNTHESIS_CLAIMS);
    const result = synthesize(this.deps, {
      question: input.question,
      projectId,
      includeHistorical: input.includeHistorical === true,
      limit,
    });
    return {
      question: result.question,
      status: result.status,
      generatedAt: result.generatedAt,
      claims: result.claims.map((claim) => ({
        recordId: claim.recordId,
        text: clip(claim.text, MAX_TEXT_CHARS),
        reviewStatus: claim.reviewStatus,
        volatile: claim.volatile,
        reviewDueAt: claim.reviewDueAt,
        isStale: claim.isStale,
        freshnessReasons: claim.isStale ? ["review_overdue"] : [],
        evidence: compactEvidence(claim.evidence),
      })),
      contradictions: result.contradictions,
      limit,
    };
  }

  getRecordWithEvidence(context: MemoryToolRunContext, recordId: string): Record<string, unknown> {
    const row = this.deps.db
      .select()
      .from(records)
      .where(and(eq(records.id, recordId), inArray(records.reviewStatus, ["accepted", "superseded"])))
      .get();
    if (!row) throw new ApiError(404, "agent_record_not_found", "Accepted or historical record not found.");
    if (context.scope === "project" && row.projectId !== context.projectId) {
      throw new ApiError(403, "agent_scope_violation", "This record belongs to a different project.");
    }
    const project = row.projectId
      ? this.deps.db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.id, row.projectId)).get()
      : undefined;
    const evidence = loadEvidenceFor(this.deps.db, [row.id]).get(row.id) ?? [];
    return {
      recordId: row.id,
      projectId: row.projectId,
      projectName: project?.name ?? null,
      type: row.type,
      subject: row.subject,
      predicate: row.predicate,
      value: parseJson<unknown>(row.valueJson, null),
      text: clip(row.text, MAX_TEXT_CHARS),
      reviewStatus: row.reviewStatus,
      evidenceBasis: row.evidenceBasis,
      taskStatus: row.taskStatus,
      recordedAt: row.recordedAt,
      sourceEventAt: row.sourceEventAt,
      reviewedAt: row.reviewedAt,
      reviewDueAt: row.reviewDueAt,
      volatile: row.volatile === 1,
      evidence: compactEvidence(evidence),
    };
  }

  listProjectSources(
    context: MemoryToolRunContext,
    input: { projectId?: string; limit?: number },
  ): Record<string, unknown> {
    const projectId = this.projectId(context, input.projectId, true)!;
    const limit = clamp(input.limit, 12, MAX_SOURCES);
    const rows = this.deps.sqlite
      .prepare(
        `SELECT s.id, s.kind, s.title, s.imported_at AS importedAt, s.event_at AS eventAt,
                s.provenance_basis AS provenanceBasis, s.redaction_state AS redactionState,
                (SELECT count(*) FROM source_excerpts se WHERE se.source_id = s.id) AS excerptCount,
                (SELECT group_concat(DISTINCT so.connector) FROM source_origins so WHERE so.source_id = s.id) AS connectors
         FROM sources s
         WHERE s.project_id = ?
            OR EXISTS (
              SELECT 1 FROM source_origins so
              JOIN workspace_bindings wb ON wb.id = so.workspace_binding_id
              WHERE so.source_id = s.id AND wb.project_id = ?
            )
         ORDER BY COALESCE(s.event_at, s.imported_at) DESC, s.id ASC
         LIMIT ?`,
      )
      .all(projectId, projectId, limit) as Array<{
        id: string;
        kind: string;
        title: string | null;
        importedAt: string;
        eventAt: string | null;
        provenanceBasis: string;
        redactionState: string;
        excerptCount: number;
        connectors: string | null;
      }>;
    return {
      projectId,
      sources: rows.map((row) => ({
        sourceId: row.id,
        kind: row.kind,
        title: row.title,
        importedAt: row.importedAt,
        eventAt: row.eventAt,
        provenanceBasis: row.provenanceBasis,
        redactionState: row.redactionState,
        excerptCount: row.excerptCount,
        connectors: row.connectors ? row.connectors.split(",") : [],
      })),
      limit,
    };
  }

  listAgentHistory(
    context: MemoryToolRunContext,
    input: { projectId?: string; limit?: number },
  ): Record<string, unknown> {
    const projectId = this.projectId(context, input.projectId, false);
    const limit = clamp(input.limit, 15, MAX_AGENT_HISTORY);
    const select = `SELECT so.connector, so.external_id AS externalId, so.external_part AS externalPart,
                           so.archive_state AS archiveState, so.external_updated_at AS externalUpdatedAt,
                           so.source_id AS sourceId, s.title AS sourceTitle,
                           wb.id AS workspaceId, wb.display_name AS workspaceName
                    FROM source_origins so
                    JOIN sources s ON s.id = so.source_id
                    LEFT JOIN workspace_bindings wb ON wb.id = so.workspace_binding_id`;
    const order = ` ORDER BY COALESCE(so.external_updated_at, s.event_at, s.imported_at) DESC, so.id ASC LIMIT ?`;
    const rows = projectId
      ? this.deps.sqlite
          .prepare(`${select} WHERE s.project_id = ? OR wb.project_id = ?${order}`)
          .all(projectId, projectId, limit)
      : this.deps.sqlite.prepare(`${select}${order}`).all(limit);

    return {
      projectId,
      history: (rows as Array<Record<string, unknown>>).map((row) => ({
        connector: row.connector,
        externalId: row.externalId,
        externalPart: row.externalPart,
        archiveState: row.archiveState,
        externalUpdatedAt: row.externalUpdatedAt,
        sourceId: row.sourceId,
        sourceTitle: row.sourceTitle,
        workspaceId: row.workspaceId,
        workspaceName: row.workspaceName,
      })),
      limit,
      contentIncluded: false,
    };
  }
}
