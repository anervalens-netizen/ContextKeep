// Run root `pnpm build` first, then `node apps/web/scripts/verify-nav.mjs`.
// Optional: CK_NAV_SHOT_DIR and CK_NAV_EXECUTABLE_PATH.
// Always starts a disposable local fixture; CK_BASE_URL is deliberately unused.
import { chromium } from "playwright";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = process.env.CK_NAV_SHOT_DIR
  ? path.resolve(process.env.CK_NAV_SHOT_DIR)
  : null;
const executablePath = process.env.CK_NAV_EXECUTABLE_PATH;
const password = randomBytes(24).toString("base64url");
const routes = ["/inbox", "/import", "/corrections", "/search", "/"];
const widths = [390, 768, 1023, 1024, 1280];
const report = {
  status: "FAIL",
  browser: null,
  auth: [],
  cases: [],
  failures: [],
  cleanup: [],
};
let phase = "initialization";
let fixtureDir;
let worker;
let workerExit;
let browserServer;
let browser;
let context;
let page;
let base;
let stopping = false;
let expectedUnauthorized = false;
let unauthorizedResponses = 0;
const runtimeFailures = [];
const pendingRequests = new Set();
const deliberateUnauthorizedRequests = new WeakSet();

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function errorText(error) {
  return String(error instanceof Error ? error.message : error)
    .replaceAll(password, "[redacted]")
    .slice(0, 2500);
}

async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function startFixture() {
  // No shell, package start script, inherited Node flags, .env loading, or CK/provider env.
  const env = { NODE_ENV: "test" };
  for (const key of [
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TMPDIR",
    "TMP",
    "TEMP",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  worker = fork(
    fileURLToPath(new URL("./nav-fixture.mjs", import.meta.url)),
    [],
    {
      cwd: fixtureDir,
      env,
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  // Never emit fixture logs, credentials, cookies, or response bodies.
  worker.stdout.resume();
  worker.stderr.resume();
  workerExit = new Promise((resolve) => {
    worker.once("exit", (code, signal) => {
      if (!stopping)
        runtimeFailures.push({ kind: "fixture-exit", code, signal });
      resolve({ code, signal });
    });
    worker.once("error", () =>
      resolve({ code: null, signal: null, error: true }),
    );
  });
  const ready = await bounded(
    new Promise((resolve, reject) => {
      worker.once("error", () =>
        reject(new Error("Fixture process could not start")),
      );
      worker.once("exit", (code, signal) =>
        reject(
          new Error(`Fixture exited before readiness (${code ?? signal})`),
        ),
      );
      worker.once("message", (message) => {
        if (
          message?.type !== "ready" ||
          !/^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(message.origin)
        ) {
          reject(new Error("Fixture initialization failed"));
          return;
        }
        resolve(message.origin);
      });
    }),
    20000,
    "fixture readiness",
  );
  const health = await fetch(`${ready}/healthz`, {
    signal: AbortSignal.timeout(5000),
  });
  check(
    health.ok && (await health.json()).ok === true,
    "Fixture health check failed",
  );
  return ready;
}

async function startBrowser() {
  const options = { headless: true, timeout: 15000 };
  if (executablePath) {
    browserServer = await chromium.launchServer({ ...options, executablePath });
    report.browser = "explicit-executable";
  } else {
    try {
      browserServer = await chromium.launchServer({
        ...options,
        channel: "chrome",
      });
      report.browser = "chrome";
    } catch {
      browserServer = await chromium.launchServer(options);
      report.browser = "bundled-chromium";
    }
  }
  browser = await chromium.connect(browserServer.wsEndpoint());
  context = await browser.newContext({
    viewport: { width: 390, height: 900 },
    deviceScaleFactor: 1,
    serviceWorkers: "block",
  });
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(15000);
  // A build accidentally referencing an external origin fails without sending it data.
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin === base ||
      url.protocol === "data:" ||
      url.protocol === "blob:"
    ) {
      await route.continue();
    } else {
      runtimeFailures.push({
        kind: "external-request",
        resource: route.request().resourceType(),
      });
      await route.abort("blockedbyclient");
    }
  });
  page = await context.newPage();
  page.on("pageerror", (error) =>
    runtimeFailures.push({ kind: "pageerror", name: error.name }),
  );
  page.on("request", (request) => {
    pendingRequests.add(request);
    const url = new URL(request.url());
    if (
      expectedUnauthorized &&
      url.origin === base &&
      url.pathname === "/api/projects" &&
      request.method() === "GET"
    ) {
      deliberateUnauthorizedRequests.add(request);
    }
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    if (
      status === 401 &&
      deliberateUnauthorizedRequests.has(response.request())
    ) {
      unauthorizedResponses += 1;
      return;
    }
    const url = new URL(response.url());
    runtimeFailures.push({
      kind: "http",
      status,
      path: url.origin === base ? url.pathname : "external",
    });
  });
  page.on("requestfinished", (request) => pendingRequests.delete(request));
  page.on("requestfailed", (request) => {
    pendingRequests.delete(request);
    const url = new URL(request.url());
    runtimeFailures.push({
      kind: "requestfailed",
      path: url.origin === base ? url.pathname : "external",
    });
  });
}

async function settled() {
  await page.waitForLoadState("domcontentloaded");
  const deadline = Date.now() + 10000;
  let quiet = 0;
  while (quiet < 3 && !stopping) {
    if (Date.now() >= deadline) {
      const details = [...pendingRequests].map(
        (request) =>
          `${request.method()} ${new URL(request.url()).pathname} ${request.resourceType()}`,
      );
      throw new Error(`SPA requests did not finish: ${details.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    quiet = pendingRequests.size === 0 ? quiet + 1 : 0;
  }
  check(!stopping, "Verification stopped");
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  check(
    runtimeFailures.length === 0,
    "Unexpected browser or fixture failures; see failures array",
  );
}

// Browser-origin requests exercise the real session cookie and CSRF double-submit.
async function api(url, method = "GET") {
  return page.evaluate(
    async ({ url, method }) => {
      const headers = {};
      if (method !== "GET") {
        const match = document.cookie.match(/(?:^|;\s*)ck_csrf=([^;]+)/);
        if (!match) throw new Error("Missing CSRF cookie");
        headers["x-csrf-token"] = decodeURIComponent(match[1]);
        headers["content-type"] = "application/json";
      }
      const response = await fetch(url, {
        method,
        headers,
        credentials: "same-origin",
        ...(method === "GET" ? {} : { body: "{}" }),
      });
      // Only auth status has a response body needed by this smoke.
      const data =
        url === "/api/auth/status"
          ? await response.json()
          : (await response.arrayBuffer(), null);
      return { status: response.status, data };
    },
    { url, method },
  );
}

async function signIn(setup = false) {
  await page
    .getByRole("heading", {
      name: setup ? "First-run setup" : "Owner sign in",
      exact: true,
    })
    .waitFor();
  check(
    (await page.locator('[data-shell="app"]').count()) === 0,
    "Login unexpectedly contains the app shell",
  );
  check(
    (await page.locator("[data-nav]").count()) === 0,
    "Login unexpectedly contains shell navigation",
  );
  await page.getByRole("textbox", { name: "Password" }).count();
  // Password inputs have no implicit textbox role.
  await page.getByLabel("Password", { exact: true }).fill(password);
  const endpoint = setup ? "/api/auth/setup" : "/api/auth/login";
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url() === `${base}${endpoint}` &&
        response.request().method() === "POST",
    ),
    page
      .getByRole("button", {
        name: setup ? "Create owner password" : "Sign in",
        exact: true,
      })
      .click(),
  ]);
  check(response.ok(), `${endpoint} returned HTTP ${response.status()}`);
  await page.waitForURL((url) => url.pathname === "/");
  await page.locator('[data-shell="app"]').waitFor({ state: "visible" });
  const status = await api("/api/auth/status");
  check(
    status.status === 200 &&
      status.data.authenticated === true &&
      status.data.needsSetup === false,
    "Authenticated status was not confirmed",
  );
  await settled();
  report.auth.push(setup ? "setup-and-session" : "login");
}

async function logout() {
  // Exercise the actual UI sign-out path. A private read dispatched before the
  // logout POST may legitimately lose the session race and return 401. Only
  // those already-dispatched reads are classified as expected.
  await page.setViewportSize({ width: 1280, height: 900 });
  const account = page.getByRole("button", {
    name: "Account & app",
    exact: true,
  });
  await account.waitFor({ state: "visible" });
  await account.click();
  const signOut = page.getByRole("button", { name: "Sign out", exact: true });
  await signOut.waitFor({ state: "visible" });
  // Drain account-panel reads before taking the pre-logout snapshot. Only
  // request objects already in flight at this boundary may be exempted.
  await settled();
  for (const request of pendingRequests) {
    const url = new URL(request.url());
    if (
      url.origin === base &&
      url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/api/auth/") &&
      (request.method() === "GET" || request.method() === "HEAD")
    ) {
      deliberateUnauthorizedRequests.add(request);
    }
  }
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url() === `${base}/api/auth/logout` &&
        candidate.request().method() === "POST",
    ),
    signOut.click(),
  ]);
  check(response.ok(), `Logout returned HTTP ${response.status()}`);
  await page.waitForURL((url) => url.pathname === "/login");
  await page
    .getByRole("heading", { name: "Owner sign in", exact: true })
    .waitFor();
  const status = await api("/api/auth/status");
  check(
    status.status === 200 &&
      status.data.authenticated === false &&
      status.data.needsSetup === false,
    "Logout did not revoke the session",
  );
  await settled();
  check(
    (await page.locator('[data-shell="app"]').count()) === 0,
    "Shell remained on the login page",
  );
  report.auth.push("logout");
}

async function assertClosedDrawer() {
  await page.waitForFunction(() => {
    const drawer = document.querySelector('[data-drawer="navigation"]');
    return (
      drawer?.hasAttribute("inert") &&
      drawer.getAttribute("aria-hidden") === "true" &&
      !drawer.hasAttribute("aria-modal")
    );
  });
}

async function focused(locator) {
  return locator.evaluate((element) => document.activeElement === element);
}

async function tabTo(locator) {
  for (let i = 0; i < 100; i += 1) {
    await page.keyboard.press("Tab");
    if (await focused(locator)) return;
  }
  throw new Error("Navigation trigger was not reachable with Tab");
}

async function openDrawer() {
  const trigger = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  await tabTo(trigger);
  await page.keyboard.press("Enter");
  const drawer = page.locator('[data-drawer="navigation"]');
  await page.waitForFunction(() => {
    const drawer = document.querySelector('[data-drawer="navigation"]');
    const rect = drawer?.getBoundingClientRect();
    return (
      drawer?.getAttribute("aria-modal") === "true" &&
      !drawer.hasAttribute("inert") &&
      rect &&
      Math.abs(rect.left) < 1
    );
  });
  check(
    await focused(
      drawer.getByRole("link", { name: "ContextKeep home", exact: true }),
    ),
    "Drawer did not focus its first link",
  );
  return drawer;
}

async function assertTrap(drawer) {
  // Discover the native forward Tab sequence, rather than duplicating the hook's selector.
  const first = await page.evaluateHandle(() => document.activeElement);
  let last;
  let wrapped = false;
  try {
    for (let i = 0; i < 100; i += 1) {
      const previous = await page.evaluateHandle(() => document.activeElement);
      await page.keyboard.press("Tab");
      check(
        await drawer.evaluate((element) =>
          element.contains(document.activeElement),
        ),
        "Tab escaped the drawer",
      );
      if (
        await page.evaluate(
          (element) => document.activeElement === element,
          first,
        )
      ) {
        last = previous;
        wrapped = true;
        check(
          i >= 5,
          "Drawer skipped its navigation links in the Tab sequence",
        );
        break;
      }
      await previous.dispose();
    }
    check(wrapped, "Drawer Tab sequence did not wrap");
    await page.keyboard.press("Shift+Tab");
    check(
      await page.evaluate(
        (element) => document.activeElement === element,
        last,
      ),
      "Reverse Tab did not wrap to the last control",
    );
    await page.keyboard.press("Tab");
    check(
      await page.evaluate(
        (element) => document.activeElement === element,
        first,
      ),
      "Forward Tab did not wrap to the first control",
    );
    // Regression: the dialog itself is programmatically focusable (tabIndex=-1).
    // Previously Shift+Tab from it escaped to the backdrop instead of staying modal.
    await drawer.focus();
    await page.keyboard.press("Shift+Tab");
    check(
      await page.evaluate(
        (element) => document.activeElement === element,
        last,
      ),
      "Reverse Tab from the dialog escaped the trap",
    );
  } finally {
    await first.dispose();
    await last?.dispose();
  }
}

async function assertRoutes(nav) {
  const actual = await nav
    .locator("a[href]")
    .evaluateAll((elements) =>
      elements.map((element) => new URL(element.href).pathname),
    );
  check(
    JSON.stringify([...actual].sort()) === JSON.stringify([...routes].sort()),
    "Primary navigation does not contain exactly the five application routes",
  );
  for (const route of routes) {
    check(
      await nav.locator(`a[href="${route}"]`).isVisible(),
      `Navigation link is not visible: ${route}`,
    );
  }
}

async function assertGeometry(desktop, drawerOpen = false) {
  const result = await page.evaluate(
    ({ desktop, drawerOpen }) => {
      const selectors = [
        '[data-shell="app"]',
        '[data-pane="center"]',
        'main[data-shell-center="true"]',
      ];
      selectors.push(
        desktop ? '[data-pane="navigation"]' : '[data-shell="mobile"]',
      );
      if (drawerOpen) selectors.push('[data-drawer="navigation"]');
      const problems = [];
      if (
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1
      )
        problems.push("document horizontal overflow");
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (!element) {
          problems.push(`missing ${selector}`);
          continue;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.left < -1 || rect.right > innerWidth + 1)
          problems.push(`outside viewport: ${selector}`);
        if (element.scrollWidth > element.clientWidth + 1)
          problems.push(`horizontal overflow: ${selector}`);
      }
      if (desktop) {
        const sidebar = document
          .querySelector('[data-pane="navigation"]')
          .getBoundingClientRect();
        const main = document.querySelector("main").getBoundingClientRect();
        if (sidebar.top > 1 || main.left < sidebar.right - 1)
          problems.push("sidebar and center overlap or sidebar is misplaced");
      }
      return problems;
    },
    { desktop, drawerOpen },
  );
  check(result.length === 0, result.join("; "));
}

async function verifyWidth(width) {
  phase = `viewport ${width}`;
  const entry = {
    width,
    desktop: width >= 1024,
    status: "RUNNING",
    routes: [],
  };
  report.cases.push(entry);
  await page.setViewportSize({ width, height: 900 });
  await settled();
  const desktop = width >= 1024;
  const sidebar = page.locator('[data-pane="navigation"]');
  const mobileHeader = page.locator('[data-shell="mobile"]');
  check(
    (await sidebar.isVisible()) === desktop,
    "Incorrect sidebar visibility at lg boundary",
  );
  check(
    (await mobileHeader.isVisible()) === !desktop,
    "Incorrect mobile header visibility at lg boundary",
  );
  await assertClosedDrawer();

  if (!desktop) {
    phase = `viewport ${width}: keyboard drawer`;
    const drawer = await openDrawer();
    await assertRoutes(drawer.locator('[data-nav="drawer"]'));
    await assertGeometry(false, true);
    await assertTrap(drawer);
    await page.keyboard.press("Escape");
    await assertClosedDrawer();
    const trigger = page.getByRole("button", {
      name: "Open navigation",
      exact: true,
    });
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute("aria-label") ===
        "Open navigation",
    );
    check(await focused(trigger), "Escape did not restore trigger focus");

    // Regression: a drawer opened below lg must not retain its trap after resizing.
    await openDrawer();
    await page.setViewportSize({ width: 1024, height: 900 });
    await assertClosedDrawer();
    check(await sidebar.isVisible(), "Desktop sidebar missing after resize");
    await page.keyboard.press("Tab");
    check(
      await page.evaluate(
        () =>
          !document
            .querySelector('[data-drawer="navigation"]')
            .contains(document.activeElement),
      ),
      "Hidden drawer retained keyboard focus after resize",
    );
    await page.setViewportSize({ width, height: 900 });
    await assertClosedDrawer();
  } else {
    await assertRoutes(sidebar.locator('[data-nav="desktop"]'));
    const collapse = sidebar.getByRole("button", {
      name: "Collapse left sidebar",
      exact: true,
    });
    await collapse.focus();
    await page.keyboard.press("Enter");
    const expand = sidebar.getByRole("button", {
      name: "Expand left sidebar",
      exact: true,
    });
    await expand.waitFor();
    check(
      Math.abs((await sidebar.boundingBox()).width - 54) < 1,
      "Collapsed sidebar width is incorrect",
    );
    await assertRoutes(sidebar.locator('[data-nav="desktop"]'));
    await expand.focus();
    await page.keyboard.press("Enter");
    const separator = page.getByRole("separator", {
      name: "Resize left sidebar",
      exact: true,
    });
    await separator.focus();
    await page.keyboard.press("Home");
    check(
      (await separator.getAttribute("aria-valuenow")) === "220",
      "Sidebar Home resize failed",
    );
    await page.keyboard.press("End");
    check(
      (await separator.getAttribute("aria-valuenow")) === "360",
      "Sidebar End resize failed",
    );
    await assertGeometry(true);
    await page.keyboard.press("Home");
    for (let i = 0; i < 4; i += 1) await page.keyboard.press("ArrowRight");
    check(
      (await separator.getAttribute("aria-valuenow")) === "268",
      "Sidebar ArrowRight resize failed",
    );
  }

  for (const route of routes) {
    phase = `viewport ${width}: route ${route}`;
    const nav = desktop
      ? sidebar.locator('[data-nav="desktop"]')
      : (await openDrawer()).locator('[data-nav="drawer"]');
    await nav.locator(`a[href="${route}"]`).click();
    await page.waitForURL((url) => url.pathname === route);
    await assertClosedDrawer();
    await settled();
    check(
      await page.locator('main[data-shell-center="true"]').isVisible(),
      "Authenticated route has no visible main content",
    );
    check(
      (await page.locator('main[data-shell-center="true"]').innerText()).trim()
        .length > 0,
      "Authenticated route rendered empty content",
    );
    const currentNav = page.locator(
      `[data-nav="${desktop ? "desktop" : "drawer"}"]`,
    );
    check(
      (await currentNav
        .locator(`a[href="${route}"]`)
        .getAttribute("aria-current")) === "page",
      "Active navigation route is not marked",
    );
    await assertGeometry(desktop);
    if (OUT) {
      const name = route === "/" ? "projects" : route.slice(1);
      await page.screenshot({
        path: path.join(OUT, `${width}-${name}.png`),
        fullPage: false,
      });
    }
    entry.routes.push(route);
  }
  entry.status = "PASS";
}

async function verifyOfflineReplay() {
  phase = "offline mutation and reconnect replay";
  const name = `Offline audit ${Date.now()}`;
  const cookie = (await context.cookies(base))
    .map((entry) => `${entry.name}=${entry.value}`)
    .join("; ");
  const serverProjects = async () => {
    const response = await fetch(`${base}/api/projects`, {
      headers: { cookie },
      signal: AbortSignal.timeout(5000),
    });
    check(
      response.status === 200,
      "Isolated server readback was not authenticated",
    );
    return response.json();
  };
  const queued = () =>
    page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const opening = indexedDB.open("contextkeep-offline");
          opening.onerror = () => reject(opening.error);
          opening.onupgradeneeded = () => {
            opening.transaction.abort();
            reject(
              new Error(
                "Expected the application offline database to already exist",
              ),
            );
          };
          opening.onsuccess = () => {
            const database = opening.result;
            const transaction = database.transaction("mutations", "readonly");
            const request = transaction.objectStore("mutations").getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            transaction.oncomplete = () => database.close();
            transaction.onerror = () => {
              database.close();
              reject(transaction.error);
            };
          };
        }),
    );
  const until = async (probe, description) => {
    const deadline = Date.now() + 15000;
    while (!stopping && Date.now() < deadline) {
      const result = await probe();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(description);
  };
  const sends = [];
  const observe = (request) => {
    if (
      request.method() !== "POST" ||
      new URL(request.url()).pathname !== "/api/projects"
    )
      return;
    if (request.postDataJSON()?.name === name)
      sends.push(request.headers()["idempotency-key"]);
  };
  page.on("request", observe);
  try {
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();
    await page.getByPlaceholder("Project or component name").fill(name);
    await settled();
    await context.setOffline(true);
    await until(
      () => page.evaluate(() => !navigator.onLine),
      "Browser did not enter native offline mode",
    );
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    const row = await until(
      async () => (await queued()).find((entry) => entry.body?.name === name),
      "Offline mutation was not persisted",
    );
    check(
      (row.deliveryState === undefined || row.deliveryState === "queued") &&
        !row.inFlightOwner &&
        !row.inFlightUntil,
      "Offline mutation must be implicitly or explicitly queued, without an in-flight lease",
    );
    check(
      typeof row.idempotencyKey === "string" && row.idempotencyKey.length > 0,
      "Offline mutation has no stable idempotency identity",
    );
    check(sends.length === 0, "Offline creation issued a network mutation");
    check(
      (await serverProjects()).filter((entry) => entry.name === name).length ===
        0,
      "Offline mutation reached the server before reconnect",
    );
    await context.setOffline(false);
    await until(
      async () =>
        (await serverProjects()).filter((entry) => entry.name === name)
          .length === 1,
      "Queued project was not replayed after reconnect",
    );
    await until(
      async () => !(await queued()).some((entry) => entry.body?.name === name),
      "Replayed mutation remained in the queue",
    );
    await settled();
    check(
      sends.length === 1 && sends[0] === row.idempotencyKey,
      "Replay did not preserve one logical mutation and its original idempotency key",
    );
    check(
      (await serverProjects()).filter((entry) => entry.name === name).length ===
        1,
      "Replay created duplicate projects",
    );
    report.offlineReplay = {
      status: "PASS",
      persistedWhileOffline: true,
      requestsWhileOffline: 0,
      replayRequests: sends.length,
      sameIdempotencyKey: true,
      remainingQueueEntries: 0,
    };
  } finally {
    page.off("request", observe);
    await context.setOffline(false);
  }
}

async function verifyDeniedStorage() {
  phase = "denied browser storage";
  const deniedContext = await browser.newContext({
    storageState: await context.storageState(),
  });
  const errors = [];
  try {
    await deniedContext.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          throw new DOMException("Synthetic storage refusal", "SecurityError");
        },
      });
    });
    const deniedPage = await deniedContext.newPage();
    deniedPage.on("pageerror", (error) => errors.push(error.message));
    let privateReads = 0;
    deniedPage.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/projects")
        privateReads += 1;
    });
    await deniedPage.goto(base, { waitUntil: "networkidle" });
    await deniedPage
      .getByRole("heading", { name: "Browser storage unavailable" })
      .waitFor();
    check(
      privateReads === 0,
      "Private project reads preceded explicit online consent",
    );
    check(
      (await deniedPage
        .getByText("Local ContextKeep data cleared", { exact: true })
        .count()) === 0,
      "Denied storage was incorrectly reported as cleared",
    );
    await deniedPage
      .getByRole("button", { name: "Continue online without local storage" })
      .click();
    await deniedPage.locator('[data-shell="app"]').waitFor();
    await deniedPage.waitForLoadState("networkidle");
    for (const route of ["/inbox", "/import", "/corrections", "/search"]) {
      await deniedPage.goto(`${base}${route}`, { waitUntil: "networkidle" });
      await deniedPage
        .getByRole("button", { name: "Continue online without local storage" })
        .click();
      await deniedPage.locator('[data-shell="app"]').waitFor();
      await deniedPage.waitForLoadState("networkidle");
    }
    const databases = await deniedPage.evaluate(() => indexedDB.databases());
    check(
      !databases.some((entry) => entry.name === "contextkeep-offline"),
      "Denied local access opened the offline store",
    );
    check(
      errors.length === 0,
      `Denied-storage startup errors: ${errors.join("; ")}`,
    );
    report.deniedStorage = {
      status: "PASS",
      explicitOnlineConsent: true,
      offlineStoreOpened: false,
      routesChecked: 5,
      startupErrors: 0,
    };
  } finally {
    await deniedContext.close();
  }
}

async function run() {
  phase = "built artifact check";
  await Promise.all([
    access(new URL("../../server/dist/app.js", import.meta.url)),
    access(new URL("../../server/dist/config.js", import.meta.url)),
    access(new URL("../dist/index.html", import.meta.url)),
  ]);
  fixtureDir = await mkdtemp(path.join(tmpdir(), "ck-nav-"));
  if (OUT) await mkdir(OUT, { recursive: true });
  phase = "fixture startup";
  base = await startFixture();
  phase = "browser startup";
  await startBrowser();
  phase = "first-run authentication";
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  const initial = await api("/api/auth/status");
  check(
    initial.status === 200 &&
      initial.data.needsSetup === true &&
      initial.data.authenticated === false,
    "Fixture is not a fresh unauthenticated store",
  );
  expectedUnauthorized = true;
  try {
    check(
      (await api("/api/projects")).status === 401,
      "Private API did not reject the unauthenticated request",
    );
  } finally {
    expectedUnauthorized = false;
  }
  check(
    unauthorizedResponses === 1,
    "Expected exactly one deliberate pre-login HTTP 401",
  );
  await signIn(true);
  await logout();
  await signIn();
  await logout();
  await signIn();
  for (const width of widths) await verifyWidth(width);
  await verifyOfflineReplay();
  await verifyDeniedStorage();
  await settled();
}

let interrupt;
const interrupted = new Promise((_, reject) => {
  interrupt = reject;
});
const onSignal = () => interrupt(new Error("Verification interrupted"));
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
try {
  await bounded(Promise.race([run(), interrupted]), 240000, "navigation smoke");
} catch (error) {
  report.failures.push({ phase, message: errorText(error) });
} finally {
  stopping = true;
  async function cleanup(name, action) {
    try {
      await bounded(action(), 10000, name);
      report.cleanup.push({ name, status: "PASS" });
    } catch (error) {
      report.cleanup.push({ name, status: "FAIL" });
      report.failures.push({ phase: name, message: errorText(error) });
    }
  }
  if (context) await cleanup("browser context close", () => context.close());
  if (browser) await cleanup("browser connection close", () => browser.close());
  if (browserServer) {
    await cleanup("browser process close", async () => {
      try {
        await bounded(browserServer.close(), 5000, "browser graceful close");
      } catch (error) {
        await browserServer.kill();
        throw error;
      }
    });
    const process = browserServer.process();
    if (process && process.exitCode === null && process.signalCode === null) {
      await cleanup("browser process termination", async () => {
        const exited = new Promise((resolve) => process.once("exit", resolve));
        process.kill("SIGKILL");
        await exited;
      });
    }
  }
  if (worker) {
    await cleanup("fixture process close", async () => {
      if (worker.exitCode === null && worker.signalCode === null)
        worker.kill("SIGTERM");
      let result;
      try {
        result = await bounded(workerExit, 5000, "fixture graceful close");
      } catch (error) {
        worker.kill("SIGKILL");
        await bounded(workerExit, 3000, "fixture forced close");
        throw error;
      }
      check(
        result.code === 0 && !result.error,
        `Fixture shutdown failed (${result.code ?? result.signal})`,
      );
    });
  }
  if (fixtureDir)
    await cleanup("temporary directory removal", () =>
      rm(fixtureDir, { recursive: true, force: true }),
    );
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}
report.failures.push(...runtimeFailures);
report.status =
  report.failures.length === 0 &&
  report.cases.length === widths.length &&
  report.cases.every((entry) => entry.status === "PASS") &&
  report.offlineReplay?.status === "PASS" &&
  report.deniedStorage?.status === "PASS"
    ? "PASS"
    : "FAIL";
if (OUT) {
  try {
    await writeFile(
      path.join(OUT, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  } catch (error) {
    report.status = "FAIL";
    report.failures.push({ phase: "report output", message: errorText(error) });
  }
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
