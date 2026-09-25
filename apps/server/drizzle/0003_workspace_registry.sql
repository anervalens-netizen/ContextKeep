-- M3.1: observed workspace registry + source-origin binding primitives.
-- Observed activity is deliberately separate from canonical project lifecycle.

CREATE TABLE `workspace_bindings` (
  `id` text PRIMARY KEY NOT NULL,
  `canonical_key` text NOT NULL,
  `canonical_path` text NOT NULL,
  `display_name` text NOT NULL,
  `git_remote` text,
  `git_branch` text,
  `git_head_sha` text,
  `last_git_activity` text,
  `last_observed_activity` text,
  `project_id` text,
  `ignored` integer DEFAULT 0 NOT NULL,
  `first_seen_at` text NOT NULL,
  `last_seen_at` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workspace_canonical_key` ON `workspace_bindings` (`canonical_key`);--> statement-breakpoint
CREATE INDEX `ix_workspace_project` ON `workspace_bindings` (`project_id`);--> statement-breakpoint
CREATE INDEX `ix_workspace_activity` ON `workspace_bindings` (`last_observed_activity`);--> statement-breakpoint

CREATE TABLE `source_origins` (
  `source_id` text PRIMARY KEY NOT NULL,
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
CREATE UNIQUE INDEX `uq_source_origin_external_part` ON `source_origins` (`connector`,`external_id`,`external_part`);--> statement-breakpoint
CREATE INDEX `ix_source_origin_workspace` ON `source_origins` (`workspace_binding_id`);
