/** All timestamps are stored in UTC ISO-8601 (handoff §6). */
export function nowIso(): string {
  return new Date().toISOString();
}

export function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function dateOnly(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return iso.slice(0, 10);
}
