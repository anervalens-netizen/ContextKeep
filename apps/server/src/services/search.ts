import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { EvidenceDto, SearchMatch, SearchMode, SearchResultDto, SearchScope } from "@contextkeep/shared";
import type { Db } from "../db/client.js";
import { projects, recordEvidence, records, sourceExcerpts, sources } from "../db/schema.js";
import { escapeLike } from "../lib/like.js";
import { attachProjectNames, loadEvidenceFor, toProjectDto, toSourceDto } from "./mappers.js";
import type { ServiceDeps } from "./import.js";
import { sourceProjectScope } from "./source-membership.js";
import { parseWorkingCheckpoint } from "./checkpoint.js";
import { foldMemoryText } from "./memory-freshness.js";

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
  old: "historical", previous: "historical", prior: "historical", historical: "historical", former: "historical",
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

export interface RetrievedRecordMatch {
  row: RecordRow;
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
  return {
    rawTokens,
    tokens,
    concepts,
    identifiers: operationalIdentifiers(query),
    normalizedQuery: tokens.join(" "),
    currentIntent: concepts.includes("current"),
    historicalIntent: concepts.includes("historical"),
  };
}

function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"*`;
}

function buildFtsMatchExpr(profile: SearchProfile, match: SearchMatch): string {
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
  const haystack = fold(rowSearchText(row));
  return profile.identifiers.some((identifier) => haystack.includes(identifier));
}

function searchScore(
  row: RecordRow,
  bm25: number,
  profile: SearchProfile,
  supportCount: number,
  ftsHit: boolean,
): Omit<RetrievedRecordMatch, "row" | "evidence"> {
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
  score += Math.max(0, -bm25) * 2;
  if (phraseMatch) score += 60;
  if (exactIdentifier) score += 1_000;

  if (profile.currentIntent) {
    score += row.reviewStatus === "accepted" ? 20 : -35;
    if (rowConcepts.has("current") || row.volatile === 1) score += 12;
  }
  if (profile.historicalIntent) {
    score += row.reviewStatus === "superseded" ? 25 : 0;
    if (rowConcepts.has("historical")) score += 12;
  }

  const distinctMatchedConcepts = [...new Set(matchedConcepts)];
  return {
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

function isSearchMatch(match: RetrievedRecordMatch, profile: SearchProfile, mode: SearchMatch): boolean {
  if (mode === "phrase") return match.phraseMatch;
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
  args: {
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

  let candidates = db
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
    .where(and(...filters))
    .orderBy(sql`bm25(ck_records_fts)`, records.id)
    .limit(Math.min(MAX_CANDIDATES, Math.max(args.limit * 8, 40)))
    .all();

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
      : or(...textConditions);
    candidates = db
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
      .where(and(statusFilter, projectFilter, args.type ? eq(records.type, args.type) : undefined, args.basis ? eq(records.evidenceBasis, args.basis) : undefined, fallbackCondition))
      .orderBy(desc(records.recordedAt), records.id)
      .limit(Math.min(MAX_CANDIDATES, Math.max(args.limit * 8, 40)))
      .all();
  }

  if (args.completeness) args.completeness.candidateLimitReached = candidates.length >= Math.min(MAX_CANDIDATES, Math.max(args.limit * 8, 40));
  const profileForScoring = profile;
  const scored = candidates
    .map(({ row, bm25, ftsHit, supportCount }) => {
      const details = searchScore(row, bm25, profileForScoring, Number(supportCount), ftsHit === 1);
      return { row, evidence: [] as EvidenceDto[], ...details };
    })
    .filter((candidate) => isSearchMatch(candidate, profileForScoring, match))
    .sort((a, b) => b.score - a.score || b.matchedConceptCount - a.matchedConceptCount || a.bm25 - b.bm25 || b.row.recordedAt.localeCompare(a.row.recordedAt) || a.row.id.localeCompare(b.row.id));

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

export function search(
  deps: ServiceDeps,
  input: {
    q: string;
    projectId?: string | null;
    type?: string | null;
    basis?: string | null;
    includeHistorical?: boolean;
    mode?: SearchMode;
    match?: SearchMatch;
    scope?: SearchScope;
    limit?: number;
  },
): SearchResultDto {
  const { db } = deps;
  const startedAt = performance.now();
  const limit = input.limit ?? 50;
  const includeHistorical = input.includeHistorical ?? false;
  const mode = input.mode ?? "discovery";
  const match = input.match ?? "terms";
  const scope = input.scope ?? "canonical";
  const q = (input.q ?? "").trim();

  const canonicalCompleteness = { candidateLimitReached: false, mayHaveMore: false };
  const workingCompleteness = { candidateLimitReached: false, mayHaveMore: false };
  const canonicalMatches = scope === "working" || !q
    ? []
    : retrieveRecordMatches(db, {
        q,
        projectId: input.projectId,
        type: input.type,
        basis: input.basis,
        statuses: includeHistorical ? ["accepted", "superseded"] : ["accepted"],
        match,
        limit,
        completeness: canonicalCompleteness,
      });
  const workingMatches = scope === "canonical"
    ? []
    : q
      ? retrieveRecordMatches(db, { q, projectId: input.projectId, basis: "agent_report", statuses: ["proposed"], match, limit, completeness: workingCompleteness })
      : [];
  const recordRows = scope === "working"
    ? []
    : q
      ? canonicalMatches.map((match) => match.row)
      : listOnlyRecords(db, { projectId: input.projectId, type: input.type, basis: input.basis, includeHistorical, limit });
  const workingRows = scope === "canonical"
    ? []
    : q
      ? workingMatches.map((match) => match.row)
      : listOnlyWorkingRecords(db, { projectId: input.projectId, limit });

  const projectRows = mode === "discovery" && scope !== "working" ? projectRowsForQuery(db, q, limit, input.projectId ?? null) : [];
  const sourcesOut = mode === "discovery" && scope !== "working" ? sourcesForQuery(db, q, 20, input.projectId ?? null) : [];

  const evidenceMap = q
    ? new Map(canonicalMatches.map((item) => [item.row.id, item.evidence] as const))
    : loadEvidenceFor(db, recordRows.map((r) => r.id));
  const workingEvidenceMap = q
    ? new Map(workingMatches.map((item) => [item.row.id, item.evidence] as const))
    : loadEvidenceFor(db, workingRows.map((r) => r.id));
  const recordDtos = attachProjectNames(db, recordRows, evidenceMap);
  const workingRecordDtos = attachProjectNames(db, workingRows, workingEvidenceMap);

  return {
    query: q,
    mode,
    match,
    scope,
    includeHistorical,
    records: recordDtos,
    workingRecords: workingRecordDtos,
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
  args: { projectId: string | null | undefined; type: string | null | undefined; basis: string | null | undefined; includeHistorical: boolean; limit: number },
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
    .where(and(...conds))
    .orderBy(desc(records.recordedAt), records.id)
    .limit(args.limit)
    .all();
}

function listOnlyWorkingRecords(
  db: Db,
  args: { projectId: string | null | undefined; limit: number },
): Array<typeof records.$inferSelect> {
  return db
    .select()
    .from(records)
    .where(and(
      eq(records.reviewStatus, "proposed"),
      eq(records.evidenceBasis, "agent_report"),
      args.projectId ? eq(records.projectId, args.projectId) : undefined,
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
