# ContextKeep

This public repository contains source code, reusable configuration examples and fictional test fixtures. Operational records, real customer/product data, credentials, private deployment configuration and production backups are maintained separately by the operator.

## Development and CI

Use the Node.js and package-manager versions specified by the CI workflow.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test:functional
pnpm test:focused
pnpm test:performance
pnpm test:ops
pnpm test:private-corpus
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

## Memory and retrieval improvement programme

The active [memory evolution tracker](MEMORY_EVOLUTION_TRACKER.md) records the
complete improvement backlog, dependencies, status and acceptance evidence.
Read the [detailed plan](docs/plans/2026-11-16-memory-evolution/PLAN.md) and
[validation catalogue](docs/plans/2026-11-16-memory-evolution/VALIDATION.md) before
starting an item. Planned work and conditional experiments are not implemented
features; private operational evidence remains outside this public repository.

The [private corpus preflight](scripts/evaluation/README.md) checks the structure,
evidence identity and split boundaries before an operator freezes a real corpus.
Its tests contain synthetic data only. It does not certify retrieval quality or
replace independent ground-truth review.

## Current-state dossier and task continuity

Read [Operational dossier](docs/OPERATIONAL_DOSSIER.md) for outcome-first project/task
reads, read-only resume, operational progress, cross-project relationships, changes
digests and bounded event continuation. Current task state is shared by MCP, PWA
and the host panel; it does not silently promote reports to accepted knowledge.

Search task hits now include the dossier's effective state, its source and a
resume pointer while retaining the original task record status. The PWA exposes
both states and keeps proposed progress provenance visible. See the
[search contract](docs/contextkeep-mcp.md#effective-task-state-in-search) and the
[baseline protocol](docs/plans/2026-11-16-memory-evolution/BASELINE_PROTOCOL.md).

## Compact project catalogue

MCP 2.23.0 adds an optional compact and conditional `list_projects` read.
Existing callers retain the full response. Compact pages contain only project
identity and metadata; opaque versions support conditional reads and coherent
pagination. Each call still authenticates and reads SQLite. An unchanged
catalogue does not establish unchanged project memory or runtime health.
Read the [catalogue contract](docs/mcp/project-catalogue.md) and
[Batch 4 qualification record](docs/plans/2026-11-16-memory-evolution/BATCH_4.md)
for cache rules, periodic full controls and implementation versus release status.

## Reliable task continuity

MCP 2.23.0 / schema 19 retains explicit execution-evidence correlation and immutable
verification receipts and adds task-scope guardrails, current-state-first resume,
operational task handoffs and no-replay uncertain-run reconciliation. A historical pass and a currently valid proof are different
states. Read [Execution evidence](docs/VERIFICATION_EVIDENCE.md) for the optional
`runEvidence` capture field and the required correlation for new verification.
Ordinary working-memory captures remain compatible and proposal-only.

The shared task view preserves explicitly cleared next steps, includes task-scoped
blocker-resolution history, and distinguishes subscription configuration from real
delivery status. Project cards keep loaded pages current after pagination errors.
Event delivery supports generation-safe renewal and bounded graceful shutdown.
The host widget advertises v7.3 while retaining compatibility reads of installed v2/v3/v4/v5/v6/v7/v7.1/v7.2 resources.

Private monitoring can use authenticated `GET /api/health`. It reports a real
SQLite application/schema read, not merely successful delivery of the application's HTML. Production
qualification still requires the release gate and independent recovery evidence.

## Error reporting

Error reporting is optional and uses the existing GlitchTip service. Configure `GLITCHTIP_DSN` only in private runtime configuration. Browser builds use `VITE_GLITCHTIP_DSN` (Next.js uses `NEXT_PUBLIC_GLITCHTIP_DSN`); the Remote Control console uses the controller DSN at build time. Rebuild frontend assets when the destination changes. Preserve the exact release identifier with the deployment metadata.

Events retain stack locations, SDK version, component and release. The new integrations omit request payloads, user data, breadcrumbs and private exception messages. Synthetic acceptance events must carry `glitchtip.synthetic=true` and a unique `validation.run`; verify receipt at the destination, not only the SDK return value. They are excluded by the operational alert collector. Do not send business data or trigger an application crash to validate reporting.
