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
