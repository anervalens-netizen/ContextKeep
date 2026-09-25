-- M3.4: persistent extraction idempotency + minimal sync health.

CREATE TABLE `source_extractions` (
  `id` text PRIMARY KEY NOT NULL,
  `source_id` text NOT NULL,
  `project_id` text,
  `project_key` text NOT NULL,
  `adapter_id` text NOT NULL,
  `adapter_version` text NOT NULL,
  `stage` text NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `last_job_id` text,
  `last_error_code` text,
  `preflight_usage_json` text,
  `actual_usage_json` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`last_job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_source_extraction_target` ON `source_extractions` (`source_id`,`project_key`,`adapter_id`,`adapter_version`);--> statement-breakpoint
CREATE INDEX `ix_source_extractions_source` ON `source_extractions` (`source_id`);--> statement-breakpoint
CREATE INDEX `ix_source_extractions_stage` ON `source_extractions` (`stage`);--> statement-breakpoint

CREATE TABLE `connector_sync_state` (
  `connector` text PRIMARY KEY NOT NULL,
  `last_scan_at` text,
  `last_success_at` text,
  `last_error` text,
  `last_result_json` text,
  `updated_at` text NOT NULL
);
