import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";
const apps: TestApp[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.cleanup();
});
async function fixture() {
  const t = await makeTestApp();
  apps.push(t);
  const id = t.cookie.split(";")[0]!.split("=")[1]!;
  const expiry = () =>
    (
      t.app.ck.handle.sqlite
        .prepare("SELECT expires_at FROM sessions WHERE id=?")
        .get(id) as { expires_at: string } | undefined
    )?.expires_at;
  const setExpiry = (time: number) =>
    t.app.ck.handle.sqlite
      .prepare("UPDATE sessions SET expires_at=? WHERE id=?")
      .run(new Date(time).toISOString(), id);
  return { t, id, expiry, setExpiry };
}
function cookies(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
describe("A03 sliding expiry renews browser and server together", () => {
  it.each(["/api/auth/status", "/api/projects"])(
    "renews cookies on %s exactly when the database expiry changes",
    async (url) => {
      const f = await fixture();
      f.setExpiry(Date.now() + 86400000);
      const before = f.expiry();
      const response = await f.t.get(url);
      expect(response.statusCode).toBe(200);
      expect(f.expiry()).not.toBe(before);
      const headers = cookies(response.headers["set-cookie"]);
      const session = headers.find((v) => v.startsWith("ck_session="));
      const csrf = headers.find((v) => v.startsWith("ck_csrf="));
      expect(session).toContain(f.id);
      expect(session).toMatch(/HttpOnly/);
      expect(session).toMatch(/SameSite=Lax/);
      expect(session).toMatch(/Secure/);
      expect(session).toMatch(/Max-Age=2592000/);
      expect(csrf).toContain(f.t.csrf);
      expect(csrf).not.toMatch(/HttpOnly/);
      expect(csrf).toMatch(/SameSite=Lax/);
      expect(csrf).toMatch(/Secure/);
      const renewed = f.expiry();
      const second = await f.t.get(url);
      expect(second.headers["set-cookie"]).toBeUndefined();
      expect(f.expiry()).toBe(renewed);
    },
  );
  it("does not renew fresh, missing, invalid or expired sessions", async () => {
    const f = await fixture();
    const before = f.expiry();
    expect(
      (await f.t.get("/api/projects")).headers["set-cookie"],
    ).toBeUndefined();
    expect(f.expiry()).toBe(before);
    expect(
      (await f.t.raw("GET", "/api/auth/status")).headers["set-cookie"],
    ).toBeUndefined();
    const invalid = await f.t.app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { cookie: "ck_session=invalid" },
    });
    expect(invalid.headers["set-cookie"]).toBeUndefined();
    expect(invalid.json().authenticated).toBe(false);
    f.setExpiry(Date.now() - 1);
    const expired = await f.t.get("/api/auth/status");
    expect(expired.json<{ authenticated: boolean }>().authenticated).toBe(
      false,
    );
    expect(expired.headers["set-cookie"]).toBeUndefined();
    expect(f.expiry()).toBeUndefined();
  });
  it("logout ends a near-expiry session rather than leaving the renewed cookie active", async () => {
    const f = await fixture();
    f.setExpiry(Date.now() + 86400000);
    const result = await f.t.post("/api/auth/logout");
    expect(result.statusCode).toBe(200);
    const headers = cookies(result.headers["set-cookie"]);
    expect(headers).toHaveLength(2);
    expect(headers.every((v) => /Max-Age=0/.test(v))).toBe(true);
    expect(f.expiry()).toBeUndefined();
    expect((await f.t.get("/api/projects")).statusCode).toBe(401);
  });
});
