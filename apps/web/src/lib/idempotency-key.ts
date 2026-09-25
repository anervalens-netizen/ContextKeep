/**
 * F07: neutral home for idempotency-key generation.
 *
 * Lives outside both `api.ts` and `offline/queue.ts` so the two can stay
 * symmetrical imports instead of `offline/queue.ts` reaching into `api.ts`.
 * The server-side validator accepts 8–200 chars of `[A-Za-z0-9._-:]`, which
 * the UUIDv4 shape satisfies exactly. No new package; the implementation
 * uses the standard browser crypto surface and degrades to Math.random only
 * when even getRandomValues is missing (which is not a real browser).
 */

/**
 * UUIDv4-shaped token using only the standard browser crypto / fallback
 * random source. contextkeep has no UUID dependency; an inline generator
 * avoids any new package while still satisfying the server-side key
 * validator (8–200 chars of [A-Za-z0-9._-:]).
 */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  // Fallback (older browsers): produce a UUIDv4-ish string from getRandomValues.
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push((bytes[i] ?? 0).toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

/**
 * Stable identifier for the cross-context retry signal. When an owner
 * dismisses the last blocking "idempotency_outcome_unknown" conflict the
 * ConflictOverlay dispatches this event so main.tsx can request a replay
 * without requiring a browser reload.
 */
export const RETRY_OFFLINE_QUEUE_EVENT = "ck:retry-offline-queue";
