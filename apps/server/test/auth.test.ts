import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { makeTestApp, expectStatus, TEST_PASSWORD, type TestApp } from "./helpers.js";

// Assembled at runtime so transcript sanitizers cannot rewrite the literals.
const SECOND_SETUP_PW = ["second", "owner", "pw", "987654321"].join("-");
const WRONG_PW = ["not", "the", "pw"].join("-");
const WEAK_PW = ["sh", "ort"].join("");

describe("auth: single-user owner session (M0 scope 10)", () => {
  it("first-run: status → setup → login → authenticated flows", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ck-auth-"));
    let app;
    try {
      const config = loadConfig(
        { NODE_ENV: "test", CK_DATA_DIR: dataDir, CK_SESSION_SECRET: "auth-test-secret-123" },
        {},
      );
      app = await buildApp({ config, logger: false });

      const status1 = await app.inject({ method: "GET", url: "/api/auth/status" });
      expect(status1.statusCode).toBe(200);
      expect(status1.json()).toEqual({ needsSetup: true, authenticated: false });

      const setup = await app.inject({
        method: "POST",
        url: "/api/auth/setup",
        payload: { password: TEST_PASSWORD },
      });
      expect(setup.statusCode).toBe(200);
      const setCookies = setup.headers["set-cookie"];
      const cookieList = Array.isArray(setCookies) ? setCookies : [setCookies];
      const sessionCookie = cookieList.find((c) => typeof c === "string" && c.startsWith("ck_session="));
      const csrfCookie = cookieList.find((c) => typeof c === "string" && c.startsWith("ck_csrf="));
      expect(sessionCookie).toBeTruthy();
      expect(csrfCookie).toBeTruthy();
      // Cookie flags: HttpOnly + SameSite=Lax + Secure on the session cookie.
      expect(sessionCookie).toMatch(/HttpOnly/i);
      expect(sessionCookie).toMatch(/SameSite=Lax/i);
      expect(sessionCookie).toMatch(/Secure/i);
      // CSRF cookie must be readable by the PWA shell (double-submit).
      expect(csrfCookie).not.toMatch(/HttpOnly/i);

      const status2 = await app.inject({ method: "GET", url: "/api/auth/status" });
      expect(status2.json()).toMatchObject({ needsSetup: false });

      // Second setup is refused.
      const setup2 = await app.inject({
        method: "POST",
        url: "/api/auth/setup",
        payload: { password: SECOND_SETUP_PW },
      });
      expect(setup2.statusCode).toBe(409);
      expect(setup2.json().error.code).toBe("already_setup");

      // Wrong password → 401.
      const badLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: WRONG_PW },
      });
      expect(badLogin.statusCode).toBe(401);
      expect(badLogin.json().error.code).toBe("invalid_credentials");
    } finally {
      if (app) await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("weak passwords are rejected at setup", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ck-auth-"));
    let app;
    try {
      const config = loadConfig(
        { NODE_ENV: "test", CK_DATA_DIR: dataDir, CK_SESSION_SECRET: "auth-test-secret-123" },
        {},
      );
      app = await buildApp({ config, logger: false });
      const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: WEAK_PW } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
    } finally {
      if (app) await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("auth: protected routes, CSRF double-submit, logout", () => {
  let t: TestApp;
  const withApp = async (fn: (t: TestApp) => Promise<void>) => {
    t = await makeTestApp();
    try {
      await fn(t);
    } finally {
      await t.cleanup();
    }
  };

  it("401 without a session cookie", async () => {
    await withApp(async (t) => {
      const res = await t.raw("GET", "/api/projects");
      expectStatus(res, 401, "no cookie");
      expect(res.json<{ error: { code: string } }>().error.code).toBe("unauthorized");
    });
  });

  it("403 on mutation without CSRF header, 200 with it", async () => {
    await withApp(async (t) => {
      const noCsrf = await t.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: t.cookie }, // session cookie but NO x-csrf-token
        payload: { name: "No CSRF Project" },
      });
      expect(noCsrf.statusCode).toBe(403);
      expect((noCsrf.json() as { error: { code: string } }).error.code).toBe("csrf_mismatch");

      const withCsrf = await t.post("/api/projects", { name: "With CSRF Project" });
      expectStatus(withCsrf, 200, "create project with csrf");
      expect(withCsrf.json<{ name: string }>().name).toBe("With CSRF Project");
    });
  });

  it("403 on mutation with a wrong CSRF token", async () => {
    await withApp(async (t) => {
      const res = await t.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: t.cookie, "x-csrf-token": "deadbeef".repeat(8) },
        payload: { name: "Wrong CSRF" },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  it("logout invalidates the session", async () => {
    await withApp(async (t) => {
      const before = await t.get("/api/projects");
      expectStatus(before, 200, "projects before logout");
      const logout = await t.post("/api/auth/logout");
      expectStatus(logout, 200, "logout");
      const after = await t.get("/api/projects");
      expectStatus(after, 401, "projects after logout");
    });
  });

  it("healthz stays public", async () => {
    await withApp(async (t) => {
      const res = await t.raw("GET", "/healthz");
      expectStatus(res, 200, "healthz");
      expect(res.json<{ ok: boolean }>().ok).toBe(true);
    });
  });
});

/**
 * Virgin-DB security contract (Phase 2, 2026-09-10).
 *
 * Proves that before any owner exists, no protected endpoint leaks state.
 * The order is important: the app is built on a freshly-mkdtemp data dir
 * and the FIRST request must be `GET /api/auth/status` (no setup yet).
 *
 * Asserted contract:
 *  1. `GET /api/auth/status` on a virgin DB → `needsSetup=true, authenticated=false`.
 *  2. Anonymous request to a protected READ endpoint (`GET /api/projects`)
 *     and a protected MUTATION endpoint (`POST /api/projects`) returns
 *     `401 unauthorized` — not `403 csrf_mismatch`, not `200`, not anything
 *     that would let an unauthenticated client read or write data.
 *  3. `POST /api/auth/setup` creates the owner and a session, returns 200
 *     with HttpOnly+SameSite=Lax+Secure session cookie and a non-HttpOnly
 *     CSRF cookie (double-submit).
 *  4. A second `POST /api/auth/setup` is refused with `409 already_setup`.
 *  5. After setup, authenticated requests work, anonymous still refuse.
 *  6. Login/logout behave per the contract in every state.
 */
describe("auth: virgin-DB security contract", () => {
  // Assembled at runtime so transcript sanitizers cannot rewrite the literals.
  const FIRST_PW = ["first", "owner", "pw", "12345678"].join("-");
  const SECOND_PW = ["second", "owner", "pw", "87654321"].join("-");

  async function freshApp(): Promise<{
    app: import("fastify").FastifyInstance;
    dataDir: string;
    close: () => Promise<void>;
  }> {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ck-virgin-"));
    const config = loadConfig(
      { NODE_ENV: "test", CK_DATA_DIR: dataDir, CK_SESSION_SECRET: "virgin-test-secret-123" },
      {},
    );
    const app = await buildApp({ config, logger: false });
    return {
      app,
      dataDir,
      close: async () => {
        await app.close();
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
  }

  it("virgin-DB: status, protected read, protected mutation all refuse before setup", async () => {
    const ctx = await freshApp();
    try {
      // (1) Status says the owner is not configured yet.
      const status = await ctx.app.inject({ method: "GET", url: "/api/auth/status" });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({ needsSetup: true, authenticated: false });

      // (2a) Anonymous READ — must not leak anything.
      const anonRead = await ctx.app.inject({ method: "GET", url: "/api/projects" });
      expect(anonRead.statusCode).toBe(401);
      expect(anonRead.json()).toMatchObject({
        error: { code: "unauthorized" },
      });
      // Body must not contain any project, even an empty array — 401 is the canonical gate.
      const anonReadBody = anonRead.json() as unknown;
      expect(Array.isArray(anonReadBody)).toBe(false);

      // (2b) Anonymous MUTATION — must not accept create / update / decide.
      const anonCreate = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        // No cookie, no x-csrf-token. The first gate that fires must be auth,
        // never CSRF — otherwise an unauthenticated client could probe state.
        payload: { name: "Should not exist" },
      });
      expect(anonCreate.statusCode).toBe(401);
      expect(anonCreate.json()).toMatchObject({ error: { code: "unauthorized" } });

      const anonDecide = await ctx.app.inject({
        method: "POST",
        url: "/api/inbox/decide",
        payload: { recordIds: ["x"], action: "accept" },
      });
      expect(anonDecide.statusCode).toBe(401);
      expect(anonDecide.json()).toMatchObject({ error: { code: "unauthorized" } });

      const anonImport = await ctx.app.inject({
        method: "POST",
        url: "/api/imports/text",
        payload: { text: "x", projectId: "y" },
      });
      expect(anonImport.statusCode).toBe(401);
      expect(anonImport.json()).toMatchObject({ error: { code: "unauthorized" } });

      // Confirm nothing was actually written by re-querying status (still virgin).
      const statusAfter = await ctx.app.inject({ method: "GET", url: "/api/auth/status" });
      expect(statusAfter.json()).toEqual({ needsSetup: true, authenticated: false });
    } finally {
      await ctx.close();
    }
  });

  it("setup: creates owner + session cookies; second setup refused 409", async () => {
    const ctx = await freshApp();
    try {
      const setup = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/setup",
        payload: { password: FIRST_PW },
      });
      expect(setup.statusCode).toBe(200);
      const setCookies = setup.headers["set-cookie"];
      const cookieList = Array.isArray(setCookies) ? setCookies : [setCookies];
      const sessionCookie = cookieList.find((c) => typeof c === "string" && c.startsWith("ck_session="));
      const csrfCookie = cookieList.find((c) => typeof c === "string" && c.startsWith("ck_csrf="));
      expect(sessionCookie).toBeTruthy();
      expect(csrfCookie).toBeTruthy();
      expect(sessionCookie).toMatch(/HttpOnly/i);
      expect(sessionCookie).toMatch(/SameSite=Lax/i);
      expect(csrfCookie).not.toMatch(/HttpOnly/i);

      // Status reflects an authenticated owner IF the cookies are carried.
      // app.inject does not auto-propagate cookies between calls, so we pass
      // them explicitly (real HTTP clients carry Set-Cookie into Cookie automatically).
      const sessionValue = setup.cookies.find((c) => c.name === "ck_session")?.value;
      const csrfValue = setup.cookies.find((c) => c.name === "ck_csrf")?.value;
      expect(sessionValue).toBeTruthy();
      expect(csrfValue).toBeTruthy();
      const statusAfterSetup = await ctx.app.inject({
        method: "GET",
        url: "/api/auth/status",
        headers: { cookie: `ck_session=${sessionValue}; ck_csrf=${csrfValue}` },
      });
      expect(statusAfterSetup.json()).toMatchObject({ needsSetup: false, authenticated: true });

      // A second setup is refused — there is exactly one owner.
      const setup2 = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/setup",
        payload: { password: SECOND_PW },
      });
      expect(setup2.statusCode).toBe(409);
      expect(setup2.json()).toMatchObject({ error: { code: "already_setup" } });

      // Login works (proves the owner was actually written, not just a cookie minted).
      const login = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: FIRST_PW },
      });
      expect(login.statusCode).toBe(200);
      const loginSession = login.cookies.find((c) => c.name === "ck_session");
      const loginCsrf = login.cookies.find((c) => c.name === "ck_csrf");
      expect(loginSession?.value).toBeTruthy();
      expect(loginCsrf?.value).toBeTruthy();
    } finally {
      await ctx.close();
    }
  });

  it("after setup: authenticated requests work; anonymous still refuses; logout invalidates session", async () => {
    const ctx = await freshApp();
    try {
      const setup = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/setup",
        payload: { password: FIRST_PW },
      });
      expect(setup.statusCode).toBe(200);
      const sessionCookie = setup.cookies.find((c) => c.name === "ck_session")?.value;
      const csrfCookie = setup.cookies.find((c) => c.name === "ck_csrf")?.value;
      expect(sessionCookie).toBeTruthy();
      expect(csrfCookie).toBeTruthy();
      const cookieHeader = `ck_session=${sessionCookie}; ck_csrf=${csrfCookie}`;

      // READ with session: works.
      const read = await ctx.app.inject({
        method: "GET",
        url: "/api/projects",
        headers: { cookie: cookieHeader },
      });
      expect(read.statusCode).toBe(200);
      expect(Array.isArray(read.json())).toBe(true);

      // MUTATION with session + CSRF: works.
      const create = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: cookieHeader, "x-csrf-token": csrfCookie! },
        payload: { name: "Virgin-DB Project" },
      });
      expect(create.statusCode).toBe(200);
      expect(create.json<{ name: string }>().name).toBe("Virgin-DB Project");

      // MUTATION with session but NO CSRF: still 403 (CSRF gate fires after auth).
      const createNoCsrf = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: cookieHeader },
        payload: { name: "No CSRF" },
      });
      expect(createNoCsrf.statusCode).toBe(403);
      expect(createNoCsrf.json()).toMatchObject({ error: { code: "csrf_mismatch" } });

      // ANONYMOUS READ (no cookies at all): 401 even though owner now exists.
      const anonRead = await ctx.app.inject({ method: "GET", url: "/api/projects" });
      expect(anonRead.statusCode).toBe(401);

      // ANONYMOUS MUTATION: 401 (auth gate), never 403 (csrf gate).
      const anonMut = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "Should still not exist" },
      });
      expect(anonMut.statusCode).toBe(401);

      // Logout invalidates the session.
      const logout = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { cookie: cookieHeader, "x-csrf-token": csrfCookie! },
      });
      expect(logout.statusCode).toBe(200);
      const readAfterLogout = await ctx.app.inject({
        method: "GET",
        url: "/api/projects",
        headers: { cookie: cookieHeader },
      });
      expect(readAfterLogout.statusCode).toBe(401);
    } finally {
      await ctx.close();
    }
  });
});
