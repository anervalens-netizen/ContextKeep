import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ApiError } from "../lib/errors.js";
import { SKIP_DIRS } from "./workspace-scan-skip.js";
import {
  normalizeGitRemote,
  laterIso,
  preferredRepresentative,
  type DiscoveredWorkspace,
} from "./workspace-policy.js";

const exec = promisify(execFile);
export interface WorkspaceScanConfig {
  roots: string[];
  maxDepth: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxDirectories?: number;
  maxEntries?: number;
  maxWorkspaces?: number;
  concurrency?: number;
  gitTimeoutMs?: number;
}

function limit(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

/** Settle on cancellation even for filesystem calls which cannot themselves be interrupted. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      work.catch(() => undefined);
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Bounded read-only filesystem/Git observation. No repository contents or credentials are read. */
export async function discoverGitWorkspaces(
  config: WorkspaceScanConfig,
): Promise<DiscoveredWorkspace[]> {
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () =>
    controller.abort(
      new ApiError(499, "workspace_scan_aborted", "Workspace scan cancelled."),
    );
  config.signal?.addEventListener("abort", cancel, { once: true });
  if (config.signal?.aborted) cancel();
  const timeoutMs = limit(config.timeoutMs, 15_000, 60_000);
  const timeout = setTimeout(
    () =>
      controller.abort(
        new ApiError(
          504,
          "workspace_scan_timeout",
          "Workspace scan exceeded its total time budget. No observations were persisted.",
        ),
      ),
    timeoutMs,
  );
  const maxDirectories = limit(config.maxDirectories, 5_000, 20_000);
  const maxEntries = limit(config.maxEntries, 25_000, 100_000);
  const maxWorkspaces = limit(config.maxWorkspaces, 250, 1_000);
  const concurrency = limit(config.concurrency, 4, 8);
  const gitTimeoutMs = limit(config.gitTimeoutMs, 3_000, 5_000);
  const assertActive = () => {
    if (signal.aborted) throw signal.reason;
  };
  const budgetExceeded = () => {
    throw new ApiError(
      422,
      "workspace_scan_limit",
      "Workspace scan exceeded its observation budget. Narrow the configured roots; no partial observations were persisted.",
    );
  };
  const optionalFs = async <T>(work: Promise<T>): Promise<T | null> => {
    try {
      return await abortable(work, signal);
    } catch {
      assertActive();
      return null;
    }
  };
  const git = async (cwd: string, args: string[]): Promise<string | null> => {
    assertActive();
    try {
      const result = await exec("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: gitTimeoutMs,
        maxBuffer: 64 * 1024,
        signal,
        killSignal: "SIGKILL",
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
        },
      });
      assertActive();
      return result.stdout.trim() || null;
    } catch (error) {
      assertActive();
      const failure = error as { killed?: boolean; code?: string };
      if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
        budgetExceeded();
      if (failure.killed || failure.code === "ETIMEDOUT") {
        throw new ApiError(
          504,
          "workspace_scan_timeout",
          "Git observation timed out; no partial observations were persisted.",
        );
      }
      if (failure.code === "ENOENT") {
        throw new ApiError(
          503,
          "workspace_git_unavailable",
          "Git is unavailable for workspace observation.",
        );
      }
      return null; // Missing origin, unborn HEAD, or a repository removed during the scan.
    }
  };
  const readWorkspace = async (
    repoDir: string,
  ): Promise<DiscoveredWorkspace | null> => {
    const top = await git(repoDir, ["rev-parse", "--show-toplevel"]);
    if (!top) return null;
    const canonicalPath = await optionalFs(fs.realpath(top));
    if (!canonicalPath) return null;
    let remote = await git(canonicalPath, [
      "config",
      "--get",
      "remote.origin.url",
    ]);
    if (!remote) {
      const first = (await git(canonicalPath, ["remote"]))
        ?.split("\n")
        .map((s) => s.trim())
        .find(Boolean);
      if (first)
        remote = await git(canonicalPath, [
          "config",
          "--get",
          `remote.${first}.url`,
        ]);
    }
    const gitRemote = normalizeGitRemote(remote);
    const marker = await optionalFs(fs.lstat(path.join(canonicalPath, ".git")));
    return {
      canonicalKey: gitRemote ? `git:${gitRemote}` : `path:${canonicalPath}`,
      canonicalPath,
      displayName: path.basename(canonicalPath) || canonicalPath,
      gitRemote,
      gitBranch: await git(canonicalPath, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]),
      gitHeadSha: await git(canonicalPath, ["rev-parse", "HEAD"]),
      lastGitActivity: await git(canonicalPath, ["log", "-1", "--format=%cI"]),
      primaryCheckout: marker?.isDirectory() ?? false,
    };
  };

  try {
    assertActive();
    const visited = new Map<string, number>();
    const candidates: string[] = [];
    const candidatePaths = new Set<string>();
    const pending = config.roots.map((root) => ({ root, depth: 0 }));
    let observedEntries = 0;
    while (pending.length) {
      assertActive();
      const { root, depth } = pending.pop()!;
      if (depth > config.maxDepth) continue;
      const real = await optionalFs(fs.realpath(root));
      if (!real) continue;
      const previousDepth = visited.get(real);
      if (previousDepth !== undefined && previousDepth <= depth) continue;
      if (depth > 0 && SKIP_DIRS.has(path.basename(real))) continue;
      if (previousDepth === undefined && visited.size >= maxDirectories)
        budgetExceeded();
      // An explicit nested root has its own depth budget, regardless of root order.
      visited.set(real, depth);
      const marker = await optionalFs(fs.lstat(path.join(real, ".git")));
      if (marker && (marker.isDirectory() || marker.isFile())) {
        if (!candidatePaths.has(real)) {
          if (candidates.length >= maxWorkspaces) budgetExceeded();
          candidates.push(real);
          candidatePaths.add(real);
        }
        continue; // Never descend into repository contents or submodules.
      }
      if (depth === config.maxDepth) continue;
      const opening = fs.opendir(real).then((directory) => {
        if (signal.aborted) {
          void directory.close().catch(() => undefined);
          throw signal.reason;
        }
        return directory;
      });
      const directory = await optionalFs(opening);
      if (!directory) continue;
      let pendingRead: Promise<Dirent | null> = Promise.resolve(null);
      try {
        while (true) {
          assertActive();
          pendingRead = directory.read();
          const entry = await abortable(pendingRead, signal);
          if (!entry) break;
          if (++observedEntries > maxEntries) budgetExceeded();
          if (
            entry.isDirectory() &&
            !entry.isSymbolicLink() &&
            !SKIP_DIRS.has(entry.name)
          ) {
            pending.push({
              root: path.join(real, entry.name),
              depth: depth + 1,
            });
          }
        }
      } finally {
        // Closing is async. If the underlying filesystem is stuck, it must not hold the HTTP deadline open.
        const closing = pendingRead
          .then(
            () => undefined,
            () => undefined,
          )
          .then(() => directory.close())
          .catch(() => undefined);
        if (!signal.aborted) await abortable(closing, signal);
      }
    }
    const found = new Map<string, DiscoveredWorkspace>();
    let cursor = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, candidates.length) },
        async () => {
          while (cursor < candidates.length) {
            assertActive();
            const workspace = await readWorkspace(candidates[cursor++]!);
            if (!workspace) continue;
            const previous = found.get(workspace.canonicalKey);
            found.set(
              workspace.canonicalKey,
              previous
                ? {
                    ...preferredRepresentative(previous, workspace),
                    lastGitActivity: laterIso(
                      previous.lastGitActivity,
                      workspace.lastGitActivity,
                    ),
                  }
                : workspace,
            );
          }
        },
      ),
    );
    assertActive();
    return [...found.values()].sort((a, b) =>
      a.canonicalKey.localeCompare(b.canonicalKey),
    );
  } finally {
    clearTimeout(timeout);
    config.signal?.removeEventListener("abort", cancel);
    controller.abort();
  }
}
