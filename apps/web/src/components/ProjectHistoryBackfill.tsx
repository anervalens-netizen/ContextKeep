import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SyncRunResultDto, SyncStatusDto } from "@contextkeep/shared";
import { apiFetch, ApiError } from "../lib/api.js";
import { Icon } from "./Icon.js";

/**
 * L4.3: durable server jobs can outlive the browser request, so the UI no longer
 * forces owner-driven batches of 3. One bounded run may consume up to 25 artifacts
 * while the total character and cost ceilings remain unchanged.
 */
const BATCH_SIZE = 25;
const MAX_CHARS = 250_000;
const MAX_ESTIMATED_COST_USD = 0.1;
/** Server status poll while this page stays open. */
const STATUS_POLL_MS = 4_000;

function formatChars(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M chars`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k chars`;
  return `${value} chars`;
}

/** Newest of the locally-returned result and the one recovered from the server. */
function newest(a: SyncRunResultDto | null, b: SyncRunResultDto | null): SyncRunResultDto | null {
  if (!a) return b;
  if (!b) return a;
  return b.finishedAt > a.finishedAt ? b : a;
}

export function ProjectHistoryBackfill({ projectId, sessionCount }: { projectId: string; sessionCount: number }): ReactNode {
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<SyncRunResultDto | null>(null);
  const [result, setResult] = useState<SyncRunResultDto | null>(null);
  const [busy, setBusy] = useState<"preview" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A run can outlive the browser request that started it (reload, closed tab,
  // frozen page). `/api/sync/status` is the only durable source of truth for
  // "is the server still working, and what did it finish?".
  const statusQuery = useQuery({
    queryKey: ["sync-status"],
    queryFn: () => apiFetch<SyncStatusDto>("/api/sync/status"),
    refetchInterval: STATUS_POLL_MS,
    retry: false,
  });
  const serverRunning = statusQuery.data?.running === true;
  const lastServerResult = statusQuery.data?.lastResult ?? null;
  // Recovery is deliberately narrow: only a FINISHED, non-dry-run run that was
  // scoped to THIS project may be surfaced. Anything else (a global timer run,
  // a preview, another project's batch) is ignored.
  const recovered =
    lastServerResult && !lastServerResult.dryRun && lastServerResult.plan.projectId === projectId
      ? lastServerResult
      : null;
  const shown = newest(result, recovered);
  const running = busy === "run" || serverRunning;

  // Refresh dependent views once per distinct finished run, including a run
  // recovered after a reload. Never triggers another batch.
  const refreshedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!shown) return;
    const token = `${shown.runId}:${shown.finishedAt}`;
    if (refreshedRef.current === token) return;
    refreshedRef.current = token;
    // A finished execution invalidates the preview it came from: the numbers
    // in it describe a plan, not what actually happened. Clearing it also
    // removes the "Import this run" button so a stale plan cannot be
    // re-submitted by accident. The owner previews again for the next bounded run.
    if (!shown.dryRun) setPreview(null);
    void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    void queryClient.invalidateQueries({ queryKey: ["workspace-reconciliation"] });
    void queryClient.invalidateQueries({ queryKey: ["brief", projectId] });
  }, [shown, projectId, queryClient]);

  const run = async (dryRun: boolean): Promise<void> => {
    setBusy(dryRun ? "preview" : "run");
    setError(null);
    if (!dryRun) setResult(null);
    try {
      const response = await apiFetch<SyncRunResultDto>("/api/sync/run", {
        method: "POST",
        body: {
          projectId,
          connector: "both",
          dryRun,
          mode: "archiveAndExtract",
          idleMinutes: 30,
          maxArtifacts: BATCH_SIZE,
          maxChars: MAX_CHARS,
          maxCostUsd: MAX_ESTIMATED_COST_USD,
          allowUnassignedArchive: false,
        },
        label: dryRun ? "Preview project history" : "Import project history",
      });
      if (dryRun) setPreview(response);
      else setResult(response);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : dryRun ? "Could not preview project history." : "Could not import project history.");
    } finally {
      setBusy(null);
      // Re-read the server view immediately: if this request died on the wire
      // while the server kept working, the next poll recovers the real result.
      void statusQuery.refetch();
    }
  };

  const plan = preview?.plan;
  const hasExecutableWork = Boolean(plan && plan.selected > 0 && (plan.plannedExtract > 0 || plan.plannedArchive > 0));

  return (
    <section className="rounded-3xl border border-ck-line bg-ck-surface p-4 shadow-xs sm:p-5" data-project-backfill="true">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ck-bg text-ck-teal">
          <Icon name="archive" className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-ck-ink">Build knowledge from agent history</h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ck-muted">
            Preview one bounded run from this project only. Up to {BATCH_SIZE} linked Codex/DSH artifacts are sanitized and evaluated; extracted knowledge stays proposed until you review it.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void run(true)}
          disabled={busy !== null || serverRunning}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-ck-line bg-ck-bg px-3 py-2 text-xs font-semibold text-ck-ink disabled:opacity-50"
        >
          <Icon name="search" className="h-4 w-4" />
          {busy === "preview" ? "Previewing…" : preview ? "Refresh preview" : "Preview history"}
        </button>
      </div>

      <p className="mt-3 text-[11px] text-ck-muted">{sessionCount} mapped sessions are visible for this project. Previewing makes no persistent changes and no extraction call.</p>

      {running ? (
        <p className="mt-3 rounded-lg bg-ck-teal/10 px-3 py-2 text-xs font-semibold text-ck-ink" data-import-running="true" role="status">
          Import running on server… progress is durable and can be recovered after a reload.
        </p>
      ) : null}

      {error ? <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p> : null}

      {plan ? (
        <div className="mt-4 rounded-2xl border border-ck-line bg-ck-bg p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Run" value={`${plan.selected}/${BATCH_SIZE}`} />
            <Metric label="Extract" value={String(plan.plannedExtract)} />
            <Metric label="Archive" value={String(plan.plannedArchive)} />
            <Metric label="Safe text" value={formatChars(plan.totalSafeChars)} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ck-line pt-3">
            <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-ck-muted">
              {plan.selected === 0
                ? "Nothing new is eligible in this run."
                : `Estimated extraction cost for this preview is ≤ $${plan.totalEstimatedCostUsd.toFixed(4)}. Nothing becomes canonical automatically.`}
            </p>
            {hasExecutableWork ? (
              <button
                type="button"
                onClick={() => void run(false)}
                disabled={busy !== null || serverRunning}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-ck-teal px-3.5 py-2 text-xs font-semibold text-on-brand disabled:opacity-50"
              >
                <Icon name="import" className="h-4 w-4" />
                {busy === "run" ? "Importing…" : "Import this run"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {shown ? (
        <div className="mt-4 rounded-2xl border border-ck-line bg-ck-bg p-3 text-xs" data-import-result="true">
          <p className="font-semibold text-ck-ink">Run finished</p>
          <p className="mt-1 text-ck-muted">
            {shown.counts.extractedCreated + shown.counts.extractionUnchanged} extracted · {shown.counts.archivedCreated + shown.counts.archivedUnchanged} archived · {shown.counts.failed} failed.
          </p>
          {shown.errors.length ? (
            <ul className="mt-2 space-y-1.5">
              {shown.errors.map((item) => (
                <li
                  key={`${item.key}:${item.code}`}
                  data-import-error={item.code}
                  className="rounded-lg bg-red-500/10 px-3 py-2"
                >
                  <p className="font-mono text-[11px] font-semibold text-red-700 dark:text-red-300">{item.code}</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-ck-muted">{item.message}</p>
                </li>
              ))}
            </ul>
          ) : null}
          <Link to="/inbox" search={{ projectId, page: 1 }} className="mt-2 inline-flex min-h-9 items-center gap-1.5 font-semibold text-ck-teal">
            Review proposed knowledge <Icon name="chevron-right" className="h-3.5 w-3.5" />
          </Link>
        </div>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }): ReactNode {
  return <div className="rounded-xl bg-ck-surface px-3 py-2"><p className="text-sm font-semibold text-ck-ink">{value}</p><p className="mt-0.5 text-[9px] font-semibold uppercase tracking-wide text-ck-muted">{label}</p></div>;
}
