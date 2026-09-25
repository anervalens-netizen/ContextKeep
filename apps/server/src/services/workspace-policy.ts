export interface DiscoveredWorkspace {
  canonicalKey: string;
  canonicalPath: string;
  displayName: string;
  gitRemote: string | null;
  gitBranch: string | null;
  gitHeadSha: string | null;
  lastGitActivity: string | null;
  primaryCheckout: boolean;
}

function cleanRepoPath(raw: string): string | null {
  const cleaned = raw
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Normalize only remote forms we can parse safely. Credentials/query/fragment
 * are deliberately discarded before anything is persisted or returned.
 */
export function normalizeGitRemote(
  raw: string | null | undefined,
): string | null {
  const value = raw?.trim();
  if (!value) return null;

  // SCP-like SSH: git@github.com:Owner/Repo.git
  if (!value.includes("://")) {
    const scp = value.match(/^(?:[^@\s/]+@)?([^:\s/]+):(.+)$/);
    if (scp) {
      const repoPath = cleanRepoPath(scp[2]!);
      if (!repoPath) return null;
      const host = scp[1]!.toLowerCase();
      return `${host}/${host === "github.com" ? repoPath.toLowerCase() : repoPath}`;
    }
    const direct = value.match(/^([^/\s]+)\/(.+)$/);
    if (direct && direct[1]!.includes(".")) {
      const repoPath = cleanRepoPath(direct[2]!);
      if (!repoPath) return null;
      const host = direct[1]!.toLowerCase();
      return `${host}/${host === "github.com" ? repoPath.toLowerCase() : repoPath}`;
    }
    return null;
  }

  try {
    const url = new URL(value);
    const repoPath = cleanRepoPath(url.pathname);
    if (!url.hostname || !repoPath) return null;
    // `host` preserves an explicit non-default port while credentials/query/
    // fragment remain excluded. Distinct SSH endpoints must not collapse.
    const host = url.host.toLowerCase();
    return `${host}/${host === "github.com" ? repoPath.toLowerCase() : repoPath}`;
  } catch {
    return null;
  }
}

export function timestampMs(value: string | null): number {
  if (!value) return 0;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}

export function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return timestampMs(b) > timestampMs(a) ? b : a;
}

export function preferredRepresentative(
  a: DiscoveredWorkspace,
  b: DiscoveredWorkspace,
): DiscoveredWorkspace {
  if (a.primaryCheckout !== b.primaryCheckout) return b.primaryCheckout ? b : a;
  if (a.canonicalPath.length !== b.canonicalPath.length) {
    return b.canonicalPath.length < a.canonicalPath.length ? b : a;
  }
  return b.canonicalPath.localeCompare(a.canonicalPath) < 0 ? b : a;
}
