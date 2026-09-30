# ContextKeep

This public repository contains source code, reusable configuration examples and fictional test fixtures. Operational records, real customer/product data, credentials, private deployment configuration and production backups are maintained separately by the operator.

## Development and CI

Use the Node.js and package-manager versions specified by the CI workflow.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test:functional
pnpm test:ops
```

The manual Gaming workflow is a narrow, dispatch-only fast lane for
typecheck, functional tests and build. Release certification is a separate,
explicit self-hosted dispatch (`release:gate`) that runs the complete
typecheck, context-quality, static-audit, public-data/history, functional,
operational-recovery, build, browser-navigation and dependency-audit gates.
Neither workflow runs untrusted external pull requests on private runners;
the full gate is run by the integrator on a trusted revision.

Tests use isolated temporary data. Never point CI at a production database or import real account, customer or employee data. Run application-specific regression checks before publishing changes.

## Deployment

Configure actual hosts, filesystem paths and secrets privately. Files under deploy/ are templates, not an inventory of live machines. Preserve installed application identifiers and existing databases during upgrades. Operator deployment records and rollback procedures belong outside Git.

## Contributions

Read AGENTS.md. Use a GitHub noreply author address. Keep public issues and comments limited to generic code behavior; exclude private logs, screenshots, addresses and account information. Run the public-data guard before committing.

ContextKeep separates accepted evidence-backed knowledge from unreviewed agent working memory. The demonstration projects are fictional. Production should have exactly one writable primary SQLite database. MCP documentation is in docs/contextkeep-mcp.md and docs/mcp/.

Public contracts are summarized in [architecture and invariants](docs/ARCHITECTURE.md),
[synthetic operations/configuration](docs/OPERATIONS.md), and the
[HTTP/MCP recovery contract](docs/RECOVERY_CONTRACT.md). Operational profiles,
endpoints, data and deployment evidence remain private.

## Current-state dossier and task continuity

Read [Operational dossier](docs/OPERATIONAL_DOSSIER.md) for outcome-first project/task
reads, read-only resume, operational progress, cross-project relationships, changes
digests and bounded event continuation. Current task state is shared by MCP, PWA
and the host panel; it does not silently promote reports to accepted knowledge.

## Reliable task continuity

MCP 2.13 / schema 19 adds explicit execution-evidence correlation and immutable
verification receipts. A historical pass and a currently valid proof are different
states. Read [Execution evidence](docs/VERIFICATION_EVIDENCE.md) for the optional
`runEvidence` capture field and the required correlation for new verification.
Ordinary working-memory captures remain compatible and proposal-only.

The shared task view preserves explicitly cleared next steps, includes task-scoped
blocker-resolution history, and distinguishes subscription configuration from real
delivery status. Project cards keep loaded pages current after pagination errors.
Event delivery supports generation-safe renewal and bounded graceful shutdown.
The host widget advertises v5 while retaining reads of installed v2/v3/v4 resources.

Private monitoring can use authenticated `GET /api/health`. It reports a real
SQLite read, not merely successful delivery of the application's HTML. Production
qualification still requires the release gate and independent recovery evidence.
