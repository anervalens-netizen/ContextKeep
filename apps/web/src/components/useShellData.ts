import { useMemo } from "react";
import { useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { WorkspaceReconciliationDto } from "@contextkeep/shared";
import { apiFetch } from "../lib/api.js";
import { readShellProjects } from "../lib/provenance-query.js";
import { sessionCounts, type ProjectSignal } from "./ShellPrimitives.js";

function projectIdFromPath(path: string): string | null {
  const m = path.match(/^\/projects\/([^/?#]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}
export function useShellData() {
  const location = useLocation();
  const projectsQuery = useQuery({
    queryKey: ["projects", "shell-provenance"],
    queryFn: readShellProjects,
    staleTime: 15000,
    retry: false,
  });
  const recon = useQuery({
    queryKey: ["workspace-reconciliation"],
    queryFn: () =>
      apiFetch<WorkspaceReconciliationDto>("/api/workspaces/reconciliation"),
    retry: false,
    staleTime: 15000,
  });
  const activeProjectId = projectIdFromPath(location.pathname);
  const signals = useMemo(() => {
    const out = new Map<string, ProjectSignal>();
    for (const item of recon.data?.items ?? []) {
      const id = item.workspace.projectId;
      if (!id) continue;
      const cur = out.get(id) ?? {
        lastSessionActivity: null,
        codexSessions: 0,
        dshSessions: 0,
        summaries: 0,
      };
      const next = sessionCounts(item);
      const cm = cur.lastSessionActivity
        ? Date.parse(cur.lastSessionActivity)
        : Number.NEGATIVE_INFINITY;
      const nm = next.lastSessionActivity
        ? Date.parse(next.lastSessionActivity)
        : Number.NEGATIVE_INFINITY;
      out.set(id, {
        lastSessionActivity:
          nm > cm ? next.lastSessionActivity : cur.lastSessionActivity,
        codexSessions: cur.codexSessions + next.codexSessions,
        dshSessions: cur.dshSessions + next.dshSessions,
        summaries: cur.summaries + next.summaries,
      });
    }
    return out;
  }, [recon.data]);
  const projects = useMemo(
    () =>
      [...(projectsQuery.data?.data ?? [])].sort((a, b) => {
        const as = signals.get(a.id),
          bs = signals.get(b.id);
        const at = as?.lastSessionActivity
          ? Date.parse(as.lastSessionActivity)
          : Date.parse(a.updatedAt);
        const bt = bs?.lastSessionActivity
          ? Date.parse(bs.lastSessionActivity)
          : Date.parse(b.updatedAt);
        return at === bt ? a.name.localeCompare(b.name) : bt - at;
      }),
    [projectsQuery.data, signals],
  );
  const activeProject = projects.find((x) => x.id === activeProjectId) ?? null;
  return {
    location,
    projects,
    signals,
    activeProjectId,
    activeProject,
    projectsStatus: projectsQuery.isPending
      ? "Loading projects…"
      : projectsQuery.isError
        ? "Projects unavailable; reconnect and retry."
        : projectsQuery.data?.provenance.source === "cache"
          ? `Cached projects (${projectsQuery.data.provenance.fetchedAt ?? "fetch time unknown"})`
          : null,
  };
}
