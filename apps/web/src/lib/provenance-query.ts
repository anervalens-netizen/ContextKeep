import type { McpWorkContextResult, ProjectDto } from "@contextkeep/shared";
import { apiFetch, isNetworkUnavailableError } from "./api.js";
import {
  META_DASHBOARD_KEY,
  PROJECTS_KEY,
  readCache,
  saveToCacheBestEffort,
  workContextKey,
} from "./offline/mirror.js";
import { cacheScopes } from "./query-contracts.js";

export type ProvenancedRead<T> = {
  data: T;
  provenance: { source: "network" | "cache"; fetchedAt: string | null };
};
export type MetaStatus = {
  adapters?: { id: string; label: string; enabled: boolean }[];
  appVersion: string;
  schemaVersion: number;
  buildSha?: string | null;
  backup?: {
    status: "fresh" | "stale" | "missing";
    latestCreatedAt: string | null;
    ageSeconds: number | null;
    staleAfterHours: number;
    rotatingCount: number;
    manifestPresent: boolean;
    verificationStatus: "verified" | "unknown" | "changed_or_invalid";
    latestVerifiedAt: string | null;
    latestBackupRestoreTestedAt: string | null;
    lastRestoreTestedAt: string | null;
  };
};
async function read<T>(
  url: string,
  key: string,
  scope: string,
  cursor?: (data: T) => unknown,
): Promise<ProvenancedRead<T>> {
  try {
    let fetchedAt: string | undefined;
    const data = await apiFetch<T>(url, {
      noQueue: true,
      onDataProvenance: (meta) => {
        fetchedAt = meta.fetchedAt;
      },
    });
    void saveToCacheBestEffort(key, data, {
      fetchedAt,
      scope,
      cursor: cursor?.(data) ?? null,
    });
    return {
      data,
      provenance: { source: "network", fetchedAt: fetchedAt ?? null },
    };
  } catch (error) {
    if (!isNetworkUnavailableError(error)) throw error;
    const cached = await readCache<T>(key, scope);
    if (!cached) throw error;
    return {
      data: cached.value,
      provenance: { source: "cache", fetchedAt: cached.provenance.fetchedAt },
    };
  }
}
export const readMeta = (): Promise<ProvenancedRead<MetaStatus>> =>
  read<MetaStatus>(
    "/api/meta",
    META_DASHBOARD_KEY,
    cacheScopes.meta,
    (data) => data.schemaVersion,
  );
export const readWorkContext = (
  id: string,
): Promise<ProvenancedRead<McpWorkContextResult>> =>
  read<McpWorkContextResult>(
    `/api/projects/${id}/work-context`,
    workContextKey(id),
    cacheScopes.workContext(id),
    (data) => data.freshness,
  );

export const readShellProjects = (): Promise<ProvenancedRead<ProjectDto[]>> =>
  read("/api/projects", PROJECTS_KEY, cacheScopes.projects);
