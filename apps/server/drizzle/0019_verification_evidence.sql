CREATE TABLE workflow_run_evidence (
 record_id TEXT PRIMARY KEY REFERENCES records(id),
 run_id TEXT NOT NULL REFERENCES workflow_runs(id),
 run_revision INTEGER NOT NULL,
 external_job_id TEXT,
 observation_hash TEXT NOT NULL,
 captured_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX workflow_run_evidence_run ON workflow_run_evidence(run_id,run_revision);
--> statement-breakpoint
CREATE TABLE workflow_verification_receipts (
 run_id TEXT NOT NULL REFERENCES workflow_runs(id),
 run_revision INTEGER NOT NULL,
 record_id TEXT NOT NULL REFERENCES records(id),
 record_revision INTEGER NOT NULL,
 evidence_hash TEXT NOT NULL,
 observation_hash TEXT NOT NULL,
 verdict TEXT NOT NULL CHECK(verdict IN ('passed','failed')),
 verified_at TEXT NOT NULL,
 PRIMARY KEY(run_id,run_revision)
);
--> statement-breakpoint
CREATE INDEX workflow_events_task_sequence ON workflow_events(task_id,sequence DESC);
