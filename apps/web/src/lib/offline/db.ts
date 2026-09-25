import { deleteDB, openDB, type IDBPDatabase } from "idb";
import { isLocalDataAccessPaused } from "./local-data-state.js";

/**
 * IndexedDB stores for offline operation (M0 scope 9, A9/A10):
 * - mutations: offline mutation queue, replayed in order on reconnect
 * - cache: last-known-good copies (current brief, last inbox page, last search)
 * - conflicts: replay results that hit 409/4xx — surfaced as a conflict banner
 */
const DB_NAME = "contextkeep-offline";
const DB_VERSION = 1;

export interface QueuedMutation {
  seq?: number;
  method: string;
  url: string;
  body?: unknown;
  enqueuedAt: string;
  label?: string;
  /**
   * F07: server-side durable idempotency key. Generated exactly once, before
   * the first send (or before the first network-failure queueing). Stored on
   * the queued row so a replay uses the same byte-for-byte key the server
   * already saw. Legacy rows pre-F07 have no key; the queue synthesizes one
   * on first replay and persists it BEFORE the request is sent.
   */
  idempotencyKey?: string;
  /**
   * F07 in-flight lease (this remediation): "in_flight" marks the row as
   * actively owned by an HTTP attempt in progress. "queued" is the default
   * replayable state and is the implicit value of any row lacking the field
   * (legacy rows + offline-enqueued rows). Only one client attempt may own
   * a row at a time — every replay/cleanup path verifies the owner token
   * inside the same readwrite transaction before mutating state.
   */
  deliveryState?: "queued" | "in_flight";
  /**
   * F07 in-flight lease: opaque random token identifying the current owner
   * of the in_flight row. Only the holder may extend the lease, release it
   * back to "queued", or delete the row on a successful 2xx. Stale
   * apiFetch() invocations cannot accidentally delete / overwrite a row that
   * a recovery / replay path has already taken over.
   */
  inFlightOwner?: string;
  /**
   * CK-A06 claim generation. Incremented every time a queued/expired row is
   * claimed. It is intentionally preserved when a row returns to queued so
   * a delayed response from an older generation cannot finalize a newer
   * attempt after that newer owner has already released its lease.
   */
  inFlightGeneration?: number;
  /** F07/CK-A06 in-flight lease: ISO timestamp; the row is replayable after this point. */
  inFlightUntil?: string;
  /**
   * CK-A07 persisted count of transport deadlines for this same logical
   * mutation/idempotency key. Survives reload so automatic retry cannot
   * become unbounded when a tab restarts.
   */
  transportTimeoutAttempts?: number;
}

export interface ConflictEntry {
  seq?: number;
  mutation: QueuedMutation;
  status: number;
  code: string;
  message: string;
  /** Optional decoded successful response for non-terminal 2xx workflows that still need owner action. */
  response?: unknown;
  detectedAt: string;
}

export interface CacheEntry {
  key: string;
  value: unknown;
  /** Local persistence timestamp; retained for legacy compatibility. */
  savedAt: string;
  /**
   * CK-A04 explicit data provenance. Legacy rows have no provenance and are
   * treated as cache/unknown-freshness on read; they are never upgraded by
   * rewriting timestamps.
   */
  provenance?: {
    generation: number;
    source: "network";
    fetchedAt: string;
    scope: string;
    cursor: unknown | null;
  };
}

let dbPromise: Promise<IDBPDatabase> | null = null;

export function offlineDb(): Promise<IDBPDatabase> {
  if (isLocalDataAccessPaused()) {
    return Promise.reject(new Error("ContextKeep local data access is paused."));
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("mutations")) {
          db.createObjectStore("mutations", { keyPath: "seq", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains("cache")) {
          db.createObjectStore("cache", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("conflicts")) {
          db.createObjectStore("conflicts", { keyPath: "seq", autoIncrement: true });
        }
      },
    });
  }
  return dbPromise;
}

export async function closeOfflineDb(): Promise<void> {
  if (!dbPromise) return;
  const db = await dbPromise;
  db.close();
  dbPromise = null;
}

export async function deleteOfflineDatabase(): Promise<void> {
  await closeOfflineDb();
  await deleteDB(DB_NAME);
}
