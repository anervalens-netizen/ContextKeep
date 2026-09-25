import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverGitWorkspaces } from "../src/services/workspace-discovery.js";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  while (roots.length)
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
function fakeGit(code: string) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "ck-git-deadline-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "repo");
  const pid = path.join(root, "child.pid");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));\n${code}\n`,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
  return { repo, pid };
}
async function waitForPid(file: string) {
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(file)) return Number(fs.readFileSync(file, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("isolated Git fixture did not start");
}
async function expectExited(pid: number) {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("isolated Git fixture remained alive after cancellation");
}
describe.skipIf(process.platform === "win32")(
  "A06 bounded real Git child lifecycle",
  () => {
    it("kills a timed-out metadata command and refuses partial scan success", async () => {
      const f = fakeGit("setInterval(()=>{},1000);");
      await expect(
        discoverGitWorkspaces({
          roots: [f.repo],
          maxDepth: 1,
          gitTimeoutMs: 250,
          timeoutMs: 3000,
        }),
      ).rejects.toMatchObject({ code: "workspace_scan_timeout" });
      await expectExited(await waitForPid(f.pid));
    });
    it("terminates its running Git child when the request is cancelled", async () => {
      const f = fakeGit("setInterval(()=>{},1000);");
      const controller = new AbortController();
      const scan = discoverGitWorkspaces({
        roots: [f.repo],
        maxDepth: 1,
        signal: controller.signal,
        timeoutMs: 3000,
      });
      const pid = await waitForPid(f.pid);
      controller.abort();
      await expect(scan).rejects.toMatchObject({
        code: "workspace_scan_aborted",
      });
      await expectExited(pid);
    });
    it("treats output exhaustion as a scan limit, not missing metadata", async () => {
      const f = fakeGit("process.stdout.write('x'.repeat(100000));");
      await expect(
        discoverGitWorkspaces({
          roots: [f.repo],
          maxDepth: 1,
          timeoutMs: 3000,
        }),
      ).rejects.toMatchObject({ code: "workspace_scan_limit" });
      await expectExited(await waitForPid(f.pid));
    });
  },
);
