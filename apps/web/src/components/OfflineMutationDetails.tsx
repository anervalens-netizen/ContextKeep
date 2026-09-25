import type { QueuedMutation } from "../lib/offline/db.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

/** Only known same-origin application routes can become navigation targets. */
export function offlineMutationTarget(mutation: QueuedMutation): string | null {
  const url = new URL(mutation.url, "http://contextkeep.local");
  if (url.origin !== "http://contextkeep.local") return null;
  const body =
    mutation.body &&
    typeof mutation.body === "object" &&
    !Array.isArray(mutation.body)
      ? (mutation.body as Record<string, unknown>)
      : {};
  const projectPath = url.pathname.match(/^\/api\/projects\/([^/]+)/)?.[1];
  const projectId = validId(projectPath)
    ? projectPath
    : validId(body.projectId)
      ? body.projectId
      : null;
  const recordPath = url.pathname.match(/^\/api\/records\/([^/]+)/)?.[1];
  const recordId = validId(recordPath)
    ? recordPath
    : validId(body.recordId)
      ? body.recordId
      : null;
  if (projectId)
    return `/projects/${projectId}${recordId ? `?recordId=${recordId}` : ""}`;
  if (url.pathname === "/api/inbox/decide") return "/inbox";
  if (url.pathname.startsWith("/api/corrections")) return "/corrections";
  if (url.pathname.startsWith("/api/imports/")) return "/import";
  return null;
}

export function OfflineMutationDetails({
  mutation,
  unknownOutcome = false,
}: {
  mutation: QueuedMutation;
  unknownOutcome?: boolean;
}) {
  let route = "Unrecognized route";
  let target: string | null = null;
  try {
    route = new URL(mutation.url, "http://contextkeep.local").pathname;
    target = offlineMutationTarget(mutation);
  } catch {
    /* Malformed legacy rows remain inspectable without unsafe links. */
  }
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-ck-teal">
        Inspect operation
      </summary>
      <dl className="mt-1 space-y-1 break-words">
        <div>
          <dt className="inline font-medium">Request: </dt>
          <dd className="inline">
            {mutation.method} {route}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">Queued: </dt>
          <dd className="inline">{mutation.enqueuedAt}</dd>
        </div>
        {mutation.idempotencyKey ? (
          <div>
            <dt className="inline font-medium">Event identity: </dt>
            <dd className="inline font-mono">{mutation.idempotencyKey}</dd>
          </div>
        ) : null}
      </dl>
      {unknownOutcome ? (
        <p className="mt-1">
          The server may already have applied this change. Inspect current state
          before acknowledging; viewing these details never retries the
          operation.
        </p>
      ) : null}
      {target ? (
        <a
          href={target}
          className="mt-1 inline-block font-medium text-ck-teal underline"
        >
          Open affected area
        </a>
      ) : null}
    </details>
  );
}
