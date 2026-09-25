/**
 * Runtime database schema authority belongs to the server package because the
 * migrations live under apps/server/drizzle. Never derive this value at
 * runtime from @contextkeep/shared: workspace packages/dist can temporarily be
 * on different revisions during certification or rollback operations.
 *
 * Keep the shared mirror in packages/shared/src/index.ts equal to this value;
 * CI asserts parity, but server boot/migrate/backup safety uses this local
 * constant only.
 */
export const SERVER_SCHEMA_VERSION = 16;
