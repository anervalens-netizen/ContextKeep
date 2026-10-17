/** Bounded client categories aid unauthorized-poll diagnosis without logging headers or identities. */
export function requestLogFields(req: { id?: string; method?: string; url?: string; headers?: Record<string, unknown> }) {
  const headers = req.headers ?? {};
  const agent = typeof headers["user-agent"] === "string" ? headers["user-agent"].slice(0, 512).toLowerCase() : "";
  const clientKind = agent.includes("mozilla/") ? "browser"
    : agent.startsWith("curl/") ? "curl"
    : agent.startsWith("python") ? "python"
    : agent === "node" || agent.startsWith("undici") ? "node"
    : /^(kube-probe|prometheus|uptime)/.test(agent) ? "probe" : "unknown";
  return { id: req.id, method: req.method, url: req.url?.split("?")[0],
    clientKind, hasAuthorization: Boolean(headers.authorization), hasCookie: Boolean(headers.cookie) };
}
