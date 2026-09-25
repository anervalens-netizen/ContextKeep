import { and, eq, lt } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import type { Db } from "../db/client.js";
import { ownerCredentials, sessions } from "../db/schema.js";
import { sha256 } from "../lib/hash.js";
import { nowIso } from "../lib/time.js";
import type { AppConfig } from "../config.js";
import { randomToken } from "./password.js";

export const SESSION_COOKIE = "ck_session";
export const CSRF_COOKIE = "ck_csrf";
export const SESSION_TTL_DAYS = 30;

export interface SessionRow {
  id: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

function ttlDate(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Stable, non-authoritative identifier for audit trails. Never persist the
 * bearer session id itself outside the sessions table: JSON exports include
 * audit history and must not become a second credential store.
 */
export function sessionAuditRef(sessionId: string): string {
  return `session-sha256:${sha256(`contextkeep-session-audit\u0000${sessionId}`)}`;
}

export function needsSetup(db: Db): boolean {
  return db.select().from(ownerCredentials).get() === undefined;
}

export function createSession(db: Db): SessionRow {
  const now = nowIso();
  const row: SessionRow = {
    id: randomToken(32),
    csrfToken: randomToken(32),
    createdAt: now,
    expiresAt: ttlDate(SESSION_TTL_DAYS),
    lastSeenAt: now,
  };
  db.insert(sessions).values(row).run();
  pruneExpired(db);
  return row;
}

export function readSession(
  db: Db,
  sessionId: string | undefined,
  onRenew: (session: SessionRow) => void,
): SessionRow | null {
  if (!sessionId) return null;
  const row = db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (!row) return null;
  if (row.expiresAt <= nowIso()) {
    db.delete(sessions).where(eq(sessions.id, row.id)).run();
    return null;
  }
  // Sliding expiry: refresh when past half the TTL.
  const halfLife = Date.now() + (SESSION_TTL_DAYS / 2) * 24 * 60 * 60 * 1000;
  if (new Date(row.expiresAt).getTime() < halfLife) {
    const expiresAt = ttlDate(SESSION_TTL_DAYS);
    const lastSeenAt = nowIso();
    db.update(sessions)
      .set({ expiresAt, lastSeenAt })
      .where(eq(sessions.id, row.id))
      .run();
    row.expiresAt = expiresAt;
    row.lastSeenAt = lastSeenAt;
    // Mandatory callback keeps every HTTP caller's cookie in step with SQLite.
    onRenew(row);
  }
  return row;
}

export function destroySession(db: Db, sessionId: string): void {
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

function pruneExpired(db: Db): void {
  db.delete(sessions)
    .where(and(lt(sessions.expiresAt, nowIso())))
    .run();
}

export function setAuthCookies(
  reply: FastifyReply,
  config: AppConfig,
  session: SessionRow,
): void {
  const base = {
    path: "/",
    sameSite: "lax" as const,
    secure: config.cookieSecure,
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  };
  reply.setCookie(SESSION_COOKIE, session.id, { ...base, httpOnly: true });
  // CSRF cookie must be readable by the PWA shell (double-submit pattern).
  reply.setCookie(CSRF_COOKIE, session.csrfToken, { ...base, httpOnly: false });
}

export function clearAuthCookies(reply: FastifyReply, config: AppConfig): void {
  const base = {
    path: "/",
    sameSite: "lax" as const,
    secure: config.cookieSecure,
    maxAge: 0,
  };
  reply.clearCookie(SESSION_COOKIE, base);
  reply.clearCookie(CSRF_COOKIE, base);
}
