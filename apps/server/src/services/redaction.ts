import { redactCredentialLikeText } from "@contextkeep/shared";
export { redactCredentialLikeText, type RedactionResult } from "@contextkeep/shared";

export function safeText(value: string, secrets: string[], preserveLength = false): string {
  let text = value;
  for (const secret of secrets) {
    if (secret.length >= 8) text = text.split(secret).join(preserveLength ? "*".repeat(secret.length) : "<REDACTED_CREDENTIAL>");
  }
  return redactCredentialLikeText(text, preserveLength).text;
}
