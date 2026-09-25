import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    // Keep SQLite/FTS performance assertions measurable on the 4-core Dell
    // and small CI runners; do not oversubscribe them with every test file.
    maxWorkers: 2,
  },
});
