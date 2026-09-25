import { offlineDb, type CacheEntry } from "./db.js";

/**
 * CK-A04 explicit last-known-good mirror.
 *
 * The service worker never owns private API data. Network reads are persisted
 * with their original fetch timestamp + logical scope + optional cursor. Reads
 * from IndexedDB are always labeled cache; legacy rows remain readable but
 * have unknown fetchedAt so they cannot masquerade as freshly revalidated.
 */
export const MIRROR_GENERATION = 2;

export type MirrorSource = "network" | "cache" | "legacy-cache";

export interface MirrorWriteMeta {
  fetchedAt: string;
  scope: string;
  cursor?: unknown | null;
}

export interface MirrorProvenance {
  generation: number;
  source: MirrorSource;
  fetchedAt: string | null;
  savedAt: string;
  scope: string;
  cursor: unknown | null;
}

export const briefKey = (projectId: string): string => `brief:${projectId}`;
export const PROJECTS_KEY = "projects:last";
export const INBOX_KEY = "inbox";
export function inboxKey(input: { projectId: string | null; page: number; limit: number }): string {
  return `inbox:v2:${JSON.stringify([input.projectId, input.page, input.limit])}`;
}
export const SEARCH_LAST_KEY = "search:last";

export function searchKey(input: {
  query: string;
  includeHistorical: boolean;
  projectId: string | null;
  scope?: "canonical" | "working" | "all";
}): string {
  return `search:v2:${JSON.stringify([
    input.query,
    input.includeHistorical,
    input.projectId,
    input.scope ?? "canonical",
  ])}`;
}

/** Pre-CV scoped canonical key. Read only for exact canonical compatibility. */
export function legacyCanonicalSearchKey(input: {
  query: string;
  includeHistorical: boolean;
  projectId: string | null;
}): string {
  return `search:v2:${JSON.stringify([input.query, input.includeHistorical, input.projectId])}`;
}

export function workContextKey(projectId: string): string {
  return `work-context:${projectId}`;
}

export const META_DASHBOARD_KEY = "meta:dashboard";

export async function saveToCache(
  key: string,
  value: unknown,
  meta?: Partial<MirrorWriteMeta>,
): Promise<void> {
  const db = await offlineDb();
  const savedAt = new Date().toISOString();
  const entry: CacheEntry = {
    key,
    value,
    savedAt,
    provenance: {
      generation: MIRROR_GENERATION,
      source: "network",
      fetchedAt: meta?.fetchedAt ?? savedAt,
      scope: meta?.scope ?? key,
      cursor: meta?.cursor ?? null,
    },
  };
  await db.put("cache", entry);
}

function legacyScopeForKey(key: string): string {
  if (key === PROJECTS_KEY) return "projects:list";
  if (key === INBOX_KEY) return "inbox:limit=1000";
  if (key === META_DASHBOARD_KEY) return "meta:dashboard";
  if (key.startsWith("brief:")) return `project:${key.slice("brief:".length)}:brief`;
  if (key.startsWith("work-context:")) return `project:${key.slice("work-context:".length)}:work-context`;
  return key;
}

export async function readCache<T>(
  key: string,
  expectedScope?: string,
): Promise<{ value: T; savedAt: string; provenance: MirrorProvenance } | null> {
  const db = await offlineDb();
  const entry = (await db.get("cache", key)) as CacheEntry | undefined;
  if (!entry) return null;

  if (entry.provenance) {
    if (expectedScope !== undefined && entry.provenance.scope !== expectedScope) return null;
    return {
      value: entry.value as T,
      savedAt: entry.savedAt,
      provenance: {
        generation: entry.provenance.generation,
        source: "cache",
        fetchedAt: entry.provenance.fetchedAt,
        savedAt: entry.savedAt,
        scope: entry.provenance.scope,
        cursor: entry.provenance.cursor ?? null,
      },
    };
  }

  // Legacy mirror rows remain recoverable but their original network fetch
  // time cannot be proven: old SW NetworkFirst may have supplied the 200.
  const legacyScope = legacyScopeForKey(key);
  if (expectedScope !== undefined && expectedScope !== legacyScope) return null;
  return {
    value: entry.value as T,
    savedAt: entry.savedAt,
    provenance: {
      generation: 1,
      source: "legacy-cache",
      fetchedAt: null,
      savedAt: entry.savedAt,
      scope: legacyScope,
      cursor: null,
    },
  };
}
