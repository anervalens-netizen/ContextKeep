import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CorrectionPreviewDto, ProjectDto, RecordDto, SearchResultDto } from "@contextkeep/shared";
import { apiFetch, ApiError } from "../lib/api.js";
import { RecordCard } from "../components/RecordCard.js";
import { debounce } from "../lib/debounce.js";
import { isQueued, notifyError, reportQueued } from "../lib/hooks.js";
import type { ConflictEntry } from "../lib/offline/db.js";
import * as offlineQueue from "../lib/offline/queue.js";
import { isLocalDataAccessPaused } from "../lib/offline/local-data-state.js";
import { useUiStore } from "../state/ui.js";

interface ConfirmResult {
  jobId: string;
  acceptedRecordIds: string[];
  supersededRecordIds: string[];
  confirmedSupersessionIds: string[];
}

const LIFECYCLE_STATES = ["active", "retired", "paused", "planned", "unknown"] as const;
const RECORD_TYPES = ["fact", "decision", "constraint", "question", "action"] as const;

export default function Corrections(): ReactNode {
  const queryClient = useQueryClient();
  const [statement, setStatement] = useState("");
  const [projectId, setProjectId] = useState("");
  const [subject, setSubject] = useState("owner-correction");
  const [predicate, setPredicate] = useState("");
  const [recordType, setRecordType] = useState<(typeof RECORD_TYPES)[number]>("fact");
  const [lcEnabled, setLcEnabled] = useState(false);
  const [lcProjectId, setLcProjectId] = useState("");
  const [lcState, setLcState] = useState<(typeof LIFECYCLE_STATES)[number]>("active");
  const [targetQuery, setTargetQuery] = useState("");
  const [debouncedTarget, setDebouncedTarget] = useState("");
  const [targets, setTargets] = useState<RecordDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<CorrectionPreviewDto | null>(null);
  const [replayedConflict, setReplayedConflict] = useState<ConflictEntry | null>(null);
  const [confirmResult, setConfirmResult] = useState<ConfirmResult | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: () => apiFetch<ProjectDto[]>("/api/projects") });
  const projects = projectsQuery.data ?? [];

  useEffect(() => {
    if (isLocalDataAccessPaused()) return;
    let cancelled = false;
    void (async () => {
      const { listConflicts } = offlineQueue;
      const pending = (await listConflicts()).find((c) => c.code === "correction_preview_pending" && c.response);
      if (cancelled || !pending) return;
      setReplayedConflict(pending);
      setPreview(pending.response as CorrectionPreviewDto);
    })().catch(() => {
      if (!cancelled) useUiStore.getState().setNotice({ kind: "error", text: "Saved offline correction previews could not be read. No queued operation was changed." });
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const d = debounce((q: string) => setDebouncedTarget(q), 200);
    d(targetQuery);
    return () => d.cancel();
  }, [targetQuery]);

  const searchQuery = useQuery({
    queryKey: ["correction-target-search", debouncedTarget],
    queryFn: () => apiFetch<SearchResultDto>(`/api/search?q=${encodeURIComponent(debouncedTarget)}&mode=canonical&limit=10`),
    enabled: debouncedTarget.length >= 3,
  });

  const propose = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setPreview(null);
    setConfirmResult(null);
    try {
      const dto = await apiFetch<CorrectionPreviewDto>("/api/corrections", {
        method: "POST",
        body: {
          statement,
          projectId: projectId || null,
          scopeProjectIds: [],
          supersedesRecordIds: targets.map((t) => t.id),
          lifecycleChange: lcEnabled && lcProjectId ? { projectId: lcProjectId, state: lcState } : null,
          recordType,
          subject: subject || "owner-correction",
          predicate: predicate || null,
        },
        label: "Propose owner correction",
      });
      setPreview(dto);
    } catch (e) {
      if (isQueued(e)) await reportQueued(e, "Correction proposal");
      else if (e instanceof ApiError) setError({ code: e.code, message: e.message });
      else notifyError(e, "Could not propose the correction.");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (jobId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const dto = await apiFetch<ConfirmResult>(`/api/corrections/${jobId}/confirm`, {
        method: "POST",
        body: {},
        label: "Confirm owner correction",
      });
      setConfirmResult(dto);
      setPreview(null);
      setStatement("");
      setTargets([]);
      if (replayedConflict?.seq !== undefined) {
        const q = offlineQueue;
        await q.dismissConflict(replayedConflict.seq);
        useUiStore.getState().setConflicts(await q.listConflicts());
        setReplayedConflict(null);
      }
      void queryClient.invalidateQueries();
    } catch (e) {
      if (isQueued(e)) await reportQueued(e, "Correction confirmation");
      else if (e instanceof ApiError) setError({ code: e.code, message: e.message });
      else notifyError(e, "Could not confirm the correction.");
    } finally {
      setBusy(false);
    }
  };

  const errorHint = (code: string): string | null => {
    switch (code) {
      case "requires_supersession":
        return "A2: add the listed accepted claims as supersession targets below, then propose again.";
      case "precedence_violation":
        return "A4: technical observations or agent reports can never supersede an owner declaration.";
      case "supersession_cycle":
        return "A18: the database rejected a supersession cycle (A→B and B→A).";
      default:
        return null;
    }
  };

  return (
    <div>
      <h1 className="text-base font-semibold">Owner correction</h1>
      <p className="mt-1 text-xs text-ck-muted">
        Explicit corrections supersede earlier declarations — but only after your review (handoff §4C). Imports can
        never do this.
      </p>

      <div className="mt-3 space-y-2 rounded-2xl border border-ck-line bg-ck-surface p-3">
        <textarea
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
          rows={3}
          placeholder='e.g. "The Astra apps are retired; Astra Keyboard remains active."'
          aria-label="Correction statement"
          aria-required="true"
          className="w-full rounded-xl border border-ck-line bg-ck-bg px-3 py-2 text-sm"
          required
        />
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="Project scope for the correction"
          className="w-full rounded-xl border border-ck-line bg-ck-bg px-3 py-2 text-sm"
        >
          <option value="">Scope: unassigned</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.lifecycle})
            </option>
          ))}
        </select>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="subject"
            aria-label="Subject"
            className="rounded-xl border border-ck-line bg-ck-bg px-3 py-2 text-xs sm:flex-1"
          />
          <input
            value={predicate}
            onChange={(e) => setPredicate(e.target.value)}
            placeholder="predicate (structured claim)"
            aria-label="Predicate (structured claim)"
            className="col-span-2 rounded-xl border border-ck-line bg-ck-bg px-3 py-2 text-xs sm:col-span-1 sm:flex-1"
          />
          <select
            value={recordType}
            onChange={(e) => setRecordType(e.target.value as (typeof RECORD_TYPES)[number])}
            className="rounded-xl border border-ck-line bg-ck-bg px-2 py-2 text-xs"
            aria-label="Record type"
          >
            {RECORD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-2 text-xs text-ck-muted">
          <input type="checkbox" checked={lcEnabled} onChange={(e) => setLcEnabled(e.target.checked)} className="h-4 w-4" />
          Change project lifecycle
        </label>
        {lcEnabled ? (
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <select
              value={lcProjectId}
              onChange={(e) => setLcProjectId(e.target.value)}
              className="col-span-2 rounded-xl border border-ck-line bg-ck-bg px-3 py-2 text-xs sm:col-span-1 sm:flex-1"
              aria-label="Project for lifecycle change"
            >
              <option value="">Select project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.lifecycle})
                </option>
              ))}
            </select>
            <select
              value={lcState}
              onChange={(e) => setLcState(e.target.value as (typeof LIFECYCLE_STATES)[number])}
              className="rounded-xl border border-ck-line bg-ck-bg px-3 py-2 text-xs"
              aria-label="New lifecycle state"
            >
              {LIFECYCLE_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div>
          <p className="text-xs font-medium text-ck-muted">Supersede accepted claims (explicit targets)</p>
          <input
            value={targetQuery}
            onChange={(e) => setTargetQuery(e.target.value)}
            placeholder="Search accepted records to supersede…"
            className="mt-1 w-full rounded-xl border border-ck-line bg-ck-bg px-3 py-2 text-xs"
          />
          {searchQuery.data && searchQuery.data.records.length > 0 ? (
            <ul className="mt-1 max-h-40 space-y-1 overflow-auto">
              {searchQuery.data.records.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setTargets((prev) => (prev.some((t) => t.id === r.id) ? prev : [...prev, r]));
                      setTargetQuery("");
                      setDebouncedTarget("");
                    }}
                    className="w-full rounded-lg border border-ck-line bg-ck-bg p-2 text-left text-[11px] hover:border-ck-teal"
                  >
                    <span className="font-medium">{r.text}</span>
                    <span className="block text-ck-muted">
                      {r.projectName ?? "unassigned"} · {r.subject}
                      {r.predicate ? `/${r.predicate}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {targets.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1">
              {targets.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setTargets((prev) => prev.filter((x) => x.id !== t.id))}
                    className="rounded-full border border-ck-red/40 bg-ck-red/10 px-2 py-0.5 text-[11px] text-ck-red"
                    title="Remove target"
                  >
                    {t.text.slice(0, 40)}
                    {t.text.length > 40 ? "…" : ""} ✕
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {error ? (
          <div className="rounded-lg border border-ck-red/40 bg-ck-red/10 p-2 text-xs text-ck-red">
            <p className="font-mono">{error.code}</p>
            <p className="mt-0.5">{error.message}</p>
            {errorHint(error.code) ? <p className="mt-1 font-medium">{errorHint(error.code)}</p> : null}
          </div>
        ) : null}

        <button
          type="button"
          disabled={busy || !statement.trim() || (lcEnabled && !lcProjectId)}
          onClick={() => void propose()}
          className="w-full rounded-xl bg-ck-teal px-3 py-2 text-sm font-semibold text-on-brand disabled:opacity-50"
        >
          {busy ? "Working…" : "Propose correction"}
        </button>
      </div>

      {preview ? (
        <div className="mt-3 rounded-2xl border border-ck-line bg-ck-surface p-3">
          <h2 className="text-sm font-semibold">Preview — affected claims</h2>
          {preview.warnings.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {preview.warnings.map((w) => (
                <li key={w} className="rounded-lg border border-ck-amber/40 bg-ck-amber/10 p-2 text-xs text-ck-amber">
                  {w}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-2 divide-y divide-ck-line overflow-hidden rounded-xl border border-ck-line">
            {preview.affected.length === 0 ? (
              <p className="p-2 text-xs text-ck-muted">
                No prior claims targeted — this correction adds a new owner declaration.
              </p>
            ) : (
              preview.affected.map((r) => <RecordCard key={r.id} record={r} />)
            )}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void confirm(preview.jobId)}
            className="mt-3 w-full rounded-xl bg-ck-green px-3 py-2 text-sm font-semibold text-success-text disabled:opacity-50"
          >
            Confirm as owner (applies supersession)
          </button>
        </div>
      ) : null}

      {confirmResult ? (
        <div className="mt-3 rounded-2xl border border-ck-green/40 bg-ck-green/10 p-3 text-xs text-ck-green">
          <p className="font-semibold">Correction applied.</p>
          <p className="mt-1">
            {confirmResult.acceptedRecordIds.length} record(s) accepted ·{" "}
            {confirmResult.supersededRecordIds.length} superseded ·{" "}
            {confirmResult.confirmedSupersessionIds.length} supersession(s) confirmed.
          </p>
        </div>
      ) : null}
    </div>
  );
}
