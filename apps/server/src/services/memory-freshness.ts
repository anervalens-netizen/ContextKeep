import type {
  EvidenceBasis,
  RecordFreshnessDto,
  ReviewStatus,
  TaskStatus,
} from "@contextkeep/shared";

export type FreshnessReason = "review_overdue" | "newer_observation" | "explicit_conflict";

export type FreshnessRelationship = "same_entity" | "possibly_related" | "unrelated";

export type FreshnessRecord = {
  id: string;
  projectId: string | null;
  type: string;
  subject: string;
  predicate: string | null;
  valueJson?: unknown | null;
  text: string;
  reviewStatus: ReviewStatus | string;
  evidenceBasis: EvidenceBasis | string;
  taskStatus: TaskStatus | string | null;
  recordedAt: string;
  sourceEventAt: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  reviewDueAt: string | null;
  volatile: number | boolean;
};

export type FreshnessConflict = {
  recordIds: string[];
};

export interface RecordFreshnessContext {
  nowIso: string;
  /** Preloaded once per result/project; never loaded by the pure classifier. */
  workingRecords?: FreshnessRecord[];
  conflicts?: FreshnessConflict[];
}

type LegacyStateRow = {
  subject: string;
  predicate: string | null;
  text: string;
  volatile: number | boolean;
  reviewDueAt: string | null;
};

const IDENTITY_STOPWORDS = new Set([
  // Romanian + English function words.
  "a", "ai", "al", "ale", "and", "are", "as", "at", "be", "by", "care", "ce", "cu", "de", "din",
  "este", "for", "from", "in", "is", "it", "la", "mai", "of", "on", "or", "pentru", "se", "si", "sunt",
  "the", "this", "to", "un", "una", "with",
  // Generic state vocabulary: useful for weak relatedness, never enough to
  // establish that two claims describe the same entity.
  "active", "activ", "activa", "actual", "current", "curent", "deployment", "fact", "live", "production",
  "productie", "productia", "productiei", "project", "proiect", "release", "report", "raport", "service",
  "serviciu", "serviciul", "servicii", "state", "status", "system", "sistem", "version", "versiune",
  "working", "memory", "memorie",
]);

export function foldMemoryText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

export function memoryTokens(value: string): string[] {
  return foldMemoryText(value).split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2);
}

function normalizeSubject(value: string): string {
  return foldMemoryText(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function identityTokens(value: string): string[] {
  return memoryTokens(value).filter((token) => !IDENTITY_STOPWORDS.has(token));
}

const STATE_DIMENSION_PREFIXES = new Set([
  "current release",
  "current version",
  "deployment status",
  "operational status",
  "production release",
  "production version",
  "release curent",
  "versiune curenta",
  "status operational",
]);

function stateDimensionPrefix(value: string): string | null {
  const tokens = memoryTokens(value).filter((token) => !["a", "an", "de", "este", "is", "the"].includes(token));
  if (tokens.length < 2) return null;
  const prefix = tokens[0] + " " + tokens[1];
  return STATE_DIMENSION_PREFIXES.has(prefix) ? prefix : null;
}

function operationalIdentifiers(value: string): Set<string> {
  const folded = foldMemoryText(value);
  const patterns = [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu,
    /\/[\p{L}\p{N}._/-]{4,}/gu,
    /\b(?=[\p{L}\p{N}._:-]{6,}\b)(?=[\p{L}\p{N}._:-]*\p{L})(?=[\p{L}\p{N}._:-]*\d)[\p{L}\p{N}._:-]{6,}\b/gu,
    /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/gu,
  ];
  return new Set(patterns.flatMap((pattern) => folded.match(pattern) ?? []));
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const item of a) if (b.has(item)) count += 1;
  return count;
}

function predicatesCompatible(
  a: Pick<FreshnessRecord, "predicate">,
  b: Pick<FreshnessRecord, "predicate">,
): boolean {
  return !(a.predicate && b.predicate && foldMemoryText(a.predicate) !== foldMemoryText(b.predicate));
}

/**
 * Cheap entity relationship used only for freshness hints. It deliberately
 * distinguishes a strong identity from weak lexical relatedness: common words
 * such as "serviciu/status/current" can produce "possibly_related" but never a
 * confirmed same-entity match on their own.
 */
export function stateRelationship(
  accepted: Pick<FreshnessRecord, "projectId" | "subject" | "predicate" | "text">,
  working: Pick<FreshnessRecord, "projectId" | "subject" | "predicate" | "text">,
): FreshnessRelationship {
  if (accepted.projectId && working.projectId && accepted.projectId !== working.projectId) return "unrelated";
  if (!predicatesCompatible(accepted, working)) return "unrelated";

  const subjectA = normalizeSubject(accepted.subject);
  const subjectB = normalizeSubject(working.subject);
  if (subjectA && subjectA === subjectB) return "same_entity";

  const dimensionA = stateDimensionPrefix(accepted.text);
  const dimensionB = stateDimensionPrefix(working.text);
  if (dimensionA && dimensionA === dimensionB) return "same_entity";

  const identifiersA = operationalIdentifiers(`${accepted.subject} ${accepted.text}`);
  const identifiersB = operationalIdentifiers(`${working.subject} ${working.text}`);
  if (intersectionSize(identifiersA, identifiersB) > 0) return "same_entity";

  const significantA = new Set(identityTokens(accepted.subject));
  const significantB = new Set(identityTokens(working.subject));
  const significantOverlap = intersectionSize(significantA, significantB);
  const smallerSubject = Math.max(1, Math.min(significantA.size, significantB.size));
  if (significantOverlap >= 2 || (significantOverlap >= 1 && significantOverlap / smallerSubject >= 0.5)) {
    return "same_entity";
  }

  const contentA = new Set(identityTokens(`${accepted.subject} ${accepted.text}`));
  const contentB = new Set(identityTokens(`${working.subject} ${working.text}`));
  const contentOverlap = intersectionSize(contentA, contentB);
  const smallerContent = Math.max(1, Math.min(contentA.size, contentB.size));
  if (contentOverlap >= 3 && contentOverlap / smallerContent >= 0.4) return "same_entity";

  const broadA = new Set(memoryTokens(`${accepted.subject} ${accepted.text}`));
  const broadB = new Set(memoryTokens(`${working.subject} ${working.text}`));
  const broadOverlap = intersectionSize(broadA, broadB);
  if (significantOverlap > 0 || contentOverlap > 0 || broadOverlap >= 2) return "possibly_related";
  return "unrelated";
}

export function stateRelated(
  accepted: Pick<LegacyStateRow, "subject" | "predicate" | "text">,
  working: Pick<LegacyStateRow, "subject" | "predicate" | "text">,
): boolean {
  return stateRelationship(
    { ...accepted, projectId: null },
    { ...working, projectId: null },
  ) === "same_entity";
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isCurrentStateClaim(row: Pick<FreshnessRecord, "type" | "volatile" | "predicate" | "valueJson" | "subject" | "text">): boolean {
  if (row.type !== "fact") return false;
  if (row.volatile === 1 || row.volatile === true) return true;
  const predicate = foldMemoryText(row.predicate ?? "");
  if (["current", "current_state", "operational_state", "status", "version", "release", "deployment"].includes(predicate)) return true;
  const object = parseObject(row.valueJson ?? null);
  if (object && (object.currentState !== undefined || object.operationalState !== undefined)) return true;
  return /\b(current|curent|operational|production|productie|deployed|release|version|versiune|status|ready|active|activ)\b/i
    .test(foldMemoryText(`${row.subject} ${row.text}`));
}

export function reviewOverdue(
  row: Pick<LegacyStateRow, "volatile" | "reviewDueAt">,
  nowIso: string,
): boolean {
  return (row.volatile === 1 || row.volatile === true) && row.reviewDueAt !== null && row.reviewDueAt <= nowIso;
}

function observationTime(row: Pick<FreshnessRecord, "sourceEventAt" | "effectiveFrom" | "recordedAt">): {
  value: string;
  basis: "source_event" | "effective_from" | "capture";
} {
  if (row.sourceEventAt) return { value: row.sourceEventAt, basis: "source_event" };
  if (row.effectiveFrom) return { value: row.effectiveFrom, basis: "effective_from" };
  return { value: row.recordedAt, basis: "capture" };
}

function authorityFor(row: FreshnessRecord): RecordFreshnessDto["authority"] {
  if (row.reviewStatus === "accepted") return "canonical";
  if (row.reviewStatus === "superseded") return "historical";
  if (row.reviewStatus === "rejected") return "rejected";
  if (row.reviewStatus === "proposed" && row.evidenceBasis === "agent_report") return "working";
  if (row.reviewStatus === "proposed") return "unreviewed";
  return "unknown";
}

export function classifyRecordFreshness(
  row: FreshnessRecord,
  context: RecordFreshnessContext,
): RecordFreshnessDto {
  const authority = authorityFor(row);
  const progress = (row.taskStatus ?? null) as RecordFreshnessDto["progress"];
  const provenance = row.evidenceBasis as RecordFreshnessDto["provenance"];
  const reasons: RecordFreshnessDto["reasons"] = [];
  const supportRecordIds: string[] = [];
  const possiblyRelatedRecordIds: string[] = [];

  if (authority === "historical") {
    reasons.push("superseded_history");
    return {
      authority,
      currentness: "historical",
      progress,
      provenance,
      stale: true,
      requiresReview: false,
      reasons,
      supportRecordIds,
      possiblyRelatedRecordIds,
    };
  }
  if (authority === "rejected") {
    return {
      authority,
      currentness: "not_applicable",
      progress,
      provenance,
      stale: false,
      requiresReview: false,
      reasons,
      supportRecordIds,
      possiblyRelatedRecordIds,
    };
  }
  if (authority === "working" || authority === "unreviewed") {
    reasons.push("unreviewed_proposal");
    return {
      authority,
      currentness: "unknown",
      progress,
      provenance,
      stale: false,
      requiresReview: true,
      reasons,
      supportRecordIds,
      possiblyRelatedRecordIds,
    };
  }

  if (row.effectiveFrom && row.effectiveFrom > context.nowIso) {
    reasons.push("effective_not_started");
    return {
      authority,
      currentness: "future_effective",
      progress,
      provenance,
      stale: false,
      requiresReview: false,
      reasons,
      supportRecordIds,
      possiblyRelatedRecordIds,
    };
  }
  if (row.effectiveTo && row.effectiveTo <= context.nowIso) {
    reasons.push("effective_ended");
    return {
      authority,
      currentness: "expired",
      progress,
      provenance,
      stale: true,
      requiresReview: false,
      reasons,
      supportRecordIds,
      possiblyRelatedRecordIds,
    };
  }

  for (const conflict of context.conflicts ?? []) {
    if (!conflict.recordIds.includes(row.id)) continue;
    reasons.push("explicit_conflict");
    for (const id of conflict.recordIds) {
      if (id !== row.id && !supportRecordIds.includes(id)) supportRecordIds.push(id);
    }
  }
  if (reasons.includes("explicit_conflict")) {
    return {
      authority,
      currentness: "conflicted",
      progress,
      provenance,
      stale: true,
      requiresReview: true,
      reasons,
      supportRecordIds,
      possiblyRelatedRecordIds,
    };
  }

  if (authority === "canonical" && isCurrentStateClaim(row)) {
    const acceptedTime = observationTime(row);
    for (const working of context.workingRecords ?? []) {
      if (
        working.reviewStatus !== "proposed" ||
        working.evidenceBasis !== "agent_report" ||
        working.type !== "fact" ||
        !isCurrentStateClaim(working) ||
        (row.projectId && working.projectId !== row.projectId)
      ) {
        continue;
      }
      const workingTime = observationTime(working);
      if (workingTime.value <= acceptedTime.value) continue;
      const relationship = stateRelationship(row, working);
      if (relationship === "same_entity") {
        // A capture timestamp says when ContextKeep saw a claim, not when the
        // underlying state became true. Without structured source/effective
        // time on both sides, treat recency as verification evidence only.
        if (workingTime.basis === "capture") {
          if (!possiblyRelatedRecordIds.includes(working.id)) possiblyRelatedRecordIds.push(working.id);
        } else if (!supportRecordIds.includes(working.id)) {
          supportRecordIds.push(working.id);
        }
      } else if (relationship === "possibly_related") {
        if (!possiblyRelatedRecordIds.includes(working.id)) possiblyRelatedRecordIds.push(working.id);
      }
    }

    if (supportRecordIds.length > 0) {
      reasons.push("newer_observation");
      return {
        authority,
        currentness: "needs_verification",
        progress,
        provenance,
        stale: true,
        requiresReview: true,
        reasons,
        supportRecordIds,
        possiblyRelatedRecordIds,
      };
    }
    if (possiblyRelatedRecordIds.length > 0) {
      reasons.push("possibly_newer_observation");
      return {
        authority,
        currentness: "needs_verification",
        progress,
        provenance,
        // Weak lexical relatedness is a prompt to verify, not evidence that
        // the accepted record is already stale.
        stale: false,
        requiresReview: true,
        reasons,
        supportRecordIds,
        possiblyRelatedRecordIds,
      };
    }
  }

  if (reviewOverdue(row, context.nowIso)) {
    reasons.push("review_overdue");
    return {
      authority,
      currentness: "review_due",
      progress,
      provenance,
      stale: true,
      requiresReview: true,
      reasons,
      supportRecordIds,
      possiblyRelatedRecordIds,
    };
  }

  if (authority === "canonical" && isCurrentStateClaim(row)) {
    if (!row.sourceEventAt && !row.effectiveFrom) {
      reasons.push("observation_time_unknown");
      return {
        authority,
        currentness: "unknown",
        progress,
        provenance,
        stale: false,
        requiresReview: false,
        reasons,
        supportRecordIds,
        possiblyRelatedRecordIds,
      };
    }
    return {
      authority,
      currentness: "current",
      progress,
      provenance,
      stale: false,
      requiresReview: false,
      reasons,
      supportRecordIds,
      possiblyRelatedRecordIds,
    };
  }

  return {
    authority,
    currentness: "not_applicable",
    progress,
    provenance,
    stale: false,
    requiresReview: false,
    reasons,
    supportRecordIds,
    possiblyRelatedRecordIds,
  };
}

/** Legacy compatibility helper retained for callers/tests that only need 3 booleans. */
export function freshnessState(
  row: Pick<LegacyStateRow, "volatile" | "reviewDueAt">,
  args: { nowIso: string; newerObservation?: boolean; explicitConflict?: boolean },
): { stale: boolean; requiresReview: boolean; freshnessReasons: FreshnessReason[] } {
  const reasons: FreshnessReason[] = [];
  if (reviewOverdue(row, args.nowIso)) reasons.push("review_overdue");
  if (args.newerObservation) reasons.push("newer_observation");
  if (args.explicitConflict) reasons.push("explicit_conflict");
  return { stale: reasons.length > 0, requiresReview: reasons.length > 0, freshnessReasons: reasons };
}
