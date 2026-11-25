# Workflow skills over MCP

ContextKeep MCP 2.25 serves the same six procedure files distributed with the
ContextKeep Workflows plugin. There is one source of procedure content:
`plugins/contextkeep-workflows/skills`.

## Contract

The authenticated `/mcp` endpoint declares
`capabilities.extensions["io.modelcontextprotocol/skills"]` and supports:

- `skills/list`: the complete bounded catalogue; no continuation cursor is issued.
- `skills/get`: one entry identified by its exact `skill://contextkeep/<name>/SKILL.md` URI.
- `resources/read`: the exact bytes of a declared skill resource.
- `resources/list`: the existing task panel followed by the six skill entry resources.

The official MCP SDK parses frontmatter and builds SHA-256 manifests. Each
manifest includes every supporting file, with its raw byte length and digest.
One immutable snapshot is loaded per server process. A changed procedure is
published in a new release. Missing files, invalid metadata, symbolic links,
oversized bundles, invalid UTF-8 text, and incomplete bundles fail readiness.
Request URIs are exact lookups; they never become filesystem paths.

Modern responses carry the required result discriminator and a private,
five-minute cache hint. Legacy clients retain the existing handshake and resource
envelope. Authentication, origin rejection, size limits, rate limiting,
OpenAI settings, the task widget and event subscriptions remain enforced.

## Client compatibility

A server capability does not establish host support. A client must discover and
verify skill manifests, then activate only the relevant skill under its own
instruction policy. Reading a resource does not grant new permissions.

Keep the existing packaged plugin skills for ChatGPT and Codex. The MCP Skills
implementation register currently describes their native import as planned,
with the prior submission-time import withdrawn. Interoperable clients can use
the standard methods now. Do not infer modern Tasks or Files support from a
client's protocol version alone.

ContextKeep remains the memory and execution-evidence registry. Durable command
execution and its MCP Task handles belong to the executor. Existing run
reservation, executor correlation, verification and `execution.finished` delivery
are preserved. This release does not create a second job engine or enable new
business operations.

## Qualification

`apps/server/test/workflow-skills.test.ts` checks modern and legacy discovery,
all six manifests against returned bytes, complete supporting-file coverage,
extra frontmatter, immutable snapshots, unauthorized requests, invalid URIs,
symlinks and publication limits. Existing UI, event and protocol tests remain
release gates. Runtime qualification must inspect the authenticated installed
endpoint and exact deployed revision; source tests are not production evidence.

References:

- https://modelcontextprotocol.io/extensions/skills/overview
- https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/beta/skills.mdx
- https://github.com/modelcontextprotocol/ext-skills/blob/main/docs/implementations.md
