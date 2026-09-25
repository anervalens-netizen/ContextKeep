import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modules = [
  "apps/server/src/services/context-selection.ts",
  "apps/server/src/services/context-packing.ts",
  "packages/shared/src/resume.ts",
  "apps/server/src/services/context-budget.ts",
  "apps/server/src/lib/errors.ts",
  "apps/web/src/lib/offline/queue-policy.ts",
  "apps/server/src/services/workspace-policy.ts",
  "apps/server/src/services/workspace-scan-skip.ts",
  "apps/server/src/services/checkpoint.ts",
];

/** Inspect real imports, not matching words in comments and string content. */
function boundaryErrors(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const errors = tree.parseDiagnostics.map(
    (d) => `${file}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
  );
  const check = (specifier, typeOnly = false) => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) {
      errors.push(
        `${file}: computed imports are not allowed in pure context modules`,
      );
      return;
    }
    const name = specifier.text;
    if (file.startsWith("packages/shared/")) {
      const target = path.resolve(root, path.dirname(file), name);
      if (
        !name.startsWith(".") ||
        !target.startsWith(path.join(root, "packages/shared/src") + path.sep)
      ) {
        errors.push(
          `${file}: shared resume cannot import host/server dependencies (${name})`,
        );
      }
    } else if (!(name === "@contextkeep/shared" && typeOnly)) {
      const target = path
        .resolve(root, path.dirname(file), name)
        .replace(/\.js$/, ".ts");
      if (
        !name.startsWith(".") ||
        !modules.some((m) => target === path.join(root, m))
      ) {
        errors.push(
          `${file}: pure context module cannot import I/O or orchestration (${name})`,
        );
      }
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const typeOnly =
        clause?.isTypeOnly ||
        Boolean(
          !clause?.name &&
          named &&
          ts.isNamedImports(named) &&
          named.elements.length &&
          named.elements.every((e) => e.isTypeOnly),
        );
      check(node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier)
      check(node.moduleSpecifier, node.isTypeOnly);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      check(node.moduleReference.expression, node.isTypeOnly);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    )
      check(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return errors;
}

// Embedded source fixtures are parsed, never executed. Negative fixtures must
// fail even with different quotes or import syntax; comments must remain valid.
assert.equal(boundaryErrors(modules[2], 'import fs from "node:fs";').length, 1);
assert.equal(boundaryErrors(modules[2], "import x from 'fastify';").length, 1);
assert.equal(boundaryErrors(modules[0], "import('./import.js');").length, 1);
assert.equal(
  boundaryErrors(modules[0], "const x = require('drizzle-orm');").length,
  1,
);
assert.equal(boundaryErrors(modules[0], "import(variableName);").length, 1);
assert.equal(
  boundaryErrors(
    modules[2],
    "// node:fs and fastify are absent\nexport const x = 'drizzle';",
  ).length,
  0,
);
assert.equal(
  boundaryErrors(
    modules[2],
    'import type { WorkContextCheckpointDto } from "./dto.js";',
  ).length,
  0,
);
assert.equal(
  boundaryErrors(
    modules[0],
    'import type { RecordDto } from "@contextkeep/shared";',
  ).length,
  0,
);
const violations = modules.flatMap((file) =>
  boundaryErrors(file, fs.readFileSync(path.join(root, file), "utf8")),
);
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `AST import boundaries passed (${modules.length} focused modules; 8 adversarial self-tests)`,
  );
