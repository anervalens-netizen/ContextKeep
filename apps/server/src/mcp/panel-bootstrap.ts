import {
  DEFAULT_PANEL_PREFERENCES,
  type PanelPreferences,
} from "@contextkeep/shared";
import type { ServiceDeps } from "../services/import.js";
import { listProjects } from "./reads.js";
import { getTaskView, listTasks } from "../services/workflow.js";
import {
  operationalTimeline,
  portfolioOverview,
  projectDossier,
} from "../services/operational-dossier.js";
import { requireProject } from "../services/memory-management.js";
import { ApiError } from "../lib/errors.js";

/** Selectors carry names and routing identity only, never full project memory. */
export function panelProjects(deps: ServiceDeps, page: { offset: number; limit: number }, q?: string) {
  const result = listProjects(deps, page, q);
  return { ...result, projection: "selector" as const, projects: result.projects.map(({ id, name }) => ({ id, name })) };
}
export function panelTasks(deps: ServiceDeps, input: {
  projectId: string; offset: number; limit: number;
  selection: "all_actions" | "actual_tasks"; q?: string; view?: "recent" | "attention" | "active";
}) {
  const result = listTasks(deps, input.projectId, input.offset, input.limit, input.selection, input.q, input.view);
  return { ...result, projection: "selector" as const, items: result.items.map(task => ({
    id: task.id, subject: task.subject, taskStatus: task.taskStatus, effectiveState: task.effectiveState,
    stateSource: task.stateSource, reviewStatus: task.reviewStatus, revision: task.revision,
  })) };
}

export function panelBootstrap(
  deps: ServiceDeps,
  input: { projectId?: string; taskId?: string },
  preferences: PanelPreferences = DEFAULT_PANEL_PREFERENCES,
) {
  if (input.taskId && !input.projectId)
    throw new ApiError(
      400,
      "project_required",
      "Select a project for this task.",
    );
  return deps.sqlite.transaction(() => {
    const reads: Array<{
      tool: string;
      arguments: Record<string, unknown>;
      value: unknown;
    }> = [];
    const add = (tool: string, args: Record<string, unknown>, value: unknown) =>
      reads.push({ tool, arguments: args, value });
    const projects = panelProjects(deps, { offset: 0, limit: 50 });
    let selectedProject: { id: string; name: string } | undefined;
    if (input.projectId) {
      const project = requireProject(deps, input.projectId);
      selectedProject = { id: project.id, name: project.name };
    }
    add("panel_list_projects", { offset: 0, limit: 50 }, projects);
    if (input.projectId) {
      const projectId = input.projectId;
      add(
        "panel_list_tasks",
        {
          projectId,
          offset: 0,
          limit: 50,
          selection: preferences.taskVisibility,
          view: preferences.landingView,
        },
        panelTasks(deps, {
          projectId, offset: 0, limit: 50,
          selection: preferences.taskVisibility, view: preferences.landingView,
        }),
      );
      if (input.taskId) {
        add(
          "get_task",
          { projectId, taskId: input.taskId, offset: 0, limit: 20 },
          getTaskView(deps, {
            projectId,
            taskId: input.taskId,
            offset: 0,
            limit: 20,
          }),
        );
      } else {
        add(
          "get_project_dossier",
          {
            projectId,
            offset: 0,
            limit: 10,
            selection: preferences.taskVisibility,
            view: preferences.landingView,
          },
          projectDossier(
            deps,
            projectId,
            0,
            10,
            null,
            10,
            preferences.taskVisibility,
            preferences.landingView,
          ),
        );
      }
      const args = {
        projectId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        offset: 0,
        limit: 20,
        scope: "all" as const,
      };
      add("get_operational_timeline", args, operationalTimeline(deps, args));
    } else {
      add(
        "get_portfolio",
        {
          offset: 0,
          limit: 20,
          includeRetired: false,
          selection: preferences.taskVisibility,
        },
        portfolioOverview(deps, 0, 20, false, preferences.taskVisibility),
      );
    }
    const view = reads.find((read) => read.tool === "get_task")?.value as
      ReturnType<typeof getTaskView> | undefined;
    return {
      ...input,
      revision: view?.task.revision ?? 0,
      view: input.taskId ? "task" : "projects",
      startsExecution: false,
      bootstrap: {
        version: 1,
        preferences,
        observedAt: new Date().toISOString(),
        selectedProject,
        reads,
      },
    };
  })();
}
