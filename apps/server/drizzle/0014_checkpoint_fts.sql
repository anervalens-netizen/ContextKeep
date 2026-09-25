-- CKR-09: searchable semantic projection for working-checkpoint metadata.
-- The FTS table is derived data; record ids, evidence, hashes and truth state
-- remain unchanged. JSON keys are deliberately not indexed.
DROP TRIGGER IF EXISTS `trg_records_fts_ai`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_records_fts_au`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_records_fts_ad`;
--> statement-breakpoint
DROP TABLE IF EXISTS `ck_records_fts`;
--> statement-breakpoint

CREATE VIRTUAL TABLE `ck_records_fts` USING fts5(
  `record_id` UNINDEXED,
  `project_id` UNINDEXED,
  `type` UNINDEXED,
  `basis` UNINDEXED,
  `review_status` UNINDEXED,
  `text`,
  `subject`,
  `predicate`,
  `checkpoint_text`,
  tokenize = 'porter unicode61'
);
--> statement-breakpoint

CREATE TRIGGER `trg_records_fts_ai`
AFTER INSERT ON `records`
BEGIN
  INSERT INTO `ck_records_fts`
    (record_id, project_id, type, basis, review_status, text, subject, predicate, checkpoint_text)
  VALUES (
    NEW.id, NEW.project_id, NEW.type, NEW.evidence_basis, NEW.review_status,
    NEW.text, NEW.subject, NEW.predicate,
    CASE
      WHEN NEW.value_json IS NOT NULL
       AND json_valid(NEW.value_json) = 1
       AND json_extract(NEW.value_json, '$.kind') = 'working_checkpoint'
      THEN trim(
        COALESCE(json_extract(NEW.value_json, '$.summary'), '') || ' ' ||
        COALESCE(json_extract(NEW.value_json, '$.outcome'), '') || ' ' ||
        COALESCE(json_extract(NEW.value_json, '$.nextAction'), '') || ' ' ||
        COALESCE(json_extract(NEW.value_json, '$.blockers'), '') || ' ' ||
        COALESCE(json_extract(NEW.value_json, '$.artifactRefs'), '')
      )
      ELSE ''
    END
  );
END;
--> statement-breakpoint

CREATE TRIGGER `trg_records_fts_au`
AFTER UPDATE ON `records`
BEGIN
  DELETE FROM `ck_records_fts` WHERE record_id = OLD.id;
  INSERT INTO `ck_records_fts`
    (record_id, project_id, type, basis, review_status, text, subject, predicate, checkpoint_text)
  VALUES (
    NEW.id, NEW.project_id, NEW.type, NEW.evidence_basis, NEW.review_status,
    NEW.text, NEW.subject, NEW.predicate,
    CASE
      WHEN NEW.value_json IS NOT NULL
       AND json_valid(NEW.value_json) = 1
       AND json_extract(NEW.value_json, '$.kind') = 'working_checkpoint'
      THEN trim(
        COALESCE(json_extract(NEW.value_json, '$.summary'), '') || ' ' ||
        COALESCE(json_extract(NEW.value_json, '$.outcome'), '') || ' ' ||
        COALESCE(json_extract(NEW.value_json, '$.nextAction'), '') || ' ' ||
        COALESCE(json_extract(NEW.value_json, '$.blockers'), '') || ' ' ||
        COALESCE(json_extract(NEW.value_json, '$.artifactRefs'), '')
      )
      ELSE ''
    END
  );
END;
--> statement-breakpoint

CREATE TRIGGER `trg_records_fts_ad`
AFTER DELETE ON `records`
BEGIN
  DELETE FROM `ck_records_fts` WHERE record_id = OLD.id;
END;
--> statement-breakpoint

INSERT INTO `ck_records_fts`
  (record_id, project_id, type, basis, review_status, text, subject, predicate, checkpoint_text)
SELECT
  id, project_id, type, evidence_basis, review_status, text, subject, predicate,
  CASE
    WHEN value_json IS NOT NULL
     AND json_valid(value_json) = 1
     AND json_extract(value_json, '$.kind') = 'working_checkpoint'
    THEN trim(
      COALESCE(json_extract(value_json, '$.summary'), '') || ' ' ||
      COALESCE(json_extract(value_json, '$.outcome'), '') || ' ' ||
      COALESCE(json_extract(value_json, '$.nextAction'), '') || ' ' ||
      COALESCE(json_extract(value_json, '$.blockers'), '') || ' ' ||
      COALESCE(json_extract(value_json, '$.artifactRefs'), '')
    )
    ELSE ''
  END
FROM `records`;
