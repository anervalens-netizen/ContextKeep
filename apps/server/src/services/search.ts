import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { SearchTemporalDto, EvidenceDto, RecordDto, SearchMatch, SearchMode, SearchResultDto, SearchScope } from "@contextkeep/shared";
import type { Db } from "../db/client.js";
import { projects, recordEvidence, records, sourceExcerpts, sources } from "../db/schema.js";
import { escapeLike } from "../lib/like.js";
import { attachProjectNames, loadEvidenceFor, toProjectDto, toSourceDto } from "./mappers.js";
import type { ServiceDeps } from "./import.js";
import { ApiError } from "../lib/errors.js";
import { requireTaskScope } from "./task-scope.js";
import { sourceBelongsToProject, sourceProjectScope } from "./source-membership.js";
import { parseWorkingCheckpoint } from "./checkpoint.js";
import { foldMemoryText } from "./memory-freshness.js";
import { compareInstants } from "./instant.js";
import { searchTemporal } from "./search-time.js";
import { taskSearchStates } from "./task-search-state.js";

const MIN_TOKEN_LENGTH = 2;
const MAX_CANDIDATES = 200;

/** Common RO/EN function words. Domain words remain searchable even alone. */
const STOPWORDS = new Set([
  "a", "ai", "al", "ale", "and", "are", "as", "at", "be", "before", "by", "care", "ce", "cu", "cum", "de", "din",
  "does", "este", "for", "from", "has", "have", "how", "in", "is", "it", "la", "mai", "meu", "my", "of", "on",
  "or", "pentru", "se", "si", "sunt", "the", "this", "to", "ul", "ului", "un", "una", "unde", "what", "which", "who", "with",
]);

/**
 * Small, documented operational vocabulary. These are concepts, not record
 * identifiers: the same normalization applies to every project and language.
 */
const CONCEPT_ALIASES: Record<string, string> = {
  actual: "current", acum: "current", active: "current", currently: "current", curent: "current", curenta: "current",
  curentă: "current", deployed: "current", live: "current", latest: "current", now: "current", running: "current",
  foloseste: "current", folosește: "current", ruleaza: "current", rulează: "current",
  istoric: "historical", anterior: "historical", anteriorul: "historical", inainte: "historical", previously: "historical",
  actuala: "current", prezent: "current", momentan: "current",
  anterioara: "historical", anterioare: "historical", trecut: "historical",
  old: "historical", previous: "historical", prior: "historical", historical: "historical", former: "historical", historically: "historical",
  vechi: "historical", veche: "historical", vechiul: "historical", istorica: "historical", istorică: "historical",
  commit: "revision", commits: "revision", revizie: "revision", revizia: "revision", revision: "revision", sha: "revision",
  database: "database", databases: "database", db: "database", sqlite: "database", sqlite3: "database", store: "database",
  magazie: "database", magazia: "database", baza: "database", bazei: "database",
  cale: "path", calea: "path", locatie: "path", locație: "path", location: "path", path: "path", unde: "path",
  deploy: "deployment", deployment: "deployment", deployments: "deployment", livrare: "deployment",
  service: "service", serviciu: "service", serviciul: "service", servicii: "service",
  healthy: "healthy", health: "healthy", sanatos: "healthy", sănătos: "healthy", sănătoasă: "healthy",
  check: "verification", checks: "verification", verify: "verification", verification: "verification", verificare: "verification",
  verificarea: "verification", verificăm: "verification", verificam: "verification", test: "verification", tested: "verification",
  next: "next", urmator: "next", următoare: "next", urmatoarea: "next", următor: "next", următoarea: "next", pas: "next", pasul: "next",
  action: "action", actiune: "action", acțiune: "action", acțiunea: "action",
  startup: "startup", start: "startup", pornire: "startup", pornirea: "startup", pornit: "startup",
  agent: "agent", agentului: "agent", context: "context", contextul: "context", working: "working", lucru: "working",
  memory: "working", memoria: "working", blocker: "blocker", blocaj: "blocker", blocată: "blocker", blocata: "blocker",
  owner: "owner", proprietar: "owner", proprietarul: "owner", gateway: "gateway", port: "port", ports: "port",
  release: "release", production: "production", project: "project", proiect: "project", proiectul: "project", proiectului: "project", proiectelor: "project", evidence: "evidence", dovada: "evidence",
  backup: "backup", backupul: "backup", nas: "nas", candidate: "candidate", candidatei: "candidate", runtime: "runtime",
  dependency: "dependency", depends: "dependency", depinde: "dependency", dependență: "dependency", dependenta: "dependency",
};

/** Concepts that are too broad to establish a synthesis answer by themselves. */
const BROAD_SYNTHESIS_CONCEPTS = new Set([
  "agent", "backup", "blocker", "context", "current", "data", "deployment", "evidence", "gateway", "memory", "owner", "path",
  "project", "release", "service", "working",
]);

type RecordRow = typeof records.$inferSelect;

interface RecordFilters {
  taskId?: string;
  sourceId?: string;
  recordedFrom?: string;
  recordedTo?: string;
}

/** Validated date-only bounds; SQLite date() compares UTC calendar days. */
function recordFilterConditions(args: RecordFilters) {
  return [
    args.taskId ? sql`(${records.id} = ${args.taskId} OR EXISTS (
      SELECT 1 FROM workflow_task_records link
      WHERE link.task_id = ${args.taskId} AND link.record_id = ${records.id}
    ))` : undefined,
    args.sourceId ? sql`EXISTS (
      SELECT 1 FROM record_evidence re JOIN source_excerpts se ON se.id = re.excerpt_id
      WHERE re.record_id = ${records.id} AND se.source_id = ${args.sourceId}
    )` : undefined,
    args.recordedFrom ? sql`date(${records.recordedAt}) >= ${args.recordedFrom}` : undefined,
    args.recordedTo ? sql`date(${records.recordedAt}) <= ${args.recordedTo}` : undefined,
  ];
}

export interface RetrievedRecordMatch {
  row: RecordRow;
  temporal: SearchTemporalDto;
  bm25: number;
  score: number;
  matchedConcepts: string[];
  matchedConceptCount: number;
  matchedTokenCount: number;
  exactIdentifier: boolean;
  phraseMatch: boolean;
  /** FTS5 matched only through stemming/prefix semantics; JS concepts had no exact overlap. */
  ftsOnlyMatch: boolean;
  evidence: EvidenceDto[];
}

export interface SearchProfile {
  rawTokens: string[];
  tokens: string[];
  concepts: string[];
  identifiers: string[];
  normalizedQuery: string;
  currentIntent: boolean;
  historicalIntent: boolean;
}

const fold = foldMemoryText;

export function tokenizeSearch(value: string): string[] {
  return fold(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH);
}

function operationalIdentifiers(query: string): string[] {
  const patterns = [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
    /\b(?=[0-9a-f]{7,64}\b)(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,64}\b/giu,
    /\/[\p{L}\p{N}._/-]{5,}/gu,
    /\b(?=[\p{L}\p{N}._:-]{6,}\b)(?=[\p{L}\p{N}._:-]*\p{L})(?=[\p{L}\p{N}._:-]*\d)[\p{L}\p{N}._:-]{6,}\b/gu,
    /\b(?:pr|issue|run)[-_:#]?\d+\b/giu,
  ];
  const found = patterns.flatMap((pattern) => query.match(pattern) ?? []).map(fold);
  return [...new Set(found)];
}

export function buildSearchProfile(query: string): SearchProfile {
  const rawTokens = tokenizeSearch(query);
  // Romanian "ai" remains a stopword in normal sentences, while an explicit
  // standalone/uppercase AI query is preserved as a domain term.
  const preserveAi = query.trim().toLowerCase() === "ai" || /(?:^|[^\p{L}\p{N}])AI(?:$|[^\p{L}\p{N}])/u.test(query);
  const tokens = rawTokens.filter((token) => !STOPWORDS.has(token) || (token === "ai" && preserveAi));
  const concepts = [...new Set(tokens.map((token) => CONCEPT_ALIASES[token] ?? token))];
  const pastQuestion = /\b(?:(?:what|which|where) (?:was|were)|(?:ce|care|unde) (?:era|erau|rula|rulau|a fost))\b/u.test(fold(query));
  // "what was deployed" remains historical, even when "deployed" maps to
  // the current-state concept. A second explicit present-tense clause is mixed.
  const presentQuestion = /\b(?:(?:what|which|where) (?:is|are)|(?:ce|care|unde) (?:este|sunt)|now|acum|momentan)\b/u.test(fold(query));
  return {
    rawTokens,
    tokens,
    concepts,
    identifiers: operationalIdentifiers(query),
    normalizedQuery: tokens.join(" "),
    // One question can explicitly request previous and current state.
    currentIntent: concepts.includes("current") && (!pastQuestion || presentQuestion),
    historicalIntent: concepts.includes("historical") || pastQuestion,
  };
}

function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"*`;
}

export function buildFtsMatchExpr(profile: SearchProfile, match: SearchMatch): string {
  if (match === "phrase") return `"${profile.rawTokens.join(" ").replace(/"/g, '""')}"`;
  return [...new Set([...profile.tokens, ...profile.concepts])].map(quoteFtsToken).join(" OR ");
}

function checkpointSearchText(value: unknown): string {
  const checkpoint = parseWorkingCheckpoint(value);
  if (!checkpoint) return "";
  return [
    checkpoint.summary ?? "",
    checkpoint.outcome ?? "",
    checkpoint.nextAction ?? "",
    ...checkpoint.blockers,
    ...checkpoint.artifactRefs,
  ].join(" ");
}

function rowSearchText(row: RecordRow): string {
  return `${row.subject} ${row.predicate ?? ""} ${row.text} ${checkpointSearchText(row.valueJson)}`;
}

function normalizedHaystack(row: RecordRow): string {
  return fold(rowSearchText(row)).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function conceptsForRow(row: RecordRow): Set<string> {
  return new Set(tokenizeSearch(rowSearchText(row)).map((token) => CONCEPT_ALIASES[token] ?? token));
}

function isPhraseMatch(row: RecordRow, profile: SearchProfile): boolean {
  if (profile.rawTokens.length === 0) return false;
  return normalizedHaystack(row).includes(profile.rawTokens.join(" "));
}

function isExactIdentifierMatch(row: RecordRow, profile: SearchProfile): boolean {
  if (profile.identifiers.length === 0) return false;
  // A token embedded inside a record UUID is not an exact record identity.
  // Full record ID equality and textual identifier mentions remain eligible.
  const haystack = fold(rowSearchText(row));
  const recordId = fold(row.id);
  const isIdentifierPart = (char: string | undefined) =>
    char !== undefined && /[\p{L}\p{N}_-]/u.test(char);
  const joinsIdentifier = (text: string, index: number, direction: -1 | 1) =>
    isIdentifierPart(text[index]) ||
    (text[index] === "." && isIdentifierPart(text[index + direction]));
  const containsWholeIdentifier = (text: string, token: string) => {
    for (let offset = text.indexOf(token); offset >= 0; offset = text.indexOf(token, offset + 1)) {
      if (!joinsIdentifier(text, offset - 1, -1) &&
          !joinsIdentifier(text, offset + token.length, 1)) return true;
    }
    return false;
  };
  return profile.identifiers.some((identifier) =>
    identifier === recordId || containsWholeIdentifier(haystack, identifier));
}

function searchScore(
  row: RecordRow,
  bm25: number,
  profile: SearchProfile,
  supportCount: number,
  ftsHit: boolean,
  nowIso: string,
  temporalRanking: boolean,
): Omit<RetrievedRecordMatch, "row" | "evidence"> {
  const temporal = searchTemporal(row, nowIso);
  const rawRowTokens = new Set(tokenizeSearch(rowSearchText(row)));
  const rowConcepts = conceptsForRow(row);
  const matchedTokens = profile.tokens.filter((token) => rawRowTokens.has(token));
  const matchedConcepts = profile.concepts.filter((concept) => rowConcepts.has(concept));
  // FTS5 porter stemming can match e.g. "using" to "uses" even though the
  // JS token sets differ. Preserve that fact explicitly instead of pretending
  // the first query concept matched; that old shortcut could turn an unrelated
  // stem hit into a false semantic claim.
  const ftsOnlyMatch = ftsHit && matchedConcepts.length === 0 && profile.concepts.length > 0;
  const phraseMatch = isPhraseMatch(row, profile);
  const exactIdentifier = isExactIdentifierMatch(row, profile);
  const subjectConcepts = new Set(tokenizeSearch(`${row.subject} ${row.predicate ?? ""}`).map((token) => CONCEPT_ALIASES[token] ?? token));
  let score = matchedConcepts.length * 18 + matchedTokens.length * 4;
  score += matchedConcepts.filter((concept) => subjectConcepts.has(concept)).length * 7;
  score += supportCount * 1.5;
  // Current-intent ties compare event time before the BM25 tie-breaker.
  // Tiny lexical-frequency differences must not undo temporal ordering.
  if (!temporalRanking || !profile.currentIntent || profile.historicalIntent) score += Math.max(0, -bm25) * 2;
  if (phraseMatch) score += 60;
  if (exactIdentifier) score += 1_000;

  if (profile.currentIntent && (!temporalRanking || !profile.historicalIntent)) {
    if (temporalRanking) score += temporal.currentAdjustment;
    score += row.reviewStatus === "accepted" ? 20 : -35;
    if (rowConcepts.has("current") || row.volatile === 1) score += 12;
  }
  if (profile.historicalIntent) {
    score += row.reviewStatus === "superseded" ? 25 : 0;
    if (rowConcepts.has("historical")) score += 12;
  }

  const distinctMatchedConcepts = [...new Set(matchedConcepts)];
  return {
    temporal,
    bm25,
    score,
    matchedConcepts: distinctMatchedConcepts,
    matchedConceptCount: distinctMatchedConcepts.length,
    matchedTokenCount: matchedTokens.length,
    exactIdentifier,
    phraseMatch,
    ftsOnlyMatch,
  };
}

function isSearchMatch(match: RetrievedRecordMatch, profile: SearchProfile, mode: SearchMatch, exactIdQuery = false): boolean {
  if (mode === "phrase") return match.phraseMatch ||
    (exactIdQuery && profile.identifiers.includes(match.row.id));
  if (match.exactIdentifier || match.matchedConceptCount >= 2 || match.ftsOnlyMatch) return true;
  // A one-word lookup such as a service name or project alias is useful. For
  // multi-word questions, one broad overlap ("project", "owner", etc.) is
  // noise; one rare operational concept may still be a valid token-OR hit.
  return match.matchedConceptCount === 1 &&
    (profile.concepts.length <= 1 || !BROAD_SYNTHESIS_CONCEPTS.has(match.matchedConcepts[0] ?? ""));
}

/**
 * Synthesis needs a higher bar than interactive search. A single broad word
 * such as "project" or "owner" is not enough to claim that an answer exists;
 * an exact identifier, phrase, two concepts, or one rare non-broad concept is.
 */
export function isMeaningfulSynthesisMatch(
  match: RetrievedRecordMatch,
  allMatches: RetrievedRecordMatch[],
  profile: SearchProfile,
): boolean {
  if (match.exactIdentifier || match.phraseMatch) return true;
  // A pure FTS stem/prefix hit is useful for a one-concept lookup, but it is
  // too ambiguous to establish a deterministic answer to a multi-concept question.
  if (match.ftsOnlyMatch) return profile.concepts.length === 1;
  if (match.matchedConceptCount >= 2) {
    return match.matchedConceptCount / Math.max(1, profile.concepts.length) >= 0.5;
  }
  if (match.matchedConceptCount !== 1) return false;
  // Preserve the established token-OR synthesis contract for one rare,
  // meaningful lexical hit even inside a multi-term question. Numeric-only
  // coincidences are rejected below, which closes the 2026-style false-positive
  // without discarding useful partial lexical matches such as "production context".
  const matchedConcept = match.matchedConcepts[0];
  const frequency = matchedConcept
    ? allMatches.filter((candidate) => candidate.matchedConcepts.includes(matchedConcept)).length
    : 0;
  return Boolean(
    matchedConcept &&
    !/^\d+(?:[._-]\d+)*$/.test(matchedConcept) &&
    !BROAD_SYNTHESIS_CONCEPTS.has(matchedConcept) &&
    frequency <= 2
  );
}

/**
 * Shared bounded lexical/hybrid retrieval. FTS5/BM25 supplies candidates;
 * deterministic Unicode concepts, phrase/exact signals, status intent and
 * supporting-evidence counts provide the final stable ordering.
 */
export function retrieveRecordMatches(
  db: Db,
  args: RecordFilters & {
    q: string;
    projectId?: string | null;
    type?: string | null;
    basis?: string | null;
    statuses: readonly string[];
    match?: SearchMatch;
    limit: number;
    synthesisThreshold?: boolean;
    hydrateEvidence?: boolean;
    completeness?: { candidateLimitReached: boolean; mayHaveMore: boolean };
    nowIso?: string;
    /** Search opts in; existing synthesis/context callers retain lexical scoring. */
    temporalRanking?: boolean;
  },
): RetrievedRecordMatch[] {
  const profile = buildSearchProfile(args.q);
  const match = args.match ?? "terms";
  if (profile.tokens.length === 0 || (match === "phrase" && profile.rawTokens.length === 0)) return [];

  const statusSql = sql.join(args.statuses.map((status) => sql`${status}`), sql`, `);
  const filters = [
    sql`ck_records_fts MATCH ${buildFtsMatchExpr(profile, match)}`,
    sql`ck_records_fts.review_status IN (${statusSql})`,
  ];
  if (args.projectId) filters.push(sql`ck_records_fts.project_id = ${args.projectId}`);
  if (args.type) filters.push(sql`ck_records_fts.type = ${args.type}`);
  if (args.basis) filters.push(sql`ck_records_fts.basis = ${args.basis}`);

  const nowIso = args.nowIso ?? new Date().toISOString();
  const temporalRanking = args.temporalRanking === true;
  const current = temporalRanking && profile.currentIntent && !profile.historicalIntent;
  // Historical temporal selection has no purpose when superseded records
  // cannot be returned; unsaturated lexical results already cover all hits.
  const temporalIntent = temporalRanking &&
    (current || (profile.historicalIntent && args.statuses.includes("superseded")));
  const budget = Math.min(MAX_CANDIDATES, Math.max(args.limit * 8, 40));
  const laneLimit = temporalIntent ? Math.floor(budget / 2) : budget;
  const overscanLimit = temporalIntent
    ? Math.min(MAX_CANDIDATES * 2, Math.max(budget * 2, 256))
    : budget;
  const selectTemporal = <T extends { row: RecordRow }>(pool: T[]): T[] => {
    if (!temporalIntent) return [];
    return pool.map(candidate => ({ candidate, time: current ? searchTemporal(candidate.row, nowIso) : null }))
      .filter(({ candidate, time }) => time ? time.currentAdjustment > 0 : candidate.row.reviewStatus === "superseded")
      .sort((a, b) => current
        ? compareInstants(b.time?.rankTime ?? "", a.time?.rankTime ?? "")
        : a.candidate.row.id.localeCompare(b.candidate.row.id))
      .map(({ candidate }) => candidate)
      .slice(0, laneLimit);
  };
  const identifierOrder = temporalRanking && profile.identifiers.length
    ? sql`CASE WHEN ${or(...profile.identifiers.map((identifier) => eq(records.id, identifier)))} THEN 0 ELSE 1 END`
    : sql`0 + 0`;
  const ftsQuery = (laneFilter?: ReturnType<typeof sql>) => db
    .select({
      row: records,
      bm25: sql<number>`bm25(ck_records_fts)`,
      ftsHit: sql<number>`1`,
      supportCount: sql<number>`(
        SELECT count(*) FROM ${recordEvidence}
        WHERE ${recordEvidence.recordId} = ${records.id}
          AND ${recordEvidence.relation} = 'supports'
      )`,
    })
    .from(records)
    .innerJoin(sql`ck_records_fts`, sql`ck_records_fts.record_id = ${records.id}`)
    .where(and(...filters, ...recordFilterConditions(args), laneFilter));
  const lexical = ftsQuery().orderBy(identifierOrder, sql`bm25(ck_records_fts)`, records.id).limit(overscanLimit).all();
  // When the lexical window fills, let the FTS index supply a second shortlist.
  // SQLite's date comparisons are only selection hints. Strict time, relevance
  // and authority checks still run before results are presented.
  const eventTime = sql`julianday(coalesce(${records.sourceEventAt}, ${records.effectiveFrom}))`;
  const nowTime = sql`julianday(${nowIso})`;
  const extra = !temporalIntent || lexical.length < overscanLimit ? [] : current
    ? ftsQuery(and(
        sql`${records.reviewStatus} <> 'superseded'`,
        sql`${eventTime} <= ${nowTime}`,
        sql`(${records.effectiveFrom} IS NULL OR julianday(${records.effectiveFrom}) <= ${nowTime})`,
        sql`(${records.effectiveTo} IS NULL OR julianday(${records.effectiveTo}) >= ${nowTime})`,
      )).orderBy(desc(eventTime), records.id).limit(laneLimit * 2).all()
    : ftsQuery(sql`ck_records_fts.review_status = 'superseded'`)
        .orderBy(sql`bm25(ck_records_fts)`, records.id).limit(laneLimit * 2).all();
  const temporal = selectTemporal([...new Map(
    [...lexical, ...extra].map(candidate => [candidate.row.id, candidate]),
  ).values()]);
  let saturated = lexical.length >= budget;
  let candidates = [...new Map([...temporal, ...lexical].map((candidate) => [candidate.row.id, candidate])).values()]
    .sort((a, b) => temporalRanking ? Number(isExactIdentifierMatch(b.row, profile)) - Number(isExactIdentifierMatch(a.row, profile)) : 0)
    .slice(0, budget);

  if (candidates.length === 0) {
    const projectFilter = args.projectId ? eq(records.projectId, args.projectId) : undefined;
    const statusFilter = sql`${records.reviewStatus} IN (${statusSql})`;
    const tokens = match === "phrase" ? [profile.rawTokens.join(" ")] : [...new Set([...profile.tokens, ...profile.concepts])];
    const textConditions = tokens.map((token) => {
      const pattern = `%${escapeLike(token)}%`;
      return or(
        sql`${records.text} LIKE ${pattern} ESCAPE '\\'`,
        sql`${records.subject} LIKE ${pattern} ESCAPE '\\'`,
        sql`CASE
          WHEN ${records.valueJson} IS NOT NULL
           AND json_valid(${records.valueJson}) = 1
           AND json_extract(${records.valueJson}, '$.kind') = 'working_checkpoint'
          THEN (
            COALESCE(json_extract(${records.valueJson}, '$.summary'), '') || ' ' ||
            COALESCE(json_extract(${records.valueJson}, '$.outcome'), '') || ' ' ||
            COALESCE(json_extract(${records.valueJson}, '$.nextAction'), '') || ' ' ||
            COALESCE(json_extract(${records.valueJson}, '$.blockers'), '') || ' ' ||
            COALESCE(json_extract(${records.valueJson}, '$.artifactRefs'), '')
          ) LIKE ${pattern} ESCAPE '\\'
          ELSE 0
        END`,
      );
    });
    const fallbackCondition = match === "phrase"
      ? textConditions[0]
      : or(...textConditions, ...(temporalRanking ? profile.identifiers.map((identifier) => eq(records.id, identifier)) : []));
    const fallbackQuery = () => db
      .select({
        row: records,
        bm25: sql<number>`0`,
        ftsHit: sql<number>`0`,
        supportCount: sql<number>`(
          SELECT count(*) FROM ${recordEvidence}
          WHERE ${recordEvidence.recordId} = ${records.id}
            AND ${recordEvidence.relation} = 'supports'
        )`,
      })
      .from(records)
      .where(and(statusFilter, projectFilter, args.type ? eq(records.type, args.type) : undefined, args.basis ? eq(records.evidenceBasis, args.basis) : undefined, ...recordFilterConditions(args), fallbackCondition));
    const lexicalFallback = fallbackQuery().orderBy(identifierOrder, desc(records.recordedAt), records.id).limit(overscanLimit).all();
    const temporalFallback = selectTemporal(lexicalFallback);
    saturated = lexicalFallback.length >= budget;
    candidates = [...new Map([...temporalFallback, ...lexicalFallback].map((candidate) => [candidate.row.id, candidate])).values()]
      .sort((a, b) => temporalRanking ? Number(isExactIdentifierMatch(b.row, profile)) - Number(isExactIdentifierMatch(a.row, profile)) : 0)
      .slice(0, budget);
  }

  const recordIds = profile.identifiers.filter((identifier) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(identifier));
  // Explicit UUID lookups remain recoverable even with match=phrase. A phrase
  // containing additional words must still satisfy ordinary phrase matching.
  const exactIdQuery = recordIds.length === 1 && args.q.trim().toLowerCase() === recordIds[0];
  if (temporalRanking && recordIds.length > 0 && (match !== "phrase" || exactIdQuery)) {
    const exactRows = db.select({ row: records, bm25: sql<number>`0`, ftsHit: sql<number>`0`,
      supportCount: sql<number>`(SELECT count(*) FROM ${recordEvidence} WHERE ${recordEvidence.recordId} = ${records.id} AND ${recordEvidence.relation} = 'supports')`,
    }).from(records).where(and(
      inArray(records.id, recordIds), sql`${records.reviewStatus} IN (${statusSql})`,
      args.projectId ? eq(records.projectId, args.projectId) : undefined,
      args.type ? eq(records.type, args.type) : undefined,
      args.basis ? eq(records.evidenceBasis, args.basis) : undefined,
      ...recordFilterConditions(args),
    )).limit(recordIds.length).all();
    const combined = [...new Map([...exactRows, ...candidates].map((candidate) => [candidate.row.id, candidate])).values()];
    saturated ||= combined.length > budget;
    candidates = combined.sort((a, b) => temporalRanking ? Number(isExactIdentifierMatch(b.row, profile)) - Number(isExactIdentifierMatch(a.row, profile)) : 0)
      .slice(0, budget);
  }

  if (args.completeness) args.completeness.candidateLimitReached = saturated;
  const profileForScoring = profile;
  const scored = candidates
    .map(({ row, bm25, ftsHit, supportCount }) => {
      const details = searchScore(row, bm25, profileForScoring, Number(supportCount), ftsHit === 1, nowIso, temporalRanking);
      return { row, evidence: [] as EvidenceDto[], ...details };
    })
    .filter((candidate) => isSearchMatch(candidate, profileForScoring, match, exactIdQuery))
    .sort((a, b) => {
      const recordIdOrder = temporalRanking
        ? Number(profile.identifiers.includes(b.row.id)) - Number(profile.identifiers.includes(a.row.id))
        : 0;
      const identifierOrder = temporalRanking ? Number(b.exactIdentifier) - Number(a.exactIdentifier) : 0;
      const historyOrder = temporalRanking && profile.historicalIntent
        ? Number(b.row.reviewStatus === "superseded") - Number(a.row.reviewStatus === "superseded")
        : 0;
      // A safe dated current claim precedes lexically stronger uncertain or
      // future claims; exact identifiers still take precedence over timing.
      // Within each eligibility group the existing lexical order is retained.
      const currentTier = (candidate: RetrievedRecordMatch) => {
        if (candidate.row.reviewStatus === "superseded") return 3;
        if (candidate.temporal.currentAdjustment > 0) return 0;
        return candidate.temporal.currentAdjustment < 0 ? 2 : 1;
      };
      const currentOrder = current ? currentTier(a) - currentTier(b) : 0;
      const eventOrder = current ? compareInstants(b.temporal.rankTime ?? "", a.temporal.rankTime ?? "") : 0;
      return recordIdOrder || identifierOrder || historyOrder || currentOrder || b.score - a.score ||
        b.matchedConceptCount - a.matchedConceptCount || eventOrder || a.bm25 - b.bm25 ||
        (current ? 0 : b.row.recordedAt.localeCompare(a.row.recordedAt)) || a.row.id.localeCompare(b.row.id);
    });

  if (args.completeness) args.completeness.mayHaveMore = args.completeness.candidateLimitReached || scored.length > args.limit;
  const selected = args.synthesisThreshold
    ? scored.filter((candidate) => isMeaningfulSynthesisMatch(candidate, scored, profileForScoring)).slice(0, args.limit)
    : scored.slice(0, args.limit);
  if (args.hydrateEvidence === false) return selected;
  const evidence = loadEvidenceFor(db, selected.map((candidate) => candidate.row.id));
  return selected.map((candidate) => ({
    ...candidate,
    evidence: evidence.get(candidate.row.id) ?? [],
  }));
}

type SearchInput = RecordFilters & {
    q: string;
    projectId?: string | null;
    type?: string | null;
    basis?: string | null;
    includeHistorical?: boolean;
    hydrateEvidence?: boolean;
    mode?: SearchMode;
    match?: SearchMatch;
    scope?: SearchScope;
    limit?: number;
  };

export function search(deps: ServiceDeps, input: SearchInput): SearchResultDto {
  if (!input.taskId && !input.sourceId) return searchSnapshot(deps, input);
  return deps.sqlite.transaction(() => {
    const projectId = input.projectId;
    if (!projectId)
      throw new ApiError(400, "search_filter_project_required", "Task and source filters require a projectId.");
    if (input.taskId) requireTaskScope(deps, projectId, input.taskId);
    if (input.sourceId && !sourceBelongsToProject(deps, input.sourceId, projectId))
      throw new ApiError(404, "source_not_found", "Source not found in the requested project.");
    return searchSnapshot(deps, input);
  })();
}

function searchSnapshot(deps: ServiceDeps, input: SearchInput): SearchResultDto {
  const { db } = deps;
  const startedAt = performance.now();
  const nowIso = new Date().toISOString();
  const limit = input.limit ?? 50;
  const includeHistorical = input.includeHistorical ?? false;
  const mode = input.mode ?? "discovery";
  const match = input.match ?? "terms";
  const scope = input.scope ?? "canonical";
  const q = (input.q ?? "").trim();
  const profile = buildSearchProfile(q);
  const recordFilters = {
    type: input.type, taskId: input.taskId, sourceId: input.sourceId,
    recordedFrom: input.recordedFrom, recordedTo: input.recordedTo,
  };
  // Record filters do not imply that a project's metadata or raw source text matches.
  const includeDiscovery = mode === "discovery" && scope !== "working" &&
    !input.type && !input.taskId && !input.sourceId && !input.recordedFrom && !input.recordedTo;

  const canonicalCompleteness = { candidateLimitReached: false, mayHaveMore: false };
  const workingCompleteness = { candidateLimitReached: false, mayHaveMore: false };
  const canonicalMatches = scope === "working" || !q
    ? []
    : retrieveRecordMatches(db, {
        q, nowIso, temporalRanking: true,
        projectId: input.projectId,
        ...recordFilters,
        basis: input.basis,
        statuses: includeHistorical ? ["accepted", "superseded"] : ["accepted"],
        match,
        limit,
        completeness: canonicalCompleteness,
        hydrateEvidence: input.hydrateEvidence,
      });
  const workingMatches = scope === "canonical"
    ? []
    : q
      ? retrieveRecordMatches(db, { q, nowIso, temporalRanking: true, projectId: input.projectId, ...recordFilters, basis: "agent_report", statuses: ["proposed"], match, limit, completeness: workingCompleteness, hydrateEvidence: input.hydrateEvidence })
      : [];
  const recordRows = scope === "working"
    ? []
    : q
      ? canonicalMatches.map((match) => match.row)
      : listOnlyRecords(db, { projectId: input.projectId, ...recordFilters, basis: input.basis, includeHistorical, limit });
  const workingRows = scope === "canonical"
    ? []
    : q
      ? workingMatches.map((match) => match.row)
      : listOnlyWorkingRecords(db, { projectId: input.projectId, ...recordFilters, limit });

  const projectRows = includeDiscovery ? projectRowsForQuery(db, q, limit, input.projectId ?? null) : [];
  const sourcesOut = includeDiscovery ? sourcesForQuery(db, q, 20, input.projectId ?? null) : [];

  const evidenceMap = q
    ? new Map(canonicalMatches.map((item) => [item.row.id, item.evidence] as const))
    : loadEvidenceFor(db, recordRows.map((r) => r.id));
  const workingEvidenceMap = q
    ? new Map(workingMatches.map((item) => [item.row.id, item.evidence] as const))
    : loadEvidenceFor(db, workingRows.map((r) => r.id));
  const recordDtos = attachProjectNames(db, recordRows, evidenceMap);
  const workingRecordDtos = attachProjectNames(db, workingRows, workingEvidenceMap);
  const taskStates = taskSearchStates(deps, [...recordDtos, ...workingRecordDtos]);
  const withTaskState = (record: RecordDto) => {
    const taskState = taskStates.get(record.id);
    const temporal = searchTemporal(record, nowIso);
    return { ...record, temporal, ...(taskState ? { taskState } : {}) };
  };

  return {
    ranking: {
      policy: "bounded-temporal-v1",
      intent: profile.currentIntent && profile.historicalIntent ? "mixed" : profile.historicalIntent ? "historical" : profile.currentIntent ? "current" : "unspecified",
      notes: [
        "Exact record IDs lead. At most 400 lexical and 200 additional FTS temporal candidates are fetched per bucket before scoring at most 200. The additional shortlist runs only when the temporal lexical window fills; LIKE fallback uses lexical overscan only. Saturation means relevant matches can still be omitted.",
        "Historical (including mixed) intent prioritizes matched superseded rows. For current-only queries, eligible dated operational claims precede unknown, invalid/future/expired/review-due, and then superseded claims after exact identifiers. Within a tier lexical score, event/validity time, BM25 and stable identity rank results. For current-only scoring, BM25 is a tie-break only, not a score bonus. Capture recency gives no current bonus.",
        "recordedAt gives capture/import time, sourceEventAt gives event time, effectiveFrom/effectiveTo delimit validity, and reviewedAt gives review time. Missing event time stays null. Temporal eligibility is ranking evidence. Invalid/future events cannot establish currentness. freshness.currentness retains review/conflict warnings. reviewStatus retains authority.",
        "Scope and includeHistorical remain authoritative. Proposed working observations require review. Saturated candidates may omit relevant rows. Narrow project, type or recorded-date filters to recover more.",
      ],
    },
    query: q,
    mode,
    match,
    scope,
    includeHistorical,
    records: recordDtos.map(withTaskState),
    workingRecords: workingRecordDtos.map(withTaskState),
    projects: projectRows,
    sources: sourcesOut,
    completeness: {
      records: { returned: recordDtos.length, limit, ...canonicalCompleteness, mayHaveMore: canonicalCompleteness.mayHaveMore || (!q && recordDtos.length >= limit) },
      workingRecords: { returned: workingRecordDtos.length, limit, ...workingCompleteness, mayHaveMore: workingCompleteness.mayHaveMore || (!q && workingRecordDtos.length >= limit) },
      projects: { returned: projectRows.length, limit, mayHaveMore: projectRows.length >= limit, candidateLimitReached: false },
      sources: { returned: sourcesOut.length, limit: 20, mayHaveMore: sourcesOut.length >= 20, candidateLimitReached: false },
    },
    tookMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
}

function listOnlyRecords(
  db: Db,
  args: RecordFilters & { projectId: string | null | undefined; type: string | null | undefined; basis: string | null | undefined; includeHistorical: boolean; limit: number },
): Array<typeof records.$inferSelect> {
  const allowedStatuses = args.includeHistorical ? ["accepted", "superseded"] : ["accepted"];
  const conds = [
    sql`${records.reviewStatus} IN (${sql.join(allowedStatuses.map((s) => sql`${s}`), sql`, `)})`,
  ];
  if (args.projectId) conds.push(eq(records.projectId, args.projectId));
  if (args.type) conds.push(eq(records.type, args.type));
  if (args.basis) conds.push(eq(records.evidenceBasis, args.basis));
  return db
    .select()
    .from(records)
    .where(and(...conds, ...recordFilterConditions(args)))
    .orderBy(desc(records.recordedAt), records.id)
    .limit(args.limit)
    .all();
}

function listOnlyWorkingRecords(
  db: Db,
  args: RecordFilters & { projectId: string | null | undefined; type?: string | null; limit: number },
): Array<typeof records.$inferSelect> {
  return db
    .select()
    .from(records)
    .where(and(
      eq(records.reviewStatus, "proposed"),
      eq(records.evidenceBasis, "agent_report"),
      args.projectId ? eq(records.projectId, args.projectId) : undefined,
      args.type ? eq(records.type, args.type) : undefined,
      ...recordFilterConditions(args),
    ))
    .orderBy(desc(records.recordedAt), desc(records.id))
    .limit(args.limit)
    .all();
}


function projectRowsForQuery(db: Db, q: string, limit: number, projectId: string | null): ReturnType<typeof toProjectDto>[] {
  if (!q) {
    return db
      .select()
      .from(projects)
      .where(projectId ? eq(projects.id, projectId) : undefined)
      .orderBy(projects.name)
      .limit(limit)
      .all()
      .map(toProjectDto);
  }
  const pattern = `%${escapeLike(q)}%`;
  return db
    .select()
    .from(projects)
    .where(
      and(
        projectId ? eq(projects.id, projectId) : undefined,
        or(
          sql`${projects.name} LIKE ${pattern} ESCAPE '\\'`,
          sql`${projects.aliasesJson} LIKE ${pattern} ESCAPE '\\'`,
          sql`${projects.description} LIKE ${pattern} ESCAPE '\\'`,
        ),
      ),
    )
    .orderBy(projects.name)
    .limit(limit)
    .all()
    .map(toProjectDto);
}

function sourcesForQuery(db: Db, q: string, limit: number, projectId: string | null): SearchResultDto["sources"] {
  if (!q) return [];
  const pattern = `%${escapeLike(q)}%`;
  const sourceRows = db
    .select()
    .from(sources)
    .where(
      and(
        projectId ? sourceProjectScope(projectId) : undefined,
        or(
          sql`${sources.normalizedText} LIKE ${pattern} ESCAPE '\\'`,
          sql`${sources.title} LIKE ${pattern} ESCAPE '\\'`,
        ),
      ),
    )
    .orderBy(sources.id)
    .limit(limit)
    .all();
  const sourceIds = sourceRows.map((s) => s.id);
  const excerptRows = db
    .select()
    .from(sourceExcerpts)
    .where(and(inArray(sourceExcerpts.sourceId, sourceIds), sql`${sourceExcerpts.exactText} LIKE ${pattern} ESCAPE '\\'`))
    .all();
  const excerptCounts = db
    .select({ sourceId: sourceExcerpts.sourceId, n: sql<number>`count(*)` })
    .from(sourceExcerpts)
    .where(inArray(sourceExcerpts.sourceId, sourceIds))
    .groupBy(sourceExcerpts.sourceId)
    .all();
  const counts = new Map(excerptCounts.map((row) => [row.sourceId, Number(row.n)]));
  const matches = new Map<string, SearchResultDto["sources"][number]["matchedExcerpts"]>();
  for (const e of excerptRows) {
    const list = matches.get(e.sourceId) ?? [];
    if (list.length < 5) list.push({
      id: e.id,
      sourceId: e.sourceId,
      startOffset: e.startOffset,
      endOffset: e.endOffset,
      text: e.exactText,
      exactTextHash: e.exactTextHash,
    });
    matches.set(e.sourceId, list);
  }
  return sourceRows.map((s) => ({ source: toSourceDto(s, counts.get(s.id) ?? 0), matchedExcerpts: matches.get(s.id) ?? [] }));
}
