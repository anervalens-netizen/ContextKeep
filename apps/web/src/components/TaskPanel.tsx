import { useEffect, useRef, useState } from "react";
import "./task-panel.css";
export type TaskSelection = {
  projectId: string;
  taskId: string;
  revision: number;
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
}: {
  transport: TaskTransport;
  projectId?: string;
  selection?: TaskSelection;
  onSelection?: (s: TaskSelection) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]),
    [projectId, setProjectId] = useState(
      fixedProject ?? selection?.projectId ?? "",
    ),
    [taskId, setTaskId] = useState(selection?.taskId ?? "");
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [projectId, taskId]);
  const [tasks, setTasks] = useState<Task[]>([]),
    [nextTasks, setNextTasks] = useState<number | null>(null),
    [view, setView] = useState<TaskView | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
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
    if (projectId)
      transport
        .tasks(projectId)
        .then((r) => {
          if (active) {
            setTasks(r.items);
            setNextTasks(r.nextOffset);
          }
        })
        .catch(() => {
          if (active) setError("Could not load tasks.");
        });
    return () => {
      active = false;
    };
  }, [transport, projectId]);
  useEffect(() => {
    const request = ++serial.current;
    let stopped = false;
    setView(null);
    setError("");
    if (!projectId || !taskId) return;
    const refresh = async () => {
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
        });
      } catch {
        if (!stopped && serial.current === request)
          setError("Could not refresh task. Displayed data may be stale.");
      } finally {
        if (!stopped && serial.current === request) setLoading(false);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
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
                {(t.text ?? t.subject).slice(0, 160)} · {t.reviewStatus}
              </option>
            ))}
          </select>
        </label>
        {nextTasks !== null && (
          <button onClick={() => void moreTasks()}>More tasks</button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {!view && (
        <p className="ck-task-muted">
          {loading
            ? "Loading task…"
            : projectId && tasks.length === 0
              ? "No current action records in this project."
              : "Choose a task to inspect its state."}
        </p>
      )}
      {view && (
        <>
          <div className="ck-task-state">
            <strong>{view.task.text ?? view.task.subject}</strong>
            <span>{view.task.taskStatus ?? "No progress recorded"}</span>
            <span>
              {view.task.reviewStatus} · revision {view.task.revision}
            </span>
          </div>
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
                  {new Date(view.latestCheckpoint.recordedAt).toLocaleString()}
                </small>
              </>
            )}
          </article>
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
          <article>
            <h3>Evidence timeline</h3>
            {view.records.length === 0 ? (
              <p>No reports for this task.</p>
            ) : (
              view.records.map((r) => (
                <details key={r.id}>
                  <summary>
                    {new Date(r.recordedAt).toLocaleString()} · {r.reviewStatus}
                  </summary>
                  <p className="ck-task-evidence">{r.text}</p>
                </details>
              ))
            )}
          </article>
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
