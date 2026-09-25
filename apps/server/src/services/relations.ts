import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { RelationKind, relationKinds, type RelationKind as RelationKindValue } from "@contextkeep/shared";
import type { EvidenceDto } from "@contextkeep/shared";
import { records } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { nowIso } from "../lib/time.js";
import { loadEvidenceFor, relationObjectValue } from "./mappers.js";
import { createRecord, requireProject } from "./memory-management.js";
import type { ActorCtx, ServiceDeps } from "./import.js";
import { retrieveRecordMatches } from "./search.js";
import { foldMemoryText, memoryTokens } from "./memory-freshness.js";

export const RELATION_LIMIT = 15;

export type RelationScope = "canonical" | "working" | "all";
export type RelationDirection = "outgoing" | "incoming" | "both";

export interface RelationInput {
  projectId: string;
  sourceExcerptId: string;
  subject: string;
  relation: RelationKindValue;
  object: string;
  evidenceBasis: "agent_report" | "document" | "observed_technical";
  eventAt: string | null;
}

export interface RelationSearchInput {
  projectId: string;
  q?: string;
  relation?: RelationKindValue;
  direction?: RelationDirection;
  subject?: string;
  object?: string;
  includeHistorical?: boolean;
  scope?: RelationScope;
  limit?: number;
}

type RelationRow = typeof records.$inferSelect;

function isRelationKind(value: string | null): value is RelationKindValue {
  return value !== null && (relationKinds as readonly string[]).includes(value);
}

function relationObject(row: RelationRow): string | null {
  return relationObjectValue(row.predicate, row.valueJson);
}

const fold = foldMemoryText;
const tokens = memoryTokens;

const RELATION_INTENT: Record<RelationKindValue, Set<string>> = {
  depends_on: new Set([
    "depend", "depends", "dependency", "dependencies", "prerequisite", "prerequisites", "require", "requires",
    "required", "rely", "relies", "condition", "conditions", "gate", "gates", "before", "need", "needs",
    "depinde", "dependenta", "dependente", "conditie", "conditii", "nevoie", "trebuie", "inainte", "disponibila",
    "disponibil", "functional", "functionala",
  ]),
  blocks: new Set(["block", "blocks", "blocked", "blocker", "blocking", "blocheaza", "blocat", "blocaj"]),
  affects: new Set(["affect", "affects", "affected", "impact", "impacts", "influences", "afecteaza", "impacteaza"]),
  runs_on: new Set(["runs", "running", "host", "hosted", "machine", "server", "ruleaza", "gazduit", "masina"]),
};

function inferredRelation(query: string | undefined): RelationKindValue | null {
  if (!query) return null;
  const queryTokens = tokens(query);
  let best: { kind: RelationKindValue; hits: number } | null = null;
  for (const kind of relationKinds) {
    const hits = queryTokens.filter((token) => RELATION_INTENT[kind].has(token)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { kind, hits };
  }
  return best?.kind ?? null;
}

function relationDto(
  projectName: string | null,
  row: RelationRow,
  evidenceMap: Map<string, EvidenceDto[]>,
) {
  const object = relationObject(row);
  if (!isRelationKind(row.predicate) || object === null) return null;
  const evidence = evidenceMap.get(row.id) ?? [];
  const evidenceIds = evidence.map((item) => item.excerptId);
  return {
    recordId: row.id,
    projectId: row.projectId,
    projectName,
    relation: row.predicate,
    subject: row.subject,
    object,
    text: row.text,
    reviewStatus: row.reviewStatus,
    evidenceBasis: row.evidenceBasis,
    evidenceIds,
    evidenceCount: evidenceIds.length,
    recordedAt: row.recordedAt,
    sourceEventAt: row.sourceEventAt,
    reviewedAt: row.reviewedAt,
    revision: row.revision,
  };
}

function relationText(subject: string, relation: RelationKindValue, object: string): string {
  return `${subject} ${relation.replaceAll("_", " ")} ${object}.`;
}

export function createRelation(deps: ServiceDeps, input: RelationInput, ctx: ActorCtx) {
  RelationKind.parse(input.relation);
  const subject = input.subject.trim();
  const object = input.object.trim();
  if (!subject || !object) throw new ApiError(400, "invalid_relation", "Relation subject and object are required.");
  const created = createRecord(deps, {
    projectId: input.projectId,
    sourceExcerptId: input.sourceExcerptId,
    recordType: "fact",
    subject,
    predicate: input.relation,
    valueJson: JSON.stringify({ object }),
    text: relationText(subject, input.relation, object),
    evidenceBasis: input.evidenceBasis,
    sourceEventAt: input.eventAt,
    taskStatus: null,
    volatile: false,
  }, ctx);
  const row = deps.db.select().from(records).where(eq(records.id, created.record.id)).get();
  if (!row) throw new ApiError(500, "relation_create_failed", "Created relation was not found after writing.");
  const evidence = loadEvidenceFor(deps.db, [row.id]);
  const relation = relationDto(requireProject(deps, input.projectId).name, row, evidence);
  if (!relation) throw new ApiError(500, "relation_create_failed", "Created record is not a valid relation.");
  return { relation, record: created.record, duplicate: created.duplicate };
}

function matchesQuery(row: RelationRow, object: string, q: string | undefined, direction: RelationDirection): { match: boolean; score: number } {
  if (!q) return { match: true, score: 0 };
  const wanted = [...new Set(tokens(q))];
  if (!wanted.length) return { match: false, score: 0 };
  const relationIntent = inferredRelation(q);
  const subjectTokens = new Set(tokens(row.subject));
  const objectTokens = new Set(tokens(object));
  const textTokens = new Set(tokens(`${row.text} ${row.predicate ?? ""}`));
  const fields = direction === "outgoing"
    ? [subjectTokens]
    : direction === "incoming"
      ? [objectTokens]
      : [subjectTokens, objectTokens, textTokens];
  const matched = wanted.filter((token) => fields.some((field) => field.has(token)));
  if (!matched.length) {
    return relationIntent === row.predicate ? { match: true, score: 4 } : { match: false, score: 0 };
  }
  const exactSubject = direction !== "incoming" && fold(row.subject) === fold(q);
  const exactObject = direction !== "outgoing" && fold(object) === fold(q);
  return { match: true, score: matched.length * 10 + (exactSubject || exactObject ? 25 : 0) };
}

type RelationCandidateSet = { rows: RelationRow[]; evidence: Map<string, EvidenceDto[]> };

function candidatesForScope(
  deps: ServiceDeps,
  input: RelationSearchInput,
  statuses: string[],
): RelationCandidateSet {
  const relationFilter = input.relation ?? inferredRelation(input.q);
  const limit = Math.min(RELATION_LIMIT, Math.max(1, input.limit ?? 10));

  if (input.q) {
    const candidateLimit = Math.min(200, Math.max(60, limit * 10));
    const matches = retrieveRecordMatches(deps.db, {
      q: input.q,
      projectId: input.projectId,
      type: "fact",
      statuses,
      limit: candidateLimit,
    });
    const lexicalRows = matches
      .map((item) => item.row)
      .filter((row) =>
        isRelationKind(row.predicate) &&
        (!relationFilter || row.predicate === relationFilter) &&
        (!input.subject || row.subject === input.subject) &&
        (!input.object || fold(relationObject(row) ?? "") === fold(input.object))
      );

    // A relation-intent query can be useful even when the entity wording has
    // zero lexical overlap. Keep that historic behavior with a bounded SQL
    // candidate window, then merge it with indexed lexical candidates.
    const intentRows = relationFilter
      ? deps.db
          .select()
          .from(records)
          .where(and(
            eq(records.projectId, input.projectId),
            inArray(records.reviewStatus, statuses),
            eq(records.predicate, relationFilter),
            input.subject ? eq(records.subject, input.subject) : undefined,
          ))
          .orderBy(desc(records.recordedAt), desc(records.id))
          .limit(candidateLimit)
          .all()
          .filter((row) => !input.object || fold(relationObject(row) ?? "") === fold(input.object))
      : [];

    const seen = new Set<string>();
    const rows = [...lexicalRows, ...intentRows].filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
    const lexicalEvidence = new Map(matches.map((item) => [item.row.id, item.evidence] as const));
    const missingEvidenceIds = rows.filter((row) => !lexicalEvidence.has(row.id)).map((row) => row.id);
    const extraEvidence = loadEvidenceFor(deps.db, missingEvidenceIds);
    return {
      rows,
      evidence: new Map([...lexicalEvidence, ...extraEvidence]),
    };
  }

  const predicateFilter = relationFilter
    ? eq(records.predicate, relationFilter)
    : inArray(records.predicate, [...relationKinds]);
  const objectFilter = input.object
    ? sql`CASE
        WHEN ${records.valueJson} IS NOT NULL AND json_valid(${records.valueJson}) = 1
        THEN json_extract(${records.valueJson}, '$.object') = ${input.object}
        ELSE 0
      END`
    : undefined;
  const where = and(
    eq(records.projectId, input.projectId),
    inArray(records.reviewStatus, statuses),
    predicateFilter,
    input.subject ? eq(records.subject, input.subject) : undefined,
    objectFilter,
  )!;
  const rows = deps.db
    .select()
    .from(records)
    .where(where)
    .orderBy(desc(records.recordedAt), desc(records.id))
    .limit(limit)
    .all();
  return { rows, evidence: loadEvidenceFor(deps.db, rows.map((row) => row.id)) };
}

function selectRelations(
  projectName: string,
  candidates: RelationCandidateSet,
  input: RelationSearchInput,
): NonNullable<ReturnType<typeof relationDto>>[] {
  const direction = input.direction ?? "both";
  const objectFilter = input.object ? fold(input.object) : null;
  return candidates.rows
    .map((row) => {
      const object = relationObject(row);
      if (!object || (objectFilter !== null && fold(object) !== objectFilter)) return null;
      const query = matchesQuery(row, object, input.q, direction);
      if (!query.match) return null;
      return { dto: relationDto(projectName, row, candidates.evidence), score: query.score, row };
    })
    .filter((item): item is { dto: NonNullable<ReturnType<typeof relationDto>>; score: number; row: RelationRow } => item?.dto !== null && item?.dto !== undefined)
    .sort((a, b) => b.score - a.score || (b.row.sourceEventAt ?? b.row.recordedAt).localeCompare(a.row.sourceEventAt ?? a.row.recordedAt) || a.row.id.localeCompare(b.row.id))
    .slice(0, Math.min(RELATION_LIMIT, Math.max(1, input.limit ?? 10)))
    .map((item) => item.dto);
}

export function searchRelations(deps: ServiceDeps, input: RelationSearchInput) {
  const project = requireProject(deps, input.projectId);
  const scope = input.scope ?? "canonical";
  const canonicalStatuses = input.includeHistorical ? ["accepted", "superseded"] : ["accepted"];
  const canonical = scope === "working"
    ? []
    : selectRelations(project.name, candidatesForScope(deps, input, canonicalStatuses), input);
  const working = scope === "canonical"
    ? []
    : selectRelations(project.name, candidatesForScope(deps, input, ["proposed"]), input);
  return {
    projectId: input.projectId,
    query: input.q?.trim() || null,
    scope,
    relation: input.relation ?? null,
    direction: input.direction ?? "both",
    includeHistorical: input.includeHistorical === true,
    canonicalRelations: canonical,
    workingRelations: working,
    relations: scope === "canonical" ? canonical : scope === "working" ? working : [...canonical, ...working],
    semantics: {
      canonical: "accepted relation records are truth-bearing; superseded history is opt-in",
      working: "proposed evidence-linked relation records remain separate until review_records accepts them",
      query: "q uses bounded generic token matching over subject/object/text; it never maps a natural-language target",
    },
    limit: Math.min(RELATION_LIMIT, Math.max(1, input.limit ?? 10)),
    generatedAt: nowIso(),
  };
}
