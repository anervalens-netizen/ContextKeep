import { useState } from "react";
import { listConflicts, listMutations } from "../lib/offline/queue.js";
import type { ConflictEntry, QueuedMutation } from "../lib/offline/db.js";
import { OfflineMutationDetails } from "./OfflineMutationDetails.js";

type Inspection = { queued: QueuedMutation[]; conflicts: ConflictEntry[] };

/** Read-only inspection never retries, acknowledges, or changes queue ownership. */
export function OfflineOperationInspector() {
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [error, setError] = useState(false);
  return (
    <div className="mt-2 text-xs">
      <button
        type="button"
        className="text-ck-teal underline"
        aria-expanded={inspection !== null}
        onClick={() => {
          if (inspection) {
            setInspection(null);
            return;
          }
          setError(false);
          void Promise.all([listMutations(), listConflicts()])
            .then(([queued, conflicts]) => setInspection({ queued, conflicts }))
            .catch(() => setError(true));
        }}
      >
        Inspect offline operations
      </button>
      {error ? <p role="alert">Offline operations unavailable.</p> : null}
      {inspection ? (
        <ul
          aria-label="Offline operations"
          className="mt-2 max-h-48 overflow-auto"
        >
          {inspection.queued.length === 0 &&
          inspection.conflicts.length === 0 ? (
            <li>No queued or unresolved operations.</li>
          ) : null}
          {inspection.queued.map((row) => (
            <li key={`queued-${row.seq}`} className="py-1">
              {row.label ?? "Queued operation"} ·{" "}
              {row.deliveryState ?? "queued"}
              <OfflineMutationDetails mutation={row} />
            </li>
          ))}
          {inspection.conflicts.map((entry) => (
            <li key={`conflict-${entry.seq}`} className="py-1">
              {entry.mutation.label ?? "Unresolved operation"} · {entry.code}
              <OfflineMutationDetails
                mutation={entry.mutation}
                unknownOutcome={entry.code === "idempotency_outcome_unknown"}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
