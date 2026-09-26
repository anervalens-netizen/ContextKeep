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
