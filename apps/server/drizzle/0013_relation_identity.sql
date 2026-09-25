-- A5.4: relation records are ordinary structured facts, but one subject may
-- legitimately have several objects for the same relation kind.
DROP INDEX `uq_accepted_structured_claim`;
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_accepted_structured_claim` ON `records` (`project_id`,`subject`,`predicate`)
  WHERE review_status = 'accepted'
    AND predicate IS NOT NULL
    AND predicate NOT IN ('depends_on', 'blocks', 'affects', 'runs_on');
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_accepted_relation` ON `records` (`project_id`,`subject`,`predicate`,`value_json`)
  WHERE review_status = 'accepted'
    AND predicate IN ('depends_on', 'blocks', 'affects', 'runs_on');
