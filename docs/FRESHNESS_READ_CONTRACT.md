# Bounded freshness reads

A bounded timeline or search page must not retain a project's complete working-memory backlog. The page preloader evaluates qualifying observations in 128-row keyset batches and retains at most 128 full observation objects for compatibility. Each canonical page record receives bounded evidence signals rather than the complete candidate bodies.

Every qualifying observation is considered. Same-entity evidence with an explicit observation/effective timestamp remains distinct from weaker lexical or capture-time evidence. A strong observation occurring after the first batch must still change the classification. Conflicts take precedence; overlapping references are deduplicated, and a self-only conflict remains a conflict even without another record ID.

Returned reference samples are deterministic and limited to 20 IDs per category. When a sample omits references, the optional `freshness.referenceSummary` reports complete `supportCount` and `possiblyRelatedCount` values plus separate truncation flags. Small, complete results omit this metadata for compatibility. Record cards explain the omission and retain links to inspect the selected evidence and review the canonical record.

These are in-process/result-memory bounds, not a promise of constant-time queries: the database still evaluates all qualifying evidence to preserve correctness. The implementation does not silently turn an incomplete sample into a complete truth claim.

Regression coverage includes relevant and irrelevant multi-batch histories, strong evidence after a weak prefix, duplicate and self-only conflicts, non-state records, future/expired records, transaction handles, and complete small-result parity.
