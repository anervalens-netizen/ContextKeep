import type { FastifyInstance } from "fastify";
import * as oidc from "openid-client";
import { ApiError } from "../lib/errors.js";
import { writeAudit } from "../services/audit.js";
import { createSession, needsSetup, sessionAuditRef, setAuthCookies } from "../services/session.js";

const FLOW_COOKIE = "__Host-ck_oidc";
const FLOW_TTL_MS = 5 * 60_000;
const MAX_PENDING = 1000;

/** Optional single-owner OIDC. Provider tokens never reach the frontend or database. */
export function registerOidcRoutes(app: FastifyInstance): void {
  const { config, deps } = app.ck;
  const settings = config.oidc;
  if (!settings) return;
  const pending = new Map<string, { state: string; nonce: string; verifier: string; expires: number }>();
  let discovery: Promise<oidc.Configuration> | undefined;
  const provider = () => discovery ??= oidc.discovery(new URL(settings.issuer), settings.clientId,
    settings.clientSecret, undefined, { timeout: 10 }).then((client) => {
      oidc.enableNonRepudiationChecks(client);
      return client;
    }).catch((error: unknown) => { discovery = undefined; throw error; });
  const cookieOptions = { path: "/", secure: true, httpOnly: true, sameSite: "lax" as const };
  app.addHook("onClose", async () => { pending.clear(); });

  app.get("/api/auth/oidc/start", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (needsSetup(deps.db)) throw new ApiError(409, "setup_required", "Configure the local owner before enabling single sign-on.");
    for (const [key, flow] of pending) if (flow.expires <= Date.now()) pending.delete(key);
    if (pending.size >= MAX_PENDING) throw new ApiError(503, "oidc_busy", "Try single sign-on again later.");
    try {
      const client = await provider();
      const verifier = oidc.randomPKCECodeVerifier();
      const flow = { state: oidc.randomState(), nonce: oidc.randomNonce(), verifier, expires: Date.now() + FLOW_TTL_MS };
      const binding = oidc.randomState();
      const url = oidc.buildAuthorizationUrl(client, { redirect_uri: settings.callbackUrl, scope: "openid",
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256",
        state: flow.state, nonce: flow.nonce });
      // A new attempt supersedes only this browser's previous attempt.
      if (request.cookies[FLOW_COOKIE]) pending.delete(request.cookies[FLOW_COOKIE]);
      pending.set(binding, flow);
      reply.setCookie(FLOW_COOKIE, binding, { ...cookieOptions, maxAge: FLOW_TTL_MS / 1000 });
      return reply.redirect(url.href);
    } catch {
      throw new ApiError(503, "oidc_unavailable", "Single sign-on is unavailable. Use the owner password or try again later.");
    }
  });

  app.get("/api/auth/oidc/callback", { logLevel: "warn" }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    const binding = request.cookies[FLOW_COOKIE];
    const flow = binding ? pending.get(binding) : undefined;
    if (binding) pending.delete(binding); // consume before async exchange; retries cannot replay
    reply.clearCookie(FLOW_COOKIE, cookieOptions);
    if (!flow || flow.expires <= Date.now() || needsSetup(deps.db)) {
      throw new ApiError(400, "oidc_flow_expired", "Start single sign-on again in this browser.");
    }
    let subject: string | undefined;
    try {
      // Never trust Host or forwarded headers to construct the redirect URI.
      const callback = new URL(settings.callbackUrl);
      callback.search = new URL(request.raw.url ?? "", settings.callbackUrl).search;
      const tokens = await oidc.authorizationCodeGrant(await provider(), callback, {
        pkceCodeVerifier: flow.verifier, expectedState: flow.state,
        expectedNonce: flow.nonce, idTokenExpected: true,
      });
      subject = tokens.claims()?.sub;
    } catch {
      throw new ApiError(401, "oidc_invalid_response", "Single sign-on could not be verified. Start again.");
    }
    if (subject !== settings.ownerSubject) {
      throw new ApiError(403, "oidc_not_owner", "This identity is not the configured ContextKeep owner.");
    }
    const session = createSession(deps.db);
    setAuthCookies(reply, config, session);
    writeAudit(deps.db, { actor: "owner", action: "auth.login", targetType: "session",
      targetId: sessionAuditRef(session.id), after: { method: "oidc", createdAt: session.createdAt }, requestId: request.id });
    return reply.redirect(settings.returnUrl);
  });
}
