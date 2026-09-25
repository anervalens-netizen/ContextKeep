import { describe, expect, it } from "vitest";
import { evaluateInstallGate, APP_SCHEMA_VERSION } from "../src/index.js";

describe("evaluateInstallGate (A16)", () => {
  it("allows https origins", () => {
    const r = evaluateInstallGate({
      protocol: "https:",
      hostname: "ck.example.com",
      isSecureContext: true,
    });
    expect(r.allowed).toBe(true);
  });

  it("allows localhost dev origin in a secure context", () => {
    const r = evaluateInstallGate({
      protocol: "http:",
      hostname: "localhost",
      isSecureContext: true,
    });
    expect(r.allowed).toBe(true);
  });

  it("refuses plain-HTTP LAN origins with a clear reason", () => {
    const r = evaluateInstallGate({
      protocol: "http:",
      hostname: "192.168.0.68",
      isSecureContext: false,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/HTTPS/);
    expect(r.reason).toMatch(/192\.168\.0\.68/);
  });

  it("refuses non-secure context even on localhost", () => {
    const r = evaluateInstallGate({
      protocol: "http:",
      hostname: "localhost",
      isSecureContext: false,
    });
    expect(r.allowed).toBe(false);
  });
});

describe("schema version", () => {
  it("is a positive integer", () => {
    expect(Number.isInteger(APP_SCHEMA_VERSION)).toBe(true);
    expect(APP_SCHEMA_VERSION).toBeGreaterThan(0);
  });
});
