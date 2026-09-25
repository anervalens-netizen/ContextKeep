import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scope = JSON.parse(
  fs.readFileSync(path.join(root, "scripts/audit-quality-scope.json"), "utf8"),
);
for (const [kind, files] of Object.entries(scope)) {
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    new Set(files).size !== files.length
  )
    throw new Error(`Invalid ${kind} quality scope`);
  for (const file of files) {
    if (
      typeof file !== "string" ||
      path.isAbsolute(file) ||
      file.split("/").includes("..") ||
      !fs.statSync(path.join(root, file)).isFile()
    )
      throw new Error(`Invalid scoped file: ${file}`);
  }
}
const selected = process.argv[2];
const checks = selected ? [selected] : ["lint", "format"];
for (const check of checks) {
  if (!Object.hasOwn(scope, check))
    throw new Error(`Unknown audit gate: ${check}`);
  const args =
    check === "lint"
      ? [
          "exec",
          "eslint",
          "--config",
          "eslint.context-value.config.mjs",
          ...scope.lint,
        ]
      : ["exec", "prettier", "--check", ...scope.format];
  const result = spawnSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    args,
    { cwd: root, stdio: "inherit", shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(
    `[audit-quality] ${check}: ${scope[check].length} maintained files PASS`,
  );
}
