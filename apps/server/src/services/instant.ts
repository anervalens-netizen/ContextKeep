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

type ObservationTimes = {
  sourceEventAt: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
};

export function observationWindow({
  sourceEventAt,
  effectiveFrom,
  effectiveTo,
}: ObservationTimes): { starts: string | null; ends: string | null } | null {
  const times = [sourceEventAt, effectiveFrom, effectiveTo];
  if (
    times.some((time) => time !== null && !verifiedObservationInstant.safeParse(time).success) ||
    (effectiveFrom !== null &&
      effectiveTo !== null &&
      compareInstants(effectiveFrom, effectiveTo) >= 0)
  ) return null;

  const event = sourceEventAt === null ? null : instantKey(sourceEventAt);
  const effective = effectiveFrom === null ? null : instantKey(effectiveFrom);
  return {
    starts: event !== null && effective !== null
      ? (event > effective ? event : effective)
      : event ?? effective,
    ends: effectiveTo === null ? null : instantKey(effectiveTo),
  };
}

export function observationEligibility(
  times: ObservationTimes,
  nowIso: string,
): SearchTemporalDto["eligibility"] {
  const window = observationWindow(times);
  if (!window) return "invalid";
  const now = instantKey(nowIso);
  if (window.starts !== null && window.starts > now) return "future";
  if (window.ends !== null && window.ends <= now) return "expired";
  return window.starts === null ? "unknown" : "dated";
}
