import {
  CorrectionPreviewDto,
  CodexImportResultDto,
  DshImportResultDto,
  ExistingSourceExtractionResultDto,
  HandoffExportDto,
  ImportPreviewDto,
  ProjectDto,
  RecordDto,
  ReviewResultDto,
  SyncJobDto,
  SyncRunResultDto,
  SynthesisDto,
  WorkspaceDto,
  WorkspaceScanResultDto,
} from "@contextkeep/shared";

export type MutationAcknowledgement =
  | { valid: true; value: unknown }
  | { valid: false; reason: string };

function invalid(reason: string): MutationAcknowledgement {
  return { valid: false, reason };
}

function parsed(result: { success: boolean; data?: unknown }): MutationAcknowledgement {
  return result.success
    ? { valid: true, value: result.data }
    : invalid("response does not match the endpoint contract");
}

function pathId(url: string, prefix: string, suffix = ""): string | null {
  if (!url.startsWith(prefix) || !url.endsWith(suffix)) return null;
  const raw = url.slice(prefix.length, url.length - suffix.length);
  if (!raw || raw.includes("/")) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function validateInboxIdentity(value: unknown, body: unknown): MutationAcknowledgement {
  const checked = ReviewResultDto.safeParse(value);
  if (!checked.success) return invalid("inbox decision response is malformed");
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalid("inbox decision request is not attributable");
  }
  const items = (body as Record<string, unknown>).items;
  if (!Array.isArray(items)) return invalid("inbox decision request has no items");
  const requested = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return invalid("inbox decision request contains an invalid item");
    }
    const recordId = (item as Record<string, unknown>).recordId;
    if (typeof recordId !== "string" || requested.has(recordId)) {
      return invalid("inbox decision request contains an ambiguous record identity");
    }
    requested.add(recordId);
  }
  const action = (body as Record<string, unknown>).action;
  if (action !== "accept" && action !== "reject") return invalid("inbox decision action is ambiguous");
  if (action === "accept" && checked.data.rejected.length > 0) return invalid("accept response contains rejected records");
  if (action === "reject" && (checked.data.accepted.length > 0 || checked.data.edited.length > 0)) {
    return invalid("reject response contains accepted or edited records");
  }
  const primaryIds = [
    ...checked.data.accepted,
    ...checked.data.rejected,
    ...checked.data.blocked.map((item) => item.recordId),
  ];
  const editedIds = checked.data.edited;
  if (new Set(editedIds).size !== editedIds.length || editedIds.some((recordId) => !checked.data.accepted.includes(recordId))) {
    return invalid("edited records must be a unique subset of accepted records");
  }
  const seen = new Set<string>();
  for (const recordId of primaryIds) {
    if (!requested.has(recordId) || seen.has(recordId)) {
      return invalid("inbox decision response contains an unexpected or duplicate record");
    }
    seen.add(recordId);
  }
  return seen.size === requested.size
    ? { valid: true, value: checked.data }
    : invalid("inbox decision response did not account for every requested record");
}

function validateProject(value: unknown, body: unknown, expectedId: string | null): MutationAcknowledgement {
  const checked = ProjectDto.safeParse(value);
  if (!checked.success) return invalid("project response is malformed");
  const project = checked.data;
  if (expectedId !== null && project.id !== expectedId) return invalid("project response identity does not match the request");
  if (!body || typeof body !== "object" || Array.isArray(body)) return { valid: true, value: project };
  const input = body as Record<string, unknown>;
  if (typeof input.name === "string" && project.name !== input.name) return invalid("project response name does not match the request");
  if (Array.isArray(input.aliases) && JSON.stringify(project.aliases) !== JSON.stringify(input.aliases)) return invalid("project response aliases do not match the request");
  if ("parentId" in input && project.parentId !== (input.parentId ?? null)) return invalid("project response parent does not match the request");
  if ("description" in input && project.description !== (input.description ?? null)) return invalid("project response description does not match the request");
  return { valid: true, value: project };
}

export function validateMutationAcknowledgement(
  url: string,
  method: string,
  body: unknown,
  value: unknown,
): MutationAcknowledgement {
  const upperMethod = method.toUpperCase();

  if (upperMethod === "POST" && url === "/api/projects") return validateProject(value, body, null);
  if (upperMethod === "PATCH") {
    const id = pathId(url, "/api/projects/");
    if (id !== null) return validateProject(value, body, id);
  }

  if (upperMethod === "PUT") {
    const id = pathId(url, "/api/records/");
    if (id !== null) {
      const checked = RecordDto.safeParse(value);
      if (!checked.success) return invalid("record response is malformed");
      if (checked.data.id !== id) return invalid("record response identity does not match the request");
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const input = body as Record<string, unknown>;
        if (typeof input.revision === "number" && Number.isInteger(input.revision)) {
          const expectedRevisions = new Set([input.revision, input.revision + 1]);
          if (!expectedRevisions.has(checked.data.revision)) return invalid("record response revision does not match the request");
        }
        if ("projectId" in input && checked.data.projectId !== (input.projectId ?? null)) {
          return invalid("record response project identity does not match the request");
        }
      }
      return { valid: true, value: checked.data };
    }
  }

  if (upperMethod === "POST" && url === "/api/inbox/decide") return validateInboxIdentity(value, body);
  if (upperMethod === "POST" && url === "/api/imports/text") return parsed(ImportPreviewDto.safeParse(value));
  if (upperMethod === "POST" && url === "/api/imports/file") return parsed(ImportPreviewDto.safeParse(value));
  if (upperMethod === "POST" && url === "/api/corrections") return parsed(CorrectionPreviewDto.safeParse(value));

  if (upperMethod === "POST") {
    const correctionJobId = pathId(url, "/api/corrections/", "/confirm");
    if (correctionJobId !== null) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("correction confirmation response is malformed");
      const result = value as Record<string, unknown>;
      const arrays = [result.acceptedRecordIds, result.supersededRecordIds, result.confirmedSupersessionIds];
      if (
        result.jobId !== correctionJobId ||
        arrays.some((item) => !Array.isArray(item)) ||
        arrays.flat().some((item) => typeof item !== "string")
      ) return invalid("correction confirmation response does not match the request");
      return { valid: true, value };
    }
  }

  if (upperMethod === "POST" && url === "/api/workspaces/scan") return parsed(WorkspaceScanResultDto.safeParse(value));
  if (upperMethod === "POST") {
    const workspaceId = pathId(url, "/api/workspaces/", "/action");
    if (workspaceId !== null) {
      const checked = WorkspaceDto.safeParse(value);
      if (!checked.success) return invalid("workspace action response is malformed");
      return checked.data.id === workspaceId
        ? { valid: true, value: checked.data }
        : invalid("workspace action response identity does not match the request");
    }
  }

  if (upperMethod === "POST" && url === "/api/handoffs") {
    const checked = HandoffExportDto.safeParse(value);
    if (!checked.success) return invalid("handoff response is malformed");
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const projectId = (body as Record<string, unknown>).projectId;
      if (typeof projectId === "string" && checked.data.projectId !== projectId) {
        return invalid("handoff response project identity does not match the request");
      }
    }
    return { valid: true, value: checked.data };
  }
  if (upperMethod === "POST" && url === "/api/sync/run") {
    const checked = SyncRunResultDto.safeParse(value);
    if (!checked.success) return invalid("sync run response is malformed");
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const projectId = (body as Record<string, unknown>).projectId;
      if (typeof projectId === "string" && checked.data.plan.projectId !== projectId) {
        return invalid("sync run response project identity does not match the request");
      }
    }
    return { valid: true, value: checked.data };
  }
  if (upperMethod === "POST") {
    const syncJobId = pathId(url, "/api/sync/jobs/", "/action");
    if (syncJobId !== null) {
      const action = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).action : null;
      if (action === "retry" || action === "resume") return parsed(SyncRunResultDto.safeParse(value));
      if (action !== "cancel") return invalid("unknown sync job action");
      const checked = SyncJobDto.safeParse(value);
      if (!checked.success) return invalid("sync job action response is malformed");
      return checked.data.id === syncJobId
        ? { valid: true, value: checked.data }
        : invalid("sync job action response identity does not match the request");
    }
  }
  if (upperMethod === "POST") {
    const sourceId = pathId(url, "/api/sources/", "/extract");
    if (sourceId !== null) {
      const checked = ExistingSourceExtractionResultDto.safeParse(value);
      if (!checked.success) return invalid("source extraction response is malformed");
      return checked.data.sourceId === sourceId
        ? { valid: true, value: checked.data }
        : invalid("source extraction response identity does not match the request");
    }
  }
  if (upperMethod === "POST" && url === "/api/synthesis") return parsed(SynthesisDto.safeParse(value));
  if (upperMethod === "POST") {
    if (url.startsWith("/api/connectors/codex/") && (url.endsWith("/sessions/import") || url.endsWith("/summaries/import"))) {
      const checked = CodexImportResultDto.safeParse(value);
      if (!checked.success) return invalid("Codex import response is malformed");
      const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
      const expected = url.endsWith("/sessions/import") ? input?.sessionId : typeof input?.fileName === "string" ? `rollout-summary:${input.fileName}` : undefined;
      return typeof expected === "string" && checked.data.externalId !== expected
        ? invalid("Codex import response identity does not match the request")
        : { valid: true, value: checked.data };
    }
    if (url.startsWith("/api/connectors/dsh/") && (url.endsWith("/sessions/import") || url.endsWith("/memory/import"))) {
      const checked = DshImportResultDto.safeParse(value);
      if (!checked.success) return invalid("DSH import response is malformed");
      const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
      const expected = url.endsWith("/sessions/import") ? input?.sessionId : typeof input?.relativePath === "string" ? `memory:${input.relativePath.replaceAll("\\", "/")}` : undefined;
      return typeof expected === "string" && checked.data.externalId !== expected
        ? invalid("DSH import response identity does not match the request")
        : { valid: true, value: checked.data };
    }
  }

  return invalid("no acknowledgement contract is registered for this mutation");
}
