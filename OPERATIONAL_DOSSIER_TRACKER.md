# Operational dossier and continuity

Status: implementation and full candidate qualification complete; final cache-version qualification and production activation pending. Operational identities, receipts and actual deployment records remain private.

## Scope
Reuse project -> action/task -> run -> evidence. Share current-state and resume
semantics across MCP, PWA and the host panel. No internal LLM, alternate memory
database, general orchestrator or unrelated provider integration.

## Delivery
- [x] D1 Evidence-backed operational task progress, separate from accepted knowledge.
- [x] D2 Compact project/task dossier, current observations and explicit unknowns.
- [x] D3 Shared outcome-first UI, task selection/resume and operational timeline.
- [x] D4 Portfolio changes and identity-backed dependency lookup.
- [x] D5 Bounded continuation claims, policy/status visibility, abandoned-claim reconciliation and verification workflow contracts.
- [ ] D5-host Native subscription for the first operational workflow; unavailable in the current host tool surface. Policy is not a subscription. Do not reactivate the closed pilot or substitute polling.
- [ ] D6 Final cache-version regression, verified recovery copy, activation and authenticated readback.
- [ ] D7 Documentation, source synchronization and private memory/task closure.

## Acceptance
Two simultaneous tasks keep separate checkpoints and operational states.
Process success and run verification never auto-accept knowledge or close a task.
Unscoped historical blockers never become blockers of a selected task.
Observations retain source IDs, provenance, timestamps and review status.
Resume/select never starts a job. Unknown/unavailable is not healthy/complete.
Event retries cannot duplicate continuation effects; uncertain ownership is explicit.
Use synthetic public fixtures only and preserve compatible clients.
A changed host widget advertises a new resource URI while older installed URIs remain readable.

## Evidence
The functional candidate passed all 10 release checks, including 950 functional
tests (12 shared, 633 server, 305 web), operational recovery, builds, browser
navigation, compiled host iframe and dependency/privacy checks. Recovery-copy
migration preserves protected data. Exact execution and artifact receipts are private.

Resume inspection found that the changed host widget still advertised the already
installed UI v3 cache key. The final correction advertises v4 and tests v2/v3
compatibility. Requalify this correction before activation.

The previous extension/events qualification is closed, not a new test requirement
or permission to reactivate its pilot. Native host unavailability remains explicit.
