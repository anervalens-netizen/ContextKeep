import { TaskPanel, type TaskTransport } from "./TaskPanel.js";
import { apiFetch } from "../lib/api.js";
export const transport: TaskTransport = {
  projects: () => apiFetch("/api/projects"),
  overview: (p, offset = 0, attentionOffset, options) =>
    apiFetch(
      `/api/projects/${p}/dossier?selection=${options?.selection ?? "actual_tasks"}${options?.view && options.view !== "recent" ? `&view=${options.view}` : ""}${options?.q ? `&q=${encodeURIComponent(options.q)}` : ""}&offset=${offset}&limit=10${attentionOffset === undefined ? "" : `&attentionOffset=${attentionOffset}&attentionLimit=10`}`,
    ),
  portfolio: (offset = 0) =>
    apiFetch(`/api/portfolio?selection=actual_tasks&offset=${offset}&limit=20`),
  resume: (p, t, depth = "balanced") =>
    apiFetch(`/api/projects/${p}/tasks/${t}/resume?depth=${depth}`),
  activity: (p, t, offset = 0, scope = "all") =>
    apiFetch(
      `/api/projects/${p}/activity?offset=${offset}&limit=20&scope=${scope}${t ? `&taskId=${t}` : ""}`,
    ),
  tasks: (p, offset = 0, options) =>
    apiFetch(
      `/api/projects/${p}/tasks?selection=${options?.selection ?? "actual_tasks"}${options?.view && options.view !== "recent" ? `&view=${options.view}` : ""}&offset=${offset}${options?.q ? `&q=${encodeURIComponent(options.q)}` : ""}`,
    ),
  task: (p, t, offset = 0) =>
    apiFetch(`/api/projects/${p}/tasks/${t}?offset=${offset}`),
};
export function PwaTaskPanel({ projectId }: { projectId: string }) {
  return <TaskPanel projectId={projectId} transport={transport} />;
}
