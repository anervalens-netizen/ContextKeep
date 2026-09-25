import type { WorkspaceReconciliationItemDto } from "@contextkeep/shared";
import type { IconName } from "./Icon.js";
export const NAV_ITEMS = [
  { to: "/", label: "Projects", icon: "projects" },
  { to: "/inbox", label: "Inbox", icon: "inbox" },
  { to: "/import", label: "Import", icon: "import" },
  { to: "/corrections", label: "Correct", icon: "correct" },
  { to: "/search", label: "Search", icon: "search" },
] as const satisfies readonly { to: string; label: string; icon: IconName }[];

export function isActiveNav(pathname: string, to: string): boolean {
  return to === "/" ? pathname === "/" : pathname.startsWith(to);
}

export type ProjectSignal = {
  lastSessionActivity: string | null;
  codexSessions: number;
  dshSessions: number;
  summaries: number;
};

export function sessionCounts(item: WorkspaceReconciliationItemDto): ProjectSignal {
  return {
    lastSessionActivity: item.history.lastSessionActivity ?? null,
    codexSessions: item.history.codexCurrentCount + item.history.codexArchivedCount,
    dshSessions: item.history.dshSessionCount,
    summaries: item.history.codexSummaryCount,
  };
}

export function relativeTime(value: string | null): string {
  if (!value) return "No agent activity";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  const delta = Date.now() - ms;
  if (delta < 60_000) return "Just now";
  if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function initials(name: string): string {
  const parts = name.split(/[\s/_-]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : name.slice(0, 2)).toUpperCase();
}
