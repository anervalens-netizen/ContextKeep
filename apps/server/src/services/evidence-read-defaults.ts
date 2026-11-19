export const RECORD_READ_DEFAULTS = {
  evidenceOffset: 0,
  evidenceLimit: 3,
} as const;

export function recordRecovery(recordId: string) {
  return {
    tool: "get_record",
    recordId,
    includeUnreviewed: true,
    ...RECORD_READ_DEFAULTS,
  } as const;
}

export const SOURCE_READ_DEFAULTS = {
  representation: "normalized",
  offset: 0,
  maxChars: 6000,
  excerptOffset: 0,
  excerptLimit: 5,
} as const;
