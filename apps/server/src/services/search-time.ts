import { compareInstants } from "./instant.js";
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
  const basis =
    row.sourceEventAt !== null
      ? "source_event"
      : row.effectiveFrom !== null
        ? "effective_from"
        : "unknown";
  const rankTime = row.sourceEventAt ?? row.effectiveFrom;
  const times = [
    row.sourceEventAt,
    row.effectiveFrom,
    row.effectiveTo,
    row.reviewDueAt,
  ].filter((time) => time !== null);
  let eligibility: SearchTemporalDto["eligibility"] = "unknown";
  if (
    times.some((time) => !instant.safeParse(time).success) ||
    (row.effectiveFrom !== null &&
      row.effectiveTo !== null &&
      compareInstants(row.effectiveFrom, row.effectiveTo) >= 0)
  )
    eligibility = "invalid";
  else if (
    (row.sourceEventAt && compareInstants(row.sourceEventAt, nowIso) > 0) ||
    (row.effectiveFrom && compareInstants(row.effectiveFrom, nowIso) > 0)
  )
    eligibility = "future";
  else if (row.effectiveTo && compareInstants(row.effectiveTo, nowIso) <= 0)
    eligibility = "expired";
  else if (rankTime !== null) eligibility = "dated";
  const operational = isCurrentStateClaim(row);
  const overdue =
    row.volatile === 1 || row.volatile === true
      ? row.reviewDueAt !== null &&
        compareInstants(row.reviewDueAt, nowIso) <= 0
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
