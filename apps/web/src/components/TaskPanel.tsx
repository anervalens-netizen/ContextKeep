import { useEffect, useRef, useState } from "react";
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
  overview?: (
    projectId: string,
    offset?: number,
    attentionOffset?: number,
  ) => Promise<ProjectDossier>;
  portfolio?: (offset?: number) => Promise<PortfolioPage>;
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
  ): Promise<{ items: Task[]; nextOffset: number | null }>;
  task(projectId: string, taskId: string, offset?: number): Promise<TaskView>;
}
export function TaskPanel({
  transport,
  projectId: fixedProject,
  selection,
  onSelection,
  onResume,
}: {
  transport: TaskTransport;
  projectId?: string;
  selection?: TaskSelection;
  onSelection?: (s: TaskSelection) => void;
  onResume?: (s: TaskSelection, text: string) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]),
    [projectId, setProjectId] = useState(
      fixedProject ?? selection?.projectId ?? "",
    ),
    [taskId, setTaskId] = useState(selection?.taskId ?? "");
  const [offset, setOffset] = useState(0);
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
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const serial = useRef(0),
    selectionCallback = useRef(onSelection);
  selectionCallback.current = onSelection;
  useEffect(() => {
    let active = true;
    if (!fixedProject)
      transport
        .projects()
        .then((p) => {
          if (active) setProjects(p);
        })
        .catch(() => {
          if (active) setError("Could not load projects.");
        });
    return () => {
      active = false;
    };
  }, [transport, fixedProject]);
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
    setTasks([]);
    setNextTasks(null);
    setView(null);
    setError("");
    setTasksStatus(projectId ? "loading" : "idle");
    if (projectId)
      transport
        .tasks(projectId)
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
            setError("Could not load tasks.");
          }
        });
    return () => {
      active = false;
    };
  }, [transport, projectId]);
  useEffect(() => {
    const request = ++serial.current;
    let stopped = false,
      pending = false;
    setView(null);
    setError("");
    if (!projectId || !taskId) return;
    const refresh = async () => {
      if (pending || stopped) return;
      pending = true;
      try {
        setLoading(true);
        const next = await transport.task(projectId, taskId, offset);
        if (stopped || serial.current !== request) return;
        setView(next);
        setError("");
        selectionCallback.current?.({
          projectId,
          taskId,
          revision: next.task.revision,
          ...(next.dossier ? { stateToken: next.dossier.stateToken } : {}),
        });
      } catch {
        if (!stopped && serial.current === request)
          setError("Could not refresh task. Displayed data may be stale.");
      } finally {
        pending = false;
        if (!stopped && serial.current === request) setLoading(false);
      }
    };
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, 15000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [transport, projectId, taskId, offset]);
  async function moreTasks() {
    if (nextTasks === null) return;
    const p = projectId;
    try {
      const r = await transport.tasks(p, nextTasks);
      if (p === currentProject.current) {
        setTasks((v) => [...v, ...r.items]);
        setNextTasks(r.nextOffset);
      }
    } catch {
      setError("Could not load more tasks.");
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
        setError("Contextul de reluare nu poate fi pregătit.");
    } finally {
      if (selectedKey.current === key) setResuming(false);
    }
  }
  return (
    <section className="ck-task-panel">
      <header>
        <span className="ck-task-eyebrow">CONTEXTKEEP</span>
        <h2>Task dossier</h2>
        <p>Checkpoint, execution and verification in one place.</p>
      </header>
      <div className="ck-task-controls">
        {!fixedProject && (
          <label>
            Project
            <select
              aria-label="Project"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setTaskId("");
                setView(null);
              }}
            >
              <option value="">Select a project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Task
          <select
            aria-label="Task"
            value={taskId}
            onChange={(e) => {
              setTaskId(e.target.value);
              setView(null);
            }}
          >
            <option value="">Select a task</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.subject.slice(0, 160)} · {t.reviewStatus}
              </option>
            ))}
          </select>
        </label>
        {nextTasks !== null && (
          <button onClick={() => void moreTasks()}>More tasks</button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {!projectId && transport.portfolio && (
        <PortfolioNow load={transport.portfolio} onProject={setProjectId} />
      )}
      {projectId && !taskId && transport.overview && (
        <ProjectNow
          projectId={projectId}
          load={transport.overview}
          onTask={setTaskId}
        />
      )}
      {projectId && !taskId && transport.activity && (
        <OperationalHistory projectId={projectId} load={transport.activity} />
      )}
      {!view && tasksStatus !== "error" && (
        <p className="ck-task-muted">
          {tasksStatus === "loading"
            ? "Loading tasks…"
            : loading
              ? "Loading task…"
              : tasksStatus === "loaded" && tasks.length === 0
                ? "No current action records in this project."
                : "Choose a task to inspect its state."}
        </p>
      )}
      {view && (
        <>
          {view.dossier && <TaskNow dossier={view.dossier} />}
          {transport.resume && (
            <div className="ck-resume-controls">
              <button disabled={resuming} onClick={() => void prepareResume()}>
                {resuming ? "Se pregătește…" : "Reia lucrarea"}
              </button>
              <small>
                Pregătește contextul actual. Nu pornește nicio execuție.
              </small>
              {resumeText && (
                <label>
                  Context de reluare
                  <textarea
                    aria-label="Resume context"
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
            <summary>Obiectivul și starea inițială</summary>
            <div className="ck-task-state">
              <strong>{view.task.text ?? view.task.subject}</strong>
              <span>{view.task.taskStatus ?? "No progress recorded"}</span>
              <span>
                {view.task.reviewStatus} · revision {view.task.revision}
              </span>
            </div>
          </details>
          {!view.dossier && (
            <article>
              <h3>Resume</h3>
              <p>
                {view.latestCheckpoint?.checkpoint?.summary ??
                  "No checkpoint for this task."}
              </p>
              {view.latestCheckpoint && (
                <>
                  <p>
                    <b>Next:</b>{" "}
                    {view.latestCheckpoint.checkpoint?.nextAction ??
                      "Not specified"}
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
              <h3>Blockers</h3>
              <ul>
                {view.blockers.active.map((b) => (
                  <li key={b.blockerId}>{b.text}</li>
                ))}
              </ul>
            </article>
          )}
          <article>
            <h3>Executions</h3>
            {view.runs.length === 0 ? (
              <p>No runs recorded.</p>
            ) : (
              view.runs.map((r) => (
                <div className="ck-task-run" key={r.id}>
                  <div>
                    <b>{r.status}</b>
                    <span>Verification: {r.verification}</span>
                  </div>
                  <small>
                    {r.externalJobId ?? "No executor receipt"} ·{" "}
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
              <h3>Evidence timeline</h3>
              {view.records.length === 0 ? (
                <p>No reports for this task.</p>
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
          <nav aria-label="Task history pages">
            <button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              Previous
            </button>{" "}
            <button
              disabled={view.pagination.nextOffset === null}
              onClick={() => setOffset(view.pagination.nextOffset ?? offset)}
            >
              More history
            </button>
          </nav>
          <small>
            Execution completion does not complete the task. Agent reports
            retain their review status.
          </small>
        </>
      )}
    </section>
  );
}
