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
- [ ] Verify actual host panel activation and event-driven continuation.

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
- Host activation remains pending. Local and service integration tests are not
  evidence of ChatGPT delivery or automatic continuation.

Qualification: server functional tests, web tests and executor tests pass; recovery,
build, browser navigation and dependency audit checks pass. The isolated pilot
uses a real read-only executor job and a synthetic webhook receiver. PWA checks
cover desktop and mobile. These receipts do not certify ChatGPT host activation.

Browser bundle regression:
- A real browser reproduced an empty app before initialization because the library
  bundle retained a Node-only environment reference. Compile it to a production
  constant; do not add a browser process shim.
- Show a connection state immediately and a visible failure for a rejected or
  delayed handshake. Apply the initial host theme after connecting.
- The browser navigation gate now also runs the bundled MCP App in a sandboxed
  iframe without Node globals. It covers global launch without a tool result,
  contextual task selection, pending initialization and rejected initialization.
- These synthetic browser checks do not close the actual-host verification item.

Release dependency maintenance:
- The dependency audit detected vulnerable transitive URI/address parsing and
  brace expansion releases. Exact same-major patch overrides replace only the
  affected versions. The audit threshold and release-age policy are unchanged.
