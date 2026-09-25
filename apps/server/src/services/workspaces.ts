import {
  discoverGitWorkspaces,
  type WorkspaceScanConfig,
} from "./workspace-discovery.js";
import { laterIso, timestampMs } from "./workspace-policy.js";
export { discoverGitWorkspaces } from "./workspace-discovery.js";
export { normalizeGitRemote } from "./workspace-policy.js";
export type { WorkspaceScanConfig } from "./workspace-discovery.js";

import { eq, inArray } from "drizzle-orm";
import type {
  LifecycleState,
  WorkspaceActionInput,
  WorkspaceDto,
  WorkspaceScanResultDto,
} from "@contextkeep/shared";
import type { Db } from "../db/client.js";
import { projects } from "../db/schema.js";
import { workspaceBindings } from "../db/workspace-schema.js";
import { ApiError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import { writeAudit } from "./audit.js";

function workspaceDto(
  row: typeof workspaceBindings.$inferSelect,
  projectMap: Map<string, typeof projects.$inferSelect>,
): WorkspaceDto {
  const project = row.projectId ? projectMap.get(row.projectId) : undefined;
  return {
    id: row.id,
    canonicalKey: row.canonicalKey,
    canonicalPath: row.canonicalPath,
    displayName: row.displayName,
    gitRemote: row.gitRemote,
    gitBranch: row.gitBranch,
    gitHeadSha: row.gitHeadSha,
    lastGitActivity: row.lastGitActivity,
    lastObservedActivity: row.lastObservedActivity,
    projectId: row.projectId,
    projectName: project?.name ?? null,
    projectLifecycle:
      (project?.lifecycle as LifecycleState | undefined) ?? null,
    ignored: row.ignored === 1,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listWorkspaces(db: Db): WorkspaceDto[] {
  const rows = db.select().from(workspaceBindings).all();
  const ids = [
    ...new Set(
      rows.map((r) => r.projectId).filter((id): id is string => id !== null),
    ),
  ];
  const projectRows =
    ids.length > 0
      ? db.select().from(projects).where(inArray(projects.id, ids)).all()
      : [];
  const projectMap = new Map(projectRows.map((p) => [p.id, p]));
  return rows
    .map((r) => workspaceDto(r, projectMap))
    .sort((a, b) => {
      const activityDiff =
        timestampMs(b.lastObservedActivity) -
        timestampMs(a.lastObservedActivity);
      return activityDiff !== 0
        ? activityDiff
        : a.displayName.localeCompare(b.displayName);
    });
}

const activeScans = new WeakSet<Db>();

/** Only one observation scan per database; aborted/partial discovery never mutates it. */
export async function scanAndUpsertWorkspaces(
  db: Db,
  config: WorkspaceScanConfig,
  ctx: { actor: string; requestId?: string | null },
): Promise<WorkspaceScanResultDto> {
  if (activeScans.has(db)) {
    throw new ApiError(
      409,
      "workspace_scan_in_progress",
      "A workspace scan is already in progress.",
    );
  }
  activeScans.add(db);
  try {
    return await performWorkspaceScan(db, config, ctx);
  } finally {
    activeScans.delete(db);
  }
}

async function performWorkspaceScan(
  db: Db,
  config: WorkspaceScanConfig,
  ctx: { actor: string; requestId?: string | null },
): Promise<WorkspaceScanResultDto> {
  if (config.roots.length === 0) {
    throw new ApiError(
      409,
      "workspace_roots_not_configured",
      "Workspace discovery is not configured. Set CK_WORKSPACE_ROOTS to one or more owner-approved roots.",
    );
  }
  const discovered = await discoverGitWorkspaces(config);
  if (config.signal?.aborted) {
    throw new ApiError(
      499,
      "workspace_scan_aborted",
      "Workspace scan cancelled before persistence.",
    );
  }
  const now = nowIso();
  let insertedCount = 0;
  let updatedCount = 0;

  db.transaction((tx) => {
    for (const item of discovered) {
      const existing = tx
        .select()
        .from(workspaceBindings)
        .where(eq(workspaceBindings.canonicalKey, item.canonicalKey))
        .get();
      if (!existing) {
        tx.insert(workspaceBindings)
          .values({
            id: newId(),
            canonicalKey: item.canonicalKey,
            canonicalPath: item.canonicalPath,
            displayName: item.displayName,
            gitRemote: item.gitRemote,
            gitBranch: item.gitBranch,
            gitHeadSha: item.gitHeadSha,
            lastGitActivity: item.lastGitActivity,
            lastObservedActivity: item.lastGitActivity,
            projectId: null,
            ignored: 0,
            firstSeenAt: now,
            lastSeenAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        insertedCount += 1;
      } else {
        tx.update(workspaceBindings)
          .set({
            canonicalPath: item.canonicalPath,
            displayName: item.displayName,
            gitRemote: item.gitRemote,
            gitBranch: item.gitBranch,
            gitHeadSha: item.gitHeadSha,
            lastGitActivity: item.lastGitActivity,
            lastObservedActivity: laterIso(
              existing.lastObservedActivity,
              item.lastGitActivity,
            ),
            lastSeenAt: now,
            updatedAt: now,
          })
          .where(eq(workspaceBindings.id, existing.id))
          .run();
        updatedCount += 1;
      }
    }
    writeAudit(tx, {
      actor: ctx.actor,
      action: "workspace.scan_completed",
      targetType: "workspace_registry",
      detail: {
        configuredRootCount: config.roots.length,
        discoveredCount: discovered.length,
        insertedCount,
        updatedCount,
      },
      requestId: ctx.requestId ?? null,
    });
  });

  return {
    configuredRootCount: config.roots.length,
    discoveredCount: discovered.length,
    insertedCount,
    updatedCount,
    workspaces: listWorkspaces(db),
  };
}

function requireWorkspace(
  db: Db,
  id: string,
): typeof workspaceBindings.$inferSelect {
  const row = db
    .select()
    .from(workspaceBindings)
    .where(eq(workspaceBindings.id, id))
    .get();
  if (!row)
    throw new ApiError(
      404,
      "workspace_not_found",
      `Workspace ${id} not found.`,
    );
  return row;
}

function requireProject(db: Db, id: string): typeof projects.$inferSelect {
  const row = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!row)
    throw new ApiError(404, "project_not_found", `Project ${id} not found.`);
  return row;
}

export function applyWorkspaceAction(
  db: Db,
  workspaceId: string,
  input: WorkspaceActionInput,
  ctx: { actor: string; requestId?: string | null },
): WorkspaceDto {
  const now = nowIso();
  db.transaction((tx) => {
    const before = requireWorkspace(tx, workspaceId);
    if (before.updatedAt !== input.expectedUpdatedAt) {
      throw new ApiError(
        409,
        "workspace_stale_action",
        "Workspace state changed after this action was prepared. Refresh and choose the action again.",
        {
          expectedUpdatedAt: input.expectedUpdatedAt,
          currentUpdatedAt: before.updatedAt,
        },
      );
    }

    if (input.action === "link") {
      const project = requireProject(tx, input.projectId);
      tx.update(workspaceBindings)
        .set({ projectId: project.id, ignored: 0, updatedAt: now })
        .where(eq(workspaceBindings.id, workspaceId))
        .run();
      writeAudit(tx, {
        actor: ctx.actor,
        action: "workspace.linked",
        targetType: "workspace",
        targetId: workspaceId,
        before: { projectId: before.projectId, ignored: before.ignored === 1 },
        after: { projectId: project.id, ignored: false },
        requestId: ctx.requestId ?? null,
      });
      return;
    }

    if (input.action === "unlink") {
      tx.update(workspaceBindings)
        .set({ projectId: null, updatedAt: now })
        .where(eq(workspaceBindings.id, workspaceId))
        .run();
      writeAudit(tx, {
        actor: ctx.actor,
        action: "workspace.unlinked",
        targetType: "workspace",
        targetId: workspaceId,
        before: { projectId: before.projectId },
        after: { projectId: null },
        requestId: ctx.requestId ?? null,
      });
      return;
    }

    if (input.action === "ignore") {
      tx.update(workspaceBindings)
        .set({ projectId: null, ignored: 1, updatedAt: now })
        .where(eq(workspaceBindings.id, workspaceId))
        .run();
      writeAudit(tx, {
        actor: ctx.actor,
        action: "workspace.ignored",
        targetType: "workspace",
        targetId: workspaceId,
        before: { projectId: before.projectId, ignored: before.ignored === 1 },
        after: { projectId: null, ignored: true },
        requestId: ctx.requestId ?? null,
      });
      return;
    }

    if (input.action === "unignore") {
      tx.update(workspaceBindings)
        .set({ ignored: 0, updatedAt: now })
        .where(eq(workspaceBindings.id, workspaceId))
        .run();
      writeAudit(tx, {
        actor: ctx.actor,
        action: "workspace.unignored",
        targetType: "workspace",
        targetId: workspaceId,
        before: { ignored: before.ignored === 1 },
        after: { ignored: false },
        requestId: ctx.requestId ?? null,
      });
      return;
    }

    const name = (input.name ?? before.displayName).trim();
    const duplicate = tx
      .select()
      .from(projects)
      .where(eq(projects.name, name))
      .get();
    if (duplicate) {
      throw new ApiError(
        409,
        "workspace_project_name_exists",
        `A project named "${name}" already exists. Link this workspace to that project instead.`,
        { projectId: duplicate.id },
      );
    }
    const projectId = newId();
    tx.insert(projects)
      .values({
        id: projectId,
        name,
        aliasesJson: "[]",
        parentProjectId: null,
        description: null,
        lifecycle: "unknown",
        lifecycleRecordId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.update(workspaceBindings)
      .set({ projectId, ignored: 0, updatedAt: now })
      .where(eq(workspaceBindings.id, workspaceId))
      .run();
    writeAudit(tx, {
      actor: ctx.actor,
      action: "workspace.tracked",
      targetType: "workspace",
      targetId: workspaceId,
      before: { projectId: before.projectId, ignored: before.ignored === 1 },
      after: {
        projectId,
        projectName: name,
        lifecycle: "unknown",
        ignored: false,
      },
      requestId: ctx.requestId ?? null,
    });
  });

  const dto = listWorkspaces(db).find((w) => w.id === workspaceId);
  if (!dto)
    throw new ApiError(
      404,
      "workspace_not_found",
      `Workspace ${workspaceId} not found.`,
    );
  return dto;
}
