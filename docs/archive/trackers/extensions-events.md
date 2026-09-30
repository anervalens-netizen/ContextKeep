# Extensions and events integration

This tracker covers reusable implementation only. Deployment identities, account
activation, owner-specific plans and verification receipts stay in private storage.

- [x] Pin compatible MCP Apps and OpenAI extension SDK versions.
- [x] Validate local SDK construction and global/thread metadata.
- [x] Add and run automated SDK regression tests (3 cases).
- [x] Scope checkpoints to existing action record IDs without changing legacy clients.
- [x] Persist runs and terminal observations independently of verification.
- [x] Reuse task views in the PWA and a separate MCP App entrypoint.
- [x] Implement persistent webhook subscriptions and signed delivery.
- [x] Add the optional executor result bridge.
- [x] Verify retry, restart, concurrency, revocation and isolated end-to-end behavior.
- [x] Verify a recoverable release and authenticated runtime discovery.
- [x] Qualify the live executor bridge with an idempotent read-only job.
- [x] Verify actual host panel activation and event-driven continuation.

Process completion, webhook acceptance, agent verification and task completion
are distinct facts. An unreviewed agent report never becomes accepted knowledge
merely because it came from an event. No internal LLM or general orchestrator is
introduced by this integration. Selection alone never starts an operation.

Implementation verification:
- Task captures/read paths accept existing action IDs; independent run reservations,
  terminal observations and evidence-backed verification are persistent (schema 17).
- Shared task dossier renders in the PWA and a separate bundled MCP App.
- Signed webhook subscriptions/outbox/delivery retries use durable storage.
- SDK 2.1.0's closed modern capability schema needs a narrow discovery-response
  adapter to preserve the draft events capability; actual wire discovery is tested.
- Actual host panel activation and native event-driven continuation have been
  qualified separately. Detailed receipts remain in private project memory.

Qualification: server functional tests, web tests and executor tests pass; recovery,
build, browser navigation and dependency audit checks pass. The isolated pilot
uses a real read-only executor job and a synthetic webhook receiver. PWA checks
cover desktop and mobile. A separate host qualification confirmed direct panel
rendering and native subscription before execution, followed by event-triggered
agent continuation, retained-result inspection and separate run verification.
Synthetic test results alone do not certify host activation.

Browser bundle regression:
- A real browser reproduced an empty app before initialization because the library
  bundle retained a Node-only environment reference. Compile it to a production
  constant; do not add a browser process shim.
- Show a connection state immediately and a visible failure for a rejected or
  delayed handshake. Apply the initial host theme after connecting.
- The browser navigation gate now also runs the bundled MCP App in a sandboxed
  iframe without Node globals. It covers global launch without a tool result,
  contextual task selection, pending initialization and rejected initialization.
- These synthetic browser checks are complemented by the separate actual-host
  qualification above.

Release dependency maintenance:
- The dependency audit detected vulnerable transitive URI/address parsing and
  brace expansion releases. Exact same-major patch overrides replace only the
  affected versions. The audit threshold and release-age policy are unchanged.

Host tool-call contract regression:
- The MCP App now supplies every published required pagination argument to task
  list and detail calls. Backend defaults must not mask host schema validation.
- The compiled browser check derives required workflow arguments from the server
  definitions and rejects missing fields before returning synthetic results.
- A failed task-list request no longer displays a contradictory empty-project
  message; successful empty responses remain distinct from loading and errors.

UI resource cache lifecycle:
- Publish the repaired bundle through a new versioned resource URI and advertise
  that same URI in tools/list and resources/list.
- Preserve resources/read for the previously installed URI during metadata
  refresh. A wire-level regression checks the new mapping and legacy reads.
- Refresh the developer connection after UI metadata changes. Serving the latest
  bundle at the origin does not prove an existing host iframe has loaded it.

Qualification closure:
- The one-off host pilot is complete; its test automation is disabled.
- General project subscriptions and continuation policies remain a separate
  configuration step. Pilot success does not enable them automatically.
