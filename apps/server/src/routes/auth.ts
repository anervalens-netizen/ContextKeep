import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { LoginInput, SetupInput } from "@contextkeep/shared";
import { ownerCredentials } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import { parseWith } from "../lib/validate.js";
import { writeAudit } from "../services/audit.js";
import { hashPassword, verifyPassword } from "../services/password.js";
import {
  clearAuthCookies,
  createSession,
  destroySession,
  needsSetup,
  readSession,
  sessionAuditRef,
  setAuthCookies,
  SESSION_COOKIE,
} from "../services/session.js";

/** Public auth routes: status, first-run setup, login. Logout lives in the authed scope. */
export function registerPublicAuthRoutes(app: FastifyInstance): void {
  const { deps, config } = app.ck;

  app.get("/api/auth/status", async (request, reply) => {
    const session = readSession(deps.db, request.cookies[SESSION_COOKIE], (renewed) => setAuthCookies(reply, config, renewed));
    return { needsSetup: needsSetup(deps.db), authenticated: session !== null };
  });

  app.post(
    "/api/auth/setup",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!needsSetup(deps.db)) {
        throw new ApiError(409, "already_setup", "Owner password is already configured.");
      }
      const input = parseWith(SetupInput, request.body, "setup payload");
      const pepper = config.secretIsEphemeral ? "" : config.sessionSecret;
      const now = nowIso();
      deps.db
        .insert(ownerCredentials)
        .values({ id: 1, passwordHash: hashPassword(input.password, pepper), createdAt: now, updatedAt: now })
        .run();
      const session = createSession(deps.db);
      setAuthCookies(reply, config, session);
      writeAudit(deps.db, {
        actor: "owner",
        action: "auth.setup",
        targetType: "owner_credentials",
        targetId: "1",
        after: { createdAt: now },
        requestId: request.id,
      });
      return { ok: true, csrfToken: session.csrfToken };
    },
  );

  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const cred = deps.db.select().from(ownerCredentials).get();
      if (!cred) {
        throw new ApiError(409, "setup_required", "Run first-time password setup before logging in.");
      }
      const input = parseWith(LoginInput, request.body, "login payload");
      const pepper = config.secretIsEphemeral ? "" : config.sessionSecret;
      if (!verifyPassword(input.password, cred.passwordHash, pepper)) {
        throw new ApiError(401, "invalid_credentials", "Wrong password.");
      }
      const session = createSession(deps.db);
      setAuthCookies(reply, config, session);
      writeAudit(deps.db, {
        actor: "owner",
        action: "auth.login",
        targetType: "session",
        targetId: sessionAuditRef(session.id),
        after: { createdAt: session.createdAt },
        requestId: request.id,
      });
      return { ok: true, csrfToken: session.csrfToken };
    },
  );

  // Health probe (public, tiny).
  app.get("/healthz", async () => ({ ok: true, version: app.ck.appVersion }));
}

/** Logout (requires a session). */
export function registerLogoutRoute(app: FastifyInstance): void {
  const { deps, config } = app.ck;
  app.post("/api/auth/logout", async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (sessionId) {
      const auditRef = sessionAuditRef(sessionId);
      destroySession(deps.db, sessionId);
      writeAudit(deps.db, {
        actor: "owner",
        action: "auth.logout",
        targetType: "session",
        targetId: auditRef,
        before: { active: true },
        after: { active: false },
        requestId: request.id,
      });
    }
    clearAuthCookies(reply, config);
    return { ok: true };
  });
}

export { newId, eq };
