import { TaskPanel, type TaskTransport } from "./TaskPanel.js";
import { apiFetch } from "../lib/api.js";
const transport: TaskTransport = {
  projects: () => apiFetch("/api/projects"),
  overview: (p, offset = 0, attentionOffset) =>
    apiFetch(
      `/api/projects/${p}/dossier?offset=${offset}&limit=10${attentionOffset === undefined ? "" : `&attentionOffset=${attentionOffset}&attentionLimit=10`}`,
    ),
  portfolio: (offset = 0) =>
    apiFetch(`/api/portfolio?offset=${offset}&limit=20`),
  resume: (p, t) => apiFetch(`/api/projects/${p}/tasks/${t}/resume`),
  activity: (p, t, offset = 0, scope = "all") =>
    apiFetch(
      `/api/projects/${p}/activity?offset=${offset}&limit=20&scope=${scope}${t ? `&taskId=${t}` : ""}`,
    ),
  tasks: (p, offset = 0) =>
    apiFetch(`/api/projects/${p}/tasks?offset=${offset}`),
  task: (p, t, offset = 0) =>
    apiFetch(`/api/projects/${p}/tasks/${t}?offset=${offset}`),
};
export function PwaTaskPanel({ projectId }: { projectId: string }) {
  return <TaskPanel projectId={projectId} transport={transport} />;
}
