import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { ProjectDto } from "@contextkeep/shared";
import { Icon } from "./Icon.js";
import { ShellUtilities } from "./ShellUtilities.js";
import { CkMark } from "./CkMark.js";
import { NAV_ITEMS, initials, isActiveNav, relativeTime, type ProjectSignal } from "./ShellPrimitives.js";
import { partitionProjectVisibility } from "../lib/project-visibility.js";

export type PaneSurface = "desktop" | "drawer";

type Props = {
  compact: boolean;
  surface: PaneSurface;
  pathname: string;
  projects: ProjectDto[];
  projectsStatus?: string | null;
  signals: Map<string, ProjectSignal>;
  activeProjectId: string | null;
  offline: boolean;
  queuedCount: number;
  onCollapse: () => void;
  onCloseDrawer: () => void;
  onOpenChangelog: () => void;
};

const LAST_PROJECT_KEY = "ck:last-project";

function ProjectLink({
  project,
  signal,
  active,
  remember,
}: {
  project: ProjectDto;
  signal: ProjectSignal | undefined;
  active: boolean;
  remember: (id: string) => void;
}): ReactNode {
  const sessions = (signal?.codexSessions ?? 0) + (signal?.dshSessions ?? 0);
  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      search={{ recordId: undefined }}
      onClick={() => remember(project.id)}
      aria-current={active ? "page" : undefined}
      className={`mb-0.5 flex min-h-11 items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] ${
        active ? "bg-ck-teal-soft text-ck-ink" : "text-ck-muted hover:bg-ck-bg hover:text-ck-ink"
      }`}
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-bold ${
          active ? "bg-ck-teal text-on-brand" : "bg-ck-bg"
        }`}
      >
        {initials(project.name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{project.name}</span>
        <span className="block truncate text-[10.5px] opacity-80">
          {sessions ? `${sessions} sessions · ${relativeTime(signal?.lastSessionActivity ?? null)}` : "No mapped sessions"}
        </span>
      </span>
    </Link>
  );
}

export function ShellLeftPane(p: Props): ReactNode {
  const drawer = p.surface === "drawer";
  const { active: activeProjects, inactive: inactiveProjects } = partitionProjectVisibility(p.projects);
  const inactiveSelected = inactiveProjects.some((project) => project.id === p.activeProjectId);
  const headerAction = (): void => (drawer ? p.onCloseDrawer() : p.onCollapse());
  const remember = (id: string): void => window.localStorage.setItem(LAST_PROJECT_KEY, id);

  return (
    <div className="flex h-full min-h-0 flex-col bg-ck-surface">
      <div
        className={`flex h-14 shrink-0 items-center border-b border-ck-line ${
          p.compact ? "justify-center px-2" : "gap-2 px-3"
        }`}
      >
        {p.compact ? (
          <button
            type="button"
            onClick={p.onCollapse}
            className="flex h-9 w-9 items-center justify-center rounded-md text-ck-muted hover:bg-ck-bg hover:text-ck-ink"
            aria-label="Expand left sidebar"
            title="Expand sidebar"
          >
            <Icon name="panel-right" className="h-4 w-4" />
          </button>
        ) : (
          <>
            <Link to="/" className="flex items-center gap-2 text-ck-teal" aria-label="ContextKeep home">
              <CkMark className="h-7 w-7" />
              <span className="text-[13px] font-semibold text-ck-ink">ContextKeep</span>
            </Link>
            <button
              type="button"
              onClick={headerAction}
              className="ml-auto flex h-9 w-9 items-center justify-center rounded-md text-ck-muted hover:bg-ck-bg hover:text-ck-ink"
              aria-label={drawer ? "Close navigation" : "Collapse left sidebar"}
              title={drawer ? "Close navigation" : "Collapse sidebar"}
            >
              <Icon name={drawer ? "close" : "panel-left"} className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

      <nav
        aria-label="Primary"
        data-nav={p.surface}
        className={p.compact ? "border-b border-ck-line p-1.5" : "border-b border-ck-line p-2"}
      >
        {NAV_ITEMS.map((item) => {
          const active = isActiveNav(p.pathname, item.to);
          return (
            <Link
              key={item.to}
              to={item.to}
              aria-current={active ? "page" : undefined}
              title={p.compact ? item.label : undefined}
              className={`mb-0.5 flex min-h-10 items-center rounded-lg text-[13px] font-medium ${
                p.compact ? "justify-center px-2" : "gap-2.5 px-2.5"
              } ${active ? "bg-ck-teal-soft text-ck-ink" : "text-ck-muted hover:bg-ck-bg hover:text-ck-ink"}`}
            >
              <Icon name={item.icon} className="h-[17px] w-[17px] shrink-0" />
              {!p.compact ? item.label : null}
            </Link>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!p.compact ? (
          <>
            <div className="flex items-center px-2 pb-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ck-muted">Projects</span>
              <span className="ml-auto text-[11px] text-ck-muted">{p.projectsStatus && p.projects.length === 0 ? "—" : activeProjects.length}</span>
            </div>
            {p.projectsStatus ? <p role="status" className="px-2 py-2 text-xs text-ck-amber">{p.projectsStatus}</p> : null}
            {activeProjects.map((project) => (
              <ProjectLink
                key={project.id}
                project={project}
                signal={p.signals.get(project.id)}
                active={project.id === p.activeProjectId}
                remember={remember}
              />
            ))}
            {inactiveProjects.length > 0 ? (
              <details className="mt-1 border-t border-ck-line pt-1" open={inactiveSelected || undefined}>
                <summary className="cursor-pointer select-none rounded-md px-2 py-2 text-[11px] font-medium text-ck-muted hover:bg-ck-bg hover:text-ck-ink">
                  Other projects ({inactiveProjects.length})
                </summary>
                <div className="pt-0.5">
                  {inactiveProjects.map((project) => (
                    <ProjectLink
                      key={project.id}
                      project={project}
                      signal={p.signals.get(project.id)}
                      active={project.id === p.activeProjectId}
                      remember={remember}
                    />
                  ))}
                </div>
              </details>
            ) : null}
          </>
        ) : (
          activeProjects.slice(0, 10).map((project) => (
            <Link
              key={project.id}
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              search={{ recordId: undefined }}
              onClick={() => remember(project.id)}
              title={project.name}
              aria-current={project.id === p.activeProjectId ? "page" : undefined}
              className={`mb-1 flex h-9 items-center justify-center rounded-lg text-[10px] font-bold ${
                project.id === p.activeProjectId ? "bg-ck-teal text-on-brand" : "bg-ck-bg text-ck-muted"
              }`}
            >
              {initials(project.name)}
            </Link>
          ))
        )}
      </div>

      {!p.compact ? (
        <div className="shrink-0 border-t border-ck-line p-2">
          <ShellUtilities offline={p.offline} queuedCount={p.queuedCount} onOpenChangelog={p.onOpenChangelog} />
        </div>
      ) : null}
    </div>
  );
}
