import type { SyncConnector, SyncRunInput } from "@contextkeep/shared";
import type { AppConfig } from "../config.js";
export function connectorList(connector: SyncConnector): ("codex" | "dsh")[] {
  return connector === "both" ? ["codex", "dsh"] : [connector];
}

export function maxIso(values: (string | null)[]): string | null {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null
  );
}

export function idle(
  updatedAt: string,
  nowMs: number,
  idleMinutes: number,
): boolean {
  const stamp = Date.parse(updatedAt);
  return Number.isFinite(stamp) && nowMs - stamp >= idleMinutes * 60_000;
}

export function resolveLimits(config: AppConfig, input: SyncRunInput) {
  return {
    extractionAdapterId:
      input.extractionAdapterId ?? config.syncExtractionAdapter,
    idleMinutes: input.idleMinutes ?? config.syncIdleMinutes,
    maxArtifacts: input.maxArtifacts ?? config.syncMaxArtifacts,
    maxChars: input.maxChars ?? config.syncMaxChars,
    maxCostUsd: input.maxCostUsd ?? config.syncMaxCostUsd,
  };
}
