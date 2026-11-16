# Batch 2: review attribution and event identity

Date: 2026-11-16\
Programme items: ME-18 / ME-19; bounded preparation for ME-01 / ME-02 / ME-03\
Accountable role: development agent; independent replay-safety review

## Status and source boundary

**VERIFIED for the new forward-ingestion path; historical recovery remains
partial.** Both required reviews, explicit dispositions, source integration and
CI passed. The qualified producer and complete owner workflow bundles are
installed. Controlled live readback verified attribution, preserved delivery
history and explicit grouped-review closure. Scheduled polling resumed after
guarded acceptance. One automatic repeat completed without additional captures
or dispositions and retained the known reconciliation fence. The retained
backlog prevents a claim of full health or complete historical migration; one
repeat does not establish indefinite stability.

The review producer belongs to the companion integration. Its exact private
source baseline, candidate and deployed component identities are maintained in
the operational evidence ledger. The public ContextKeep plan and protocol
baseline is `6cc120a06233ffa08a1c0139b5fe5a6015109ded`.
The public preparation is linked in
[PR #28](https://github.com/anervalens-netizen/ContextKeep/pull/28). Private
companion revisions and operational receipts remain outside this repository.

This is an ingestion correctness change. It does not introduce the ME-20 current
review UI, remove history, accept agent reports, change task execution authority,
or introduce global URL/title/text deduplication.

## Reproduced problems

Synthetic tests against the exact producer baseline reproduce these defects:

- Captured outcomes and checkpoint summaries label a Codex result as a DSH reply.
- Review provenance has no uniform explicit status, resource kind or attested
  base field. Absence of an attestation must remain unknown.
- Visible Codex findings can change while the shared fingerprint remains equal,
  allowing an earlier developer disposition to appear to cover edited evidence.
- The delivery version uses only the body digest. A changed reviewed commit or
  review state with the same body can be dropped.
- An older arrival can reopen a grouped review task or publish its checkpoint
  after newer evidence. Import order is not source event order.
- A source requiring reconciliation can stop a whole repository sweep unless
  its observation is durably isolated before the incremental cursor advances.
- A fingerprint upgrade can discard a legacy disposition without proving that
  it covered the current findings. A successful fresh disposition at a new
  comment URL can also leave the earlier legacy row pending indefinitely.

These are reproduced contract failures. They are not a claim about the frequency
or impact of these events in production.

## Required behavior

| Area | Contract |
| --- | --- |
| Attribution | Preserve actual reviewer and source author, repository, PR, resource kind, stable source ID, reviewed head and explicitly attested base. |
| Status | Distinguish running, completed, failed and unknown; completed evidence can await a developer disposition. A disposition is not owner approval. |
| Content version | Retain meaningful body, head, base and status edits while ignoring only a narrowly identified cosmetic timestamp. |
| Exact retry | Reuse the saved delivery identity, idempotency key and original serialized payload. |
| Legacy state | Preserve existing rows. Resolve a pending legacy delivery before a replacement version is sent; ambiguous identity remains blocked. |
| Reconciliation | Persist each fenced source observation before advancing its cursor; continue unaffected sources and keep backlog coverage explicit. |
| Disposition compatibility | Version new semantic fingerprints. Keep legacy lossy receipts pending for a fresh evidence-bound disposition; never accept the old hash as proof of inspected findings. |
| New-URL supersession | Retire only proved legacy fingerprint debt for the same repository/PR/head/base, after a strictly newer semantic disposition has a confirmed closure that is still current. Retain the old payload, reason and replacement proof. |
| Ordering | Retain older, equal-time conflicting and unknown-order evidence without replacing a current checkpoint. Historical versions of the same source do not reopen settled work; a distinct source can retain a separate disposition obligation. |
| Scope | Equal numeric IDs in different resource kinds and equal text in different repositories remain separate events. |
| Authority | Every imported report remains proposed evidence. No execution or acceptance is inferred from publication or transport success. |

## Qualification

The targeted producer tests run with synthetic fixtures and mocked external
calls. They cover source attribution, status transitions, meaningful edits,
metadata-only changes, retry after restart, preserved legacy payloads, ambiguous
acknowledgments, out-of-order versions and resource/repository separation.

The pinned baseline passes 43 targeted delivery and review lifecycle tests. The
initial candidate passed 70 targeted tests and 12 independent invariant probes.
Official review then reproduced a repository-wide reconciliation stall and
legacy disposition invalidation. Follow-up tests cover durable source isolation,
checkpoint fences, bounded backlog retry and explicit fingerprint compatibility.
Fresh-source container checks and a reproduced new-URL disposition defect added
further controls. The combined follow-up suite passes **99 targeted synthetic
tests**. Exact candidate identities, test commands and review receipts are
retained in the private operational ledger; this count is not the entire
companion repository test suite.

The cases include the meaningful `completed -> failed -> completed` transition,
same-source historical-first versions, clock-only observations and lost delivery
acknowledgments. The corresponding regression tests fail against the baseline.

### Proved supersession of a legacy disposition

A later comment URL alone cannot retire pending work. Only legacy
fingerprint-upgrade debt qualifies. The earlier and replacement dispositions must
identify the same repository, PR, head and base. The replacement's source event
time, retained in its original capture payload, must be strictly later than the
earlier source timestamp; poll or capture time is not a substitute. The current
replacement comment must retain its author, source identity and semantic receipt,
and that receipt must match the current full review evidence.

Both the saved capture and closure must have confirmed receipts for the correct
project/task and original operation keys. Readback must show the task done, with
the saved closure still its current progress record and no unresolved execution
or active blocker. Failed closure, later task progress, missing order or a
different comparison pair leaves the pending work visible. Successful
reconciliation atomically retains the original payload, reason and replacement
proof in history; it does not replay the old operation or rewrite delivery rows.

### Controlled deployed readback

The operational checks were separate from the synthetic suite. They verified:

- Existing delivery identities, serialized payloads and record associations
  were unchanged, and historical review events were retained.
- New Codex and DSH captures preserved the actual reviewer, source author and
  reviewed head. Base provenance matched the source; an unattested Codex base
  remained unknown.
- Historical inline evidence retained unknown status where the source did not
  attest one, without publishing a current checkpoint.
- Explicit developer dispositions closed the grouped review work with no active
  blockers or unresolved executions. Current checkpoints remained current
  review evidence rather than older arrivals.
- Eligible new evidence progressed without API failures or new uncertain
  deliveries. Existing uncertainty was not replayed to manufacture a receipt.

A historical formal review still lacks enough legacy metadata to distinguish an
exact retry from a new version. It remains durably fenced. The poll therefore
reports a reconciliation backlog with `ok: false` and exit status `1`; this is a
classified incomplete result, not a claim of full health. Other historical
uncertainty and ambiguity remain subject to private recovery work. One subsequent
automatic repeat completed without additional captures, dispositions, pending
dispositions or API failures, while retaining the same known fence. The timer
remains active and scheduled for its next poll. This observation does not imply
complete migration coverage, indefinite stability or implementation of the ME-20
current-review projection.

## Private evaluation preparation

A compact [offline helper](../../../scripts/evaluation/README.md) validates the
corpus described in [BASELINE_PROTOCOL.md](BASELINE_PROTOCOL.md). Its 45 synthetic
guard tests cover missing quotas, mixed development/held-out episodes, missing
response identities, unverified ground truth, MCP errors, nested incompleteness,
capture/review/freeze time ordering and bounded input reads. A freeze binds
content hashes, requires a private output file and cannot overwrite an existing
freeze. Standard output contains only a compact receipt.

Official review reproduced incomplete paginated reads, unenforced capture-window
bounds and cross-split intent reuse. The follow-up rejects non-null continuation
cursors, enforces an explicitly declared capture-time window and collection
ordering, and uses intent identity as a split boundary. Historical event time
remains distinct from capture time. Malformed omission flags, explicit budget
omission diagnostics and conflicting JSON response representations also block
ground-truth validation.

Exclusive creation applies to one output path. The private evidence ledger must
register the canonical corpus hash and freeze before candidate tuning; writing a
second file does not create a new independent baseline. The canonical private
freeze registry remains an open ME-02 follow-up. This helper does not enforce
global freeze uniqueness or establish semantic ground truth.

Unicode code points, JavaScript UTF-16 units, logical UTF-8 bytes and complete
serialized MCP-result bytes remain separate measurements. Run
`pnpm test:private-corpus`; the regular CI workflow runs the same synthetic suite.

The helper is not a second retrieval evaluator. Existing benchmark code and the
frozen synthetic held-out corpus remain unchanged. No synthetic fixture can
stand in for the 40 real private questions, and no missing provider token receipt
can become a zero-token observation.

Execution of the 40 natural private questions remains **NOT_RUN**. The real
corpus, independent ground-truth adjudication and matched before/after outcomes
remain pending. No retrieval or token-saving improvement is claimed.

## Qualification and remaining continuation

1. **Verified:** synthetic regressions and independent review are bound to the
   qualified source; both official review providers, explicit finding
   dispositions, required CI and normal source integration passed.
2. **Verified:** private preflight identified the actual producer, configuration,
   ledger and recovery copy. Installation preserved the application checkout and
   deployed the matching complete owner workflow bundles. Controlled live
   readback confirmed the new ingestion path and explicit grouped disposition.
3. **Open:** retain source-specific reconciliation and classify legacy recovery
   coverage. Reconcile any uncertain delivery; never restart it with a new key
   merely because an acknowledgment is missing.
   Classify existing legacy receipts as provably adoptable, pending or ambiguous.
   Some older review submissions lack stored status metadata. The new guard
   deliberately fences these cases instead of duplicating or inventing evidence.
   Persisted source isolation permits unaffected work to continue; the backlog
   remains visible and cannot be reported as complete migration coverage.
   Inventory legacy disposition receipts as well as source delivery rows.
   Recovery must preserve the upgraded delivery identities. After new-format
   imports, reverting only the producer binary to the old version is not
   replay-safe. Stop ingestion and preserve the current ledger and application
   database during recovery; resume only with a build that understands the new
   identities and fences.
4. **Restart and one automatic repeat verified:** the existing polling timer
   resumed through the guarded step bound to the assessed canary and its known
   reconciliation backlog. One natural repeat completed without additional
   captures or dispositions and retained the known fence. The timer remains
   active and scheduled. Preserve the incomplete-health signal and recovery
   follow-up; continued operation requires its own observations.
5. **Ongoing:** synchronize the programme tracker and private ContextKeep
   checkpoint. ME-18/19 are VERIFIED for forward ingestion; historical recovery,
   the natural corpus, canonical freeze registration and later programme work
   remain open. Close only a separately evidenced scope.

Operational receipts, private runtime paths, source records and question fixtures
remain outside the public repositories. The active topology is primary plus
backup; retired devices are excluded from this batch.
