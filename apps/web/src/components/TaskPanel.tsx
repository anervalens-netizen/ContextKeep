import { usePanelText } from "../lib/panel-locale.js";
import type { PanelPreferences } from "@contextkeep/shared";
import { schedulePanelRefresh } from "../lib/panel-refresh.js";
import {
  TaskContextActions,
  type TaskHostActions,
} from "./TaskContextActions.js";
import { useCallback, useEffect, useRef, useState } from "react";
import "./task-panel.css";
import {
  TaskNow,
  ProjectNow,
  PortfolioNow,
  OperationalHistory,
  type TaskDossier,
  type ProjectDossier,
  type PortfolioPage,
  type ActivityPage,
} from "./OperationalDossier.js";
export type TaskSelection = {
  projectId: string;
  taskId: string;
  revision: number;
  stateToken?: string;
};
type Project = { id: string; name: string };
type Task = {
  id: string;
  subject: string;
  text?: string;
  taskStatus: string | null;
  effectiveState?: string;
  reviewStatus: string;
  revision: number;
};
type Run = {
  id: string;
  status: string;
  verification: string;
  externalJobId: string | null;
  updatedAt: string;
  criteria: string[];
};
export type TaskView = {
  task: Task;
  dossier?: TaskDossier;
  latestCheckpoint: {
    recordedAt: string;
    provenance: string;
    status: string;
    checkpoint?: { summary?: string; nextAction?: string | null };
  } | null;
  blockers: { active: Array<{ blockerId: string; text: string }> };
  runs: Run[];
  records: Array<{
    id: string;
    text: string;
    reviewStatus: string;
    recordedAt: string;
  }>;
  pagination: { nextOffset: number | null };
};
export interface TaskTransport {
  projects(): Promise<Project[]>;
  projectPage?: (
    offset?: number,
  ) => Promise<{ projects: Project[]; nextOffset: number | null }>;
  overview?: (
    projectId: string,
    offset?: number,
    attentionOffset?: number,
    options?: {
      selection?: "actual_tasks" | "all_actions";
      view?: "recent" | "attention" | "active";
      q?: string;
    },
  ) => Promise<ProjectDossier>;
  portfolio?: (
    offset?: number,
    selection?: "actual_tasks" | "all_actions",
  ) => Promise<PortfolioPage>;
  resume?: (
    projectId: string,
    taskId: string,
  ) => Promise<{
    dossier: TaskDossier;
    resumeText: string;
    startsExecution: false;
  }>;
  activity?: (
    projectId: string,
    taskId?: string,
    offset?: number,
    scope?: string,
  ) => Promise<ActivityPage>;
  tasks(
    projectId: string,
    offset?: number,
    options?: {
      selection?: "actual_tasks" | "all_actions";
      q?: string;
      view?: "recent" | "attention" | "active";
    },
  ): Promise<{ items: Task[]; nextOffset: number | null }>;
  task(projectId: string, taskId: string, offset?: number): Promise<TaskView>;
}
export function TaskPanel({
  transport,
  projectId: fixedProject,
  selection,
  onSelection,
  onResume,
  hostActions,
  refreshIntervalMs = 15000,
  initialTaskVisibility = "actual_tasks",
  contextBudget = "balanced",
  initialLandingView = "recent",
}: {
  transport: TaskTransport;
  projectId?: string;
  selection?: TaskSelection;
  onSelection?: (s: TaskSelection) => void;
  onResume?: (s: TaskSelection, text: string) => void;
  hostActions?: TaskHostActions;
  refreshIntervalMs?: number | null;
  initialTaskVisibility?: "actual_tasks" | "all_actions";
  contextBudget?: PanelPreferences["contextBudget"];
  initialLandingView?: PanelPreferences["landingView"];
}) {
  const tr = usePanelText();
  const [projects, setProjects] = useState<Project[]>([]),
    [projectId, setProjectId] = useState(
      fixedProject ?? selection?.projectId ?? "",
    ),
    [taskId, setTaskId] = useState(selection?.taskId ?? "");
  const [offset, setOffset] = useState(0);
  const [listRetry, setListRetry] = useState(0);
  const [projectsFailed, setProjectsFailed] = useState(false);
  const [nextProjects, setNextProjects] = useState<number | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const projectsPending = useRef(false);
  const [taskFilter, setTaskFilter] = useState<"actual_tasks" | "all_actions">(
    initialTaskVisibility,
  );
  const [taskView, setTaskView] = useState(initialLandingView);
  useEffect(
    () => setTaskFilter(initialTaskVisibility),
    [initialTaskVisibility],
  );
  useEffect(() => setTaskView(initialLandingView), [initialLandingView]);
  const [searchDraft, setSearchDraft] = useState("");
  const [taskQuery, setTaskQuery] = useState("");
  const loadPortfolio = useCallback(
    (offset?: number) => transport.portfolio!(offset, taskFilter),
    [transport, taskFilter],
  );
  const loadOverview = useCallback(
    (id: string, offset?: number, attentionOffset?: number) =>
      transport.overview!(id, offset, attentionOffset, {
        selection: taskFilter,
        view: taskView,
        ...(taskQuery ? { q: taskQuery } : {}),
      }),
    [transport, taskFilter, taskView, taskQuery],
  );
  const [moreLoading, setMoreLoading] = useState(false);
  const morePending = useRef(false);
  const listGeneration = useRef(0);
  const listKey = `${projectId}:${taskFilter}:${taskView}:${taskQuery}`;
  const currentListKey = useRef(listKey);
  currentListKey.current = listKey;
  const [resumeText, setResumeText] = useState("");
  const [resuming, setResuming] = useState(false);
  const selectedKey = useRef("");
  selectedKey.current = `${projectId}:${taskId}`;
  useEffect(() => {
    setResumeText("");
    setResuming(false);
  }, [projectId, taskId]);
  useEffect(() => setOffset(0), [projectId, taskId]);
  const [tasks, setTasks] = useState<Task[]>([]),
    [nextTasks, setNextTasks] = useState<number | null>(null),
    [view, setView] = useState<TaskView | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const [tasksStatus, setTasksStatus] = useState<
    "idle" | "loading" | "loaded" | "error"
  >("idle");
  const refreshTask = useRef<(() => Promise<void>) | null>(null);
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const serial = useRef(0),
    selectionCallback = useRef(onSelection);
  selectionCallback.current = onSelection;
  useEffect(() => {
    let active = true;
    setProjectsFailed(false);
    if (!fixedProject)
      (transport.projectPage
        ? transport.projectPage(0)
        : transport
            .projects()
            .then((projects) => ({ projects, nextOffset: null }))
      )
        .then((p) => {
          if (active) {
            setProjects(p.projects);
            setNextProjects(p.nextOffset);
          }
        })
        .catch(() => {
          if (active) {
            setProjectsFailed(true);
            setError(tr("Could not load projects."));
          }
        });
    return () => {
      active = false;
    };
  }, [transport, fixedProject, listRetry]);
  useEffect(() => {
    if (fixedProject) {
      setProjectId(fixedProject);
      setTaskId("");
      setView(null);
    }
  }, [fixedProject]);
  useEffect(() => {
    if (selection) {
      setProjectId(selection.projectId);
      setTaskId(selection.taskId);
    }
  }, [selection?.projectId, selection?.taskId]);
  useEffect(() => {
    let active = true;
    ++listGeneration.current;
    morePending.current = false;
    setMoreLoading(false);
    setTasks([]);
    setNextTasks(null);
    setError("");
    setTasksStatus(projectId ? "loading" : "idle");
    if (projectId)
      transport
        .tasks(projectId, 0, {
          selection: taskFilter,
          view: taskView,
          ...(taskQuery ? { q: taskQuery } : {}),
        })
        .then((r) => {
          if (active) {
            setTasks(r.items);
            setNextTasks(r.nextOffset);
            setTasksStatus("loaded");
          }
        })
        .catch(() => {
          if (active) {
            setTasksStatus("error");
            setError(tr("Could not load tasks."));
          }
        });
    return () => {
      active = false;
    };
  }, [transport, projectId, taskFilter, taskView, taskQuery, listRetry]);
  useEffect(() => {
    const request = ++serial.current;
    let stopped = false,
      pending = false;
    setView(null);
    setError("");
    setObservedAt(null);
    setLoading(false);
    refreshTask.current = null;
    if (!projectId || !taskId) return;
    const refresh = async () => {
      if (pending || stopped) return;
      pending = true;
      try {
        setLoading(true);
        const next = await transport.task(projectId, taskId, offset);
        if (stopped || serial.current !== request) return;
        setView(next);
        setObservedAt(new Date().toISOString());
        setError("");
        selectionCallback.current?.({
          projectId,
          taskId,
          revision: next.task.revision,
          ...(next.dossier ? { stateToken: next.dossier.stateToken } : {}),
        });
      } catch {
        if (!stopped && serial.current === request)
          setError(tr("Could not refresh task. Displayed data may be stale."));
      } finally {
        pending = false;
        if (!stopped && serial.current === request) setLoading(false);
      }
    };
    refreshTask.current = refresh;
    void refresh();
    const stop = schedulePanelRefresh(() => void refresh(), refreshIntervalMs);
    return () => {
      stopped = true;
      refreshTask.current = null;
      stop();
    };
  }, [transport, projectId, taskId, offset, refreshIntervalMs]);
  async function moreProjects() {
    if (
      !transport.projectPage ||
      nextProjects === null ||
      projectsPending.current
    )
      return;
    projectsPending.current = true;
    setProjectsLoading(true);
    try {
      const page = await transport.projectPage(nextProjects);
      setProjects((previous) => [
        ...previous,
        ...page.projects.filter(
          (p) => !previous.some((existing) => existing.id === p.id),
        ),
      ]);
      setNextProjects(page.nextOffset);
    } catch {
      setError(tr("Could not load more projects."));
    } finally {
      projectsPending.current = false;
      setProjectsLoading(false);
    }
  }
  async function moreTasks() {
    if (nextTasks === null || morePending.current) return;
    const key = listKey,
      generation = listGeneration.current;
    morePending.current = true;
    setMoreLoading(true);
    try {
      const r = await transport.tasks(projectId, nextTasks, {
        selection: taskFilter,
        view: taskView,
        ...(taskQuery ? { q: taskQuery } : {}),
      });
      if (
        key === currentListKey.current &&
        generation === listGeneration.current
      ) {
        setTasks((v) => [
          ...v,
          ...r.items.filter(
            (item) => !v.some((existing) => existing.id === item.id),
          ),
        ]);
        setNextTasks(r.nextOffset);
      }
    } catch {
      if (
        key === currentListKey.current &&
        generation === listGeneration.current
      )
        setError(tr("Could not load more tasks."));
    } finally {
      if (
        key === currentListKey.current &&
        generation === listGeneration.current
      ) {
        morePending.current = false;
        setMoreLoading(false);
      }
    }
  }
  async function prepareResume() {
    if (!transport.resume || resuming) return;
    const key = selectedKey.current;
    setResuming(true);
    try {
      const result = await transport.resume(projectId, taskId);
      if (selectedKey.current !== key) return;
      setResumeText(result.resumeText);
      onResume?.(
        {
          projectId,
          taskId,
          revision: result.dossier.taskRevision,
          stateToken: result.dossier.stateToken,
        },
        result.resumeText,
      );
    } catch {
      if (selectedKey.current === key)
        setError(tr("Contextul de reluare nu poate fi pregătit."));
    } finally {
      if (selectedKey.current === key) setResuming(false);
    }
  }
  return (
    <section className="ck-task-panel">
      <header>
        <span className="ck-task-eyebrow">CONTEXTKEEP</span>
        <h2>{tr("Task dossier")}</h2>
        <p>{tr("Checkpoint, execution and verification in one place.")}</p>
      </header>
      <nav aria-label="Breadcrumb" className="ck-filter-controls">
        {!fixedProject && (
          <button
            disabled={hostActions?.pending}
            onClick={() => {
              if (hostActions?.pending) return;
              setProjectId("");
              setTaskId("");
              setView(null);
            }}
          >
            {tr("Proiecte")}
          </button>
        )}
        {projectId && (
          <button
            disabled={hostActions?.pending}
            onClick={() => {
              if (hostActions?.pending) return;
              setTaskId("");
              setView(null);
            }}
          >
            {projects.find((p) => p.id === projectId)?.name ??
              tr("Proiectul selectat")}
          </button>
        )}
        {taskId && (
          <span aria-current="page">
            {view?.task.subject ??
              tasks.find((t) => t.id === taskId)?.subject ??
              tr("Taskul selectat")}
          </span>
        )}
      </nav>
      <div className="ck-task-controls">
        {!fixedProject && (
          <label>
            {tr(" Project ")}
            <select
              aria-label={tr("Project")}
              disabled={hostActions?.pending}
              value={projectId}
              onChange={(e) => {
                if (hostActions?.pending) return;
                setProjectId(e.target.value);
                setTaskId("");
                setView(null);
              }}
            >
              <option value="">{tr("Select a project")}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {nextProjects !== null && (
          <button
            disabled={projectsLoading}
            onClick={() => void moreProjects()}
          >
            {tr("More projects")}
          </button>
        )}
        <nav aria-label={tr("Task views")} className="ck-filter-controls">
          {(["recent", "attention", "active"] as const).map((value) => (
            <button
              key={value}
              aria-pressed={taskView === value}
              onClick={() => setTaskView(value)}
            >
              {
                {
                  recent: tr("Recente"),
                  attention: tr("Atenție"),
                  active: tr("Active"),
                }[value]
              }
            </button>
          ))}
        </nav>
        <label>
          {tr(" Afișare ")}
          <select
            aria-label={tr("Task selection")}
            value={taskFilter}
            onChange={(e) =>
              setTaskFilter(e.target.value as "actual_tasks" | "all_actions")
            }
          >
            <option value="actual_tasks">{tr("Taskuri")}</option>
            <option value="all_actions">{tr("Toate acțiunile")}</option>
          </select>
        </label>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setTaskQuery(searchDraft.trim());
          }}
        >
          <label>
            {tr("Caută taskul")}
            <input
              aria-label={tr("Search tasks")}
              value={searchDraft}
              maxLength={200}
              onChange={(e) => setSearchDraft(e.target.value)}
            />
          </label>
          <button type="submit" disabled={!projectId}>
            {tr("Caută")}
          </button>
        </form>
        <label>
          {tr(" Task ")}
          <select
            aria-label={tr("Task")}
            disabled={hostActions?.pending}
            value={taskId}
            onChange={(e) => {
              if (hostActions?.pending) return;
              setTaskId(e.target.value);
              setView(null);
            }}
          >
            <option value="">{tr("Select a task")}</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.subject.slice(0, 160)} ·{" "}
                {t.effectiveState ?? t.taskStatus ?? "unknown"} ·{" "}
                {t.reviewStatus}
              </option>
            ))}
          </select>
        </label>
        {nextTasks !== null && (
          <button disabled={moreLoading} onClick={() => void moreTasks()}>
            {tr("More tasks")}
          </button>
        )}
      </div>
      {taskId && (
        <div className="ck-refresh-controls">
          <button
            disabled={loading}
            onClick={() => void refreshTask.current?.()}
          >
            {tr("Actualizează taskul")}
          </button>
          {observedAt && (
            <small>
              {tr("Citit la ")}
              <time dateTime={observedAt}>
                {new Date(observedAt).toLocaleTimeString()}
              </time>
            </small>
          )}
        </div>
      )}
      {error && <p role="alert">{tr(error)}</p>}
      {(projectsFailed || tasksStatus === "error") && (
        <button
          onClick={() => {
            setError("");
            setListRetry((value) => value + 1);
          }}
        >
          {tr("Reîncearcă lista")}
        </button>
      )}
      {!projectId && transport.portfolio && (
        <PortfolioNow
          load={loadPortfolio}
          onProject={(id) => {
            if (!hostActions?.pending) setProjectId(id);
          }}
          refreshIntervalMs={refreshIntervalMs}
        />
      )}
      {projectId && !taskId && transport.overview && (
        <ProjectNow
          projectId={projectId}
          load={loadOverview}
          serverFiltered
          refreshIntervalMs={refreshIntervalMs}
          onTask={(id) => {
            if (!hostActions?.pending) setTaskId(id);
          }}
        />
      )}
      {projectId && !taskId && transport.activity && (
        <OperationalHistory projectId={projectId} load={transport.activity} />
      )}
      {!view && tasksStatus !== "error" && (
        <p className="ck-task-muted">
          {tasksStatus === "loading"
            ? tr("Loading tasks…")
            : loading
              ? tr("Loading task…")
              : tasksStatus === "loaded" && tasks.length === 0
                ? tr(
                    "No matching tasks. Try another search or view all actions.",
                  )
                : tr("Choose a task to inspect its state.")}
        </p>
      )}
      {view && (
        <>
          {view.dossier && <TaskNow dossier={view.dossier} />}
          {transport.resume && hostActions && (
            <TaskContextActions
              selection={{
                projectId,
                taskId,
                revision: view.task.revision,
                stateToken: view.dossier?.stateToken,
              }}
              title={view.task.subject}
              resume={transport.resume}
              host={hostActions}
              contextBudget={contextBudget}
            />
          )}
          {transport.resume && (
            <div className="ck-resume-controls">
              <button disabled={resuming} onClick={() => void prepareResume()}>
                {resuming ? tr("Se pregătește…") : tr("Reia lucrarea")}
              </button>
              <small>
                {tr(
                  " Pregătește contextul actual. Nu pornește nicio execuție. ",
                )}
              </small>
              {resumeText && (
                <label>
                  {tr(" Context de reluare ")}
                  <textarea
                    aria-label={tr("Resume context")}
                    readOnly
                    value={resumeText}
                    rows={9}
                    onFocus={(e) => e.target.select()}
                  />
                </label>
              )}
            </div>
          )}
          <details className="ck-original-task">
            <summary>{tr("Obiectivul și starea inițială")}</summary>
            <div className="ck-task-state">
              <strong>{view.task.text ?? view.task.subject}</strong>
              <span>{view.task.taskStatus ?? tr("No progress recorded")}</span>
              <span>
                {view.task.reviewStatus} {tr(" · revision ")}
                {view.task.revision}
              </span>
            </div>
          </details>
          {!view.dossier && (
            <article>
              <h3>{tr("Resume")}</h3>
              <p>
                {view.latestCheckpoint?.checkpoint?.summary ??
                  tr("No checkpoint for this task.")}
              </p>
              {view.latestCheckpoint && (
                <>
                  <p>
                    <b>{tr("Next:")}</b>{" "}
                    {view.latestCheckpoint.checkpoint?.nextAction ??
                      tr("Not specified")}
                  </p>
                  <small>
                    {view.latestCheckpoint.status} ·{" "}
                    {view.latestCheckpoint.provenance} ·{" "}
                    {new Date(
                      view.latestCheckpoint.recordedAt,
                    ).toLocaleString()}
                  </small>
                </>
              )}
            </article>
          )}
          {view.blockers.active.length > 0 && (
            <article>
              <h3>{tr("Blockers")}</h3>
              <ul>
                {view.blockers.active.map((b) => (
                  <li key={b.blockerId}>{b.text}</li>
                ))}
              </ul>
            </article>
          )}
          <article>
            <h3>{tr("Executions")}</h3>
            {view.runs.length === 0 ? (
              <p>{tr("No runs recorded.")}</p>
            ) : (
              view.runs.map((r) => (
                <div className="ck-task-run" key={r.id}>
                  <div>
                    <b>{r.status}</b>
                    <span>
                      {tr("Verification: ")}
                      {r.verification}
                    </span>
                  </div>
                  <small>
                    {r.externalJobId ?? tr("No executor receipt")} ·{" "}
                    {new Date(r.updatedAt).toLocaleString()}
                  </small>
                  <ul>
                    {r.criteria.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </article>
          {transport.activity ? (
            <OperationalHistory
              projectId={projectId}
              taskId={taskId}
              load={transport.activity}
            />
          ) : (
            <article>
              <h3>{tr("Evidence timeline")}</h3>
              {view.records.length === 0 ? (
                <p>{tr("No reports for this task.")}</p>
              ) : (
                view.records.map((r) => (
                  <details key={r.id}>
                    <summary>
                      {new Date(r.recordedAt).toLocaleString()} ·{" "}
                      {r.reviewStatus}
                    </summary>
                    <p className="ck-task-evidence">{r.text}</p>
                  </details>
                ))
              )}
            </article>
          )}
          <nav aria-label={tr("Task history pages")}>
            <button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              {tr(" Previous ")}
            </button>{" "}
            <button
              disabled={view.pagination.nextOffset === null}
              onClick={() => setOffset(view.pagination.nextOffset ?? offset)}
            >
              {tr(" More history ")}
            </button>
          </nav>
          <small>
            {tr(
              " Execution completion does not complete the task. Agent reports retain their review status. ",
            )}
          </small>
        </>
      )}
    </section>
  );
}
