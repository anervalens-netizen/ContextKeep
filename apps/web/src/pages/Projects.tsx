import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectDto, WorkspaceReconciliationDto, WorkspaceReconciliationItemDto } from "@contextkeep/shared";
import { apiFetch, ApiError, isNetworkUnavailableError } from "../lib/api.js";
import { PROJECTS_KEY, readCache, saveToCache } from "../lib/offline/mirror.js";
import { LifecycleBadge } from "../components/Badge.js";
import { WorkspaceRegistry } from "../components/WorkspaceRegistry.js";
import { Icon } from "../components/Icon.js";
import { isQueued, notifyError, reportQueued } from "../lib/hooks.js";
import { partitionProjectVisibility } from "../lib/project-visibility.js";

export const LAST_PROJECT_KEY = "ck:last-project";

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function relativeTime(value: string | null): string {
  if (!value) return "No activity yet";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  const delta = Date.now() - ms;
  if (delta < 60_000) return "Just now";
  if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

function initials(name: string): string {
  const parts = name.split(/[\s/_-]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : name.slice(0, 2)).toUpperCase();
}

function itemStats(item: WorkspaceReconciliationItemDto) {
  const codexSessions = item.history.codexCurrentCount + item.history.codexArchivedCount;
  const summaries = item.history.codexSummaryCount;
  const dshSessions = item.history.dshSessionCount;
  return {
    codexSessions,
    summaries,
    dshSessions,
    sessions: codexSessions + dshSessions,
  };
}

export default function Projects(): ReactNode {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState<string>("");
  const [formError, setFormError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: async () => {
      try {
        let fetchedAt: string | undefined;
        const data = await apiFetch<ProjectDto[]>("/api/projects", {
          onDataProvenance: (meta) => { fetchedAt = meta.fetchedAt; },
        });
        void saveToCache(PROJECTS_KEY, data, { fetchedAt, scope: "projects:list", cursor: null });
        setFromCache(false);
        return data;
      } catch (e) {
        if (!isNetworkUnavailableError(e)) throw e;
        const cached = await readCache<ProjectDto[]>(PROJECTS_KEY, "projects:list");
        if (cached) {
          setFromCache(true);
          return cached.value;
        }
        throw e;
      }
    },
  });

  const reconciliationQuery = useQuery({
    queryKey: ["workspace-reconciliation"],
    queryFn: () => apiFetch<WorkspaceReconciliationDto>("/api/workspaces/reconciliation"),
    retry: false,
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("source") === "pwa") {
      const last = localStorage.getItem(LAST_PROJECT_KEY);
      if (last) void navigate({ to: "/projects/$projectId", params: { projectId: last }, search: { recordId: undefined }, replace: true });
    }
  }, [navigate]);

  const openProject = (id: string): void => localStorage.setItem(LAST_PROJECT_KEY, id);

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setFormError(null);
    try {
      await apiFetch<ProjectDto>("/api/projects", {
        method: "POST",
        body: { name, description: description || null, parentId: parentId || null },
        label: `Create project ${name}`,
      });
      setName("");
      setDescription("");
      setParentId("");
      setShowForm(false);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["workspace-reconciliation"] });
    } catch (err) {
      if (isQueued(err)) await reportQueued(err, "Project creation");
      else if (err instanceof ApiError) setFormError(err.message);
      else notifyError(err, "Could not create the project.");
    }
  };

  const projects = projectsQuery.data ?? [];
  const reconciliation = reconciliationQuery.data;

  const itemsByProject = useMemo(() => {
    const map = new Map<string, WorkspaceReconciliationItemDto[]>();
    for (const item of reconciliation?.items ?? []) {
      const id = item.workspace.projectId;
      if (!id) continue;
      const list = map.get(id) ?? [];
      list.push(item);
      map.set(id, list);
    }
    return map;
  }, [reconciliation]);

  const signalsFor = (projectId: string) => {
    const items = itemsByProject.get(projectId) ?? [];
    let sessionLatest: string | null = null;
    let repoLatest: string | null = null;
    let codexSessions = 0;
    let summaries = 0;
    let dshSessions = 0;
    for (const item of items) {
      const stats = itemStats(item);
      codexSessions += stats.codexSessions;
      summaries += stats.summaries;
      dshSessions += stats.dshSessions;
      sessionLatest = later(sessionLatest, item.history.lastSessionActivity ?? null);
      repoLatest = later(repoLatest, item.workspace.lastObservedActivity);
    }
    return {
      items,
      sessionLatest,
      repoLatest,
      codexSessions,
      summaries,
      dshSessions,
      sessions: codexSessions + dshSessions,
    };
  };

  const sorted = [...projects].sort((a, b) => {
    const aSignal = signalsFor(a.id);
    const bSignal = signalsFor(b.id);
    if (aSignal.sessionLatest && bSignal.sessionLatest && aSignal.sessionLatest !== bSignal.sessionLatest) {
      return Date.parse(bSignal.sessionLatest) - Date.parse(aSignal.sessionLatest);
    }
    if (aSignal.sessionLatest && !bSignal.sessionLatest) return -1;
    if (!aSignal.sessionLatest && bSignal.sessionLatest) return 1;
    if (aSignal.repoLatest && bSignal.repoLatest && aSignal.repoLatest !== bSignal.repoLatest) {
      return Date.parse(bSignal.repoLatest) - Date.parse(aSignal.repoLatest);
    }
    if (aSignal.repoLatest && !bSignal.repoLatest) return -1;
    if (!aSignal.repoLatest && bSignal.repoLatest) return 1;
    return a.name.localeCompare(b.name);
  });

  const { active, inactive } = partitionProjectVisibility(sorted);
  const mappedSessions = (reconciliation?.items ?? []).filter((i) => i.workspace.projectId).reduce((sum, item) => sum + itemStats(item).sessions, 0);

  const projectCard = (p: ProjectDto): ReactNode => {
    const signal = signalsFor(p.id);
    const primaryActivity = signal.sessionLatest ?? signal.repoLatest;
    const hasAgentHistory = signal.sessions > 0 || signal.summaries > 0;
    const activityLabel = signal.sessionLatest ? `Worked ${relativeTime(signal.sessionLatest)}` : signal.repoLatest ? `Repo activity ${relativeTime(signal.repoLatest)}` : "No activity yet";
    return (
      <li key={p.id}>
        <Link
          to="/projects/$projectId"
          params={{ projectId: p.id }}
          search={{ recordId: undefined }}
          onClick={() => openProject(p.id)}
          className="group block rounded-3xl border border-ck-line bg-ck-surface p-4 shadow-sm transition duration-150 hover:-translate-y-0.5 hover:border-ck-teal/30 hover:shadow-md active:translate-y-0 active:bg-ck-teal-soft/30"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-ck-teal-soft text-sm font-bold tracking-tight text-ck-teal-dark">
              {initials(p.name)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-[15px] font-semibold tracking-tight text-ck-ink">{p.name}</h2>
                <LifecycleBadge state={p.lifecycle} />
              </div>
              {p.aliases.length > 0 ? <p className="mt-1 truncate text-[11px] text-ck-muted">Aliases: {p.aliases.join(", ")}</p> : null}
              {p.description ? <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ck-muted">{p.description}</p> : null}
              {!p.description && hasAgentHistory ? (
                <p className="mt-1 text-xs text-ck-muted">Work history detected from your Dell agent history.</p>
              ) : null}
            </div>
            <Icon name="chevron-right" className="mt-2 h-4 w-4 shrink-0 text-ck-muted transition-transform group-hover:translate-x-0.5" />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-ck-line pt-3 text-[11px] text-ck-muted">
            <span className="inline-flex items-center gap-1.5">
              <Icon name="clock" className="h-3.5 w-3.5" />
              {activityLabel}
            </span>
            {hasAgentHistory ? (
              <>
                <span className="inline-flex items-center gap-1.5"><Icon name="archive" className="h-3.5 w-3.5" />{signal.sessions > 0 ? `${signal.sessions} agent sessions${signal.summaries > 0 ? ` + ${signal.summaries} summaries` : ""}` : `${signal.summaries} Codex summaries`}</span>
                <span className="ml-auto font-medium text-ck-teal">Codex {signal.codexSessions} · DSH {signal.dshSessions}</span>
              </>
            ) : signal.items.length > 0 ? (
              <span className="ml-auto">Workspace linked</span>
            ) : null}
          </div>
          {primaryActivity && !signal.sessionLatest && signal.items.length > 0 ? <p className="mt-2 text-[10px] text-ck-muted">No mapped agent session yet; showing repository activity only.</p> : null}
        </Link>
      </li>
    );
  };

  return (
    <div className="space-y-6">
      <section className="pt-1">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ck-teal">Context workspace</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ck-ink sm:text-3xl">Your projects</h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ck-muted">Recent agent work comes first. Repo and server activity stay secondary until they become reviewed project knowledge.</p>
          </div>
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl bg-ck-teal px-3.5 py-2 text-xs font-semibold text-on-brand shadow-sm transition hover:brightness-95"
          >
            <Icon name={showForm ? "more" : "plus"} className="h-4 w-4" />
            <span className="hidden sm:inline">{showForm ? "Close" : "New project"}</span>
          </button>
        </div>

        {fromCache ? <p className="mt-2 text-xs text-ck-amber">Offline — showing the last loaded project list.</p> : null}

        <div className="mt-4 grid grid-cols-3 gap-2 sm:max-w-xl sm:gap-3">
          <div className="rounded-2xl border border-ck-line bg-ck-surface px-3 py-3 shadow-xs">
            <p className="text-xl font-semibold tracking-tight text-ck-ink">{active.length}</p>
            <p className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-ck-muted">Active</p>
          </div>
          <div className="rounded-2xl border border-ck-line bg-ck-surface px-3 py-3 shadow-xs">
            <p className="text-xl font-semibold tracking-tight text-ck-ink">{mappedSessions}</p>
            <p className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-ck-muted">Agent sessions</p>
          </div>
          <div className="rounded-2xl border border-ck-line bg-ck-surface px-3 py-3 shadow-xs">
            <p className={`text-xl font-semibold tracking-tight ${reconciliation?.unresolved ? "text-ck-amber" : "text-ck-ink"}`}>{reconciliation?.unresolved ?? "—"}</p>
            <p className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-ck-muted">To classify</p>
          </div>
        </div>
      </section>

      {showForm ? (
        <form onSubmit={(e) => void create(e)} className="rounded-3xl border border-ck-line bg-ck-surface p-4 shadow-md">
          <div className="mb-3"><h2 className="text-sm font-semibold text-ck-ink">Create a canonical project</h2><p className="mt-0.5 text-xs text-ck-muted">Use this for knowledge you want ContextKeep to manage independently of server discovery.</p></div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project or component name" className="w-full rounded-xl border border-ck-line bg-ck-bg px-3 py-2.5 text-sm" required />
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" rows={2} className="mt-2 w-full rounded-xl border border-ck-line bg-ck-bg px-3 py-2.5 text-sm" />
          <select value={parentId} onChange={(e) => setParentId(e.target.value)} className="mt-2 w-full rounded-xl border border-ck-line bg-ck-bg px-3 py-2.5 text-sm">
            <option value="">No parent (top level)</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {formError ? <p className="mt-2 text-xs text-ck-red">{formError}</p> : null}
          <button type="submit" className="mt-3 w-full rounded-xl bg-ck-teal px-3 py-2.5 text-sm font-semibold text-on-brand">Create project</button>
        </form>
      ) : null}

      {projectsQuery.isLoading ? <p className="rounded-2xl border border-ck-line bg-ck-surface p-4 text-sm text-ck-muted">Loading your workspace…</p> : null}
      {projectsQuery.isError ? <p className="rounded-2xl border border-ck-red/30 bg-ck-red/5 p-4 text-sm text-ck-red">Could not load projects and no cached copy exists. Reconnect and retry.</p> : null}

      {active.length > 0 ? (
        <section>
          <div className="mb-2 flex items-end justify-between gap-2">
            <div><h2 className="text-sm font-semibold text-ck-ink">Active projects</h2><p className="mt-0.5 text-xs text-ck-muted">Sorted by your most recent mapped agent session, then repo activity.</p></div>
          </div>
          <ul className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">{active.map(projectCard)}</ul>
        </section>
      ) : null}

      {projects.length === 0 && projectsQuery.isSuccess ? (
        <div className="rounded-3xl border border-dashed border-ck-line bg-ck-surface p-6 text-center">
          <Icon name="projects" className="mx-auto h-7 w-7 text-ck-teal" />
          <h2 className="mt-2 text-sm font-semibold">No canonical projects yet</h2>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-ck-muted">Create one, or classify a discovered server workspace below. Observed workspaces stay separate until you explicitly track or link them.</p>
        </div>
      ) : null}

      {inactive.length > 0 ? (
        <details className="rounded-2xl border border-ck-line bg-ck-surface p-3">
          <summary className="cursor-pointer select-none text-xs font-medium text-ck-muted">Inactive / historical projects ({inactive.length})</summary>
          <p className="mt-2 text-[11px] text-ck-muted">Planned, paused, unknown and retired projects stay out of the main workspace until you need them.</p>
          <ul className="mt-3 grid gap-2 md:grid-cols-2">{inactive.map(projectCard)}</ul>
        </details>
      ) : null}

      <WorkspaceRegistry projects={projects} />
    </div>
  );
}
