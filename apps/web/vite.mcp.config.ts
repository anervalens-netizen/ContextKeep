import {execFileSync} from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  // Library mode preserves process.env; the iframe has no Node.js globals.
  define: { "import.meta.env.VITE_RELEASE": JSON.stringify(process.env.CK_BUILD_SHA || execFileSync("git",["rev-parse","HEAD"],{cwd:import.meta.dirname,encoding:"utf8"}).trim()), "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist/mcp",
    emptyOutDir: true,
    target: "es2022",
    lib: {
      entry: "src/mcp-app.tsx",
      name: "ContextKeepPanel",
      formats: ["iife"],
      fileName: () => "widget.js",
      cssFileName: "widget",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
