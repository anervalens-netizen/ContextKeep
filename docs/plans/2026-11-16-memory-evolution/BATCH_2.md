# Batch 2: review attribution and event identity

Date: 2026-11-16\
Programme items: ME-18 / ME-19; bounded preparation for ME-01 / ME-02 / ME-03\
Accountable role: development agent; independent replay-safety review

## Status and source boundary

**The local implementation and targeted qualification are complete. This batch
is not deployed or complete.** Official exact-head reviews, CI, integration, producer
runtime identification and deployed readback remain open.

The review producer belongs to the companion integration. Its exact private
source baseline, candidate and deployed component identities are maintained in
the operational evidence ledger. The public ContextKeep plan and protocol
baseline is `6cc120a06233ffa08a1c0139b5fe5a6015109ded`.

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
| Ordering | Retain older, equal-time conflicting and unknown-order evidence without replacing a current checkpoint or reopening completed work. |
| Scope | Equal numeric IDs in different resource kinds and equal text in different repositories remain separate events. |
| Authority | Every imported report remains proposed evidence. No execution or acceptance is inferred from publication or transport success. |

## Qualification

The targeted producer tests run with synthetic fixtures and mocked external
calls. They cover source attribution, status transitions, meaningful edits,
metadata-only changes, retry after restart, preserved legacy payloads, ambiguous
acknowledgments, out-of-order versions and resource/repository separation.

The pinned baseline passes 43 targeted delivery and review lifecycle tests. The
candidate passes 70 targeted tests, including 27 additional regression cases.
An independent reviewer also passes 12 direct invariant probes covering the
previously reproduced failures. Exact private candidate identities and review
receipts are retained in the operational ledger.

The cases include the meaningful `completed -> failed -> completed` transition,
same-source historical-first versions, clock-only observations and lost delivery
acknowledgments. The corresponding regression tests fail against the baseline.

Local synthetic success does not establish the deployed producer version,
integration health, production event ordering or grouped review-task closure.
Those require separate readback after a qualified rollout.

## Private evaluation preparation

A compact [offline helper](../../../scripts/evaluation/README.md) validates the
corpus described in [BASELINE_PROTOCOL.md](BASELINE_PROTOCOL.md). Its 32 synthetic
guard tests cover missing quotas, mixed development/held-out episodes, missing
response identities, unverified ground truth, MCP errors, nested incompleteness,
capture/review/freeze time ordering and bounded input reads. A freeze binds
content hashes, requires a private output file and cannot overwrite an existing
freeze. Standard output contains only a compact receipt.

Unicode code points, JavaScript UTF-16 units, logical UTF-8 bytes and complete
serialized MCP-result bytes remain separate measurements. Run
`pnpm test:private-corpus`; the regular CI workflow runs the same synthetic suite.

The helper is not a second retrieval evaluator. Existing benchmark code and the
frozen synthetic held-out corpus remain unchanged. No synthetic fixture can
stand in for the 40 real private questions, and no missing provider token receipt
can become a zero-token observation.

The real corpus, independent ground-truth adjudication and matched before/after
outcomes remain pending. No retrieval or token-saving improvement is claimed.

## Continuation gates

1. Finish local regressions and independent review; bind evidence to the exact
   candidate and preserve the inspected baseline.
2. Integrate source using normal public-history/privacy checks. Request or reuse
   both official review providers for the exact PR head, resolve confirmed
   findings and check CI.
3. Inspect the current producer source, service,
   configuration and delivery ledger before activation. Reconcile any uncertain
   delivery; never restart it with a new key merely because an acknowledgment is
   missing.
   Classify existing legacy receipts as provably adoptable, pending or ambiguous.
   Some older review submissions lack stored status metadata. The new guard
   deliberately blocks these cases instead of duplicating or inventing evidence;
   this preflight is a required activation gate.
   Recovery must preserve the upgraded delivery identities. After new-format
   imports, reverting only the producer binary to the old version is not
   replay-safe and is not an approved rollback procedure.
4. Activate only the qualified producer change. Verify live attribution and
   version/retry behavior through the existing authenticated interfaces, and
   record the actual deployed component identity privately.
5. Read back the grouped review-task disposition, synchronize the programme
   tracker and private ContextKeep checkpoint, then close only the proven scope.

Operational receipts, private runtime paths, source records and question fixtures
remain outside the public repositories. The active topology is primary plus
backup; retired devices are excluded from this batch.
