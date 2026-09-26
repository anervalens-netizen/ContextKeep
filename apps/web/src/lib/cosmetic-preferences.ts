const memory = new Map<string, string>();
// A pending value/tombstone wins over stale persistent state until the
// browser accepts the corresponding write/remove.
const pending = new Map<string, string | null>();

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    // Accessing window.localStorage itself can throw in privacy-restricted
    // contexts; the getter is part of the guarded operation.
    return window.localStorage;
  } catch {
    return null;
  }
}

function restore(key: string, target: Storage): void {
  if (!pending.has(key)) return;
  const desired = pending.get(key)!;
  try {
    if (desired === null) target.removeItem(key);
    else target.setItem(key, desired);
    pending.delete(key);
  } catch {
    // Keep the desired value authoritative until persistence succeeds.
  }
}

export function readCosmeticPreference(key: string): string | null {
  const target = storage();
  if (target) {
    restore(key, target);
    if (pending.has(key)) return pending.get(key)!;
    try {
      const value = target.getItem(key);
      if (value === null) memory.delete(key);
      else memory.set(key, value);
      return value;
    } catch { /* fall through to the volatile session fallback */ }
  }
  return pending.has(key) ? pending.get(key)! : memory.get(key) ?? null;
}

export function writeCosmeticPreference(key: string, value: string): void {
  memory.set(key, value);
  pending.set(key, value);
  const target = storage();
  if (!target) return;
  try {
    target.setItem(key, value);
    pending.delete(key);
  } catch {
    // The pending value remains visible even if an old persistent value stays.
  }
}

export function removeCosmeticPreference(key: string): void {
  memory.delete(key);
  pending.set(key, null);
  const target = storage();
  if (!target) return;
  try {
    target.removeItem(key);
    pending.delete(key);
  } catch { /* keep the tombstone until removal succeeds */ }
}
