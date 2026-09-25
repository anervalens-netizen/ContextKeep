CREATE TABLE `idempotency_requests` (
	`key` text PRIMARY KEY NOT NULL,
	`method` text NOT NULL,
	`url` text NOT NULL,
	`request_hash` text NOT NULL,
	`state` text NOT NULL,
	`response_status` integer,
	`response_body` text,
	`response_content_type` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_idempotency_state_updated` ON `idempotency_requests` (`state`, `updated_at`);
