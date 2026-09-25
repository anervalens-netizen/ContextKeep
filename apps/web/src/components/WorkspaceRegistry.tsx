import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ProjectDto,
  WorkspaceActionInput,
  WorkspaceReconciliationDto,
  WorkspaceReconciliationItemDto,
  WorkspaceScanResultDto,
} from "@contextkeep/shared";
import { apiFetch } from "../lib/api.js";
import { queryRoots } from "../lib/query-contracts.js";
import { Icon } from "./Icon.js";

function shortDate(value: string | null): string {
  if (!value) return "No activity yet";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}

function laterActivity(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

function suggestionLabel(item: WorkspaceReconciliationItemDto): string {
  const suggestion = item.suggestion;
  if (suggestion.action === "link") return `Suggested: link to ${suggestion.projectName ?? "existing project"}`;
  if (suggestion.action === "track") return "Suggested: track as a new project";
  if (suggestion.action === "ignore") return "Suggested: ignore as a tool / third-party workspace";
  return "Needs owner review";
}

export function WorkspaceRegistry({ projects }: { projects: ProjectDto[] }): ReactNode {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [linkTargets, setLinkTargets] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);

  const query = useQuery({
    queryKey: ["workspace-reconciliation"],
    queryFn: () => apiFetch<WorkspaceReconciliationDto>("/api/workspaces/reconciliation"),
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["workspace-reconciliation"] });
  };

  const scan = async (): Promise<void> => {
    setBusy("scan");
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetch<WorkspaceScanResultDto>("/api/workspaces/scan", {
        method: "POST",
        body: {},
        label: "Scan server workspaces",
      });
      await refresh();
      setNotice(`Found ${result.discoveredCount} workspace${result.discoveredCount === 1 ? "" : "s"} · ${result.insertedCount} new · ${result.updatedCount} refreshed.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Workspace scan failed.");
    } finally {
      setBusy(null);
    }
  };

  const act = async (item: WorkspaceReconciliationItemDto, input: WorkspaceActionInput): Promise<void> => {
    setBusy(item.workspace.id);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/workspaces/${item.workspace.id}/action`, {
        method: "POST",
        body: input,
        label: `Workspace ${input.action}`,
      });
      if (input.action === "track") await queryClient.invalidateQueries({ queryKey: queryRoots.projects });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Workspace ${input.action} failed.`);
    } finally {
      setBusy(null);
    }
  };

  const data = query.data;
  const items = data?.items ?? [];
  const unresolved = items.filter((item) => item.status === "unresolved");
  const resolved = items.filter((item) => item.status !== "unresolved");
  const seededIds = new Set(data?.seededProjectIds ?? []);
  const seededProjects = projects.filter((project) => seededIds.has(project.id));

  const row = (item: WorkspaceReconciliationItemDto): ReactNode => {
    const workspace = item.workspace;
    const suggestedProject = item.suggestion.action === "link" ? (item.suggestion.projectId ?? "") : "";
    const selectedProject = linkTargets[workspace.id] ?? suggestedProject;
    const isBusy = busy === workspace.id;
    const codexSessions = item.history.codexCurrentCount + item.history.codexArchivedCount;
    const summaries = item.history.codexSummaryCount;
    const dshSessions = item.history.dshSessionCount;
    const sessionCount = codexSessions + dshSessions;
    const latestActivity = laterActivity(item.history.lastAgentActivity, workspace.lastObservedActivity);

    return (
      <li key={workspace.id} className="rounded-2xl border border-ck-line bg-ck-surface p-3">
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-ck-ink">{workspace.displayName}</h3>
              {item.status === "tracked" || item.status === "linked" ? (
                <span className="rounded-full bg-ck-teal-soft px-2 py-0.5 text-[11px] font-medium text-ck-teal-dark">{item.status === "tracked" ? "Tracked" : "Linked"} · {workspace.projectName ?? "project"}</span>
              ) : item.status === "ignored" ? (
                <span className="rounded-full border border-ck-line px-2 py-0.5 text-[11px] text-ck-muted">Ignored</span>
              ) : (
                <span className="rounded-full border border-ck-amber/40 bg-ck-amber/10 px-2 py-0.5 text-[11px] text-ck-amber">Needs decision</span>
              )}
            </div>

            <p className="mt-1 text-xs text-ck-muted">Last mapped activity: {shortDate(latestActivity)}{workspace.gitBranch ? ` · ${workspace.gitBranch}` : ""}</p>
            <p className="mt-1 text-[11px] text-ck-muted">
              {sessionCount > 0 ? `${sessionCount} mapped agent sessions · Codex ${codexSessions} · DSH ${dshSessions}${summaries > 0 ? ` · ${summaries} summaries` : ""}` : "No mapped agent sessions"}
            </p>

            {item.status === "unresolved" ? (
              <div className="mt-2 rounded-xl border border-ck-line bg-ck-bg p-2">
                <p className="text-xs font-medium text-ck-ink">{suggestionLabel(item)}{item.suggestion.confidence ? ` · ${item.suggestion.confidence} confidence` : ""}</p>
                {item.suggestion.reason ? <p className="mt-0.5 text-[11px] text-ck-muted">{item.suggestion.reason}</p> : null}
                <p className="mt-1 text-[10px] uppercase tracking-wide text-ck-muted">Suggestion only — nothing happens until you choose an action.</p>
              </div>
            ) : null}

            <details className="mt-2 text-[11px] text-ck-muted">
              <summary className="cursor-pointer select-none text-ck-teal">Workspace details</summary>
              <div className="mt-1 space-y-0.5 break-all rounded-lg bg-ck-bg p-2 font-mono">
                <p>{workspace.canonicalPath}</p>
                {workspace.gitRemote ? <p>{workspace.gitRemote}</p> : null}
                {workspace.gitHeadSha ? <p>HEAD {workspace.gitHeadSha.slice(0, 12)}</p> : null}
              </div>
            </details>
          </div>
        </div>

        {item.status === "ignored" ? (
          <button type="button" disabled={isBusy} onClick={() => void act(item, { action: "unignore", expectedUpdatedAt: workspace.updatedAt })} className="mt-2 rounded-lg border border-ck-line px-3 py-1.5 text-xs font-medium text-ck-ink disabled:opacity-50">Undo ignore</button>
        ) : workspace.projectId ? (
          <div className="mt-2 flex items-center gap-2">
            {workspace.projectLifecycle ? <span className="text-xs text-ck-muted">Lifecycle: {workspace.projectLifecycle}</span> : null}
            <button type="button" disabled={isBusy} onClick={() => void act(item, { action: "unlink", expectedUpdatedAt: workspace.updatedAt })} className="ml-auto rounded-lg border border-ck-line px-3 py-1.5 text-xs font-medium text-ck-muted disabled:opacity-50">Unlink</button>
          </div>
        ) : (
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <select value={selectedProject} onChange={(e) => setLinkTargets((current) => ({ ...current, [workspace.id]: e.target.value }))} aria-label={`Existing project for ${workspace.displayName}`} className="min-w-0 flex-1 rounded-lg border border-ck-line bg-ck-bg px-2 py-1.5 text-xs">
              <option value="">Link to existing project…</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name} ({project.lifecycle}){seededIds.has(project.id) ? " · demo seed" : ""}</option>)}
            </select>
            <button type="button" disabled={isBusy || !selectedProject} onClick={() => void act(item, { action: "link", projectId: selectedProject, expectedUpdatedAt: workspace.updatedAt })} className="rounded-lg border border-ck-teal px-3 py-1.5 text-xs font-semibold text-ck-teal disabled:opacity-40">Link</button>
            <button type="button" disabled={isBusy} onClick={() => void act(item, { action: "track", expectedUpdatedAt: workspace.updatedAt })} className="rounded-lg bg-ck-teal px-3 py-1.5 text-xs font-semibold text-on-brand disabled:opacity-50">Track as project</button>
            <button type="button" disabled={isBusy} onClick={() => void act(item, { action: "ignore", expectedUpdatedAt: workspace.updatedAt })} className="rounded-lg border border-ck-line px-3 py-1.5 text-xs font-medium text-ck-muted disabled:opacity-50">Ignore</button>
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="rounded-3xl border border-ck-line bg-ck-surface shadow-xs" aria-labelledby="server-workspaces-title">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-ck-bg text-ck-teal"><Icon name="branch" className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1">
          <h2 id="server-workspaces-title" className="text-sm font-semibold">Workspace setup</h2>
          <p className="mt-0.5 text-xs text-ck-muted">
            {query.isLoading ? "Checking server workspaces…" : query.isError ? "Could not load workspace setup." : unresolved.length > 0 ? `${unresolved.length} workspace${unresolved.length === 1 ? "" : "s"} still need a decision · ${data?.tracked ?? 0} tracked` : "All observed workspaces have a decision."}
          </p>
        </div>
        <button type="button" disabled={busy !== null} onClick={() => void scan()} className="rounded-lg border border-ck-line px-3 py-1.5 text-xs font-medium text-ck-muted disabled:opacity-50">{busy === "scan" ? "Scanning…" : "Scan"}</button>
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="rounded-lg border border-ck-teal px-3 py-1.5 text-xs font-semibold text-ck-teal">
          {expanded ? "Hide setup" : unresolved.length > 0 ? `Review ${unresolved.length}` : "View setup"}
        </button>
      </div>

      {error ? <p role="alert" className="mx-4 mb-3 rounded-lg border border-ck-red/30 bg-ck-red/5 p-2 text-xs text-ck-red">{error}</p> : null}
      {notice ? <p role="status" className="mx-4 mb-3 rounded-lg border border-ck-line bg-ck-bg p-2 text-xs text-ck-muted">{notice}</p> : null}

      {expanded ? (
        <div className="border-t border-ck-line p-4">
          {data ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-xl bg-ck-bg p-2"><p className="text-lg font-semibold">{data.unresolved}</p><p className="text-[11px] text-ck-muted">Needs decision</p></div>
              <div className="rounded-xl bg-ck-bg p-2"><p className="text-lg font-semibold">{data.tracked}</p><p className="text-[11px] text-ck-muted">Tracked</p></div>
              <div className="rounded-xl bg-ck-bg p-2"><p className="text-lg font-semibold">{data.linked}</p><p className="text-[11px] text-ck-muted">Linked</p></div>
              <div className="rounded-xl bg-ck-bg p-2"><p className="text-lg font-semibold">{data.ignored}</p><p className="text-[11px] text-ck-muted">Ignored</p></div>
            </div>
          ) : null}

          {data && (!data.codexCatalogAvailable || !data.dshCatalogAvailable) ? <p className="mt-2 text-xs text-ck-amber">Some agent-history metadata is unavailable; setup actions remain usable.</p> : null}
          {seededProjects.length > 0 ? <p className="mt-2 rounded-lg border border-ck-amber/30 bg-ck-amber/5 p-2 text-xs text-ck-muted">Demo-seeded projects still present: {seededProjects.map((project) => project.name).join(", ")}. They are marked in the Link menu and are not treated as canonical matches automatically.</p> : null}
          {query.isError ? <p className="mt-3 text-xs text-ck-red">Could not load workspace setup.</p> : null}
          {!query.isLoading && !query.isError && items.length === 0 ? <p className="mt-3 rounded-xl border border-dashed border-ck-line p-3 text-xs text-ck-muted">No workspaces indexed yet. Scan the configured server folders to discover them.</p> : null}

          {unresolved.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ck-muted">Needs decision ({unresolved.length})</h3>
              <ul className="mt-2 space-y-2">{unresolved.map(row)}</ul>
            </div>
          ) : data && data.total > 0 ? <p className="mt-3 rounded-xl border border-ck-teal/30 bg-ck-teal-soft/40 p-3 text-xs text-ck-teal-dark">All observed workspaces have a reconciliation decision.</p> : null}

          {resolved.length > 0 ? (
            <details className="mt-4 rounded-xl border border-ck-line bg-ck-surface p-3">
              <summary className="cursor-pointer text-xs font-medium text-ck-muted">Resolved workspaces ({resolved.length})</summary>
              <ul className="mt-2 space-y-2">{resolved.map(row)}</ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
