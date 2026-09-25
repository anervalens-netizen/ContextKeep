import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BriefDto,
  HandoffExportDto,
  TimelineDto,
  WorkspaceReconciliationDto,
  WorkspaceReconciliationItemDto,
  RecordDto,
} from "@contextkeep/shared";
import { apiFetch, ApiError, isNetworkUnavailableError } from "../lib/api.js";
import { briefKey, readCache, saveToCache } from "../lib/offline/mirror.js";
import { LifecycleBadge, StatusBadge } from "../components/Badge.js";
import { Icon, type IconName } from "../components/Icon.js";
import { ProjectHistoryBackfill } from "../components/ProjectHistoryBackfill.js";
import { ProjectMemoryDashboard } from "../components/ProjectMemoryDashboard.js";
import { RecordCard } from "../components/RecordCard.js";
import { VirtualList } from "../components/VirtualList.js";
import { notifyError } from "../lib/hooks.js";
import { describeReadError, formatLocalDateTime } from "../lib/presentation.js";
import { queryKeys, queryRoots } from "../lib/query-contracts.js";

type Tab = "overview" | "timeline" | "export";

type ProjectFreshness = {
  projectId: string;
  cursor: number;
  contentCursor: number;
  workingCursor: number;
  workingMemoryVersion: number;
  changed: boolean;
  delta: number;
  resetRequired: boolean;
  workingChanged: boolean;
  workingDelta: number;
  workingResetRequired: boolean;
};

const PROJECT_FRESHNESS_INTERVAL_MS = 5_000;

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

export default function ProjectDetail(): ReactNode {
  const params = useParams({ strict: false }) as { projectId?: string };
  const projectId = params.projectId ?? "";
  const search = useSearch({ from: "/projects/$projectId" });
  const recordId = search.recordId;
  const [tab, setTab] = useState<Tab>("overview");
  const queryClient = useQueryClient();
  const freshnessCursor = useRef<{ projectId: string; contentCursor: number; workingCursor: number } | null>(null);
  const freshnessQuery = useQuery({
    queryKey: ["project-freshness", projectId],
    queryFn: () => {
      const previous = freshnessCursor.current;
      const params = new URLSearchParams();
      if (previous?.projectId === projectId) {
        params.set("after", String(previous.contentCursor));
        params.set("workingAfter", String(previous.workingCursor));
      }
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      return apiFetch<ProjectFreshness>(`/api/projects/${projectId}/freshness${suffix}`);
    },
    enabled: Boolean(projectId),
    refetchInterval: PROJECT_FRESHNESS_INTERVAL_MS,
    staleTime: 0,
    retry: false,
  });

  useEffect(() => {
    const freshness = freshnessQuery.data;
    if (!freshness) return;
    const previous = freshnessCursor.current;
    const hadCursor = previous?.projectId === projectId;
    freshnessCursor.current = {
      projectId,
      contentCursor: freshness.contentCursor,
      workingCursor: freshness.workingCursor,
    };
    if (!hadCursor) return;
    if (freshness.changed || freshness.resetRequired) {
      void queryClient.invalidateQueries({ queryKey: ["brief", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["timeline", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    }
    if (freshness.changed || freshness.resetRequired || freshness.workingChanged || freshness.workingResetRequired) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workContext(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryRoots.inbox });
    }
  }, [freshnessQuery.data, projectId, queryClient]);
  const tabs: { id: Tab; label: string; icon: IconName }[] = [
    { id: "overview", label: "Overview", icon: "projects" },
    { id: "timeline", label: "Timeline", icon: "activity" },
    { id: "export", label: "Export", icon: "archive" },
  ];

  return (
    <div className="space-y-4">
      <Link to="/" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-1 text-xs font-medium text-ck-muted hover:text-ck-ink">
        <Icon name="arrow-left" className="h-4 w-4" />
        Projects
      </Link>

      {recordId ? <RecordDeepLink projectId={projectId} recordId={recordId} /> : null}

      <div role="tablist" aria-label="Project views" className="grid grid-cols-3 gap-1 rounded-2xl border border-ck-line bg-ck-surface p-1 shadow-xs">
        {tabs.map((item) => (
          <button
            key={item.id}
            role="tab"
            id={`project-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`project-panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            onKeyDown={(event) => {
              const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (!direction && event.key !== "Home" && event.key !== "End") return;
              event.preventDefault();
              const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (tabs.findIndex((entry) => entry.id === tab) + direction + tabs.length) % tabs.length;
              const next = tabs[index]!;
              setTab(next.id);
              document.getElementById(`project-tab-${next.id}`)?.focus();
            }}
            type="button"
            onClick={() => setTab(item.id)}
            className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl px-2 text-xs font-semibold transition ${
              tab === item.id ? "bg-ck-teal text-on-brand shadow-sm" : "text-ck-muted hover:bg-ck-bg hover:text-ck-ink"
            }`}
          >
            <Icon name={item.icon} className="h-4 w-4" />
            {item.label}
          </button>
        ))}
      </div>

      <section role="tabpanel" id={`project-panel-${tab}`} aria-labelledby={`project-tab-${tab}`}>
      {tab === "overview" ? <OverviewTab projectId={projectId} /> : null}
      {tab === "timeline" ? <TimelineTab projectId={projectId} /> : null}
      {tab === "export" ? <ExportTab projectId={projectId} /> : null}
      </section>
    </div>
  );
}

export function recordDeepLinkErrorMessage(error: unknown): string {
  if ((error as { status?: number } | null)?.status === 404) {
    return "Record not found in the current store. It may have been deleted or restored under a newer snapshot; no local queue or server data was changed.";
  }
  return describeReadError(error, "Linked record");
}

export function RecordDeepLink({ projectId, recordId }: { projectId: string; recordId: string }): ReactNode {
  const recordQuery = useQuery({
    queryKey: ["record-detail", recordId],
    queryFn: () => apiFetch<RecordDto>(`/api/records/${recordId}`, { noQueue: true }),
    retry: false,
  });

  return (
    <section className="overflow-hidden rounded-2xl border border-ck-teal/30 bg-ck-surface shadow-sm" data-testid="record-deep-link">
      <div className="flex items-center justify-between gap-2 border-b border-ck-line px-3 py-2">
        <div>
          <p className="text-xs font-semibold text-ck-ink">Linked record &amp; evidence</p>
          <p className="text-[10px] font-mono text-ck-muted">{recordId}</p>
        </div>
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          search={{ recordId: undefined }}
          className="rounded-lg border border-ck-line px-2 py-1 text-[11px] font-semibold text-ck-muted"
        >
          Close
        </Link>
      </div>
      {recordQuery.isLoading ? <p className="p-3 text-xs text-ck-muted">Loading linked record…</p> : null}
      {recordQuery.isError ? (
        <p className={`p-3 text-xs ${(recordQuery.error as { status?: number } | null)?.status === 404 ? "text-ck-amber" : "text-ck-red"}`}>
          {recordDeepLinkErrorMessage(recordQuery.error)}
        </p>
      ) : null}
      {recordQuery.data ? (
        recordQuery.data.projectId !== null && recordQuery.data.projectId !== projectId ? (
          <p className="p-3 text-xs text-ck-amber">This record belongs to a different project scope.</p>
        ) : (
          <RecordCard record={recordQuery.data} />
        )
      ) : null}
    </section>
  );
}

function OverviewTab({ projectId }: { projectId: string }): ReactNode {
  const briefQuery = useQuery({
    queryKey: ["brief", projectId],
    queryFn: async () => {
      try {
        let fetchedAt: string | undefined;
        const data = await apiFetch<BriefDto>(`/api/projects/${projectId}/brief`, {
          onDataProvenance: (meta) => { fetchedAt = meta.fetchedAt; },
        });
        void saveToCache(briefKey(projectId), data, {
          fetchedAt,
          scope: `project:${projectId}:brief`,
          cursor: data.contentVersion,
        });
        return { brief: data, cachedAt: null as string | null, cached: false };
      } catch (e) {
        if (!isNetworkUnavailableError(e)) throw e;
        const cached = await readCache<BriefDto>(briefKey(projectId), `project:${projectId}:brief`);
        if (cached) return { brief: cached.value, cachedAt: cached.provenance.fetchedAt, cached: true };
        throw e;
      }
    },
  });

  const reconciliationQuery = useQuery({
    queryKey: ["workspace-reconciliation"],
    queryFn: () => apiFetch<WorkspaceReconciliationDto>("/api/workspaces/reconciliation"),
    retry: false,
  });

  const workspaceItems = useMemo(
    () => (reconciliationQuery.data?.items ?? []).filter((item) => item.workspace.projectId === projectId),
    [reconciliationQuery.data, projectId],
  );

  if (briefQuery.isLoading) return <OverviewSkeleton />;
  if (briefQuery.isError) {
    return <p className="rounded-2xl border border-ck-red/30 bg-ck-red/5 p-4 text-sm text-ck-red">{describeReadError(briefQuery.error, "Project overview")}</p>;
  }

  const { brief, cachedAt, cached } = briefQuery.data!;
  const sections: { title: string; items: BriefDto["facts"]; icon: IconName }[] = [
    { title: "Current facts", items: brief.facts, icon: "database" },
    { title: "Decisions", items: brief.decisions, icon: "sparkles" },
    { title: "Constraints", items: brief.constraints, icon: "archive" },
    { title: "Open questions", items: brief.openQuestions, icon: "search" },
    { title: "Next actions", items: brief.actions, icon: "activity" },
  ];
  const knowledgeCount = brief.facts.length + brief.decisions.length + brief.constraints.length;
  const openCount = brief.openQuestions.length + brief.actions.length;
  const hasKnowledge = sections.some((section) => section.items.length > 0);

  let codexSessions = 0;
  let codexSummaries = 0;
  let dshSessions = 0;
  let latestSessionActivity: string | null = null;
  let latestRepoActivity: string | null = null;
  for (const item of workspaceItems) {
    codexSessions += item.history.codexCurrentCount + item.history.codexArchivedCount;
    codexSummaries += item.history.codexSummaryCount;
    dshSessions += item.history.dshSessionCount;
    latestSessionActivity = later(latestSessionActivity, item.history.lastSessionActivity ?? null);
    latestRepoActivity = later(latestRepoActivity, item.workspace.lastObservedActivity);
  }
  const sessionCount = codexSessions + dshSessions;

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-3xl border border-ck-line bg-ck-surface shadow-sm">
        <div className="p-4 sm:p-5">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight text-ck-ink">{brief.project.name}</h1>
                <LifecycleBadge state={brief.lifecycle.state} />
              </div>
              {brief.description ? <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ck-muted">{brief.description}</p> : null}
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-ck-muted">
                <span className="inline-flex items-center gap-1.5"><Icon name="clock" className="h-3.5 w-3.5" />{latestSessionActivity ? `Worked ${relativeTime(latestSessionActivity)}` : latestRepoActivity ? `Repo activity ${relativeTime(latestRepoActivity)}` : "No activity yet"}</span>
                {workspaceItems[0]?.workspace.gitBranch ? <span className="inline-flex items-center gap-1.5"><Icon name="branch" className="h-3.5 w-3.5" />{workspaceItems[0].workspace.gitBranch}</span> : null}
                {workspaceItems.length > 0 ? <span>{workspaceItems.length} linked workspace{workspaceItems.length === 1 ? "" : "s"}</span> : null}
              </div>
            </div>
            <Link to="/import" search={{ projectId }} className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-ck-teal/30 bg-ck-teal-soft px-3 py-2 text-xs font-semibold text-ck-teal-dark">
              <Icon name="import" className="h-4 w-4" />
              Add context
            </Link>
          </div>

          {cached ? <p className="mt-3 rounded-xl border border-ck-amber/30 bg-ck-amber/10 px-3 py-2 text-[11px] text-ck-amber">Offline/cache — showing the last verified overview{cachedAt ? ` fetched at ${formatLocalDateTime(cachedAt)}` : " (original fetch time unavailable for legacy cache)"}.</p> : null}
        </div>

        <div className="grid grid-cols-2 border-t border-ck-line sm:grid-cols-4">
          <Metric value={knowledgeCount} label="Known" />
          <Metric value={brief.decisions.length} label="Decisions" />
          <Metric value={openCount} label="Open items" />
          <Metric value={sessionCount} label="Agent sessions" highlight={sessionCount > 0 && !hasKnowledge} />
        </div>
      </section>

      <ProjectMemoryDashboard projectId={projectId} />

      {sessionCount > 0 ? <ProjectHistoryBackfill projectId={projectId} sessionCount={sessionCount} /> : null}

      {!hasKnowledge ? (
        <section className="rounded-3xl border border-ck-line bg-ck-surface p-5 shadow-sm sm:p-6">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-ck-teal-soft text-ck-teal-dark">
            <Icon name={sessionCount > 0 ? "sparkles" : "database"} className="h-5 w-5" />
          </div>
          <h2 className="mt-3 text-base font-semibold tracking-tight text-ck-ink">
            {sessionCount > 0 ? "Your agent work is here. Reviewed knowledge has not been built yet." : "No reviewed project knowledge yet."}
          </h2>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ck-muted">
            {sessionCount > 0
              ? `ContextKeep sees ${sessionCount} mapped agent sessions from work done on Dell (${codexSessions} Codex, ${dshSessions} DSH)${codexSummaries > 0 ? ` plus ${codexSummaries} Codex summaries` : ""}. Those sessions are the primary work history for this project. They still need an explicit import/review step before anything becomes canonical project knowledge.`
              : "This project has no accepted facts, decisions, constraints, questions or actions yet. Add context manually, or link it to an observed workspace with agent history."}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to="/import" search={{ projectId }} className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-ck-teal px-3.5 py-2 text-xs font-semibold text-on-brand shadow-sm">
              <Icon name="import" className="h-4 w-4" />
              Import manually
            </Link>
            <Link to="/" className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-ck-line px-3.5 py-2 text-xs font-semibold text-ck-muted">
              Workspace setup
            </Link>
          </div>
        </section>
      ) : (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-3">
            {sections.filter((section) => section.items.length > 0).map((section) => (
              <KnowledgeSection key={section.title} title={section.title} icon={section.icon} items={section.items} />
            ))}
          </div>
          <WorkspaceContext
            items={workspaceItems}
            codexSessions={codexSessions}
            codexSummaries={codexSummaries}
            dshSessions={dshSessions}
            latestSessionActivity={latestSessionActivity}
            latestRepoActivity={latestRepoActivity}
          />
        </div>
      )}

      {!hasKnowledge && workspaceItems.length > 0 ? (
        <WorkspaceContext
          items={workspaceItems}
          codexSessions={codexSessions}
          codexSummaries={codexSummaries}
          dshSessions={dshSessions}
          latestSessionActivity={latestSessionActivity}
          latestRepoActivity={latestRepoActivity}
        />
      ) : null}
    </div>
  );
}

function Metric({ value, label, highlight = false }: { value: number; label: string; highlight?: boolean }): ReactNode {
  return (
    <div className="border-r border-ck-line px-4 py-3 last:border-r-0 odd:border-b odd:sm:border-b-0 even:border-b even:sm:border-b-0">
      <p className={`text-xl font-semibold tracking-tight ${highlight ? "text-ck-teal" : "text-ck-ink"}`}>{value}</p>
      <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-ck-muted">{label}</p>
    </div>
  );
}

function KnowledgeSection({ title, icon, items }: { title: string; icon: IconName; items: BriefDto["facts"] }): ReactNode {
  return (
    <section className="overflow-hidden rounded-3xl border border-ck-line bg-ck-surface shadow-xs">
      <div className="flex items-center gap-2 border-b border-ck-line px-4 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-ck-bg text-ck-teal"><Icon name={icon} className="h-4 w-4" /></span>
        <h2 className="text-sm font-semibold text-ck-ink">{title}</h2>
        <span className="ml-auto text-xs font-medium text-ck-muted">{items.length}</span>
      </div>
      <div className="divide-y divide-ck-line">{items.map((s) => <RecordCard key={s.record.id} record={s.record} />)}</div>
    </section>
  );
}

function WorkspaceContext({
  items,
  codexSessions,
  codexSummaries,
  dshSessions,
  latestSessionActivity,
  latestRepoActivity,
}: {
  items: WorkspaceReconciliationItemDto[];
  codexSessions: number;
  codexSummaries: number;
  dshSessions: number;
  latestSessionActivity: string | null;
  latestRepoActivity: string | null;
}): ReactNode {
  if (items.length === 0) return null;
  const primary = items[0]!;
  return (
    <aside className="rounded-3xl border border-ck-line bg-ck-surface p-4 shadow-xs">
      <div className="flex items-center gap-2"><Icon name="activity" className="h-4 w-4 text-ck-teal" /><h2 className="text-sm font-semibold">Agent work on Dell</h2></div>
      <p className="mt-1 text-xs leading-relaxed text-ck-muted">Codex and DSH sessions are treated as the primary work-history signal. Repo/server state is shown separately as infrastructure context.</p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <div className="rounded-xl bg-ck-bg p-3"><p className="text-lg font-semibold">{codexSessions}</p><p className="text-[10px] uppercase tracking-wide text-ck-muted">Codex sessions</p></div>
        <div className="rounded-xl bg-ck-bg p-3"><p className="text-lg font-semibold">{dshSessions}</p><p className="text-[10px] uppercase tracking-wide text-ck-muted">DSH sessions</p></div>
        <div className="rounded-xl bg-ck-bg p-3"><p className="text-lg font-semibold">{codexSummaries}</p><p className="text-[10px] uppercase tracking-wide text-ck-muted">Summaries</p></div>
      </div>
      <dl className="mt-3 space-y-2 text-xs">
        <div className="flex gap-3"><dt className="w-24 shrink-0 text-ck-muted">Last agent work</dt><dd className="font-medium text-ck-ink">{relativeTime(latestSessionActivity)}</dd></div>
        <div className="flex gap-3"><dt className="w-24 shrink-0 text-ck-muted">Repo observed</dt><dd className="font-medium text-ck-ink">{relativeTime(latestRepoActivity)}</dd></div>
        <div className="flex gap-3"><dt className="w-24 shrink-0 text-ck-muted">Workspace</dt><dd className="min-w-0 truncate font-medium text-ck-ink">{primary.workspace.displayName}</dd></div>
        {primary.workspace.gitBranch ? <div className="flex gap-3"><dt className="w-24 shrink-0 text-ck-muted">Branch</dt><dd className="font-mono text-[11px] text-ck-ink">{primary.workspace.gitBranch}</dd></div> : null}
      </dl>
      <details className="mt-3 border-t border-ck-line pt-3 text-[11px] text-ck-muted">
        <summary className="cursor-pointer font-medium text-ck-teal">Technical details</summary>
        <p className="mt-2 break-all font-mono">{primary.workspace.canonicalPath}</p>
        {primary.workspace.gitRemote ? <p className="mt-1 break-all font-mono">{primary.workspace.gitRemote}</p> : null}
      </details>
    </aside>
  );
}

function OverviewSkeleton(): ReactNode {
  return <div className="space-y-3"><div className="h-44 animate-pulse rounded-3xl border border-ck-line bg-ck-surface"/><div className="h-36 animate-pulse rounded-3xl border border-ck-line bg-ck-surface"/></div>;
}

function TimelineTab({ projectId }: { projectId: string }): ReactNode {
  const timelineQuery = useQuery({ queryKey: ["timeline", projectId], queryFn: () => apiFetch<TimelineDto>(`/api/projects/${projectId}/timeline`) });
  if (timelineQuery.isLoading) return <p className="rounded-2xl border border-ck-line bg-ck-surface p-4 text-sm text-ck-muted">Loading timeline…</p>;
  if (timelineQuery.isError) return <p className="rounded-2xl border border-ck-red/30 bg-ck-red/5 p-4 text-sm text-ck-red">Timeline unavailable.</p>;
  const entries = timelineQuery.data!.entries;
  return (
    <section className="overflow-hidden rounded-3xl border border-ck-line bg-ck-surface shadow-sm">
      <div className="border-b border-ck-line px-4 py-3"><h1 className="text-sm font-semibold">Project timeline</h1><p className="mt-0.5 text-xs text-ck-muted">Accepted and superseded knowledge in chronological context.</p></div>
      <VirtualList
        items={entries}
        estimateRowHeight={150}
        emptyText="No accepted or superseded records yet."
        renderRow={(entry) => (
          <div className="border-b border-ck-line last:border-b-0">
            <RecordCard record={entry.record} footer={entry.supersededBy ? <p className="text-[11px] text-ck-amber">Superseded{entry.supersededBy.confirmedAt ? ` ${entry.supersededBy.confirmedAt.slice(0, 10)}` : ""}: {entry.supersededBy.reason}</p> : entry.supersedes.length > 0 ? <p className="text-[11px] text-ck-green">Supersedes {entry.supersedes.length} earlier record(s).</p> : null} />
          </div>
        )}
      />
    </section>
  );
}

function ExportTab({ projectId }: { projectId: string }): ReactNode {
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState(60000);
  const [busy, setBusy] = useState(false);
  const [handoff, setHandoff] = useState<HandoffExportDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setHandoff(await apiFetch<HandoffExportDto>("/api/handoffs", {
        method: "POST",
        body: { projectId, objective: objective || null, contextBudgetChars: budget },
        label: "Handoff export",
      }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Export failed.");
      notifyError(e, "Export failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <section className="rounded-3xl border border-ck-line bg-ck-surface p-4 shadow-sm sm:p-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-ck-teal-soft text-ck-teal-dark"><Icon name="archive" className="h-5 w-5" /></div>
        <h2 className="mt-3 text-base font-semibold tracking-tight">Portable handoff</h2>
        <p className="mt-1 max-w-xl text-xs leading-relaxed text-ck-muted">Create a compact Markdown package of accepted project knowledge for another person or agent.</p>
        <textarea value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Objective for the next person/agent (optional)" rows={2} className="mt-3 w-full rounded-xl border border-ck-line bg-ck-bg px-3 py-2.5 text-sm" />
        <label className="mt-2 block text-xs text-ck-muted">Context budget (characters)<input type="number" min={2000} max={400000} value={budget} onChange={(e) => setBudget(Number(e.target.value))} className="mt-1 w-full rounded-xl border border-ck-line bg-ck-bg px-3 py-2.5 text-sm" /></label>
        {error ? <p className="mt-2 text-xs text-ck-red">{error}</p> : null}
        <button type="button" onClick={() => void generate()} disabled={busy} className="mt-3 w-full rounded-xl bg-ck-teal px-3 py-2.5 text-sm font-semibold text-on-brand disabled:opacity-50">{busy ? "Rendering…" : "Generate handoff"}</button>
        <a className="mt-3 block text-center text-xs font-medium text-ck-teal" href="/api/export/json">Download full JSON dump</a>
      </section>

      {handoff ? (
        <section className="rounded-3xl border border-ck-line bg-ck-surface p-4 shadow-sm">
          <div className="flex items-center gap-2"><StatusBadge status="accepted"/><h3 className="text-sm font-semibold">Handoff {handoff.id.slice(0, 8)}</h3><a className="ml-auto rounded-lg border border-ck-teal px-2 py-1 text-xs font-semibold text-ck-teal" href={`/api/handoffs/${handoff.id}/markdown`}>Download .md</a></div>
          {handoff.truncationNotes.length > 0 ? <ul className="mt-2 list-disc pl-4 text-[11px] text-ck-amber">{handoff.truncationNotes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
          <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-2xl bg-ck-bg p-3 text-[11px] leading-relaxed">{handoff.markdown}</pre>
        </section>
      ) : null}
    </div>
  );
}
