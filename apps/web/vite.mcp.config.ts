import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
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
