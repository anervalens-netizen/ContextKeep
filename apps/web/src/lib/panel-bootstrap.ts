import { PanelPreferences } from "@contextkeep/shared";
const READ_TOOLS = new Set([
  "list_projects",
  "list_tasks",
  "get_task",
  "get_project_dossier",
  "get_portfolio",
  "get_operational_timeline",
]);
function key(name: string, args: Record<string, unknown>) {
  return (
    name +
    ":" +
    JSON.stringify(
      Object.fromEntries(
        Object.entries(args).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
  );
}
/** Bootstrap data is consumed once; refreshes always go back to the server. */
export class PanelBootstrap {
  private generation = 0;
  private entries = new Map<string, unknown>();
  private observedAt = 0;
  private inFlight = new Map<string, Promise<Record<string, unknown>>>();
  preferences: PanelPreferences | undefined;
  selectedProject: { id: string; name: string } | undefined;
  prime(value: unknown, now = Date.now()) {
    ++this.generation;
    this.inFlight.clear();
    this.entries.clear();
    this.selectedProject = undefined;
    this.preferences = undefined;
    this.observedAt = 0;
    if (!value || typeof value !== "object") return;
    const body = value as {
      version?: unknown;
      observedAt?: unknown;
      reads?: unknown;
      selectedProject?: unknown;
      preferences?: unknown;
    };
    const time =
      typeof body.observedAt === "string" ? Date.parse(body.observedAt) : NaN;
    if (
      body.version !== 1 ||
      !Number.isFinite(time) ||
      time > now + 5000 ||
      now - time > 30000 ||
      !Array.isArray(body.reads) ||
      body.reads.length > 8
    )
      return;
    this.observedAt = time;
    const prefs = PanelPreferences.safeParse(body.preferences);
    if (prefs.success) this.preferences = prefs.data;
    const p = body.selectedProject as
      { id?: unknown; name?: unknown } | undefined;
    if (p && typeof p.id === "string" && typeof p.name === "string")
      this.selectedProject = { id: p.id, name: p.name };
    for (const entry of body.reads) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as {
        tool?: unknown;
        arguments?: unknown;
        value?: unknown;
      };
      if (
        typeof e.tool === "string" &&
        READ_TOOLS.has(e.tool) &&
        e.arguments &&
        typeof e.arguments === "object" &&
        !Array.isArray(e.arguments) &&
        e.value &&
        typeof e.value === "object" &&
        !Array.isArray(e.value)
      )
        this.entries.set(
          key(e.tool, e.arguments as Record<string, unknown>),
          e.value,
        );
    }
  }
  async loadPreferences(fetcher: () => Promise<{ values?: unknown }>) {
    const epoch = this.generation;
    const result = await fetcher();
    if (epoch !== this.generation) return false;
    this.preferences = PanelPreferences.parse(result.values);
    return true;
  }
  async read(
    name: string,
    args: Record<string, unknown>,
    fetcher: () => Promise<Record<string, unknown>>,
    now = Date.now(),
  ) {
    const k = key(name, args);
    const active = this.inFlight.get(k);
    if (active) return active;
    let pending: Promise<Record<string, unknown>>;
    if (now - this.observedAt <= 30000 && this.entries.has(k)) {
      const value = this.entries.get(k);
      this.entries.delete(k);
      pending = Promise.resolve(value as Record<string, unknown>);
    } else pending = fetcher();
    this.inFlight.set(k, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(k) === pending) this.inFlight.delete(k);
    }
  }
}
