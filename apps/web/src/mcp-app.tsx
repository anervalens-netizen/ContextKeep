import { captureError } from "./lib/error-reporting.js";
import { PanelLocale, translatePanel } from "./lib/panel-locale.js";
import { PanelPreferences } from "@contextkeep/shared";
import { PanelSettings } from "./components/PanelSettings.js";
import { PanelDisplay } from "./lib/panel-display.js";
import { PanelBootstrap } from "./lib/panel-bootstrap.js";
import { HostOperationFence } from "./lib/host-operation-fence.js";
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
const display = new PanelDisplay();
function requestFullscreen() {
  if (!connected) return;
  void display.requestFullscreen(app.getHostContext(), () =>
    app.requestDisplayMode({ mode: "fullscreen" }, { timeout: 5000 }),
  );
}
let selection: TaskSelection | undefined;
let connected = false,
  initialResult = false,
  launchRevision = 0;
const bootstrap = new PanelBootstrap();
const root = createRoot(document.getElementById("root")!, {onUncaughtError:(error)=>{captureError(error);},onCaughtError:(error)=>{captureError(error);}});
function panelText(text: string) {
  return translatePanel(bootstrap.preferences?.language ?? "ro", text);
}
function connectionNotice(message: string, failed = false) {
  root.render(
    <section className="ck-task-panel">
      <h2>ContextKeep</h2>
      <p role={failed ? "alert" : "status"}>{panelText(message)}</p>
    </section>,
  );
}
connectionNotice("Connecting to ContextKeep…");
const connectionTimer = setTimeout(() => {
  connectionNotice(
    "ContextKeep is taking longer to connect. Close and reopen the panel to try again.",
    true,
  );
}, 10000);

async function call(name: string, args: Record<string, unknown> = {}) {
  return bootstrap.read(name, args, async () => {
    const result = await app.callServerTool({ name, arguments: args });
    if (result.isError) throw new Error("ContextKeep request failed.");
    return result.structuredContent as Record<string, unknown>;
  });
}
const transport: TaskTransport = {
  overview: async (projectId, offset = 0, attentionOffset, options) =>
    (await call("get_project_dossier", {
      projectId,
      offset,
      limit: 10,
      selection: options?.selection ?? bootstrap.preferences!.taskVisibility,
      view: options?.view ?? bootstrap.preferences!.landingView,
      ...(options?.q ? { q: options.q } : {}),
      ...(attentionOffset === undefined
        ? {}
        : { attentionOffset, attentionLimit: 10 }),
    })) as unknown as Awaited<
      ReturnType<NonNullable<TaskTransport["overview"]>>
    >,
  portfolio: async (offset = 0, selected) =>
    (await call("get_portfolio", {
      offset,
      limit: 20,
      includeRetired: false,
      selection: selected ?? bootstrap.preferences!.taskVisibility,
    })) as unknown as Awaited<
      ReturnType<NonNullable<TaskTransport["portfolio"]>>
    >,
  resume: async (projectId, taskId) =>
    (await call("resume_task", { projectId, taskId })) as unknown as Awaited<
      ReturnType<NonNullable<TaskTransport["resume"]>>
    >,
  activity: async (projectId, taskId, offset = 0, scope = "all") =>
    (await call("get_operational_timeline", {
      projectId,
      ...(taskId ? { taskId } : {}),
      offset,
      limit: 20,
      scope,
    })) as unknown as Awaited<
      ReturnType<NonNullable<TaskTransport["activity"]>>
    >,
  projects: async () =>
    (await call("list_projects", { offset: 0, limit: 50 })).projects as Array<{
      id: string;
      name: string;
    }>,
  projectPage: async (offset = 0) => {
    const result = await call("list_projects", { offset, limit: 50 });
    const projects = result.projects as Array<{ id: string; name: string }>;
    const selected = bootstrap.selectedProject;
    return {
      projects:
        offset === 0 && selected && !projects.some((p) => p.id === selected.id)
          ? [...projects, selected]
          : projects,
      nextOffset: result.nextOffset as number | null,
    };
  },
  tasks: async (projectId, offset = 0, options) =>
    (await call("list_tasks", {
      projectId,
      offset,
      limit: 50,
      selection: options?.selection ?? "actual_tasks",
      view: options?.view ?? "recent",
      ...(options?.q ? { q: options.q } : {}),
    })) as Awaited<ReturnType<TaskTransport["tasks"]>>,
  task: async (projectId, taskId, offset = 0) =>
    (await call("get_task", {
      projectId,
      taskId,
      offset,
      limit: 20,
    })) as Awaited<ReturnType<TaskTransport["task"]>>,
};
const hostFence = new HostOperationFence(() => render());
let preferencesPending: number | null = null;
let preferencesError = "";
function preparePreferences() {
  if (preferencesPending === launchRevision) return;
  const epoch = launchRevision;
  preferencesPending = epoch;
  preferencesError = "";
  connectionNotice("Se citesc preferințele panoului…");
  void bootstrap
    .loadPreferences(() => call("settings.read"))
    .then((applied) => {
      if (applied && epoch === launchRevision) render();
    })
    .catch(() => {
      if (epoch === launchRevision)
        preferencesError = "Preferințele salvate nu pot fi citite.";
    })
    .finally(() => {
      if (epoch === launchRevision) {
        preferencesPending = null;
        render();
      }
    });
}
function render() {
  if (!connected || !initialResult) return;
  if (!bootstrap.preferences) {
    if (preferencesError)
      root.render(
        <section className="ck-task-panel">
          <h2>ContextKeep</h2>
          <p role="alert">{panelText(preferencesError)}</p>
          <button onClick={() => preparePreferences()}>
            {panelText("Reîncearcă preferințele")}
          </button>
        </section>,
      );
    else preparePreferences();
    return;
  }
  const epoch = launchRevision;
  const applyPreferences = async (
    name: string,
    args: Record<string, unknown>,
  ) => {
    const result = await call(name, args);
    if (epoch !== launchRevision) throw new Error("Panel changed");
    bootstrap.preferences = PanelPreferences.parse(result.values);
    render();
  };
  root.render(
    <PanelLocale.Provider value={bootstrap.preferences.language}>
      <PanelSettings
        key={"settings-" + launchRevision}
        values={bootstrap.preferences}
        save={(patch) => applyPreferences("settings.update", { set: patch })}
        reload={() => applyPreferences("settings.read", {})}
      />
      <TaskPanel
        key={launchRevision}
        transport={transport}
        selection={selection}
        initialLandingView={bootstrap.preferences!.landingView}
        contextBudget={bootstrap.preferences!.contextBudget}
        initialTaskVisibility={bootstrap.preferences!.taskVisibility}
        refreshIntervalMs={
          bootstrap.preferences!.refreshInterval === "manual"
            ? null
            : Number.parseInt(bootstrap.preferences!.refreshInterval, 10) * 1000
        }
        hostActions={{
          pending: hostFence.pending,
          messageUncertain: hostFence.messageUncertain,
          currentUpdateId:
            extensions.modelContext?.getCurrent()?.updateId ??
            (extensions.modelContext?.getCurrent() === null ? null : undefined),
          ...(extensions.modelContext
            ? {
                attach: async (payload) => {
                  const api = extensions.modelContext;
                  if (!api) throw new Error("Model context unsupported");
                  const ack = await hostFence.run("attach", () =>
                    api.update(
                      {
                        structuredContent: {
                          projectId: payload.projectId,
                          taskId: payload.taskId,
                          revision: payload.revision,
                          stateToken: payload.stateToken,
                          title: payload.title,
                          provenance: payload.provenance,
                        },
                        content: [{ type: "text", text: payload.text }],
                      },
                      { timeout: 15000 },
                    ),
                  );
                  if (!ack?.updateId)
                    throw new Error("Model context not acknowledged");
                  return ack;
                },
              }
            : {}),
          ...(extensions.message
            ? {
                send: async (payload) => {
                  const api = extensions.message;
                  if (!api) throw new Error("Message unsupported");
                  await hostFence.run("send", () =>
                    api.send(
                      {
                        role: "user",
                        content: [{ type: "text", text: payload.text }],
                        _meta: {
                          "openai/message": { target: "active", send: true },
                        },
                      },
                      { timeout: 15000 },
                    ),
                  );
                },
              }
            : {}),
        }}
      />
    </PanelLocale.Provider>,
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
    render();
  }
}
app.ontoolresult = (result) => {
  const value = result.structuredContent as Record<string, unknown> | undefined;
  bootstrap.prime(value?.bootstrap);
  initialResult = true;
  ++launchRevision;
  preferencesError = "";
  preferencesPending = null;
  selection = undefined;
  takeSelection(value);
  render();
};
app.addEventListener("hostcontextchanged", () => {
  requestFullscreen();
  const context = app.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables)
    applyHostStyleVariables(context.styles.variables);
  render();
});
void app
  .connect()
  .then(() => {
    clearTimeout(connectionTimer);
    const context = app.getHostContext();
    if (context?.theme) applyDocumentTheme(context.theme);
    if (context?.styles?.variables)
      applyHostStyleVariables(context.styles.variables);
    connected = true;
    requestFullscreen();
    if (initialResult) render();
    else
      root.render(
        <section className="ck-task-panel">
          <h2>ContextKeep</h2>
          <p role="status">
            {panelText("Se așteaptă contextul de deschidere…")}
          </p>
          <button
            onClick={() => {
              initialResult = true;
              ++launchRevision;
              preferencesError = "";
              takeSelection(
                extensions.modelContext?.getCurrent()?.structuredContent,
              );
              render();
            }}
          >
            {panelText("Încarcă proiectele")}
          </button>
        </section>,
      );
  })
  .catch(() => {
    clearTimeout(connectionTimer);
    connectionNotice(
      "ContextKeep could not connect. Close and reopen the panel to try again.",
      true,
    );
  });
