import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

export const releaseGatePlan = [
  ["typecheck", ["run", "typecheck"]],
  ["context quality", ["run", "check:context-value"]],
  ["static audit", ["run", "check:audit"]],
  ["public-data privacy", ["run", "check:privacy"]],
  ["published-history privacy", ["run", "check:privacy:history"]],
  ["functional tests", ["run", "test:functional"]],
  ["operational recovery", ["run", "test:ops"]],
  ["build", ["run", "build"]],
  ["browser navigation", ["run", "verify:nav"]],
  // `audit` is pnpm's native command, not a root package script.
  ["dependency audit", ["audit", "--audit-level", "moderate"]],
];

export function commandFor([, args]) {
  return [pnpm, ...args];
}

export function runReleaseGate({ dryRun = false } = {}) {
  for (const step of releaseGatePlan) {
    const [name] = step;
    const command = commandFor(step);
    if (dryRun) {
      console.log(`[release-gate] PLAN ${name}: ${command.join(" ")}`);
      continue;
    }
    console.log(`[release-gate] START ${name}`);
    const result = spawnSync(command[0], command.slice(1), {
      stdio: "inherit",
      shell: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
    console.log(`[release-gate] PASS ${name}`);
  }
  console.log(
    `[release-gate] PASS ${releaseGatePlan.length} full release checks`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runReleaseGate({ dryRun: process.argv.includes("--dry-run") });
}
