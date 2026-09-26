# Reliability consolidation plan

Scope: preserve the existing architecture and data model; strengthen failure handling, client acknowledgements, freshness and maintenance contracts. Only synthetic fixtures and generic development details belong in this public plan. Deployment evidence and operator state remain private.

## Acceptance tracker

- [x] Runtime lifecycle: initial persistence failure releases the coordinator; shutdown callback errors are controlled and live continuations drain before DB close (R01, R15).
- [x] Offline acknowledgements: malformed, truncated, redirected or semantically invalid successes retain the same intent and event key; valid receipts finalize once (R02).
- [x] Application exclusivity: claim runtime ownership before migrations/recovery; online backup readers remain supported; competing runtime refuses without mutating live work (R03).
- [x] Browser preferences: denied storage cannot stop initial rendering; durable offline storage is never replaced by silent volatile persistence (R04).
- [x] Metadata freshness: project revision participates independently in freshness and UI invalidation, including resets (R05).
- [x] Bounded reads: measure synthetic large fixtures; move filtering into SQL and add compatible, stable pagination without silent loss (R06).
- [x] MCP result size: bound the complete dual-content result, retain protocol compatibility and keep semantic context budgets distinct (R07).
- [x] Public-source guard: inspect history and commit messages without printing matched sensitive values; pre-push prevention remains enabled (R08, R14).
- [x] Verification contract: make release certification explicit, distinguish optional fast CI, include new regression checks and extend static checks proportionately (R09).
- [x] Portable operations: validate configured primary identity/data/runtime paths; report backup-kit space; preserve runtime kits and the existing 96-recent/30-daily snapshot retention, without introducing additional automatic cleanup (R10).
- [x] Public documentation: architecture/invariants, synthetic configuration and HTTP/MCP recovery contract (R11).
- [x] Local UI continuity: validated URL tab, neutral source provenance, readable key status labels without redesign (R12).
- [x] Durable event identity: old completed results may compact, but their keys cannot silently become new writes; unresolved outcomes retain their barrier (R13).
- [x] Evaluate context packing against existing deterministic evidence/provenance checks. Change ordering only if the same budget retains more relevant material without degrading canonical constraints.
- [ ] Full regression/type/build/privacy/operational/browser checks and independent final review on the integrated revision.

## Delivery order

1. Failure handling, acknowledgement and durable identity, with post-fix regression expectations.
2. Runtime ownership, metadata/browser recovery and publication guard.
3. Proportionate read/UI/operations/documentation improvements; no architecture rewrite or new infrastructure.
4. Verify integrated revision before release; preserve recovery material and independently verify runtime after activation. Runtime details are recorded privately.

## Integrated verification

Implementation items have focused regression coverage, including valid connector receipts, failed privacy-marker removal, transaction-compatible read batches and actual recovery entrypoint identity. The final integrated release gate remains the completion criterion. Context packing retains deterministic evidence/authority rules rather than introducing an unproven ranking change.
