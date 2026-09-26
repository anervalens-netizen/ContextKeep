import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkRepository, inspectCommitMessage } from "./check-public-data.mjs";

const root = mkdtempSync(path.join(tmpdir(), "contextkeep-public-history-"));
const git = (args, options = {}) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", ...options });
const run = (args) =>
  git(args, {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Synthetic Runner",
      GIT_AUTHOR_EMAIL: "runner@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Synthetic Runner",
      GIT_COMMITTER_EMAIL: "runner@users.noreply.github.com",
    },
  });
run(["init", "-q"]);
run(["config", "user.name", "Synthetic Runner"]);
run(["config", "user.email", "runner@users.noreply.github.com"]);
writeFileSync(path.join(root, "baseline.txt"), "synthetic baseline\n");
run(["add", "."]);
run(["commit", "-qm", "Publish sanitized public source baseline"]);
const introduced = ["gh", "p_", "x".repeat(30)].join("");
writeFileSync(path.join(root, "removed.txt"), introduced + "\n");
run(["add", "."]);
run(["commit", "-qm", "Add synthetic fixture"]);
run(["rm", "-q", "removed.txt"]);
run(["commit", "-qm", "Remove synthetic fixture"]);
const messageOnly = [
  "notes",
  "only",
  ["gh", "p_", "y".repeat(30)].join(""),
].join(" ");
assert.ok(
  inspectCommitMessage("0123456789abcdef", messageOnly).includes(
    "access-token",
  ),
);
const messageFile = path.join(
  tmpdir(),
  "contextkeep-public-history-message.txt",
);
writeFileSync(
  messageFile,
  messageOnly + "\nsecond line\n" + "context ".repeat(50000),
);
run(["commit", "--allow-empty", "-q", "-F", messageFile]);
const tracked = ["AKIA", "Z".repeat(16)].join("");
writeFileSync(path.join(root, "tracked.txt"), tracked + "\n");
run(["add", "."]);
run(["commit", "-qm", "Tracked synthetic fixture"]);

const original = console.log;
let output = "";
console.log = (value) => {
  output += String(value);
};
try {
  assert.equal(checkRepository(["--history", "HEAD"], root), 1);
} finally {
  console.log = original;
}
const result = JSON.parse(output);
assert.ok(result.issues.length >= 3);
for (const issue of result.issues.filter((value) => value.commit)) {
  assert.deepEqual(Object.keys(issue).sort(), ["commit", "kind"]);
  assert.match(issue.commit, /^[0-9a-f]{40}$/);
}
assert.ok(result.issues.some((issue) => issue.kind === "access-token"));
assert.ok(
  result.issues.some((issue) => issue.kind === "non-noreply-author") === false,
);
assert.ok(!output.includes(introduced));
assert.ok(!output.includes(messageOnly));
assert.ok(!output.includes(tracked));
assert.ok(!output.includes("gmail.com"));
const oversizedSentinel = "OVERSIZED_SYNTHETIC_PAYLOAD_";
const oversizedMessageFile = path.join(
  tmpdir(),
  "contextkeep-public-history-oversized.txt",
);
writeFileSync(oversizedMessageFile, oversizedSentinel + "x".repeat(9_000_000));
run(["commit", "--allow-empty", "-q", "-F", oversizedMessageFile]);
let oversizedOutput = "";
console.log = (value) => {
  oversizedOutput += String(value);
};
try {
  assert.equal(checkRepository(["--history", "HEAD"], root), 1);
} finally {
  console.log = original;
}
const oversizedResult = JSON.parse(oversizedOutput);
assert.deepEqual(oversizedResult.issues, [
  { path: "<history>", kind: "git-output-too-large" },
]);
assert.ok(!oversizedOutput.includes(oversizedSentinel));
let failedOutput = "";
console.log = (value) => {
  failedOutput += String(value);
};
try {
  assert.equal(
    checkRepository(["--history", "missing-synthetic-ref"], root),
    1,
  );
} finally {
  console.log = original;
}
assert.deepEqual(JSON.parse(failedOutput).issues, [
  { path: "<history>", kind: "git-command-failed" },
]);
assert.ok(!failedOutput.includes(oversizedSentinel));
console.log(
  "PASS: public-data history scans blobs and multiline commit messages without disclosure.",
);
