import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@contextkeep/shared/install-gate",
        replacement: path.resolve(import.meta.dirname, "../../packages/shared/src/install-gate.ts"),
      },
      {
        find: "@contextkeep/shared",
        replacement: path.resolve(import.meta.dirname, "../../packages/shared/src/index.ts"),
      },
    ],
  },
  test: {
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    testTimeout: 15000,
  },
});
