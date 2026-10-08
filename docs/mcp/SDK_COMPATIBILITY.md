# SDK compatibility

MCP interface version: 2.17.0. Supported protocol contract: 2026-07-28.

Use authenticated MCP requests against an operator-configured endpoint. Resolve a project, read bounded work context, preserve canonical versus proposed provenance, then capture progress with a stable idempotency key. Never put private project records into the public repository or CI logs.
Runtime dependency: @modelcontextprotocol/server@2.1.0. Verify the dependency version in apps/server/package.json when upgrading.

## Panel v7 contract

MCP 2.17 exposes 60 tools, including native `settings.read` and
`settings.update`. Preferences live in a separate atomic JSON file in the
configured data directory. Partial updates preserve omitted fields; they do
not create memory records or execution receipts. Unlike memory mutations,
`settings.update` accepts the native `{set: {...}}` contract without an
idempotency key. Its returned values are read back after persistence.

The low-level SDK2 server advertises the settings extension in both protocol
routes; it does not use the SDK1 registration helper. The fallback panel editor
uses the same tools and offers explicit preference readback. It is not evidence
that a host implements native settings.

The opener points to `ui://contextkeep/tasks/v7.html` and includes a bounded,
timestamped first-screen projection. Matching fresh reads consume that
projection once. Missing or expired preferences are read before data loading.
Task selection belongs to each panel; saving preferences does not select a
task in another conversation.

Task navigation filters run before pagination and use the dossier's effective
state and attention rules. Project-wide attention stays visible when a search
narrows the main task cards. Attachment and active-chat messaging are explicit
actions, with independent acknowledgement and no automatic replay of an
uncertain message. Message acceptance is not execution confirmation.

## Release rollback

Historical widget URIs, including v6, are compatibility aliases to the selected
release's widget. They are **not** immutable bundles or rollback controls.
Rollback must select the previous complete application release through the
supported deployment path, restart the sole primary process and verify its
actual database path/inode and runtime identity. Preserve the preferences file
and production database; v7 introduces no database schema migration.

Contract, synthetic browser and locale tests qualify development behavior.
Native ChatGPT, Codex and Android acceptance, supported rollback and production
identity require separate live evidence before release closure.
