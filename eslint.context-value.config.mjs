import tseslint from "typescript-eslint";
import auditScope from "./scripts/audit-quality-scope.json" with { type: "json" };

// Check the maintained pure modules without creating unrelated legacy churn.
export default [
  {
    files: [
      ...auditScope.lint,
      "apps/server/src/services/context-budget.ts",
      "apps/server/src/services/sync-policy.ts",
      "apps/web/src/lib/offline/queue-policy.ts",
      "apps/web/src/lib/provenance-query.ts",
      "apps/web/src/components/useShellData.ts",

      "apps/server/src/services/context-selection.ts",
      "apps/server/src/services/context-packing.ts",
      "packages/shared/src/resume.ts",
      "apps/server/src/evals/context-value-resume.ts",
    ],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "no-unreachable": "error",
      "no-constant-condition": "error",
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
    },
  },
];
