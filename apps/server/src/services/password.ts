import crypto from "node:crypto";

/**
 * First-run local password setup stored hashed with Node's built-in scrypt
 * (handoff M0 scope 10: argon2 or scrypt; scrypt avoids a native dependency).
 * Format: scrypt$N$r$p$saltB64$hashB64 — pepper (CK_SESSION_SECRET) is mixed
 * into the scrypt salt input when configured.
 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

export function hashPassword(password: string, pepper: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, Buffer.concat([salt, Buffer.from(pepper, "utf8")]), SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2,
  });
  return [
    "scrypt",
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

export function verifyPassword(password: string, stored: string, pepper: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const derived = crypto.scryptSync(password, Buffer.concat([salt, Buffer.from(pepper, "utf8")]), expected.length, {
    N,
    r,
    p,
    maxmem: 128 * N * r * 2,
  });
  return crypto.timingSafeEqual(derived, expected);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}
