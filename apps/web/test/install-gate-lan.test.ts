/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "http://192.168.0.68:3082/inbox"}
 */
import { describe, expect, it } from "vitest";
import { currentInstallGate } from "../src/lib/install-gate.js";

describe("A16: install refused when the API origin is not HTTPS", () => {
  it("blocks install on a plain-HTTP LAN origin and explains why", () => {
    const gate = currentInstallGate();
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/HTTPS/);
    expect(gate.reason).toMatch(/192\.168\.0\.68/);
    expect(gate.reason).toMatch(/reverse proxy|TLS/i);
  });
});
