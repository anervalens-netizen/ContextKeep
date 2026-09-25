import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Absolute root of the apps/server package, regardless of cwd. */
export const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const emptyToUndef = (v: unknown): unknown => (v === "" ? undefined : v);

const EnvSchema = z.object({
  CK_SQLITE_SYNCHRONOUS: z.enum(["NORMAL", "FULL"]).optional(),
  CK_DATA_DIR: z.string().min(1).default("./data"),
  CK_PORT: z.coerce.number().int().min(1).max(65535).default(3082),
  CK_HOST: z.string().min(1).default("127.0.0.1"),
  CK_MCP_TOKEN: z.preprocess(emptyToUndef, z.string().min(32).max(256).optional()),
  CK_MCP_DEFAULT_CLIENT_ID: z.preprocess(emptyToUndef, z.string().trim().min(1).max(80).optional()),
  CK_MCP_DELEGATE_WORKING_MEMORY: z.enum(["true", "false"]).default("false"),
  CK_SESSION_SECRET: z.preprocess(emptyToUndef, z.string().min(8).optional()),
  CK_BUILD_SHA: z.preprocess(emptyToUndef, z.string().regex(/^[0-9a-fA-F]{7,64}$/).optional()),
  CK_COOKIE_SECURE: z.enum(["true", "false"]).default("true"),
  CK_BACKUP_DIR: z.string().min(1).default("./backups"),
  CK_BACKUP_KEEP: z.coerce.number().int().min(1).max(1000).default(14),
  CK_ADAPTERS: z.string().default("manual,faketest"),
  /** Comma-separated roots scanned only when the owner explicitly requests workspace discovery. */
  CK_WORKSPACE_ROOTS: z.string().default(""),
  CK_WORKSPACE_SCAN_MAX_DEPTH: z.coerce.number().int().min(0).max(12).default(6),
  /** Optional GitHub login used only for evidence-based reconciliation suggestions. */
  CK_WORKSPACE_GITHUB_OWNER: z.preprocess(
    emptyToUndef,
    z.string().regex(/^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/, "invalid GitHub owner login").optional(),
  ),
  /** Optional override for the local Codex store. Defaults to ~/.codex for the service user. */
  CK_CODEX_HOME: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  /** Optional override for the local DSH store. Defaults to ~/.dsh for the service user. */
  CK_DSH_HOME: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  /** M3.4 sync defaults. Interval 0 means disabled. */
  CK_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(60 * 24 * 30).default(0),
  CK_SYNC_IDLE_MINUTES: z.coerce.number().int().min(1).max(60 * 24 * 30).default(30),
  CK_SYNC_MAX_ARTIFACTS: z.coerce.number().int().min(1).max(500).default(25),
  CK_SYNC_MAX_CHARS: z.coerce.number().int().min(1).max(50_000_000).default(1_000_000),
  CK_SYNC_MAX_COST_USD: z.coerce.number().min(0).max(1000).default(0.25),
  CK_SYNC_EXTRACTION_ADAPTER: z.string().min(1).max(64).default("deepseek"),
  CK_SYNC_ALLOW_UNASSIGNED_ARCHIVE: z.enum(["true", "false"]).default("false"),
  /** L5.4: periodic safe memory housekeeping. Zero disables the timer. */
  CK_HOUSEKEEPING_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(60 * 24 * 30).default(0),
  CK_HOUSEKEEPING_PROPOSAL_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  /** Provider cost ceiling per import, in USD (handoff §12 item 13, §16 item 5). */
  CK_COST_CEILING_USD: z.coerce.number().min(0).max(1000).default(0.05),
  /** A11: review interval for volatile facts in days (handoff §12 item 15, §16 item 6).
   * Default 7 days. This is a reminder policy, NOT a claim that the fact becomes false on
   * day N+1 — the owner decides. */
  CK_VOLATILE_REVIEW_INTERVAL_DAYS: z.coerce.number().int().min(1).max(3650).default(7),
  CK_OTLP_ENDPOINT: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  CK_WEB_DIST: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  CK_SEED_ON_START: z.enum(["", "demo"]).default(""),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export interface AppConfig {
  sqliteSynchronous: "NORMAL" | "FULL";
  dataDir: string;
  dbPath: string;
  port: number;
  host: string;
  sessionSecret: string;
  /** Private MCP transport credential; independent from owner web login. */
  mcpToken: string | undefined;
  /** Optional stable identity for this configured MCP/tunnel client. */
  mcpDefaultClientId: string | null;
  /** Allows proposal-only working-memory capture without per-write owner confirmation. */
  mcpDelegateWorkingMemory: boolean;
  /** true when no CK_SESSION_SECRET was provided (ephemeral random secret, dev/test only). */
  secretIsEphemeral: boolean;
  /** Exact deployed Git commit when provided by the release environment. */
  buildSha: string | null;
  cookieSecure: boolean;
  backupDir: string;
  backupKeep: number;
  adapters: string[];
  /** Filesystem roots inspected by the explicit owner workspace scan. */
  workspaceRoots: string[];
  /** Maximum directory depth below each configured workspace root. */
  workspaceScanMaxDepth: number;
  /** Optional GitHub account identity used only to label reconciliation suggestions. */
  workspaceGithubOwner: string | null;
  /** Local Codex state root. Connector code reads only explicit safe subpaths beneath it. */
  codexHome: string;
  /** Local DSH state root. Connector code reads only explicit safe subpaths beneath it. */
  dshHome: string;
  /** M3.4 built-in sync timer. Zero disables scheduled sync. */
  syncIntervalMinutes: number;
  /** Current sessions must be idle at least this long before automatic eligibility. */
  syncIdleMinutes: number;
  syncMaxArtifacts: number;
  syncMaxChars: number;
  syncMaxCostUsd: number;
  syncExtractionAdapter: string;
  syncAllowUnassignedArchive: boolean;
  /** Periodic recoverable archival of old non-owner proposals; zero disables scheduling. */
  housekeepingIntervalMinutes: number;
  housekeepingProposalRetentionDays: number;
  /** Per-import provider cost ceiling, in USD. Imports over this are refused. */
  costCeilingUsd: number;
  /** A11: review interval for volatile facts in days. */
  volatileReviewIntervalDays: number;
  otlpEndpoint: string | undefined;
  webDist: string | undefined;
  seedOnStart: boolean;
  env: "development" | "test" | "production";
}

function resolveFrom(base: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

export function loadConfig(
  rawEnv: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  overrides: Partial<AppConfig> = {},
): AppConfig {
  const parsed = EnvSchema.parse(rawEnv);
  const dataDir = resolveFrom(serverRoot, parsed.CK_DATA_DIR);
  const backupDir = resolveFrom(serverRoot, parsed.CK_BACKUP_DIR);
  const secretIsEphemeral = !parsed.CK_SESSION_SECRET;
  if (parsed.NODE_ENV === "production" && secretIsEphemeral) {
    throw new Error("CK_SESSION_SECRET is required when NODE_ENV=production.");
  }
  const sessionSecret = parsed.CK_SESSION_SECRET ?? crypto.randomBytes(32).toString("hex");
  if (parsed.CK_MCP_DELEGATE_WORKING_MEMORY === "true" && !parsed.CK_MCP_DEFAULT_CLIENT_ID) {
    throw new Error("CK_MCP_DEFAULT_CLIENT_ID is required when CK_MCP_DELEGATE_WORKING_MEMORY=true.");
  }
  const base: AppConfig = {
    sqliteSynchronous: parsed.CK_SQLITE_SYNCHRONOUS ?? (parsed.NODE_ENV === "production" ? "FULL" : "NORMAL"),
    dataDir,
    dbPath: path.join(dataDir, "store.sqlite"),
    port: parsed.CK_PORT,
    host: parsed.CK_HOST,
    sessionSecret,
    mcpToken: parsed.CK_MCP_TOKEN,
    mcpDefaultClientId: parsed.CK_MCP_DEFAULT_CLIENT_ID ?? null,
    mcpDelegateWorkingMemory: parsed.CK_MCP_DELEGATE_WORKING_MEMORY === "true",
    secretIsEphemeral,
    buildSha: parsed.CK_BUILD_SHA?.toLowerCase() ?? null,
    cookieSecure: parsed.CK_COOKIE_SECURE === "true",
    backupDir,
    backupKeep: parsed.CK_BACKUP_KEEP,
    adapters: parsed.CK_ADAPTERS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    workspaceRoots: parsed.CK_WORKSPACE_ROOTS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => resolveFrom(serverRoot, p)),
    workspaceScanMaxDepth: parsed.CK_WORKSPACE_SCAN_MAX_DEPTH,
    workspaceGithubOwner: parsed.CK_WORKSPACE_GITHUB_OWNER?.toLowerCase() ?? null,
    codexHome: parsed.CK_CODEX_HOME ? resolveFrom(serverRoot, parsed.CK_CODEX_HOME) : path.join(os.homedir(), ".codex"),
    dshHome: parsed.CK_DSH_HOME ? resolveFrom(serverRoot, parsed.CK_DSH_HOME) : path.join(os.homedir(), ".dsh"),
    syncIntervalMinutes: parsed.CK_SYNC_INTERVAL_MINUTES,
    syncIdleMinutes: parsed.CK_SYNC_IDLE_MINUTES,
    syncMaxArtifacts: parsed.CK_SYNC_MAX_ARTIFACTS,
    syncMaxChars: parsed.CK_SYNC_MAX_CHARS,
    syncMaxCostUsd: parsed.CK_SYNC_MAX_COST_USD,
    syncExtractionAdapter: parsed.CK_SYNC_EXTRACTION_ADAPTER,
    syncAllowUnassignedArchive: parsed.CK_SYNC_ALLOW_UNASSIGNED_ARCHIVE === "true",
    housekeepingIntervalMinutes: parsed.CK_HOUSEKEEPING_INTERVAL_MINUTES,
    housekeepingProposalRetentionDays: parsed.CK_HOUSEKEEPING_PROPOSAL_RETENTION_DAYS,
    costCeilingUsd: parsed.CK_COST_CEILING_USD,
    volatileReviewIntervalDays: parsed.CK_VOLATILE_REVIEW_INTERVAL_DAYS,
    otlpEndpoint: parsed.CK_OTLP_ENDPOINT,
    webDist: parsed.CK_WEB_DIST ? resolveFrom(serverRoot, parsed.CK_WEB_DIST) : undefined,
    seedOnStart: parsed.CK_SEED_ON_START === "demo",
    env: parsed.NODE_ENV,
  };
  return { ...base, ...overrides };
}
