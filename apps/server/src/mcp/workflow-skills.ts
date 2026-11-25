import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { ProtocolError, type Server } from "@modelcontextprotocol/server";
import {
  skillEntry,
  SKILLS_EXTENSION_ID,
  type Skill,
} from "@modelcontextprotocol/server/ext/skills";
import { z } from "zod";

export const WORKFLOW_SKILLS_EXTENSION = SKILLS_EXTENSION_ID;
export const WORKFLOW_SKILLS_CAPABILITIES = { [SKILLS_EXTENSION_ID]: {} };
const BASE_URI = "skill://contextkeep/";
const CACHE = { ttlMs: 300_000, cacheScope: "private" as const };
const DEFAULT_ROOT = path.resolve(
  import.meta.dirname,
  "../../../../plugins/contextkeep-workflows/skills",
);
const MAX_FILES = 128;
const MAX_BYTES = 512 * 1024;

type ResourceContent =
  | { uri: string; mimeType: string; text: string }
  | { uri: string; mimeType: string; blob: string };
export interface WorkflowSkillCatalog {
  entries: readonly Skill[];
  read(uri: string): ResourceContent | undefined;
}

function mimeType(name: string): string {
  switch (path.extname(name).toLowerCase()) {
    case ".md":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    case ".txt":
    case ".py":
    case ".js":
    case ".ts":
    case ".sh":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

/** Build one immutable release snapshot. The official SDK parses frontmatter and
 * calculates manifests; the bytes retained here are exactly those it hashes.
 * Only the bundled procedures are read, never project memory or host paths.
 */
export async function loadWorkflowSkillCatalog(
  root = DEFAULT_ROOT,
): Promise<WorkflowSkillCatalog> {
  const entries: Skill[] = [];
  const resources = new Map<string, ResourceContent>();
  let totalFiles = 0;
  let totalBytes = 0;
  async function walk(
    directory: string,
    relative: string,
    files: Record<string, Uint8Array>,
    depth = 0,
  ): Promise<void> {
    if (depth > 12) throw new Error("Workflow skill directory depth exceeded.");
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (
        !/^[A-Za-z0-9_.-]+$/.test(child.name) ||
        child.name === "." ||
        child.name === ".."
      )
        throw new Error("Invalid workflow skill path.");
      const item = relative ? `${relative}/${child.name}` : child.name;
      const full = path.join(directory, child.name);
      if (child.isDirectory()) {
        await walk(full, item, files, depth + 1);
        continue;
      }
      if (!child.isFile())
        throw new Error(
          "Workflow skills cannot contain symbolic links or special files.",
        );
      const handle = await fs.open(
        full,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          ++totalFiles > MAX_FILES ||
          stat.size > MAX_BYTES - totalBytes
        )
          throw new Error("Workflow skill publication limit exceeded.");
        const bytes = await handle.readFile();
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_BYTES)
          throw new Error("Workflow skill publication limit exceeded.");
        files[item] = bytes;
      } finally {
        await handle.close();
      }
    }
  }
  const folders = await fs.readdir(root, { withFileTypes: true });
  folders.sort((a, b) => a.name.localeCompare(b.name));
  for (const folder of folders) {
    if (
      !folder.isDirectory() ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(folder.name)
    )
      throw new Error(
        "Workflow skill root must contain only named skill directories.",
      );
    const files: Record<string, Uint8Array> = Object.create(null);
    await walk(path.join(root, folder.name), "", files);
    const entry = await skillEntry(folder.name, files, { baseUri: BASE_URI });
    for (const [relative, bytes] of Object.entries(files)) {
      const uri =
        BASE_URI +
        folder.name +
        "/" +
        relative.split("/").map(encodeURIComponent).join("/");
      const mime = mimeType(relative);
      const decoded =
        mime !== "application/octet-stream"
          ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              bytes,
            )
          : null;
      // Invalid UTF-8 fails loading instead of publishing a different digest.
      resources.set(
        uri,
        freeze(
          decoded === null
            ? {
                uri,
                mimeType: mime,
                blob: Buffer.from(bytes).toString("base64"),
              }
            : { uri, mimeType: mime, text: decoded },
        ),
      );
    }
    entries.push(freeze(entry));
  }
  if (!entries.length) throw new Error("Workflow skill catalogue is empty.");
  return Object.freeze({
    entries: Object.freeze(entries),
    read: (uri: string) => resources.get(uri),
  });
}

let bundledCatalog: Promise<WorkflowSkillCatalog> | undefined;
export function workflowSkillCatalog(): Promise<WorkflowSkillCatalog> {
  return (bundledCatalog ??= loadWorkflowSkillCatalog());
}

function cacheFields(server: Server) {
  return server.getNegotiatedProtocolVersion() === "2026-07-28" ? CACHE : {};
}

export function registerWorkflowSkills(server: Server): void {
  server.setRequestHandler(
    "skills/list",
    { params: z.object({ cursor: z.string().optional() }) },
    async ({ cursor }) => {
      if (cursor !== undefined)
        throw new ProtocolError(
          -32602,
          "Invalid skill cursor; restart listing.",
        );
      return {
        skills: [...(await workflowSkillCatalog()).entries],
        ...cacheFields(server),
      };
    },
  );
  server.setRequestHandler(
    "skills/get",
    { params: z.object({ uri: z.string().min(1).max(1024) }) },
    async ({ uri }) => {
      const skill = (await workflowSkillCatalog()).entries.find(
        (entry) => entry.uri === uri,
      );
      if (!skill) throw new ProtocolError(-32602, "Unknown workflow skill.");
      return { skill, ...cacheFields(server) };
    },
  );
}

export async function listWorkflowSkillResources() {
  return (await workflowSkillCatalog()).entries.map((entry) => ({
    uri: entry.uri,
    name: entry.frontmatter.name,
    description: entry.frontmatter.description,
    mimeType: "text/markdown",
  }));
}

export async function readWorkflowSkillResource(server: Server, uri: string) {
  if (!uri.startsWith(BASE_URI)) return undefined;
  const content = (await workflowSkillCatalog()).read(uri);
  if (!content)
    throw new ProtocolError(-32602, "Unknown workflow skill resource.");
  return { contents: [{ ...content }], ...cacheFields(server) };
}
