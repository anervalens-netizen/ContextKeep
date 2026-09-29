import { TaskPanel, type TaskTransport } from "./TaskPanel.js";
import { apiFetch } from "../lib/api.js";
const transport: TaskTransport = {
  projects: () => apiFetch("/api/projects"),
  tasks: (p, offset = 0) =>
    apiFetch(`/api/projects/${p}/tasks?offset=${offset}`),
  task: (p, t, offset = 0) =>
    apiFetch(`/api/projects/${p}/tasks/${t}?offset=${offset}`),
};
export function PwaTaskPanel({ projectId }: { projectId: string }) {
  return <TaskPanel projectId={projectId} transport={transport} />;
}
