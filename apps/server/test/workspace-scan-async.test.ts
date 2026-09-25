import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverGitWorkspaces,
  scanAndUpsertWorkspaces,
} from "../src/services/workspaces.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const roots: string[] = [];
const apps: TestApp[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (apps.length) await apps.pop()!.cleanup();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function root(): string {
  const p = mkdtempSync(path.join(tmpdir(), "ck-async-scan-"));
  roots.push(p);
  return p;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("A06 bounded asynchronous workspace scan", () => {
  it("serves health while filesystem discovery is pending and refuses a duplicate scan", async () => {
    const r = root();
    const t = await makeTestApp();
    apps.push(t);
    t.app.ck.config.workspaceRoots = [r];
    const entered = deferred();
    const release = deferred();
    const original = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    let completed = false;
    const scan = t.post("/api/workspaces/scan", {}).then((result) => {
      completed = true;
      return result;
    });
    try {
      await entered.promise;
      expect((await t.get("/healthz")).statusCode).toBe(200);
      expect(completed).toBe(false);
      const duplicate = await t.post("/api/workspaces/scan", {});
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json().error.code).toBe("workspace_scan_in_progress");
    } finally {
      release.resolve();
    }
    expect((await scan).statusCode).toBe(200);
  });

  it("enforces the overall deadline while an asynchronous filesystem call is pending", async () => {
    const r = root();
    const release = deferred();
    const original = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementationOnce(async (...args) => {
      await release.promise;
      return original(...args);
    });
    try {
      await expect(
        discoverGitWorkspaces({ roots: [r], maxDepth: 3, timeoutMs: 25 }),
      ).rejects.toMatchObject({ code: "workspace_scan_timeout" });
    } finally {
      release.resolve();
    }
  });

  it("aborts on caller cancellation without persisting partial observations", async () => {
    const r = root();
    const t = await makeTestApp();
    apps.push(t);
    const controller = new AbortController();
    controller.abort();
    await expect(
      scanAndUpsertWorkspaces(
        t.app.ck.deps.db,
        { roots: [r], maxDepth: 3, signal: controller.signal },
        { actor: "audit" },
      ),
    ).rejects.toMatchObject({ code: "workspace_scan_aborted" });
    expect(
      t.app.ck.handle.sqlite
        .prepare("SELECT count(*) AS n FROM workspace_bindings")
        .get(),
    ).toEqual({ n: 0 });
    expect(
      t.app.ck.handle.sqlite
        .prepare(
          "SELECT count(*) AS n FROM audit_events WHERE action='workspace.scan_completed'",
        )
        .get(),
    ).toEqual({ n: 0 });
  });

  it("rejects a directory/entry budget exhaustion rather than calling partial results complete", async () => {
    const r = root();
    mkdirSync(path.join(r, "one"));
    mkdirSync(path.join(r, "two"));
    await expect(
      discoverGitWorkspaces({ roots: [r], maxDepth: 3, maxDirectories: 1 }),
    ).rejects.toMatchObject({ code: "workspace_scan_limit" });
    await expect(
      discoverGitWorkspaces({ roots: [r], maxDepth: 3, maxEntries: 1 }),
    ).rejects.toMatchObject({ code: "workspace_scan_limit" });
  });

  it("deduplicates root symlink aliases and closes directory iterators on a bounded exit", async () => {
    const r = root();
    const alias = path.join(root(), "alias");
    symlinkSync(r, alias, "dir");
    expect(
      await discoverGitWorkspaces({
        roots: [r, alias],
        maxDepth: 3,
        maxDirectories: 1,
      }),
    ).toEqual([]);
    mkdirSync(path.join(r, "one"));
    await expect(
      discoverGitWorkspaces({ roots: [r], maxDepth: 3, maxDirectories: 1 }),
    ).rejects.toMatchObject({ code: "workspace_scan_limit" });
    expect(await discoverGitWorkspaces({ roots: [r], maxDepth: 3 })).toEqual(
      [],
    );
  });
  it("closes an opendir handle which arrives after the request deadline", async () => {
    const r = root();
    const directory = await fs.opendir(r);
    const closed = deferred();
    const close = directory.close.bind(directory);
    const spy = vi.spyOn(directory, "close").mockImplementation(async () => {
      await close();
      closed.resolve();
    });
    const release = deferred();
    vi.spyOn(fs, "opendir").mockImplementationOnce(async () => {
      await release.promise;
      return directory;
    });
    try {
      await expect(
        discoverGitWorkspaces({ roots: [r], maxDepth: 3, timeoutMs: 25 }),
      ).rejects.toMatchObject({ code: "workspace_scan_timeout" });
    } finally {
      release.resolve();
    }
    await closed.promise;
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("waits for an outstanding directory read before releasing its handle after cancellation", async () => {
    const r = root();
    const directory = await fs.opendir(r);
    const entered = deferred();
    const release = deferred();
    const closed = deferred();
    const read = directory.read.bind(directory);
    const close = directory.close.bind(directory);
    let reading = false;
    vi.spyOn(directory, "read").mockImplementationOnce(async () => {
      reading = true;
      entered.resolve();
      await release.promise;
      const value = await read();
      reading = false;
      return value;
    });
    vi.spyOn(directory, "close").mockImplementation(async () => {
      expect(reading).toBe(false);
      await close();
      closed.resolve();
    });
    vi.spyOn(fs, "opendir").mockResolvedValueOnce(directory);
    const controller = new AbortController();
    const scan = discoverGitWorkspaces({
      roots: [r],
      maxDepth: 3,
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    await expect(scan).rejects.toMatchObject({
      code: "workspace_scan_aborted",
    });
    release.resolve();
    await closed.promise;
  });
  it.each([false, true])(
    "discovers overlapping configured roots independently of their order: reverse=%s",
    async (reverse) => {
      const base = root();
      const team = path.join(base, "team");
      const repository = path.join(team, "repo");
      mkdirSync(repository, { recursive: true });
      execFileSync("git", ["init", "--quiet", repository], {
        stdio: "ignore",
        timeout: 3000,
      });
      const configured = [team, base];
      if (reverse) configured.reverse();
      const found = await discoverGitWorkspaces({
        roots: configured,
        maxDepth: 1,
        maxWorkspaces: 1,
      });
      expect(found.map((workspace) => workspace.canonicalPath)).toEqual([
        repository,
      ]);
    },
  );

  it("does not count an overlapping repository root twice against the repository budget", async () => {
    const base = root();
    const repository = path.join(base, "team", "repo");
    mkdirSync(repository, { recursive: true });
    execFileSync("git", ["init", "--quiet", repository], {
      stdio: "ignore",
      timeout: 3000,
    });
    const found = await discoverGitWorkspaces({
      roots: [repository, base],
      maxDepth: 3,
      maxWorkspaces: 1,
    });
    expect(found.map((workspace) => workspace.canonicalPath)).toEqual([
      repository,
    ]);
  });
  it("cancels a real disconnected HTTP scan without persisting partial observations", async () => {
    const r = root();
    const t = await makeTestApp();
    apps.push(t);
    t.app.ck.config.workspaceRoots = [r];
    const address = await t.app.listen({ port: 0, host: "127.0.0.1" });
    const entered = deferred();
    const release = deferred();
    const closed = deferred();
    const original = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    t.app.server.once("request", (_request, response) =>
      response.once("close", () => closed.resolve()),
    );
    const controller = new AbortController();
    const request = fetch(`${address}/api/workspaces/scan`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        cookie: t.cookie,
        "content-type": "application/json",
        "x-csrf-token": t.csrf,
      },
      body: "{}",
    });
    try {
      await entered.promise;
      controller.abort();
      await expect(request).rejects.toMatchObject({ name: "AbortError" });
      await closed.promise;
      expect(
        t.app.ck.handle.sqlite
          .prepare(
            "SELECT count(*) AS n FROM audit_events WHERE action='workspace.scan_completed'",
          )
          .get(),
      ).toEqual({ n: 0 });
      let status = 409;
      for (let attempt = 0; attempt < 20 && status === 409; attempt++) {
        status = (await t.post("/api/workspaces/scan", {})).statusCode;
        if (status === 409)
          await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(status).toBe(200);
      expect(
        t.app.ck.handle.sqlite
          .prepare(
            "SELECT count(*) AS n FROM audit_events WHERE action='workspace.scan_completed'",
          )
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      controller.abort();
      release.resolve();
      await request.catch(() => undefined);
    }
  });
});
