/**
 * F07: durable server-side mutation idempotency.
 *
 * The durability model:
 *
 *   1. The authenticated preHandler reserves a single SQLite row keyed by the
 *      client-supplied `Idempotency-Key` header. The PK uniqueness IS the
 *      concurrency authority; no in-memory lock is required and any number of
 *      tabs / processes / future replicas will see the same outcome.
 *   2. The business handler runs against the freshly-claimed `pending` row.
 *   3. The onSend hook finalizes the row with the response status + body
 *      (or `indeterminate` for 5xx), strictly before the bytes leave the
 *      server.
 *   4. After a process restart, every leftover `pending` row is converted to
 *      `indeterminate` by `recoverInterruptedIdempotencyClaims`. A retry then
 *      sees `idempotency_outcome_unknown` instead of being silently
 *      re-executed.
 *
 * Storage minimization (F07 §18):
 *   - no raw request bodies (only a deterministic hash);
 *   - no cookies, CSRF tokens, session ids, or auth headers;
 *   - response bodies are stored already serialized to JSON / text so the
 *     replay path is a byte-for-byte replay without re-running any handler.
 */
import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { nowIso } from "../lib/time.js";

export type IdempotencyState = "pending" | "completed" | "indeterminate";

export interface IdempotencyClaim {
  key: string;
  method: string;
  url: string;
  requestHash: string;
  state: IdempotencyState;
  responseStatus: number | null;
  responseBody: string | null;
  responseContentType: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimInput {
  key: string;
  method: string;
  url: string;
  /** Caller-computed request hash; see `requestHash()`. */
  requestHash: string;
}

export interface ClaimOutcome {
  /** True iff this call inserted a brand new pending claim. */
  fresh: boolean;
  claim: IdempotencyClaim;
}

export interface FinalizeInput {
  key: string;
  state: "completed" | "indeterminate";
  responseStatus: number;
  /** Already-serialized response body. May be empty string for indeterminate. */
  responseBody: string;
  responseContentType: string;
}

/** Allowed alphabet / length for an Idempotency-Key header value. */
const KEY_RE = /^[A-Za-z0-9._\-:]{8,200}$/;

/** Reject obviously malformed keys without ever touching the database. */
export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === "string" && KEY_RE.test(key);
}

interface RawRow {
  key: string;
  method: string;
  url: string;
  request_hash: string;
  state: IdempotencyState;
  response_status: number | null;
  response_body: string | null;
  response_content_type: string | null;
  created_at: string;
  updated_at: string;
}

function rowToClaim(row: RawRow): IdempotencyClaim {
  return {
    key: row.key,
    method: row.method,
    url: row.url,
    requestHash: row.request_hash,
    state: row.state,
    responseStatus: row.response_status,
    responseBody: row.response_body,
    responseContentType: row.response_content_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Stable JSON canonicalization (RFC 8785 subset):
 *   - object keys sorted recursively (so {"a":1,"b":2} and {"b":2,"a":1}
 *     hash to the same value);
 *   - arrays preserve order (the body is semantically ordered);
 *   - primitives are preserved as-is;
 *   - `undefined` serializes to the literal `"null"` so a bodyless mutation
 *     and an explicit `null` body produce the same canonical form;
 *   - plain objects (including `{}`) preserve their structure as-is. An
 *     empty object `{}` is a real JSON body and must remain distinct from
 *     `null` / no-body — only the value `undefined` collapses to `null`,
 *     never the value `{}`.
 *
 * `undefined`, functions, and symbols inside objects are dropped (consistent
 * with JSON serialization, which would drop them anyway).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  // Plain object only: ignore class instances (no DTO has any in a mutation
  // body — the request body is parsed JSON). Defensive cast through `unknown`
  // keeps the index access typed.
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/**
 * SHA-256 of method + ' ' + url + ' ' + canonical-JSON-body.
 *
 * `url` must already be the exact request URL the server sees, including any
 * query string. The body is canonicalized verbatim:
 *
 *   undefined              -> "null"   (no body)
 *   null                   -> "null"
 *   {}                     -> "{}"     (preserve as a real empty object body)
 *   {"b":2,"a":1}          -> "{\"a\":1,\"b\":2}"   (key order is canonicalized)
 *
 * `{}` MUST be distinct from a missing / `null` body so that an explicit
 * empty JSON object is recognized as a different logical mutation.
 */
export function requestHash(method: string, url: string, body: unknown): string {
  // Only an absent value (`undefined`) collapses to no-body. Anything else,
  // including `null` and `{}`, passes through canonicalization unchanged so a
  // client that sends an explicit empty JSON object is fingerprinted
  // differently from one that sends no body at all.
  const normalized = body === undefined ? null : body;
  return crypto
    .createHash("sha256")
    .update(method)
    .update(" ")
    .update(url)
    .update(" ")
    .update(canonicalJson(normalized))
    .digest("hex");
}

interface Prepared {
  insert: Database.Statement;
  selectByKey: Database.Statement;
  finalize: Database.Statement;
}

const prepared = new WeakMap<Database.Database, Prepared>();

function getPrepared(sqlite: Database.Database): Prepared {
  const cached = prepared.get(sqlite);
  if (cached) return cached;
  const fresh: Prepared = {
    insert: sqlite.prepare(
      `INSERT INTO idempotency_requests
         (key, method, url, request_hash, state, response_status, response_body, response_content_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`,
    ),
    selectByKey: sqlite.prepare(
      `SELECT key, method, url, request_hash, state,
              response_status, response_body, response_content_type,
              created_at, updated_at
       FROM idempotency_requests WHERE key = ?`,
    ),
    finalize: sqlite.prepare(
      `UPDATE idempotency_requests
         SET state = ?, response_status = ?, response_body = ?, response_content_type = ?, updated_at = ?
       WHERE key = ? AND state = 'pending'`,
    ),
  };
  prepared.set(sqlite, fresh);
  return fresh;
}

/**
 * Atomically claim an idempotency key. Returns the resolved claim:
 *   - `fresh: true` when this call inserted a brand new `pending` row — the
 *     caller owns the business execution and must finalize on the way out;
 *   - `fresh: false` when a row already existed for this key — the caller
 *     must consult `claim.state` / `claim.requestHash` and either replay,
 *     retry, or refuse.
 *
 * The insert uses the PRIMARY KEY as the uniqueness barrier: the second
 * caller of the same key gets a SQLITE_CONSTRAINT that we map to the
 * existing row, so two processes racing on the same key observe the same
 * single owner.
 */
export function tryClaim(sqlite: Database.Database, input: ClaimInput): ClaimOutcome {
  const { key, method, url, requestHash: requestHashValue } = input;
  const { insert, selectByKey } = getPrepared(sqlite);
  const stamp = nowIso();
  try {
    insert.run(key, method, url, requestHashValue, stamp, stamp);
    const fresh = selectByKey.get(key) as RawRow;
    return { fresh: true, claim: rowToClaim(fresh) };
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    if (!code.startsWith("SQLITE_CONSTRAINT")) throw err;
  }
  const existing = selectByKey.get(key) as RawRow | undefined;
  if (!existing) {
    // Constraint triggered for a reason other than PK collision (extremely
    // unlikely — keep this defensive branch).
    throw new Error(`idempotency claim lost for key ${key}`);
  }
  return { fresh: false, claim: rowToClaim(existing) };
}

/**
 * Finalize a previously-claimed `pending` row. Must only be called by the
 * caller that observed `fresh: true` from `tryClaim`.
 *
 * `state = "completed"` requires non-null response status/body/content-type
 * (the body is the already-serialized response we will replay on retry).
 * `state = "indeterminate"` accepts empty body (the response was a 5xx and
 * we cannot prove what committed).
 *
 * Idempotent: if the row is no longer `pending` (e.g. recovery ran first,
 * or another replica raced us) the update is a no-op.
 */
export function finalizeClaim(sqlite: Database.Database, input: FinalizeInput): void {
  const { key, state, responseStatus, responseBody, responseContentType } = input;
  const { finalize } = getPrepared(sqlite);
  finalize.run(state, responseStatus, responseBody, responseContentType, nowIso(), key);
}

/**
 * Bounded startup recovery: convert every persisted `pending` claim to
 * `indeterminate`. After a process restart there is no in-flight execution
 * that could legitimately own those rows, so the safest next state is the
 * one that forces any retry to surface an explicit unknown outcome instead
 * of silently re-running a possibly-committed mutation.
 *
 * Returns the number of rows recovered (0 on a clean restart).
 */
export function recoverInterruptedIdempotencyClaims(sqlite: Database.Database): number {
  const recover = sqlite.transaction(() => {
    const stamp = nowIso();
    const result = sqlite
      .prepare(
        `UPDATE idempotency_requests SET state = 'indeterminate', updated_at = ?
         WHERE state = 'pending'`,
      )
      .run(stamp);
    return result.changes;
  });
  return recover.immediate();
}

export const IDEMPOTENCY_TERMINAL_RETENTION_DAYS = 30;

export function pruneTerminalIdempotencyClaims(
  sqlite: Database.Database,
  retentionDays = IDEMPOTENCY_TERMINAL_RETENTION_DAYS,
  nowMs = Date.now(),
): number {
  const cutoff = new Date(nowMs - retentionDays * 86_400_000).toISOString();
  const prune = sqlite.transaction(() =>
    sqlite
      .prepare(
        `DELETE FROM idempotency_requests
         WHERE state IN ('completed','indeterminate') AND updated_at < ?`,
      )
      .run(cutoff).changes,
  );
  return prune.immediate();
}

/** Test-only: drop a key so tests can re-claim a fresh slot. */
export function _testDeleteClaim(sqlite: Database.Database, key: string): void {
  sqlite.prepare("DELETE FROM idempotency_requests WHERE key = ?").run(key);
}
