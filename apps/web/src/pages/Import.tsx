import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ImportPreviewDto, ProjectDto } from "@contextkeep/shared";
import { apiFetch, ApiError } from "../lib/api.js";
import { readMeta } from "../lib/provenance-query.js";
import { queryKeys } from "../lib/query-contracts.js";
import type { ConflictEntry } from "../lib/offline/db.js";
import * as offlineQueue from "../lib/offline/queue.js";
import { isLocalDataAccessPaused } from "../lib/offline/local-data-state.js";
import { isQueued, reportQueued } from "../lib/hooks.js";
import { useUiStore } from "../state/ui.js";
import { debounce } from "../lib/debounce.js";

const CANDIDATE_LINE =
  /^(fact|decision|action|question|constraint|observed|owner-claim)\s*:|^status:\s*done\s*[—–-]/i;

export default function Import(): ReactNode {
  const queryClient = useQueryClient();
  const search = useSearch({ from: "/import" });
  const [mode, setMode] = useState<"text" | "file">("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(() => search.projectId ?? "");
  const [adapterId, setAdapterId] = useState("manual");
  const [eventAt, setEventAt] = useState("");
  const [authorLabel, setAuthorLabel] = useState("");
  const [confirmOf, setConfirmOf] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportPreviewDto | null>(null);
  const [replayedConflict, setReplayedConflict] = useState<ConflictEntry | null>(null);
  const [previewLines, setPreviewLines] = useState(0);

  const meta = useQuery({ queryKey: queryKeys.meta, queryFn: readMeta });
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: () => apiFetch<ProjectDto[]>("/api/projects") });

  useEffect(() => {
    if (isLocalDataAccessPaused()) return;
    let cancelled = false;
    void (async () => {
      const { listConflicts } = offlineQueue;
      const pending = (await listConflicts()).find((c) => c.code === "near_duplicate_pending" && c.response);
      if (cancelled || !pending) return;
      setReplayedConflict(pending);
      setResult(pending.response as ImportPreviewDto);
    })().catch(() => {
      if (!cancelled) useUiStore.getState().setNotice({ kind: "error", text: "Saved offline import previews could not be read. No queued operation was changed." });
    });
    return () => { cancelled = true; };
  }, []);

  // Debounce expensive parsing of long pastes (handoff §9: ≤200ms interactions).
  useEffect(() => {
    const count = debounce((t: string) => {
      setPreviewLines(t.split("\n").filter((l) => CANDIDATE_LINE.test(l.trim())).length);
    }, 200);
    count(text);
    return () => count.cancel();
  }, [text]);

  const buildBody = (bodyText: string, kind: "paste" | "upload", filename: string | null): Record<string, unknown> => ({
    text: bodyText,
    kind,
    title: title || filename || null,
    originalFilename: filename,
    projectId: projectId || null,
    adapterId,
    eventAt: eventAt ? new Date(eventAt).toISOString() : null,
    authorLabel: authorLabel || null,
    confirmNearDuplicateOf: confirmOf,
  });

  const afterSuccess = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    void queryClient.invalidateQueries({ queryKey: ["sources"] });
  };

  const clearReplayedConflict = async (): Promise<void> => {
    if (replayedConflict?.seq === undefined) return;
    const q = offlineQueue;
    await q.dismissConflict(replayedConflict.seq);
    useUiStore.getState().setConflicts(await q.listConflicts());
    setReplayedConflict(null);
  };

  const resumeReplayedImport = async (confirmation: string | null): Promise<void> => {
    if (!replayedConflict || !replayedConflict.mutation.body || typeof replayedConflict.mutation.body !== "object") return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        ...(replayedConflict.mutation.body as Record<string, unknown>),
        confirmNearDuplicateOf: confirmation,
      };
      const dto = await apiFetch<ImportPreviewDto>("/api/imports/text", {
        method: "POST",
        body,
        label: "Confirm queued import",
      });
      setResult(dto);
      if (dto.status !== "near_duplicate_pending") {
        await clearReplayedConflict();
        setConfirmOf(null);
        afterSuccess();
      }
    } catch (e) {
      if (isQueued(e)) await reportQueued(e, "Import confirmation");
      else setError(e instanceof ApiError ? e.message : "Import confirmation failed.");
    } finally {
      setBusy(false);
    }
  };

  const submitText = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const dto = await apiFetch<ImportPreviewDto>("/api/imports/text", {
        method: "POST",
        body: buildBody(text, "paste", null),
        label: "Import pasted text",
      });
      setResult(dto);
      if (dto.status === "created") {
        setText("");
        setConfirmOf(null);
        afterSuccess();
      }
    } catch (e) {
      if (isQueued(e)) {
        await reportQueued(e, "Import");
        setResult(null);
      } else setError(e instanceof ApiError ? e.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  };

  const submitFile = async (confirmation: string | null = confirmOf): Promise<void> => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      if (file.size > 4 * 1024 * 1024) throw new ApiError(413, "file_too_large", "File exceeds the 4 MiB import limit.");
      const asText = await file.text();
      const body = buildBody(asText, "upload", file.name);
      body.confirmNearDuplicateOf = confirmation;
      // Browser file imports use the same JSON/idempotency/offline queue path
      // as pasted text. This removes the multipart replay hole and guarantees
      // near-duplicate confirmation uses the exact requested value.
      const dto = await apiFetch<ImportPreviewDto>("/api/imports/text", {
        method: "POST",
        body,
        label: `Import file ${file.name}`,
      });
      setResult(dto);
      if (dto.status === "created") {
        setFile(null);
        setConfirmOf(null);
        afterSuccess();
      }
    } catch (e) {
      if (isQueued(e)) {
        await reportQueued(e, "File import");
        setResult(null);
      } else setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  const projects = projectsQuery.data ?? [];

  useEffect(() => {
    if (!projectsQuery.isSuccess || !projectId) return;
    if (!projects.some((project) => project.id === projectId)) setProjectId("");
  }, [projectId, projects, projectsQuery.isSuccess]);

  return (
    <div>
      <h1 className="text-base font-semibold">Import material</h1>
      <p className="mt-1 text-xs text-ck-muted">
        Paste a conversation/handoff or upload a .md/.txt file. Nothing is accepted automatically — candidates land in
        the review inbox (handoff §4B, §8).
      </p>

      <div className="mt-3 flex gap-1 rounded-xl border border-ck-line bg-ck-surface p-1">
        {(["text", "file"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold capitalize ${
              mode === m ? "bg-ck-teal text-on-brand" : "text-ck-muted"
            }`}
          >
            {m === "text" ? "Paste text" : "Upload file"}
          </button>
        ))}
      </div>

      <div className="mt-3 space-y-2 rounded-2xl border border-ck-line bg-ck-surface p-3">
        {mode === "text" ? (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              placeholder={"Paste Markdown or plain text…\n\nFakeTest adapter recognizes lines like:\nfact: …\ndecision: …\naction: …\nquestion: …\nconstraint: …"}
              className="w-full rounded-xl border border-ck-line bg-ck-bg px-3 py-2 font-mono text-xs"
            />
            <p className="text-[11px] text-ck-muted">
              {text.length.toLocaleString()} chars
              {adapterId === "faketest" ? ` · ~${previewLines} candidate line(s) detected` : " · Manual adapter extracts nothing"}
            </p>
          </>
        ) : (
          <input
            type="file"
            accept=".md,.txt,text/markdown,text/plain"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="w-full rounded-xl border border-ck-line bg-ck-bg px-3 py-2 text-xs"
          />
        )}

        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (optional)"
          className="w-full rounded-xl border border-ck-line bg-ck-bg px-3 py-2 text-sm"
        />
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="w-full rounded-xl border border-ck-line bg-ck-bg px-3 py-2 text-sm"
        >
          <option value="">Unassigned (no project)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} {p.lifecycle === "retired" ? "(retired)" : ""}
            </option>
          ))}
        </select>
        <select
          value={adapterId}
          onChange={(e) => setAdapterId(e.target.value)}
          className="w-full rounded-xl border border-ck-line bg-ck-bg px-3 py-2 text-sm"
        >
          {(meta.data?.data.adapters ?? [{ id: "manual", label: "Manual", enabled: true }])
            .filter((a) => a.enabled)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
        </select>
        <div className="flex gap-2">
          <label className="flex-1 text-xs text-ck-muted">
            Event date (optional)
            <input
              type="date"
              value={eventAt}
              onChange={(e) => setEventAt(e.target.value)}
              className="mt-1 w-full rounded-xl border border-ck-line bg-ck-bg px-3 py-2 text-sm"
            />
          </label>
          <label className="flex-1 text-xs text-ck-muted">
            Author label
            <input
              value={authorLabel}
              onChange={(e) => setAuthorLabel(e.target.value)}
              placeholder="e.g. codex-memory"
              className="mt-1 w-full rounded-xl border border-ck-line bg-ck-bg px-3 py-2 text-sm"
            />
          </label>
        </div>

        {error ? <p className="rounded-lg border border-ck-red/40 bg-ck-red/10 p-2 text-xs text-ck-red">{error}</p> : null}

        <button
          type="button"
          disabled={busy || (mode === "text" ? !text.trim() : !file)}
          onClick={() => void (mode === "text" ? submitText() : submitFile())}
          className="w-full rounded-xl bg-ck-teal px-3 py-2 text-sm font-semibold text-on-brand disabled:opacity-50"
        >
          {busy ? "Importing…" : confirmOf ? "Import anyway (near-duplicate confirmed)" : "Import"}
        </button>
      </div>

      {result ? (
        <div className="mt-3 rounded-2xl border border-ck-line bg-ck-surface p-3 text-xs">
          {result.status === "created" ? (
            <>
              <p className="font-semibold text-ck-green">
                Imported: {result.excerptCount} excerpt(s), {result.candidateCount} candidate record(s).
              </p>
              <p className="mt-1 text-ck-muted">
                Review them in the <Link to="/inbox" search={{ projectId: projectId || undefined, page: 1 }} className="text-ck-teal underline">inbox</Link>.
              </p>
            </>
          ) : null}
          {result.status === "duplicate_skipped" ? (
            <p className="font-semibold text-ck-amber">
              Exact duplicate (A1) — already imported as “{result.duplicateOf?.title ?? result.duplicateOf?.sourceId}”.
              Nothing was created.
            </p>
          ) : null}
          {result.status === "near_duplicate_pending" ? (
            <>
              <p className="font-semibold text-ck-amber">Near-duplicate source(s) detected — explicit confirmation required (A1):</p>
              <ul className="mt-1 space-y-1">
                {result.nearDuplicates.map((n) => (
                  <li key={n.sourceId} className="rounded-lg border border-ck-line bg-ck-bg p-2">
                    “{n.title ?? n.sourceId}” · similarity {(n.similarity * 100).toFixed(1)}% · imported{" "}
                    {n.importedAt.slice(0, 10)}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => {
                  setConfirmOf(result.nearDuplicates[0]?.sourceId ?? null);
                  setResult(null);
                  const confirmation = result.nearDuplicates[0]?.sourceId ?? null;
                  if (replayedConflict) void resumeReplayedImport(confirmation);
                  else if (mode === "text") void submitTextWith(confirmation);
                  else void submitFileWith(confirmation);
                }}
                className="mt-2 w-full rounded-xl border border-ck-amber px-3 py-2 text-xs font-semibold text-ck-amber"
              >
                Import anyway (I have reviewed the near-duplicates)
              </button>
            </>
          ) : null}
          {result.warnings.length > 0 ? (
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-ck-muted">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  function submitTextWith(confirmation: string | null): Promise<void> {
    const previous = confirmOf;
    setConfirmOf(confirmation);
    // submitText reads confirmOf from state; pass through a direct call instead.
    return submitWith(confirmation, previous);
  }

  function submitFileWith(confirmation: string | null): Promise<void> {
    return submitFile(confirmation);
  }

  async function submitWith(confirmation: string | null, _previous: string | null): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const body = buildBody(mode === "text" ? text : await (file?.text() ?? ""), mode === "text" ? "paste" : "upload", mode === "file" ? (file?.name ?? null) : null);
      body.confirmNearDuplicateOf = confirmation;
      if (mode === "text") {
        const dto = await apiFetch<ImportPreviewDto>("/api/imports/text", {
          method: "POST",
          body,
          label: "Import (near-duplicate confirmed)",
        });
        setResult(dto);
        if (dto.status === "created") {
          setText("");
          setConfirmOf(null);
          afterSuccess();
        }
      } else if (file) {
        await submitFile(confirmation);
      }
    } catch (e) {
      if (isQueued(e)) await reportQueued(e, "Import");
      else setError(e instanceof ApiError ? e.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }
}
