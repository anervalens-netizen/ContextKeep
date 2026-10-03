import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const requested = process.argv.slice(2);
const tests =
  requested.length > 0
    ? requested
    : [
        "test/consistency-remediation.test.ts",
        "test/operational-dossier.test.ts",
        "test/usage-hardening.test.ts",
        "test/context-packing-evaluation.test.ts",
      ];

function run(args) {
  const result = spawnSync(pnpm, args, {
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const git = spawnSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
  shell: false,
});
if (git.status !== 0) process.exit(git.status ?? 1);
const sourceSha = git.stdout.trim();
const status = spawnSync("git", ["status", "--porcelain"], {
  encoding: "utf8",
  shell: false,
});
if (status.status !== 0) process.exit(status.status ?? 1);
const changedPaths = status.stdout
  .split("\n")
  .filter((line) => line.length > 0);
const dirty = changedPaths.length > 0;

console.log(
  `[focused-tests] source=${sourceSha} dirty=${dirty ? "yes" : "no"}`,
);
if (dirty) {
  console.log(
    `[focused-tests] uncommittedPaths=${changedPaths
      .map((line) => line.slice(3))
      .join(",")}`,
  );
}
console.log("[focused-tests] preparing @contextkeep/shared");
run(["--filter", "@contextkeep/shared", "build"]);

const sharedArtifact = "packages/shared/dist/dto.js";
const artifactSha = createHash("sha256")
  .update(readFileSync(sharedArtifact))
  .digest("hex");
console.log(
  `[focused-tests] sharedArtifact=${sharedArtifact} sha256=${artifactSha}`,
);
console.log(`[focused-tests] tests=${tests.join(",")}`);

run([
  "--filter",
  "@contextkeep/server",
  "exec",
  "vitest",
  "run",
  ...tests,
  "--maxWorkers=1",
  "--reporter=verbose",
]);
