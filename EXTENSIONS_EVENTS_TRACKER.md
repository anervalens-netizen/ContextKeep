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
- [ ] Verify a recoverable release and actual host activation.

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
- Host activation and production qualification remain pending. Local tests are not
  evidence of ChatGPT delivery or automatic continuation.

Qualification: server functional tests, web tests and executor tests pass; recovery,
build, browser navigation and dependency audit checks pass. The isolated pilot
uses a real read-only executor job and a synthetic webhook receiver. PWA checks
cover desktop and mobile. These receipts do not certify ChatGPT host activation.
