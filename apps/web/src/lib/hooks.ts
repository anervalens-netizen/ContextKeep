import { QueuedOfflineError, QueuedUnknownOutcomeError } from "./api.js";
import { listMutations, listConflicts } from "./offline/queue.js";
import { useUiStore } from "../state/ui.js";

export type QueuedMutationError = QueuedOfflineError | QueuedUnknownOutcomeError;

export function isQueued(e: unknown): e is QueuedMutationError {
  return e instanceof QueuedOfflineError || e instanceof QueuedUnknownOutcomeError;
}

/** Report a queued mutation and refresh the header pill. */
export async function reportQueued(e: QueuedMutationError, what: string): Promise<void> {
  const ui = useUiStore.getState();
  ui.setQueuedCount((await listMutations()).length);
  if (e instanceof QueuedUnknownOutcomeError) {
    ui.setNotice({
      kind: "queued",
      text:
        e.reason === "timeout"
          ? `${what} timed out. The server may already have applied it; the same request is preserved for reconciliation.`
          : `${what} was cancelled after send. Its outcome may be unknown; the same request is preserved for reconciliation.`,
    });
    return;
  }
  ui.setNotice({ kind: "queued", text: `${what} queued offline — it will replay when the connection returns.` });
}

export async function refreshConflictState(): Promise<void> {
  const ui = useUiStore.getState();
  ui.setQueuedCount((await listMutations()).length);
  ui.setConflicts(await listConflicts());
}

export function notifyError(e: unknown, fallback: string): void {
  const text = e instanceof Error && e.message ? e.message : fallback;
  useUiStore.getState().setNotice({ kind: "error", text });
}
