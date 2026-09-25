-- M3.2: allow multiple external Codex/DSH origins to reference one immutable
-- ContextKeep source when exact sanitized content deduplication collapses them.

CREATE TABLE `source_origins_v2` (
  `id` text PRIMARY KEY NOT NULL,
  `source_id` text NOT NULL,
  `connector` text NOT NULL,
  `external_id` text NOT NULL,
  `external_part` text DEFAULT 'full' NOT NULL,
  `external_revision` text,
  `external_hash` text,
  `workspace_binding_id` text,
  `archive_state` text DEFAULT 'unknown' NOT NULL,
  `external_updated_at` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`workspace_binding_id`) REFERENCES `workspace_bindings`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint

INSERT INTO `source_origins_v2` (
  `id`,`source_id`,`connector`,`external_id`,`external_part`,`external_revision`,
  `external_hash`,`workspace_binding_id`,`archive_state`,`external_updated_at`,`created_at`
)
SELECT lower(hex(randomblob(16))), `source_id`,`connector`,`external_id`,`external_part`,
  `external_revision`,`external_hash`,`workspace_binding_id`,`archive_state`,`external_updated_at`,`created_at`
FROM `source_origins`;--> statement-breakpoint

DROP TABLE `source_origins`;--> statement-breakpoint
ALTER TABLE `source_origins_v2` RENAME TO `source_origins`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_source_origin_external_part` ON `source_origins` (`connector`,`external_id`,`external_part`);--> statement-breakpoint
CREATE INDEX `ix_source_origin_source` ON `source_origins` (`source_id`);--> statement-breakpoint
CREATE INDEX `ix_source_origin_workspace` ON `source_origins` (`workspace_binding_id`);
