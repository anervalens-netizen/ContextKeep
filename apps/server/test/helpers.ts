import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { seedDemo } from "../src/seed.js";

export interface InjectResult {
  statusCode: number;
  payload: string;
  headers: Record<string, string | string[] | undefined>;
  cookies: { name: string; value: string }[];
  json<T = unknown>(): T;
}

export interface TestApp {
  app: FastifyInstance;
  config: AppConfig;
  dataDir: string;
  cookie: string;
  csrf: string;
  get(url: string): Promise<InjectResult>;
  post(url: string, payload?: unknown): Promise<InjectResult>;
  put(url: string, payload?: unknown): Promise<InjectResult>;
  patch(url: string, payload?: unknown): Promise<InjectResult>;
  postForm(url: string, form: FormData): Promise<InjectResult>;
  /** Unauthenticated request (no cookies, no CSRF). */
  raw(method: string, url: string, payload?: unknown): Promise<InjectResult>;
  cleanup(): Promise<void>;
}

// Assembled at runtime so transcript sanitizers cannot rewrite the literal (see
// secret-safe-script-authoring skill). Test-only value, not a real credential.
export const TEST_PASSWORD = ["ck", "test", "owner", "0123456789"].join("-");

export async function makeTestApp(opts: { seed?: boolean; adapters?: string; mcpToken?: string; mcpDefaultClientId?: string; mcpDelegateWorkingMemory?: boolean; buildSha?: string } = {}): Promise<TestApp> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ck-test-"));
  const config = loadConfig(
    {
      NODE_ENV: "test",
      CK_MCP_TOKEN: opts.mcpToken,
      CK_MCP_DEFAULT_CLIENT_ID: opts.mcpDefaultClientId,
      CK_MCP_DELEGATE_WORKING_MEMORY: opts.mcpDelegateWorkingMemory ? "true" : "false",
      CK_DATA_DIR: dataDir,
      CK_BACKUP_DIR: path.join(dataDir, "..", `ck-backups-${path.basename(dataDir)}`),
      CK_SESSION_SECRET: "test-secret-0123456789abcdef",
      CK_BUILD_SHA: opts.buildSha,
      ...(opts.adapters !== undefined ? { CK_ADAPTERS: opts.adapters } : {}),
    },
    {},
  );
  const app = await buildApp({ config, logger: false });

  // First-run setup + login (single-user owner auth).
  const setupRes = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    payload: { password: TEST_PASSWORD },
  });
  if (setupRes.statusCode !== 200) {
    throw new Error(`test setup failed: ${setupRes.statusCode} ${setupRes.body}`);
  }
  const loginRes = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { password: TEST_PASSWORD },
  });
  if (loginRes.statusCode !== 200) {
    throw new Error(`test login failed: ${loginRes.statusCode} ${loginRes.body}`);
  }
  const sessionCookie = loginRes.cookies.find((c) => c.name === "ck_session");
  const csrfCookie = loginRes.cookies.find((c) => c.name === "ck_csrf");
  if (!sessionCookie || !csrfCookie) throw new Error("test login: missing cookies");
  const cookie = `ck_session=${sessionCookie.value}; ck_csrf=${csrfCookie.value}`;
  const csrf = csrfCookie.value;

  if (opts.seed) {
    seedDemo(app.ck.deps, { actor: "system:seed" });
  }

  let closed = false;
  const t: TestApp = {
    app,
    config,
    dataDir,
    cookie,
    csrf,
    get: (url) => inject(app, "GET", url, undefined, cookie, undefined) as Promise<InjectResult>,
    post: (url, payload) => inject(app, "POST", url, payload, cookie, csrf) as Promise<InjectResult>,
    put: (url, payload) => inject(app, "PUT", url, payload, cookie, csrf) as Promise<InjectResult>,
    patch: (url, payload) => inject(app, "PATCH", url, payload, cookie, csrf) as Promise<InjectResult>,
    postForm: (url, form) => inject(app, "POST", url, form, cookie, csrf) as Promise<InjectResult>,
    raw: (method, url, payload) => inject(app, method, url, payload, undefined, undefined) as Promise<InjectResult>,
    cleanup: async () => {
      if (closed) return;
      closed = true;
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(config.backupDir, { recursive: true, force: true });
    },
  };
  return t;
}

async function inject(
  app: FastifyInstance,
  method: string,
  url: string,
  payload: unknown,
  cookie: string | undefined,
  csrf: string | undefined,
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  const res = await app.inject({
    method: method as "GET",
    url,
    headers,
    payload: payload as never,
  });
  return {
    statusCode: res.statusCode,
    payload: res.payload,
    headers: res.headers as Record<string, string | string[] | undefined>,
    cookies: res.cookies.map((c) => ({ name: c.name, value: c.value })),
    json<T>(): T {
      return JSON.parse(res.payload) as T;
    },
  };
}

export interface ApiErrorBody {
  error: { code: string; message: string; details: unknown };
}

export interface ProjectSummary {
  id: string;
  name: string;
  lifecycle: string;
  lifecycleRecordId: string | null;
  revision: number;
}

export async function getProjectByName(t: TestApp, name: string): Promise<ProjectSummary> {
  const res = await t.get("/api/projects");
  expectStatus(res, 200, "list projects");
  const projects = res.json<ProjectSummary[]>();
  const found = projects.find((p) => p.name === name);
  if (!found) throw new Error(`project not found in seed: ${name} (have: ${projects.map((p) => p.name).join(", ")})`);
  return found;
}

export async function getInboxCandidates(t: TestApp, projectId?: string): Promise<Record<string, unknown>[]> {
  const url = projectId ? `/api/inbox?projectId=${encodeURIComponent(projectId)}` : "/api/inbox";
  const res = await t.get(url);
  expectStatus(res, 200, "inbox");
  return res.json<{ candidates: Record<string, unknown>[] }>().candidates;
}

/**
 * Test convenience for flows that are not exercising stale-review behavior.
 * Reads each record's current revision and submits the production revision-bound
 * review contract. Stale/legacy contract tests must call the endpoint directly.
 */
export async function reviewCurrent(
  t: TestApp,
  recordIds: string[],
  action: "accept" | "reject",
  extra: Record<string, unknown> = {},
): Promise<InjectResult> {
  const items = recordIds.map((recordId) => {
    const row = t.app.ck.handle.sqlite
      .prepare("SELECT revision FROM records WHERE id=?")
      .get(recordId) as { revision: number } | undefined;
    if (!row) throw new Error(`reviewCurrent: missing record ${recordId}`);
    return { recordId, revision: row.revision };
  });
  return t.post("/api/inbox/decide", { items, action, ...extra });
}

/** Convenience: expect a specific status and return parsed JSON. */
export function expectStatus(res: InjectResult, status: number, context = ""): void {
  if (res.statusCode !== status) {
    throw new Error(
      `Expected status ${status} ${context ? `(${context})` : ""} but got ${res.statusCode}: ${res.payload.slice(0, 600)}`,
    );
  }
}
