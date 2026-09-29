# Extensions and events integration

This tracker covers reusable implementation only. Deployment identities, account
activation, owner-specific plans and verification receipts stay in private storage.

- [x] Pin compatible MCP Apps and OpenAI extension SDK versions.
- [x] Validate local SDK construction and global/thread metadata.
- [x] Add and run automated SDK regression tests (3 cases).
- [ ] Scope checkpoints to existing action record IDs without changing legacy clients.
- [ ] Persist runs and terminal observations independently of verification.
- [ ] Reuse task views in the PWA and a separate MCP App entrypoint.
- [ ] Implement persistent webhook subscriptions and signed delivery.
- [ ] Add the optional executor result bridge.
- [ ] Verify retry, restart, concurrency, revocation and end-to-end behavior.
- [ ] Verify a recoverable release and actual host activation.

Process completion, webhook acceptance, agent verification and task completion
are distinct facts. An unreviewed agent report never becomes accepted knowledge
merely because it came from an event. No internal LLM or general orchestrator is
introduced by this integration. Selection alone never starts an operation.

Local foundation verification: 8 task-scope cases, 3 SDK cases, workspace
typecheck and public-data guards pass. The task-scope helper is not yet wired
into capture/read paths; scoped checkpoints, UI and events remain incomplete.
