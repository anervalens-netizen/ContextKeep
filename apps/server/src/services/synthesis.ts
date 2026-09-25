import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  EvidenceDto,
  SynthesisClaimDto,
  SynthesisDto,
  SynthesisInput,
  SynthesisStatus,
} from "@contextkeep/shared";
import type { Db } from "../db/client.js";
import { conflicts, records } from "../db/schema.js";
import { nowIso } from "../lib/time.js";
import { retrieveRecordMatches } from "./search.js";
import { reviewOverdue } from "./memory-freshness.js";
import type { ServiceDeps } from "./import.js";

const SYNTHESIS_DEFAULT_LIMIT = 25;
const SYNTHESIS_MAX_LIMIT = 50;

/**
 * Bounded synthesis (handoff §12 item 14, §13 cases A11 + A12).
 *
 * Semantics (M2.4d cleanup §3 — tightening on top of M2.4d):
 *
 *  - Retrieval is BOUNDED via FTS5 token-OR with bm25 ranking, OR a LIKE
 *    fallback with the same token-OR semantics. No full-table `.all()` +
 *    JS filter on every query.
 *
 *  - Token-OR semantics in both paths: a multi-word query matches a record
 *    when ANY of its tokens matches.
 *
 *  - Unicode-aware tokenisation (\p{L}\p{N}).
 *
 *  - `disputed` is RELEVANT to the query: an ACTIVE dispute (unresolved
 *    conflict whose member record ids include ≥2 of the matched records)
 *    signals disputed. The conflict query is BOUNDED via json_each — we do
 *    NOT load every unresolved conflict in the table and filter in JS.
 *
 *  - Confirmed supersessions are NOT disputes — they are RESOLUTIONS of the
 *    historical record. An owner-confirmed supersession means the owner
 *    reviewed and accepted the replacement; that is exactly the opposite of
 *    "disputed". The previous (M2.4d) check that treated a confirmed
 *    supersession with different text as disputed is REMOVED. (A proposed
 *    supersession where the replacement record is still 'proposed' never
 *    has both sides in the matched set because proposed records are
 *    excluded from retrieval — so no further check is needed.)
 *
 *  - `stale` only when a matched volatile claim is past its review window.
 *
 *  - `known` requires each material claim to have ≥1 linked evidence row
 *    with `relation="supports"`. Contradicts-only evidence is NOT
 *    sufficient: a matched record whose only evidence rows have
 *    `relation="contradicts"` produces no claim and therefore cannot
 *    alone drive `known`. (Contradicts rows may still be ATTACHED to
    the claim payload for transparency — the existence of supports rows
    is what gates the claim.)
 *
 *  - Provider-independent: no provider calls, no network.
 */
export function synthesize(deps: ServiceDeps, input: SynthesisInput): SynthesisDto {
  const { db } = deps;
  const { question, projectId, includeHistorical, limit } = input;
  const cap = Math.max(1, Math.min(SYNTHESIS_MAX_LIMIT, limit ?? SYNTHESIS_DEFAULT_LIMIT));
  const now = nowIso();
  const q = (question ?? "").trim();

  // (1) Bounded retrieval.
  const matches = q
    ? retrieveRecordMatches(db, {
        q,
        projectId: projectId ?? null,
        statuses: includeHistorical === true ? ["accepted", "superseded"] : ["accepted"],
        limit: cap,
        synthesisThreshold: true,
      })
    : [];
  const matched = matches.map((match) => match.row);
  if (matched.length === 0) {
    return {
      question,
      status: "unknown",
      claims: [],
      contradictions: [],
      generatedAt: now,
    };
  }

  // (2) Build claims; require real supporting evidence on each matched row.
  //     A claim is only surfaced if it has ≥1 evidence row linked with
  //     relation="supports". A matched record with zero supporting evidence
  //     produces no claim and therefore cannot alone drive `known`. Contradicts
  //     evidence rows, if present, are still ATTACHED to the claim payload
  //     for transparency — but their presence does NOT satisfy the
  //     "supports" requirement.
  const matchedIds = matched.map((r) => r.id);
  const evidenceByRecord = new Map(matches.map((match) => [match.row.id, match.evidence]));
  const claims: SynthesisClaimDto[] = [];
  for (const row of matched) {
    const evidence = evidenceByRecord.get(row.id);
    if (!evidence || evidence.length === 0) continue;
    const hasSupports = evidence.some((e) => e.relation === "supports");
    if (!hasSupports) continue;
    const volatile = row.volatile === 1;
    const reviewDueAt = row.reviewDueAt;
    const isStale = reviewOverdue(row, now);
    claims.push({
      recordId: row.id,
      text: row.text,
      reviewStatus: row.reviewStatus as "accepted" | "superseded",
      volatile,
      reviewDueAt,
      isStale,
      evidence: evidence as EvidenceDto[],
    });
  }
  if (claims.length === 0) {
    // Every matched row had no supporting evidence → no claim → unknown.
    return {
      question,
      status: "unknown",
      claims: [],
      contradictions: [],
      generatedAt: now,
    };
  }

  // (3) Stale: any matched volatile claim past its review window (A11).
  const hasStale = claims.some((c) => c.isStale);

  // (4) Disputed: ACTIVE dispute scoped to the matched set. Confirmed
  //     supersessions are resolutions, NOT disputes — they do NOT trigger
  //     disputed. The check is bounded: we query only conflicts whose
  //     record_ids_json contains at least one matched record id (via
  //     json_each). We never load every unresolved conflict in the table.
  const matchedIdSet = new Set(matchedIds);
  const contradictions: SynthesisDto["contradictions"] = [];
  let hasDisputed = false;

  if (matchedIds.length > 0) {
    const matchedIdsForJson = sql.join(
      matchedIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const openConflicts = db
      .select({
        id: conflicts.id,
        recordIdsJson: conflicts.recordIdsJson,
      })
      .from(conflicts)
      .where(
        and(
          eq(conflicts.status, "unresolved"),
          sql`EXISTS (SELECT 1 FROM json_each(${conflicts.recordIdsJson}) AS je WHERE je.value IN (${matchedIdsForJson}))`,
        ),
      )
      .all();
    for (const c of openConflicts) {
      let ids: string[] = [];
      try {
        const parsed = JSON.parse(c.recordIdsJson) as unknown;
        if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === "string");
      } catch {
        continue;
      }
      const overlap = ids.filter((id) => matchedIdSet.has(id));
      if (overlap.length < 2) continue;
      hasDisputed = true;
      const [recordIdA, recordIdB] = overlap as [string, string, ...string[]];
      const aRow = matched.find((r) => r.id === recordIdA);
      const bRow = matched.find((r) => r.id === recordIdB);
      contradictions.push({
        recordIdA,
        recordIdB,
        subject: aRow?.subject ?? "",
        predicate: aRow?.predicate ?? null,
      });
    }
  }

  const status: SynthesisStatus = hasStale
    ? "stale"
    : hasDisputed
      ? "disputed"
      : "known";

  return {
    question,
    status,
    claims,
    contradictions,
    generatedAt: now,
  };
}
