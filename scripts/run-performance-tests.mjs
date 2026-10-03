import { spawnSync } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const checks = [
  ["brief route", "brief route latency"],
  ["task-aware work context", "task-aware get_work_context"],
  ["working-memory search", "explicit working-memory search"],
  ["attention projection", "attention projection performance"],
  ["FTS5 search", "FTS5 dedicated performance qualification"],
];

for (const [label, pattern] of checks) {
  console.log(`[performance] START ${label}`);
  const result = spawnSync(
    pnpm,
    [
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
    ],
    { stdio: "inherit", shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`[performance] PASS ${label}`);
}
console.log(`[performance] PASS ${checks.length} isolated checks`);
