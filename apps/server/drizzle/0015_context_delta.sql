CREATE TABLE `context_cursor_snapshots` (
  `project_id` text NOT NULL,
  `scope` text NOT NULL,
  `cursor` integer NOT NULL,
  `project_revision` integer NOT NULL,
  `manifest_json` text NOT NULL,
  `baseline` integer DEFAULT 0 NOT NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY(`project_id`, `scope`, `cursor`),
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_context_cursor_snapshots_project_scope`
  ON `context_cursor_snapshots` (`project_id`,`scope`,`cursor`);
--> statement-breakpoint
CREATE TABLE `context_delta_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `from_canonical_cursor` integer NOT NULL,
  `from_working_cursor` integer NOT NULL,
  `from_project_revision` integer NOT NULL,
  `target_canonical_cursor` integer NOT NULL,
  `target_working_cursor` integer NOT NULL,
  `target_project_revision` integer NOT NULL,
  `request_key` text,
  `changes_json` text NOT NULL,
  `project_json` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_context_delta_sessions_project`
  ON `context_delta_sessions` (`project_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_context_delta_sessions_request`
  ON `context_delta_sessions` (`project_id`,`request_key`);
