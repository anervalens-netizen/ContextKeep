-- M1: FTS5 virtual table for record search (handoff §12 item 9 + §10 perf budget).
--
-- Replaces the M0 LIKE-based search service with a porter+unicode61-tokenized
-- FTS5 index. UNINDEXED columns carry metadata (project_id, type, basis,
-- review_status) used for filtering; the three INDEXED columns (text, subject,
-- predicate) are what MATCH actually searches. Triggers keep the index in sync
-- with the records table on INSERT/UPDATE/DELETE. See docs/decisions/0020.

CREATE VIRTUAL TABLE IF NOT EXISTS `ck_records_fts` USING fts5(
  `record_id` UNINDEXED,
  `project_id` UNINDEXED,
  `type` UNINDEXED,
  `basis` UNINDEXED,
  `review_status` UNINDEXED,
  `text`,
  `subject`,
  `predicate`,
  tokenize = 'porter unicode61'
);
--> statement-breakpoint

-- NOTE: SQLite does not allow CREATE INDEX on virtual tables; FTS5 keeps
-- its own internal index for the searchable columns, and the UNINDEXED
-- metadata columns are filtered via the join to records.id (which is a
-- text primary key, indexed by definition). If project_id filtering ever
-- becomes a bottleneck, materialize it as a non-UNINDEXED column on a
-- companion table instead.

-- Sync triggers: keep the FTS5 row in lock-step with records.
-- We DELETE-then-INSERT on UPDATE because FTS5 has no UPDATE; rowids would
-- otherwise accumulate. The trade-off (lose rank score on update) is fine for
-- a knowledge-base that is written rarely and read often.

CREATE TRIGGER IF NOT EXISTS `trg_records_fts_ai`
AFTER INSERT ON `records`
BEGIN
  INSERT INTO `ck_records_fts` (record_id, project_id, type, basis, review_status, text, subject, predicate)
  VALUES (NEW.id, NEW.project_id, NEW.type, NEW.evidence_basis, NEW.review_status, NEW.text, NEW.subject, NEW.predicate);
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `trg_records_fts_au`
AFTER UPDATE ON `records`
BEGIN
  DELETE FROM `ck_records_fts` WHERE record_id = OLD.id;
  INSERT INTO `ck_records_fts` (record_id, project_id, type, basis, review_status, text, subject, predicate)
  VALUES (NEW.id, NEW.project_id, NEW.type, NEW.evidence_basis, NEW.review_status, NEW.text, NEW.subject, NEW.predicate);
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `trg_records_fts_ad`
AFTER DELETE ON `records`
BEGIN
  DELETE FROM `ck_records_fts` WHERE record_id = OLD.id;
END;
--> statement-breakpoint

-- Backfill: pre-existing records (from M0 demo seed or earlier test runs) need
-- to be indexed once. After this, the triggers above keep it in sync.

INSERT INTO `ck_records_fts` (record_id, project_id, type, basis, review_status, text, subject, predicate)
SELECT id, project_id, type, evidence_basis, review_status, text, subject, predicate
FROM `records`;
