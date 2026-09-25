import type { AuditAction } from "@contextkeep/shared";
import { auditEvents } from "../db/schema.js";
import type { Db } from "../db/client.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";

export interface AuditEntry {
  actor: string;
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  /** A15: before/after references stored as JSON snapshots. */
  before?: unknown;
  after?: unknown;
  detail?: unknown;
  requestId?: string | null;
}

export function writeAudit(db: Db, entry: AuditEntry): string {
  const id = newId();
  db.insert(auditEvents)
    .values({
      id,
      actor: entry.actor,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      timestamp: nowIso(),
      beforeRef: entry.before === undefined ? null : JSON.stringify(entry.before),
      afterRef: entry.after === undefined ? null : JSON.stringify(entry.after),
      detailJson: entry.detail === undefined ? null : JSON.stringify(entry.detail),
      requestId: entry.requestId ?? null,
    })
    .run();
  return id;
}
