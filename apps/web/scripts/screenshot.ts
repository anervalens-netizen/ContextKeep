#!/usr/bin/env -S node --import tsx/esm
/**
 * ContextKeep design-QA screenshot harness.
 *
 * Captures every page in both light and dark themes against the running
 * server at CK_BASE_URL (default http://127.0.0.1:3082). Output goes to
 * docs/verification/design-screenshots/<theme>/<page>.png.
 *
 * Auth: set CK_SCREENSHOT_PASSWORD (the owner password) before running.
 * If the store has no owner yet, this script creates one with that
 * password and re-runs. Idempotent — safe to re-run.
 *
 * Usage:
 *   CK_SCREENSHOT_PASSWORD=<owner-pw> pnpm --filter @contextkeep/web screenshots
 *
 * The script is intentionally tolerant: missing pages or empty lists are
 * captured as-is so the screenshots still tell the design story.
 */
import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env["CK_BASE_URL"] ?? "http://127.0.0.1:3082";
const PASSWORD = process.env["CK_SCREENSHOT_PASSWORD"];
const OUT_DIR = resolve(__dirname, "../../../docs/verification/design-screenshots");

type Theme = "light" | "dark";

interface Shot {
  name: string;
  path: string; // path under the app
  /** Optional: dataset value to seed before navigation (e.g. ?source=pwa). */
  search?: string;
  /** Optional: extra setup function (e.g. click a tab). */
  setup?: (page: Page) => Promise<void>;
  /** Optional: CSS selector to wait for before screenshotting. */
  ready?: string;
  /** Optional: skip if this route can't be reached (return false from a guard). */
  guard?: (ctx: { projects: Array<{ id: string }>; hasInbox: boolean }) => boolean;
}

function shots(): Shot[] {
  return [
    { name: "01-login", path: "/login", ready: 'h2:has-text("Owner sign in"), h2:has-text("First-run setup")' },
    { name: "02-projects", path: "/", ready: 'h1:has-text("Projects")' },
    {
      name: "03-project-brief",
      path: "/projects/__id__",
      guard: (ctx) => ctx.projects.length > 0,
      ready: "h1",
    },
    {
      name: "04-project-timeline",
      path: "/projects/__id__",
      guard: (ctx) => ctx.projects.length > 0,
      setup: clickTimelineTab,
      ready: 'button:has-text("timeline")',
    },
    {
      name: "05-project-export",
      path: "/projects/__id__",
      guard: (ctx) => ctx.projects.length > 0,
      setup: clickExportTab,
      ready: 'button:has-text("export")',
    },
    { name: "06-inbox", path: "/inbox", ready: 'h1:has-text("Review inbox")' },
    { name: "07-import", path: "/import", ready: 'h1:has-text("Import material")' },
    { name: "08-corrections", path: "/corrections", ready: 'h1:has-text("Owner correction")' },
    { name: "09-search", path: "/search", setup: seedSearch, ready: 'input[type="search"]' },
  ];
}

async function clickTimelineTab(page: Page): Promise<void> {
  await page.locator("button", { hasText: /^timeline$/i }).first().click();
}

async function clickExportTab(page: Page): Promise<void> {
  await page.locator("button", { hasText: /^export$/i }).first().click();
}

async function seedSearch(page: Page): Promise<void> {
  await page.fill('input[type="search"]', "release verification");
  await page.waitForTimeout(400); // debounce + render
}

interface AuthBootstrap {
  ownerExists: boolean;
}

async function checkOwnerExists(): Promise<AuthBootstrap> {
  const res = await fetch(`${BASE_URL}/api/auth/status`, { credentials: "include" });
  if (!res.ok) throw new Error(`auth status: ${res.status}`);
  const json = (await res.json()) as { needsSetup?: boolean };
  return { ownerExists: json.needsSetup === false };
}

async function setupOwner(password: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`auth setup failed: ${res.status} ${text}`);
  }
}

async function login(ctx: BrowserContext, password: string): Promise<void> {
  // Use the browser context so the session cookie is set in our isolated
  // context, not in node's fetch cookie jar.
  const apiPage = await ctx.newPage();
  await apiPage.goto(`${BASE_URL}/login`);
  await apiPage.fill('input[type="password"]', password);
  await apiPage.click('button[type="submit"]');
  await apiPage.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 5000 }).catch(() => undefined);
  await apiPage.close();
}

interface AuthProbe {
  authenticated: boolean;
}

async function probeAuth(page: Page): Promise<AuthProbe> {
  const res = await page.request.get(`${BASE_URL}/api/auth/status`);
  if (!res.ok()) return { authenticated: false };
  const json = (await res.json()) as { authenticated?: boolean };
  return { authenticated: json.authenticated === true };
}

interface ProjectSummary {
  id: string;
  name: string;
}

interface ProjectsResp extends Array<ProjectSummary> {}

async function probeContext(page: Page): Promise<{ projects: ProjectSummary[]; hasInbox: boolean }> {
  const projects = await page.request
    .get(`${BASE_URL}/api/projects`)
    .then(async (r) => (await r.json()) as ProjectsResp)
    .catch(() => [] as ProjectSummary[]);
  const inbox = await page.request
    .get(`${BASE_URL}/api/inbox?limit=1`)
    .then((r) => r.status())
    .catch(() => 0);
  return { projects, hasInbox: inbox === 200 };
}

async function takeShot(
  browser: Browser,
  theme: Theme,
  page: Page,
  shot: Shot,
  projects: ProjectSummary[],
  cookies: Awaited<ReturnType<BrowserContext["cookies"]>>,
): Promise<void> {
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 915 }, // Pixel 7 — covers most modern phones + small desktop
    deviceScaleFactor: 2,
    colorScheme: theme === "dark" ? "dark" : "light",
    extraHTTPHeaders: { "x-design-screenshot": "1" },
  });
  // Share session cookies with the probe context so authenticated pages
  // render their content (not a /login redirect).
  if (cookies.length > 0) {
    await ctx.addCookies(cookies);
  }
  // Block the service worker entirely: the PWA banners ("new version installed",
  // "ready to work offline") would otherwise pollute design screenshots on
  // any page where workbox's idle callbacks fire.
  await ctx.route(/\/sw\.js(\?.*)?$/, (route) => route.abort());
  const p = await ctx.newPage();
  // Apply theme before navigation so CSS picks it up on first paint.
  await p.addInitScript((t: Theme) => {
    window.localStorage.setItem("ck:theme", t);
    document.documentElement.setAttribute("data-theme", t);
    // The PWA registration is deferred to idle; when /sw.js is blocked above
    // we still want to suppress any leftover state.
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
    }
  }, theme);

  if (shot.path === "/login") {
    await ctx.clearCookies();
  }

  // Resolve dynamic project id.
  let path = shot.path;
  if (path.includes("__id__")) {
    const projectId = projects[0]?.id;
    if (!projectId) {
      await ctx.close();
      console.warn(`  skip ${shot.name}: no project in store`);
      return;
    }
    path = path.replace("__id__", projectId);
  }

  const url = `${BASE_URL}${path}${shot.search ?? ""}`;
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
  await p.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);

  // Wait for page-specific content before capturing — some pages render
  // "Loading..." until the auth-status query resolves (especially /login,
  // which renders nothing useful until useQuery on auth-status succeeds).
  if (shot.ready) {
    try {
      await p.waitForSelector(shot.ready, { timeout: 10000, state: "visible" });
    } catch (err) {
      console.warn(`  ready selector "${shot.ready}" not found for ${shot.name}: ${(err as Error).message}`);
    }
  }

  if (shot.setup) await shot.setup(p);

  const out = resolve(OUT_DIR, theme, `${shot.name}.png`);
  await mkdir(dirname(out), { recursive: true });
  await p.screenshot({ path: out, fullPage: true });
  await ctx.close();
  console.log(`  ✓ ${theme}/${shot.name}.png (${url})`);
}

async function writeManifest(themes: Theme[], all: Shot[]): Promise<void> {
  const manifest = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    themes,
    pages: all.map((s) => ({ name: s.name, path: s.path })),
  };
  const out = resolve(OUT_DIR, "manifest.json");
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(out, JSON.stringify(manifest, null, 2));
  console.log(`  ✓ manifest.json`);
}

async function main(): Promise<void> {
  if (!PASSWORD) {
    throw new Error("CK_SCREENSHOT_PASSWORD is not set. Set it to the owner password before running.");
  }

  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Output:   ${OUT_DIR}`);

  const { ownerExists } = await checkOwnerExists();
  if (!ownerExists) {
    console.log("No owner yet — creating one with the provided password.");
    await setupOwner(PASSWORD);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  // One context for auth + context probing. We'll create per-shot contexts
  // so theme + viewport settings stay isolated.
  const probeCtx = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
  });
  const probePage = await probeCtx.newPage();
  await probePage.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  // Try to log in.
  await probePage.fill('input[type="password"]', PASSWORD);
  await probePage.click('button[type="submit"]');
  try {
    await probePage.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 5000 });
  } catch {
    await probeCtx.close();
    await browser.close();
    throw new Error("Login failed — check CK_SCREENSHOT_PASSWORD.");
  }

  const auth = await probeAuth(probePage);
  if (!auth.authenticated) {
    await probeCtx.close();
    await browser.close();
    throw new Error("Auth probe says we're still unauthenticated after login.");
  }

  const ctxProbe = await probeContext(probePage);
  // Snapshot the cookies BEFORE closing the probe context — we copy them
  // into each per-shot context so authenticated pages render.
  const sharedCookies = await probeCtx.cookies();
  await probeCtx.close();

  const all = shots();
  const themes: Theme[] = ["light", "dark"];
  for (const theme of themes) {
    console.log(`\n[${theme}]`);
    for (const shot of all) {
      if (shot.guard && !shot.guard(ctxProbe)) {
        console.warn(`  skip ${shot.name}: guard refused (no data)`);
        continue;
      }
      try {
        await takeShot(browser, theme, probePage, shot, ctxProbe.projects, sharedCookies);
      } catch (err) {
        console.error(`  ✗ ${shot.name}: ${(err as Error).message}`);
      }
    }
  }

  await writeManifest(themes, all);
  await browser.close();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
