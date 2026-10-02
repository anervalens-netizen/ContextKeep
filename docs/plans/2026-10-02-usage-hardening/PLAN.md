# Usage hardening plan — 2026-10-02

The implementation follows the completed adversarial usage review.

1. Preserve current schemas and history where possible; prefer additive/read-path changes.
2. Guard new operational checkpoints against accidental project-level capture while keeping an explicit project-note escape hatch.
3. Make task resume a current-state projection: state/provenance/time, blockers, unresolved runs, latest verified execution, then historical objective.
4. Add explicit blocker category/key metadata for new captures; keep checkpoint+index identities and historical resolution semantics for compatibility.
5. Add task-scoped operational handoff using the task dossier and evidence labels; retain canonical project handoff unchanged.
6. Add opt-in compact MCP search output; default compatibility response is unchanged.
7. Add no-replay uncertain-run reconciliation from exact external receipt identity.
8. Qualify exact source, obtain external review, deploy immutably with recovery copy, live-read back, and verify independent backup/restore.
