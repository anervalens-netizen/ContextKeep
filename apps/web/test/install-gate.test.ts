import { beforeEach, describe, expect, it } from "vitest";
import {
  captureInstallPrompt,
  currentInstallGate,
} from "../src/lib/install-gate.js";

describe("install gate on the default (localhost) origin", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("allows install on localhost as a trusted dev origin", () => {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    const gate = currentInstallGate();
    expect(gate.allowed).toBe(true);
  });

  it("captures and releases the beforeinstallprompt event", () => {
    let captured = 0;
    const release = captureInstallPrompt(() => {
      captured++;
    });
    window.dispatchEvent(new Event("beforeinstallprompt"));
    expect(captured).toBe(1);
    release();
    window.dispatchEvent(new Event("beforeinstallprompt"));
    expect(captured).toBe(1);
  });
});
