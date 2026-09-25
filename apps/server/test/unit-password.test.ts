import { describe, expect, it } from "vitest";
import { hashPassword, randomToken, verifyPassword } from "../src/services/password.js";

describe("password hashing (M0 scope 10: scrypt)", () => {
  const pepper = "test-pepper";

  it("round-trips a correct password", () => {
    const stored = hashPassword("correct horse battery staple", pepper);
    expect(stored.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(verifyPassword("correct horse battery staple", stored, pepper)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const stored = hashPassword("correct horse battery staple", pepper);
    expect(verifyPassword("wrong password", stored, pepper)).toBe(false);
  });

  it("rejects when the pepper differs", () => {
    const stored = hashPassword("correct horse battery staple", pepper);
    expect(verifyPassword("correct horse battery staple", stored, "other-pepper")).toBe(false);
  });

  it("salts: two hashes of the same password differ", () => {
    const a = hashPassword("same-password", pepper);
    const b = hashPassword("same-password", pepper);
    expect(a).not.toBe(b);
    expect(verifyPassword("same-password", a, pepper)).toBe(true);
    expect(verifyPassword("same-password", b, pepper)).toBe(true);
  });

  it("rejects malformed stored values", () => {
    expect(verifyPassword("x", "garbage", pepper)).toBe(false);
    expect(verifyPassword("x", "scrypt$1$2$3", pepper)).toBe(false);
  });

  it("randomToken produces unique hex tokens", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
