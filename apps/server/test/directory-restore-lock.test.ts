import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { bootstrapDatabase } from "../src/db/bootstrap.js";
import { openDatabase, type DbHandle } from "../src/db/client.js";
import { DIRECTORY_LOCK_FILE } from "../src/db/directory-lock.js";
import { restoreBackup, verifyBackup } from "../src/services/backup.js";

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ck-directory-lock-"));
  const dataDir = path.join(root, "custom-data");
  const file = path.join(dataDir, "store.sqlite");
  let handle: DbHandle;
  try {
    handle = openDatabase(file);
    bootstrapDatabase(handle);
    handle.sqlite.exec(
      "CREATE TABLE restore_sentinel (value TEXT); INSERT INTO restore_sentinel VALUES ('preserved');",
    );
    const backup = path.join(root, "backup.sqlite");
    await handle.sqlite.backup(backup);
    handle.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    fs.writeFileSync(path.join(dataDir, "owner-file"), "keep me");
    return { root, dataDir, file, backup, handle };
  } catch (error) {
    if (handle!?.sqlite.open) handle!.sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function bytes(directory: string): Record<string, Buffer> {
  return Object.fromEntries(
    fs
      .readdirSync(directory)
      .filter((name) => !name.startsWith(DIRECTORY_LOCK_FILE))
      .map((name) => [name, fs.readFileSync(path.join(directory, name))]),
  );
}

function restore(dataDir: string, backupFile: string, hardWipe = false) {
  return restoreBackup({
    dataDir,
    backupFile,
    hardWipe,
    ctx: { actor: "test:directory-lock" },
  });
}

async function childHandle(file: string, legacy = false) {
  const module = pathToFileURL(path.resolve("src/db/client.ts")).href;
  const code = legacy
    ? `import Database from 'better-sqlite3'; const sqlite = new Database(${JSON.stringify(file)}); sqlite.pragma('journal_mode = WAL'); sqlite.pragma('wal_checkpoint(TRUNCATE)');`
    : `import { openDatabase } from ${JSON.stringify(module)}; const { sqlite } = openDatabase(${JSON.stringify(file)}); sqlite.pragma('wal_checkpoint(TRUNCATE)');`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "--input-type=module",
      "-e",
      code +
        "process.send('ready'); process.on('message', () => { sqlite.close(); process.exit(0); });",
    ],
    {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = once(child, "exit");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Child startup timeout: ${stderr}`));
    }, 10000);
    child.once("message", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Child exited ${code}: ${stderr}`));
    });
  });
  return {
    async close(crash = false) {
      if (child.exitCode === null && child.signalCode === null) {
        if (crash) child.kill("SIGKILL");
        else child.send("close");
      }
      await exited;
    },
  };
}

function makeSnapshot(root: string, backup: string, releaseName: string) {
  const verified = verifyBackup(backup);
  const manifest = path.join(root, "manifest.json");
  // Python supplies the same archive format as the actual operational job.
  const snapshot = path.join(root, "snapshot.tar.gz");
  execFileSync("python3", [
    "-c",
    "import hashlib,json,pathlib,sys,tarfile\nb,m,out,release,counts=sys.argv[1:]\np=pathlib.Path(b)\npathlib.Path(m).write_text(json.dumps({'release':release,'db_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'counts':json.loads(counts)}))\nwith tarfile.open(out,'w:gz') as t:\n t.add(b,arcname='store.sqlite')\n t.add(m,arcname='manifest.json')\n",
    backup,
    manifest,
    snapshot,
    releaseName,
    JSON.stringify({
      projects: verified.counts.projects,
      records: verified.counts.records,
      sources: verified.counts.sources,
    }),
  ]);
  return snapshot;
}

// Legacy descriptor detection is intentionally Linux-specific and fails closed
// for an existing store on platforms where that check is unavailable.
describe.skipIf(process.platform !== "linux")(
  "directory ownership during restore",
  () => {
    it("refuses checkpointed-empty WAL through directory and database symlink aliases until every handle closes", async () => {
      const t = await fixture();
      let second: DbHandle | undefined;
      try {
        const alias = path.join(t.root, "alias");
        fs.symlinkSync(t.dataDir, alias, "dir");
        const dbAliasDir = path.join(t.root, "db-alias");
        fs.mkdirSync(dbAliasDir);
        fs.symlinkSync(t.file, path.join(dbAliasDir, "store.sqlite"));
        second = openDatabase(path.join(dbAliasDir, "store.sqlite"));
        expect(fs.statSync(`${t.file}-wal`).size).toBe(0);
        const before = bytes(t.dataDir);
        expect(() => restore(alias, t.backup, true)).toThrow(/in use/);
        expect(bytes(t.dataDir)).toEqual(before);
        t.handle.sqlite.close();
        expect(() => restore(alias, t.backup)).toThrow(/in use/);
        second.sqlite.close();
        const lockInode = fs.statSync(
          path.join(t.dataDir, DIRECTORY_LOCK_FILE),
        ).ino;
        const result = restore(alias, t.backup, true);
        expect(result.restored).toBe(t.file);
        expect(fs.statSync(path.join(t.dataDir, DIRECTORY_LOCK_FILE)).ino).toBe(
          lockInode,
        );
        const restarted = openDatabase(t.file);
        try {
          expect(
            restarted.sqlite
              .prepare("SELECT value FROM restore_sentinel")
              .get(),
          ).toEqual({ value: "preserved" });
        } finally {
          restarted.sqlite.close();
        }
      } finally {
        if (second?.sqlite.open) second.sqlite.close();
        if (t.handle.sqlite.open) t.handle.sqlite.close();
        fs.rmSync(t.root, { recursive: true, force: true });
      }
    });

    it.each([false, true])(
      "fences restore while another process is active and releases ownership after crash=%s",
      async (crash) => {
        const t = await fixture();
        t.handle.sqlite.close();
        const child = await childHandle(t.file);
        try {
          const before = bytes(t.dataDir);
          const reader = openDatabase(t.file);
          reader.sqlite.close();
          expect(() => restore(t.dataDir, t.backup)).toThrow(/in use/);
          expect(bytes(t.dataDir)).toEqual(before);
          await child.close(crash);
          restore(t.dataDir, t.backup);
          const restarted = openDatabase(t.file);
          restarted.sqlite.close();
        } finally {
          await child.close(true);
          fs.rmSync(t.root, { recursive: true, force: true });
        }
      },
    );

    it.each([false, true])(
      "detects an idle legacy SQLite handle (child=%s) with an empty WAL",
      async (inChild) => {
        const t = await fixture();
        t.handle.sqlite.close();
        let legacy: Database.Database | undefined;
        let child: Awaited<ReturnType<typeof childHandle>> | undefined;
        try {
          if (inChild) child = await childHandle(t.file, true);
          else {
            legacy = new Database(t.file);
            legacy.pragma("journal_mode = WAL");
            legacy.pragma("wal_checkpoint(TRUNCATE)");
          }
          const before = bytes(t.dataDir);
          expect(() => restore(t.dataDir, t.backup, true)).toThrow(
            /has a database file open/,
          );
          expect(bytes(t.dataDir)).toEqual(before);
          legacy?.close();
          await child?.close();
          restore(t.dataDir, t.backup);
        } finally {
          if (legacy?.open) legacy.close();
          await child?.close(true);
          fs.rmSync(t.root, { recursive: true, force: true });
        }
      },
    );

    it("restores a new directory without schema reset or reacquiring its own lease", async () => {
      const t = await fixture();
      try {
        const target = path.join(t.root, "new-target");
        const version = verifyBackup(t.backup).schemaVersion;
        restore(target, t.backup);
        expect(
          verifyBackup(path.join(target, "store.sqlite")).schemaVersion,
        ).toBe(version);
        const restarted = openDatabase(path.join(target, "store.sqlite"));
        try {
          bootstrapDatabase(restarted);
          expect(
            restarted.sqlite
              .prepare("SELECT value FROM restore_sentinel")
              .get(),
          ).toEqual({ value: "preserved" });
        } finally {
          restarted.sqlite.close();
        }
      } finally {
        t.handle.sqlite.close();
        fs.rmSync(t.root, { recursive: true, force: true });
      }
    });

    it("retains directory ownership through promotion and rolls back a failed rename byte-for-byte", async () => {
      const t = await fixture();
      t.handle.sqlite.close();
      const before = bytes(t.dataDir);
      const rename = fs.renameSync.bind(fs);
      let intercepted = false;
      const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (
          String(to) === t.file &&
          String(from).includes(".restore-stage-") &&
          !intercepted
        ) {
          intercepted = true;
          expect(() => openDatabase(t.file)).toThrow(/in use/);
          throw new Error("injected promotion failure");
        }
        rename(from, to);
      });
      try {
        expect(() => restore(t.dataDir, t.backup)).toThrow(
          "injected promotion failure",
        );
        expect(intercepted).toBe(true);
        const ordinaryFiles = Object.fromEntries(
          Object.entries(bytesWithoutTrash(t.dataDir)),
        );
        expect(ordinaryFiles).toEqual(before);
        spy.mockRestore();
        const restarted = openDatabase(t.file);
        restarted.sqlite.close();
        restore(t.dataDir, t.backup);
      } finally {
        spy.mockRestore();
        fs.rmSync(t.root, { recursive: true, force: true });
      }
    });

    it("releases a lease when opening a corrupt database fails", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ck-lock-startup-"));
      try {
        fs.writeFileSync(
          path.join(root, "store.sqlite"),
          "not a SQLite database",
        );
        expect(() => openDatabase(path.join(root, "store.sqlite"))).toThrow();
        const handle = openDatabase(path.join(root, "other.sqlite"));
        handle.sqlite.close();
        const again = openDatabase(path.join(root, "other.sqlite"));
        again.sqlite.close();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("the real Python wrapper refuses a live custom-directory alias, then restores and restarts after close", async () => {
      const t = await fixture();
      try {
        const alias = path.join(t.root, "custom-alias");
        fs.symlinkSync(t.dataDir, alias, "dir");
        const release = path.join(t.root, "test-runtime");
        const cli = path.join(release, "apps/server/dist/cli");
        fs.mkdirSync(cli, { recursive: true });
        fs.writeFileSync(
          path.join(release, "package.json"),
          JSON.stringify({ type: "module" }),
        );
        fs.writeFileSync(
          path.join(cli, "restore.js"),
          `import ${JSON.stringify(pathToFileURL(path.resolve("src/cli/restore.ts")).href)};\n`,
        );
        const snapshot = makeSnapshot(t.root, t.backup, path.basename(release));
        const profile = path.join(t.root, "synthetic-restore-profile.json");
        fs.writeFileSync(
          profile,
          JSON.stringify({
            primary_host: os.hostname(),
            data_dir: t.dataDir,
            release_dir: release,
          }),
        );
        const args = [
          path.resolve("../../ops/restore-snapshot.py"),
          snapshot,
          "--config",
          profile,
          "--data-dir",
          alias,
          "--node",
          process.execPath,
          "--release",
          release,
        ];
        const env = {
          ...process.env,
          NODE_ENV: "test",
          NODE_OPTIONS: "--import tsx/esm",
          CK_SESSION_SECRET: "restore-lock-regression-test-secret",
        };
        const before = bytes(t.dataDir);
        expect(() =>
          execFileSync("python3", args, { env, stdio: "pipe" }),
        ).toThrow();
        expect(bytes(t.dataDir)).toEqual(before);
        t.handle.sqlite.close();
        const output = execFileSync("python3", args, { env, encoding: "utf8" });
        expect(output).toContain('"integrity": "ok"');
        const restarted = openDatabase(t.file);
        try {
          expect(
            restarted.sqlite
              .prepare("SELECT value FROM restore_sentinel")
              .get(),
          ).toEqual({ value: "preserved" });
        } finally {
          restarted.sqlite.close();
        }
      } finally {
        if (t.handle.sqlite.open) t.handle.sqlite.close();
        fs.rmSync(t.root, { recursive: true, force: true });
      }
    }, 30000);
  },
);

function bytesWithoutTrash(directory: string): Record<string, Buffer> {
  return Object.fromEntries(
    fs
      .readdirSync(directory)
      .filter(
        (name) =>
          !name.startsWith(".trash-") && !name.startsWith(DIRECTORY_LOCK_FILE),
      )
      .map((name) => [name, fs.readFileSync(path.join(directory, name))]),
  );
}
