import type { IDBPDatabase } from "idb";
import { closeOfflineDb, deleteOfflineDatabase, offlineDb, type ConflictEntry, type QueuedMutation } from "./db.js";
import { purgeLegacyContextKeepApiCaches } from "./sw-data-cache.js";
import {
  LOCAL_DATA_PAUSED_KEY,
  setLocalDataAccessPaused,
} from "./local-data-state.js";

export type LocalDataSummary = {
  queued: number;
  inFlight: number;
  conflicts: number;
  unknownOutcome: number;
  reviewRequired: number;
  unsafeCount: number;
};

export type LocalDataPurgeResult =
  | { status: "blocked"; summary: LocalDataSummary; errors: [] }
  | { status: "complete"; summary: LocalDataSummary; errors: []; removedCaches: string[] }
  | { status: "partial"; summary: LocalDataSummary; errors: string[]; removedCaches: string[] };

function summarize(mutations: QueuedMutation[], conflicts: ConflictEntry[]): LocalDataSummary {
  const unknownOutcome = conflicts.filter((item) =>
    item.code === "idempotency_outcome_unknown" || item.code === "idempotency_in_progress"
  ).length;
  const inFlight = mutations.filter((item) => item.deliveryState === "in_flight").length;
  return {
    queued: mutations.length,
    inFlight,
    conflicts: conflicts.length,
    unknownOutcome,
    reviewRequired: Math.max(0, conflicts.length - unknownOutcome),
    unsafeCount: mutations.length + conflicts.length,
  };
}

async function readSummary(db: IDBPDatabase): Promise<LocalDataSummary> {
  const [mutations, conflicts] = await Promise.all([
    db.getAll("mutations") as Promise<QueuedMutation[]>,
    db.getAll("conflicts") as Promise<ConflictEntry[]>,
  ]);
  return summarize(mutations, conflicts);
}

export async function inspectLocalContextKeepData(): Promise<LocalDataSummary> {
  return readSummary(await offlineDb());
}

function clearContextKeepLocalStorage(): void {
  if (typeof window === "undefined") return;
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith("ck:") && key !== LOCAL_DATA_PAUSED_KEY) keys.push(key);
  }
  for (const key of keys) window.localStorage.removeItem(key);
}

export async function purgeLocalContextKeepData(input: {
  discardUnsynced: boolean;
  onPause?: () => void | Promise<void>;
  cacheStorage?: Pick<CacheStorage, "keys" | "delete">;
  deleteDatabase?: () => Promise<void>;
}): Promise<LocalDataPurgeResult> {
  const db = await offlineDb();
  const initial = await readSummary(db);
  if (initial.unsafeCount > 0 && !input.discardUnsynced) {
    return { status: "blocked", summary: initial, errors: [] };
  }

  setLocalDataAccessPaused(true);
  await input.onPause?.();

  // Re-read after the pause barrier so a mutation that committed between the
  // first inspection and the pause cannot be silently discarded.
  const frozen = await readSummary(db);
  if (frozen.unsafeCount > 0 && !input.discardUnsynced) {
    setLocalDataAccessPaused(false);
    return { status: "blocked", summary: frozen, errors: [] };
  }

  const errors: string[] = [];
  let removedCaches: string[] = [];
  try {
    await closeOfflineDb();
    await (input.deleteDatabase ?? deleteOfflineDatabase)();
  } catch {
    errors.push("IndexedDB could not be fully deleted.");
  }

  try {
    removedCaches = await purgeLegacyContextKeepApiCaches(input.cacheStorage);
  } catch {
    errors.push("One or more ContextKeep legacy browser caches could not be deleted.");
  }

  try {
    clearContextKeepLocalStorage();
  } catch {
    errors.push("ContextKeep localStorage could not be fully cleared.");
  }

  if (errors.length > 0) {
    return { status: "partial", summary: frozen, errors, removedCaches };
  }
  return { status: "complete", summary: frozen, errors: [], removedCaches };
}
