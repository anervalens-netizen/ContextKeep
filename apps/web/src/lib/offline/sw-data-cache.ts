/**
 * CK-A04 migration helper: remove only ContextKeep's legacy API runtime
 * caches. App-shell/precache entries, IndexedDB, and caches owned by other
 * applications on the same origin are intentionally untouched.
 */
export const LEGACY_CONTEXTKEEP_API_CACHES = [
  "ck-brief",
  "ck-inbox",
  "ck-search",
  "ck-projects",
] as const;

export async function purgeLegacyContextKeepApiCaches(
  storage: Pick<CacheStorage, "keys" | "delete"> | undefined =
    typeof caches === "undefined" ? undefined : caches,
): Promise<string[]> {
  if (!storage) return [];
  const existing = new Set(await storage.keys());
  const removed: string[] = [];
  for (const name of LEGACY_CONTEXTKEEP_API_CACHES) {
    if (!existing.has(name)) continue;
    if (await storage.delete(name)) removed.push(name);
  }
  return removed;
}
