CREATE TABLE `sync_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
  `connector` text NOT NULL,
  `mode` text NOT NULL,
  `input_json` text NOT NULL,
  `stage` text NOT NULL,
  `selected` integer DEFAULT 0 NOT NULL,
  `completed` integer DEFAULT 0 NOT NULL,
  `failed` integer DEFAULT 0 NOT NULL,
  `current_key` text,
  `result_json` text,
  `last_error` text,
  `started_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `finished_at` text
);
--> statement-breakpoint
CREATE INDEX `ix_sync_jobs_stage_updated` ON `sync_jobs` (`stage`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `ix_sync_jobs_project_updated` ON `sync_jobs` (`project_id`,`updated_at`);
