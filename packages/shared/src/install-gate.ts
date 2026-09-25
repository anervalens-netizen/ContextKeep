/**
 * Client-side install gate (A16) — pure logic, unit-testable, NO zod dependency
 * (kept in its own module + package subpath so the web bundle never pulls the
 * schema runtime just for this function).
 */
export function evaluateInstallGate(info: {
  protocol: string;
  hostname: string;
  isSecureContext: boolean;
}): { allowed: boolean; reason: string } {
  const { protocol, hostname, isSecureContext } = info;
  const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  if (protocol === "https:") {
    return { allowed: true, reason: "API origin is HTTPS." };
  }
  if (local && isSecureContext) {
    return {
      allowed: true,
      reason: "Localhost is a trusted origin for development; install allowed.",
    };
  }
  return {
    allowed: false,
    reason:
      "Install blocked: ContextKeep requires the API origin to be reachable over HTTPS " +
      `(current origin is ${protocol}//${hostname}). Serve the app through the owner's ` +
      "TLS-terminating reverse proxy, then retry. Local development on http://localhost is exempt.",
  };
}
