import { redactCredentialLikeText } from "@contextkeep/shared";

export class ToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly nextAction: string;
  constructor(value: unknown) {
    const detail =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    super(
      redactCredentialLikeText(
        typeof detail.message === "string"
          ? detail.message
          : "ContextKeep request failed.",
      ).text,
    );
    this.code = typeof detail.code === "string" ? detail.code : "tool_error";
    this.retryable = detail.retryable === true;
    this.nextAction =
      typeof detail.nextAction === "string"
        ? detail.nextAction
        : "inspect_state";
  }
}
export function describeToolError(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object") return fallback;
  const e = error as Record<string, unknown>;
  const details =
    e.details && typeof e.details === "object"
      ? (e.details as Record<string, unknown>)
      : {};
  const code = typeof e.code === "string" ? e.code : null;
  if (!code) return fallback;
  const message = typeof e.message === "string" ? e.message : fallback;
  const next = e.nextAction ?? details.nextAction;
  const retryable = e.retryable ?? details.retryable;
  return redactCredentialLikeText(
    [
      fallback,
      `[${code}] ${message}`,
      typeof next === "string" ? `Next: ${next}.` : "",
      code === "idempotency_outcome_unknown" ||
      next === "reconcile_state_before_retry"
        ? "Inspect uncertain effects before retry."
        : "",
      typeof retryable === "boolean" ? `Retryable: ${retryable}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  ).text;
}
