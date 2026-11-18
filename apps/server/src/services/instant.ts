import { z } from "zod";
import type { SearchTemporalDto } from "@contextkeep/shared";

/**
 * Order ISO instants without rounding fractional seconds to milliseconds. UTC
 * and numeric offsets (including minute-only times) share a UTC seconds key;
 * the arbitrary-precision fraction is compared separately by lexical order.
 * This never rewrites stored values. Legacy non-ISO values retain their former
 * lexical ordering; input validation remains the responsibility of the caller.
 */
export function instantKey(value: string): string {
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})$/.exec(
      value,
    );
  if (!match) return value;
  let seconds = `${match[1]}:${match[2] ?? "00"}`;
  if (match[4] !== "Z") {
    // Parse only the whole-second component, never the fractional precision.
    const ms = Date.parse(seconds + match[4]);
    if (!Number.isFinite(ms)) return value;
    seconds = new Date(ms).toISOString().slice(0, -5);
  }
  return `${seconds}.${(match[3] ?? "").replace(/0+$/, "")}`;
}

export function compareInstants(a: string, b: string): number {
  const left = instantKey(a);
  const right = instantKey(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

const verifiedObservationInstant = z.iso.datetime({ offset: true });

export function observationEligibility(
  { sourceEventAt, effectiveFrom, effectiveTo }: {
    sourceEventAt: string | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
  },
  nowIso: string,
): SearchTemporalDto["eligibility"] {
  const times = [sourceEventAt, effectiveFrom, effectiveTo];
  if (
    times.some((time) => time !== null && !verifiedObservationInstant.safeParse(time).success) ||
    (effectiveFrom !== null &&
      effectiveTo !== null &&
      compareInstants(effectiveFrom, effectiveTo) >= 0)
  ) return "invalid";
  if (
    (sourceEventAt !== null && compareInstants(sourceEventAt, nowIso) > 0) ||
    (effectiveFrom !== null && compareInstants(effectiveFrom, nowIso) > 0)
  ) return "future";
  if (effectiveTo !== null && compareInstants(effectiveTo, nowIso) <= 0) return "expired";
  return sourceEventAt !== null || effectiveFrom !== null ? "dated" : "unknown";
}
