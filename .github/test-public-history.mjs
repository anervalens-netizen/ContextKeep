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

function fixtureRepository() {
  const directory = mkdtempSync(
    path.join(tmpdir(), "contextkeep-public-paths-"),
  );
  const command = (args) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Synthetic Runner",
        GIT_COMMITTER_NAME: "Synthetic Runner",
        GIT_AUTHOR_EMAIL: "runner@users.noreply.github.com",
        GIT_COMMITTER_EMAIL: "runner@users.noreply.github.com",
      },
    });
  command(["init", "-q"]);
  writeFileSync(path.join(directory, "safe.txt"), "shared synthetic content\n");
  command(["add", "."]);
  command(["commit", "-qm", "Publish sanitized public source baseline"]);
  return { directory, command };
}
function capturedCheck(args, directory) {
  const previous = console.log;
  let text = "";
  let code;
  console.log = (value) => {
    text += String(value);
  };
  try {
    code = checkRepository(args, directory);
  } finally {
    console.log = previous;
  }
  return { code, result: JSON.parse(text) };
}
{
  const { directory, command } = fixtureRepository();
  writeFileSync(
    path.join(directory, "harmless.bin"),
    Buffer.from([0, 1, 2, 3]),
  );
  command(["add", "."]);
  command(["commit", "-qm", "Add synthetic binary"]);
  assert.equal(capturedCheck(["--history", "HEAD"], directory).code, 0);
  writeFileSync(
    path.join(directory, "leaked.sqlite"),
    Buffer.from([0, 1, 2, 3]),
  );
  command(["add", "leaked.sqlite"]);
  for (const args of [[], ["--staged"]]) {
    const checked = capturedCheck(args, directory);
    assert.equal(checked.code, 1);
    assert.ok(
      checked.result.issues.some(
        (issue) =>
          issue.path === "leaked.sqlite" && issue.kind === "private-file-path",
      ),
    );
  }
  command(["commit", "-qm", "Add synthetic forbidden binary pathname"]);
  command(["rm", "-q", "leaked.sqlite"]);
  command(["commit", "-qm", "Remove synthetic forbidden binary pathname"]);
  const checked = capturedCheck(["--history", "HEAD"], directory);
  assert.equal(checked.code, 1);
  assert.ok(
    checked.result.issues.some(
      (issue) =>
        issue.path === "leaked.sqlite" && issue.kind === "private-file-path",
    ),
  );
}
{
  const { directory, command } = fixtureRepository();
  writeFileSync(
    path.join(directory, "leaked.sqlite"),
    "shared synthetic content\n",
  );
  command(["add", "."]);
  command(["commit", "-qm", "Alias identical blob at forbidden pathname"]);
  command(["rm", "-q", "leaked.sqlite"]);
  command(["commit", "-qm", "Remove alias while keeping shared blob"]);
  assert.equal(capturedCheck([], directory).code, 0);
  const checked = capturedCheck(["--history", "HEAD"], directory);
  assert.equal(checked.code, 1);
  assert.ok(
    checked.result.issues.some(
      (issue) =>
        issue.path === "leaked.sqlite" && issue.kind === "private-file-path",
    ),
  );
}
console.log(
  "PASS: binary path rules and every historical blob alias remain enforced.",
);

for (const filename of ["package-lock.json", "LICENSE", "NOTICE.txt"]) {
  const { directory, command } = fixtureRepository();
  const email = ["maintainer", "vendor.testdomain.org"].join("@");
  writeFileSync(path.join(directory, filename), email + "\n");
  command(["add", "."]);
  command(["commit", "-qm", "Synthetic third-party metadata"]);
  assert.equal(capturedCheck(["--history", "HEAD"], directory).code, 0);
  const secret = ["gh", "p_", "z".repeat(30)].join("");
  writeFileSync(path.join(directory, filename), email + "\n" + secret);
  command(["add", "."]);
  for (const args of [[], ["--staged"]]) {
    const checked = capturedCheck(args, directory);
    assert.equal(checked.code, 1);
    assert.ok(
      checked.result.issues.some(
        (issue) => issue.path === filename && issue.kind === "access-token",
      ),
    );
    assert.ok(!JSON.stringify(checked.result).includes(secret));
  }
  command(["commit", "-qm", "Synthetic forbidden content inside metadata"]);
  writeFileSync(path.join(directory, filename), email + "\n");
  command(["add", "."]);
  command(["commit", "-qm", "Remove synthetic forbidden content"]);
  assert.equal(capturedCheck([], directory).code, 0);
  const history = capturedCheck(["--history", "HEAD"], directory);
  assert.equal(history.code, 1);
  assert.ok(
    history.result.issues.some(
      (issue) => issue.path === filename && issue.kind === "access-token",
    ),
  );
  assert.ok(!JSON.stringify(history.result).includes(secret));
}
console.log(
  "PASS: metadata exceptions retain secret detection in staged, working and historical content.",
);
