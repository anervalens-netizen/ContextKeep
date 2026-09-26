export const LOCAL_DATA_PAUSED_KEY = "ck:local-data-paused";
export const LOCAL_DATA_CHANNEL = "contextkeep-local-data-control";

let memoryPaused = false;

export function isLocalDataStorageUnavailable(): boolean {
  try {
    if (typeof window !== "undefined") window.localStorage.getItem(LOCAL_DATA_PAUSED_KEY);
    return false;
  } catch {
    return true;
  }
}

export function isLocalDataAccessPaused(): boolean {
  if (memoryPaused) return true;
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(LOCAL_DATA_PAUSED_KEY) === "1";
  } catch {
    // A denied read cannot distinguish "not paused" from an existing privacy
    // pause that is no longer observable. Fail closed so callers never turn
    // an unknown persisted pause into a durable-save success.
    return true;
  }
}

function announce(paused: boolean): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(LOCAL_DATA_CHANNEL);
  try {
    channel.postMessage({ type: paused ? "pause" : "resume" });
  } finally {
    channel.close();
  }
}

export function setLocalDataAccessPaused(paused: boolean): boolean {
  // Pause immediately, but never announce a resume before the durable marker
  // is removed. A read-capable browser can still deny removeItem.
  if (paused) memoryPaused = true;
  let persisted = true;
  if (typeof window !== "undefined") {
    try {
      if (paused) window.localStorage.setItem(LOCAL_DATA_PAUSED_KEY, "1");
      else window.localStorage.removeItem(LOCAL_DATA_PAUSED_KEY);
    } catch {
      persisted = false;
    }
  }
  if (!paused && !persisted) {
    memoryPaused = true;
    announce(true);
    return false;
  }
  memoryPaused = paused;
  announce(paused);
  return persisted;
}

export function subscribeLocalDataAccess(handler: (paused: boolean) => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === LOCAL_DATA_PAUSED_KEY) handler(event.newValue === "1");
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);

  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(LOCAL_DATA_CHANNEL);
  const onMessage = (event: MessageEvent): void => {
    const type = (event.data as { type?: unknown } | null)?.type;
    if (type === "pause") handler(true);
    if (type === "resume") handler(false);
  };
  channel?.addEventListener("message", onMessage);

  return () => {
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    channel?.removeEventListener("message", onMessage);
    channel?.close();
  };
}
