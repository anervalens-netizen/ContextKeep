import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

const sharedSrc = path.resolve(import.meta.dirname, "../../packages/shared/src/index.ts");

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Handoff §9: registerType autoUpdate + an owner-facing prompt-for-update
      // flow (controllerchange banner with changelog) layered on top.
      registerType: "autoUpdate",
      injectRegister: false,
      strategies: "generateSW",
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api/],
        cleanupOutdatedCaches: true,
        // autoUpdate semantics, explicit: activate the new SW immediately AND
        // take control of open tabs so the controllerchange update banner fires.
        skipWaiting: true,
        clientsClaim: true,
        // CK-A04: private API data is never cached by the service worker.
        // Offline reads use the explicit IndexedDB mirror, which preserves
        // provenance/fetchedAt/scope instead of presenting an opaque SW 200 as
        // freshly revalidated data. Workbox remains app-shell/assets only.
        runtimeCaching: [],
      },
      manifest: {
        name: "ContextKeep",
        short_name: "CK",
        description: "Keep the context. Know what changed. Private project memory and handoffs.",
        start_url: "/?source=pwa",
        scope: "/",
        display: "standalone",
        orientation: "portrait-primary",
        background_color: "#F6F6F4",
        theme_color: "#0E7C7B",
        icons: [
          { src: "/icons/pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/icons/logo.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: [
      // Subpath first: keeps zod/schema runtime out of the web bundle (only the
      // pure install-gate function is imported at startup).
      {
        find: "@contextkeep/shared/install-gate",
        replacement: path.resolve(import.meta.dirname, "../../packages/shared/src/install-gate.ts"),
      },
      {
        find: "@contextkeep/shared",
        replacement: sharedSrc,
      },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:3082", changeOrigin: false },
      "/healthz": { target: "http://127.0.0.1:3082" },
    },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        // Vite 8 is Rolldown-based: manualChunks must be the function form.
        // react-virtual is intentionally NOT in the startup vendor chunk — it is
        // only used by lazy route components (inbox/timeline/search lists).
        manualChunks(id: string): string | undefined {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
          if (id.includes("@tanstack") && !id.includes("react-virtual")) return "tanstack";
          return undefined;
        },
      },
    },
  },
});
