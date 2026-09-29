import { createRoot } from "react-dom/client";
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import {
  TaskPanel,
  type TaskTransport,
  type TaskSelection,
} from "./components/TaskPanel.js";
const app = new App({ name: "ContextKeep task dossier", version: "1.0.0" });
const extensions = new OpenAIExtensions(app);
let selection: TaskSelection | undefined,
  lastSelection = "";
const root = createRoot(document.getElementById("root")!);
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error("ContextKeep request failed.");
  return result.structuredContent as Record<string, unknown>;
}
const transport: TaskTransport = {
  projects: async () => {
    const projects = [];
    let offset: number | null = 0;
    do {
      const r = await call("list_projects", { offset, limit: 50 });
      projects.push(...(r.projects as Array<{ id: string; name: string }>));
      offset = r.nextOffset as number | null;
    } while (offset !== null);
    return projects;
  },
  tasks: async (projectId, offset = 0) =>
    (await call("list_tasks", { projectId, offset })) as Awaited<
      ReturnType<TaskTransport["tasks"]>
    >,
  task: async (projectId, taskId, offset = 0) =>
    (await call("get_task", { projectId, taskId, offset })) as Awaited<
      ReturnType<TaskTransport["task"]>
    >,
};
function render() {
  root.render(
    <TaskPanel
      transport={transport}
      selection={selection}
      onSelection={(s) => {
        const compact = JSON.stringify(s);
        if (compact === lastSelection) return;
        lastSelection = compact;
        void extensions.modelContext?.update({
          structuredContent: s,
          content: [
            {
              type: "text",
              text: `Selected ContextKeep task ${s.taskId}, revision ${s.revision}.`,
            },
          ],
        });
      }}
    />,
  );
}
function takeSelection(value: unknown) {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (typeof v.projectId === "string") {
    selection = {
      projectId: v.projectId,
      taskId: typeof v.taskId === "string" ? v.taskId : "",
      revision: typeof v.revision === "number" ? v.revision : 0,
    };
    lastSelection = JSON.stringify(selection);
    render();
  }
}
app.ontoolresult = (result) => {
  takeSelection(result.structuredContent);
  render();
};
app.addEventListener("hostcontextchanged", () => {
  const context = app.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables)
    applyHostStyleVariables(context.styles.variables);
  takeSelection(extensions.modelContext?.getCurrent()?.structuredContent);
});
void app
  .connect()
  .then(() => {
    takeSelection(extensions.modelContext?.getCurrent()?.structuredContent);
    render();
  })
  .catch(() => {
    root.render(
      <p>
        Open this panel through the ContextKeep plugin in a compatible host.
      </p>,
    );
  });
