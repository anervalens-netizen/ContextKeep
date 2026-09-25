import { describe, expect, it } from "vitest";
import { auditEvents } from "../src/db/schema.js";
import { nowIso } from "../src/lib/time.js";
import { buildJsonDump } from "../src/services/export.js";
import { makeTestApp } from "./helpers.js";

describe("audit credential safety", () => {
  it("never persists the bearer session id in new auth audit events", async () => {
    const t = await makeTestApp();
    try {
      const sessionId = /(?:^|; )ck_session=([^;]+)/.exec(t.cookie)?.[1];
      expect(sessionId).toBeTruthy();

      const loginEvent = t.app.ck.deps.db
        .select()
        .from(auditEvents)
        .all()
        .find((event) => event.action === "auth.login");
      expect(loginEvent).toBeDefined();
      expect(loginEvent!.targetType).toBe("session");
      expect(loginEvent!.targetId).toMatch(/^session-sha256:[0-9a-f]{64}$/);
      expect(loginEvent!.targetId).not.toBe(sessionId);
      expect(JSON.stringify(loginEvent)).not.toContain(sessionId!);

      const logout = await t.post("/api/auth/logout");
      expect(logout.statusCode).toBe(200);
      const logoutEvent = t.app.ck.deps.db
        .select()
        .from(auditEvents)
        .all()
        .find((event) => event.action === "auth.logout");
      expect(logoutEvent).toBeDefined();
      expect(logoutEvent!.targetId).toMatch(/^session-sha256:[0-9a-f]{64}$/);
      expect(logoutEvent!.targetId).not.toBe(sessionId);
      expect(JSON.stringify(logoutEvent)).not.toContain(sessionId!);
    } finally {
      await t.cleanup();
    }
  });

  it("redacts legacy raw session credentials from JSON dumps", async () => {
    const t = await makeTestApp();
    try {
      const legacySessionId = ["legacy", "session", "credential", "marker"].join("-");
      const legacyCsrf = ["legacy", "csrf", "marker"].join("-");
      t.app.ck.deps.db
        .insert(auditEvents)
        .values({
          id: "legacy-session-audit-fixture",
          actor: "owner",
          action: "auth.logout",
          targetType: "session",
          targetId: legacySessionId,
          timestamp: nowIso(),
          beforeRef: JSON.stringify({ id: legacySessionId, csrfToken: legacyCsrf, active: true }),
          afterRef: JSON.stringify({ active: false }),
          detailJson: JSON.stringify({ token: legacySessionId }),
          requestId: "test-request",
        })
        .run();

      const dump = buildJsonDump(t.app.ck.deps, { actor: "test:audit-security" });
      const serialized = JSON.stringify(dump);
      expect(serialized).not.toContain(legacySessionId);
      expect(serialized).not.toContain(legacyCsrf);

      const exportedEvents = dump.auditEvents as Array<{
        id: string;
        targetId: string | null;
        beforeRef: string | null;
        detailJson: string | null;
      }>;
      const legacy = exportedEvents.find((event) => event.id === "legacy-session-audit-fixture");
      expect(legacy).toBeDefined();
      expect(legacy!.targetId).toBe("[redacted-session]");
      expect(JSON.parse(legacy!.beforeRef!)).toEqual({ id: "[redacted]", csrfToken: "[redacted]", active: true });
      expect(JSON.parse(legacy!.detailJson!)).toEqual({ token: "[redacted]" });
    } finally {
      await t.cleanup();
    }
  });
});
