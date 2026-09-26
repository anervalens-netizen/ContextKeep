import assert from "node:assert/strict";
import { commandFor, releaseGatePlan } from "./release-gate.mjs";

const audit = releaseGatePlan.find(([name]) => name === "dependency audit");
assert.deepEqual(audit?.[1], ["audit", "--audit-level", "moderate"]);
assert.deepEqual(commandFor(audit), [
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  "audit",
  "--audit-level",
  "moderate",
]);
for (const [name, args] of releaseGatePlan) {
  if (name === "dependency audit") continue;
  assert.equal(args[0], "run", `${name} must use a package script`);
}
console.log(
  "PASS: release gate plan keeps pnpm audit native and does not run suites.",
);
