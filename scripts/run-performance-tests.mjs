import { spawnSync } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
function run(args) {
  const result = spawnSync(pnpm, args, { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("[performance] PREPARE shared package");
run(["--filter", "@contextkeep/shared", "build"]);

const checks = [
  ["brief route", "brief route latency"],
  ["task-aware work context", "task-aware get_work_context"],
  ["working-memory search", "explicit working-memory search"],
  ["attention projection", "attention projection performance"],
  ["portfolio attention", "portfolio attention performance"],
  ["FTS5 search", "FTS5 dedicated performance qualification"],
];

for (const [label, pattern] of checks) {
  console.log(`[performance] START ${label}`);
  run([
    "--filter",
    "@contextkeep/server",
    "exec",
    "vitest",
    "run",
    "test/perf.test.ts",
    "-t",
    pattern,
    "--maxWorkers=1",
    "--reporter=verbose",
  ]);
  console.log(`[performance] PASS ${label}`);
}
console.log(`[performance] PASS ${checks.length} isolated checks`);
