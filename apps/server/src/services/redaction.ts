export interface RedactionResult {
  text: string;
  redactionCount: number;
}

/**
 * Conservative connector-side credential redaction. This runs BEFORE imported
 * agent text is persisted or sent to an extraction provider. It intentionally
 * targets credential-shaped material only; ordinary SHAs/IDs remain useful as
 * project evidence.
 */
export function redactCredentialLikeText(input: string): RedactionResult {
  let text = input;
  let redactionCount = 0;

  const apply = (pattern: RegExp, replacement: string): void => {
    pattern.lastIndex = 0;
    if (!pattern.test(text)) return;
    pattern.lastIndex = 0;
    text = text.replace(pattern, replacement);
    redactionCount += 1;
  };

  apply(
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    "<REDACTED_PRIVATE_KEY>",
  );
  apply(/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}\b/gi, "Bearer <REDACTED_CREDENTIAL>");
  apply(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "<REDACTED_GITHUB_TOKEN>");
  apply(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "<REDACTED_API_KEY>");
  apply(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<REDACTED_JWT>");
  apply(
    /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*["']?[^\s"'`]{6,}["']?/gi,
    "$1=<REDACTED_CREDENTIAL>",
  );
  apply(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<REDACTED_USERINFO>@");

  return { text, redactionCount };
}
