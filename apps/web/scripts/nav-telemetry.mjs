// Match only the configured build's Sentry envelope. The caller fulfills it
// locally; matching never permits network access.
export function envelopeMatcher(dsn) {
  if (!dsn) return () => false;
  let source;
  try { source = new URL(dsn); } catch { throw new Error("Invalid navigation telemetry DSN"); }
  const parts = source.pathname.split("/").filter(Boolean);
  const project = parts.pop();
  if (!["https:", "http:"].includes(source.protocol) || !source.username || !project || source.password || source.search || source.hash)
    throw new Error("Invalid navigation telemetry DSN");
  const pathname = `/${parts.length ? `${parts.join("/")}/` : ""}api/${project}/envelope/`;
  return (request) => {
    const url = new URL(request.url());
    return request.method() === "POST" && request.resourceType() === "fetch" &&
      url.origin === source.origin && url.pathname === pathname &&
      url.searchParams.get("sentry_key") === source.username;
  };
}
