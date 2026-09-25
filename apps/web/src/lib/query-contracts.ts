export const queryRoots = {
  projects: ["projects"] as const,
  meta: ["meta"] as const,
  inbox: ["inbox"] as const,
  brief: ["brief"] as const,
  workContext: ["work-context"] as const,
};

export const queryKeys = {
  projects: queryRoots.projects,
  meta: queryRoots.meta,
  inbox: (projectId: string | null, page: number, limit: number) =>
    ["inbox", projectId, page, limit] as const,
  workContext: (projectId: string) => ["work-context", projectId] as const,
};

export const cacheScopes = {
  projects: "projects:list",
  meta: "meta:dashboard",
  inbox: (projectId: string | null, page: number, limit: number) =>
    `inbox:project=${projectId ?? "*"}:page=${page}:limit=${limit}`,
  workContext: (projectId: string) => `project:${projectId}:work-context`,
};
