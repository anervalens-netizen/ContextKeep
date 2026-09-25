import { evaluateInstallGate } from "@contextkeep/shared/install-gate";

/**
 * A16: install is refused with a clear reason when the API origin is not
 * reachable over HTTPS (localhost development is exempt as a secure context).
 */
export function currentInstallGate(): { allowed: boolean; reason: string } {
  return evaluateInstallGate({
    protocol: window.location.protocol,
    hostname: window.location.hostname,
    isSecureContext: window.isSecureContext,
  });
}

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

export function captureInstallPrompt(
  onPrompt: (e: BeforeInstallPromptEvent) => void,
): () => void {
  const handler = (e: Event): void => {
    e.preventDefault();
    onPrompt(e as BeforeInstallPromptEvent);
  };
  window.addEventListener("beforeinstallprompt", handler);
  return () => window.removeEventListener("beforeinstallprompt", handler);
}
