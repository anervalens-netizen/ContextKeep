import { OfflineMutationDetails } from "./OfflineMutationDetails.js";
import * as offlineQueue from "../lib/offline/queue.js";
import type { ReactNode } from "react";
import { useUiStore } from "../state/ui.js";
import { RETRY_OFFLINE_QUEUE_EVENT } from "../lib/idempotency-key.js";

/**
 * Persistent banner of offline replay conflicts. The owner dismisses an
 * entry to acknowledge it; on dismissal we dispatch `ck:retry-offline-queue`
 * so the F07 durable-barrier release path in main.tsx can transparently
 * resume the queue if no other blocking conflict remains and the browser is
 * online. `idempotency_outcome_unknown` entries are the only ones that gate
 * the rest of the queue; other semantic 4xx conflicts are inert once
 * dismissed.
 *
 * The region is assertively announced because an unknown-outcome conflict is
 * an actionable durable queue barrier, not decorative status text.
 */
export function ConflictOverlay(): ReactNode {
  const conflicts = useUiStore((s) => s.conflicts);
  const dismiss = useUiStore((s) => s.dismissConflict);
  const setNotice = useUiStore((s) => s.setNotice);
  const handle = async (seq: number): Promise<void> => {
    try {
      const q = offlineQueue;
      await q.dismissConflict(seq);
      dismiss(seq);
      const remaining = await q.listConflicts();
      const stillBlocking = remaining.some(
        (c) => c.code === "idempotency_outcome_unknown",
      );
      if (stillBlocking) return;
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(RETRY_OFFLINE_QUEUE_EVENT));
      }
    } catch {
      setNotice({ kind: "error", text: "Could not dismiss the offline conflict. Try again." });
    }
  };
  if (!conflicts.length) return null;
  return (
    <div role="alert" aria-label="Offline conflicts" aria-live="assertive" className="fixed inset-x-3 bottom-3 z-[60] mx-auto max-w-2xl rounded-xl border border-ck-red/40 bg-ck-surface p-3 shadow-xl">
      <p className="text-xs font-semibold text-ck-red">
        {conflicts.length} offline change{conflicts.length === 1 ? "" : "s"} need{conflicts.length === 1 ? "s" : ""} attention.
      </p>
      <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-[11px]">
        {conflicts.map((c) => {
          const isUnknown = c.code === "idempotency_outcome_unknown";
          const reviewRoute =
            c.code === "near_duplicate_pending"
              ? "/import"
              : c.code === "correction_preview_pending"
                ? "/corrections"
                : c.code === "needs_user_review"
                  ? "/inbox"
                  : null;
          return (
            <li key={c.seq} className="flex flex-col gap-1 rounded-lg bg-ck-bg p-2">
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 text-ck-muted">
                  {c.mutation.label ?? `${c.mutation.method} ${c.mutation.url}`} · {c.status} {c.code}
                </span>
                <div className="flex shrink-0 gap-2">
                  {reviewRoute ? (
                    <a href={reviewRoute} className="font-medium text-ck-teal underline">Review</a>
                  ) : null}
                  <button
                    type="button"
                    className="text-ck-muted underline"
                    onClick={() => {
                      if (c.seq !== undefined) void handle(c.seq);
                    }}
                    aria-label={isUnknown ? "Acknowledge and continue queue" : reviewRoute ? "Discard pending offline result" : "Dismiss conflict"}
                  >
                    {isUnknown ? "Acknowledge & continue queue" : reviewRoute ? "Discard" : "Dismiss"}
                  </button>
                </div>
              </div>
              <OfflineMutationDetails mutation={c.mutation} unknownOutcome={isUnknown} />
              {c.message ? (
                <p className="whitespace-pre-wrap text-ck-ink" data-testid="conflict-message">
                  {c.message}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
