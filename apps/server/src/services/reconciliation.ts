import { inArray } from "drizzle-orm";
import type {
  WorkspaceHistorySignalDto,
  WorkspaceReconciliationDto,
  WorkspaceReconciliationStatus,
  WorkspaceSuggestionDto,
} from "@contextkeep/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { auditEvents, importJobs, projects } from "../db/schema.js";
import { nowIso } from "../lib/time.js";
import { catalogCodexSessions, catalogCodexSummaries } from "./codex.js";
import { catalogDshSessions } from "./dsh.js";
import { listWorkspaces } from "./workspaces.js";

// Catalog functions already enumerate/sort the complete metadata set before
// slicing. Reconciliation needs complete counts, not the bounded UI pages used
// by connector catalog routes.
const RECONCILIATION_CATALOG_LIMIT = Number.MAX_SAFE_INTEGER;

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function emptyHistory(): WorkspaceHistorySignalDto {
  return {
    codexCurrentCount: 0,
    codexArchivedCount: 0,
    codexSummaryCount: 0,
    dshSessionCount: 0,
    lastSessionActivity: null,
    lastAgentActivity: null,
  };
}

function parseAliases(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function normalizedLabel(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function seededProjects(db: Db, projectRows: (typeof projects.$inferSelect)[]): Set<string> {
  const seedTimes = new Set<string>();
  for (const row of db.select({ createdAt: importJobs.createdAt, usageJson: importJobs.usageJson }).from(importJobs).all()) {
    if (!row.usageJson) continue;
    try {
      const usage = JSON.parse(row.usageJson) as { seed?: unknown };
      if (usage.seed === true) seedTimes.add(row.createdAt);
    } catch {
      // Non-seed usage payloads are irrelevant to project provenance.
    }
  }
  return new Set(projectRows.filter((project) => seedTimes.has(project.createdAt)).map((project) => project.id));
}

function bindingModes(db: Db): Map<string, "tracked" | "linked"> {
  const rows = db
    .select({
      workspaceId: auditEvents.targetId,
      action: auditEvents.action,
      timestamp: auditEvents.timestamp,
    })
    .from(auditEvents)
    .where(inArray(auditEvents.action, ["workspace.tracked", "workspace.linked"]))
    .all()
    .filter((row): row is { workspaceId: string; action: string; timestamp: string } => Boolean(row.workspaceId))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const out = new Map<string, "tracked" | "linked">();
  for (const row of rows) out.set(row.workspaceId, row.action === "workspace.tracked" ? "tracked" : "linked");
  return out;
}

function statusFor(
  workspace: ReturnType<typeof listWorkspaces>[number],
  modes: Map<string, "tracked" | "linked">,
): WorkspaceReconciliationStatus {
  if (workspace.ignored) return "ignored";
  if (!workspace.projectId) return "unresolved";
  return modes.get(workspace.id) ?? "linked";
}

function suggestionFor(
  workspace: ReturnType<typeof listWorkspaces>[number],
  projectRows: (typeof projects.$inferSelect)[],
  seededIds: Set<string>,
  githubOwner: string | null,
): WorkspaceSuggestionDto {
  if (workspace.ignored || workspace.projectId) {
    return { action: null, projectId: null, projectName: null, confidence: null, reason: null };
  }

  const workspaceName = normalizedLabel(workspace.displayName);
  const exactMatches = projectRows.filter((project) => {
    if (normalizedLabel(project.name) === workspaceName) return true;
    return parseAliases(project.aliasesJson).some((alias) => normalizedLabel(alias) === workspaceName);
  });
  if (exactMatches.length > 1) {
    return {
      action: "review",
      projectId: null,
      projectName: null,
      confidence: "low",
      reason: `Multiple canonical projects (${exactMatches.length}) match this workspace name/alias; choose the intended project explicitly.`,
    };
  }
  const exact = exactMatches[0];
  if (exact) {
    const seeded = seededIds.has(exact.id);
    return {
      action: "link",
      projectId: exact.id,
      projectName: exact.name,
      confidence: seeded ? "medium" : "high",
      reason: seeded
        ? "Exact existing project name/alias match, but that project originated from demo seed data; owner confirmation is required."
        : "Exact existing project name/alias match.",
    };
  }

  const remote = workspace.gitRemote?.toLocaleLowerCase() ?? null;
  if (remote?.startsWith("github.com/") && githubOwner) {
    if (remote.startsWith(`github.com/${githubOwner.toLocaleLowerCase()}/`)) {
      return {
        action: "track",
        projectId: null,
        projectName: null,
        confidence: "high",
        reason: "Git remote belongs to the configured owner GitHub account and no exact canonical project exists yet.",
      };
    }
    return {
      action: "ignore",
      projectId: null,
      projectName: null,
      confidence: "medium",
      reason: "Git remote belongs to a different GitHub owner; keep it untracked unless it matters as an owner project.",
    };
  }
  if (remote?.startsWith("github.com/")) {
    return {
      action: "review",
      projectId: null,
      projectName: null,
      confidence: "low",
      reason: "GitHub owner identity is not configured, so ContextKeep cannot safely classify this remote as owner-owned or third-party.",
    };
  }
  return {
    action: "review",
    projectId: null,
    projectName: null,
    confidence: "low",
    reason: "No configured owner remote or exact canonical-project match proves how this workspace should be classified.",
  };
}

export function buildWorkspaceReconciliation(db: Db, config: AppConfig): WorkspaceReconciliationDto {
  const workspaces = listWorkspaces(db);
  const projectRows = db.select().from(projects).all();
  const seededIds = seededProjects(db, projectRows);
  const modes = bindingModes(db);
  const history = new Map(workspaces.map((workspace) => [workspace.id, emptyHistory()]));

  let codexCatalogAvailable = true;
  try {
    const sessions = catalogCodexSessions(db, config.codexHome, { state: "all", limit: RECONCILIATION_CATALOG_LIMIT });
    if (sessions.unreadableCount > 0) codexCatalogAvailable = false;
    for (const session of sessions.sessions) {
      if (!session.workspaceBindingId) continue;
      const item = history.get(session.workspaceBindingId);
      if (!item) continue;
      if (session.archiveState === "archived") item.codexArchivedCount += 1;
      else item.codexCurrentCount += 1;
      item.lastSessionActivity = maxIso(item.lastSessionActivity ?? null, session.updatedAt);
      item.lastAgentActivity = maxIso(item.lastAgentActivity, session.updatedAt);
    }
    const summaries = catalogCodexSummaries(db, config.codexHome, RECONCILIATION_CATALOG_LIMIT);
    if (summaries.unreadableCount > 0) codexCatalogAvailable = false;
    for (const summary of summaries.summaries) {
      if (!summary.workspaceBindingId) continue;
      const item = history.get(summary.workspaceBindingId);
      if (!item) continue;
      item.codexSummaryCount += 1;
      item.lastAgentActivity = maxIso(item.lastAgentActivity, summary.updatedAt);
    }
  } catch {
    codexCatalogAvailable = false;
  }

  let dshCatalogAvailable = true;
  try {
    const sessions = catalogDshSessions(db, config.dshHome, RECONCILIATION_CATALOG_LIMIT);
    if (sessions.unreadableCount > 0) dshCatalogAvailable = false;
    for (const session of sessions.sessions) {
      if (!session.workspaceBindingId) continue;
      const item = history.get(session.workspaceBindingId);
      if (!item) continue;
      item.dshSessionCount += 1;
      item.lastSessionActivity = maxIso(item.lastSessionActivity ?? null, session.updatedAt);
      item.lastAgentActivity = maxIso(item.lastAgentActivity, session.updatedAt);
    }
  } catch {
    dshCatalogAvailable = false;
  }

  const items = workspaces.map((workspace) => ({
    workspace,
    status: statusFor(workspace, modes),
    history: history.get(workspace.id) ?? emptyHistory(),
    suggestion: suggestionFor(workspace, projectRows, seededIds, config.workspaceGithubOwner),
  }));

  items.sort((a, b) => {
    if (a.status === "unresolved" && b.status !== "unresolved") return -1;
    if (a.status !== "unresolved" && b.status === "unresolved") return 1;
    const aTime = maxIso(a.history.lastAgentActivity, a.workspace.lastObservedActivity) ?? "";
    const bTime = maxIso(b.history.lastAgentActivity, b.workspace.lastObservedActivity) ?? "";
    if (aTime !== bTime) return bTime.localeCompare(aTime);
    return a.workspace.displayName.localeCompare(b.workspace.displayName);
  });

  const count = (status: WorkspaceReconciliationStatus): number => items.filter((item) => item.status === status).length;
  return {
    generatedAt: nowIso(),
    total: items.length,
    tracked: count("tracked"),
    linked: count("linked"),
    ignored: count("ignored"),
    unresolved: count("unresolved"),
    codexCatalogAvailable,
    dshCatalogAvailable,
    seededProjectIds: [...seededIds].sort(),
    items,
  };
}
