import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { TEST_PASSWORD } from "./helpers.js";
import * as oidc from "openid-client";

vi.mock("openid-client", async (original) => {
  const actual = await original<typeof import("openid-client")>();
  return { ...actual, enableNonRepudiationChecks: vi.fn(), discovery: vi.fn(async () => ({})),
    buildAuthorizationUrl: vi.fn((_config, params) => { const url = new URL("https://identity.example/authorize"); url.search = new URLSearchParams(params).toString(); return url; }),
    authorizationCodeGrant: vi.fn() };
});
const env = {
  NODE_ENV: "test", CK_SESSION_SECRET: "synthetic-oidc-test-secret",
  CK_OIDC_ISSUER: "https://identity.example/issuer/", CK_OIDC_CLIENT_ID: "synthetic-client",
  CK_OIDC_CLIENT_SECRET: "synthetic-client-secret", CK_OIDC_OWNER_SUBJECT: "synthetic-owner",
  CK_OIDC_CALLBACK_URL: "https://memory.example/api/auth/oidc/callback",
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.clearAllMocks(); });
async function fixture() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ck-oidc-"));
  const app = await buildApp({ config: loadConfig({ ...env, CK_DATA_DIR: dataDir }), logger: false });
  cleanups.push(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: TEST_PASSWORD } });
  const start = await app.inject({ method: "GET", url: "/api/auth/oidc/start" });
  expect(start.statusCode).toBe(302);
  expect(oidc.enableNonRepudiationChecks).toHaveBeenCalled();
  const redirect = new URL(start.headers.location!);
  const binding = start.cookies.find(c => c.name === "__Host-ck_oidc")!;
  const cookie = `${binding.name}=${binding.value}`;
  const callback = `/api/auth/oidc/callback?code=synthetic-code&state=${redirect.searchParams.get("state")}`;
  return { app, cookie, callback, start, redirect };
}
function ownerResponse(subject = "synthetic-owner") {
  vi.mocked(oidc.authorizationCodeGrant).mockResolvedValue({ claims: () => ({ sub: subject }) } as never);
}

describe("optional single-owner OIDC", () => {
  it("rejects incomplete and insecure configurations", () => {
    expect(() => loadConfig({ CK_OIDC_CLIENT_ID: "partial" })).toThrow(/All CK_OIDC/);
    expect(() => loadConfig({ ...env, CK_COOKIE_SECURE: "false" })).toThrow(/HTTPS/);
    expect(() => loadConfig({ ...env, CK_OIDC_ISSUER: "http://identity.example" })).toThrow(/HTTPS/);
    expect(() => loadConfig({ ...env, CK_OIDC_CALLBACK_URL: "https://memory.example/other" })).toThrow(/callback/);
  });
  it("requests PKCE, state and nonce with a secure browser binding", async () => {
    const { start, redirect } = await fixture();
    expect(redirect.searchParams.get("scope")).toBe("openid");
    expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
    expect(redirect.searchParams.get("code_challenge")).toBeTruthy();
    expect(redirect.searchParams.get("state")).toBeTruthy();
    expect(redirect.searchParams.get("nonce")).toBeTruthy();
    expect(String(start.headers["set-cookie"])).toMatch(/HttpOnly/);
    expect(String(start.headers["set-cookie"])).toMatch(/Secure/);
    expect(String(start.headers["set-cookie"])).toMatch(/SameSite=Lax/);
    expect(start.headers["cache-control"]).toBe("no-store");
  });
  it("creates an ordinary owner session only after validated claims; CSRF still applies", async () => {
    ownerResponse();
    const { app, cookie, callback, redirect } = await fixture();
    const response = await app.inject({ method: "GET", url: callback, headers: { cookie, host: "attacker.example" } });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/");
    const [, checkedUrl, checks] = vi.mocked(oidc.authorizationCodeGrant).mock.calls[0]!;
    expect((checkedUrl as URL).origin).toBe("https://memory.example");
    expect(checks).toMatchObject({ expectedState: redirect.searchParams.get("state"), expectedNonce: redirect.searchParams.get("nonce"), idTokenExpected: true });
    expect(await oidc.calculatePKCECodeChallenge(checks!.pkceCodeVerifier!)).toBe(redirect.searchParams.get("code_challenge"));
    const session = response.cookies.find(c => c.name === "ck_session")!;
    const csrf = response.cookies.find(c => c.name === "ck_csrf")!;
    expect(session).toBeTruthy(); expect(csrf).toBeTruthy();
    const authCookie = `ck_session=${session.value}; ck_csrf=${csrf.value}`;
    const status = await app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie: authCookie } });
    expect(status.json()).toMatchObject({ authenticated: true, oidcAvailable: true });
    const blocked = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: authCookie } });
    expect(blocked.statusCode).toBe(403);
    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: authCookie, "x-csrf-token": csrf.value } });
    expect(logout.statusCode).toBe(200);
    const replay = await app.inject({ method: "GET", url: callback, headers: { cookie } });
    expect(replay.statusCode).toBe(400);
    expect(oidc.authorizationCodeGrant).toHaveBeenCalledTimes(1);
  });
  it("refuses another authenticated identity", async () => {
    ownerResponse("another-subject");
    const { app, cookie, callback } = await fixture();
    const response = await app.inject({ method: "GET", url: callback, headers: { cookie } });
    expect(response.statusCode).toBe(403);
    expect(response.cookies.some(c => c.name === "ck_session")).toBe(false);
  });
  it("refuses missing or wrong browser binding before exchanging codes", async () => {
    const { app, callback } = await fixture();
    for (const cookie of [undefined, "__Host-ck_oidc=wrong"]) {
      const response = await app.inject({ method: "GET", url: callback, headers: cookie ? { cookie } : {} });
      expect(response.statusCode).toBe(400);
    }
    expect(oidc.authorizationCodeGrant).not.toHaveBeenCalled();
  });
  it("refuses expired flow even with its original cookie", async () => {
    const { app, cookie, callback } = await fixture();
    const original = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(original + 6 * 60_000);
    try {
      const response = await app.inject({ method: "GET", url: callback, headers: { cookie } });
      expect(response.statusCode).toBe(400);
      expect(oidc.authorizationCodeGrant).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
  it("fails closed if provider rejects state, nonce, issuer or token validation", async () => {
    vi.mocked(oidc.authorizationCodeGrant).mockRejectedValue(new Error("provider validation failed"));
    const { app, cookie, callback } = await fixture();
    const response = await app.inject({ method: "GET", url: callback, headers: { cookie } });
    expect(response.statusCode).toBe(401);
    expect(response.cookies.some(c => c.name === "ck_session")).toBe(false);
    expect(response.body).not.toContain("provider validation failed");
  });
});
