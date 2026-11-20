import { compareInstants, observationEligibility, optionalObservationInstant } from "./instant.js";
import { z } from "zod";
import type { SearchTemporalDto } from "@contextkeep/shared";
import {
  isCurrentStateClaim,
  type FreshnessRecord,
} from "./memory-freshness.js";

const instant = z.iso.datetime({ offset: true });

/** Capture and review times never stand in for an event or validity start. */
export function searchTemporal(
  row: FreshnessRecord,
  nowIso: string,
): SearchTemporalDto {
  // Use the same absent-time semantics as freshness eligibility so temporal
  // ranking and public HTTP/MCP provenance cannot disagree on legacy blanks.
  const eventTime = optionalObservationInstant(row.sourceEventAt);
  const effectiveTime = optionalObservationInstant(row.effectiveFrom);
  const basis =
    eventTime !== null
      ? "source_event"
      : effectiveTime !== null
        ? "effective_from"
        : "unknown";
  const rankTime = eventTime ?? effectiveTime;
  const eligibility = observationEligibility(row, nowIso);
  const invalidReviewTime = row.reviewDueAt !== null &&
    !instant.safeParse(row.reviewDueAt).success;
  const operational = row.reviewStatus !== "superseded" && isCurrentStateClaim(row);
  const overdue =
    row.volatile === 1 || row.volatile === true
      ? invalidReviewTime || (row.reviewDueAt !== null &&
        compareInstants(row.reviewDueAt, nowIso) <= 0)
      : false;
  const currentAdjustment = operational
    ? eligibility === "dated" && !overdue
      ? 12
      : eligibility === "unknown" && !overdue
        ? 0
        : -24
    : 0;
  return {
    basis,
    rankTime: eligibility === "dated" ? rankTime : null,
    eligibility,
    currentAdjustment,
  };
}
