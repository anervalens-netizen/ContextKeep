import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { and, eq, or, sql } from "drizzle-orm";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { records } from "../db/schema.js";
import { escapeLike } from "../lib/like.js";
import { loadEvidenceFor } from "../services/mappers.js";
import { synthesize } from "../services/synthesis.js";
import { search } from "../services/search.js";
import { runContextValueResumeEval, type ResumeQualityReport } from "./context-value-resume.js";
import corpusJson from "./ai-memory-corpus.json" with { type: "json" };
import {
  AI_MEMORY_FIXTURE_RECORDS,
  AI_MEMORY_PROJECT_ID,
  seedAiMemoryFixture,
  type AiMemoryFixtureSummary,
} from "./ai-memory-fixture.js";

export type AiMemoryLanguage = "ro" | "en";
export type AiMemoryAbstentionCheck = "search_empty" | "synthesis_unknown";

export interface AiMemoryEvalCase {
  id: string;
  language: AiMemoryLanguage;
  categories: string[];
  query: string;
  includeHistorical?: boolean;
  targetRecordIds: string[];
  currentRecordIds?: string[];
  forbiddenRecordIds?: string[];
  requiresEvidence?: boolean;
  shouldAbstain?: boolean;
  abstentionCheck?: AiMemoryAbstentionCheck;
}

export const AI_MEMORY_CORPUS = corpusJson as readonly AiMemoryEvalCase[];

export interface AiMemoryCaseResult {
  id: string;
  language: AiMemoryLanguage;
  categories: string[];
  query: string;
  includeHistorical: boolean;
  retrievalScope: "canonical" | "working" | "all";
  targetRecordIds: string[];
  top5RecordIds: string[];
  top10RecordIds: string[];
  recallAt5: number | null;
  recallAt10: number | null;
  currentnessCorrect: boolean | null;
  evidenceCoverage: number | null;
  expectedAbstention: boolean | null;
  observedAbstention: boolean | null;
  synthesisStatus: string | null;
  contextBytes: number;
  retrievalLatencyMs: number;
  toolCallsProxy: number;
}

export interface AiMemoryRate {
  correct: number;
  total: number;
  rate: number | null;
}

export interface AiMemoryScalarMetric {
  numerator: number;
  denominator: number;
  value: number | null;
}

export interface AiMemoryCategoryMetrics {
  caseCount: number;
  recallAt5: AiMemoryScalarMetric;
  recallAt10: AiMemoryScalarMetric;
  currentness: AiMemoryRate;
  evidenceCoverage: AiMemoryScalarMetric;
  abstention: AiMemoryRate;
}

export interface AiMemoryMetrics {
  recallAt5: AiMemoryScalarMetric;
  recallAt10: AiMemoryScalarMetric;
  exactIdentifierRecallAt10: AiMemoryScalarMetric;
  currentness: AiMemoryRate;
  evidenceCoverage: AiMemoryScalarMetric;
  /** Excludes the intentional no-evidence/abstention oracle from the claim-coverage gate. */
  evidenceCoverageEligible: AiMemoryScalarMetric;
  abstention: AiMemoryRate;
  contextBytes: { p50: number; p95: number; max: number; mean: number };
  localLatencyMs: { p50: number; p95: number; max: number; mean: number };
  toolCallsProxy: { total: number; meanPerCase: number; p95PerCase: number; providerCalls: 0 };
}

export interface AiMemoryThresholdEvaluation {
  recallAt10: { actual: number | null; target: number; meets: boolean };
  exactIdentifierRecallAt10: { actual: number | null; target: number; meets: boolean };
  currentness: { actual: number | null; target: number; meets: boolean };
  evidenceCoverageEligible: { actual: number | null; target: number; meets: boolean };
  abstention: { actual: number | null; target: number; meets: boolean };
  localLatencyP95Ms: { actual: number; target: number; meets: boolean };
  meetsAllMeasuredThresholds: boolean;
}

export interface AiMemoryWorkflowReport {
  name: "legacy-canonical" | "ai-first";
  retrievalImplementation: string;
  metrics: AiMemoryMetrics;
  categoryMetrics: Record<string, AiMemoryCategoryMetrics>;
  thresholdEvaluation: AiMemoryThresholdEvaluation;
  cases: AiMemoryCaseResult[];
}

export interface AiMemoryEvalReport {
  schemaVersion: 2;
  evaluation: "A5.2";
  generatedAt: string;
  baseline: true;
  providerCalls: 0;
  retrievalImplementation: string;
  corpus: {
    caseCount: number;
    languageCounts: Record<AiMemoryLanguage, number>;
    categoryCounts: Record<string, number>;
    requiredCategories: string[];
  };
  fixture: AiMemoryFixtureSummary;
  /** A5.1-compatible aliases: the frozen legacy canonical workflow. */
  metrics: AiMemoryMetrics;
  categoryMetrics: Record<string, AiMemoryCategoryMetrics>;
  acceptanceThresholds: {
    recallAt10: number;
    exactIdentifierRecallAt10: number;
    currentness: number;
    evidenceCoverageEligible: number;
    abstention: number;
    localLatencyP95Ms: number;
  };
  thresholdEvaluation: AiMemoryThresholdEvaluation;
  notes: string[];
  cases: AiMemoryCaseResult[];
  legacyBaseline: AiMemoryWorkflowReport;
  aiFirst: AiMemoryWorkflowReport;
  resumeQuality: ResumeQualityReport;
}

const REQUIRED_CATEGORIES = [
  "exact_identifier",
  "paraphrase",
  "ro_en_wording",
  "current_vs_old",
  "working_memory",
  "superseded",
  "missing_info_abstention",
  "blocker_next_action",
  "dependency",
];

const ACCEPTANCE_THRESHOLDS = {
  recallAt10: 0.95,
  exactIdentifierRecallAt10: 1,
  currentness: 0.95,
  evidenceCoverageEligible: 1,
  abstention: 0.95,
  localLatencyP95Ms: 75,
} as const;

const RECORD_IDS = new Set(AI_MEMORY_FIXTURE_RECORDS.map((record) => record.id));

export function validateAiMemoryCorpus(corpus: readonly AiMemoryEvalCase[] = AI_MEMORY_CORPUS): void {
  if (corpus.length < 40) throw new Error(`A5.1 corpus must contain at least 40 cases; found ${corpus.length}.`);
  const seen = new Set<string>();
  for (const testCase of corpus) {
    if (seen.has(testCase.id)) throw new Error(`Duplicate A5.1 case id: ${testCase.id}`);
    seen.add(testCase.id);
    if (!testCase.query.trim()) throw new Error(`A5.1 case ${testCase.id} has an empty query.`);
    if (testCase.targetRecordIds.some((id) => !RECORD_IDS.has(id))) {
      throw new Error(`A5.1 case ${testCase.id} references a record outside the synthetic fixture.`);
    }
    for (const id of [...(testCase.currentRecordIds ?? []), ...(testCase.forbiddenRecordIds ?? [])]) {
      if (!RECORD_IDS.has(id)) throw new Error(`A5.1 case ${testCase.id} references an unknown currentness record.`);
    }
    if (testCase.shouldAbstain && !testCase.abstentionCheck) {
      throw new Error(`A5.1 abstention case ${testCase.id} must declare its check.`);
    }
    if (testCase.abstentionCheck && testCase.shouldAbstain !== true) {
      throw new Error(`A5.1 abstention check ${testCase.id} must expect abstention.`);
    }
  }
  const categories = new Set(corpus.flatMap((testCase) => testCase.categories));
  const missing = REQUIRED_CATEGORIES.filter((category) => !categories.has(category));
  if (missing.length > 0) throw new Error(`A5.1 corpus is missing categories: ${missing.join(", ")}`);
  const languages = new Set(corpus.map((testCase) => testCase.language));
  if (!languages.has("ro") || !languages.has("en")) throw new Error("A5.1 corpus must contain both RO and EN cases.");
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function scalar(values: Array<number | null>): AiMemoryScalarMetric {
  const usable = values.filter((value): value is number => value !== null);
  return {
    numerator: round(usable.reduce((sum, value) => sum + value, 0)),
    denominator: usable.length,
    value: usable.length > 0 ? round(usable.reduce((sum, value) => sum + value, 0) / usable.length) : null,
  };
}

function rate(values: Array<boolean | null>): AiMemoryRate {
  const usable = values.filter((value): value is boolean => value !== null);
  const correct = usable.filter(Boolean).length;
  return { correct, total: usable.length, rate: usable.length > 0 ? round(correct / usable.length) : null };
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1));
  return round(sorted[index] ?? 0, 3);
}

function distribution(values: number[]): { p50: number; p95: number; max: number; mean: number } {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: round(Math.max(...values, 0), 3),
    mean: round(values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1), 3),
  };
}

function idsAtK(ids: string[], k: number): Set<string> {
  return new Set(ids.slice(0, k));
}

function recall(targets: string[], ids: string[], k: number, shouldAbstain: boolean): number | null {
  if (targets.length === 0 || shouldAbstain) return null;
  const found = idsAtK(ids, k);
  return targets.filter((id) => found.has(id)).length / targets.length;
}

function categoryMetrics(results: AiMemoryCaseResult[], category: string): AiMemoryCategoryMetrics {
  const selected = results.filter((result) => result.categories.includes(category));
  return {
    caseCount: selected.length,
    recallAt5: scalar(selected.map((result) => result.recallAt5)),
    recallAt10: scalar(selected.map((result) => result.recallAt10)),
    currentness: rate(selected.map((result) => result.currentnessCorrect)),
    evidenceCoverage: scalar(selected.map((result) => result.evidenceCoverage)),
    abstention: rate(selected.map((result) => result.observedAbstention === null ? null : result.expectedAbstention === result.observedAbstention)),
  };
}

function threshold(actual: number | null, target: number): { actual: number | null; target: number; meets: boolean } {
  return { actual, target, meets: actual !== null && actual >= target };
}

type EvalRecord = { id: string; evidence: Array<{ relation: string }> };
type LegacySynthesis = { status: "known" | "unknown"; claims: number };

/** Frozen A5.1 canonical search, retained only as an honest before comparator. */
function legacyCanonicalRows(
  db: Parameters<typeof loadEvidenceFor>[0],
  args: { q: string; projectId: string; includeHistorical: boolean; limit: number },
): Array<typeof records.$inferSelect> {
  const terms = args.q.trim().split(/\s+/).filter(Boolean);
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"*`;
  const matchExpr = terms.map(quote).join(" ");
  const statuses = args.includeHistorical ? ["accepted", "superseded"] : ["accepted"];
  const filters = [
    sql`ck_records_fts MATCH ${matchExpr}`,
    sql`ck_records_fts.review_status IN (${sql.join(statuses.map((status) => sql`${status}`), sql`, `)})`,
    eq(sql`ck_records_fts.project_id`, args.projectId),
  ];
  const ftsRows = db
    .select({ row: records })
    .from(records)
    .innerJoin(sql`ck_records_fts`, sql`ck_records_fts.record_id = ${records.id}`)
    .where(and(...filters))
    .orderBy(sql`bm25(ck_records_fts)`)
    .limit(args.limit)
    .all();
  if (ftsRows.length > 0) return ftsRows.map((item) => item.row);

  const conditions = terms.map((term) => {
    const pattern = `%${escapeLike(term)}%`;
    return or(sql`${records.text} LIKE ${pattern} ESCAPE '\\'`, sql`${records.subject} LIKE ${pattern} ESCAPE '\\'`);
  });
  return db
    .select()
    .from(records)
    .where(and(eq(records.projectId, args.projectId), sql`${records.reviewStatus} IN (${sql.join(statuses.map((status) => sql`${status}`), sql`, `)})`, ...conditions))
    .orderBy(sql`${records.recordedAt} DESC`)
    .limit(args.limit)
    .all();
}

/** Frozen A5.1 evidence-aware token-OR synthesis, for the before comparator. */
function legacySynthesisRows(
  db: Parameters<typeof loadEvidenceFor>[0],
  args: { q: string; projectId: string; includeHistorical: boolean; limit: number },
): Array<typeof records.$inferSelect> {
  const tokens = args.q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2);
  if (tokens.length === 0) return [];
  const matchExpr = tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" OR ");
  const statuses = args.includeHistorical ? ["accepted", "superseded"] : ["accepted"];
  const ftsRows = db
    .select({ row: records })
    .from(records)
    .innerJoin(sql`ck_records_fts`, sql`ck_records_fts.record_id = ${records.id}`)
    .where(and(
      sql`ck_records_fts MATCH ${matchExpr}`,
      sql`ck_records_fts.review_status IN (${sql.join(statuses.map((status) => sql`${status}`), sql`, `)})`,
      eq(sql`ck_records_fts.project_id`, args.projectId),
    ))
    .orderBy(sql`bm25(ck_records_fts)`)
    .limit(args.limit)
    .all();
  if (ftsRows.length > 0) return ftsRows.map((item) => item.row);

  const conditions = tokens.map((token) => {
    const pattern = `%${escapeLike(token)}%`;
    return or(sql`${records.text} LIKE ${pattern} ESCAPE '\\'`, sql`${records.subject} LIKE ${pattern} ESCAPE '\\'`);
  });
  return db
    .select()
    .from(records)
    .where(and(eq(records.projectId, args.projectId), sql`${records.reviewStatus} IN (${sql.join(statuses.map((status) => sql`${status}`), sql`, `)})`, or(...conditions)))
    .orderBy(sql`${records.recordedAt} DESC`)
    .limit(args.limit)
    .all();
}

function legacySynthesisStatus(
  db: Parameters<typeof loadEvidenceFor>[0],
  args: { q: string; projectId: string; includeHistorical: boolean; limit: number },
): LegacySynthesis {
  const rows = legacySynthesisRows(db, args);
  const evidence = loadEvidenceFor(db, rows.map((row) => row.id));
  const claims = rows.filter((row) => (evidence.get(row.id) ?? []).some((item) => item.relation === "supports")).length;
  return { status: claims > 0 ? "known" : "unknown", claims };
}

function buildCaseResult(
  testCase: AiMemoryEvalCase,
  recordsOut: EvalRecord[],
  synthesisResult: { status: string; claims: number } | null,
  startedAt: number,
  toolCallsProxy: number,
  retrievalScope: "canonical" | "working" | "all",
  contextPayload: unknown,
): AiMemoryCaseResult {
  const top10RecordIds = recordsOut.map((record) => record.id);
  const currentRecordIds = testCase.currentRecordIds ?? [];
  const forbiddenRecordIds = testCase.forbiddenRecordIds ?? [];
  const hasCurrentnessOracle = currentRecordIds.length > 0 || forbiddenRecordIds.length > 0;
  const observedAbstention = testCase.abstentionCheck
    ? testCase.abstentionCheck === "search_empty"
      ? recordsOut.length === 0
      : synthesisResult?.status === "unknown" && synthesisResult.claims === 0
    : null;
  const evidenceTargets = testCase.requiresEvidence ? testCase.targetRecordIds : [];
  const returnedById = new Map(recordsOut.map((record) => [record.id, record]));
  const evidenceCoverage = evidenceTargets.length > 0
    ? evidenceTargets.filter((id) => (returnedById.get(id)?.evidence ?? []).some((item) => item.relation === "supports")).length / evidenceTargets.length
    : null;
  return {
    id: testCase.id,
    language: testCase.language,
    categories: testCase.categories,
    query: testCase.query,
    includeHistorical: testCase.includeHistorical === true,
    retrievalScope,
    targetRecordIds: testCase.targetRecordIds,
    top5RecordIds: top10RecordIds.slice(0, 5),
    top10RecordIds,
    recallAt5: recall(testCase.targetRecordIds, top10RecordIds, 5, testCase.shouldAbstain === true),
    recallAt10: recall(testCase.targetRecordIds, top10RecordIds, 10, testCase.shouldAbstain === true),
    currentnessCorrect: hasCurrentnessOracle
      ? currentRecordIds.every((id) => top10RecordIds.includes(id)) && forbiddenRecordIds.every((id) => !top10RecordIds.includes(id))
      : null,
    evidenceCoverage,
    expectedAbstention: testCase.abstentionCheck ? testCase.shouldAbstain === true : null,
    observedAbstention,
    synthesisStatus: synthesisResult?.status ?? null,
    contextBytes: Buffer.byteLength(JSON.stringify(contextPayload), "utf8"),
    retrievalLatencyMs: round(performance.now() - startedAt, 3),
    toolCallsProxy,
  };
}

function workflowMetrics(results: AiMemoryCaseResult[]): AiMemoryMetrics {
  const toolCalls = results.map((result) => result.toolCallsProxy);
  return {
    recallAt5: scalar(results.map((result) => result.recallAt5)),
    recallAt10: scalar(results.map((result) => result.recallAt10)),
    exactIdentifierRecallAt10: scalar(results.filter((result) => result.categories.includes("exact_identifier")).map((result) => result.recallAt10)),
    currentness: rate(results.map((result) => result.currentnessCorrect)),
    evidenceCoverage: scalar(results.map((result) => result.evidenceCoverage)),
    evidenceCoverageEligible: scalar(results.filter((result) => result.expectedAbstention !== true).map((result) => result.evidenceCoverage)),
    abstention: rate(results.map((result) => result.observedAbstention === null ? null : result.expectedAbstention === result.observedAbstention)),
    contextBytes: distribution(results.map((result) => result.contextBytes)),
    localLatencyMs: distribution(results.map((result) => result.retrievalLatencyMs)),
    toolCallsProxy: {
      total: toolCalls.reduce((sum, value) => sum + value, 0),
      meanPerCase: round(toolCalls.reduce((sum, value) => sum + value, 0) / Math.max(toolCalls.length, 1)),
      p95PerCase: percentile(toolCalls, 0.95),
      providerCalls: 0,
    },
  };
}

function workflowThresholds(metrics: AiMemoryMetrics): AiMemoryThresholdEvaluation {
  const evaluation: AiMemoryThresholdEvaluation = {
    recallAt10: threshold(metrics.recallAt10.value, ACCEPTANCE_THRESHOLDS.recallAt10),
    exactIdentifierRecallAt10: threshold(metrics.exactIdentifierRecallAt10.value, ACCEPTANCE_THRESHOLDS.exactIdentifierRecallAt10),
    currentness: threshold(metrics.currentness.rate, ACCEPTANCE_THRESHOLDS.currentness),
    evidenceCoverageEligible: threshold(metrics.evidenceCoverageEligible.value, ACCEPTANCE_THRESHOLDS.evidenceCoverageEligible),
    abstention: threshold(metrics.abstention.rate, ACCEPTANCE_THRESHOLDS.abstention),
    localLatencyP95Ms: { actual: metrics.localLatencyMs.p95, target: ACCEPTANCE_THRESHOLDS.localLatencyP95Ms, meets: metrics.localLatencyMs.p95 <= ACCEPTANCE_THRESHOLDS.localLatencyP95Ms },
    meetsAllMeasuredThresholds: false,
  };
  evaluation.meetsAllMeasuredThresholds = [
    evaluation.recallAt10.meets,
    evaluation.exactIdentifierRecallAt10.meets,
    evaluation.currentness.meets,
    evaluation.evidenceCoverageEligible.meets,
    evaluation.abstention.meets,
    evaluation.localLatencyP95Ms.meets,
  ].every(Boolean);
  return evaluation;
}

function buildWorkflowReport(
  name: AiMemoryWorkflowReport["name"],
  retrievalImplementation: string,
  results: AiMemoryCaseResult[],
): AiMemoryWorkflowReport {
  const metrics = workflowMetrics(results);
  return {
    name,
    retrievalImplementation,
    metrics,
    categoryMetrics: Object.fromEntries(REQUIRED_CATEGORIES.map((category) => [category, categoryMetrics(results, category)])),
    thresholdEvaluation: workflowThresholds(metrics),
    cases: results,
  };
}

export async function runAiMemoryEval(): Promise<AiMemoryEvalReport> {
  validateAiMemoryCorpus();
  const tempRoot = mkdtempSync(path.join(tmpdir(), "contextkeep-a5-2-"));
  const config = loadConfig(
    {
      NODE_ENV: "test",
      CK_DATA_DIR: tempRoot,
      CK_BACKUP_DIR: path.join(tempRoot, "backups"),
      CK_SESSION_SECRET: "a5-2-synthetic-eval-secret",
      CK_COOKIE_SECURE: "false",
      CK_ADAPTERS: "manual,faketest",
      CK_SYNC_INTERVAL_MINUTES: "0",
      CK_HOUSEKEEPING_INTERVAL_MINUTES: "0",
    },
    {},
  );
  const app = await buildApp({ config, logger: false });

  try {
    const fixture = seedAiMemoryFixture(app.ck.deps);
    // Warm SQLite/FTS5 pages before collecting local latency samples. Both
    // workflows use this one deterministic store and make no provider calls.
    for (const testCase of AI_MEMORY_CORPUS) {
      search(app.ck.deps, {
        q: testCase.query,
        projectId: AI_MEMORY_PROJECT_ID,
        includeHistorical: testCase.includeHistorical === true,
        mode: "canonical",
        limit: 10,
      });
      legacyCanonicalRows(app.ck.deps.db, {
        q: testCase.query,
        projectId: AI_MEMORY_PROJECT_ID,
        includeHistorical: testCase.includeHistorical === true,
        limit: 10,
      });
    }

    const legacyResults: AiMemoryCaseResult[] = [];
    for (const testCase of AI_MEMORY_CORPUS) {
      const startedAt = performance.now();
      const rows = legacyCanonicalRows(app.ck.deps.db, {
        q: testCase.query,
        projectId: AI_MEMORY_PROJECT_ID,
        includeHistorical: testCase.includeHistorical === true,
        limit: 10,
      });
      const evidence = loadEvidenceFor(app.ck.deps.db, rows.map((row) => row.id));
      let synthesisResult: LegacySynthesis | null = null;
      let toolCallsProxy = 1;
      if (testCase.abstentionCheck === "synthesis_unknown") {
        synthesisResult = legacySynthesisStatus(app.ck.deps.db, {
          q: testCase.query,
          projectId: AI_MEMORY_PROJECT_ID,
          includeHistorical: testCase.includeHistorical === true,
          limit: 10,
        });
        toolCallsProxy += 1;
      }
      legacyResults.push(buildCaseResult(
        testCase,
        rows.map((row) => ({ id: row.id, evidence: evidence.get(row.id) ?? [] })),
        synthesisResult,
        startedAt,
        toolCallsProxy,
        "canonical",
        { scope: "canonical", records: rows, synthesis: synthesisResult },
      ));
    }

    const aiFirstResults: AiMemoryCaseResult[] = [];
    for (const testCase of AI_MEMORY_CORPUS) {
      const startedAt = performance.now();
      // The workflow selects the explicit working scope for working-memory
      // questions; all other cases retain canonical truth as the default.
      const scope: "canonical" | "working" = testCase.categories.includes("working_memory") ? "working" : "canonical";
      const searchResult = search(app.ck.deps, {
        q: testCase.query,
        projectId: AI_MEMORY_PROJECT_ID,
        includeHistorical: testCase.includeHistorical === true,
        mode: "canonical",
        scope,
        limit: 10,
      });
      const selected = scope === "working" ? searchResult.workingRecords : searchResult.records;
      let synthesisResult: ReturnType<typeof synthesize> | null = null;
      let toolCallsProxy = 1;
      if (testCase.abstentionCheck === "synthesis_unknown") {
        synthesisResult = synthesize(app.ck.deps, {
          question: testCase.query,
          projectId: AI_MEMORY_PROJECT_ID,
          includeHistorical: testCase.includeHistorical === true,
          limit: 10,
        });
        toolCallsProxy += 1;
      }
      aiFirstResults.push(buildCaseResult(
        testCase,
        selected.map((record) => ({ id: record.id, evidence: record.evidence })),
        synthesisResult ? { status: synthesisResult.status, claims: synthesisResult.claims.length } : null,
        startedAt,
        toolCallsProxy,
        scope,
        { scope, records: searchResult.records, workingRecords: searchResult.workingRecords, synthesis: synthesisResult },
      ));
    }

    const categoryCounts = Object.fromEntries(
      [...new Set(AI_MEMORY_CORPUS.flatMap((testCase) => testCase.categories))].sort().map((category) => [
        category,
        AI_MEMORY_CORPUS.filter((testCase) => testCase.categories.includes(category)).length,
      ]),
    );
    const languageCounts: Record<AiMemoryLanguage, number> = {
      ro: AI_MEMORY_CORPUS.filter((testCase) => testCase.language === "ro").length,
      en: AI_MEMORY_CORPUS.filter((testCase) => testCase.language === "en").length,
    };
    const legacyBaseline = buildWorkflowReport(
      "legacy-canonical",
      "Frozen A5.1 canonical FTS5/BM25 AND search plus evidence-aware token-OR synthesis",
      legacyResults,
    );
    const aiFirst = buildWorkflowReport(
      "ai-first",
      "Explicit-scope FTS5/BM25 hybrid retrieval with Unicode concepts, exact/phrase/token overlap, currentness/status/evidence ranking and bounded synthesis abstention",
      aiFirstResults,
    );
    const resumeQuality = runContextValueResumeEval();

    return {
      schemaVersion: 2,
      evaluation: "A5.2",
      generatedAt: new Date().toISOString(),
      // Kept true for A5.1 consumers: top-level metrics/cases remain the
      // frozen before comparator. The final workflow is under `aiFirst`.
      baseline: true,
      providerCalls: 0,
      retrievalImplementation: legacyBaseline.retrievalImplementation,
      corpus: { caseCount: AI_MEMORY_CORPUS.length, languageCounts, categoryCounts, requiredCategories: REQUIRED_CATEGORIES },
      fixture,
      metrics: legacyBaseline.metrics,
      categoryMetrics: legacyBaseline.categoryMetrics,
      acceptanceThresholds: { ...ACCEPTANCE_THRESHOLDS },
      thresholdEvaluation: legacyBaseline.thresholdEvaluation,
      notes: [
        "The top-level A5.1-compatible fields are the frozen legacy canonical baseline; compare `legacyBaseline` with `aiFirst` for A5.2 before/after.",
        "Recall@5/10 averages per-case target recall and excludes cases whose oracle expects abstention; the report keeps those cases in abstention metrics.",
        "Currentness requires every expected current record in top-10 and every forbidden old record absent from top-10.",
        "Evidence coverage is the fraction of required target records returned in top-10 with at least one supporting evidence excerpt.",
        "contextBytes is UTF-8 JSON size for the local search records plus optional synthesis payload, before any MCP transport framing.",
        "The legacy comparator intentionally searches canonical memory only; the AI-first workflow selects scope=working for working-memory cases and keeps proposal-only results separate.",
        "The unbacked synthetic row is intentional: search can surface it, while evidence-aware synthesis should abstain.",
        "toolCallsProxy counts direct local search/synthesis service calls per case; it is not a live MCP transcript and providerCalls is zero.",
        "Latency is local wall-clock measurement on the current host and is not a deterministic quality invariant.",
      ],
      cases: legacyResults,
      legacyBaseline,
      aiFirst,
      resumeQuality,
    };
  } finally {
    await app.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
