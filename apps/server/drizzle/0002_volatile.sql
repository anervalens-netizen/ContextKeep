-- M2: A11 volatile-facts plumbing (handoff §12 item 15, §13 case A11).
--
-- Adds a `volatile` flag to records. A volatile fact is one whose currency
-- expires (e.g. deployment version, current build SHA, live endpoint URL).
-- When the owner accepts a volatile record, the pipeline stamps
-- `review_due_at = reviewed_at + CK_VOLATILE_REVIEW_INTERVAL_DAYS` (default
-- 7 days, plan §16 item 6). Stable decisions do not get this stamp —
-- §3 "Stable decisions do not expire automatically" still holds.
--
-- The index is partial + covers review_due_at so the future badge query
-- (volatile=1 AND review_due_at < now) stays cheap once the table grows.

ALTER TABLE `records` ADD COLUMN `volatile` integer NOT NULL DEFAULT 0;--> statement-breakpoint

CREATE INDEX `ix_records_volatile_due` ON `records` (`volatile`, `review_due_at`) WHERE `volatile` = 1;
